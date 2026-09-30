#!/usr/bin/env node
// Record the walkthrough video the OpenAI plugin review asks for.
//
// Step 5 of the review dialog: "Share a recording that demonstrates your
// plugin's test cases and functionality. It will not be shared externally."
// The URL has to go in plugin.json (extensions.com.openai.review.
// demo_recording_url) — there is no dashboard field for it — so this produces
// the file that gets uploaded to the site and named there.
//
// Nothing here is mocked. Every value on screen comes from a live MCP session
// against production, run at record time, and the figures the reviewer's
// expected_behavior records are the ones the presentation calls out. The
// Authorization header is never rendered, so the recording cannot leak the
// credential it was made with.
//
// Two hard-won constraints shape the design:
//
//   1. The recorder owns the timeline, not the page. An earlier version paced
//      the reveal with setTimeout inside the page and had it set window.__done
//      at the end; when the tab was not the visible one Chrome throttled those
//      timers and the take never finished. Now the page only renders what it is
//      told to (`window.__show`) and this script does all the waiting on Node
//      timers, which are never throttled.
//   2. Frames are polled with Page.captureScreenshot, never Page.startScreencast.
//      Screencast is change-driven and halts the stream if a frame goes
//      unacknowledged, which silently truncated one take at test case 3 — a
//      30-second video for a 48-second page, with no error anywhere.
//
// Usage:
//   node scripts/record-mcp-walkthrough.mjs                       # writes the asset
//   node scripts/record-mcp-walkthrough.mjs --out /tmp/take.mp4
//   CDP_PORT=9333 node scripts/record-mcp-walkthrough.mjs
//
// Needs a Chrome already listening on the CDP port (the repo's usual
// /tmp/chatgpt-drive profile on 9333) and ffmpeg on PATH.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..');
const SDK = path.join(ROOT, 'backend', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs');
const { Client } = require(path.join(SDK, 'client', 'index.js'));
const { StreamableHTTPClientTransport } = require(path.join(SDK, 'client', 'streamableHttp.js'));

const WIDTH = 1280;
const HEIGHT = 720;
const LEAD_MS = 900;    // beat before the first line
const BLOCK_MS = 1100;  // per revealed line — long enough to read a figure
const CASE_MS = 2800;   // pause between test cases
const OUTRO_MS = 3400;  // how long the closing card rests on screen
const FRAME_MS = 100;   // capture cadence (~10 fps)
const HOLD_S = 1.2;     // extra rest on the final frame in the encode

function parseArgs(argv) {
    const args = {
        url: 'https://www.stockportfolio.pro/mcp/apps',
        keyFile: path.join(os.homedir(), '.config', 'stockportfolio', 'api-key'),
        cdpPort: process.env.CDP_PORT || '9333',
        out: path.join(ROOT, 'frontend-v2', 'assets', 'plugin-walkthrough.mp4')
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--url') args.url = argv[++i];
        else if (argv[i] === '--key-file') args.keyFile = argv[++i];
        else if (argv[i] === '--cdp-port') args.cdpPort = argv[++i];
        else if (argv[i] === '--out') args.out = argv[++i];
        else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    return args;
}

function readKey(args) {
    if (process.env.SP_API_KEY) return process.env.SP_API_KEY.trim();
    try { return fs.readFileSync(args.keyFile, 'utf8').trim(); } catch (_) { return ''; }
}

const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : String(value));
const pct = (value) => `${Number(value).toFixed(2)}%`;
// The recording date is shown to the reviewer, so it uses the machine's local
// day rather than the UTC one — this box is IST, where those differ by a day.
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// --- the five cases, exactly as the reviewer will read them -----------------
// Arguments mirror the prompt in each case, so what the video shows is what the
// reviewer sees when they type it themselves.
const CASES = [
    {
        prompt: "Show Apple's revenue for the last five fiscal years.",
        tool: 'get_company_financials',
        args: { company: 'AAPL', metrics: ['revenue'], period_type: 'annual', periods: 5 },
        render(p) {
            const series = p.metrics.find((m) => m.metric === 'revenue');
            // Every observation carries its own filing, so each line names one
            // rather than a single source note at the bottom.
            return series.observations.map((o) => [
                `<span class="k">FY ending ${esc(o.period_end)}</span>`,
                `<span class="v">${num(o.value)}</span>`,
                `<span class="d">${esc(o.units)} · ${esc(o.source.form)} filed ${esc(o.source.filing_date)} · ${esc(o.source.accession_number)}</span>`
            ].join('  '));
        }
    },
    {
        prompt: "Find Microsoft's latest 10-Q.",
        tool: 'search_filings',
        args: { company: 'MSFT', forms: ['10-Q'], limit: 1 },
        render(p) {
            const f = p.filings[0];
            return [
                `<span class="d">matched</span> ${num(p.match_count)} filings, returning ${p.filings.length}`,
                `<span class="k">${esc(f.form)}</span> filed <span class="v">${esc(f.filing_date)}</span> for the period ending ${esc(f.report_date)}`,
                `<span class="d">accession</span> ${esc(f.accession_number)}`,
                `<span class="d">source</span> ${esc(f.source_url)}`,
                `<span class="d">metadata only — filing text is never returned by this tool</span>`
            ];
        }
    },
    {
        prompt: 'What did Amazon say about AWS in its latest filing?',
        tool: 'get_filing_content',
        args: { company: 'AMZN', form: '10-K', query: 'AWS', max_excerpts: 3 },
        render(p) {
            const head = [
                `<span class="k">${esc(p.filing.form)}</span> filed ${esc(p.filing.filing_date)}, accession ${esc(p.filing.accession_number)}`,
                `<span class="d">search scope</span> ${esc(p.search_scope)} · ${num(p.match_count)} matches`
            ];
            return head.concat(p.excerpts.slice(0, 3).map((e, i) =>
                `<span class="d">excerpt ${i + 1}</span> ${esc(String(e.text).replace(/\s+/g, ' ').slice(0, 190))}…`));
        }
    },
    {
        prompt: 'Compare operating margins for Amazon, Microsoft and Alphabet.',
        tool: 'compare_company_metrics',
        args: { companies: ['AMZN', 'MSFT', 'GOOGL'], metrics: ['operating_margin'] },
        render(p) {
            const series = p.metrics[0];
            return series.observations.map((o) => [
                `<span class="k">${esc(o.ticker)}</span>`,
                `<span class="v">${Number(o.value).toFixed(4)}%</span>`,
                `<span class="d">period ending ${esc(o.period_end)} · ${esc(o.source.accession_number)}</span>`
            ].join('  ')).concat([
                `<span class="d">note</span> ${esc(p.notes[0])}`
            ]);
        }
    },
    {
        prompt: 'Why did Microsoft\'s EPS grow faster than its revenue last year?',
        tool: 'get_financial_change_drivers',
        args: { company: 'MSFT', period_type: 'annual' },
        render(p) {
            const o = p.observed;
            const e = p.eps_decomposition;
            return [
                `<span class="d">comparing</span> FY ending ${esc(p.current_period.end)} with ${esc(p.prior_period.end)}`,
                `<span class="k">revenue</span>  ${num(o.revenue.current)}  vs  ${num(o.revenue.prior)}  <span class="v">+${pct(o.revenue.change_pct)}</span>`,
                `<span class="k">operating income</span>  ${num(o.operating_income.current)}  vs  ${num(o.operating_income.prior)}  <span class="v">+${pct(o.operating_income.change_pct)}</span>`,
                `<span class="k">net income</span>  ${num(o.net_income.current)}  vs  ${num(o.net_income.prior)}  <span class="v">+${pct(o.net_income.change_pct)}</span>`,
                `<span class="d">EPS</span> ${e.eps_current} vs ${e.eps_prior} split into <span class="v">${e.net_income_effect.toFixed(2)}</span> net income and <span class="v">${e.share_count_effect.toFixed(2)}</span> share count`,
                `<span class="d">reported arithmetic, not a causal claim — every input is a filed line item</span>`
            ];
        }
    }
];

const OUTRO = '<strong>Read-only, and never estimated.</strong> Seven tools over MCP: company lookup, '
    + 'financial metrics with the filing behind each fiscal period, metric histories, SEC filing search, '
    + 'filing excerpts, peer comparison, and period-over-period change from reported line items. '
    + 'Values that are not in a filing are returned as missing rather than filled in.';

// --- run the session --------------------------------------------------------
async function runSession(args, key) {
    const client = new Client({ name: 'record-walkthrough', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(args.url), {
        requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} }
    }));
    const call = async (name, callArgs) => {
        const result = await client.callTool({ name, arguments: callArgs });
        const raw = (result.content && result.content[0] && result.content[0].text) || '';
        return JSON.parse(raw);
    };
    const list = await client.listTools();
    const results = [];
    for (const testCase of CASES) results.push(await call(testCase.tool, testCase.args));
    await client.close().catch(() => {});
    return { tools: list.tools.map((t) => t.name), results };
}

// --- the reveal plan --------------------------------------------------------
// A flat list of what appears and how long each beat is held. Node walks it, so
// the pacing is this script's, not the page's.
function buildPlan(session, args) {
    const plan = [{ kind: 'pause', ms: LEAD_MS }];
    CASES.forEach((testCase, index) => {
        plan.push({ kind: 'line', ms: BLOCK_MS, html: `<div class="case">Test case ${index + 1} of 5 &nbsp;·&nbsp; <span class="tool">${esc(testCase.tool)}</span></div>` });
        plan.push({ kind: 'line', ms: BLOCK_MS, html: `<div class="prompt">&ldquo;${esc(testCase.prompt)}&rdquo;</div>` });
        plan.push({ kind: 'line', ms: BLOCK_MS, html: `<div class="call"><span class="d">arguments</span> ${esc(JSON.stringify(testCase.args))}</div>` });
        for (const line of testCase.render(session.results[index])) {
            plan.push({ kind: 'line', ms: BLOCK_MS, html: `<div class="out">${line}</div>` });
        }
        plan.push({ kind: 'pause', ms: CASE_MS });
    });
    plan.push({ kind: 'line', ms: OUTRO_MS, html: `<div id="end">${OUTRO}</div>` });
    const expectedMs = plan.reduce((total, item) => total + item.ms, 0);
    const header = { endpoint: args.url, tools: session.tools, date: localDate(new Date()) };
    return { plan, expectedMs, header };
}

function buildHtml(header) {
    const meta = JSON.stringify(header);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>StockPortfolio.pro — MCP plugin walkthrough</title>
<style>
  html,body{margin:0;background:#0b1120;color:#e2e8f0;
    font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  #bar{padding:14px 24px;border-bottom:1px solid #1e293b;background:#0f172a;
    position:sticky;top:0;z-index:10}
  #bar h1{margin:0;font-size:17px;font-weight:700;letter-spacing:.01em;color:#f8fafc}
  #bar .sub{color:#94a3b8;font-size:12.5px;margin-top:3px}
  #bar .tools{color:#64748b;font-size:12px;margin-top:5px}
  #stage{padding:20px 24px 50vh}
  /* Half a viewport of tail room, or the closing lines clamp at maximum scroll
     and slide up under the sticky bar instead of centring. */
  #stage > div{scroll-margin-top:120px}
  .case{margin:22px 0 10px;color:#f8fafc;font-weight:700;font-size:15px;
    border-top:1px solid #1e293b;padding-top:14px}
  .case:first-child{border-top:0;margin-top:0;padding-top:0}
  .tool{color:#38bdf8;font-weight:700}
  .prompt{color:#fde68a;margin:6px 0 4px}
  .call,.out{margin:3px 0;color:#cbd5e1}
  .out .k{color:#7dd3fc}
  .out .v{color:#4ade80;font-weight:700}
  .out .d{color:#64748b}
  .call .d{color:#64748b}
  .fade{animation:in .18s ease-out}
  @keyframes in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
  #end{margin-top:26px;border-top:1px solid #1e293b;padding-top:16px;color:#94a3b8;font-size:13px;
    margin-bottom:40px}
  #end strong{color:#f8fafc}
</style></head><body>
<div id="bar">
  <h1>StockPortfolio.pro — MCP plugin walkthrough</h1>
  <div class="sub">Live session against <span style="color:#e2e8f0" id="ep"></span> · <span id="dt"></span> · every value below carries its fiscal period and its SEC filing</div>
  <div class="tools" id="tl"></div>
</div>
<div id="stage"></div>
<script>
const META = ${meta};
document.getElementById('ep').textContent = META.endpoint;
document.getElementById('dt').textContent = META.date;
document.getElementById('tl').textContent = 'tools discovered (' + META.tools.length + '): ' + META.tools.join(' · ');
const stage = document.getElementById('stage');
// The page has no clock of its own: the recorder calls this once per beat.
// Anything time-based here would be throttled whenever the tab is not visible.
window.__show = (html) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.className = (el.className ? el.className + ' ' : '') + 'fade';
  stage.appendChild(el);
  const target = el.children.length === 1 ? el.children[0] : el;
  target.scrollIntoView({ block: 'center' });
};
window.__ready = true;
</script></body></html>`;
}

// --- screencast -------------------------------------------------------------
function cdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.addEventListener('open', () => resolve({
            send(method, params = {}) {
                const mid = ++id;
                ws.send(JSON.stringify({ id: mid, method, params }));
                return new Promise((res, rej) => {
                    pending.set(mid, { res, rej });
                    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout: ${method}`)); } }, 30000);
                });
            },
            close() { try { ws.close(); } catch (_) { /* already closed */ } }
        }));
        ws.addEventListener('error', () => reject(new Error('CDP socket failed')));
        ws.addEventListener('message', (ev) => {
            let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
            if (msg.id && pending.has(msg.id)) {
                const p = pending.get(msg.id); pending.delete(msg.id);
                msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
            }
        });
    });
}

async function record(args, html, plan, frameDir) {
    const base = `http://127.0.0.1:${args.cdpPort}`;
    const version = await (await fetch(`${base}/json/version`)).json();
    const browser = await cdp(version.webSocketDebuggerUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const pageInfo = (await (await fetch(`${base}/json/list`)).json()).find((t) => t.id === targetId);
    const page = await cdp(pageInfo.webSocketDebuggerUrl);

    // A capture is bounded by the real compositor surface, not by the emulated
    // viewport: asking for a taller override than the window can show clips the
    // bottom off every frame instead of scaling it down. So size the window
    // first, then read back what the page actually got and emulate exactly that.
    const original = await browser.send('Browser.getWindowForTarget', { targetId }).catch(() => null);
    if (original) {
        await browser.send('Browser.setWindowBounds', {
            windowId: original.windowId,
            bounds: { width: WIDTH, height: 810, windowState: 'normal' }
        }).catch(() => {});
        // A throttled background tab renders at about a frame a second, which
        // would make the video stutter, so make this the visible tab.
        await browser.send('Target.activateTarget', { targetId }).catch(() => {});
    }
    await page.send('Page.enable');
    const measured = await page.send('Runtime.evaluate', { expression: 'window.innerHeight', returnByValue: true });
    const viewportHeight = Number(measured.result && measured.result.value) || HEIGHT;
    // libx264 refuses odd dimensions, and the viewport height lands on whatever
    // the window chrome leaves behind, so round down to an even number.
    const height = viewportHeight % 2 === 0 ? viewportHeight : viewportHeight - 1;
    await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: `file://${html}` });

    // Wait for the page's own script before capturing, so the video opens on
    // the header rather than on a loading flash.
    for (let i = 0; i < 100; i++) {
        const ready = await page.send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true }).catch(() => null);
        if (ready && ready.result && ready.result.value === true) break;
        await new Promise((r) => setTimeout(r, 100));
    }

    // Screenshots on our own clock rather than Page.startScreencast, which is
    // change-driven and halts the stream if a frame goes unacknowledged — that
    // silently truncated an earlier take at the third test case.
    const frames = [];
    const digests = new Set();
    const started = Date.now();
    const capture = async () => {
        const at = Date.now();
        const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }).catch(() => null);
        if (!shot || !shot.data) return;
        const buf = Buffer.from(shot.data, 'base64');
        const file = path.join(frameDir, `f${String(frames.length).padStart(5, '0')}.jpg`);
        fs.writeFileSync(file, buf);
        frames.push({ file, ts: (at - started) / 1000 });
        digests.add(crypto.createHash('md5').update(buf).digest('hex'));
    };
    const hold = async (ms) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const at = Date.now();
            await capture();
            const spent = Date.now() - at;
            if (spent < FRAME_MS) await new Promise((r) => setTimeout(r, FRAME_MS - spent));
        }
    };

    for (const item of plan) {
        if (item.kind === 'line') {
            await page.send('Runtime.evaluate', { expression: `window.__show(${JSON.stringify(item.html)})`, returnByValue: true });
        }
        await hold(item.ms);
    }

    page.close();
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    if (original && original.bounds) {
        await browser.send('Browser.setWindowBounds', { windowId: original.windowId, bounds: original.bounds }).catch(() => {});
    }
    browser.close();

    console.log(`Viewport: ${WIDTH}x${height}`);
    console.log(`Frames:   ${frames.length} (${digests.size} distinct)`);
    // A capture that returned the same picture over and over means the tab was
    // throttled or the compositor was not keeping up; either way there is no
    // video to publish.
    if (digests.size < 5) throw new Error(`the capture never changed (${digests.size} distinct frames) — the tab was probably throttled`);
    const span = frames[frames.length - 1].ts * 1000;
    if (span < plan.reduce((t, i) => t + i.ms, 0) - 2000) {
        throw new Error(`capture stopped after ${(span / 1000).toFixed(1)}s — the video would be incomplete`);
    }
    return frames;
}

function encode(frames, out) {
    const listFile = path.join(path.dirname(frames[0].file), 'frames.txt');
    const lines = [];
    frames.forEach((frame, i) => {
        const next = frames[i + 1];
        // Duration is the real gap to the next frame; the last one holds for a
        // beat so the closing card is readable.
        const seconds = next ? Math.max(0.02, next.ts - frame.ts) : HOLD_S;
        lines.push(`file '${path.basename(frame.file)}'`, `duration ${seconds.toFixed(3)}`);
    });
    lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
    fs.writeFileSync(listFile, lines.join('\n'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        // Belt and braces on the even-dimension rule libx264 enforces.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-vsync', 'vfr', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-c:v', 'libx264', '-crf', '26',
        out
    ], { stdio: 'inherit' });
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log('Usage: node scripts/record-mcp-walkthrough.mjs [--out <file.mp4>] [--url <mcp-url>] [--cdp-port <port>]');
        return 0;
    }
    const key = readKey(args);
    if (!key) { console.error(`No credential: set SP_API_KEY or write ${args.keyFile}`); return 1; }

    console.log(`Session: ${args.url}`);
    const session = await runSession(args, key);
    console.log(`Tools:   ${session.tools.length}`);
    const { plan, expectedMs, header } = buildPlan(session, args);
    console.log(`Timeline: ${(expectedMs / 1000).toFixed(1)}s`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-'));
    const html = path.join(work, 'walkthrough.html');
    fs.writeFileSync(html, buildHtml(header));

    const frames = await record(args, html, plan, work);
    encode(frames, args.out);
    fs.rmSync(work, { recursive: true, force: true });
    const bytes = fs.statSync(args.out).size;
    const span = frames[frames.length - 1].ts;
    console.log(`Duration: ${(span + HOLD_S).toFixed(1)}s`);
    console.log(`\nwrote ${args.out} (${(bytes / 1048576).toFixed(1)} MB)`);
    return 0;
}

export { main, buildPlan, buildHtml, CASES };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    main().then((code) => process.exit(code)).catch((error) => {
        console.error('Recording failed:', error && error.message);
        process.exit(1);
    });
}
