// get_financials must declare how old its newest period is.
//
// The failure this prevents is silent and was measured, not imagined: with the
// fundamentals cache sitting on Q1 2026, "Summarise Berkshire's latest
// quarterly results" was answered as Q1 — confidently, with correct figures for
// the wrong quarter — because the payload carried period dates but nothing
// saying those periods were behind. loadFundAny() deliberately falls open to a
// stale cache when a rebuild fails, so this state is reachable in production
// any time a refresh fails or a filing has just landed.
//
// A model cannot detect what it is not told. Putting freshness in the payload
// makes the behaviour the same for every model instead of depending on whether
// one happens to double-check the web.
const test = require('node:test');
const assert = require('node:assert');
const aiChat = require('../ai-chat');

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('the newest quarter is not flagged while it is still the newest', () => {
    // The trap this pins: a 10-Q is due ~40 days after quarter end, but the
    // NEXT quarter does not exist until ~92 days after it. Flagging at the
    // filing deadline marks a current quarter stale for most of its life.
    // Real case, 2026-09-22: Exxon/Meta/Morgan Stanley all sat on a Q2 ending
    // 2026-06-30, 84 days old and entirely up to date, because Q3 had not
    // ended. An 84-day flag would have fired on all three.
    for (const age of [20, 45, 84, 120]) {
        const f = aiChat.freshness(daysAgo(age), 'quarterly');
        assert.equal(f.latestPeriodAgeDays, age);
        assert.equal(f.stalenessWarning, undefined, `a ${age}-day-old quarter is still current and must not be flagged`);
    }
});

test('a quarter old enough that a NEWER quarter should be filed IS flagged', () => {
    const f = aiChat.freshness(daysAgo(160), 'quarterly');
    assert.ok(f.stalenessWarning, 'a 160-day-old quarter means a newer one is filed and missing');
    // The warning has to tell the model what to DO, not just that something is off.
    assert.match(f.stalenessWarning, /search_filings/);
    assert.match(f.stalenessWarning, /fetch_page/);
    assert.match(f.stalenessWarning, /latest/i);
    assert.ok(f.stalenessWarning.includes(daysAgo(160)), 'the warning must name the period it covers');
});

test('the boundary sits either side of one period plus its filing deadline', () => {
    assert.equal(aiChat.freshness(daysAgo(139), 'quarterly').stalenessWarning, undefined);
    assert.ok(aiChat.freshness(daysAgo(141), 'quarterly').stalenessWarning);
});

test('annual gets a full year of grace, because that is when the next 10-K lands', () => {
    // 200 days: a newer QUARTER exists, but no newer 10-K does. The annual
    // table is not stale, and the prompt's separate rule covers the quarter.
    assert.equal(aiChat.freshness(daysAgo(200), 'annual').stalenessWarning, undefined, 'a 200-day-old fiscal year is still the newest one');
    assert.ok(aiChat.freshness(daysAgo(200), 'quarterly').stalenessWarning, 'but 200 days IS stale for a quarter');
    assert.ok(aiChat.freshness(daysAgo(500), 'annual').stalenessWarning, 'a 500-day-old fiscal year means a newer 10-K is filed');
});

test('unparseable or future dates produce no claim either way', () => {
    assert.equal(aiChat.freshness('', 'quarterly'), null);
    assert.equal(aiChat.freshness(undefined, 'quarterly'), null);
    assert.equal(aiChat.freshness('not-a-date', 'quarterly'), null);
    // A period ending in the future is bad data, not staleness — say nothing
    // rather than reporting a negative age.
    assert.equal(aiChat.freshness(new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), 'quarterly'), null);
});

test('the system prompt treats stalenessWarning as binding', () => {
    // The payload field is only half the fix; the model has to be told the
    // field outranks its own judgement.
    const sys = aiChat.ASK_SYSTEM;
    assert.match(sys, /stalenessWarning/, 'ASK_SYSTEM never mentions stalenessWarning');
    assert.match(sys, /binding/i);
});
