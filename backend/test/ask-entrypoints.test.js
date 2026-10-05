'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../../frontend-v2');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('homepage, /ask, inline Ask and the global keyboard bar submit through the shared engine', () => {
    const app = read('assets/app.js'), home = read('index.html'), ask = read('ask.html');
    assert.match(home, /id="try-form"/);
    assert.match(home, /const engine = V2\.askEngine\(exchange\)/);
    assert.match(home, /form\.addEventListener\('submit'[\s\S]*?engine\.send\(q\)/);
    assert.match(ask, /const \{ API, token, nav, footer, askEngine/);
    assert.match(ask, /engine\.send\(sentQ, opts\)/);
    assert.match(ask, /e\.key === 'Enter' && !e\.shiftKey[\s\S]*?submit\(\)/);
    assert.match(app, /function askEngine\(/);
    assert.match(app, /function mountAsk\([\s\S]*?askEngine\([\s\S]*?form\.addEventListener\('submit'[\s\S]*?engine\.send\(q\)/);
    assert.match(app, /function mountAskFloor\([\s\S]*?askEngine\([\s\S]*?addEventListener\('submit'[\s\S]*?engine\.send\(q\)/);
    assert.match(app, /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === 'k'/);
    assert.match(app, /body: JSON\.stringify\(\{ question, history: history\.slice\(-8\), stream: true, mode: askMode/);
    assert.match(app, /aborter = new AbortController\(\)/);
    assert.match(app, /signal: aborter\.signal/);
    assert.match(app, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/, 'transient server errors receive one bounded retry');
    assert.match(app, /if \(aborter\) aborter\.abort\(\)/, 'Stop cancels the in-flight request');
});

test('company, dossier, monitor and dashboard Ask surfaces use the shared mount functions', () => {
    assert.match(read('assets/company.js'), /mountAskFloor\(/);
    assert.match(read('assets/dossier.js'), /mountAskFloor\(/);
    assert.match(read('assets/monitor.js'), /mountAskFloor\(/);
    assert.match(read('assets/dashboard.js'), /mountAsk\(/);
});

test('Normal and Analyst share one evidence policy; AI Portfolio remains per-request gated', () => {
    const policy = require('../ask-report-policy');
    for (const q of ['AMD', 'INTC', 'Microsoft']) {
        assert.equal(policy.select(q, 'normal').kind, 'company_report');
        assert.equal(policy.select(q, 'analyst').kind, 'company_report');
    }
    const ask = read('ask.html'), app = read('../backend/app.js');
    assert.match(ask, /opts\.aiPaperMode = true/);
    assert.match(app, /aiPaperMode\) === true && aiPaper\.isBetaUser\(req\.user\)/);
    assert.match(app, /aiPaperCtx \? \{ \.\.\.aiPaperCtx, aiPaperProgress:/);
    assert.match(app, /\.\.\.\(aiPaperCtx \|\| \{\}\)/);
});
