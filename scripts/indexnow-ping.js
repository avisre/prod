#!/usr/bin/env node
// Submit the live sitemap's URLs to the current IndexNow participants. Search
// engines outside IndexNow (including DuckDuckGo) are reached through their
// own crawlers or upstream indexes rather than this endpoint. Run after deploys:
//   node scripts/indexnow-ping.js            # submit recently changed URLs
//   node scripts/indexnow-ping.js --all      # submit every sitemap URL (rare)
//   node scripts/indexnow-ping.js URL [URL]  # submit specific changed URLs
//   node scripts/indexnow-ping.js --queue    # submit only queued changed URLs
// The key is public by design (it's served at /<key>.txt for verification).
// Spec: https://www.indexnow.org/documentation — up to 10,000 URLs per POST.

const https = require('https');
const fs = require('fs');
const path = require('path');

const HOST = 'www.stockportfolio.pro';
const KEY = 'e449a1013681cad5f57dfb04d321918f';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', reject);
    });
}

function post(urlList) {
    const payload = JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList });
    return new Promise((resolve, reject) => {
        const req = https.request('https://api.indexnow.org/IndexNow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 200) }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function parseLocs(xml) {
    return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}
function parseUrlEntries(xml) {
    return [...String(xml || '').matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)]
        .map((m) => ({ loc: m[1], lastmod: m[2] || null }));
}
async function sitemapUrls({ all = false } = {}) {
    const root = await get(`https://${HOST}/sitemap.xml`);
    if (root.status !== 200) throw new Error(`sitemap fetch failed: ${root.status}`);
    const children = /<sitemapindex\b/.test(root.body) ? parseLocs(root.body) : [];
    const docs = children.length ? await Promise.all(children.map(async (url) => {
        const r = await get(url);
        if (r.status !== 200) throw new Error(`child sitemap fetch failed (${r.status}): ${url}`);
        return r.body;
    })) : [root.body];
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    return docs.flatMap(parseUrlEntries)
        .filter((u) => all || !u.lastmod || Date.parse(u.lastmod) >= cutoff)
        .map((u) => u.loc);
}

function queuePath() { return path.join(__dirname, '..', 'seo-data', 'indexnow-queue.json'); }
function readQueue() {
    try { const rows = JSON.parse(fs.readFileSync(queuePath(), 'utf8')); return Array.isArray(rows) ? rows : []; }
    catch (_) { return []; }
}
function writeQueue(rows) { fs.mkdirSync(path.dirname(queuePath()), { recursive: true }); fs.writeFileSync(queuePath(), `${JSON.stringify(rows, null, 2)}\n`); }
async function submitQueue() {
    const rows = readQueue(); const now = Date.now();
    const ready = rows.filter((row) => row.status === 'queued' && (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= now)).slice(0, 10000);
    if (!ready.length) { console.log('no queued IndexNow URLs ready'); return; }
    const urls = [...new Set(ready.map((row) => row.url))]; const response = await post(urls);
    const ok = response.status === 200 || response.status === 202; const submittedAt = new Date().toISOString();
    const selected = new Set(urls);
    const updated = rows.map((row) => {
        if (!selected.has(row.url)) return row;
        const attempts = Number(row.attempt_count || 0) + 1;
        if (ok) return { ...row, status: 'submitted', submitted_at: submittedAt, attempt_count: attempts, next_attempt_at: null, last_error: null };
        const delay = Math.min(6 * 60 * 60 * 1000, 30 * 1000 * (2 ** Math.min(attempts, 8)));
        return { ...row, status: 'queued', attempt_count: attempts, next_attempt_at: new Date(Date.now() + delay).toISOString(), last_error: `HTTP ${response.status}` };
    });
    writeQueue(updated);
    console.log(`queue batch (${urls.length} urls): HTTP ${response.status} ${response.body}`);
    if (!ok) process.exitCode = 1;
}

(async () => {
    const args = process.argv.slice(2);
    if (args.includes('--queue')) { await submitQueue(); return; }
    const all = args.includes('--all');
    let urls = args.filter((x) => x !== '--all');
    if (!urls.length) urls = await sitemapUrls({ all });
    urls = [...new Set(urls)].filter((u) => {
        try { return new URL(u).hostname === HOST; } catch (_) { return false; }
    });
    if (!urls.length) { console.log('no recently changed URLs to submit'); return; }
    console.log(`submitting ${urls.length} URLs to IndexNow as ${HOST}`);
    for (let i = 0; i < urls.length; i += 10000) {
        const batch = urls.slice(i, i + 10000);
        const r = await post(batch);
        console.log(`batch ${i / 10000 + 1} (${batch.length} urls): HTTP ${r.status} ${r.body}`);
        if (r.status !== 200 && r.status !== 202) process.exitCode = 1;
    }
})();
