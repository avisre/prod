'use strict';
/*
 * backend/ssr-cache.js
 * -------------------------------------------------------------------------
 * Hand-rolled, ZERO-DEPENDENCY in-process SSR HTML/XML cache for the public
 * SEO surface of stockportfolio.pro. Node built-ins only (zlib). Express
 * middleware factory.
 *
 * WHY: Googlebot crawled a 26k-URL sitemap; every /stocks/:ticker,
 * /stocks/:t/:metric, /compare/:pair re-renders filings + fundamentals on a
 * 512MB / 0.5-CPU single instance -> 5xx overload -> 91% impressions drop.
 * Caching the rendered 200 HTML/XML serves REPEAT crawl hits from memory at
 * ~0 CPU. This cache does NOT help the first hit per URL (that render still
 * runs) -- see the SSR overload guard below for the cold-burst defense.
 *
 * DESIGN DECISIONS (from review):
 *  - Store body RAW (uncompressed); let the upstream `compression` middleware
 *    (app.js:104) gzip on the way out. This removes ALL Content-Encoding /
 *    double-gzip / non-gzip-client / Vary footguns. We store gzipped ONLY to
 *    save memory and gunzip on serve into a plain string -> single, normal
 *    res.send path identical to a MISS.
 *  - /sitemap.xml gets a DEDICATED single slot, never in the LRU Map and never
 *    counted toward the small-page byte budget -> the 3-4MB entry can never be
 *    evicted by small-page churn, and its multi-second cold render happens at
 *    most once per TTL/deploy. Its gzip is done ASYNC (zlib.gzip) so the
 *    request path never blocks the 0.5-CPU loop on a 3-4MB gzipSync.
 *  - NO single-flight Promise map: renders are synchronous so Node already
 *    serializes same-key requests; the promise map was a no-op + leak surface.
 *  - SSR OVERLOAD GUARD: a module counter of in-progress cold renders. The
 *    /api rate limiters do NOT cover SSR paths (verified app.js:122/134 are
 *    /api-scoped). On a MISS, if too many cold renders are already in flight we
 *    serve a stale (expired) entry if we have one, else 503 + Retry-After so
 *    Googlebot backs off instead of queueing thousands of blocking renders that
 *    can time out Render's health check -> restart -> cache-loss loop.
 *  - Cache-Control max-age is SHORT (600s) so the edge/Googlebot refresh
 *    quickly after a deploy (the codebase deliberately serves HTML no-cache);
 *    the CPU offload comes from the in-memory store, not the edge.
 *  - Memory-pressure backstop: skip storing when rss exceeds a guard.
 *
 * EXPORTS:
 *  - middleware(opts)  -> Express middleware (mount ONCE, before SEO routes)
 *  - warmSitemap(mw,fn)-> deferred, off-critical-path sitemap warm helper
 *  - stats()           -> { entries, bytes, sitemapBytes, hits, misses, ... }
 *  - flush()           -> clears everything (optional admin hook)
 */

const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Tunables (conservative for a 512MB / 0.5-CPU box). See memoryMathMB.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  maxEntries: 4000,            // small-page LRU cap (well under 26k URL space)
  maxBytes: 20 * 1024 * 1024,  // 20MB gzipped, small-page LRU only (sitemap separate)
  ttlMs: 6 * 60 * 60 * 1000,   // 6h: bounds staleness to a quarter-day
  sitemapTtlMs: 90 * 60 * 1000,// 90m: <lastmod> stamps today's date; keep fresher
  maxBodyBytes: 1.5 * 1024 * 1024, // any single small-page body over this is NOT LRU-cached
  minHtmlBytes: 200,           // reject suspiciously tiny/partial 200 bodies
  minXmlBytes: 100,
  perEntryOverhead: 200,       // flat fudge for key+object+Buffer-wrapper heap
  maxColdRenders: 2,           // SSR overload guard: concurrent cold renders allowed
  rssGuardBytes: 400 * 1024 * 1024, // skip storing above this rss (memory backstop)
  cacheControl: 'public, max-age=600, stale-while-revalidate=86400',
  retryAfterSeconds: 5
};

// Anchored positive allowlist -- ONLY exact SSR shapes. Never a denylist.
// Order changes the HTTP status the origin returns (a>b 301s) so we do NOT
// normalize compare order in the key; only case-fold. Excludes /company(.html),
// /screener(.html), /api, /admin, /dashboard, /login, /register, /demo, /v1,
// /v2, /, and the root-mounted localyze-proxy router.
const SSR_PATTERNS = [
  /^\/sitemap\.xml$/,
  /^\/stocks$/,
  /^\/stocks\/[A-Za-z0-9.\-]+$/,
  /^\/stocks\/[A-Za-z0-9.\-]+\/[a-z-]+$/,
  /^\/compare$/,
  /^\/compare\/[A-Za-z0-9.\-]+-vs-[A-Za-z0-9.\-]+$/,
  /^\/screens\/[a-z0-9-]+$/,
  /^\/vs\/[a-z0-9-]+$/,
  /^\/methodology$/,
  /^\/editorial-policy$/
];

function isCacheablePath(p) {
  for (let i = 0; i < SSR_PATTERNS.length; i++) {
    if (SSR_PATTERNS[i].test(p)) return true;
  }
  return false;
}

// Normalize the cache key. req.path excludes the querystring and is decoded by
// Express. Uppercase ONLY ticker/metric/pair segments so case variants share a
// key. Do NOT swap compare order (order changes the HTTP status). Nothing else.
function normalizeKey(p) {
  let m = p.match(/^\/stocks\/([A-Za-z0-9.\-]+)(\/[a-z-]+)?$/);
  if (m) {
    return '/stocks/' + m[1].toUpperCase() + (m[2] || '');
  }
  m = p.match(/^\/compare\/([A-Za-z0-9.\-]+)-vs-([A-Za-z0-9.\-]+)$/);
  if (m) {
    return '/compare/' + m[1].toUpperCase() + '-vs-' + m[2].toUpperCase();
  }
  return p; // /vs/:competitor, /screens/:slug already lowercase slugs
}

function isSitemap(key) { return key === '/sitemap.xml'; }

// ---------------------------------------------------------------------------
// Store: one Map for small pages (LRU by insertion order) + one dedicated
// variable for the sitemap. All removals funnel through removeKey() so the
// byte counter never drifts.
// ---------------------------------------------------------------------------
function createStore(opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const map = new Map();        // key -> { gz, type, bytes, expires }
  let totalBytes = 0;           // sum of (gz.length + perEntryOverhead)
  let sitemap = null;           // { gz, type, bytes, expires } | null
  let activeColdRenders = 0;
  const metrics = { hits: 0, misses: 0, stores: 0, evictions: 0, stale: 0, shed: 0 };

  function removeKey(key) {
    const e = map.get(key);
    if (e) {
      totalBytes -= (e.bytes + cfg.perEntryOverhead);
      map.delete(key);
    }
  }

  function evictToBudget() {
    while (map.size > cfg.maxEntries || totalBytes > cfg.maxBytes) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      removeKey(oldest);
      metrics.evictions++;
    }
  }

  // Returns { body, type } on a live HIT (body decoded string), { stale, entry }
  // if an expired entry exists, or null on a true miss.
  function get(key) {
    if (isSitemap(key)) {
      if (!sitemap) return null;
      if (Date.now() > sitemap.expires) { metrics.stale++; return { stale: true, entry: sitemap }; }
      metrics.hits++;
      return { body: zlib.gunzipSync(sitemap.gz).toString('utf8'), type: sitemap.type };
    }
    const e = map.get(key);
    if (!e) return null;
    if (Date.now() > e.expires) { metrics.stale++; return { stale: true, entry: e }; }
    map.delete(key); map.set(key, e); // LRU bump to most-recently-used
    metrics.hits++;
    return { body: zlib.gunzipSync(e.gz).toString('utf8'), type: e.type };
  }

  function staleBody(stale) {
    if (!stale || !stale.entry) return null;
    try { return zlib.gunzipSync(stale.entry.gz).toString('utf8'); } catch (_) { return null; }
  }

  function set(key, body, type) {
    let rss = 0;
    try { rss = process.memoryUsage().rss; } catch (_) {}
    if (rss && rss > cfg.rssGuardBytes) return; // memory-pressure backstop

    if (isSitemap(key)) {
      // Async gzip so a 3-4MB gzipSync never blocks the 0.5-CPU loop.
      zlib.gzip(Buffer.from(body, 'utf8'), (err, gz) => {
        if (err || !gz) return;
        sitemap = { gz, type, bytes: gz.length, expires: Date.now() + cfg.sitemapTtlMs };
        metrics.stores++;
      });
      return;
    }

    const raw = Buffer.byteLength(body, 'utf8');
    if (raw > cfg.maxBodyBytes) return; // oversized non-sitemap body: don't pollute LRU

    let gz;
    try { gz = zlib.gzipSync(Buffer.from(body, 'utf8')); } catch (_) { return; }

    removeKey(key); // overwrite path funnels through the single decrementer
    const entry = { gz, type, bytes: gz.length, expires: Date.now() + cfg.ttlMs };
    map.set(key, entry);
    totalBytes += (gz.length + cfg.perEntryOverhead);
    metrics.stores++;
    evictToBudget();
  }

  function flush() { map.clear(); totalBytes = 0; sitemap = null; }

  function stats() {
    return {
      entries: map.size, bytes: totalBytes,
      sitemapBytes: sitemap ? sitemap.bytes : 0,
      activeColdRenders,
      hits: metrics.hits, misses: metrics.misses, stores: metrics.stores,
      evictions: metrics.evictions, stale: metrics.stale, shed: metrics.shed
    };
  }

  return {
    cfg, metrics, get, set, staleBody, flush, stats,
    incCold() { activeColdRenders++; },
    decCold() { if (activeColdRenders > 0) activeColdRenders--; },
    coldCount() { return activeColdRenders; }
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------
function middleware(opts) {
  const store = createStore(opts);
  const cfg = store.cfg;

  const mw = function ssrCache(req, res, next) {
    if (req.method !== 'GET') return next();
    const path = req.path; // querystring-free; decoded by Express
    if (!isCacheablePath(path)) return next();
    if (req.headers.authorization) return next(); // never touch credentialed requests

    const key = normalizeKey(path);

    // HIT: serve decoded body via a normal res.send (upstream compression gzips).
    const hit = store.get(key);
    if (hit && hit.body) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', hit.type);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Vary', 'Accept-Encoding');
        if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', cfg.cacheControl);
      }
      return res.send(hit.body);
    }

    // MISS + overload guard: shed load rather than queue another blocking render.
    if (store.coldCount() >= cfg.maxColdRenders) {
      store.metrics.shed++;
      if (hit && hit.stale) {
        const body = store.staleBody(hit);
        if (body && !res.headersSent) {
          res.setHeader('Content-Type', hit.entry.type);
          res.setHeader('X-Cache', 'STALE');
          res.setHeader('Vary', 'Accept-Encoding');
          if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', cfg.cacheControl);
          return res.send(body);
        }
      }
      res.setHeader('Retry-After', String(cfg.retryAfterSeconds));
      res.setHeader('X-Cache', 'BUSY');
      return res.status(503).type('text/plain').send('Server busy, please retry.');
    }

    // Real cold render: wrap res.send per-request (never the prototype).
    store.metrics.misses++;
    store.incCold();
    let coldDone = false;
    const endCold = () => { if (!coldDone) { coldDone = true; store.decCold(); } };
    res.on('finish', endCold);
    res.on('close', endCold);

    const originalSend = res.send.bind(res);
    let captured = false;
    res.send = function patchedSend(body) {
      try {
        if (!captured) { captured = true; maybeStore(req, res, key, body, store); }
      } catch (_) { /* never let caching break the response */ }
      if (!res.getHeader('X-Cache')) res.setHeader('X-Cache', 'MISS');
      if (!res.getHeader('Vary')) res.setHeader('Vary', 'Accept-Encoding');
      return originalSend(body);
    };

    return next();
  };

  mw.store = store;
  mw.stats = store.stats;
  mw.flush = store.flush;
  return mw;
}

// Decide whether the just-produced response is storable, and store it.
function maybeStore(req, res, key, body, store) {
  const cfg = store.cfg;
  if (res.statusCode !== 200) return;          // excludes 404/301/302 cleanly
  if (res.headersSent) return;                 // streamed/partial response
  if (res.getHeader('Set-Cookie')) return;     // defense-in-depth (app is cookie-free)
  const cc = String(res.getHeader('Cache-Control') || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private') || cc.includes('no-cache')) return;

  const ctype = String(res.getHeader('Content-Type') || '');
  const isHtml = /^text\/html\b/i.test(ctype);
  const isXml = /\bxml\b/i.test(ctype);
  if (!isHtml && !isXml) return;

  let str;
  if (typeof body === 'string') str = body;
  else if (Buffer.isBuffer(body)) str = body.toString('utf8');
  else return;
  const len = Buffer.byteLength(str, 'utf8');
  if (isHtml && len < cfg.minHtmlBytes) return;
  if (isXml && len < cfg.minXmlBytes) return;

  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', cfg.cacheControl);
  res.setHeader('Vary', 'Accept-Encoding');
  store.set(key, str, ctype);
}

// Deferred, off-critical-path sitemap warm. Call AFTER server.listen / health
// green: setImmediate inside. renderFn must return the XML string synchronously
// (buildSitemap). Never call synchronously at boot (it parses ~1500 files).
function warmSitemap(mw, renderFn) {
  setImmediate(() => {
    try {
      const xml = renderFn();
      if (typeof xml === 'string' && xml.length > 100) {
        mw.store.set('/sitemap.xml', xml, 'application/xml');
      }
    } catch (_) { /* best effort */ }
  });
}

module.exports = { middleware, warmSitemap, SSR_PATTERNS, normalizeKey, isCacheablePath };
