#!/usr/bin/env node
'use strict';
// Does the receipts panel actually RENDER what the API returns — in a real
// browser, not just in the source? The repo has shipped a correct bundle that
// never reached browsers (a stale ?v= stamp), so the source being right is not
// the claim worth making. This drives headless Chrome over CDP with the admin
// session cookie set, opens the panel, and reads the rendered DOM.
//
//   node tmp-verify-receipts-panel.js [--shot out.png]
//
// Read-only: the page is only viewed. Nothing is sent from here.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require(path.join(__dirname, '../backend/node_modules', 'dotenv')).config({ path: path.join(__dirname, '../backend/.env') });
const jwt = require(path.join(__dirname, '../backend/node_modules', 'jsonwebtoken'));
const { MongoClient } = require(path.join(__dirname, '../backend/node_modules', 'mongodb'));

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const ORIGIN = 'https://www.stockportfolio.pro';
const URL_ADMIN = `${ORIGIN}/admin/messages`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.method + ': ' + m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 60000);
    });
  }
}

// Opens the panel the way a person does — a click on <summary> — then waits for
// the lazy fetch it triggers, and reports the rendered rows.
const READ_PANEL = `(async () => {
  const panel = document.getElementById('receipts-panel');
  if (!panel) return { error: 'no #receipts-panel in the DOM' };
  const summary = panel.querySelector('summary');
  if (summary) summary.click(); else panel.open = true;
  await new Promise((r) => setTimeout(r, 6000));
  const rows = [...document.querySelectorAll('#receipts-list .receipt-row')];
  return {
    url: location.href,
    onAdminPage: !!document.getElementById('receipts-panel'),
    panelOpen: panel.open,
    status: (document.getElementById('receipts-status') || {}).textContent || null,
    renderedRows: rows.length,
    firstRows: rows.slice(0, 3).map((r) => r.innerText.replace(/\\s+/g, ' ').trim().slice(0, 220)),
    hasNoReceiptNotice: document.body.innerText.includes('no receipt (sent before receipts existed)')
  };
})()`;

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const admin = await client.db().collection('users').findOne({ email: 'rin@gmail.com' }, { projection: { _id: 1, authVersion: 1 } });
  await client.close();
  if (!admin) throw new Error('admin row not found');
  const token = jwt.sign({ userId: String(admin._id), v: Number(admin.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: '20m' });

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-receipts-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });

  try {
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl; } catch {}
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error('chrome never came up: ' + chromeErr.slice(0, 300));
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true }); });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US,en;q=0.9', platform: 'MacIntel' }, sessionId);
    // The admin page is gated on this cookie; without it the route answers 404/401
    // and the panel simply would not exist, which would look like a UI failure.
    await cdp.send('Network.setCookie', { name: 'sp_auth', value: token, url: ORIGIN + '/', path: '/', secure: true, httpOnly: true }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, screenWidth: 1400, screenHeight: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

    await cdp.send('Page.navigate', { url: URL_ADMIN }, sessionId);
    await sleep(4000);

    const panel = await cdp.send('Runtime.evaluate', { expression: READ_PANEL, returnByValue: true, awaitPromise: true }, sessionId);
    console.log('--- rendered panel ---');
    console.log(JSON.stringify(panel.result.value, null, 1));

    // The older rows say "0 with receipt"; the notice that explains WHY lives in
    // the per-recipient detail, so it has to be opened to be checked at all.
    const OLD_ROW = `(async () => {
      const openers = [...document.querySelectorAll('[data-receipt-open]')];
      if (!openers.length) return { error: 'no data-receipt-open control' };
      const zeroRow = openers.find((o) => /0 with receipt/.test((o.closest('.receipt-row') || document.body).innerText));
      if (!zeroRow) return { error: 'no row reading "0 with receipt"' };
      zeroRow.click();
      await new Promise((r) => setTimeout(r, 5000));
      const detail = document.getElementById('receipts-detail');
      const text = (detail && detail.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
        detailVisible: !!(detail && !detail.hidden),
        saysNoReceipt: text.includes('no receipt (sent before receipts existed)'),
        head: text.slice(0, 260)
      };
    })()`;
    const detail = await cdp.send('Runtime.evaluate', { expression: OLD_ROW, returnByValue: true, awaitPromise: true }, sessionId);
    console.log('--- 2026-09-23 recipient detail ---');
    console.log(JSON.stringify(detail.result.value, null, 1));

    const shotIdx = process.argv.indexOf('--shot');
    if (shotIdx > -1) {
      const out = process.argv[shotIdx + 1];
      const height = await cdp.send('Runtime.evaluate', { expression: 'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)', returnByValue: true }, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: Math.min(Math.ceil(height.result.value) || 1000, 8000), screenWidth: 1400, screenHeight: Math.min(Math.ceil(height.result.value) || 1000, 8000), deviceScaleFactor: 1, mobile: false }, sessionId);
      await sleep(400);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true }, sessionId);
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      console.log('screenshot:', out);
    }
    ws.close();
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
