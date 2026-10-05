'use strict';

// The screener page's AI entry point: the chip, the adoption button, and the
// ?criteria= round trip that re-runs Ask's exact screen server-side. These are
// source-level contracts on purpose — the page has no test harness, and the
// invariants that must not regress are structural (never auto-apply, the
// criteria whitelist stays closed, the assets stay stamped together).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('screener page: the AI chip rides beside the presets without being one', () => {
    const html = read('frontend-v2', 'screener.html');
    assert.match(html, /id="ai-screen-btn"/);
    // The owner-chosen brand name is the label users read; "AI screen" was
    // deliberately retired. The id keeps its original name on purpose.
    assert.match(html, /id="ai-screen-btn"[^>]*>Doppelganger</, 'the chip carries the branded name');
    // The preset listener binds [data-preset]; an AI chip carrying that
    // attribute would run an empty preset screen the moment it was clicked.
    const chip = html.match(/<button[^>]*id="ai-screen-btn"[^>]*>/)[0];
    assert.ok(!chip.includes('data-preset'), 'the AI chip is not a preset');
    assert.match(html, /id="ai-note"/);
    assert.match(html, /data-ask-floor="1"/);
    // Extending the floor placeholder to the flagship example is copy, but it
    // is the only place a logged-out visitor learns the phrase.
    assert.match(html, /companies like AppLovin/i);
});

test('screener page: its own asset carries the page stamp, not a stale one', () => {
    const html = read('frontend-v2', 'screener.html');
    const stamp = (html.match(/assets\/app\.js\?v=([0-9a-z-]+)/) || [])[1];
    assert.ok(stamp, 'the page loads app.js with a stamp');
    assert.ok(html.includes(`assets/screener.js?v=${stamp}`), 'screener.js must share the page stamp or the fix never reaches browsers');
});

test('screener page: adoption is a click, never a side effect of Ask finishing', () => {
    const js = read('frontend-v2', 'assets', 'screener.js');
    assert.match(js, /V2\.askFloor\.send\(/);
    assert.match(js, /addEventListener\(AI_TOOL_EVT/);
    const handler = js.slice(js.indexOf('document.addEventListener(AI_TOOL_EVT'));
    const body = handler.slice(0, handler.indexOf('document.addEventListener(AI_DONE_EVT'));
    assert.match(body, /pendingScreenArgs = args/, 'the handler only stages the screen');
    assert.ok(!body.includes('adoptAiScreen'), 'the tool event must not adopt the screen by itself');
    assert.match(js, /id="ai-use-btn"[^]*?addEventListener\('click', adoptAiScreen\)/, 'a visible button is the only path in');
    assert.match(js, /function adoptAiScreen[\s\S]*?run\(\);/, 'adoption syncs controls and re-runs the screen');
});

test('screener page: the AI screen survives the round trip through ?criteria=', () => {
    const js = read('frontend-v2', 'assets', 'screener.js');
    assert.match(js, /q\.set\('criteria', JSON\.stringify\(aiCriteria\)\)/);
    // Clearing must hook every way off-script: presets, dropdown changes,
    // typing in a field, the note's × — and sorting by a column, which also
    // re-fetches so the table and the export cannot disagree.
    assert.match(js, /function clearAiScreen/);
    assert.match(js, /clearAiScreen\(\);\n\s*setFilters\(PRESETS/);
    assert.match(js, /addEventListener\('change', \(\) => \{ clearAiScreen\(\); run\(\); \}\)/);
    assert.match(js, /clearAiScreen\(\);\n\s*clearTimeout\(debounce\)/);
    assert.match(js, /if \(aiSimilar\) \{ clearAiScreen\(\); run\(\); return; \}/);
    // A similarity screen arrives ranked by the server; re-sorting client-side
    // would silently destroy the ranking it was adopted for.
    assert.match(js, /aiSimilar \? rows\.slice\(\) : rows\.slice\(\)\.sort/);
});

test('app.js: the Ask floor forwards tool frames as DOM events, engine kept on V2', () => {
    const js = read('frontend-v2', 'assets', 'app.js');
    assert.match(js, /askToolEvent: 'v2:ask-tool', askDoneEvent: 'v2:ask-done'/);
    assert.match(js, /if \(onTool\) onTool\(\{ tool: d\.tool, args: d\.args \|\| \{\}, ok: d\.ok !== false, ms: d\.ms \}\)/);
    assert.match(js, /window\.V2\.askFloor = mountAskFloor\(\{/);
    assert.match(js, /new CustomEvent\(window\.V2\.askToolEvent, \{ detail: d \}\)/);
    assert.match(js, /screen_universe: \(a\) => \(a && a\.similar_to \?/);
    assert.match(js, /doppelgangers/, 'the Ask progress line uses the brand name');
});

test('screener criteria: the browser payload passes a closed whitelist', () => {
    const src = read('backend', 'app.js');
    assert.match(src, /aiChat\.screenArgsFromClient\(q\.criteria\)/);
    const chat = read('backend', 'ai-chat.js');
    const block = chat.slice(chat.indexOf('const SCREEN_ARG_KEYS = {'), chat.indexOf('function screenArgsFromClient'));
    assert.match(block, /similar_to: 'string'/);
    // Paging and ordering belong to the page; the criteria side must never
    // carry them or a crafted URL could override the route's own limits.
    assert.ok(!/sort_by|limit/.test(block), 'limit/sort_by must stay out of the criteria whitelist');
});

test('ai-paper-portfolio: the persona prompts teach the new screen and the real universe size', () => {
    const src = read('backend', 'ai-paper-portfolio.js');
    assert.match(src, /similar_to/);
    assert.ok(!/~1,500 US companies/.test(src), 'the stale universe count is gone');
});
