#!/usr/bin/env node
/* Shared, dependency-free helpers for the SEO control plane.
 *
 * These scripts intentionally read local rendered output and exports. They do
 * not contact Google/Bing, mutate production, or read credentials. A report
 * should be reproducible from the same checkout and input exports.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SITE = 'https://www.stockportfolio.pro';

function readCsv(file) {
  if (!file || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  const flush = () => { row.push(cell); cell = ''; };
  const finish = () => { flush(); if (row.some((v) => v !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') flush();
    else if (ch === '\n') finish();
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) finish();
  if (!rows.length) return [];
  const headers = rows.shift().map((v) => String(v || '').trim());
  return rows.map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i] || ''])));
}

function num(value) {
  const n = Number(String(value ?? '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : 0;
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function absoluteUrl(href) {
  if (!href) return '';
  try { return new URL(href, SITE).toString(); } catch (_) { return ''; }
}

function routeFromUrl(url) {
  try {
    const u = new URL(url, SITE);
    return u.pathname;
  } catch (_) { return String(url || ''); }
}

function renderPath(route) {
  const seoPages = require(path.join(ROOT, 'backend', 'seo-pages'));
  const seoExtra = require(path.join(ROOT, 'backend', 'seo-extra'));
  const match = String(route || '').match(/^\/stocks\/([^/]+)\/([^/]+)$/i);
  if (match && seoExtra.METRICS[match[2].toLowerCase()]) {
    return seoExtra.renderMetricPage(match[1], match[2].toLowerCase());
  }
  const stock = String(route || '').match(/^\/stocks\/([^/]+)$/i);
  if (stock) return seoPages.renderStockPage(stock[1]);
  const compare = String(route || '').match(/^\/compare\/([^/]+)$/i);
  if (compare) {
    const out = seoExtra.renderComparePage(compare[1]);
    return out && out.html ? out.html : out;
  }
  return null;
}

function extractHtml(html, route = '') {
  const source = String(html || '');
  const first = (re) => { const m = source.match(re); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  const all = (re) => [...source.matchAll(re)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
  const canonical = first(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || first(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const description = first(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || first(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const robots = first(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i) || first(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']robots["']/i);
  const title = first(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1 = first(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, '');
  const h2 = all(/<h2[^>]*>([\s\S]*?)<\/h2>/gi).map((v) => v.replace(/<[^>]+>/g, ''));
  const links = all(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi).map(absoluteUrl).filter(Boolean);
  const jsonld = all(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi).map((value) => {
    try { return JSON.parse(value); } catch (_) { return { invalid: true }; }
  });
  const text = source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const h1End = source.search(/<h1[^>]*>/i);
  const afterH1 = h1End >= 0 ? source.slice(h1End).replace(/<h1[\s\S]*?<\/h1>/i, '') : source;
  const opening = afterH1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  const headings = h2.join(' | ');
  return {
    route,
    status: html ? 200 : 404,
    canonical,
    robots,
    title,
    titleLength: title.length,
    description,
    descriptionLength: description.length,
    h1,
    h2,
    opening,
    structuredData: jsonld,
    links: unique(links),
    internalOutboundLinks: unique(links.filter((link) => link.startsWith(SITE))),
    headingText: headings,
    indexable: Boolean(html && /index\s*,?\s*follow|index\s+follow/i.test(robots || 'index, follow')),
    responseSizeBytes: Buffer.byteLength(source, 'utf8'),
    sourceVisible: /(?:SEC\s+EDGAR|SEC filings|source:)/i.test(source),
    criticalContentStatus: Boolean(html && h1 && opening),
  };
}

function sitemapEntries() {
  const seoPages = require(path.join(ROOT, 'backend', 'seo-pages'));
  const xml = seoPages.buildSitemap();
  const index = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/sitemap>/g)];
  const entries = [];
  for (const [, shardUrl] of index) {
    const shard = shardUrl.split('/').pop().replace(/\.xml$/, '');
    const shardXml = seoPages.buildSitemapShard(shard) || '';
    for (const match of shardXml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
      entries.push({ loc: match[1], lastmod: match[2], shard });
    }
  }
  return entries;
}

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function writeText(file, value) { ensureDir(file); fs.writeFileSync(file, `${String(value).replace(/\s+$/, '')}\n`); }

module.exports = { ROOT, SITE, readCsv, num, unique, absoluteUrl, routeFromUrl, renderPath, extractHtml, sitemapEntries, writeJson, writeText };
