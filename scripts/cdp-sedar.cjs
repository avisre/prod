#!/usr/bin/env node
'use strict';
// Minimal CDP driver for the sedarplus.ca tab in the debug browser (127.0.0.1:9222).
// Runs a JS expression INSIDE the page (first-party cookies/session) and prints the result.
//
//   node scripts/cdp-sedar.cjs 'document.title'
//   node scripts/cdp-sedar.cjs 'fetch("/path").then(r=>r.text())'   # promises are awaited
//
// Local-only. Used for the approved 2-PDF Bird Construction pilot retrieval.

let expr = process.argv.slice(2).join(' ');
if (expr.startsWith('@')) expr = require('fs').readFileSync(expr.slice(1), 'utf8');
if (!expr) { console.error('usage: cdp-sedar.cjs <expression|@file>'); process.exit(2); }

const http = require('http');

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

(async () => {
    const targets = await getJson('http://127.0.0.1:9222/json');
    const page = targets.find(t => t.type === 'page' && t.url.includes('sedarplus.ca'));
    if (!page) { console.error('no sedarplus tab'); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params) => new Promise((resolve, reject) => {
        const myId = ++id;
        pending.set(myId, m => m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
        ws.send(JSON.stringify({ id: myId, method, params }));
    });
    await new Promise(r => ws.onopen = r);
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
        console.error('PAGE EXCEPTION:', JSON.stringify(res.exceptionDetails).slice(0, 600));
        process.exit(1);
    }
    const v = res.result?.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    ws.close();
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
