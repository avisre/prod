#!/usr/bin/env node
/**
 * Walks the ChatGPT-connector path in a REAL browser (headless Chrome over CDP).
 *
 * Why a browser and not curl: the acceptance test is "I can use it from my
 * ChatGPT account in a browser". curl proves the server answers; only a browser
 * proves the page a person actually lands on renders, that the inline sign-in
 * form posts, and that no hop in the chain answers 402 to a real client.
 *
 * What it cannot do: the two hops that need a human credential — a successful
 * sign-in, and the approve POST that follows it — plus creating the connector
 * inside ChatGPT. Everything up to and including "the sign-in form returns a
 * clean error for bad credentials" is automated here.
 *
 * Usage: node scripts/mcp-browser-test.mjs [--port 9333] [--out /tmp/mcp-browser]
 */
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.MCP_BROWSER_BASE || 'https://www.stockportfolio.pro';
// The bot blocker denies HeadlessChrome, so a real UA is required.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// The redirect ChatGPT registers for custom connectors. If this ever changes,
// registration must still accept it — that is what the DCR step checks.
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- results -----------------------------------------------------------------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}
function note(text) { console.log(`      ${text}`); }

// --- minimal CDP client (same shape as scripts/screenshot-cdp.js) ------------
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
      }, 90000);
    });
  }
}

async function wsUrl(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up on port ' + port);
}

async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails.exception));
  }
  return r.result.value;
}

async function goto(cdp, ws, sessionId, url, settle = 1200) {
  await cdp.send('Page.navigate', { url }, sessionId);
  await new Promise((res) => {
    const t = setTimeout(res, 20000);
    const onMsg = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) {
          clearTimeout(t); ws.removeEventListener('message', onMsg); res();
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', onMsg);
  });
  await sleep(settle);
}

// --- SSE / JSON-RPC decoding -------------------------------------------------
function decodeRpc(body) {
  const out = [];
  const push = (s) => { try { out.push(JSON.parse(s)); } catch { /* partial */ } };
  if (/^\s*[[{]/.test(body)) { push(body); return out; }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload) push(payload);
  }
  return out;
}

// Runs inside the page: a same-origin MCP POST exactly as an MCP client sends it.
function mcpPostExpr(body, headers) {
  return `(async () => {
  const H = Object.assign({
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream'
  }, ${JSON.stringify(headers || {})});
  try {
    const r = await fetch('/mcp', { method: 'POST', headers: H, body: ${JSON.stringify(JSON.stringify(body))} });
    const t = await r.text();
    return JSON.stringify({
      threw: false, status: r.status,
      contentType: r.headers.get('content-type'),
      wwwAuthenticate: r.headers.get('www-authenticate'),
      allow: r.headers.get('allow'),
      body: t
    });
  } catch (e) {
    return JSON.stringify({ threw: true, error: String(e) });
  }
})()`;
}

async function mcpCall(cdp, sid, body, headers) {
  const raw = await evaluate(cdp, sid, mcpPostExpr(body, headers));
  const parsed = JSON.parse(raw);
  if (parsed.threw) return { threw: true, error: parsed.error };
  return { ...parsed, rpc: decodeRpc(parsed.body) };
}

const RPC = (id, method, params) =>
  ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

async function main() {
  const port = parseInt(arg('port', '9333'), 10);
  const outDir = arg('out', path.join(os.tmpdir(), 'mcp-browser'));
  fs.mkdirSync(outDir, { recursive: true });

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-browser-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });

  try {
    const ws = new WebSocket(await wsUrl(port));
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws failed: ' + chromeErr.slice(0, 300))), { once: true });
    });
    const cdp = new CDP(ws);

    const open = async (url) => {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Network.setUserAgentOverride',
        { userAgent: UA, acceptLanguage: 'en-US,en;q=0.9', platform: 'MacIntel' }, sessionId);
      if (url) await goto(cdp, ws, sessionId, url);
      return { targetId, sessionId };
    };

    console.log(`\n=== StockPortfolio MCP — browser path (${BASE}) ===\n`);

    // Origin for same-origin fetches. robots.txt: a trivial document that still
    // gives the page the site's real origin.
    const main_ = await open(`${BASE}/robots.txt`);
    const sid = main_.sessionId;

    // 1. The GET that used to answer 402 to a datacenter client.
    const getRaw = await evaluate(cdp, sid, `(async () => {
      try {
        const r = await fetch('/mcp', { headers: { 'accept': 'application/json, text/event-stream' } });
        return JSON.stringify({ threw:false, status:r.status, contentType:r.headers.get('content-type'), allow:r.headers.get('allow'), body:(await r.text()).slice(0,300) });
      } catch (e) { return JSON.stringify({ threw:true, error:String(e) }); }
    })()`);
    const getRes = JSON.parse(getRaw);
    check('GET /mcp answers 405 (not 402) to a real browser',
      !getRes.threw && getRes.status === 405,
      getRes.threw ? getRes.error : `HTTP ${getRes.status} ${getRes.body || ''}`.slice(0, 160));

    // 2. initialize
    const init = await mcpCall(cdp, sid, RPC(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'chatgpt-connector-browser-check', version: '1.0.0' },
    }));
    const initMsg = init.rpc && init.rpc[0];
    check('initialize returns a server identity over SSE',
      !!initMsg && !!initMsg.result && initMsg.result.serverInfo,
      initMsg && initMsg.result
        ? `HTTP ${init.status} · ${initMsg.result.serverInfo.name} ${initMsg.result.serverInfo.version} · protocol ${initMsg.result.protocolVersion}`
        : `HTTP ${init && init.status} · ${String(init && (init.body || init.error)).slice(0, 160)}`);

    // 3. notifications/initialized (no id — 202 Accepted, empty body)
    const inited = await mcpCall(cdp, sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
    check('notifications/initialized is accepted', inited.threw !== true && inited.status < 400,
      inited.threw ? inited.error : `HTTP ${inited.status}`);

    // 4. tools/list — the names the connector will show
    const list = await mcpCall(cdp, sid, RPC(2, 'tools/list', {}));
    const tools = (list.rpc && list.rpc[0] && list.rpc[0].result && list.rpc[0].result.tools) || [];
    const names = tools.map((t) => t.name);
    check('tools/list returns the catalog', names.length === 6, names.join(', '));
    if (names.length) {
      note('titles: ' + tools.map((t) => `${t.name}=${t.title || '(none)'}`).join(' · '));
      const withSchema = tools.filter((t) => t.inputSchema && t.inputSchema.type === 'object').length;
      const readOnly = tools.filter((t) => t.annotations && t.annotations.readOnlyHint === true).length;
      check('every tool has an object inputSchema', withSchema === tools.length, `${withSchema}/${tools.length}`);
      check('every tool is annotated read-only', readOnly === tools.length, `${readOnly}/${tools.length}`);
    }

    // 5. company search, keyless (one lookup from the allowance) — the first thing a new connector does
    const search = await mcpCall(cdp, sid, RPC(3, 'tools/call', {
      name: 'search_companies', arguments: { query: 'Apple', limit: 3 },
    }));
    const sres = search.rpc && search.rpc[0] && search.rpc[0].result;
    const sStruct = sres && sres.structuredContent;
    const sText = sres && Array.isArray(sres.content) && sres.content[0] && sres.content[0].text;
    check('search_companies answers keyless', !!sStruct && sres.isError !== true,
      sStruct ? `HTTP ${search.status} · ${JSON.stringify(sStruct).slice(0, 180)}` : String(sText || '').slice(0, 180));

    // 6. A metered tool with no credential. It is allowed within the anonymous
    //    allowance, so the pass condition is not "refused" — it is that the
    //    answer arrives as a TOOL RESULT and the transport never raises the 402
    //    wall that used to make a fresh connector look like a dead server.
    const metered = await mcpCall(cdp, sid, RPC(4, 'tools/call', {
      name: 'get_company_fundamentals', arguments: { ticker: 'AAPL', periods: 1 },
    }));
    const mres = metered.rpc && metered.rpc[0] && metered.rpc[0].result;
    const mcode = mres && mres.structuredContent && mres.structuredContent.error &&
      mres.structuredContent.error.code;
    const mServed = !!mres && mres.isError !== true;
    const mCoded = !!mres && mres.isError === true && !!mcode;
    check('metered tool keyless answers as a tool result, never HTTP 402',
      metered.status !== 402 && (mServed || mCoded),
      metered.threw ? metered.error
        : `HTTP ${metered.status} · ${mServed ? 'served within the anon allowance' : mCoded ? 'tool error ' + mcode : 'malformed response'}`);

    // 7. OAuth discovery documents, parsed by the browser
    const asMeta = await evaluate(cdp, sid, `(async () => {
      const out = {};
      for (const u of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
        try { const r = await fetch(u); out[u] = { status: r.status, body: await r.json() }; }
        catch (e) { out[u] = { error: String(e) }; }
      }
      return JSON.stringify(out);
    })()`);
    const meta = JSON.parse(asMeta);
    const prm = meta['/.well-known/oauth-protected-resource'];
    const asm = meta['/.well-known/oauth-authorization-server'];
    check('protected-resource metadata is valid JSON',
      prm && prm.status === 200 && Array.isArray(prm.body.authorization_servers),
      prm && prm.status === 200 ? `resource ${prm.body.resource} · AS ${prm.body.authorization_servers.join(',')}` : JSON.stringify(prm).slice(0, 160));
    check('authorization-server metadata advertises DCR + PKCE S256',
      asm && asm.status === 200 && !!asm.body.registration_endpoint &&
      (asm.body.code_challenge_methods_supported || []).includes('S256'),
      asm && asm.status === 200
        ? `register ${asm.body.registration_endpoint} · auth methods ${JSON.stringify(asm.body.token_endpoint_auth_methods_supported)}`
        : JSON.stringify(asm).slice(0, 160));

    // 8. Dynamic Client Registration, from the browser, with ChatGPT's redirect
    const regRaw = await evaluate(cdp, sid, `(async () => {
      try {
        const r = await fetch('/oauth/register', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_name: 'ChatGPT connector (browser check)', redirect_uris: [${JSON.stringify(CHATGPT_REDIRECT)}] })
        });
        return JSON.stringify({ threw:false, status:r.status, body: await r.text() });
      } catch (e) { return JSON.stringify({ threw:true, error:String(e) }); }
    })()`);
    const reg = JSON.parse(regRaw);
    let clientId = null;
    try { clientId = JSON.parse(reg.body).client_id; } catch { /* leave null */ }
    check('DCR accepts ChatGPT\'s redirect_uri', !reg.threw && reg.status === 201 && !!clientId,
      reg.threw ? reg.error : `HTTP ${reg.status} · client_id ${clientId || '(none)'}`);

    // 9. Read the scope out of the 401 challenge rather than assuming one: the
    //    challenge is the instruction a client follows, so the consent request
    //    below asks for exactly what it advertised. That round trip is the one
    //    that failed before 2026-09-30 — /mcp advertised "mcp" and
    //    /oauth/authorize refused it with invalid_scope.
    const chalRaw = await evaluate(cdp, sid, `(async () => {
      try {
        const r = await fetch('/mcp', { method:'POST',
          headers: { 'content-type':'application/json', 'accept':'application/json, text/event-stream',
                     'authorization':'Bearer not-a-real-token' },
          body: JSON.stringify({ jsonrpc:'2.0', id:8, method:'tools/list' }) });
        return JSON.stringify({ threw:false, status:r.status, wa:r.headers.get('www-authenticate'), body:(await r.text()).slice(0,200) });
      } catch (e) { return JSON.stringify({ threw:true, error:String(e) }); }
    })()`);
    const chal = JSON.parse(chalRaw);
    const chalScope = (chal.wa && /scope="([^"]*)"/.exec(chal.wa) || [])[1] || '';
    check('a bad bearer gets a 401 challenge naming scopes',
      !chal.threw && chal.status === 401 && !!chalScope,
      chal.threw ? chal.error : `HTTP ${chal.status} · scope="${chalScope}"`);

    // 10. The consent page an unauthenticated person lands on. This is the hop
    //     that must render a sign-in form — not a 402, not an error page.
    let authorizeUrl = null;
    if (clientId) {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const pkce = crypto.createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomBytes(8).toString('hex');
      authorizeUrl = `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT)}` +
        `&code_challenge=${pkce}&code_challenge_method=S256&state=${state}` +
        `&scope=${encodeURIComponent(chalScope)}&resource=${encodeURIComponent(BASE + '/mcp')}`;
      note('consent request asks for the challenge\'s own scope: ' + JSON.stringify(chalScope));

      const auth = await open(authorizeUrl);
      const page = await evaluate(cdp, auth.sessionId, `JSON.stringify({
        status: document.readyState,
        url: location.href,
        title: document.title,
        hasForm: !!document.getElementById('f'),
        hasEmail: !!document.getElementById('e'),
        hasPassword: !!document.getElementById('p'),
        text: (document.querySelector('.card') || document.body).innerText.replace(/\\s+/g,' ').slice(0,400)
      })`);
      const p = JSON.parse(page);
      const landedOffsite = !String(p.url).startsWith(BASE);
      // The heading is the <h1> in the card, not <title> — the document title is
      // "Connect <client>" on both the sign-in and the consent variant.
      check('consent page renders a sign-in form (no 402, no error page)',
        p.hasForm && p.hasEmail && p.hasPassword && !landedOffsite && /Sign in to connect/i.test(p.text),
        landedOffsite
          ? `redirected off-site to ${p.url} — an OAuth error came back instead of a consent screen`
          : `${p.title} · ${p.text.slice(0, 150)}`);

      const shot = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true, fromSurface: true }, auth.sessionId);
      const shotPath = path.join(outDir, 'oauth-signin.png');
      fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      note('screenshot: ' + shotPath);

      if (!p.hasForm) {
        check('sign-in form surfaces a clean error for bad credentials', false,
          'skipped — the consent page never rendered');
      } else {
        // 11. The inline form's submit path, with credentials that are wrong on
        //     purpose: the page must show a clean error, not crash and not 402.
        const submit = await evaluate(cdp, auth.sessionId, `(async () => {
          const err = document.getElementById('err');
          document.getElementById('e').value = 'not-a-real-account-' + Date.now() + '@example.com';
          document.getElementById('p').value = 'definitely-not-the-password';
          document.getElementById('f').dispatchEvent(new Event('submit', { cancelable: true }));
          for (let i = 0; i < 60 && !err.textContent; i++) await new Promise(r => setTimeout(r, 250));
          return JSON.stringify({ err: err.textContent, stillOnAuthorize: location.pathname === '/oauth/authorize' });
        })()`);
        const sub = JSON.parse(submit);
        check('sign-in form surfaces a clean error for bad credentials',
          !!sub.err && sub.stillOnAuthorize && !/402|payment/i.test(sub.err),
          `"${sub.err}"`);
      }
      await cdp.send('Target.closeTarget', { targetId: auth.targetId });
    } else {
      check('consent page renders a sign-in form (no 402, no error page)', false, 'skipped — no client_id');
    }

    // 12. Informational: what a browser page on ANOTHER origin sees. ChatGPT's
    //     connector is server-side, so this is not required to pass — it only
    //     matters for browser-based MCP clients.
    const foreign = await open('https://example.com');
    const corsRaw = await evaluate(cdp, foreign.sessionId, `(async () => {
      try {
        const r = await fetch(${JSON.stringify(BASE + '/mcp')}, {
          method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/list' })
        });
        return JSON.stringify({ threw:false, status:r.status, acao:r.headers.get('access-control-allow-origin'), body:(await r.text()).slice(0,200) });
      } catch (e) { return JSON.stringify({ threw:true, error:String(e) }); }
    })()`);
    const cors = JSON.parse(corsRaw);
    note(`cross-origin probe (informational): ${cors.threw ? 'blocked — ' + cors.error.slice(0, 120) : `HTTP ${cors.status}, allow-origin=${cors.acao}`}`);
    await cdp.send('Target.closeTarget', { targetId: foreign.targetId });

    ws.close();
  } finally {
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('mcp-browser-test failed:', e.message); process.exit(1); });
