'use strict';
// The Ask bar on a company, dossier or monitor page is about the instrument in
// front of the reader. It must not inherit another Ask session's history, saved
// memory or "what you researched lately" nudge, must never open by asking which
// company was meant, and must not be saved as a thread that another page then
// resumes. These tests pin both halves: the engine resolves the page's subject,
// and the route keeps a page-scoped question out of the account's other chats.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ask } = require('../ai-chat');
const reportPolicy = require('../ask-report-policy');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

const unconfigured = (input) => ask({ mode: 'normal', history: [], ...input })
    .then((out) => {
        assert.equal(out.source, 'unconfigured', 'no provider key in tests: the policy is still selected');
        return out.quality.policy;
    });

test('a page-scoped question with no ticker is resolved to the page company', async () => {
    const policy = await unconfigured({ question: 'How is it doing?', ctx: { pageSymbol: 'MSFT' } });
    assert.ok(policy.company, 'the page symbol supplies the subject');
    assert.equal(policy.company.symbol, 'MSFT');
    assert.notEqual(policy.kind, 'listing_choice', 'never answers by asking which company was meant');
    assert.match(reportPolicy.prompt(policy), /MSFT/);
});

test('a ticker the reader names still wins over the page subject', async () => {
    const policy = await unconfigured({ question: 'AAPL', ctx: { pageSymbol: 'MSFT' } });
    assert.equal(policy.company.symbol, 'AAPL');
});

test('an unknown ticker keeps its own answer path on a page-scoped bar', async () => {
    const policy = await unconfigured({ question: 'ZZZZQ', ctx: { pageSymbol: 'MSFT' } });
    assert.ok(policy.unknownTicker, 'the typed symbol is still reported as unknown');
    assert.notEqual(policy.company && policy.company.symbol, 'MSFT');
});

test('without a page subject the same vague question keeps asking which company', async () => {
    const policy = await unconfigured({ question: 'How is it doing?' });
    assert.equal(policy.company, null);
    // and it never silently becomes Gartner (IT) — a lowercase two-letter word is a word
    assert.equal(reportPolicy.select('How is it doing?', 'normal').company, null);
    assert.equal(reportPolicy.select('IT', 'normal').company.symbol, 'IT', 'typed in capitals it is still the listing');
});

test('the policy prompt binds vague references to the resolved listing', () => {
    // Measured 2026-11-01: a page-scoped "visualize it" resolved NVIDIA in the
    // policy but the answer still opened "this is the start of our
    // conversation, no company yet". The resolved-listing clause must tell the
    // agent who "it" is.
    const nvda = reportPolicy.select('NVDA', 'normal').company;
    const policy = reportPolicy.select('visualize it', 'normal', { company: nvda });
    assert.equal(policy.company.symbol, 'NVDA');
    const p = reportPolicy.prompt(policy);
    assert.match(p, /Resolved listing: Nvidia \(NVDA\)/);
    assert.match(p, /vague reference/i);
    assert.match(p, /never open as if no company were named/i);
    // and a genuinely subjectless question still gets the clarify guidance
    assert.match(reportPolicy.prompt(reportPolicy.select('How is it doing?', 'normal')), /Resolve the listing and instrument/);
});

test('the route treats a page-scoped ask as this-bar-only: no saved thread, memory or nudge', () => {
    const app = read('backend/app.js');
    assert.match(app, /const pageSymbol = \/\^\[A-Z\]\[A-Z0-9\.\\-\]\{0,9\}\$\/\.test\(String\(\(req\.body && req\.body\.pageSymbol\)/);
    assert.match(app, /const temporary = \(\(req\.body && req\.body\.temporary\) === true \|\| !!pageSymbol\) && !aiPaperCtx;/);
    assert.match(app, /\.\.\.\(pageSymbol \? \{ pageSymbol \} : \{\}\),/, 'the subject reaches the engine');
    // temporary skips these three, by construction in the same handler:
    assert.match(app, /const history = edit \? edit\.history : hasThread\s*\n\s*\? await aiChat\.threadHistory/);
    assert.match(app, /: clientHistory;/, 'a new chat starts empty: this bar\'s own turns only');
    assert.doesNotMatch(app, /aiChat\.recentHistory\(/, 'the account\'s other chats are never read as context');
    assert.match(app, /const nextHint = temporary \|\| chatSurface === 'paper' \? '' : require\('\.\/ask-suggestions'\)\.nextHint/);
    assert.match(app, /const memoryConsent = !temporary && !!\(req\.user && req\.user\.askMemoryEnabled\);/);
    assert.match(app, /threadIdSaved = result\.source === 'ai' && !temporary/, 'a page chat is never saved as a resumable thread');
});

test('every page-level Ask bar passes its symbol to the shared engine', () => {
    const app = read('frontend-v2/assets/app.js');
    assert.match(app, /function askEngine\(exchange, \{[^}]*symbol \} = \{\}\)/);
    assert.match(app, /const pageSymbol = \/\^\[A-Z\]\[A-Z0-9\.\\-\]\{0,9\}\$\/\.test\(String\(symbol \|\| ''\)\.toUpperCase\(\)\)/);
    assert.match(app, /\.\.\.\(pageSymbol \? \{ pageSymbol \} : \{\}\)/);
    assert.match(app, /function mountAsk\(el, \{ placeholder, suggestions = \[\], onPaperEvent, symbol \} = \{\}\)/);
    assert.match(app, /function mountAskFloor\(\{ placeholder, onTool, onComplete, symbol \} = \{\}\)/);
    for (const file of ['frontend-v2/assets/company.js', 'frontend-v2/assets/dossier.js', 'frontend-v2/assets/monitor.js']) {
        assert.match(read(file), /mountAskFloor\(\{ symbol[,:]/, file + ' names its subject');
    }
    // The same edits touched dossier.js and monitor.js, so their pages must
    // carry fresh stamps — the immutable-cache trap ships silently otherwise.
    assert.match(read('frontend-v2/dossier.html'), /assets\/dossier\.js\?v=20261102-dos17/);
    assert.match(read('frontend-v2/monitor.html'), /assets\/monitor\.js\?v=20261102-quote2/);
});
