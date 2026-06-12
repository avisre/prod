#!/usr/bin/env node
// Submit the live sitemap's URLs to IndexNow (Bing, DuckDuckGo, Yandex, Seznam,
// Naver — and the AI engines that read Bing's index). Run after each deploy:
//   node scripts/indexnow-ping.js            # submit every sitemap URL
//   node scripts/indexnow-ping.js URL [URL]  # submit specific URLs only
// The key is public by design (it's served at /<key>.txt for verification).
// Spec: https://www.indexnow.org/documentation — up to 10,000 URLs per POST.

const https = require('https');

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

(async () => {
    let urls = process.argv.slice(2);
    if (!urls.length) {
        const sm = await get(`https://${HOST}/sitemap.xml`);
        if (sm.status !== 200) { console.error('sitemap fetch failed:', sm.status); process.exit(1); }
        urls = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    }
    console.log(`submitting ${urls.length} URLs to IndexNow as ${HOST}`);
    for (let i = 0; i < urls.length; i += 10000) {
        const batch = urls.slice(i, i + 10000);
        const r = await post(batch);
        console.log(`batch ${i / 10000 + 1} (${batch.length} urls): HTTP ${r.status} ${r.body}`);
        if (r.status !== 200 && r.status !== 202) process.exitCode = 1;
    }
})();
