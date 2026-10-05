'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../ask-answer-quality');
const policy = require('../ask-report-policy');

function fact(value, id, currency = 'USD') {
    return { value, unit: currency, currency, scope: 'entity', sourceIds: [id] };
}

function annual(symbol, observations) {
    return { tool: 'get_financials', result: { symbol, statement: 'income', basis: 'annual (fiscal years)', observations } };
}

test('failed comparison synthesis retains a real two-company comparison and dated valuation', () => {
    const results = [
        annual('MSFT', [
            { periodEnd: '2026-06-30', currency: 'USD', fields: { totalRevenue: fact(331839000000, 'msft-r-26'), netIncome: fact(133749000000, 'msft-ni-26') } },
            { periodEnd: '2025-06-30', currency: 'USD', fields: { totalRevenue: fact(281724000000, 'msft-r-25'), netIncome: fact(101832000000, 'msft-ni-25') } }
        ]),
        annual('HIMS', [
            { periodEnd: '2025-12-31', currency: 'USD', fields: { totalRevenue: fact(2348000000, 'hims-r-25'), netIncome: fact(128365000, 'hims-ni-25') } },
            { periodEnd: '2024-12-31', currency: 'USD', fields: { totalRevenue: fact(1477000000, 'hims-r-24'), netIncome: fact(126038000, 'hims-ni-24') } }
        ]),
        { tool: 'get_quote', result: { symbol: 'MSFT', currency: 'USD', marketCap: 3909965100000, asOf: '2026-10-05T20:00:02.000Z' } },
        { tool: 'get_quote', result: { symbol: 'HIMS', currency: 'USD', marketCap: 6875907558, asOf: '2026-10-05T20:00:03.000Z' } }
    ];
    const question = 'Compare Microsoft (MSFT) and Hims & Hers (HIMS) using latest reported annual revenue, net income, revenue growth and dated valuation.';
    const answer = q.fallback(results, question);
    assert.match(answer, /MSFT/); assert.match(answer, /HIMS/);
    assert.match(answer, /2026-06-30/); assert.match(answer, /2025-12-31/);
    assert.match(answer, /17\.8%/); assert.match(answer, /59\.0%/);
    assert.match(answer, /market capitalization and quote date/i);
    assert.doesNotMatch(answer, /This is a partial answer using verified SEC evidence/);
    assert.deepEqual(q.audit(answer, results, { question }), []);
});

test('company-story recovery narrates only sourced annual financial movements and labels remaining gaps', () => {
    const periods = [
        ['2025-12-27', 34639000000, 4335000000, 8091000000],
        ['2024-12-28', 25785000000, 1641000000, 6456000000],
        ['2023-12-30', 22680000000, 854000000, 5872000000],
        ['2022-12-31', 23601000000, 1320000000, 5005000000],
        ['2021-12-25', 16434000000, 3162000000, 2845000000]
    ].map(([periodEnd, revenue, netIncome, rd], index) => ({ periodEnd, currency: 'USD', fields: {
        totalRevenue: fact(revenue, `amd-r-${index}`), netIncome: fact(netIncome, `amd-ni-${index}`),
        researchAndDevelopment: fact(rd, `amd-rd-${index}`)
    } }));
    const results = [annual('AMD', periods),
        { tool: 'get_segments', result: { symbol: 'AMD', error: 'Segment extraction unavailable' } },
        { tool: 'get_peer_context', result: { symbol: 'AMD', error: 'Peer context unavailable' } }];
    const question = 'Tell me the story of AMD.';
    const answer = q.fallback(results, question, { policy: policy.select(question) });
    assert.match(answer, /The financial story in the reported numbers/);
    assert.match(answer, /more than doubled/);
    assert.match(answer, /revenue fell 3\.9% in the period ended 2023-12-30/);
    assert.match(answer, /revenue rose 13\.7% in the period ended 2024-12-28/);
    assert.match(answer, /23\.4% of revenue/);
    assert.match(answer, /\*\*The read\*\*/);
    assert.match(answer, /> Next:/);
    assert.match(answer, /segment drivers.*could not be validated/);
    assert.deepEqual(q.audit(answer, results, { question }), []);
});

test('failed latest-quarter follow-up retains checked prior and current filing excerpts', () => {
    const currentUrl = 'https://www.sec.gov/Archives/edgar/data/50863/000005086326000157/intc-20260627.htm';
    const priorUrl = 'https://www.sec.gov/Archives/edgar/data/50863/000005086326000079/intc-20260328.htm';
    const results = [
        { tool: 'get_financials', result: { symbol: 'INTC', statement: 'income', basis: 'quarterly', observations: [
            { periodEnd: '2026-06-27', currency: 'USD', fields: { totalRevenue: fact(16128000000, 'intc-q2-r') } }
        ] } },
        { tool: 'get_filing_diff', result: { symbol: 'INTC',
            latest: { form: '10-Q', date: '2026-07-24', url: currentUrl },
            prev: { form: '10-Q', date: '2026-04-24', url: priorUrl },
            changes: [{ area: 'Revenue', what: 'Provider-generated prose must not be repeated.',
                priorQuote: 'Revenue increased 3% to $13.7 billion for the quarter ended March 28, 2026.',
                newQuote: 'Revenue decreased 20% to $10.3 billion for the quarter ended June 27, 2026.',
                evidenceVerified: true, figuresVerified: true }] } }
    ];
    const question = 'Follow up on the INTC report in this conversation. What changed in Intel latest quarter and how does it relate to earlier report?';
    const answer = q.fallback(results, question);
    assert.match(answer, /Checked filing comparison/);
    assert.match(answer, /10-Q filed 2026-07-24/); assert.match(answer, /10-Q filed 2026-04-24/);
    assert.match(answer, /Revenue decreased 20%/); assert.match(answer, /Revenue increased 3%/);
    assert.doesNotMatch(answer, /Provider-generated prose/);
    assert.deepEqual(q.audit(answer, results, { question }), []);
});
