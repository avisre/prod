'use strict';
// The provider gap-fill is the one path where a figure reaches an answer without
// a filed fact behind it, so what it refuses to publish matters as much as what it
// publishes: a placeholder read as a measurement is the exact error the verified
// pages exist to catch.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.SEC_COVERAGE_READ_ONLY = '1';
process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
const cache = require('../fundamentals-cache');
const provider = require('../provider-fundamentals');

const originalLoad = cache.loadRawFundamentals;
afterEach(() => { cache.loadRawFundamentals = originalLoad; });
const useSnapshot = raw => { cache.loadRawFundamentals = () => raw; };

const FETCHED = '2026-10-01T09:57:19.929Z';
const snapshot = (overview, statements = {}) => ({ fetchedAt: FETCHED, overview, ...statements });

test('valuation gates the share-count multiples but never the margins or beta', () => {
    useSnapshot(snapshot({
        ForwardPE: '39.270035', PEGRatio: '0.62', PriceToBookRatio: '14.851788', EVToEBITDA: '103.519',
        Beta: '2.476', DividendYield: '', EBITDA: '9562000384', ProfitMargin: '0.15577',
        OperatingMarginTTM: '0.1725', ReturnOnEquityTTM: '0.10196'
    }));
    const open = provider.valuation('AMD', { perShareAllowed: true }).fields;
    assert.equal(open.forwardPE, 39.270035);
    assert.equal(open.pegRatio, 0.62);
    assert.equal(open.priceToBook, 14.851788);
    assert.equal(open.evToEbitda, 103.519);
    assert.equal(open.beta, 2.476);
    assert.equal(open.profitMarginTtm, 0.15577);
    // EBITDA is a money field and the snapshot carries no statement currency:
    // TSM's overview reads 3167467077632 with Currency "USD" — NT$3.17tn. It is
    // supplied per period by statementGaps instead, in the filed row's currency.
    assert.equal('ebitdaTtm' in open, false);
    // An unverified share class or ADR basis disqualifies exactly what it
    // disqualifies in get_quote — the priced-off-a-share-count multiples.
    const gated = provider.valuation('AMD', { perShareAllowed: false }).fields;
    for (const k of ['forwardPE', 'pegRatio', 'priceToBook', 'evToEbitda']) assert.equal(gated[k], undefined, k);
    assert.equal(gated.beta, 2.476);
    assert.equal(gated.profitMarginTtm, 0.15577);
    const block = provider.valuation('AMD', { perShareAllowed: true });
    assert.equal(block.source, 'Yahoo Finance');
    assert.equal(block.asOf, FETCHED);
    assert.match(block.note, /Yahoo Finance/);
});

test('a provider zero is a placeholder in margins and multiples, but a real dividend yield', () => {
    // Measured on the store: AllianceBernstein filed $299.8m of net income on
    // $332.8m of revenue — a 90% margin — and the provider records "0".
    useSnapshot(snapshot({
        Symbol: 'AB', ProfitMargin: '0', OperatingMarginTTM: '0', ReturnOnEquityTTM: '0',
        ForwardPE: '0', EVToEBITDA: '0', EBITDA: '0', Beta: '0', DividendYield: '0'
    }));
    const fields = provider.valuation('AB', { perShareAllowed: true }).fields;
    assert.deepEqual(fields, { dividendYield: 0 });
    // '' means not reported and must never read as a value at all.
    useSnapshot(snapshot({ ProfitMargin: '', ForwardPE: '', Beta: '' }));
    assert.equal(provider.valuation('AB', { perShareAllowed: true }), null);
});

test('a 52/53-week fiscal year matches the provider row on fiscal year, not exact date', () => {
    // AMD files FY2025 at 2025-12-27; the provider normalises it to 2025-12-31.
    useSnapshot(snapshot({}, {
        income: {
            annualReports: [
                { fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD', ebit: '4000000000', ebitda: '5000000000' },
                { fiscalDateEnding: '2024-12-31', reportedCurrency: 'USD', ebit: '2000000000' }
            ]
        }
    }));
    const rows = [{ fiscalDateEnding: '2025-12-27', reportedCurrency: 'USD', ebit: null, ebitda: null }];
    const gaps = provider.statementGaps('AMD', 'income', 'annual', rows);
    assert.equal(gaps.source, 'Yahoo Finance');
    assert.equal(gaps.fields.ebit[0].value, 4000000000);
    assert.equal(gaps.fields.ebit[0].periodEnd, '2025-12-27');
    assert.equal(gaps.fields.ebit[0].providerPeriodEnd, '2025-12-31');
    assert.equal(gaps.fields.ebitda[0].value, 5000000000);
});

test('a quarterly row takes the nearest quarter-end within three weeks, and refuses a tie', () => {
    const quarterly = (dates) => snapshot({}, {
        income: { quarterlyReports: dates.map(d => ({ fiscalDateEnding: d, reportedCurrency: 'USD', ebit: '1000000' })) }
    });
    useSnapshot(quarterly(['2026-06-30', '2026-03-31']));
    const near = provider.statementGaps('X', 'income', 'quarterly', [{ fiscalDateEnding: '2026-06-27', ebit: null }]);
    assert.equal(near.fields.ebit[0].providerPeriodEnd, '2026-06-30');
    // Two candidates equidistant from the filed date: leave the period alone
    // rather than guess which one the issuer meant.
    useSnapshot(quarterly(['2026-06-28', '2026-07-02']));
    assert.equal(provider.statementGaps('X', 'income', 'quarterly', [{ fiscalDateEnding: '2026-06-30', ebit: null }]), null);
    // Beyond the window nothing matches either.
    useSnapshot(quarterly(['2026-03-31']));
    assert.equal(provider.statementGaps('X', 'income', 'quarterly', [{ fiscalDateEnding: '2026-06-27', ebit: null }]), null);
});

test('the filed figure wins: a field the verified row carries is never supplied again', () => {
    useSnapshot(snapshot({}, {
        balance: { annualReports: [{ fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD', goodwill: '999', inventory: '25000000' }] }
    }));
    const rows = [{ fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD', goodwill: 12345678, inventory: null }];
    const gaps = provider.statementGaps('X', 'balance', 'annual', rows);
    assert.equal(gaps.fields.goodwill, undefined);           // filed value stands
    assert.equal(gaps.fields.inventory[0].value, 25000000);  // a real gap, filled
});

test('cash outflows arrive as unsigned magnitudes so the sign cannot flip their meaning', () => {
    useSnapshot(snapshot({}, {
        cash: {
            annualReports: [{
                fiscalDateEnding: '2026-01-31', reportedCurrency: 'USD',
                capitalExpenditures: '-6042000000', changeInCashAndCashEquivalents: '2016000000'
            }]
        }
    }));
    const rows = [{ fiscalDateEnding: '2026-01-25', reportedCurrency: 'USD', capitalExpenditures: null, changeInCashAndCashEquivalents: null }];
    const gaps = provider.statementGaps('NVDA', 'cash', 'annual', rows);
    assert.equal(gaps.fields.capitalExpenditures[0].value, 6042000000);
    assert.equal(gaps.fields.capitalExpenditures[0].magnitude, true);
    // A net change is not an outflow field: its sign is the fact.
    assert.equal(gaps.fields.changeInCashAndCashEquivalents[0].value, 2016000000);
    assert.equal(gaps.fields.changeInCashAndCashEquivalents[0].magnitude, undefined);
});

test('a company the provider cannot fill returns nothing rather than an empty block', () => {
    useSnapshot(snapshot({}, { income: { annualReports: [{ fiscalDateEnding: '2025-12-31', ebit: '0', ebitda: '' }] } }));
    assert.equal(provider.statementGaps('AB', 'income', 'annual', [{ fiscalDateEnding: '2025-12-31', ebit: null, ebitda: null }]), null);
    // No snapshot at all, an unknown statement, and a missing series are all null.
    useSnapshot(null);
    assert.equal(provider.statementGaps('AB', 'income', 'annual', [{ fiscalDateEnding: '2025-12-31', ebit: null }]), null);
    assert.equal(provider.valuation('AB'), null);
    useSnapshot(snapshot({}));
    assert.equal(provider.statementGaps('AB', 'equity', 'annual', [{ fiscalDateEnding: '2025-12-31' }]), null);
    assert.equal(provider.statementGaps('AB', 'income', 'annual', []), null);
});

test('a cache that throws yields no provider data instead of breaking the tool call', () => {
    cache.loadRawFundamentals = () => { throw new Error('cache exploded'); };
    assert.equal(provider.snapshot('AB'), null);
    assert.equal(provider.valuation('AB'), null);
    assert.equal(provider.statementGaps('AB', 'income', 'annual', [{ fiscalDateEnding: '2025-12-31', ebit: null }]), null);
});

test('pnum reads the provider’s string numbers and rejects what is not a number', () => {
    assert.equal(provider.pnum('1,234.5'), 1234.5);
    assert.equal(provider.pnum(''), null);
    assert.equal(provider.pnum('  '), null);
    assert.equal(provider.pnum('N/A'), null);
    assert.equal(provider.pnum(null), null);
    assert.equal(provider.pnum(0), 0);
});
