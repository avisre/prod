#!/usr/bin/env node
'use strict';
// Local answer review using the real Ask engine and renderer. No application
// server, account database, production credentials dump or background jobs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const backend = path.join(root, 'backend');
const port = Number(process.env.ASK_REVIEW_PORT || 5056);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid ASK_REVIEW_PORT.');
require('./lib/dev-env').loadAiEnvOnly(backend);
for (const key of ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_TOKEN']) delete process.env[key];
Object.assign(process.env, { DISABLE_BACKGROUND_JOBS: '1', SEC_COVERAGE_READ_ONLY: '1', SEC_COVERAGE_DISABLE_ON_DEMAND: '1' });
const mongoose = require(path.join(backend, 'node_modules/mongoose'));
mongoose.set('bufferCommands', false);
mongoose.connect = mongoose.createConnection = () => { throw Error('Database connections are disabled in local Ask review.'); };
const engine = require(path.join(backend, 'ai-chat'));
const client = require(path.join(backend, 'ai-client'));
const examples = new Map();
const savedIndex = process.argv.indexOf('--examples');
if (savedIndex >= 0) {
    const directory = process.argv[savedIndex + 1];
    if (!directory) throw Error('Give an examples directory after --examples.');
    for (const id of ['short', 'complex']) {
        try {
            const result = JSON.parse(fs.readFileSync(path.resolve(directory, id + '.json'), 'utf8'));
            if (typeof result.answer === 'string' && typeof result.question === 'string' && ['ai', 'partial'].includes(result.source)) examples.set(id, result);
        } catch (_) { /* examples are optional; generate fresh answers in the UI */ }
    }
}
let active = false;
const prompts = {
    short: { mode: 'normal', question: 'Using only verified stored facts, how much free cash flow did Apple generate in its latest stored annual period? Name the actual period end, currency and SEC source, show the calculation, and keep the answer under 80 words. No extra history or chart.' },
    complex: { mode: 'analyst', question: 'Using only verified stored annual financial facts for Apple, analyse the latest three annual periods of revenue, net income, operating cash flow, capex and calculated free cash flow. Include readable charts for revenue/net income and operating cash flow/capex/free cash flow using raw USD values and actual period ends. Explain the changes, calculate whether dividends plus buybacks were covered by free cash flow in the latest period, and show any shortfall. Distinguish observations from causes the data cannot establish. Name currencies, periods and exact SEC sources. Do not refresh data, search news or infer missing facts. This is a detailed analysis; keep it under 450 words.' }
};
function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}
async function readBody(req) {
    const parts = []; let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 64 * 1024) throw Error('Request too large.');
        parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
const page = fs.readFileSync(path.join(__dirname, 'dev-ask-review.html'));
const assets = new Map(['app.js', 'system.css'].map(name => ['/assets/' + name, path.join(root, 'frontend-v2/assets', name)]));
const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    // A page on another origin cannot use this loopback-only inference service.
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { message: 'Use the local review page.' });
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return json(res, 403, { message: 'Use the loopback address.' });
    if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(page);
    }
    if (req.method === 'GET' && assets.has(pathname)) {
        res.writeHead(200, { 'Content-Type': pathname.endsWith('.js') ? 'application/javascript' : 'text/css', 'Cache-Control': 'no-store' }); return fs.createReadStream(assets.get(pathname)).pipe(res);
    }
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, configured: client.isConfigured(), active, scope: 'Local Ask engine; no database connection' });
    if (req.method === 'GET' && pathname === '/api/examples') return json(res, 200, { prompts, examples: Object.fromEntries(examples) });
    if (req.method !== 'POST' || pathname !== '/api/ask') return json(res, 404, { message: 'Not found.' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { message: 'Send JSON.' });
    if (active) return json(res, 429, { message: 'An answer is already running. Wait for it to finish.' });
    let body;
    try { body = await readBody(req); } catch (_) { return json(res, 400, { message: 'Invalid or oversized request.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { message: 'Send a JSON object.' });
    if (active) return json(res, 429, { message: 'An answer is already running. Wait for it to finish.' });
    const example = Object.hasOwn(prompts, body.example) ? body.example : null;
    const question = String(example ? prompts[example].question : body.question || '').trim();
    const mode = (example ? prompts[example].mode : body.mode) === 'analyst' ? 'analyst' : 'normal';
    if (!question || question.length > 8000) return json(res, 400, { message: 'Enter a question of 1–8,000 characters.' });
    if (!client.isConfigured()) return json(res, 503, { message: 'The local AI connection is not configured.' });
    const history = Array.isArray(body.history) ? body.history.slice(-10).filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 16000) })) : [];
    const stream = body.stream === true;
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = (type, value) => { if (!closed && !res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); };
    let heartbeat;
    if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        heartbeat = setInterval(() => { if (!closed && !res.writableEnded) res.write(': ping\n\n'); }, 10000);
    }
    active = true;
    const started = Date.now();
    try {
        const result = await engine.ask({ question, mode, history, ctx: { holdings: [], memoryConsent: false }, ...(stream ? { onEvent: e => send(e.type, e) } : {}) });
        const output = { question, mode, ms: Date.now() - started, generatedAt: new Date().toISOString(), ...result };
        if (example) examples.set(example, output);
        if (stream) send('done', output); else if (!closed) json(res, 200, output);
    } catch (_) {
        if (stream) send('error', { message: 'The answer could not be completed. Please retry.' });
        else if (!closed) json(res, 502, { message: 'The answer could not be completed. Please retry.' });
    } finally {
        active = false;
        clearInterval(heartbeat);
        if (stream && !res.writableEnded) res.end();
    }
});
server.requestTimeout = 200000;
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Local review port is occupied. Set ASK_REVIEW_PORT to another port.' : 'Local review server could not start.'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Local Ask review: http://127.0.0.1:${port}\nReal AI answers and product charts. No database connection. Stop with Ctrl+C.`));
