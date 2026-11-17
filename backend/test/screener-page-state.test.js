'use strict';

// Exercise the browser's actual asynchronous screen code without a live AI
// service. Full-page layout and save/export flows are also checked in Chrome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../frontend-v2/assets/screener.js'), 'utf8');
const wordsCode = source.slice(source.indexOf('    async function screenFromWords('), source.indexOf('    async function runCustomScreen('));
const plain = (value) => JSON.parse(JSON.stringify(value));

function words(fetch) {
    const context = vm.createContext({ fetch, window: { V2: null }, TextDecoder });
    vm.runInContext(wordsCode, context);
    return context.screenFromWords;
}
function stream(chunks) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        }
    }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('custom screen reads split CRLF frames and an unterminated final tool frame', async () => {
    const args = { min_net_margin_pct: 15, max_peg: 2 };
    let request;
    const signal = new AbortController().signal;
    const build = words(async (url, options) => {
        request = { url, options };
        return stream(['event: ping\r\ndata:{}\r', '\n\r\nevent:tool\r\ndata:' + JSON.stringify({ tool: 'screen_universe', args, ok: true })]);
    });
    assert.deepEqual(plain(await build('profitable growers', signal)), { args });
    assert.equal(request.url, '/api/ai/chat');
    assert.equal(request.options.signal, signal);
    assert.equal(JSON.parse(request.options.body).question, 'Run a stock screen for: profitable growers');
});

test('custom screen ignores failed tools, malformed data and non-object criteria', async () => {
    const frames = [
        'event: tool\ndata: not-json',
        'event: tool\ndata: ' + JSON.stringify({ tool: 'screen_universe', args: { max_pe: 20 }, ok: false }),
        'event: tool\ndata: ' + JSON.stringify({ tool: 'screen_universe', args: ['max_pe'] }),
        'event: tool\ndata: ' + JSON.stringify({ tool: 'get_company', args: { symbol: 'AAPL' }, ok: true })
    ];
    assert.deepEqual(plain(await words(async () => stream([frames.join('\n\n') + '\n\n']))('growers')), { args: null });
});

test('custom screen keeps the last successful screen when Ask refines its criteria', async () => {
    const frames = [{ min_roe_pct: 10 }, { min_roe_pct: 20, min_volume_ratio_20: 2 }].map(args => 'event: tool\ndata: ' + JSON.stringify({ tool: 'screen_universe', args, ok: true }) + '\n\n');
    assert.deepEqual(plain(await words(async () => stream(frames))('growers')), { args: { min_roe_pct: 20, min_volume_ratio_20: 2 } });
});

test('custom screen treats a broken stream as a recoverable failure', async () => {
    const broken = { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: new ReadableStream({ pull(controller) { controller.error(new Error('connection lost')); } }) };
    assert.equal(await words(async () => broken)('growers'), null);
    assert.equal(await words(async () => { throw new Error('offline'); })('growers'), null);
});

test('custom screen distinguishes allowance or login denial from server failures', async () => {
    for (const status of [401, 402, 429]) assert.deepEqual(plain(await words(async () => new Response('{}', { status }))('growers')), { denied: true });
    assert.equal(await words(async () => new Response('{}', { status: 503 }))('growers'), null);
    assert.equal(await words(async () => new Response('{}'))('growers'), null);
});

function screenPage() {
    const elements = {
        'export-btn': { disabled: false },
        results: { setAttribute(key, value) { this[key] = value; } },
        'result-count': { textContent: '' },
        'results-body': { innerHTML: '', querySelector() { return { addEventListener() {} }; } },
        'f-sector': { options: [{}, {}] }
    };
    const pending = [];
    const context = vm.createContext({
        elements, AbortController, clearTimeout,
        fetch: () => new Promise(resolve => pending.push(resolve)),
        $: id => elements[id], esc: value => String(value)
    });
    vm.runInContext(`
        let requestId = 0, screenController = null, debounce = null;
        let rows = [], aiSimilar = null, trendAsOf = null, aiCriteria = null;
        let rendered = [];
        function buildQuery() { return ''; }
        function tableBusy(text) { $('result-count').textContent = text; $('results').setAttribute('aria-busy', 'true'); }
        function render() { rendered = rows.map(r => r.symbol); }
        function renderAiNote() {}
        ${source.slice(source.indexOf('    function cancelRun('), source.indexOf('    function render(error)'))}
    `, context);
    return { context, elements, pending, rendered: () => plain(vm.runInContext('rendered', context)) };
}
const response = (data, ok = true) => ({ ok, json: async () => data });

test('a delayed screen cannot replace results from the newer screen even if abort is ignored', async () => {
    const page = screenPage();
    const first = page.context.run();
    const second = page.context.run();
    page.pending[1](response({ rows: [{ symbol: 'NEW' }], matched: 1, universe: 20 }));
    await second;
    page.pending[0](response({ rows: [{ symbol: 'OLD' }], matched: 1, universe: 20 }));
    await first;
    assert.deepEqual(page.rendered(), ['NEW']);
    assert.equal(page.elements['result-count'].textContent, '1 of 20 companies match');
    assert.equal(page.elements['export-btn'].disabled, false);
    assert.equal(page.elements.results['aria-busy'], 'false');
});

test('a failed screen clears exportable rows and provides an error and retry', async () => {
    const page = screenPage();
    const good = page.context.run();
    page.pending[0](response({ rows: [{ symbol: 'OLD' }], matched: 1, universe: 20 }));
    await good;
    const failed = page.context.run();
    page.pending[1](response({ message: 'Temporary issue' }, false));
    await failed;
    assert.equal(page.elements['export-btn'].disabled, true);
    assert.equal(page.elements['result-count'].textContent, 'Screen unavailable');
    assert.match(page.elements['results-body'].innerHTML, /Temporary issue/);
    assert.match(page.elements['results-body'].innerHTML, /screen-retry/);
    assert.deepEqual(plain(vm.runInContext('rows', page.context)), []);
});

test('valid empty results keep a numeric count and disable export', async () => {
    const page = screenPage();
    const request = page.context.run();
    page.pending[0](response({ rows: [], matched: 0, universe: 20 }));
    await request;
    assert.equal(page.elements['result-count'].textContent, '0 of 20 companies match');
    assert.equal(page.elements['export-btn'].disabled, true);
});
