#!/usr/bin/env node
/**
 * The whole OAuth round trip against a LOCAL server, driven through a real
 * browser — the hops no test in this repo covered.
 *
 * Why it exists: scripts/mcp-browser-test.mjs stops at the sign-in form because
 * a production run has no credential to type. That leaves the four hops a
 * ChatGPT connector depends on unexercised end to end: the inline sign-in
 * POSTing /api/login, the consent screen's Allow button, the code that comes
 * back on the redirect, and the token exchange — after which the issued bearer
 * has to work against /mcp *as that account*. Nothing in `npm test` boots
 * app.js at all, so the approve route had no coverage of any kind.
 *
 * It runs against scripts/dev-local.js (in-memory Mongo, production untouched)
 * and signs in with the account that launcher seeds — a local test credential
 * committed in that file, not a real one. Point --base elsewhere and it will
 * happily do the same thing to any server, so don't point it at production.
 *
 * Usage:
 *   ANON_MCP_LOOKUP_LIMIT=1 node scripts/dev-local.js   # in another terminal
 *   node scripts/mcp-oauth-e2e.mjs [--base http://127.0.0.1:5055]
 *                                  [--email rin@gmail.com] [--password devlocal]
 *
 * The ANON_MCP_LOOKUP_LIMIT=1 is not incidental. The launcher's own default is
 * 10000 keyless lookups, which no test can spend; set to 1 the last check can
 * spend the free allowance and prove the issued bearer is billed to the
 * ACCOUNT rather than quietly riding the free tier.
 *
 * Launch it from the REPO ROOT, as its own header says. Run from backend/ and
 * app.js's dotenv finds backend/.env, so NODE_ENV becomes production, oauthBase()
 * switches to https, and a loopback resource is refused invalid_target — a
 * confusing dead end that looks like broken OAuth rather than a wrong cwd.
 */
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      }, 60000);
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

// Runtime.evaluate that tolerates the execution context being torn down
// mid-navigation — which is exactly what happens between "Allow" and the
// redirect landing back on the callback URL.
async function pollEval(cdp, sessionId, expression, done, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await cdp.send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (!r.exceptionDetails) {
        last = r.result.value;
        if (done(last)) return last;
      }
    } catch { /* context destroyed, retry */ }
    await sleep(300);
  }
  return last;
}

async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails.exception));
  }
  return r.result.value;
}

// --- MCP over Streamable HTTP, as a server-side client sends it --------------
function decodeRpc(body) {
  const out = [];
  const push = (s) => { try { out.push(JSON.parse(s)); } catch { /* partial */ } };
  if (/^\s*[[{]/.test(body)) { push(body); return out; }
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) {
      const p = line.slice(5).trim();
      if (p) push(p);
    }
  }
  return out;
}

async function rpc(url, body, token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const msgs = decodeRpc(text);
  return { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate'), msgs, text };
}

async function main() {
  const base = arg('base', 'http://127.0.0.1:5055').replace(/\/$/, '');
  const email = arg('email', 'rin@gmail.com');
  const password = arg('password', 'devlocal');
  const redirectUri = `${base}/oauth-e2e-callback`;
  const mcpUrl = `${base}/mcp`;
  const port = parseInt(arg('port', '9345'), 10);

  console.log(`\n=== OAuth + MCP end to end, in a browser (${base}) ===\n`);

  // 1. Dynamic Client Registration — the step ChatGPT performs for itself.
  const regRes = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Local end-to-end check', redirect_uris: [redirectUri] }),
  });
  const client = await regRes.json().catch(() => ({}));
  check('DCR registers a loopback redirect_uri', regRes.status === 201 && !!client.client_id,
    `HTTP ${regRes.status} · ${client.client_id || JSON.stringify(client).slice(0, 120)}`);

  // 2. The scope comes from the 401 challenge — the instruction a client follows.
  const probe = await rpc(mcpUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'bogus-token');
  const scope = (probe.wwwAuthenticate && /scope="([^"]*)"/.exec(probe.wwwAuthenticate) || [])[1] || '';
  check('the challenge names a scope to request', probe.status === 401 && !!scope,
    `HTTP ${probe.status} · scope="${scope}"`);

  // 3. PKCE, and the authorize URL ChatGPT would build.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');
  const authorizeUrl = `${base}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(client.client_id || '')}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&state=${state}&scope=${encodeURIComponent(scope)}` +
    `&resource=${encodeURIComponent(mcpUrl)}`;

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });

  let code = null;
  try {
    const ws = new WebSocket(await wsUrl(port));
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws failed: ' + chromeErr.slice(0, 300))), { once: true });
    });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.setUserAgentOverride',
      { userAgent: UA, acceptLanguage: 'en-US,en;q=0.9', platform: 'MacIntel' }, sessionId);
    await cdp.send('Page.navigate', { url: authorizeUrl }, sessionId);
    await sleep(1200);

    // 4. Sign in on the consent page's own inline form.
    const form = JSON.parse(await evaluate(cdp, sessionId, `JSON.stringify({
      hasForm: !!document.getElementById('f'),
      title: document.title,
      text: (document.querySelector('.card') || document.body).innerText.replace(/\\s+/g,' ').slice(0,200)
    })`));
    check('the authorize page asks an unauthenticated visitor to sign in',
      form.hasForm, `${form.title} · ${form.text.slice(0, 120)}`);

    await evaluate(cdp, sessionId, `(() => {
      document.getElementById('e').value = ${JSON.stringify(email)};
      document.getElementById('p').value = ${JSON.stringify(password)};
      document.getElementById('f').dispatchEvent(new Event('submit', { cancelable: true }));
      return true;
    })()`);

    // The form reloads the page on success, so the Allow button appearing IS
    // the signal that a session now exists.
    const afterLogin = await pollEval(cdp, sessionId,
      `JSON.stringify({
         allow: !!document.querySelector('button[value="allow"]'),
         err: (document.getElementById('err') || {}).textContent || '',
         text: (document.querySelector('.card') || document.body).innerText.replace(/\\s+/g,' ').slice(0,300)
       })`,
      (v) => { try { const p = JSON.parse(v); return p.allow || !!p.err; } catch { return false; } });
    const consent = JSON.parse(afterLogin || '{}');
    check('signing in reaches the consent screen, naming the account',
      consent.allow === true && new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(consent.text || ''),
      consent.allow ? consent.text.slice(0, 160) : `still on the sign-in form: "${consent.err || 'no error shown'}"`);

    // 5. Allow. This is the only place a code is minted.
    await evaluate(cdp, sessionId, `(() => {
      const b = document.querySelector('button[value="allow"]');
      if (b) b.click();
      return !!b;
    })()`);

    const landed = await pollEval(cdp, sessionId, 'location.href',
      (v) => typeof v === 'string' && (v.includes('code=') || v.includes('error=')));
    const landedUrl = new URL(String(landed));
    const oauthError = landedUrl.searchParams.get('error');
    code = landedUrl.searchParams.get('code');
    check('allowing redirects back to the registered redirect_uri with a code',
      !!code && !oauthError && landedUrl.searchParams.get('state') === state,
      oauthError ? `error=${oauthError} — ${landedUrl.searchParams.get('error_description') || ''}`
        : `code ${String(code).slice(0, 8)}… · state echoed`);

    await cdp.send('Target.closeTarget', { targetId });
    ws.close();
  } finally {
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // 6. Exchange the code, with the PKCE verifier and the same resource.
  let token = null;
  if (code) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: mcpUrl,
    });
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const tok = await res.json().catch(() => ({}));
    token = tok.access_token || null;
    check('the code exchanges for a token', res.status === 200 && !!token,
      `HTTP ${res.status} · ${token ? 'access_token ' + String(token).slice(0, 10) + '… · scope ' + (tok.scope || '(none)') : JSON.stringify(tok).slice(0, 160)}`);

    // Single use, which is what makes a leaked code survivable.
    const replay = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    check('the code cannot be redeemed twice', replay.status === 400,
      `HTTP ${replay.status} ${(await replay.text()).slice(0, 80)}`);
  } else {
    check('the code exchanges for a token', false, 'skipped — no code was issued');
  }

  // 7. The issued bearer has to work against /mcp — and as that account.
  if (token) {
    const init = await rpc(mcpUrl, {
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
    }, token);
    const initMsg = init.msgs[0];
    check('the token authenticates initialize',
      init.status === 200 && !!initMsg && !!initMsg.result,
      `HTTP ${init.status} · ${initMsg && initMsg.result ? initMsg.result.serverInfo.name : init.text.slice(0, 100)}`);

    const list = await rpc(mcpUrl, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, token);
    const tools = ((list.msgs[0] || {}).result || {}).tools || [];
    check('the token lists the tools', tools.length === 6, tools.map((t) => t.name).join(', '));

    const call = await rpc(mcpUrl, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_company_fundamentals', arguments: { ticker: 'AAPL', periods: 1, metrics: ['revenue'] } },
    }, token);
    const res = ((call.msgs[0] || {}).result) || {};
    const errCode = res.structuredContent && res.structuredContent.error && res.structuredContent.error.code;
    check('the token runs a metered tool as that account',
      call.status === 200 && res.isError !== true,
      res.isError === true ? `tool error ${errCode}`
        : `HTTP ${call.status} · ${JSON.stringify(res.structuredContent).slice(0, 200)}`);

    // The control that makes the line above mean something. A keyless caller
    // reaches the same tool on the free allowance, so "it returned data" proves
    // only that the endpoint works — it would say exactly the same thing if the
    // bearer had been thrown away and the call billed to the anonymous tier,
    // which is the failure that would actually cost a customer: their ChatGPT
    // connector quietly living on the free allowance instead of their wallet,
    // with no error anywhere.
    //
    // Response SHAPE cannot tell the two apart — mcp-endpoint.js only injects
    // usage/notice for anonymous callers of aiCost tools, and a lookup tool has
    // no such field — so the free allowance itself is the instrument. Spend it
    // keylessly until the server refuses, then call the tool again with the
    // token: an account's own copy of that tool is charged to its wallet, so it
    // must still be served once the free tier is gone. Nothing about this
    // depends on how much allowance was left at the start, which makes it both
    // decisive and repeatable.
    //
    // The launcher has to be booted at ANON_MCP_LOOKUP_LIMIT=1 (its own default
    // is 10000) or there is no allowance to spend inside a test.
    const lookupArgs = { ticker: 'AAPL', periods: 1, metrics: ['revenue'] };
    const lookupWith = (id, bearer) => rpc(mcpUrl, {
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'get_company_fundamentals', arguments: lookupArgs },
    }, bearer);
    // errorResult() puts nothing in structuredContent, and it names the text
    // field error for a tool result but message for a protocol error.
    const refusalOf = (r) => {
      const msg = r.msgs[0] || {};
      if (msg.error) return { code: msg.error.code, message: msg.error.message || '', protocol: true };
      const res = msg.result || {};
      if (res.isError !== true) return null;
      const text = ((res.content || [])[0] || {}).text || '';
      try {
        const payload = JSON.parse(text);
        return Object.assign(payload, { message: payload.error || payload.message || '' });
      } catch { return { code: '(unparsed)', message: text.slice(0, 120) }; }
    };

    let spent = 0;
    let refusal = null;
    for (let id = 7; id < 19 && !refusal; id++) {
      const r = await lookupWith(id);
      if (r.status !== 200) { refusal = { code: `HTTP ${r.status}`, message: r.text.slice(0, 120) }; break; }
      const err = refusalOf(r);
      if (err) refusal = err; else spent++;
    }
    const allowance = Number((/all (\d+) free data lookups/.exec(String(refusal && refusal.message)) || [])[1]);
    check('the free allowance is spent, so the check below means something',
      !!refusal && refusal.code === 'QUOTA_EXCEEDED' && Number.isFinite(allowance),
      refusal ? `${refusal.code} after ${spent} keyless lookup(s) — ${String(refusal.message).slice(0, 80)}`
        : `12 keyless lookups, none refused — boot the launcher with ANON_MCP_LOOKUP_LIMIT=1`);

    const afterFree = await lookupWith(19, token);
    const freeErr = refusalOf(afterFree);
    check('the token is still served once the free allowance is gone',
      afterFree.status === 200 && !freeErr,
      freeErr ? `refused as ${freeErr.code} — the bearer is being billed to the free tier, not the account`
        : `HTTP ${afterFree.status} · still served with the free allowance spent`);

    const wrongTarget = await rpc(`${base}/mcp/apps`, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, token);
    check('the same token is refused by the other MCP surface',
      wrongTarget.status === 401, `HTTP ${wrongTarget.status}`);

    const bad = await rpc(mcpUrl, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, 'not-a-real-token');
    check('a bogus bearer is still refused', bad.status === 401, `HTTP ${bad.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('mcp-oauth-e2e failed:', e.message); process.exit(1); });
