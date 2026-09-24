#!/usr/bin/env node
/**
 * Screenshots via headless Chrome + the DevTools Protocol. No selenium, no puppeteer.
 *
 * Why this exists: scripts/generate-marketing-screenshots.js needs selenium, which is
 * not installed here, and `chrome --screenshot` cannot set a viewport independent of the
 * OS window minimum (on macOS the window floor is ~500px, so a 390px `--window-size`
 * lays out at ~500 and crops to 390 — silently wrong mobile shots). CDP's
 * Emulation.setDeviceMetricsOverride sets the viewport directly.
 *
 * Usage:
 *   node scripts/screenshot-cdp.js --shot "<url>|<out.png>|<w>|<h>[|full]"[ --shot ...]
 *                                  [--wait 1200] [--ua "..."] [--probe] [--port 9222]
 *
 *   --full   capture the whole document height, not just <h>
 *   --probe  print layout diagnostics (document width vs viewport, widest offenders)
 *
 * One Chrome launch serves every --shot, sequentially.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The site's bot-blocker denies HeadlessChrome and wants modern client hints, so a real
// UA is the default. Harmless for file:// targets.
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes('--' + name);

function parseShots() {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== '--shot') continue;
    const parts = String(process.argv[i + 1] || '').split('|');
    if (parts.length < 4) throw new Error('--shot needs <url>|<out.png>|<w>|<h>[|full]');
    out.push({
      url: parts[0],
      out: parts[1],
      width: parseInt(parts[2], 10),
      height: parseInt(parts[3], 10),
      full: parts[4] === 'full',
    });
  }
  if (!out.length) throw new Error('no --shot given');
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal CDP client: id -> promise, flattened sessions for page targets.
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.method + ': ' + msg.error.message));
        else resolve(msg.result);
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 60000);
    });
  }
}

async function wsUrl(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up on port ' + port);
}

// The diagnostic that turns "it looks clipped" into a number: which element is wider
// than the viewport, and by how much.
const PROBE = `(() => {
  const de = document.documentElement;
  const vw = window.innerWidth;
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > vw + 1 || r.right > vw + 1) {
      wide.push({
        sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''),
        w: Math.round(r.width), right: Math.round(r.right),
      });
    }
  }
  wide.sort((a, b) => b.right - a.right);
  return JSON.stringify({
    viewport: vw,
    docScrollWidth: de.scrollWidth,
    docClientWidth: de.clientWidth,
    overflow: de.scrollWidth - vw,
    offenders: wide.slice(0, 8),
  }, null, 2);
})()`;

async function main() {
  const shots = parseShots();
  const port = parseInt(arg('port', '9222'), 10);
  const wait = parseInt(arg('wait', '1200'), 10);
  const ua = arg('ua', DEFAULT_UA);

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-shots-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });

  const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} };

  try {
    const ws = new WebSocket(await wsUrl(port));
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws failed: ' + chromeErr.slice(0, 400))), { once: true });
    });
    const cdp = new CDP(ws);

    for (const shot of shots) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: ua,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'MacIntel',
      }, sessionId);
      // screenWidth/screenHeight matter: with mobile:true and no screen size, the page's
      // `width=device-width` resolves against an unknown screen and the layout viewport
      // comes out wrong — a 390px shot measured and laid out at 727px. Setting the screen
      // explicitly makes the emulated viewport the viewport.
      // --no-mobile lays a narrow viewport out at exactly that width instead of letting
      // Chrome shrink-to-fit the way a phone would. Under shrink-to-fit, innerWidth reports
      // the *visual* viewport (390) while the page laid out at 727, and getBoundingClientRect
      // returns scaled numbers — so a width overflow is invisible and every measurement lies.
      // Use it to find what is forcing the min-content width; leave it off for a real phone look.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: shot.width,
        height: shot.height,
        screenWidth: shot.width,
        screenHeight: shot.height,
        deviceScaleFactor: 1,
        mobile: shot.width < 700 && !flag('no-mobile'),
      }, sessionId);
      await cdp.send('Emulation.setScrollbarsHidden', { hidden: true }, sessionId);

      await cdp.send('Page.navigate', { url: shot.url }, sessionId);
      // A load event, plus a settle window for fonts, layout and any entry animation.
      await new Promise((res) => {
        const t = setTimeout(res, 15000);
        const onMsg = (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) {
              clearTimeout(t); ws.removeEventListener('message', onMsg); res();
            }
          } catch {}
        };
        ws.addEventListener('message', onMsg);
      });
      await sleep(wait);

      if (flag('probe')) {
        const r = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
        console.log(`\n--- probe ${shot.out} (${shot.width}px) ---`);
        console.log(r.result.value);
      }
      if (arg('eval', '')) {
        const r = await cdp.send('Runtime.evaluate', {
          expression: fs.readFileSync(arg('eval'), 'utf8'),
          returnByValue: true,
          awaitPromise: true,
        }, sessionId);
        if (r.exceptionDetails) throw new Error('--eval threw: ' + JSON.stringify(r.exceptionDetails.exception));
        console.log(`\n--- eval ${shot.out} ---`);
        console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
      }

      let captureHeight = shot.height;
      if (shot.full) {
        const r = await cdp.send('Runtime.evaluate', {
          expression: 'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)',
          returnByValue: true,
        }, sessionId);
        captureHeight = Math.min(Math.ceil(r.result.value) || shot.height, 30000);
        // Same override as above, and for the same reason: dropping screenWidth here (as this
        // call first did) re-lays-out a 390px page at 727px under shrink-to-fit, so the "full"
        // capture silently showed a layout no phone ever renders.
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: shot.width, height: captureHeight,
          screenWidth: shot.width, screenHeight: captureHeight,
          deviceScaleFactor: 1,
          mobile: shot.width < 700 && !flag('no-mobile'),
        }, sessionId);
        await sleep(250);
      }

      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: shot.full,
        fromSurface: true,
      }, sessionId);

      fs.mkdirSync(path.dirname(path.resolve(shot.out)), { recursive: true });
      const buf = Buffer.from(data, 'base64');
      fs.writeFileSync(shot.out, buf);
      console.log(`${shot.out}  ${shot.width}x${captureHeight}  ${buf.length} bytes`);

      await cdp.send('Target.closeTarget', { targetId });
    }
    ws.close();
  } finally {
    cleanup();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error('screenshot-cdp failed:', e.message); process.exit(1); });
