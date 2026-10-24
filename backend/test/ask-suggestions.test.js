'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { suggest, nextHint } = require('../ask-suggestions');

const NOW = new Date('2026-10-25T12:00:00Z');
const ago = (d) => new Date(NOW - d * 864e5);
const lookup = (s) => ['SPOT', 'LLY', 'VRTX', 'AMD', 'NVDA', 'TSLA', 'AAPL', 'NFLX', 'MSFT'].includes(s);
const run = (opts) => suggest({ now: NOW, lookup, ...opts });

test('a Polish checklist reader gets Polish starters on their own tickers, each ticker on a different angle', () => {
    const out = run({
        questions: [{ q: 'kontynuuj', at: ago(9) },
            { q: 'Proszę o analizę spółek SPOT, LLY, VRTX: 1. przychody i zyski 2. bilans 3. zarząd 4. dywidenda', at: ago(9) }],
        peerOf: (s) => (s === 'SPOT' ? 'NFLX' : null)
    });
    assert.equal(out.personalized, true);
    assert.equal(out.language, 'pl');
    assert.deepEqual(out.tickers, ['SPOT', 'LLY', 'VRTX']);
    const qs = out.questions.map((x) => x.q);
    assert.ok(qs.length <= 6 && qs.length >= 3);
    assert.match(qs[0], /^Jakie nowe raporty SPOT pojawiły się od 16 paź/);
    assert.ok(qs.some((q) => /Porównaj SPOT z NFLX/.test(q)));
    // what they already asked about a ticker is not offered again on it
    assert.ok(!qs.some((q) => /dywidenda (SPOT|LLY|VRTX)/.test(q)), qs.join('\n'));
    // one angle per ticker within the first round
    const firstRound = out.questions.filter((x) => /^(filings|growth|cashflow|balance|valuation|risks|insiders|dividends|technicals):(SPOT|LLY|VRTX)$/.test(x.why)).slice(0, 3);
    assert.equal(new Set(firstRound.map((x) => x.why.split(':')[0])).size, firstRound.length);
});

test('a price-trend reader gets their topic on the closest peer and the technical screen', () => {
    const out = run({
        questions: [{ q: 'Which stocks have RSI above 50 and a golden cross?', at: ago(2) },
            { q: 'Is AMD in a confirmed uptrend with a volume breakout?', at: ago(3) }],
        peerOf: () => 'NVDA'
    });
    const qs = out.questions.map((x) => x.q);
    assert.equal(out.language, 'en');
    assert.ok(qs.includes('Is NVDA above its 50- and 200-day averages, and what is its RSI?'), qs.join('\n'));
    assert.ok(qs.includes('Find stocks with RSI above 50 and a golden cross in the last 30 days.'));
    // asked three days ago: no "since" starter yet
    assert.ok(!qs.some((q) => /filed since/.test(q)));
});

test('a reader who only asked the onboarding question gets what changed since, and their holdings join in', () => {
    const out = run({
        questions: [{ q: 'What are the biggest risks in the latest 10-K? Use TSLA and include the source URL.', at: ago(20) }],
        holdings: ['AAPL']
    });
    const qs = out.questions.map((x) => x.q);
    assert.deepEqual(out.tickers, ['TSLA', 'AAPL']);
    assert.equal(qs[0], 'What has TSLA filed since 5 Oct, and what changed?');
    assert.ok(qs.includes('Compare TSLA with AAPL: growth, margins, balance sheet and valuation.'));
    assert.ok(!qs.some((q) => /TSLA's latest 10-K flag as risk/.test(q)), 'already asked');
});

test('no history keeps the general starters, and an exact past question is never offered back', () => {
    assert.deepEqual(run({}), { personalized: false, language: 'en', tickers: [], questions: [] });
    const asked = 'Find companies that grew revenue 10%+ a year with net margins above 20%.';
    const out = run({ questions: [{ q: asked, at: ago(1) }] });
    assert.ok(!out.questions.some((x) => x.q === asked));
});

test('the follow-up hint names the reader\'s topics and tickers and is empty without history', () => {
    const hint = nextHint([{ q: 'Is AMD in a confirmed uptrend with a volume breakout?' }], { lookup });
    assert.match(hint, /^FOLLOW-UP FOR THIS USER: .*price trend \(RSI, moving averages, volume\).* and follow AMD\./);
    assert.match(hint, /"> Next:" question/);
    assert.equal(nextHint([]), '');
});

test('wiring: free route, both chat paths carry the hint, temporary chats and the shared report cache never do', () => {
    const fs = require('node:fs'), path = require('node:path');
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const aiChat = fs.readFileSync(path.join(__dirname, '..', 'ai-chat.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'ask.html'), 'utf8');
    assert.match(app, /app\.get\('\/api\/ask\/suggestions', authMiddleware,/);
    assert.match(app, /const nextHint = temporary \|\| chatSurface === 'paper' \? '' :/);
    assert.equal((app.match(/\.\.\.\(nextHint \? \{ nextHint \} : \{\}\)/g) || []).length, 2);
    // a report written for one reader is served to every reader of that company
    assert.match(aiChat, /if \(key && input\.ctx\?\.nextHint\) input = \{ \.\.\.input, ctx: \{ \.\.\.input\.ctx, nextHint: '' \} \};/);
    assert.match(page, /fetch\(`\$\{API\}\/ask\/suggestions`/);
    assert.match(page, /engine\.send\(b\.dataset\.q \|\| b\.textContent, turnOpts\(\)\)/);
});
