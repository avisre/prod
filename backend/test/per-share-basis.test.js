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
