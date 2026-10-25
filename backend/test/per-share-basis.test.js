'use strict';
// Which listings may set their price against the filed per-share amounts (audit 2026-10-25):
// 700 company pages showed no EPS or P/E, 18 of them only because a note, unit or ETN of the
// same issuer was listed as a second "stock", and 69 because a second share class existed.
const test = require('node:test'), assert = require('node:assert/strict');
const { securityType } = require('../../scripts/lib/us-listings');
const verified = require('../verified-fundamentals');
const quotes = require('../quote-store');
const stocks = require('../stock-universe');

test('notes, ETNs, corporate units and preferred depositary shares are not typed as stock', () => {
    const type = (name, symbol = 'X') => securityType({ symbol, name });
    assert.equal(type('iPath Series B S&P 500 VIX Short-Term Futures ETN', 'VXX'), 'debt');
    assert.equal(type('Comcast Holdings ZONES', 'CCZ'), 'debt');
    assert.equal(type('Brookfield Finance Inc. 4.50% Perpetual Subordinated Notes', 'BNJ'), 'debt');
    assert.equal(type('DTE Energy Company 2021 Series E 4.375% Junior Subordinated Debentures', 'DTG'), 'debt');
    assert.equal(type('Synthetic Fixed-Income Securities Inc 6.375% (STRATS) Cl A-1', 'GJH'), 'debt');
    assert.equal(type('Tennessee Valley Authority Common Stock', 'TVC'), 'debt');
    assert.equal(type('Duke Energy Corporation Corporate Units', 'DUKU'), 'unit');
    assert.equal(type('VSE Corporation - Tangible Equity Units', 'VSECU'), 'unit');
    assert.equal(type('Empire State Realty OP, L.P. Series ES Operating Partnership Units Representing Limited Partnership Interests', 'ESBA'), 'unit');
    assert.equal(type('WaFd, Inc. - Depositary Shares', 'WAFDP'), 'preferred');
    assert.equal(type("Dillard's Capital Trust I", 'DDT'), 'preferred');
    // common equity keeps its type: ADRs, MLP units, trust units
    assert.equal(type('Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share', 'BABA'), 'stock');
    assert.equal(type('Energy Transfer LP Common Units', 'ET'), 'stock');
    assert.equal(type('Permianville Royalty Trust Units of Beneficial Interest', 'PVL'), 'stock');
    assert.equal(type('Duke Energy Corporation (Holding Company) Common Stock', 'DUK'), 'stock');
});

const issuer = (eps, currency = 'USD') => ({ income: { annualReports: [{ fiscalDateEnding: '2025-12-31', reportedCurrency: currency, dilutedEPS: eps }], quarterlyReports: [] }, balance: { annualReports: [] }, cash: { annualReports: [] } });
const quote = (price, trailingPE) => ({ symbol: 'X', price, trailingPE, forwardPE: 21, dividendYield: 0.0123, marketCap: 1e12, asOf: '2026-10-23', currency: 'USD' });
const reason = (t, symbol, data, q) => {
    t.mock.method(quotes, 'getDailyQuote', () => q);
    return verified.adapt(stocks.lookup(symbol), null, data, {}, null);
};

test('a sibling that is not common stock leaves per-share figures on', (t) => {
    const out = reason(t, 'DUK', issuer(6.31), quote(121.47, 19.2));
    assert.equal(out.coverage.perShareReason, null);
    assert.equal(out.coverage.perShareAllowed, true);
    assert.equal(out.overview.ForwardPE, 21);
    assert.equal(out.overview.DividendYield, 0.0123);
});

test('share classes are allowed only when price over the filed EPS agrees with the quote P/E', (t) => {
    assert.equal(reason(t, 'GOOGL', issuer(10.81), quote(340, 31)).coverage.perShareReason, null);
    // Berkshire files EPS per Class A share: a Class B price is 1/1,500 of it
    const brk = reason(t, 'BRK.B', issuer(41000), quote(532, 13.4));
    assert.equal(brk.coverage.perShareReason, 'share_class');
    assert.equal(brk.overview.PERatio, null);
    assert.equal(brk.overview.ForwardPE, null);
    // the yield is per listed share, whatever the filing's share basis
    assert.equal(brk.overview.DividendYield, 0.0123);
});

test('tracking stocks, ADRs and foreign-currency filers keep price-based per-share figures off', (t) => {
    assert.equal(reason(t, 'FWONA', issuer(2), quote(80, 40)).coverage.perShareReason, 'tracking');
    assert.equal(reason(t, 'BABA', issuer(5.5, 'CNY'), quote(109, 15)).coverage.perShareReason, 'adr');
    assert.equal(reason(t, 'DUK', issuer(6.31, 'CAD'), quote(121.47, 19.2)).coverage.perShareReason, 'currency');
});

// One issuer file shared by BRK-A and BRK.B: Berkshire files each class's EPS separately
// (Q2 2026: Class A 17,868, Class B 11.91), so the row keeps both figures and each listing
// takes the class its price and trailing P/E confirm (BRK.B: 542.19 / 13.64 ≈ 39.8 = Class B).
const epsSource = (v, dimension) => ({
    type: 'sec_xbrl_fact', cik: '0001067983', taxonomy: 'us-gaap', concept: 'EarningsPerShareDiluted', unit: 'USD/shares',
    rawValue: v, periodStart: '2025-01-01', periodEnd: '2025-12-31', form: '10-K', filingDate: '2026-02-28',
    accessionNumber: '0001067983-26-000009', filingUrl: 'https://www.sec.gov/Archives/edgar/data/1067983/000106798326000009/0001067983-26-000009-index.htm',
    linkage: 'xbrl_fact', verificationMethod: 'statement_line', dimension, scope: 'entity', retrievedAt: '2026-10-20T00:00:00Z', extractionVersion: '20261025-rev2',
});
const perClass = (a, b) => ({
    cik: '0001067983', schemaVersion: 1,
    sources: { a: epsSource(a, 'ClassOfStock=ClassACommonStock'), b: epsSource(b, 'ClassOfStock=ClassBCommonStock') },
    income: {
        annualReports: [{
            fiscalDateEnding: '2025-12-31', periodStart: '2025-01-01', reportedCurrency: 'USD', periodType: 'annual',
            dilutedEPS: null, eps: null, _sources: {}, _derivations: {}, _scopes: {}, _signs: {},
            _classes: { dilutedEPS: { ClassACommonStock: { v: a, id: 'a' }, ClassBCommonStock: { v: b, id: 'b' } } },
        }],
        quarterlyReports: [],
    },
    balance: { annualReports: [], quarterlyReports: [] }, cash: { annualReports: [], quarterlyReports: [] },
});

test('a filing with one EPS per class gives each listing its own class, and never mutates the shared file', (t) => {
    const data = perClass(45000, 30);
    const a = reason(t, 'BRK.A', data, quote(675000, 15));
    assert.equal(a.coverage.perShareAllowed, true);
    assert.equal(a.overview.EPS, 45000);
    assert.equal(a.income.annualReports[0].dilutedEPS, 45000);
    assert.equal(a.income.annualReports[0]._sources.dilutedEPS.length, 1);
    const b = reason(t, 'BRK.B', data, quote(480, 16));
    assert.equal(b.coverage.perShareAllowed, true);
    assert.equal(b.overview.EPS, 30);
    assert.equal(b.income.annualReports[0].dilutedEPS, 30);
    // loadIssuer hands the same issuer object to both listings: it comes back untouched
    assert.equal(data.income.annualReports[0].dilutedEPS, null);
    assert.deepEqual(data.income.annualReports[0]._sources, {});
    assert.deepEqual(data.income.annualReports[0]._classes.dilutedEPS, { ClassACommonStock: { v: 45000, id: 'a' }, ClassBCommonStock: { v: 30, id: 'b' } });
    // no P/E on the quote, or a P/E two classes agree with: the figures stay off
    assert.equal(reason(t, 'BRK.B', data, quote(480, null)).coverage.perShareReason, 'share_class');
    assert.equal(reason(t, 'BRK.B', data, quote(480, null)).overview.EPS, null);
    const close = perClass(30, 33);
    const two = reason(t, 'BRK.B', close, quote(3150, 100)); // 31.5 implied: both classes match
    assert.equal(two.coverage.perShareReason, 'share_class');
    assert.equal(two.overview.EPS, null);
});

// The class the quote's trailing P/E confirms: the one whose figures sit within 5% of the implied
// EPS while no other class's do — a loose match is another class's figure (GEF-B: the only annual on
// file was stale, and 36% off still looked closer than the right class's 76%).
const classSource = (v, end, start, form) => ({
    type: 'sec_xbrl_fact', cik: '0001067983', taxonomy: 'us-gaap', concept: 'EarningsPerShareBasic', unit: 'USD/shares',
    rawValue: v, periodStart: start, periodEnd: end, form, filingDate: form === '10-K' ? '2026-02-28' : '2026-08-01', accessionNumber: '0001067983-26-000009',
    filingUrl: 'https://www.sec.gov/Archives/edgar/data/1067983/000106798326000009/0001067983-26-000009-index.htm',
    linkage: 'xbrl_fact', verificationMethod: 'statement_line', dimension: 'ClassOfStock=CommonStock', scope: 'entity',
    retrievedAt: '2026-10-20T00:00:00Z', extractionVersion: '20261025-rev2',
});
// One row per period: `members` holds each class's own figure under _classes with its own source;
// `shared` is the one figure the classes filed together, carried on the field itself (HSY's quarters).
const classIssuer = (rows) => {
    const sources = {}, income = rows.map(({ end, start, type, members, shared }) => {
        const row = { fiscalDateEnding: end, periodStart: start, reportedCurrency: 'USD', periodType: type, eps: null, dilutedEPS: null, _sources: {}, _derivations: {}, _scopes: {}, _signs: {} };
        const form = type === 'annual' ? '10-K' : '10-Q';
        if (shared != null) { const id = end + '-shared'; sources[id] = classSource(shared, end, start, form); row.eps = shared; row._sources.eps = [id]; }
        if (members) {
            row._classes = {};
            for (const [field, per] of Object.entries(members)) {
                row._classes[field] = {};
                for (const [member, v] of Object.entries(per)) {
                    const id = end + '-' + field + '-' + member;
                    sources[id] = classSource(v, end, start, form);
                    row._classes[field][member] = { v, id };
                }
            }
        }
        return row;
    });
    return { cik: '0001067983', schemaVersion: 1, sources, income: { annualReports: income.filter(r => r.periodType === 'annual'), quarterlyReports: income.filter(r => r.periodType === 'quarterly') }, balance: { annualReports: [], quarterlyReports: [] }, cash: { annualReports: [], quarterlyReports: [] } };
};

test('a class is the listing\'s only when its figures are within 5% and no other class\'s are', (t) => {
    // V: four classes — Class A 1.5% off the implied EPS, B1/B2 about 30%, C far.
    const four = classIssuer([{ end: '2025-12-31', start: '2025-01-01', type: 'annual', members: { dilutedEPS: { ClassA: 11.4, B1: 15.9, B2: 15.7, C: 40.8 } } }]);
    const v = reason(t, 'BRK.B', four, quote(115.7, 10)); // implied 11.57
    assert.equal(v.coverage.perShareAllowed, true);
    assert.equal(v.overview.EPS, 11.4);
    // RBCAA: Class A 0.9% off, Class B 6% — the old loose band could not tell them apart.
    const rbc = classIssuer([{ end: '2025-12-31', start: '2025-01-01', type: 'annual', members: { dilutedEPS: { ClassA: 6.55, ClassB: 6.11 } } }]);
    assert.equal(reason(t, 'BRK.B', rbc, quote(65, 10)).overview.EPS, 6.55); // implied 6.5
    // GEF-B: only a stale annual on file, the wrong class 36% off, the right one 76% — no class is taken.
    const greif = classIssuer([{ end: '2024-10-31', start: '2023-11-01', type: 'annual', members: { dilutedEPS: { ClassA: 4.64, ClassB: 6.98 } } }]);
    const blank = reason(t, 'GEF-B', greif, quote(325, 100)); // implied 3.25
    assert.equal(blank.coverage.perShareAllowed, false);
    assert.equal(blank.overview.EPS, null);
    assert.equal(blank.income.annualReports.filter(r => r.dilutedEPS !== null || r.eps !== null).length, 0, 'Class A must not be taken for the Class B listing');
});

test('a quarter where the classes filed one figure still counts toward the trailing twelve months', (t) => {
    // HSY: the latest annual and quarter keep each class's figure, older quarters the shared one.
    const hsy = classIssuer([
        { end: '2025-12-31', start: '2025-01-01', type: 'annual', members: { eps: { CommonStock: 4.34, ClassB: 4.05 } } },
        { end: '2026-06-30', start: '2026-04-01', type: 'quarterly', members: { eps: { CommonStock: 1.2, ClassB: 1.1 } } },
        { end: '2026-03-31', start: '2026-01-01', type: 'quarterly', shared: 1.1 },
        { end: '2025-06-30', start: '2025-04-01', type: 'quarterly', shared: 1.0 },
        { end: '2025-03-31', start: '2025-01-01', type: 'quarterly', shared: 0.95 },
    ]);
    const out = reason(t, 'BRK.B', hsy, quote(46.8, 10)); // implied 4.68: CommonStock TTM 4.69, ClassB 4.30
    assert.equal(out.coverage.perShareAllowed, true);
    assert.equal(out.overview.EPS, 4.34);
    assert.equal(out.income.quarterlyReports.find(r => r.fiscalDateEnding === '2026-06-30').eps, 1.2);
});

test('the chosen class fills every per-share field it filed, each from its own source', (t) => {
    // ERIE: Class A filed both basic and diluted; the listing takes both, not the diluted alone.
    const erie = classIssuer([{ end: '2025-12-31', start: '2025-01-01', type: 'annual', members: { eps: { ClassA: 10.69, ClassB: 1802 }, dilutedEPS: { ClassA: 10.75, ClassB: 1801 } } }]);
    const out = reason(t, 'BRK.B', erie, quote(110.3, 10)); // implied 11.03
    assert.equal(out.coverage.perShareAllowed, true);
    const row = out.income.annualReports[0];
    assert.equal(row.eps, 10.69);
    assert.equal(row.dilutedEPS, 10.75);
    assert.notEqual(row._sources.eps[0], row._sources.dilutedEPS[0]);
    // the shared issuer file comes back untouched
    assert.equal(erie.income.annualReports[0].eps, null);
    assert.equal(erie.income.annualReports[0].dilutedEPS, null);
});
