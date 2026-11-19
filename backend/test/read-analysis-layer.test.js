'use strict';

// The read block is the model's analysis layer: causal inference and
// cross-source synthesis are ALLOWED there without retrieved narrative —
// the lending-standards-before-the-crisis read no filing spells out. Outside
// that block the grounding rules are unchanged, and figures inside it are
// audited exactly like figures everywhere else. These contracts pin all
// three edges so a future tightening cannot silently restore the
// copy-paste-only behaviour, and a future loosening cannot smuggle in
// invented numbers.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OLLAMA_API_KEY = 'test-only-key';
const q = require('../ask-answer-quality');

const INFERENCE = 'the margin gains are driven by AI/datacenter demand the filings do not yet spell out, and the pattern across peers suggests it persists';
const withRead = body => `${body}\n\n**The read** — ${INFERENCE}.\n\n> Next: What happens when NAND supply catches up?`;
const base = { question: 'why did profitability rise', mode: 'normal', policy: require('../ask-report-policy').resolve('why did profitability rise') };
const noNarrative = [{ tool: 'get_financials', result: {} }];

test('causal inference inside the read block needs no retrieved narrative', () => {
    const issues = q.audit(withRead('Revenue rose 5% year on year.'), noNarrative, base);
    assert.ok(!issues.some(i => /attribute a financial change/.test(i)), 'the read block is the analysis layer — inference is allowed there');
});

test('the same inference outside the read block is still flagged', () => {
    const issues = q.audit(`Revenue rose 5% year on year. ${INFERENCE}.\n\n**The read** — A calm summary.`, noNarrative, base);
    assert.ok(issues.some(i => /attribute a financial change/.test(i)), 'grounded sections keep the narrative requirement');
});

test('the read block ends where the Next line begins — inference in the Next line is not exempted', () => {
    const issues = q.audit(`**The read** — A calm summary.\n\n> Next: Will ${INFERENCE}?`, noNarrative, base);
    assert.ok(issues.some(i => /attribute a financial change/.test(i)), 'the exemption is scoped to the read paragraph only');
});

test('an invented figure inside the read block is still rejected', () => {
    const issues = q.audit(`**The read** — In my read, margins rose because of AI demand: revenue climbed 41% and net margin hit 73%.`, noNarrative, base);
    assert.ok(issues.some(i => /Percentage claim/.test(i)), 'figure grounding survives inside the read block');
});

test('a supported figure inside the read block passes', () => {
    const results = [{ tool: 'get_financials', result: { basis: 'annual', statement: 'income', observations: [{ periodEnd: '2025-12-31', currency: 'USD',
        fields: { netIncome: { value: 7300, currency: 'USD' }, totalRevenue: { value: 10000, currency: 'USD' } } }] } }];
    const issues = q.audit('**The read** — Net margin was 73% of revenue, and in my read the driver is pricing power, not volume.', results, base);
    assert.ok(!issues.length, JSON.stringify(issues));
});

test('both modes instruct the model to reason beyond the retrieved text', async () => {
    const aiChat = require('../ai-chat');
    try {
        // The system prompt is built from the mode frameworks; assert the
        // analysis-layer instruction reached the prompt in each mode.
        for (const mode of ['analyst', 'normal']) {
            const captures = [];
            aiChat.__setDeps({ chatRaw: async (messages, opts) => { captures.push({ messages, opts }); return { role: 'assistant', content: 'Done.' }; },
                chatRawStream: (m, o) => ({ role: 'assistant', content: '' }),
                runTool: async () => ({ error: 'Offline test fixture' }) });
            await aiChat.ask({ question: 'How is AMD doing?', history: [], ctx: {}, mode });
            const system = captures.flatMap(c => c.messages.filter(m => m.role === 'system').map(m => m.content)).join('\n');
            assert.match(system, /YOUR analysis layer/i, `${mode}: the read is defined as the analysis layer`);
            assert.match(system, /conclusion none of the individual sources states/i, `${mode}: the model is told to reason beyond the sources`);
            assert.match(system, /never present an inference as a filed statement/i, `${mode}: inference stays labelled as a read`);
        }
    } finally { aiChat.__resetDeps(); }
});
