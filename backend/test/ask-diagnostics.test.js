'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { outcome } = require('../ask-diagnostics');

test('terminal Ask telemetry identifies flow failures without question, answer, identity or tool arguments', () => {
    const result = outcome({
        source: 'partial',
        answer: 'PRIVATE ANSWER',
        toolsUsed: [
            { tool: 'get_financials', args: { symbol: 'SECRET', question: 'PRIVATE QUESTION' }, ok: true },
            { tool: 'get_peer_context', args: { symbol: 'SECRET' }, ok: false }
        ],
        quality: { policy: { kind: 'company_report' }, terminalReason: 'validation_after_correction',
            correctionAttempted: true, correctionSucceeded: false }
    }, { mode: 'analyst', stream: true, entrypoint: 'web_chat' });
    assert.deepEqual(result, { source: 'partial', mode: 'analyst', stream: true, entrypoint: 'web_chat',
        policy: 'company_report', terminalReason: 'validation_after_correction', tools: 2,
        failedTools: ['get_peer_context'], correctionAttempted: true, correctionSucceeded: false });
    const serialized = JSON.stringify(result);
    for (const privateValue of ['PRIVATE QUESTION', 'PRIVATE ANSWER', 'SECRET']) assert.equal(serialized.includes(privateValue), false);
});
