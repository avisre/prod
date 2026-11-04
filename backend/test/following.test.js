'use strict';
const test = require('node:test');
const assert = require('node:assert');
const following = require('../following');

const now = new Date('2026-10-24T12:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86400000);

test('holdings and watchlist come first, then views newest first; removed and old views are left out', () => {
    const rows = following.collect({
        holdings: ['ko'], watchlist: ['PEP', 'KO'], unfollowed: ['DBX'], now,
        views: [
            { symbol: 'APP', kind: 'dossier', lastViewedAt: daysAgo(10) },
            { symbol: 'CEG', kind: 'company', lastViewedAt: daysAgo(2) },
            { symbol: 'DBX', kind: 'dossier', lastViewedAt: daysAgo(1) },
            { symbol: 'SIMO', kind: 'company', lastViewedAt: daysAgo(91) },
            { symbol: 'PEP', kind: 'company', lastViewedAt: daysAgo(1) }
        ]
    });
    assert.deepEqual(rows.map((r) => `${r.symbol}:${r.reason}`), ['KO:holding', 'PEP:watchlist', 'CEG:viewed', 'APP:dossier']);
});

test('the list is capped', () => {
    const watchlist = Array.from({ length: 30 }, (_, i) => `S${i}`);
    assert.equal(following.collect({ watchlist, now }).length, following.MAX_SYMBOLS);
});

test('summarize picks the newest periodic report and the newest 8-K, and flags filings from the last 14 days', () => {
    const s = following.summarize([
        { form: '8-K', date: '2026-10-21', url: 'u1' },
        { form: '10-Q', date: '2026-10-12', url: 'u2' },
        { form: '10-K', date: '2026-02-20', url: 'u3' }
    ], now);
    assert.deepEqual(s.periodic, { form: '10-Q', date: '2026-10-12', url: 'u2', isNew: true });
    assert.deepEqual(s.event, { form: '8-K', date: '2026-10-21', url: 'u1', isNew: true });
    assert.equal(following.summarize([{ form: '10-K', date: '2026-10-01', url: 'x' }], now).periodic.isNew, false, '23 days old');
    assert.deepEqual(following.summarize(null, now), { periodic: null, event: null });
});

test('filings are read live once per 6 hours; a failed read falls back to the index and retries sooner', async () => {
    following.__reset();
    let calls = 0;
    const live = async () => { calls++; return [{ form: '10-Q', date: '2026-10-21', url: 'live' }]; };
    const fromIndex = () => [{ form: '10-Q', date: '2026-07-29', url: 'index' }];
    const t0 = now.getTime();
    assert.equal((await following.filingsFor('KO', { fetchRecent: live, fromIndex, now: t0 }))[0].url, 'live');
    await following.filingsFor('KO', { fetchRecent: live, fromIndex, now: t0 + 5 * 3600000 });
    assert.equal(calls, 1);
    const down = async () => { throw new Error('SEC 503'); };
    assert.equal((await following.filingsFor('PEP', { fetchRecent: down, fromIndex, now: t0 }))[0].url, 'index');
    assert.equal((await following.filingsFor('PEP', { fetchRecent: live, fromIndex, now: t0 + 11 * 60000 }))[0].url, 'live');
    following.__reset();
});
