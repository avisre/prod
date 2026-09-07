'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assetProfile = require('../asset-profile');
const fundHoldings = require('../fund-holdings');

// ---------------------------------------------------------------------------
// The shape bug: Yahoo sends sector weightings and bond ratings as an array of
// single-key objects, and reading .name/.weight off those produced undefined
// for every row — so sector exposure was empty on every fund page and the
// public etf-sector-concentration tool returned zero rows.
// ---------------------------------------------------------------------------
test('sector weightings survive Yahoo\'s single-key array shape', () => {
    const rows = assetProfile.normalizeWeights([
        { realestate: 0.018 },
        { consumer_cyclical: 0.0931 },
        { technology: 0.3869 }
    ]);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { name: 'Technology', weight: 0.3869 });
    assert.equal(rows[1].name, 'Consumer Cyclical');
    assert.equal(rows[2].name, 'Real Estate');
});

test('bond ratings keep their letter casing and drop empty buckets', () => {
    const rows = assetProfile.normalizeWeights([
        { bb: 0 }, { aa: 0.7274 }, { aaa: 0.0305 }, { us_government: 0.5183 }
    ]);
    assert.deepEqual(rows.map((row) => row.name), ['AA', 'US Government', 'AAA']);
    // An equity ETF reports every rating as zero; eleven empty bars is noise.
    assert.equal(rows.some((row) => row.weight === 0), false);
});

test('the labelled {name, weight} shape still works', () => {
    const rows = assetProfile.normalizeWeights([{ name: 'Energy', weight: 0.04 }]);
    assert.deepEqual(rows, [{ name: 'Energy', weight: 0.04 }]);
});

// ---------------------------------------------------------------------------
// N-PORT parsing
// ---------------------------------------------------------------------------
const NPORT = `<edgarSubmission>
  <repPdDate>2026-06-30</repPdDate>
  <invstOrSecs>
    <invstOrSec>
      <name>NVIDIA Corp</name>
      <title>NVIDIA Corp.</title>
      <cusip>67066G104</cusip>
      <identifiers><isin value="US67066G1040"/></identifiers>
      <balance>1000.00000000</balance>
      <curCd>USD</curCd>
      <valUSD>5000000.00000000</valUSD>
      <pctVal>7.5059000000</pctVal>
      <assetCat>EC</assetCat>
    </invstOrSec>
    <invstOrSec>
      <name>Procter &amp; Gamble Co</name>
      <title>Procter &amp; Gamble Co.</title>
      <cusip>742718109</cusip>
      <balance>500.00000000</balance>
      <valUSD>250000.00000000</valUSD>
      <pctVal>0.5000000000</pctVal>
      <assetCat>EC</assetCat>
    </invstOrSec>
    <invstOrSec>
      <name>S&amp;P 500 E-Mini Future</name>
      <title>S&amp;P 500 E-Mini Future</title>
      <pctVal>-0.2500000000</pctVal>
      <assetCat>DE</assetCat>
    </invstOrSec>
  </invstOrSecs>
</edgarSubmission>`;

test('N-PORT Part C parses into weights, identifiers and sorted order', () => {
    const rows = fundHoldings.parseHoldings(NPORT);
    assert.equal(rows.length, 3);
    // pctVal is a percentage of net assets; every weight in this codebase is a
    // fraction, so 7.5059% must arrive as 0.075059.
    assert.equal(rows[0].name, 'NVIDIA Corp.');
    assert.ok(Math.abs(rows[0].weight - 0.075059) < 1e-9);
    assert.equal(rows[0].cusip, '67066G104');
    assert.equal(rows[0].isin, 'US67066G1040');
    assert.equal(rows[0].valueUsd, 5000000);
    // Entities are decoded, not left as &amp;.
    assert.equal(rows[1].name, 'Procter & Gamble Co.');
    // Shorts and derivatives carry negative weights and sort last.
    assert.equal(rows[2].weight, -0.0025);
});

test('rows with no name are skipped rather than rendered blank', () => {
    const rows = fundHoldings.parseHoldings('<invstOrSec><pctVal>1.0</pctVal></invstOrSec>');
    assert.equal(rows.length, 0);
});

test('an ambiguous ticker is dropped rather than applied to the wrong share class', () => {
    // "ALPHABET INC-A" and "ALPHABET INC-C" both normalize to the same name and
    // Yahoo lists only GOOG, so a naive match labelled the A shares GOOG too.
    const rows = fundHoldings.mergeSymbols(
        [{ symbol: '', name: 'ALPHABET INC-A', issuer: 'ALPHABET INC' },
         { symbol: '', name: 'ALPHABET INC-C', issuer: 'ALPHABET INC' },
         { symbol: '', name: 'NVIDIA CORP', issuer: 'NVIDIA CORP' }],
        [{ symbol: 'GOOG', name: 'Alphabet Inc.' }, { symbol: 'NVDA', name: 'NVIDIA Corp' }]
    );
    assert.equal(rows[0].symbol, '');
    assert.equal(rows[1].symbol, '');
    // An unambiguous match is still applied.
    assert.equal(rows[2].symbol, 'NVDA');
});

test('exchange symbols are merged in by normalized name, never invented', () => {
    const rows = fundHoldings.mergeSymbols(
        [{ symbol: '', name: 'NVIDIA Corp.', issuer: 'NVIDIA Corp' }, { symbol: '', name: 'Some Private Placement', issuer: '' }],
        [{ symbol: 'NVDA', name: 'NVIDIA Corp' }]
    );
    assert.equal(rows[0].symbol, 'NVDA');
    // N-PORT identifies by CUSIP, not ticker; the tail stays blank.
    assert.equal(rows[1].symbol, '');
});

// ---------------------------------------------------------------------------
// Regression guards on the two call sites that used to truncate silently.
// ---------------------------------------------------------------------------
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('asset search ranks both sources instead of concatenating local first', () => {
    // The old shape — local.concat(remote).slice(0, limit) — let a query that
    // prefix-matched several of the 99 directory companies ("v", "s", "i")
    // fill every slot with equities, so no ETF could appear at all.
    assert.equal(/const out = local\.concat\(remote\.map/.test(appSource), false);
    assert.ok(appSource.includes('const rank = (rows) => rows'));
    assert.ok(appSource.includes('const quota = Math.min(funds.length, Math.floor(limit / 2));'));
});

test('a local fund directory backs short queries Yahoo answers with no funds', () => {
    // Measured 2026-09-07: Yahoo's symbol search returns V/HWGV/TRUM for "v"
    // and S/SI=F/SOL-USD for "s" — no funds at all — so ranking alone can never
    // surface VOO for "vo". The directory is what makes that query work.
    const directory = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'data', 'top-funds.json'), 'utf8'));
    const symbols = new Set(directory.funds.map((row) => row.symbol));
    assert.ok(directory.funds.length >= 150);
    for (const ticker of ['VOO', 'VTI', 'SPY', 'QQQ', 'SCHD', 'BND', 'VTSAX', 'FXAIX', 'GLD']) {
        assert.ok(symbols.has(ticker), `${ticker} missing from the fund directory`);
    }
    // Every row carries a real net-asset figure: the file is generated from
    // live quotes, never hand-written.
    assert.equal(directory.funds.filter((row) => !row.netAssets).length, 0);
    assert.ok(appSource.includes('const directoryRows = directory.filter(take);'));
    assert.ok(appSource.includes('rank(localRows.concat(directoryRows, remoteRows))'));
});

test('London one-letter suffixes are filtered, not offered as US tickers', () => {
    // SPYY.L slipped the old {2,4} bound and would 404 on the profile route.
    assert.ok(appSource.includes('if (/\\.[A-Z]{1,4}$/.test(sym)) return false;'));
});

test('the holdings route exists, is paged, and is capped', () => {
    assert.ok(appSource.includes("app.get('/api/assets/:symbol/holdings'"));
    assert.ok(appSource.includes('Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000)'));
});

test('the ETF overlap tool compares full portfolios, not two top-ten lists', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'free-tools.js'), 'utf8');
    assert.ok(source.includes('fundHoldings.fetchFundHoldings'));
    assert.ok(source.includes("source: complete ? 'SEC Form N-PORT'"));
});

test('the fund page loads the complete portfolio and labels its as-of date', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    assert.ok(source.includes('/holdings?limit='));
    assert.ok(source.includes('Complete portfolio as reported on'));
});

test('the holdings table leads with the company name, not a ticker column', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    // N-PORT carries no exchange symbol, so a ticker column could only ever be
    // filled from Yahoo's ten rows — 8 of VOO's 520 — leaving a sticky, bold,
    // empty column in front of the name the reader is actually scanning.
    assert.ok(source.includes('<thead><tr><th>Holding</th><th>Weight</th></tr></thead>'));
    assert.equal(source.includes('<th>Symbol</th>'), false);
    assert.ok(source.includes('`<tr><td class="row-head">${esc(h.name)}</td>'));
});

test('holdings scroll in a pane sized to the column beside them, with no button', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'system.css'), 'utf8');
    // The page no longer grows to 520 rows, and there is no "Show 100 more".
    assert.equal(source.includes('fund-holdings-more'), false);
    assert.ok(source.includes('class="table-wrap holdings-scroll"'));
    assert.ok(/\.holdings-scroll \{[^}]*overflow-y: auto/s.test(css));
    // macOS overlay scrollbars vanish when idle, so the pane had nothing to
    // grab; styling ::-webkit-scrollbar opts out and keeps a draggable bar.
    assert.ok(css.includes('.holdings-scroll::-webkit-scrollbar-thumb'));
    // Two standard-property traps, both measured on the live page (gutter was
    // 2px, i.e. an ungrabbable hairline):
    //   1. `scrollbar-width` on .holdings-scroll makes Chrome ignore every
    //      ::-webkit-scrollbar rule, so it is scoped to engines without them.
    //   2. attachHScroll() adds .has-hbar, and THAT carries
    //      `scrollbar-width: none` — so the pane opts out of the custom
    //      horizontal bar it never needed.
    assert.ok(css.includes('@supports not selector(::-webkit-scrollbar)'));
    // Pinned exactly: the base rule must carry no `scrollbar-width` of its own
    // (the @supports-scoped one below it is deliberate and must not match here).
    assert.ok(css.includes('.holdings-scroll { overflow-y: auto; overscroll-behavior: contain; }'));
    assert.ok(source.includes('id="fund-holdings-table" data-hbar="off"'));
    // The pane is measured against the allocation column so neither side ends
    // in dead space.
    assert.ok(source.includes("const left = $('fund-left')"));
    assert.ok(source.includes('pane.style.maxHeight'));
    // Column headers must outrank the sticky first column once the pane scrolls.
    assert.ok(css.includes('.holdings-scroll .table-data thead th { z-index: 3; }'));
    // A pane taller than its rows fires no scroll event; that must not stall
    // the list short of the full portfolio.
    assert.ok(source.includes('if (pane.scrollHeight <= pane.clientHeight && loaded < total) loadMore();'));
});

// ---------------------------------------------------------------------------
// Production-readiness guards. Each of these encodes a measured failure, not a
// hypothetical one.
// ---------------------------------------------------------------------------
const secFundIndex = require('../sec-fund-index');

test('the holdings cache is bounded by bytes, not by entry count', () => {
    // BND retains 15.4MB of heap; a 40-entry count cap allowed ~614MB.
    const source = fs.readFileSync(path.join(__dirname, '..', 'fund-holdings.js'), 'utf8');
    assert.ok(source.includes('MEM_MAX_BYTES'));
    assert.equal(/MEM_MAX\s*=\s*\d+/.test(source), false);
});

test('a byte-bounded cache evicts instead of growing without limit', () => {
    const cache = secFundIndex.createCache({ maxBytes: 4096, ttlMs: 60000, missTtlMs: 1000 });
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, { pad: 'x'.repeat(500) });
    assert.ok(cache.stats().bytes <= 4096, `cache held ${cache.stats().bytes} bytes`);
    assert.ok(cache.stats().entries < 50);
    // The most recent write survives; the oldest is gone.
    assert.ok(cache.get('k49'));
    assert.equal(cache.get('k0'), undefined);
});

test('concurrent callers for one key share a single fetch', async () => {
    const cache = secFundIndex.createCache({ maxBytes: 1e6, ttlMs: 60000, missTtlMs: 1000 });
    let runs = 0;
    const loader = async () => { runs++; await new Promise((r) => setTimeout(r, 30)); return { ok: true }; };
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => cache.remember('same', loader)));
    // Without single-flight this is 5 fetch chains against EDGAR's shared throttle.
    assert.equal(runs, 1);
    assert.ok(all.every((r) => r === all[0]));
});

test('a genuine "no filing" is cached; a transient failure never is', async () => {
    const cache = secFundIndex.createCache({ maxBytes: 1e6, ttlMs: 60000, missTtlMs: 60000 });
    let nullRuns = 0;
    await cache.remember('none', async () => { nullRuns++; return null; });
    await cache.remember('none', async () => { nullRuns++; return null; });
    assert.equal(nullRuns, 1, 'a null result should be cached');

    let failRuns = 0;
    const boom = async () => { failRuns++; throw new Error('SEC 429'); };
    await cache.remember('bad', boom).catch(() => {});
    await cache.remember('bad', boom).catch(() => {});
    // One rate-limit response must not pin a fund to "unavailable" for the TTL.
    assert.equal(failRuns, 2, 'a thrown error must not be cached');
});

test('an oversized document is skipped rather than silently failing to write', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'sec-fund-index.js'), 'utf8');
    assert.ok(source.includes('MAX_DOC_BYTES_MONGO'));
    assert.ok(source.includes('over the 16MB document limit'));
    // And the collections expire, so they cannot grow one document per fund forever.
    assert.ok(source.includes('expireAfterSeconds'));
});

test('the AI summary never waits unbounded on EDGAR', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'ai-features.js'), 'utf8');
    assert.ok(source.includes('HOLDINGS_TIMEOUT_MS'));
    assert.ok(source.includes('Promise.race'));
});

test('a fund price is never called "today" unless it is from today', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    // A mutual fund strikes one NAV a day, so its price is always at least a
    // session old; FXAIX showed a 5 September move as "today" on the 7th.
    assert.equal(source.includes("fixed(p.changePercent, 2)}% today`"), false);
    assert.ok(source.includes("priceDay === new Date().toISOString().slice(0, 10)"));
    assert.ok(source.includes("at the ${formatAsOf(priceDay)} NAV"));
});

test('a mutual fund is identified by its family, not by a tradeable venue', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    // Yahoo reports exchange "Nasdaq" for FXAIX, which you cannot trade there.
    assert.ok(source.includes("const venue = isMutualFund ? p.fundFamily : p.exchange;"));
    assert.equal(source.includes("[symbol, p.assetTypeLabel, p.category, p.exchange]"), false);
});

