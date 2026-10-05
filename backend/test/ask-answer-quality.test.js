'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.OLLAMA_API_KEY = 'test-only-key';
process.env.SEC_COVERAGE_READ_ONLY = '1';
process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
const q = require('../ask-answer-quality');
const evidence = require('../ask-evidence');
const ask = require('../ai-chat');
const axios = require('axios');
const secSource = require('../sec-source');
const watchdog = require('../watchdog');
const segmentProof = require('../ask-segment-evidence');
const fixture = require('./fixtures/ask-apple-verified.json');
const cache = require('../fundamentals-cache');
const originalLoad = cache.loadFundamentals;
const originalAxiosGet = axios.get;
const originalCikFor = secSource.cikFor;
const originalRecentFilings = watchdog.fetchRecentFilings;
afterEach(() => {
    ask.__resetDeps(); cache.loadFundamentals = originalLoad; axios.get = originalAxiosGet;
    secSource.cikFor = originalCikFor; watchdog.fetchRecentFilings = originalRecentFilings;
});
function useFixture() { cache.loadFundamentals = symbol => symbol === 'AAPL' ? structuredClone(fixture) : originalLoad(symbol); }
const tool = (id, statement) => ({ id, type: 'function', function: { name: 'get_financials', arguments: JSON.stringify({ symbol: 'AAPL', statement, limit: 2 }) } });
const spec = (points, unit = 'USD', type = 'viz', name = 'Revenue') => '```' + type + '\n' + JSON.stringify(type === 'viz' ? { unit, series: [{ name, points }] } : { unit, rows: points }) + '\n```';
const get = async statement => { useFixture(); return [{ tool: 'get_financials', result: await ask.runTool('get_financials', { symbol: 'AAPL', statement, limit: 2 }) }]; };

function withLiteralSegmentProof(segment, income) {
    const row = income.observations[0], fact = row.fields.totalRevenue;
    fact.unit = segment.currency;
    const start = new Date(row.periodEnd + 'T00:00:00Z');
    start.setUTCFullYear(start.getUTCFullYear() - 1); start.setUTCDate(start.getUTCDate() + 1);
    for (const source of Object.values(income.provenance.sources)) Object.assign(source, {
        rawValue: fact.value, periodStart: start.toISOString().slice(0, 10), linkage: 'xbrl_fact'
    });
    const parsed = { periodEnd: segment.periodEnd, basisExcerpt: `Segment revenue in ${segment.currency}.`, periodExcerpt: `Year ended ${segment.periodEnd}.`,
        segments: segment.segments.map(s => ({ ...s, reportedValue: s.value, scale: 1, sourceExcerpt: `${s.name} revenue ${s.value}.` })) };
    const text = [parsed.basisExcerpt, parsed.periodExcerpt, ...parsed.segments.map(s => s.sourceExcerpt)].join(' ');
    const filing = { ...segment.filing, accession: segment.filing.accessionNumber };
    return segmentProof.normalizeResult(parsed, segment.symbol || 'TEST', segment.cik, filing, { text, anchor: segmentProof.exactAnnualRevenue(filing, income, segment.cik) });
}

test('standalone leases and guarantees use filing research without requiring an SPV mention', () => {
    const url = 'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/annual.htm';
    const results = [
        { tool: 'search_filings', result: { results: [{ url, form: '20-F', filed: '2026-03-01' }] } },
        { tool: 'fetch_page', result: { url, text: 'All amounts are in CAD. Lease obligations were $2 billion as of December 31, 2025. Guarantees were C$400 million as of December 31, 2025.' } }
    ];
    const facts = q.filingNarrativeEvidence(results);
    assert.deepEqual(facts.map(f => [f.category, f.unit, f.value]), [['lease_obligation', 'CAD', 2e9], ['guarantee', 'CAD', 400e6]]);
    assert.equal(q.issuerDisclosureEvidence(results, 'Show lease obligations and guarantees.'), true);
    const lines = []; q.appendDisclosureSummary(lines, results, 'Show lease obligations and guarantees.');
    assert.match(lines.join('\n'), /```bars/);
    assert.doesNotMatch(lines.join('\n'), /research is unavailable|does not quantify a separate unconsolidated/);
    const ambiguous = structuredClone(results); ambiguous[1].result.text = 'Lease obligations were $2 billion as of December 31, 2025. Guarantees were ¥400 million as of December 31, 2025.';
    assert.deepEqual(q.filingNarrativeEvidence(ambiguous), [], 'bare dollar and yen symbols need a verified currency basis');
});

test('dated obligation charts reject mixed dates and ambiguous same-category scopes', () => {
    const url = 'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/annual.htm';
    const wrap = text => [
        { tool: 'search_filings', result: { results: [{ url, form: '10-K', filed: '2026-03-01' }] } },
        { tool: 'fetch_page', result: { url, text } }
    ];
    const results = wrap('Lease obligations were USD 2 billion as of December 31, 2025. Guarantees were USD 400 million as of December 31, 2024.');
    const mixed = spec([['Lease obligations as of 2025-12-31', 2e9], ['Guarantees as of 2024-12-31', 400e6]], 'USD', 'bars');
    assert.match(q.audit(mixed, results).join(' '), /same disclosed date/);
    const undated = spec([['Lease obligations', 2e9], ['Guarantees', 400e6]], 'USD', 'bars');
    assert.match(q.audit(undated, results).join(' '), /date/);
    const conflicting = wrap('Lease obligations were USD 2 billion as of December 31, 2025 and USD 1 billion as of December 31, 2024.');
    assert.ok(q.filingNarrativeEvidence(conflicting).every(f => f.periodEnd === null));
    const scopes = wrap('Lease liabilities were USD 2 billion as of December 31, 2025. Leases not yet commenced had lease obligations of USD 5 billion as of December 31, 2025.');
    const known = []; q.appendDisclosureSummary(known, scopes, 'Show lease obligations.');
    assert.match(known.join('\n'), /Reported lease liabilities/);
    assert.match(known.join('\n'), /Leases not yet commenced/);
    assert.match(known.join('\n'), /not summed/);
    const ambiguousScopes = wrap('Lease obligations were USD 2 billion as of December 31, 2025. Other lease obligations were USD 5 billion as of December 31, 2025.');
    const lines = []; q.appendDisclosureSummary(lines, ambiguousScopes, 'Show lease obligations.');
    assert.doesNotMatch(lines.join('\n'), /```bars/);
    assert.match(lines.join('\n'), /scopes cannot be compared reliably/);
});

test('capital-return coverage preserves exact inputs and does not invent missing payouts', async () => {
    const [{ result }] = await get('cash'), c = result.capitalReturns[0];
    assert.equal(c.totalDistributions, 106132000000);
    assert.equal(c.surplusAfterDistributions, -7365000000);
    assert.equal(c.coveredByFreeCashflow, false);
    assert.equal(c.inputs.freeCashflow.value, 98767000000);
    for (const id of c.sourceIds) assert.ok(result.provenance.sources[id]);
    const row = structuredClone(fixture.cash.annualReports[0]);
    row.dividendPayout = 0; row.paymentsForRepurchaseOfCommonStock = 0;
    assert.equal(evidence.capitalReturns(row).coveredByFreeCashflow, true);
    row.paymentsForRepurchaseOfCommonStock = null;
    assert.equal(evidence.capitalReturns(row).coveredByFreeCashflow, null);
});

test('financial bars retain a single available metric, reported zero and native-currency gaps', () => {
    const results = [{ tool: 'get_financials', result: { symbol: 'TEST', statement: 'income', basis: 'annual', currency: 'EUR', observations: [
        { periodEnd: '2025-03-31', currency: 'EUR', fields: { totalRevenue: { value: 0, unit: 'EUR', sourceIds: ['current'] } } },
        { periodEnd: '2024-03-31', currency: 'USD', fields: { totalRevenue: { value: 200, unit: 'USD', sourceIds: ['old'] } } }
    ] } }];
    const question = 'Show revenue, net income and SBC for the latest two stored annual periods.';
    const answer = q.fallback(results, question), bars = JSON.parse(answer.match(/```bars\n([\s\S]*?)```/)[1]);
    assert.deepEqual(bars.series[0].points, [['2024-03-31', null], ['2025-03-31', 0]]);
    assert.ok(bars.series.slice(1).every(s => s.points.every(([,v]) => v === null)));
    assert.equal(bars.unit, 'EUR'); assert.deepEqual(q.audit(answer, results, { question }), []);
    const latest = 'Show revenue, net income and SBC for the latest annual period.';
    const single = q.fallback(results, latest);
    assert.deepEqual(q.audit(single, results, { question: latest }), []);
    assert.match(single, /2025-03-31/); assert.doesNotMatch(single.match(/```bars\n([\s\S]*?)```/)[1], /2024-03-31/);
});

test('observed false FCF coverage assertion is rejected, accurate shortfall is allowed', async () => {
    const data = await get('cash');
    assert.match(q.audit('FY2025 free cash flow comfortably covers dividends and buybacks.', data).join(' '), /shortfall 7365000000/);
    assert.deepEqual(q.audit('FY2025 free cash flow does not cover dividends and buybacks; the shortfall is USD 7.365bn.', data), []);
});

test('incorrect reported money and growth cannot pass because a tool was called', async () => {
    const income = await get('income');
    assert.match(q.audit('Revenue was USD 999 billion.', income).join(' '), /Monetary claim/);
    const cash = await get('cash');
    assert.match(q.audit('Capex rose 34.3%.', cash).join(' '), /Percentage claim/);
    assert.deepEqual(q.audit('Capex rose 34.6%, or $3.3bn. Operating cash flow fell $6.8bn.', cash), []);
    const bad = structuredClone(cash); bad[0].result.observations[0].fields.operatingCashflow.value = -111482000000;
    bad[0].result.comparisons = null;
    assert.match(q.audit('Operating cash flow was $111.482bn.', bad).join(' '), /Monetary claim/);
});

test('R&D intensity is a claimable compatible calculation from filed lines', async () => {
    // Apple FY2025: 34.55bn R&D over 416.161bn revenue = 8.3%. The framework's
    // Context column expresses R&D as a share of revenue, but the pair was
    // missing from percentageEvidence, so a correctly derived intensity was
    // rejected and the whole answer fell back (measured on the AMD analyst
    // sweep: 8,091/34,639 -> "23% of revenue", rejected).
    const income = await get('income');
    assert.deepEqual(q.audit('Research and development spend was 8.3% of revenue.', income), []);
    assert.deepEqual(q.audit('Research and development spend was 8% of revenue.', income), []);
    assert.match(q.audit('Research and development spend was 20% of revenue.', income).join(' '), /Percentage claim/);
});

test('a provider gap-fill figure is usable evidence, and only what the block supplied', () => {
    // EBITDA has no XBRL concept, so it arrives from the provider block. Citing
    // it used to read as an unsourced claim — the model was rewritten for using
    // the one number the tool handed it.
    const nvda = [{
        tool: 'get_financials',
        result: {
            symbol: 'NVDA', statement: 'income', basis: 'annual (fiscal years)', currency: 'USD',
            observations: [{ periodEnd: '2026-01-25', currency: 'USD', fields: { totalRevenue: { value: 213000000000, currency: 'USD', unit: 'USD', scope: 'consolidated' } } }],
            alternativeSources: {
                source: 'Yahoo Finance', asOf: '2026-10-01T00:00:00.000Z',
                units: 'Unscaled values in the row currency; magnitudes are unsigned cash outflows.',
                fields: {
                    ebit: [{ periodEnd: '2026-01-25', providerPeriodEnd: '2026-01-31', value: 130387000000, currency: 'USD', providerField: 'ebit' }],
                    capitalExpenditures: [{ periodEnd: '2026-01-25', value: 6042000000, magnitude: true, currency: 'USD', providerField: 'capitalExpenditures' }]
                }
            }
        }
    }];
    assert.deepEqual(q.audit('Yahoo Finance reports EBIT of $130.39bn for the year to 25 January 2026, as of 1 October 2026.', nvda), []);
    // The magnitude convention travels with it: capex is stated as money going out.
    assert.deepEqual(q.audit('Yahoo Finance reports capital expenditure of $6.042bn for the same period.', nvda), []);
    // Only supplied figures are claimable — the block is not an amnesty.
    assert.match(q.audit('Yahoo Finance reports EBIT of $99.9bn.', nvda).join(' '), /Monetary claim/);
    // And the filed row's currency is the block's: the same figure in JPY fails.
    assert.match(q.audit('Yahoo Finance reports EBIT of ¥130.39bn.', nvda).join(' '), /Monetary claim/);
});

test('provider valuation margins restated as percentages are claimable, wrong ones are not', () => {
    const quote = [{
        tool: 'get_quote',
        result: {
            symbol: 'AMD', price: 633.91, priceAsOf: '2026-10-02', currency: 'USD',
            // Claim validation only runs at all when the answer carries statement
            // observations (a quote-only answer is not audited figure-by-figure),
            // so the fixture is the shape a real analyst answer has: a quote
            // beside the statements.
            observations: [{ periodEnd: '2026-06-27', currency: 'USD', fields: { totalRevenue: { value: 11536000000, currency: 'USD', unit: 'USD', scope: 'consolidated' } } }],
            providerValuation: {
                source: 'Yahoo Finance', asOf: '2026-10-01T09:57:19.929Z',
                fields: { forwardPE: 39.270035, beta: 2.476, dividendYield: 0.0921, profitMarginTtm: 0.15577, operatingMarginTtm: 0.1725, returnOnEquityTtm: 0.10196 }
            }
        }
    }];
    assert.deepEqual(q.audit('The provider puts the profit margin at 15.6% and operating margin at 17.3%.', quote), []);
    assert.match(q.audit('The provider puts the profit margin at 42%.', quote).join(' '), /Percentage claim/);
});

test('the peer medians and the premium the tool computed are claimable evidence', () => {
    // get_peer_context computes these itself, so they carry no sourceIds — and
    // the framework REQUIRES them in sections 5 and 7. The tool returns
    // premiumPct 293.9; the model quoted it and the audit rejected its own
    // tool's output.
    const peer = [{
        tool: 'get_peer_context',
        result: {
            symbol: 'AMD',
            observations: [{ periodEnd: '2026-06-27', currency: 'USD', fields: { totalRevenue: { value: 11536000000, currency: 'USD', unit: 'USD', scope: 'consolidated' } } }],
            peerPositioning: {
                sector: 'Information Technology', peerCount: 187,
                company: { pe: 156.1, revCagr5Pct: 28.8, netMarginPct: 12.5, roePct: 6.9, divYieldPct: 0 },
                medians: { pe: 39.6, revCagr5Pct: 9.2, netMarginPct: 9.4, roePct: 8.7, divYieldPct: 0 },
                rank: { revCagr5Pct: 93, netMarginPct: 63, roePct: 43 },
                comps: [
                    { symbol: 'INTC', name: 'Intel', revCagr5Pct: -7.5, netMarginPct: -0.5, roePct: -0.2 },
                    { symbol: 'PLTR', name: 'Palantir Technologies', revCagr5Pct: 32.6, netMarginPct: 36.3, roePct: 22 }
                ],
                multiples: { companyPe: 156.1, peerMedianPe: 39.6, premiumPct: 293.9, repriceToMedianPct: -74.6 }
            }
        }
    }];
    assert.deepEqual(q.audit('Revenue grew 28.8% a year against a 9.2% peer median, and the 156x P/E is a 293.9% premium to the 39.6x median.', peer), []);
    // The bounded named-peer list is evidence too. AMD's live output supplied
    // Intel at -7.5% and Palantir at 32.6%, but neither value was harvested.
    assert.deepEqual(q.audit('Intel had a -7.5% five-year revenue CAGR while Palantir reached 32.6%.', peer), []);
    assert.match(q.audit('The P/E carries a 42% premium to the peer median.', peer).join(' '), /Percentage claim/);
});

test('a calculator result counts only when every input is itself a supplied figure', () => {
    const results = [
        {
            tool: 'get_financials',
            result: {
                symbol: 'AMD', basis: 'annual (fiscal years)', currency: 'USD',
                observations: [{
                    periodEnd: '2026-06-27', currency: 'USD', fields: {
                        cash: { value: 5000000000, currency: 'USD', unit: 'USD', scope: 'entity', sourceIds: ['0000002488-26-000021'] },
                        longTermDebt: { value: 8058000000, currency: 'USD', unit: 'USD', scope: 'entity', sourceIds: ['0000002488-26-000021'] }
                    }
                }]
            }
        },
        { tool: 'calculator', result: { expression: '5000000000+8058000000', result: 13058000000 } }
    ];
    // A sum the prompt instructs the model to compute is evidence.
    assert.deepEqual(q.audit('Cash and long-term debt together come to $13,058m.', results), []);
    // A remembered figure typed into the calculator is not: its literal matches
    // no supplied fact, so the result stays unclaimable.
    const laundered = structuredClone(results);
    laundered[1].result = { expression: '5000000000+999999999', result: 5999999999 };
    assert.match(q.audit('Cash and long-term debt together come to $5.999bn.', laundered).join(' '), /Monetary claim/);
    // Neither is a scale-invented figure: the millions figure does not match the
    // unscaled facts, so it is refused rather than silently accepted.
    const millions = structuredClone(results);
    millions[1].result = { expression: '5000+8058', result: 13058 };
    assert.match(q.audit('Cash and long-term debt together come to $13,058m.', millions).join(' '), /Monetary claim/);
});

test('a loss written after its amount is the filed negative, not a positive', () => {
    const results = [{
        tool: 'get_financials',
        result: {
            symbol: 'AMD', basis: 'quarterly', currency: 'USD',
            observations: [{ periodEnd: '2025-06-28', currency: 'USD', fields: { operatingIncome: { value: -134000000, currency: 'USD', unit: 'USD', scope: 'entity', sourceIds: ['0000002488-25-000118'] } } }]
        }
    }];
    assert.deepEqual(q.audit('Operating income swung from a $134m loss to a profit.', results), []);
    // The wording "a loss of" was already handled; both spellings must work.
    assert.deepEqual(q.audit('It swung from a loss of $134m to a profit.', results), []);
    // A neighbouring figure is not dragged into the sign by the trailing form.
    assert.match(q.audit('Revenue of $5bn in a year with a $134m loss.', results).join(' '), /Monetary claim/);
    // A dash before the figure with nothing before it is still a sign.
    assert.deepEqual(q.audit('Operating income came in at −$134m.', results), []);
});

test('a dash between two figures is a range, not a sign', () => {
    // get_quote supplies a 52-week range and a range is written with a dash
    // between its ends. That dash was read as a minus, so the high arrived as
    // −645.46 against a supplied +645.4599: the one figure a normal-mode answer
    // cites from the quote made a correct answer fall back. Measured live — it
    // was the only issue in both passes of the bare-AMD probe.
    const results = [
        {
            tool: 'get_financials',
            result: {
                symbol: 'AMD', basis: 'annual (fiscal years)', currency: 'USD',
                observations: [{ periodEnd: '2025-12-27', currency: 'USD', fields: { totalRevenue: { value: 34639000000, currency: 'USD', unit: 'USD', scope: 'entity', sourceIds: ['b10cdf3286d81ca73abd17c6'] } } }]
            }
        },
        { tool: 'get_quote', result: { symbol: 'AMD', currency: 'USD', priceAsOf: '2026-10-02', price: 633.91, week52High: 645.4599, week52Low: 188.22 } }
    ];
    assert.deepEqual(q.audit('Price $633.91, a 52-week range of $188.22–$645.46 — near its high.', results), []);
    // The rounded form of the supplied high is the same fact at coarser precision.
    assert.deepEqual(q.audit('Price $633.91 against a 52-week high of $645.46.', results), []);
});

test('a filing-diff quote is evidence; the tool’s own commentary is not', () => {
    // The quotes are checked character-for-character against the filing, so a
    // figure inside one is filed — and the framework's "how it makes money" and
    // "key risks" sections are written from them. The headline and `what` fields
    // are prose ABOUT the filing and must stay out of evidence.
    const diff = [
        // Claim validation only runs when the answer carries statement
        // observations, so the fixture is the shape a real answer has.
        {
            tool: 'get_financials',
            result: {
                symbol: 'AMD', basis: 'annual (fiscal years)', currency: 'USD',
                observations: [{ periodEnd: '2025-12-27', currency: 'USD', fields: { totalRevenue: { value: 34639000000, currency: 'USD', unit: 'USD', scope: 'entity', sourceIds: ['b10cdf3286d81ca73abd17c6'] } } }]
            }
        },
        {
            tool: 'get_filing_diff',
            result: {
                symbol: 'AMD',
                headline: 'Data Center revenue grew 107% with a 31% Gaming decline.',
                changes: [{
                    area: 'Demand',
                    what: 'Net revenue accelerated to 77% growth.',
                    newQuote: 'Net revenue for the three months ended June 27, 2026 was $11.5 billion, a 50% increase compared to the prior year period. Data Center segment revenue grew 107% year-over-year.',
                    priorQuote: 'Gaming segment revenue declined 31% year-over-year to $779 million.',
                    evidenceVerified: true, figuresVerified: true
                }]
            }
        }
    ];
    assert.deepEqual(q.audit('Net revenue was $11.5bn, up 50%, with Data Center up 107%.', diff), []);
    // The declined figure is claimable in either phrasing, and the level it fell
    // to is not dragged negative by the decline word beside it.
    assert.deepEqual(q.audit('Gaming revenue fell 31% to $779m.', diff), []);
    assert.deepEqual(q.audit('Gaming revenue showed a 31% decline.', diff), []);
    // Commentary the tool wrote itself is not a source.
    assert.match(q.audit('Headline: net revenue grew 77%.', diff).join(' '), /Percentage claim/);
});

test('raw category bars match evidence; millionfold scale and wrong currencies fail', async () => {
    const data = await get('cash');
    const points = [['Operating cash flow', 111482000000], ['Capex', 12715000000], ['Free cash flow', 98767000000]];
    assert.deepEqual(q.audit(spec(points, 'USD', 'bars'), data), []);
    assert.match(q.audit(spec(points.map(([label, value]) => [label, value / 1e6]), 'USD', 'bars'), data).join(' '), /raw unscaled/);
    assert.match(q.audit(spec(points, 'JPY', 'bars'), data).join(' '), /declared unit/);
    assert.match(q.audit(spec(points, 'USD', 'viz'), data).join(' '), /time sequence/);
});

test('chart metric labels and actual dates must match the sourced observation', async () => {
    const data = await get('income');
    const good = spec([['2024-09-28', 391035000000], ['2025-09-27', 416161000000]]);
    assert.deepEqual(q.audit(good, data), []);
    assert.match(q.audit(good.replace('2025-09-27', '2025-09-30'), data).join(' '), /date/);
    assert.match(q.audit(good.replace('Revenue', 'Net income'), data).join(' '), /metric label/);
});

test('chart gaps, zero, unsupported numbers and duplicate labels remain truthful', () => {
    const data = [{ observations: [{ fields: { totalRevenue: { value: 0, unit: 'USD', sourceIds: ['zero'] } } }] }];
    assert.deepEqual(q.audit(spec([['2024', null], ['2025', 0]]), data), []);
    assert.match(q.audit(spec([['2024', 99], ['2025', 0]]), data).join(' '), /no exact supplied source/);
    assert.match(q.audit(spec([['2025', 0], ['2025', 0]]), data).join(' '), /unique/);
    assert.match(q.audit('```viz\n{"unit":"USD"}', data).join(' '), /incomplete/);
});

test('calculated percentages and dimensionless ratios retain their own units', () => {
    const data = [{ observations: [{ periodEnd: '2025-12-31', currency: 'JPY', metrics: {
        netMarginPct: { value: 12.5, sourceIds: ['income', 'revenue'] },
        currentRatio: { value: 1.5, sourceIds: ['assets', 'liabilities'] }
    } }] }];
    assert.deepEqual(q.audit(spec([['2024', null], ['2025-12-31', 12.5]], '%', 'viz', 'Net margin'), data), []);
    assert.deepEqual(q.audit(spec([['2024', null], ['2025-12-31', 1.5]], 'x', 'viz', 'Current ratio'), data), []);
});

test('share-basis suppression cannot be described as absent issuer XBRL', () => {
    const data = [{ coverage: { perShareAllowed: false } }];
    assert.match(q.audit('EPS is not populated in filed XBRL.', data).join(' '), /security\/ADR basis/);
    assert.deepEqual(q.audit('EPS is unavailable because the ADR basis is unverified.', data), []);
});

test('unsupported investment causation fails; explicit unknown causes and retrieved narrative are allowed', () => {
    assert.match(q.audit('Capex rose, likely tied to AI/data-centre investment.', []).join(' '), /supporting retrieved narrative/);
    assert.deepEqual(q.audit('Capex rose; its cause is not established by these cash-flow facts.', []), []);
    assert.deepEqual(q.audit('Capex rose due to AI infrastructure, according to the retrieved filing.', [{ tool: 'fetch_page', result: { text: 'Filing narrative' } }]), []);
});

test('length counts visible prose, not chart JSON/URLs; explicit and detailed requests are respected', () => {
    assert.equal(q.wordCount('[Source](https://example.com/very-long-url) hello ' + spec([['2024', 1], ['2025', 2]])), 2);
    assert.equal(q.wordLimit('Keep it under 150 words.', 'normal'), 150);
    assert.equal(q.wordLimit('A detailed analysis.', 'normal'), 1600);
    // The framework's measured size sets the cap, not the other way round: five
    // live analyst answers ran 348–432 prose words with tables already excluded,
    // so a 350 cap rejected the owner's own target shape on length alone.
    assert.equal(q.wordLimit('AMD', 'analyst'), 1600);
    assert.equal(q.wordLimit('AMD', 'normal'), 1600);
    // The owner requested one firm ceiling, with no preset word target.
    assert.deepEqual(q.audit('word '.repeat(334), [], { mode: 'normal' }), []);
    assert.deepEqual(q.audit('word '.repeat(340), [], { mode: 'normal' }), []);
    // A rich analyst answer inside the raised cap raises no length issue at all.
    assert.deepEqual(q.audit('word '.repeat(430), [], { mode: 'analyst' }), []);
    assert.deepEqual(q.audit('word '.repeat(1600), [], { question: 'AMD', mode: 'normal' }), []);
    assert.match(q.audit('word '.repeat(1601), [], { question: 'AMD' }).join(' '), /1600-word limit/);
    assert.match(q.audit('word '.repeat(101), [], { question: 'AMD under 100 words' }).join(' '), /100-word limit/);
    assert.equal(q.wordLimit('Keep it under 10 words.', 'normal'), 10);
});

test('table rows are data, not prose — bounded separately from the word budget', () => {
    const table = (rows) => 'Summary of the reported periods.\n\n| Metric | FY2024 | FY2025 |\n| --- | --- | --- |\n' +
        Array.from({ length: rows }, (_, i) => `| Metric ${i} | ${i} | ${i + 1} |`).join('\n');
    // Header, separator and body rows all stay out of the prose count.
    assert.equal(q.wordCount(table(3)), 5);
    // 200 prose words is inside the normal-mode budget, so only the row cap can fire.
    const audited = q.audit('word '.repeat(200) + '\n\n' + table(45), [], { mode: 'normal' }).join(' ');
    assert.match(audited, /table rows/);
    assert.doesNotMatch(audited, /250 prose words/);
    // A reference-shaped answer with tables passes the budget it used to fail.
    assert.deepEqual(q.audit(table(6), [], { mode: 'normal' }), []);
});

test('financial chart prose cannot describe line series as bars', async () => {
    const data = await get('income');
    const chart = spec([['2024-09-28', 391035000000], ['2025-09-27', 416161000000]]);
    assert.match(q.audit(chart + '\nEach bar shows reported revenue.', data).join(' '), /line chart/);
});

test('fallback discloses payout coverage and labels instruments without exposing tool instructions', async () => {
    const data = await get('cash');
    data.push({ result: { code: 'UNSUPPORTED_SECURITY_TYPE', symbol: 'HCACU', securityType: 'unit', error: 'Explain the instrument and continue research.' } });
    const text = q.fallback(data, 'Does Apple annual free cash flow cover dividends plus buybacks?');
    assert.match(text, /106\.132bn/); assert.match(text, /shortfall USD 7\.365bn/);
    assert.match(text, /HCACU is a unit/); assert.doesNotMatch(text, /Explain the instrument/);
    assert.match(text, /98\.767bn/);
});

test('valid cash magnitudes and precise deficit calculations are not rejected', async () => {
    const cash = await get('cash');
    assert.deepEqual(q.numericClaims('Distributions exceeded FCF by $7.365bn, a shortfall of 7.5% of FCF. Financing showed a $120.686bn net outflow.', cash), []);
    const negative = [{ observations: [{ fields: { operatingCashflow: { value: -2400000, unit: 'USD', sourceIds: ['fact'] } } }] }];
    assert.deepEqual(q.numericClaims('Operating cash flow was negative $2.4m; operations consumed $2.4m.', negative), []);
});

test('annual comparisons expose capex growth with verified magnitude inputs', async () => {
    const [{ result }] = await get('cash');
    assert.ok(Math.abs(result.comparisons.yoy.metrics.capitalExpenditures.changePct - 34.5929924844) < 1e-8);
    assert.ok(result.comparisons.yoy.metrics.freeCashflow.changePct < -9);
    assert.equal(result.comparisons.yoy.metrics.freeCashflow.current.derivation.formula, 'operatingCashflow - abs(capitalExpenditures)');
    for (const c of Object.values(result.comparisons.yoy.metrics)) for (const id of c.sourceIds) assert.ok(result.provenance.sources[id]);
});

test('upstream synthesis failure preserves successful financial evidence', async () => {
    useFixture(); let count = 0;
    ask.__setDeps({ chatRaw: async () => {
        if (++count === 1) return { tool_calls: [tool('cash', 'cash')] };
        throw new Error('request rejected');
    } });
    const r = await ask.ask({ question: 'Apple free cash flow?', ctx: {} });
    assert.equal(r.source, 'partial'); assert.ok(r.quality.synthesisUnavailable);
    assert.match(r.answer, /98\.767bn/); assert.doesNotMatch(r.answer, /request rejected/);
});

test('actual tool missing fields carry share-basis reasons', async () => {
    const r = await ask.runTool('get_financials', { symbol: 'MUFG', statement: 'income', limit: 1 });
    assert.equal(r.observations[0].fields.eps.value, null);
    assert.match(r.observations[0].fields.eps.missingReason, /ADR basis/);
});

test('failed answer validation gets one rewrite and truthful partial fallback', async () => {
    useFixture(); let calls = 0;
    const bad = 'FY2025 free cash flow comfortably covers dividends and buybacks.';
    ask.__setDeps({ chatRaw: async () => { calls++; return calls === 1 ? { tool_calls: [tool('cash', 'cash')] } : { content: bad }; } });
    const r = await ask.ask({ question: 'Apple annual free cash flow, capex and operating cash flow?', mode: 'normal', ctx: {} });
    assert.equal(calls, 3); assert.equal(r.source, 'partial'); assert.equal(r.quality.fallback, true);
    assert.doesNotMatch(r.answer, /comfortably covers/); assert.match(r.answer, /98\.767bn/);
});

test('rewrite corrects a bad chart; streamed financial output is held until validation', async () => {
    useFixture(); let calls = 0; const events = [];
    const good = spec([['Operating cash flow', 111482000000], ['Free cash flow', 98767000000]], 'USD', 'bars');
    const bad = good.replace('111482000000', '111482').replace('98767000000', '98767');
    const next = async () => { calls++; return calls === 1 ? { tool_calls: [tool('cash', 'cash')] } : { content: calls === 2 ? bad : good }; };
    ask.__setDeps({ chatRaw: next, chatRawStream: async (messages, opts, delta) => { const r = await next(); if (r.content) delta(r.content); return r; } });
    const r = await ask.ask({ question: 'Apple annual operating cash flow and free cash flow chart?', mode: 'normal', ctx: {}, onEvent: e => events.push(e) });
    assert.equal(calls, 3); assert.equal(r.source, 'ai'); assert.equal(r.quality.rewritten, true);
    assert.equal(events.filter(e => e.type === 'delta').length, 1); assert.equal(events.at(-1).text, r.answer);
    assert.ok(!events.some(e => e.type === 'delta' && e.text.includes('111482,')));
});

test('rewrite failures and identity leaks cannot publish rejected content', async () => {
    useFixture(); let calls = 0;
    ask.__setDeps({ chatRaw: async () => {
        calls++;
        if (calls === 1) return { tool_calls: [tool('cash', 'cash')] };
        if (calls === 2) return { content: 'FY2025 free cash flow covers dividends and buybacks.' };
        throw new Error('upstream failure');
    } });
    const r = await ask.ask({ question: 'Apple free cash flow?', ctx: {} });
    assert.equal(r.source, 'partial'); assert.ok(r.quality.fallback); assert.doesNotMatch(r.answer, /upstream failure/);
});

test('mobile financial charts abbreviate axes, adapt viewBox and provide accessible dates', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../../frontend-v2/assets/app.js'), 'utf8');
    const code = source.slice(source.indexOf('    function chart('), source.indexOf('    // A completed answer'));
    const box = { num: v => v == null ? null : Number(v), money: v => Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : String(v), fixed: (v, dp) => Number(v).toFixed(dp), esc: v => String(v), document: { documentElement: { clientWidth: 390 }, querySelector: () => ({ clientWidth: 342 }) } };
    vm.runInNewContext(code + '\nthis.render = vizBlock; this.bars = barsBlock;', box);
    const html = box.render(JSON.stringify({ unit: 'USD', series: [{ name: 'Revenue', points: [['2024-09-28', 391035000000], ['2025-09-27', 416161000000]] }] }));
    assert.match(html, /viewBox="0 0 310 260"/); assert.match(html, /font-size="12"/);
    assert.match(html, /USD 400.0B/); assert.match(html, /<desc>Revenue: 2024-09-28/);
    assert.doesNotMatch(html, />400,000,000,000</);
    const annual = box.render(JSON.stringify({ unit: 'JPY', series: [{ name: 'Revenue', points: [['FY ended 31 Mar 2025', 10e12], ['FY ended 31 Mar 2026', 11e12]] }] }));
    assert.match(annual, />FY2025<\/text>/); assert.match(annual, />FY2026<\/text>/);
    assert.doesNotMatch(annual, />FY ended 31 Mar 2025<\/text>/);
    const bars = box.bars(JSON.stringify({ unit: 'USD', rows: [['Zero', 0], ['Outflow', -5]] }));
    assert.match(bars, /width:0.0%/); assert.match(bars, /is-negative/);
});

test('requested revenue, net income and SBC use period-matched grouped bars', async () => {
    const income = await get('income'), cash = await get('cash');
    const grouped = {
        title: 'Revenue, net income and share-based compensation', unit: 'USD', orientation: 'vertical', facet: true,
        series: [
            { name: 'Revenue', points: [['2024-09-28', 391035000000], ['2025-09-27', 416161000000]] },
            { name: 'Net income', points: [['2024-09-28', 93736000000], ['2025-09-27', 112010000000]] },
            { name: 'Share-based compensation', points: [['2024-09-28', 11688000000], ['2025-09-27', 12863000000]] }
        ]
    };
    const answer = '```bars\n' + JSON.stringify(grouped) + '\n```';
    assert.deepEqual(q.audit(answer, [...income, ...cash], { question: 'Compare revenue, net profit and share-based compensation' }), []);
    grouped.series[2].points[1][1] = 12863000000 + 100000000;
    assert.match(q.audit('```bars\n' + JSON.stringify(grouped) + '\n```', [...income, ...cash], { question: 'Compare revenue, net profit and share-based compensation' }).join(' '), /exact supplied source/);
    grouped.series[2].points[1][1] = 12863000000;
    grouped.series.pop();
    assert.match(q.audit('```bars\n' + JSON.stringify(grouped) + '\n```', [...income, ...cash], { question: 'Compare revenue, net profit and share-based compensation' }).join(' '), /must include/);
    const reversed = structuredClone(grouped);
    reversed.series.push({ name: 'Share-based compensation', points: [['2025-09-27', 12863000000], ['2024-09-28', 11688000000]] });
    reversed.series.forEach(s => s.points.reverse());
    assert.match(q.audit('```bars\n' + JSON.stringify(reversed) + '\n```', [...income, ...cash], { question: 'Compare revenue, net profit and share-based compensation' }).join(' '), /oldest to newest/);
});

test('a grouped chart spanning more than 10x demands facets, and faceting discharges it', async () => {
    const income = await get('income'), cash = await get('cash');
    const facts = [...income, ...cash];
    const question = 'Compare revenue and share-based compensation';
    const spec = {
        title: 'Revenue and share-based compensation', unit: 'USD', orientation: 'vertical',
        series: [
            { name: 'Revenue', points: [['2025-09-27', 416161000000]] },
            { name: 'Share-based compensation', points: [['2025-09-27', 12863000000]] }
        ]
    };
    const bar = (s) => '```bars\n' + JSON.stringify(s) + '\n```';
    const issue = q.audit(bar(spec), facts, { question }).join(' ');
    assert.match(issue, /span 32x/);
    assert.match(issue, /"facet": true/);
    // Faceting is the remedy, so the faceted chart is accepted outright.
    assert.deepEqual(q.audit(bar({ ...spec, facet: true }), facts, { question }), []);
    // The model has returned this otherwise-valid time series using a viz
    // fence with facet:true, which the renderer ignores. Normalize the chart
    // fence and type without changing any evidence point.
    const facetedViz = '```viz\n' + JSON.stringify({ ...spec, orientation: 'vertical', facet: true, series: [
        { name: 'Revenue', points: [['2024-09-28', 391035000000], ['2025-09-27', 416161000000]] },
        { name: 'Share-based compensation', points: [['2024-09-28', 11688000000], ['2025-09-27', 12863000000]] }
    ] }) + '\n```';
    const normalized = q.normalizeFacetedViz(facetedViz);
    assert.match(normalized, /^```bars\n/);
    assert.deepEqual(q.audit(normalized, facts, { question }), []);
    // Comparable magnitudes stay on one axis: faceting is allowed, never required.
    const narrow = { ...spec, series: [
        { name: 'Revenue', points: [['2025-09-27', 416161000000]] },
        { name: 'Net income', points: [['2025-09-27', 112010000000]] }
    ] };
    assert.deepEqual(q.audit(bar(narrow), facts, { question: 'Compare revenue and net income' }), []);
    // A facet value that is neither absent nor true is a silent no-op in the renderer.
    assert.match(q.audit(bar({ ...spec, facet: false }), facts, { question }).join(' '), /takes only true/);
});

test('validated fallback keeps available SBC, actual periods and grouped bar output', async () => {
    const income = await get('income'), cash = await get('cash');
    const question = 'Compare Apple revenue, net income and share-based compensation for the latest three annual periods.';
    const text = q.fallback([...income, ...cash], question);
    assert.match(text, /partial answer using verified SEC evidence/);
    assert.match(text, /Only 2 comparable annual periods/);
    assert.match(text, /```bars/);
    assert.match(text, /Share-based compensation/);
    assert.match(text, /2024-09-28/);
    assert.deepEqual(q.audit(text, [...income, ...cash], { question }), []);
    const noSbc = structuredClone(cash);
    for (const row of noSbc[0].result.observations) {
        row.fields.shareBasedCompensation.value = null;
        row.fields.shareBasedCompensation.sourceIds = [];
        row.fields.shareBasedCompensation.missingReason = 'Not available in verified filing facts.';
    }
    const sparse = q.fallback([...income, ...noSbc], question);
    const bars = JSON.parse(sparse.match(/```bars\s*\n([\s\S]*?)\n```/)[1]);
    assert.ok(bars.series.find(s => /share-based/i.test(s.name)).points.every(([, value]) => value === null));
    assert.match(sparse, /share-based compensation.*unavailable|unavailable.*share-based compensation/i);
});

test('Sankey is allowed only when native segment values reconcile to revenue from that same annual SEC filing', () => {
    const accessionNumber = '0000000123-25-000001';
    const sourceUrl = 'https://www.sec.gov/Archives/edgar/data/123/000000012325000001/report.htm';
    let segment = {
        cik: '0000000123', periodEnd: '2025-12-31', currency: 'EUR', filing: { form: '10-K', date: '2026-02-15', accessionNumber, url: sourceUrl },
        segments: [{ name: 'Cloud', value: 65, currency: 'EUR' }, { name: 'Devices', value: 35, currency: 'EUR' }]
    };
    const income = {
        tool: 'get_financials', result: { statement: 'income', basis: 'annual (fiscal years)', currency: 'EUR',
            observations: [{ periodEnd: '2025-12-31', currency: 'EUR', fields: { totalRevenue: { value: 100, unit: 'EUR', sourceIds: ['annual-revenue'] } } }],
            provenance: { sources: { 'annual-revenue': { type: 'sec_xbrl_fact', cik: '0000000123', form: '10-K', filingDate: '2026-02-15', accessionNumber, periodEnd: '2025-12-31', unit: 'EUR' } } }
        }
    };
    segment = withLiteralSegmentProof(segment, income.result);
    const segmentResult = { tool: 'get_segments', result: segment };
    const evidence = q.verifiedSegmentEvidence([segmentResult, income]);
    assert.equal(evidence.status, 'eligible');
    assert.equal(evidence.currency, 'EUR');
    assert.equal(evidence.unallocated, 0);
    const chart = {
        title: 'Revenue by segment', unit: evidence.currency, periodEnd: evidence.periodEnd, filingDate: evidence.filingDate,
        accessionNumber, sourceUrl, total: evidence.totalRevenue, unallocated: evidence.unallocated,
        segments: evidence.segments
    };
    assert.deepEqual(q.audit('```sankey\n' + JSON.stringify(chart) + '\n```', [segmentResult, income]), []);
    const fallback = q.fallback([segmentResult, income], 'Show the business segment revenue mix.');
    assert.match(fallback, /```sankey/);
    assert.deepEqual(q.audit(fallback, [segmentResult, income]), []);
    chart.segments[0].value++;
    assert.match(q.audit('```sankey\n' + JSON.stringify(chart) + '\n```', [segmentResult, income]).join(' '), /match the retrieved SEC segment evidence/);
    segment.segments[1].revenueUsd = 30;
    segment.segments[1].value = 30;
    assert.equal(q.segmentEvidence(segment, income.result).status, 'unverified');
    segment.filing.accessionNumber = '0000000123-25-000002';
    assert.equal(q.segmentEvidence(segment, income.result).status, 'unverified');
    const legacy = { ...segment, filing: { form: '10-K', date: '2026-02-15', accessionNumber, url: sourceUrl }, segments: [{ name: 'Cloud', revenueUsd: 65 }, { name: 'Devices', revenueUsd: 35 }] };
    assert.equal(q.segmentEvidence(legacy, income.result).status, 'unverified', 'legacy revenueUsd cache values cannot authorize an Ask Sankey');
});

test('native segment reconciliation is generic across industries, currencies and fiscal year ends', () => {
    const cases = [
        ['JPM', 'bank', 'USD', '2025-12-31'], ['PGR', 'insurer', 'USD', '2025-12-31'],
        ['O', 'REIT', 'USD', '2025-12-31'], ['CAT', 'industrial', 'USD', '2025-12-31'],
        ['REGN', 'biotech', 'USD', '2025-12-31'], ['BABA', 'ADR', 'CNY', '2025-03-31']
    ];
    for (const [symbol, industry, currency, periodEnd] of cases) {
        const digits = String(cases.indexOf(cases.find(row => row[0] === symbol)) + 501).padStart(10, '0');
        const accessionNumber = `${digits.slice(0, 10)}-26-${String(symbol.charCodeAt(0)).padStart(6, '0')}`;
        const filingDate = '2026-05-01', url = `https://www.sec.gov/Archives/edgar/data/${Number(digits)}/${accessionNumber.replace(/-/g, '')}/report.htm`;
        let segment = { symbol, cik: digits, periodEnd, currency, filing: { form: industry === 'ADR' ? '20-F' : '10-K', date: filingDate, accessionNumber, url },
            segments: [{ name: 'Segment A', value: 60, currency }, { name: 'Segment B', value: 39, currency }] };
        const sourceId = `${symbol}-revenue`;
        const income = { statement: 'income', basis: 'annual', observations: [{ periodEnd, currency, fields: { totalRevenue: { value: 100, sourceIds: [sourceId] } } }],
            provenance: { sources: { [sourceId]: { type: 'sec_xbrl_fact', cik: digits, form: segment.filing.form, filingDate, accessionNumber, periodEnd, unit: currency } } } };
        segment = withLiteralSegmentProof(segment, income);
        const result = q.segmentEvidence(segment, income);
        assert.equal(result.status, 'eligible', `${symbol} (${industry}) should use generic native-currency matching`);
        assert.equal(result.currency, currency);
        assert.equal(result.unallocated, 1);
    }
});

test('Ask native segment cache parser requires exact quoted amounts, explicit scale and ISO currency', () => {
    const extractor = require('../ask-segments');
    const filing = { form: '20-F', date: '2026-05-01', accession: '0000000501-26-000065', url: 'https://www.sec.gov/Archives/edgar/data/501/000000050126000065/report.htm' };
    const parsed = { periodEnd: '2025-03-31', basisExcerpt: 'Revenue in EUR millions.', periodExcerpt: 'Year ended March 31, 2025.', segments: [
        { name: 'Cloud', reportedValue: 42, scale: 1e6, currency: 'EUR', value: 42e6, sourceExcerpt: 'Cloud revenue EUR 42 million' },
        { name: 'Hardware', reportedValue: 58, scale: 1e6, currency: 'EUR', value: 58e6, sourceExcerpt: 'Hardware revenue EUR 58 million' }
    ] };
    const anchor = { periodEnd: parsed.periodEnd, currency: 'EUR', value: 100e6, sourceId: 'revenue', source: { rawValue: 100e6, unit: 'EUR' } };
    const context = { anchor, text: [parsed.basisExcerpt, parsed.periodExcerpt, ...parsed.segments.map(s => s.sourceExcerpt)].join(' ') };
    const good = extractor.normalizeResult(parsed, 'BABA', '0000000501', filing, context);
    assert.equal(good.currency, 'EUR'); assert.equal(good.periodEnd, '2025-03-31'); assert.equal(good.segments[0].value, 42e6);
    assert.equal(extractor.validCachedPayload(good, '0000000501', filing, anchor), true);
    assert.equal(extractor.validCachedPayload(good, '0000000502', filing, anchor), false);
    assert.equal(extractor.normalizeResult({ ...parsed, segments: parsed.segments.map(s => ({ ...s, sourceExcerpt: 'segment revenue not shown' })) }, 'BABA', '0000000501', filing, context), null);
    assert.equal(extractor.normalizeResult({ ...parsed, segments: parsed.segments.map(s => ({ ...s, scale: 1e4 })) }, 'BABA', '0000000501', filing, context), null);
    assert.equal(extractor.normalizeResult({ ...parsed, segments: parsed.segments.slice(0, 1) }, 'BABA', '0000000501', filing, context), null);
    assert.equal(extractor.normalizeResult({ ...parsed, segments: [{ ...parsed.segments[0] }, { ...parsed.segments[0], reportedValue: 58, value: 58e6, sourceExcerpt: 'Cloud revenue EUR 58 million' }] }, 'BABA', '0000000501', filing, context), null);
});

test('directory routing covers every stock listing and rejects units and rights without refresh', async () => {
    const universe = require('../stock-universe');
    const listings = universe.companies();
    const stocks = listings.filter(x => x.securityType === 'stock');
    const instruments = listings.filter(x => ['unit', 'right'].includes(x.securityType));
    assert.equal(stocks.length,require('../../frontend/data/stock-universe-manifest.json').counts.stockListings);
    const types=require('../../frontend/data/stock-universe-manifest.json').counts.retainedInstrumentsByType;
    assert.equal(instruments.length,(types.unit || 0)+(types.right || 0));
    for (const listing of stocks) {
        assert.equal(universe.lookup(listing.symbol)?.symbol, listing.symbol);
        assert.equal(universe.lookup(listing.symbol)?.securityType, 'stock');
    }
    for (const listing of instruments) {
        assert.equal(universe.lookup(listing.symbol)?.securityType, listing.securityType);
        const response = await ask.runTool('get_segments', { symbol: listing.symbol });
        assert.equal(response.code, 'UNSUPPORTED_SECURITY_TYPE');
    }
});

test('SPV and off-balance-sheet claims require fetched issuer-filing evidence and reject inferred intent', () => {
    const filing = [{ tool: 'fetch_page', result: { url: 'https://www.sec.gov/Archives/edgar/data/1/filing.htm', text: 'The filing discusses a variable interest entity and guarantees.' } }];
    assert.match(q.audit('The company uses an SPV to keep debt off the books.', filing).join(' '), /Do not infer an intent/);
    assert.match(q.audit('The company keeps obligations off-balance-sheet.', []).join(' '), /require retrieved text/);
    assert.deepEqual(q.audit('The filing discusses an unconsolidated entity; it does not establish that the issuer hides debt.', filing), []);
    assert.match(q.audit('The issuer says the filing addresses accounting.', [], { question: 'Does Meta use SPVs to keep debt off its books?' }).join(' '), /needs a searched SEC filing/);
    const candidate = [{ tool: 'search_filings', result: { results: [{ url: filing[0].result.url, candidateOnly: true }] } }];
    assert.equal(q.issuerDisclosureEvidence([...candidate, filing[0]]), true);
    assert.equal(q.issuerDisclosureEvidence([...candidate, { ...filing[0], result: { ...filing[0].result, note: 'Keyword "off-balance sheet" not found in the document.' } }]), false);
    assert.equal(q.issuerDisclosureEvidence([...candidate, { ...filing[0], result: { ...filing[0].result, text: 'The issuer has lease obligations and guarantees.' } }]), false);
    const searchUrl = 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm';
    assert.deepEqual(evidence.filingLinks({ results: [{ url: searchUrl, form: '10-K', filed: '2026-01-29' }] }), [
        { url: searchUrl, label: 'SEC 10-K filed 2026-01-29' }
    ]);
    assert.deepEqual(evidence.filingLinks({ ticker: 'META', results: [
        { url: searchUrl, form: '10-K', filed: '2026-01-29', confirmedLatest: true },
        { url: 'https://www.sec.gov/Archives/edgar/data/1/older.htm', form: '10-K', filed: '2020-01-30' }
    ] }), [{ url: searchUrl, label: 'META 10-K filed 2026-01-29' }]);
});

test('SEC full-text outage falls back to latest ticker-specific filing candidates, not fake keyword matches', async () => {
    axios.get = async () => { throw Object.assign(new Error('server error'), { response: { status: 500 } }); };
    secSource.cikFor = async symbol => symbol === 'META' ? '0001326801' : null;
    watchdog.fetchRecentFilings = async (symbol, forms, count) => {
        assert.equal(symbol, 'META'); assert.ok(forms.has('10-K')); assert.equal(count, 3);
        return [{ form: '10-K', date: '2026-01-29', url: 'https://www.sec.gov/Archives/edgar/data/1326801/000162828026003942/meta-20251231.htm' }];
    };
    const result = await ask.toolSearchFilings({ query: 'off-balance-sheet arrangements', ticker: 'META', forms: '10-K', limit: 3 });
    assert.equal(result.totalMatches, null);
    assert.equal(result.results[0].candidateOnly, true);
    assert.equal(result.results[0].confirmedLatest, true);
    assert.match(result.note, /not keyword matches/);
    assert.doesNotMatch(JSON.stringify(result.results), /off-balance-sheet/);
});

test('filing obligation amounts are grounded to their disclosed category', () => {
    const url = 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm';
    const results = [
        { tool: 'search_filings', result: { results: [{ url, form: '10-K', filed: '2026-01-29', periodEnding: '2025-12-31' }] } },
        { tool: 'fetch_page', result: { url, text: 'All amounts are in USD. We have no off-balance-sheet arrangements. In addition to lease liabilities in our consolidated balance sheets, we have leases that have not yet commenced, with total lease obligations of approximately $103.77 billion as of December 31, 2025.' } },
        { tool: 'fetch_page', result: { url, text: 'As of December 31, 2025, we had guarantees of USD 2 billion.' } }
    ];
    assert.deepEqual(q.numericClaims('The 10-K separately discloses $103.77 billion of lease obligations for leases not yet commenced.', results), []);
    assert.match(q.numericClaims('The company has $103.77 billion of off-balance debt.', results).join(' '), /is not a figure any tool result supplies/);
    assert.match(q.numericClaims('The SPV has $103.77 billion of debt.', results, 'Does the company have SPVs and off-balance-sheet exposures?').join(' '), /is not a figure any tool result supplies/);
    assert.equal(q.filingNarrativeEvidence(results)[0].category, 'lease_obligation');
    assert.equal(q.filingNarrativeEvidence(results)[0].periodEnd, '2025-12-31');
    const undated = q.filingNarrativeEvidence([
        results[0], { tool: 'fetch_page', result: { url, text: 'Lease obligations were USD 5 billion.' } }
    ]);
    assert.equal(undated[0].periodEnd, null);
    const fallback = q.fallback(results, 'Check SPVs and off-balance-sheet obligations in this issuer 10-K.');
    assert.doesNotMatch(fallback.replace(/```[\s\S]*?```/g, ''), /103\.77bn/, 'plotted amounts are not repeated in prose');
    assert.match(fallback, /not summed/);
    assert.match(fallback, /does not quantify a separate unconsolidated-entity or securitization exposure/);
    assert.match(fallback, /Separately disclosed amounts/);
    assert.match(fallback, /\[\["Leases not yet commenced · as of 2025-12-31",103770000000\],\["Guarantees · as of 2025-12-31",2000000000\]\]/);
    assert.deepEqual(q.audit(fallback, results, { question: 'Check SPVs and off-balance-sheet obligations in this issuer 10-K.' }), []);
    assert.equal(q.disclosureCategory('The unconsolidated entity has $80 million of debt'), 'entity_or_securitization_exposure');
    const noGuaranteeAmount = q.fallback([
        results[0], results[1], { tool: 'fetch_page', result: { url, text: 'We provide guarantees to certain vendors under the terms of their contracts.' } }
    ], 'Check guarantees in this issuer 10-K.');
    assert.match(noGuaranteeAmount, /Guarantees are mentioned in the retrieved excerpt, but I could not verify an amount with its own explicit scale, currency and period/);
    assert.match(noGuaranteeAmount, /does not establish that the full filing contains no such amount/);
});

test('filing amount classification follows its own sentence and nearest obligation label', () => {
    const url = 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm';
    const results = [
        { tool: 'search_filings', result: { results: [{ url, form: '10-K', filed: '2026-01-29' }] } },
        { tool: 'fetch_page', result: { url, text: 'All amounts are in USD. Lease obligations are described in Note 6. We also have $131.05 billion of contractual commitments as of December 31, 2025. Investments of $30.63 billion were due in 2026. Long-term debt is described below.' } }
    ];
    const facts = q.filingNarrativeEvidence(results);
    assert.deepEqual(facts.map(({ category, value, periodEnd }) => ({ category, value, periodEnd })), [
        { category: 'commitment', value: 131050000000, periodEnd: '2025-12-31' }
    ]);
    const exposure = q.filingNarrativeEvidence([
        results[0], { tool: 'fetch_page', result: { url, text: 'All amounts are in USD. Our maximum exposure to loss related to the Venture was $45.95 billion as of December 31, 2025, consisting of $1.83 billion carrying value of our equity investment, the lease commitments, and our estimated future fundings.' } }
    ]);
    assert.deepEqual(exposure.map(({ category, value }) => ({ category, value })), [
        { category: 'entity_or_securitization_exposure', value: 45950000000 }
    ]);
    const distinctExposures = q.fallback([
        results[0],
        { tool: 'fetch_page', result: { url, text: 'All amounts are in USD. Our maximum exposure to loss related to the Venture was $45.95 billion as of December 31, 2025, consisting of $1.83 billion carrying value of our equity investment, the lease commitments, and our estimated future fundings.' } },
        { tool: 'fetch_page', result: { url, text: 'As of December 31, 2025, total maximum exposure to loss in these other VIEs was $5.58 billion, equal to our investments.' } },
        { tool: 'fetch_page', result: { url, text: 'We have total lease obligations of approximately $103.77 billion as of December 31, 2025.' } }
    ], 'Compare the unconsolidated-entity exposure and leases in this 10-K.');
    assert.doesNotMatch(distinctExposures.replace(/```[\s\S]*?```/g, ''), /USD 45\.95bn|USD 5\.58bn/, 'a chart replaces duplicated amount bullets');
    assert.match(distinctExposures, /\[\["Venture maximum exposure to loss · as of 2025-12-31",45950000000\],\["Other VIE maximum exposure to loss · as of 2025-12-31",5580000000\]/);
});

test('Ask renders grouped vertical bars, horizontal negative bars and a reconciled Sankey accessibly', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../../frontend-v2/assets/app.js'), 'utf8');
    const code = source.slice(source.indexOf('    function chart('), source.indexOf('    // A completed answer'));
    const box = { num: v => v == null || v === '' ? null : Number(v), money: v => String(v), fixed: (v, dp) => Number(v).toFixed(dp),
        esc: v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        document: { documentElement: { clientWidth: 390 }, querySelector: () => ({ clientWidth: 342 }) } };
    vm.runInNewContext(code + '\nthis.bars=barsBlock; this.sankey=sankeyBlock;', box);
    const grouped = box.bars(JSON.stringify({ title: 'Revenue and profit', unit: 'USD', orientation: 'vertical', series: [
        { name: 'Revenue', points: [['2024-09-28', 100], ['2025-09-27', 120]] },
        { name: 'Net income', points: [['2024-09-28', -5], ['2025-09-27', 10]] }
    ] }));
    assert.match(grouped, /role="img"/); assert.match(grouped, /ask-zero/); assert.match(grouped, /Revenue, 2025-09-27: USD 120/);
    assert.match(grouped, /FY2025/); assert.match(grouped, /Net income/);
    const gaps = box.bars(JSON.stringify({ unit: 'USD', orientation: 'vertical', series: [
        { name: 'Revenue', points: [['2024-12-31', 100], ['2025-12-31', 120]] },
        { name: 'Net income', points: [['2024-12-31', 10], ['2025-12-31', 12]] },
        { name: 'Share-based compensation', points: [['2024-12-31', null], ['2025-12-31', null]] }
    ] }));
    assert.match(gaps, /Share-based compensation, 2025-12-31: unavailable/); assert.doesNotMatch(gaps, /<title>Share-based compensation, 202[45]-12-31:/);
    const single = box.bars(JSON.stringify({ unit: 'EUR', orientation: 'vertical', series: [
        { name: 'Revenue', points: [['2025-03-31', 0]] },
        { name: 'Net income', points: [['2025-03-31', null]] },
        { name: 'Share-based compensation', points: [['2025-03-31', null]] }
    ] }));
    assert.match(single, /ask-bar-svg/); assert.match(single, /Revenue, 2025-03-31: EUR 0/);
    assert.match(single, /Net income, 2025-03-31: unavailable/); assert.equal((single.match(/<rect /g) || []).length, 1);
    const dense = box.bars(JSON.stringify({ unit: 'USD', orientation: 'vertical', series: [
        { name: 'Revenue', points: [['2024-12-31', 100], ['2025-12-31', 120]] },
        { name: 'Net income', points: [['2024-12-31', 10], ['2025-12-31', 12]] },
        { name: 'Share-based compensation', points: [['2024-12-31', 2], ['2025-12-31', 3]] }
    ] }));
    for (const match of dense.matchAll(/<rect x="([\d.]+)"[^>]+width="([\d.]+)"/g)) assert.ok(Number(match[1]) + Number(match[2]) <= 296.1, 'every bar stays inside the mobile plot');
    const dates = Array.from({ length: 8 }, (_, i) => `${2018+i}-03-31`);
    const history = box.bars(JSON.stringify({ unit: 'USD', orientation: 'vertical', series: [
        { name: 'Revenue', points: dates.map((d,i) => [d,100+i]) },
        { name: 'Net income', points: dates.map((d,i) => [d,i-2]) }
    ] }));
    assert.ok((history.match(/class="ask-period"/g) || []).length <= 3, 'mobile period labels stay sparse');
    assert.equal((history.match(/<rect /g) || []).length, 16, 'label thinning preserves all observations');
    assert.match(history, /Net income, 2021-03-31: USD 1/);
    const horizontal = box.bars(JSON.stringify({ unit: 'USD', rows: [['Net loss', -5], ['Cash flow', 0], ['Revenue', 10]] }));
    assert.match(horizontal, /ask-hbar-track is-mixed/); assert.match(horizontal, /left:50.0%;width:50.0%/); assert.match(horizontal, /Zero-based scale/i);
    const sankey = box.sankey(JSON.stringify({ title: 'Revenue by segment', unit: 'EUR', periodEnd: '2025-09-27', filingDate: '2025-10-31', accessionNumber: '000000000000000001',
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm', total: 100, unallocated: 10,
        segments: [{ name: 'Cloud', value: 60 }, { name: 'Devices', value: 30 }] }));
    assert.match(sankey, /ask-sankey-svg/); assert.match(sankey, /Cloud/); assert.match(sankey, /Unallocated \/ eliminations/); assert.match(sankey, /SEC annual filing/); assert.match(sankey, /EUR 100/);
    const thinSpec = { unit: 'EUR', periodEnd: '2025-12-31', filingDate: '2026-02-15', accessionNumber: '000000000000000001',
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm', total: 100, unallocated: 1,
        segments: [{ name: 'Main segment', value: 98 }, { name: 'Small segment', value: 1 }] };
    const thin = box.sankey(JSON.stringify(thinSpec));
    assert.match(thin, /ask-sankey-svg/); assert.match(thin, /Small segment/); assert.match(thin, /Unallocated \/ eliminations/);
    assert.equal((thin.match(/<path /g) || []).length, 3, 'thin flows retain their true values');
    assert.equal(box.sankey(JSON.stringify({ ...thinSpec, unallocated: null })), '');
    assert.equal(box.sankey(JSON.stringify({ unit: 'USD', periodEnd: '2025-09-27', filingDate: '2025-10-31', accessionNumber: '000000000000000001', total: 100, unallocated: 0, segments: [{ name: 'Only', value: 100 }] })), '');
});

test('faceted bars give each wide-spread metric its own panel, scaled and labelled', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../../frontend-v2/assets/app.js'), 'utf8');
    const code = source.slice(source.indexOf('    function chart('), source.indexOf('    // A completed answer'));
    const load = (clientWidth) => {
        const box = { num: v => v == null || v === '' ? null : Number(v), money: v => String(v), fixed: (v, dp) => Number(v).toFixed(dp),
            esc: v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
            document: { documentElement: { clientWidth }, querySelector: () => ({ clientWidth: clientWidth - 48 }) } };
        vm.runInNewContext(code + '\nthis.bars=barsBlock;', box);
        return box;
    };
    // AMD's real annual figures: revenue is 21x share-based compensation, the
    // measured case a shared axis renders as a hairline.
    const spec = { title: 'AMD annual', unit: 'USD', orientation: 'vertical', facet: true, series: [
        { name: 'Revenue', points: [['2023-12-30', 22680000000], ['2024-12-28', 25785000000], ['2025-12-27', 34639000000]] },
        { name: 'Net income', points: [['2023-12-30', 854000000], ['2024-12-28', 1641000000], ['2025-12-27', 4335000000]] },
        { name: 'Share-based compensation', points: [['2023-12-30', 1384000000], ['2024-12-28', 1419000000], ['2025-12-27', 1638000000]] }
    ] };
    const facet = load(390).bars(JSON.stringify(spec));
    assert.match(facet, /ask-bars-facet/);
    assert.equal((facet.match(/ask-facet-row/g) || []).length, 3, 'one panel per metric');
    assert.equal((facet.match(/<rect /g) || []).length, 9, 'every observation is drawn');
    assert.equal((facet.match(/class="ask-bar-value"/g) || []).length, 9, 'every bar is labelled — this is what replaces the shared axis');
    assert.match(facet, /not comparable between panels/);
    assert.match(facet, /fill="var\(--chart-1\)"/); assert.match(facet, /fill="var\(--chart-3\)"/);
    assert.match(facet, /FY2025 · USD 34\.6B/);
    assert.match(facet, /\+52\.7% FY2023→FY2025/, 'first-to-last change is stated with its window');
    assert.equal((facet.match(/<span>FY20\d\d/g) || []).length, 3, 'every period keeps its label at phone width');
    assert.match(facet, /Revenue, 2023-12-30: USD 22\.7B/);
    // A panel must never truncate its baseline: each is scaled from zero.
    const panel = facet.slice(facet.indexOf('ask-facet-row'));
    assert.ok(panel.includes('class="ask-zero"'), 'each panel draws its own zero line');
    // Faceting is opt-in: the same data on a shared axis keeps the old form.
    const shared = load(390).bars(JSON.stringify({ ...spec, facet: undefined }));
    assert.doesNotMatch(shared, /ask-facet-row/);
    // Three series on a shared axis label their bars once the bars are wide
    // enough to carry a value, instead of assuming a third series never fits.
    assert.equal((load(1440).bars(JSON.stringify({ ...spec, facet: undefined })).match(/class="ask-bar-value"/g) || []).length, 9, 'desktop bars print their values');
    assert.equal((shared.match(/class="ask-bar-value"/g) || []).length, 0, 'phone-width bars stay clean');
});

test('mixed entity and lease research retains sourced leases and explains missing entity evidence', () => {
    const url = 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm';
    const results = [
        { tool: 'search_filings', result: { results: [{ url, form: '10-K', filed: '2026-01-29' }] } },
        { tool: 'fetch_page', result: { url, text: 'All amounts are in USD. Lease obligations were $2 billion as of December 31, 2025. Guarantees were USD 400 million as of December 31, 2025.' } }
    ];
    const question = 'Inspect SPVs, VIEs, guarantees and leases in the annual filing.';
    assert.equal(q.issuerDisclosureEvidence(results, question), true);
    const answer = q.fallback(results, question);
    assert.match(answer, /does not quantify a separate unconsolidated-entity/);
    assert.match(answer, /orientation.*horizontal/);
    assert.doesNotMatch(answer, /SEC filing research is unavailable/);
    assert.equal(q.issuerDisclosureEvidence(results, 'Inspect SPVs in the annual filing.'), false);
});


test('the receipt tolerates every tool-result shape, including results with no statement fields', () => {
    // The receipt is the terminal state the pipeline promises is always
    // answerable, and both of its call sites sit inside failure handlers. So a
    // shape it cannot parse does not degrade the answer — it destroys it.
    // Measured 2026-10-04: get_ratios_history returns observations of
    // {periodEnd, currency, metrics} with no `fields` at all, `field in undefined`
    // threw at the receipt's field loop, and because the receipt is built *inside*
    // the catch that was meant to survive it, every analyst answer whose research
    // included the ratios tool returned no answer at all instead of a receipt.
    const ratios = {
        tool: 'get_ratios_history',
        result: {
            symbol: 'AMD', units: 'USD', statement: undefined,
            observations: [{
                periodEnd: '2025-12-27', currency: 'USD',
                metrics: { grossMarginPct: { value: 49.51 }, netMarginPct: { value: 12.5 } }
            }]
        }
    };
    const shapes = [
        [ratios],
        [{ tool: 'get_financials', result: { symbol: 'AMD', statement: 'cash', observations: [{ periodEnd: '2025-12-27', currency: 'USD' }] } }],
        [{ tool: 'get_quote', result: { error: 'unavailable', code: 'VERIFIED_FINANCIALS_UNAVAILABLE' } }],
        []
    ];
    for (const results of shapes) {
        const answer = q.fallback(results, 'How is AMD doing?');
        assert.equal(typeof answer, 'string');
        assert.ok(answer.length > 0, 'the receipt is never empty');
        // A receipt that its own audit rejects would be replaced by another
        // receipt on the next pass — the reason it may never throw in the first place.
        assert.deepEqual(q.audit(answer, results, { question: 'How is AMD doing?', mode: 'analyst' }), []);
    }
    // The ratios observation contributes no statement rows rather than a crash.
    assert.match(q.fallback([ratios], 'How is AMD doing?'), /partial answer using verified SEC evidence/);
});

test('filing currency can be established from consistent core inline XBRL with literal receipts', () => {
    const currency = require('../ask-filing-currency');
    const unit = '<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>';
    const html = unit + ['Revenues','NetIncomeLoss','Assets'].map(name => `<ix:nonFraction name="us-gaap:${name}" unitRef="usd" contextRef="fy">100</ix:nonFraction>`).join('');
    const receipt = currency.inlineCurrency(html);
    assert.equal(receipt.currency, 'USD');
    const url = 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm';
    const page = {url, currencyEvidence:{...receipt,sourceUrl:url},text:'Lease obligations were $2 billion as of December 31, 2025.'};
    assert.equal(currency.filingBasis([],page), 'USD');
    assert.equal(currency.filingBasis([],{...page,currencyEvidence:{...page.currencyEvidence,currency:'CAD'}}),null);
    assert.equal(currency.inlineCurrency(unit + '<ix:nonFraction name="us-gaap:Assets" unitRef="usd">1</ix:nonFraction>'),null);
    assert.equal(currency.inlineCurrency(html+'<xbrli:unit id="cad"><xbrli:measure>iso4217:CAD</xbrli:measure></xbrli:unit><ix:nonFraction name="us-gaap:Assets" unitRef="cad">1</ix:nonFraction>'),null);
    const results=[{tool:'search_filings',result:{results:[{url}]}},{tool:'fetch_page',result:page}];
    assert.equal(q.filingNarrativeEvidence(results)[0].unit,'USD');
});


test('non-directory funds cannot receive company segment analysis', async () => {
    for (const symbol of ['SPY','VFIAX']) {
        const result = await ask.runTool('get_segments',{symbol});
        assert.equal(result.code,'VERIFIED_FINANCIALS_UNAVAILABLE');
        assert.equal(result.coverage,'unavailable');
        assert.equal(result.segments,undefined);
    }
});
