'use strict';

// Ask can test any condition a reader sets, not only the ones a column was
// built for.
//
// 2026-10-11: "pick one stock … greater than 35% growth in the last 4 quarters,
// low SBC, buybacks" was answered with Booking Holdings, whose revenue had
// grown about 8%. The screen had no four-quarter growth and no share-based-pay
// figure, so the answer was written from five-year growth and one quarter's
// profit growth instead. These tests pin the tool that removes the limit: the
// caller writes the formula and every company is tested against it.

const { test } = require('node:test');
const assert = require('node:assert');
const uq = require('../ask-universe-query');
const screenFacts = require('../screen-facts');

const quarters = n => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 5 - 3 * i + 1, 0));
    return d.toISOString().slice(0, 10);
});
function company(symbol, { revenue, sbc, buybacks, shares, annualRevenue, marketCapB = 10, pe = 20 }) {
    const ends = quarters(revenue.length);
    return {
        row: { symbol, name: symbol + ' Inc.', sector: 'Information Technology', marketCapB, pe, price: 100 },
        fact: {
            s: symbol, c: 'USD',
            q: { ends, f: { revenue, ...(sbc ? { sbc } : {}), ...(buybacks ? { buybacks } : {}), ...(shares ? { shares_outstanding: shares } : {}) } },
            ...(annualRevenue ? { a: { ends: ['2025-12-31', '2024-12-31', '2023-12-31'].slice(0, annualRevenue.length), f: { revenue: annualRevenue } } } : {})
        }
    };
}
const FAST = company('FAST', { revenue: [150, 140, 130, 120, 100, 100, 100, 100], sbc: [3, 3, 3, 3, 2, 2, 2, 2], buybacks: [-10, -10, -10, -10, 0, 0, 0, 0], shares: [95, 96, 97, 98, 100, 100, 100, 100], annualRevenue: [500, 400, 300] });
// The Booking shape: steady single-digit growth, and one quarter of share-based pay never filed.
const SLOW = company('SLOW', { revenue: [108, 108, 108, 108, 100, 100, 100, 100], sbc: [2, 2, null, 2, 2, 2, null, 2], buybacks: [50, 50, 50, 50, 40, 40, 40, 40] });
const NOSBC = company('NOSBC', { revenue: [200, 190, 180, 170, 100, 100, 100, 100] });
const all = [FAST, SLOW, NOSBC];
const run = (args, items = all, asOf = '2026-07-15') => uq.query(args, {
    screenRows: items.map(c => c.row),
    facts: { v: 1, asOf, rows: items.map(c => c.fact), bySymbol: new Map(items.map(c => [c.fact.s, c.fact])) }
});
const cellsOf = (table, symbol) => table.split('\n').find(l => l.startsWith(symbol + '|')).split('|');

test('the customer\'s conditions are one call: four-quarter growth, share-based pay and buybacks', () => {
    const out = run({
        columns: [
            { name: 'rev_growth_4q', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))' },
            { name: 'sbc_share', formula: 'pct(ttm(sbc), ttm(revenue))' },
            { name: 'buybacks_4q', formula: 'ttm(abs(buybacks))', unit: 'usd' }
        ],
        where: 'rev_growth_4q > 35 and sbc_share < 5 and buybacks_4q > 0', sort_by: 'rev_growth_4q'
    });
    assert.equal(out.error, undefined);
    assert.equal(out.matched, 1);
    const fast = cellsOf(out.table, 'FAST');
    assert.equal(fast[6], ((540 / 400 - 1) * 100).toFixed(1));
    assert.equal(fast[7], (12 / 540 * 100).toFixed(1));
    assert.equal(fast[8], '40', 'an outflow filed as a negative is counted by its size');
    assert.ok(!/SLOW\|/.test(out.table), 'eight per cent growth does not pass a 35% condition');
});

test('a line the company did not file is blank and never passes a condition', () => {
    const out = run({ columns: [{ name: 'sbc_share', formula: 'pct(ttm(sbc), ttm(revenue))' }], symbols: ['SLOW', 'NOSBC', 'FAST'] });
    assert.equal(cellsOf(out.table, 'SLOW')[6], '', 'one unfiled quarter leaves the four-quarter sum blank, not understated');
    assert.equal(cellsOf(out.table, 'NOSBC')[6], '');
    assert.equal(out.columns[0].blankFor, 2);
    assert.equal(run({ columns: [{ name: 'sbc_share', formula: 'pct(ttm(sbc), ttm(revenue))' }], where: 'sbc_share < 5' }).matched, 1);
    // …while the quarters that were filed can still be read one at a time.
    assert.equal(cellsOf(run({ columns: [{ name: 'q_sbc', formula: 'pct(q(sbc), q(revenue))' }], symbols: ['SLOW'] }).table, 'SLOW')[6], (2 / 108 * 100).toFixed(1));
});

test('when nothing passes every part, the closest are returned with the part each misses', () => {
    const out = run({
        columns: [{ name: 'g', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))' }, { name: 's', formula: 'pct(ttm(sbc), ttm(revenue))' }],
        where: 'g > 35 and s < 1'
    });
    assert.equal(out.matched, 0);
    assert.match(out.closest.note, /No company passes every part/);
    assert.match(out.closest.table.split('\n')[0], /\|misses$/);
    assert.match(out.closest.table, /FAST\|.*\|s < 1$/m);
    assert.match(out.closest.table, /NOSBC\|.*s < 1 \(untested\)/);
});

test('every quarter can be tested, not only the total: lag() reads the same quarter a year earlier', () => {
    const out = run({ columns: [{ name: 'weakest', formula: 'min_q(growth_pct(revenue, lag(revenue, 4)), 4)' }], symbols: ['FAST', 'SLOW'] });
    assert.equal(cellsOf(out.table, 'FAST')[6], '20.0');
    assert.equal(cellsOf(out.table, 'SLOW')[6], '8.0');
});

test('fiscal years, growth rates over several years and the price figures are all usable', () => {
    const out = run({ columns: [{ name: 'cagr2', formula: 'cagr_pct(fy(revenue), fy(revenue, 2), 2)' }, { name: 'ps', formula: 'market_cap / ttm(revenue)', unit: 'number' }], symbols: ['FAST'] });
    assert.equal(cellsOf(out.table, 'FAST')[6], ((Math.sqrt(500 / 300) - 1) * 100).toFixed(1));
    assert.equal(Number(cellsOf(out.table, 'FAST')[7]), Math.round(10e9 / 540));
    assert.equal(run({ where: 'pe < 25 and market_cap_b >= 10' }).matched, 3);
});

test('a company that stopped filing is left out unless it is asked for by name', () => {
    assert.equal(run({ where: 'q(revenue) > 0' }, all, '2027-06-30').matched, 0);
    assert.match(run({ where: 'q(revenue) > 0' }, all, '2027-06-30').skippedStale, /3 companies/);
    assert.equal(run({ where: 'q(revenue) > 0', include_stale: true }, all, '2027-06-30').matched, 3);
    assert.equal(run({ where: 'q(revenue) > 0', symbols: ['FAST'] }, all, '2027-06-30').matched, 1);
});

test('a formula is parsed, never executed: anything that is not arithmetic over the named lines is refused', () => {
    for (const bad of ['process.exit()', 'q(revenue).constructor', 'require("fs")', 'q(revenue)[0]', 'this', 'foo(1)', 'q(revenue', 'q(revenue, 99)', 'q(revenue, -1)', 'revenue > 5', '1 +', 'x'.repeat(500)])
        assert.ok(run({ where: bad }).error, bad + ' should be refused');
    assert.match(run({ where: 'revenue > 5' }).error, /say which period/);
    assert.match(run({ columns: [{ name: 'revenue', formula: 'q(revenue)' }] }).error, /already a statement line/);
    assert.match(run({ columns: [{ name: 'pe', formula: 'pe * 2' }] }).error, /already a per-company figure/);
    assert.ok(run({}).error);
    // Division by zero and a non-positive base are blanks, not Infinity or NaN.
    const z = company('ZERO', { revenue: [0, 0, 0, 0, 0, 0, 0, 0] });
    const out = run({ columns: [{ name: 'a', formula: '1 / q(revenue)' }, { name: 'b', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))' }], symbols: ['ZERO'] }, [z]);
    assert.deepEqual(cellsOf(out.table, 'ZERO').slice(6), ['', '']);
});

test('the numerical review can accept every figure the table shows', () => {
    const out = run({ columns: [{ name: 'g', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))' }, { name: 'bb', formula: 'ttm(abs(buybacks))', unit: 'usd' }], symbols: ['FAST'] });
    assert.ok(out.claimable.percentages.includes(35));
    assert.ok(out.claimable.money.some(m => m.value === 40 && m.unit === 'USD'));
});

test('the table is built from filed rows on the company\'s own calendar: a period it did not file keeps its place as a blank', () => {
    const rows = (ends, extra = {}) => ends.map((end, i) => ({ fiscalDateEnding: end, reportedCurrency: 'USD', totalRevenue: String(100 - i), ...extra }));
    const view = {
        // 2025-09-30 was never filed; 2024-12-31 is a different currency.
        income: { quarterlyReports: [...rows(['2026-06-30', '2026-03-31', '2025-12-31', '2025-06-30', '2025-03-31']), { fiscalDateEnding: '2024-12-31', reportedCurrency: 'EUR', totalRevenue: '1' }], annualReports: rows(['2025-12-31', '2024-12-31', '2022-12-31']) },
        balance: { quarterlyReports: [{ fiscalDateEnding: '2026-03-31', reportedCurrency: 'USD', totalAssets: 9 }], annualReports: [] },
        cash: { quarterlyReports: [{ fiscalDateEnding: '2026-06-30', reportedCurrency: 'EUR', shareBasedCompensation: 5 }], annualReports: [] }
    };
    const fact = screenFacts.row({ symbol: 'GAP' }, view);
    assert.deepEqual(fact.q.ends, ['2026-06-30', '2026-03-31', '2025-12-31', null, '2025-06-30', '2025-03-31']);
    assert.deepEqual(fact.q.f.revenue, [100, 99, 98, null, 97, 96], 'four quarters back is still the quarter a year earlier');
    assert.deepEqual(fact.a.ends, ['2025-12-31', '2024-12-31', null, '2022-12-31']);
    assert.deepEqual(fact.q.f.total_assets, [null, 9, null, null, null, null]);
    assert.equal(fact.q.f.sbc, undefined, 'a row in another currency is not mixed in');
    assert.equal(screenFacts.row({ symbol: 'NONE' }, { income: {}, balance: {}, cash: {} }), null);
    // The gap blanks the sums that need it and nothing else.
    const out = uq.query({ columns: [{ name: 'yoy', formula: 'growth_pct(q(revenue), q(revenue, 4))' }, { name: 'four', formula: 'ttm(revenue)' }], symbols: ['GAP'] },
        { screenRows: [{ symbol: 'GAP', name: 'Gap Co', sector: 'Industrials', marketCapB: 1 }], facts: { v: 1, asOf: '2026-07-15', rows: [fact], bySymbol: new Map([['GAP', fact]]) } });
    assert.deepEqual(cellsOf(out.table, 'GAP').slice(6), [((100 / 97 - 1) * 100).toFixed(1), '']);
});

test('Ask is offered the tool and told never to swap the reader\'s condition for another metric', () => {
    const aiChat = require('../ai-chat');
    assert.ok(aiChat.TOOLS.some(t => t.function.name === 'query_universe'));
    assert.match(uq.TOOL.function.description, /never replace the user's condition with a different metric/);
    for (const line of ['revenue', 'sbc', 'buybacks', 'shares_outstanding', 'operating_cash_flow']) assert.ok(uq.HELP.includes(line));
});

// 2026-10-18: Ask answered "AppLovin's FY2024 free cash flow margin was 65.0%"
// from this tool. FY2024 revenue was restated to leave out the Apps business
// sold to Tripledot, while the filed operating cash flow still included it.
test('a cash-flow share of revenue is blank for a period with discontinued operations, and says why', () => {
    const fact = (s, disc) => ({ s, c: 'USD', a: { ends: ['2025-12-31', '2024-12-31'], f: { revenue: [100, 80], operating_cash_flow: [70, 52], capex: [-2, -1], ...(disc ? { discontinued_operations: disc } : {}) } } });
    const items = [
        { row: { symbol: 'DISC', name: 'DISC Inc.', sector: 'Information Technology', marketCapB: 20 }, fact: fact('DISC', [null, -9]) },
        { row: { symbol: 'PLAIN', name: 'PLAIN Inc.', sector: 'Information Technology', marketCapB: 10 }, fact: fact('PLAIN', null) }
    ];
    const columns = [
        { name: 'fcf_margin_prior', formula: 'pct(fy(operating_cash_flow, 1) - abs(fy(capex, 1)), fy(revenue, 1))', unit: 'percent' },
        { name: 'fcf_margin_latest', formula: 'pct(fy(operating_cash_flow) - abs(fy(capex)), fy(revenue))', unit: 'percent' },
        { name: 'ocf_prior', formula: 'fy(operating_cash_flow, 1)', unit: 'usd' }
    ];
    const out = run({ columns, include_stale: true }, items);
    assert.deepEqual(cellsOf(out.table, 'DISC').slice(6), ['', '68.0', '52'], 'the mixed year is blank; a clean year and the filed cash flow itself still show');
    assert.deepEqual(cellsOf(out.table, 'PLAIN').slice(6), ['63.7', '68.0', '52']);
    assert.deepEqual(out.mixedCashBasis.blanked, ['DISC fcf_margin_prior']);
    assert.match(out.mixedCashBasis.note, /discontinued operations/);
    const screened = run({ where: 'pct(fy(operating_cash_flow, 1), fy(revenue, 1)) > 10', include_stale: true }, items);
    assert.deepEqual(screened.table.split('\n').slice(1).map(l => l.split('|')[0]), ['PLAIN'], 'a mixed figure never passes a condition');
    const rows = items.map(c => c.row), facts = { v: 1, asOf: '2026-07-15', rows: items.map(c => c.fact), bySymbol: new Map(items.map(c => [c.fact.s, c.fact])) };
    assert.deepEqual(uq.valuesFor('DISC', [columns[0].formula, columns[2].formula], { screenRows: rows, facts }), [null, 52]);
});

// 2026-10-18: Max follow-ups ("find me 3 more in micro cap") asked for
// {name: 'pe', formula: 'pe'} beside their growth columns and were refused as
// "already a statement line"; each refusal cost a whole extra reasoning round.
test('a column that only shows a per-company figure under its own name is accepted', () => {
    const out = run({ columns: [{ name: 'g', formula: 'growth_pct(ttm(revenue), ttm(revenue, 4))', unit: 'percent' }, { name: 'pe', formula: 'pe', unit: 'number' }, { name: 'market_cap_b', formula: 'MARKET_CAP_B' }],
        where: 'g >= 30 and pe < 25', sort_by: 'pe' });
    assert.equal(out.error, undefined);
    assert.equal(out.matched, 2);
    assert.deepEqual(cellsOf(out.table, 'FAST').slice(6), ['35.0', '20', '10']);
});
