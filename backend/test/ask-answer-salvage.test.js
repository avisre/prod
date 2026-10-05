'use strict';

// One finding that survived the rewrite used to replace the whole answer with a
// data receipt. Measured on 2026-10-06: "tell me the story of intel" lost a
// 696-word story to a range dash read as a minus sign, and "intel" lost a
// 929-word report to a wording rule that matched across unrelated sections.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.OLLAMA_API_KEY = 'test-only-key';
const q = require('../ask-answer-quality');
const policy = require('../ask-report-policy');
const aiChat = require('../ai-chat');

afterEach(() => aiChat.__resetDeps());

const fact = (value, id) => ({ value, unit: 'USD', currency: 'USD', scope: 'entity', sourceIds: [id] });
const periods = rows => rows.map(([periodEnd, revenue, netIncome, rd], i) => ({ periodEnd, currency: 'USD', fields: {
    totalRevenue: fact(revenue, 'r' + i), netIncome: fact(netIncome, 'n' + i), researchAndDevelopment: fact(rd, 'd' + i) } }));
const annual = (symbol, rows) => ({ tool: 'get_financials', result: { symbol, statement: 'income', basis: 'annual (fiscal years)', observations: periods(rows) } });
const AMD = annual('AMD', [
    ['2025-12-27', 34639000000, 4335000000, 8091000000],
    ['2024-12-28', 25785000000, 1641000000, 6456000000],
    ['2023-12-30', 22680000000, 854000000, 5872000000]
]);
const filler = 'The company designs processors for personal computers, servers and game consoles, and it relies on outside foundries to manufacture them. ' +
    'Its customers are large computer makers and cloud providers, which buy in volume and negotiate hard. ' +
    'The business is cyclical, because demand for computers rises and falls with the wider economy. ' +
    'Management has spent several years moving the product mix toward data-centre chips, which carry better pricing. ' +
    'That shift is the main thread of the story told in the annual filings. ' +
    'Competition remains intense, and each product generation has to win its place again. ' +
    'Investors therefore watch the pace of new launches as closely as the reported results. ' +
    'The filings describe these dynamics in the business and risk sections each year.';
const story = `## The story\n\n${filler}\n\nRevenue reached $34.6bn in the latest year. Analysts expect it to hit $50.0bn soon. Net income was $4.3bn.\n\n**The read** — A steady climb in the filed numbers.\n\n> Next: What drove the data-centre growth?`;

test('a range dash after a scaled figure is a range, not a minus sign', () => {
    assert.deepEqual(q.numericClaims('R&D ran at $5.9bn–$6.5bn a year.', [AMD]), []);
    assert.equal(q.numericClaims('The loss was –$6.5bn.', [AMD]).length, 1);
});

test('salvage removes only the sentence with the unsupported figure', () => {
    const options = { question: 'Tell me the story of AMD.', policy: policy.select('Tell me the story of AMD.') };
    assert.equal(q.audit(story, [AMD], options).length, 1);
    const out = q.salvage(story, [AMD], options);
    assert.equal(out.ok, true);
    assert.equal(out.removedClaims, 1);
    assert.doesNotMatch(out.text, /\$50\.0bn|Analysts expect/);
    assert.match(out.text, /Revenue reached \$34\.6bn in the latest year\. Net income was \$4\.3bn\./);
    assert.match(out.text, /\*\*The read\*\* — A steady climb/);
    assert.match(out.text, /> Next: What drove/);
    assert.deepEqual(q.audit(out.text, [AMD], options), []);
});

test('salvage blanks an unsupported table cell and keeps the row', () => {
    const table = `${filler}\n\n| Year | Revenue | Backlog |\n| --- | --- | --- |\n| 2025-12-27 | $34.6bn | $9.9bn |`;
    const out = q.salvage(table, [AMD], { question: 'AMD revenue history' });
    assert.equal(out.ok, true);
    assert.match(out.text, /\| 2025-12-27 \| \$34\.6bn \| — \|/);
});

test('a supported draft is returned untouched, and a gutted one is refused', () => {
    const options = { question: 'AMD revenue history' };
    const clean = `${filler}\n\nRevenue reached $34.6bn in the latest year.`;
    assert.deepEqual(q.salvage(clean, [AMD], options), { ok: true, text: clean, issues: [], removedClaims: 0, chartsRemoved: 0 });
    assert.equal(q.salvage('Revenue will reach $50.0bn. Profit will reach $9.9bn.', [AMD], options).ok, false);
});

test('debt and a commitment in separate sections are not a conflation', () => {
    const separate = 'Long-term debt is unchanged on the balance sheet.\n\nManagement repeated its commitment to the new process node.';
    assert.deepEqual(q.audit(separate, [], { question: 'What is new at the company?' }), []);
    const added = 'Total debt including lease commitments is the figure to watch.';
    assert.match(q.audit(added, [], { question: 'What is new at the company?' }).join('\n'), /Distinguish leases/);
});

test('the receipt names the direction revenue actually moved', () => {
    const intc = annual('INTC', [['2025-12-27', 52853000000, -267000000, 13774000000], ['2021-12-25', 79024000000, 19868000000, 15190000000]]);
    const question = 'Tell me the story of Intel.';
    const receipt = q.fallback([intc], question, { policy: { ...policy.select(question), kind: 'company_report', company: { symbol: 'INTC' } } });
    assert.match(receipt, /longer-term revenue decline/);
    assert.doesNotMatch(receipt, /revenue increase/);
});

test('the engine publishes the salvaged answer instead of a receipt', async () => {
    const draft = `${filler}\n\nRevenue reached $34.6bn in the latest year. Analysts expect it to hit $50.0bn soon.`;
    let call = 0;
    const chatRaw = async () => {
        call++;
        if (call === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_financials', arguments: JSON.stringify({ symbol: 'AMD', statement: 'income', basis: 'annual' }) } }] };
        return { role: 'assistant', content: draft };
    };
    aiChat.__setDeps({ chatRaw, chatRawStream: (m, o) => chatRaw(m, o), runTool: async () => AMD.result });
    const out = await aiChat.ask({ question: 'How has AMD revenue changed? No chart.', history: [], ctx: {} });
    assert.equal(out.source, 'ai');
    assert.equal(out.quality.salvaged, true);
    assert.equal(out.quality.fallback, false);
    assert.doesNotMatch(out.answer, /\$50\.0bn/);
    assert.match(out.answer, /Revenue reached \$34\.6bn/);
});

test('a percentage range is not a negative figure, and its sentence can still be removed', () => {
    // R&D intensity (8,091 / 34,639 = 23.4%) is a supplied calculation.
    assert.deepEqual(q.numericClaims('R&D ran at 20–23.4% of revenue.', [AMD]).filter(i => /23.4%/.test(i)), []);
    const draft = `${filler}\n\nRevenue reached $34.6bn in the latest year. Margins sit around 91–93% of sales.`;
    const out = q.salvage(draft, [AMD], { question: 'AMD revenue history' });
    assert.equal(out.ok, true);
    assert.doesNotMatch(out.text, /93%/);
    assert.match(out.text, /Revenue reached \$34\.6bn/);
});

test('a magazine-layout annual report still yields its business and risk text', () => {
    const sections = require('../filing-sections');
    const body = 'We are a global leader in the design and manufacturing of CPUs. ' + 'Our products are sold to computer makers and cloud providers. '.repeat(40);
    const text = 'Page Overview 3 Our Strategy 3 Our Business 6 Risk Factors 37 ... Our Strategy 5 Our Business ' + body +
        ' Risk Factors The following summarizes the material factors. ' + 'Demand may fall. '.repeat(120) +
        ' Item 1. Business: General development of business Pages 3-5';
    assert.match(sections.narrativeFallback(text, '1', 9000), /^Our Business We are a global leader/);
    assert.match(sections.narrativeFallback(text, '1A', 6000), /^Risk Factors The following summarizes/);
    assert.equal(sections.narrativeFallback('Our Business 6 Risk Factors 37', '1', 9000), null);
});

test('every company report is told to use the eight-part format, in order', () => {
    const source = require('node:fs').readFileSync(require.resolve('../ai-chat'), 'utf8');
    const parts = ['1. What the company does', '2. Business segments', '3. Recent quarters', '4. Annual trend', '5. What makes it different', '6. Key risks', '7. Valuation snapshot', '8. The read'];
    let cursor = -1;
    for (const part of parts) { const at = source.indexOf(part, cursor + 1); assert.ok(at > cursor, part); cursor = at; }
});

test('a scaled figure cut short instead of rounded is still the supplied figure', () => {
    const quote = { tool: 'get_quote', result: { symbol: 'INTC', currency: 'USD', price: 119.33, marketCap: 630790946816, asOf: '2026-10-02' } };
    assert.deepEqual(q.numericClaims('Market cap is $630bn.', [quote]), []);
    assert.deepEqual(q.numericClaims('Market cap is $631bn.', [quote]), []);
    assert.equal(q.numericClaims('Market cap is $632bn.', [quote]).length, 1);
    assert.equal(q.numericClaims('Market cap is $629bn.', [quote]).length, 1);
});
