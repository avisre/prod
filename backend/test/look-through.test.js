'use strict';

// Pins the look-through reveal: what the user actually owns underneath.
//
// The claim this feature makes is a strong one — "you own 61 companies and the
// largest isn't a ticker you typed" — so the arithmetic has to survive being
// checked against a portfolio that is fully known. Three properties carry it:
//
//   1. Exposure is summed in DOLLARS, not percentages. A fund's N-PORT weights
//      are fractions of that fund's own net assets, so a company's exposure is
//      `fund value x weight`; adding percentages of different bases would be a
//      quiet lie.
//   2. A company held both directly and inside a fund is ONE company, and the
//      row says both ways it is held.
//   3. Nothing unreadable is guessed. A fund that files no holding report is
//      named with its share of the portfolio, and coverage is printed, so a
//      partial expansion announces itself as partial.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildReveal } = require('../look-through');

const FUND = (rows, extra) => Object.assign({
    holdings: rows, count: rows.length, complete: true, asOf: '2026-06-30',
    source: 'SEC Form N-PORT', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/x.xml'
}, extra || {});

const eq = (name, weight, extra) => Object.assign({
    name, issuer: name, weight, cusip: '', isin: '', assetCategory: 'EC', currency: 'USD'
}, extra || {});

// A portfolio whose answer is known by hand: VTSAX is 60% of the money and
// holds Apple at 5.00% of its own assets, so Apple's exposure is
// 60,000 x 0.05 = $3,000 = 30% of the $10,000 portfolio.
function portfolio() {
    return [
        { symbol: 'VTSAX', name: 'Vanguard Total Stock Market', assetType: 'mutual_fund', shares: 60, currentPrice: 100 },
        { symbol: 'KO', name: 'Coca-Cola', assetType: 'stock', shares: 100, currentPrice: 40 }
    ];
}

const fetchFor = (map) => async (symbol) => map[symbol] || null;

test('exposure is summed in dollars through each fund, not in percentages', () => {
    const map = {
        VTSAX: FUND([eq('APPLE INC', 0.05), eq('MICROSOFT CORP', 0.025), eq('NVIDIA CORP', 0.01)])
    };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        const apple = rv.top.find((c) => /apple/i.test(c.name));
        // 600 shares x $100 = $6,000 in VTSAX; x 5% = $300 of Apple; over the
        // $10,000 total = 3.0%, NOT the fund's 5%.
        assert.equal(apple.value, 300);
        assert.equal(apple.weightPct, 3);
        const msft = rv.top.find((c) => /microsoft/i.test(c.name));
        assert.equal(msft.weightPct, 1.5);
    });
});

test('the direct holding is counted once and named as both ways held', () => {
    // KO is held directly AND sits inside the fund. One company, two routes.
    const map = {
        VTSAX: FUND([eq('COCA-COLA CO', 0.10), eq('APPLE INC', 0.05)])
    };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        const ko = rv.top.find((c) => /coca/i.test(c.name));
        assert.equal(ko.direct, true);
        assert.deepEqual(ko.via, ['VTSAX']);
        // $4,000 direct + $600 through the fund = $4,600 of $10,000.
        assert.equal(ko.value, 4600);
        assert.equal(ko.weightPct, 46);
        assert.equal(rv.top.filter((c) => /coca/i.test(c.name)).length, 1, 'KO must appear once');
    });
});

test('the company count is companies, not fund rows', () => {
    const map = {
        VTSAX: FUND([eq('APPLE INC', 0.04), eq('APPLE INC', 0.01), eq('MICROSOFT CORP', 0.02)])
    };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        // Apple appears twice (two share classes/lines) and KO once.
        assert.equal(rv.companies, 3);
        assert.equal(rv.tickers, 2);
    });
});

test('bonds and derivatives are held but are not counted as companies', () => {
    const map = {
        VTSAX: FUND([
            eq('APPLE INC', 0.05),
            eq('US TREASURY N/B', 0.20, { assetCategory: 'DBT' }),
            eq('SOME SWAP', 0.01, { assetCategory: 'DE' }),
            eq('UNCLASSIFIED LINE', 0.02, { assetCategory: '' })
        ])
    };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        assert.equal(rv.companies, 2, 'only Apple and Coca-Cola are companies');
        assert.ok(!rv.top.some((c) => /treasury|swap|unclassified/i.test(c.name)));
        // $6,000 x 23% = $1,380 of $10,000 = 13.8%, disclosed rather than dropped.
        assert.equal(rv.otherPct, 13.8);
    });
});

test('a fund that files no holding report is named, never guessed at', () => {
    const map = { VTSAX: null };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        assert.equal(rv.companies, 1, 'only the direct holding is known');
        const missed = rv.notExpanded.map((f) => f.symbol);
        assert.deepEqual(missed, ['VTSAX']);
        assert.equal(rv.notExpanded[0].weightPct, 60);
        // 40% of the money is covered, and the payload says so.
        assert.equal(rv.coveredPct, 40);
    });
});

test('a company held only through a fund is flagged as not a typed ticker', () => {
    const map = { VTSAX: FUND([eq('MICROSOFT CORP', 0.70), eq('NVIDIA CORP', 0.10)]) };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        assert.equal(rv.largest.name, 'MICROSOFT CORP');
        // $6,000 x 70% = $4,200, ahead of the $4,000 held directly in KO.
        assert.equal(rv.largest.value, 4200);
        assert.equal(rv.largest.direct, false);
        assert.equal(rv.largestIsUntyped, true);
    });
});

test('when the largest IS held directly the claim is not made', () => {
    const map = { VTSAX: FUND([eq('MICROSOFT CORP', 0.01)]) };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        assert.equal(rv.largest.name, 'Coca-Cola');
        assert.equal(rv.largestIsUntyped, false);
    });
});

test('a failing fetch degrades to uncovered, and never fails the reveal', () => {
    const boom = async () => { throw new Error('sec.gov is down'); };
    return buildReveal(portfolio(), { fetchHoldings: boom }).then((rv) => {
        assert.equal(rv.companies, 1);
        assert.equal(rv.notExpanded.length, 1);
        assert.equal(rv.coveredPct, 40);
    });
});

test('a portfolio of funds only still resolves to companies', () => {
    const holdings = [
        { symbol: 'VOO', name: 'Vanguard S&P 500', assetType: 'etf', shares: 10, currentPrice: 500 },
        { symbol: 'VTSAX', name: 'Vanguard Total Stock Market', assetType: 'mutual_fund', shares: 60, currentPrice: 100 }
    ];
    const map = {
        VOO: FUND([eq('APPLE INC', 0.07), eq('MICROSOFT CORP', 0.06)]),
        VTSAX: FUND([eq('APPLE INC', 0.05), eq('NVIDIA CORP', 0.04)])
    };
    return buildReveal(holdings, { fetchHoldings: fetchFor(map) }).then((rv) => {
        assert.equal(rv.tickers, 2);
        assert.equal(rv.companies, 3);
        // Apple: 5,000 x 7% + 6,000 x 5% = $650 of $11,000 = 5.9%.
        const apple = rv.top.find((c) => /apple/i.test(c.name));
        assert.equal(apple.value, 650);
        assert.equal(apple.via.length, 2, 'both funds must be named');
    });
});

test('positions the user holds but we cannot price are excluded, not counted as zero', () => {
    const holdings = [
        { symbol: 'KO', name: 'Coca-Cola', assetType: 'stock', shares: 100, currentPrice: 40 },
        { symbol: 'ZZZZ', name: 'Unpriced', assetType: 'stock', shares: 5 }   // no price at all
    ];
    return buildReveal(holdings, { fetchHoldings: fetchFor({}) }).then((rv) => {
        assert.equal(rv.tickers, 1);
        assert.equal(rv.coveredPct, 100, 'the unpriced holding is not silently counted as covered or uncovered');
    });
});

test('an empty or worthless portfolio returns null rather than a reveal of nothing', () => {
    return Promise.all([
        buildReveal([], { fetchHoldings: fetchFor({}) }),
        buildReveal([{ symbol: 'KO', shares: 0, currentPrice: 40 }], { fetchHoldings: fetchFor({}) })
    ]).then(([a, b]) => {
        assert.equal(a, null);
        assert.equal(b, null);
    });
});

test('the counts shown are the ones the payload carries', () => {
    // The reveal is rendered straight from these fields, so a rename here would
    // silently blank the card rather than fail loudly.
    const map = { VTSAX: FUND([eq('APPLE INC', 0.05), eq('MICROSOFT CORP', 0.02)]) };
    return buildReveal(portfolio(), { fetchHoldings: fetchFor(map) }).then((rv) => {
        for (const field of ['tickers', 'companies', 'top', 'largest', 'largestIsUntyped',
            'expanded', 'notExpanded', 'coveredPct', 'otherPct', 'more']) {
            assert.ok(Object.prototype.hasOwnProperty.call(rv, field), `reveal is missing ${field}`);
        }
        assert.equal(rv.expanded[0].source, 'SEC Form N-PORT');
        assert.equal(rv.expanded[0].asOf, '2026-06-30');
    });
});

test('the dashboard renders the reveal from the payload and settles its counts', () => {
    const fs = require('node:fs');
    const dashboardJs = fs.readFileSync(path.join(__dirname, '../../frontend-v2/assets/dashboard.js'), 'utf8');
    const dashboardHtml = fs.readFileSync(path.join(__dirname, '../../frontend-v2/dashboard.html'), 'utf8');
    assert.match(dashboardJs, /renderReveal\(x\.reveal\)/, 'loadXray must pass the reveal to the renderer');
    assert.match(dashboardJs, /settleInt\(\$\('reveal-companies'\), rv\.companies\)/, 'the count must settle');
    assert.match(dashboardHtml, /id="xray-reveal"/, 'the container must exist');
    assert.match(dashboardHtml, /assets\/dashboard\.js\?v=20261006-annual30/, 'the stamp must ship the change');
});
