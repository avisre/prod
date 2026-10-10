'use strict';

// The deploy gate runs only the tests a change can affect (owner decision
// 2026-10-10). Being wrong in the direction of running too little would let a
// broken change through, so the rules that keep it safe are pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const testMap = require('../../scripts/lib/test-map');

const ROOT = path.join(__dirname, '..', '..');
const map = testMap.build(ROOT);
const pick = (...files) => testMap.select(ROOT, files, map);
const names = (r) => r.files.map((f) => path.basename(f));

test('a change runs the tests that require it or read it, and not the rest', () => {
    const notice = pick('backend/connector-notices.js');
    assert.equal(notice.all, false);
    for (const t of ['connector-notices.test.js', 'mcp-endpoint.test.js', 'mcp-apps.test.js']) assert.ok(names(notice).includes(t), t);
    assert.ok(notice.files.length < 20, `a connector change selected ${notice.files.length} test files`);
    assert.ok(!names(notice).includes('seo-research.test.js'), 'stock-page tests are not run for a connector change');

    // Read as text, not required: still a dependency.
    assert.ok(names(pick('frontend-v2/ask.html')).includes('speech-to-text.test.js'));
    assert.ok(names(pick('.claude/HANDOFF.md')).includes('handoff-size.test.js'));
    // A test that changed runs itself.
    assert.ok(names(pick('backend/test/oauth-mcp.test.js')).includes('oauth-mcp.test.js'));
});

test('it errs toward running everything', () => {
    const total = map.tests.size;
    // Anything that changes how tests run.
    for (const f of ['backend/package.json', 'package-lock.json', 'scripts/predeploy.js', 'scripts/lib/test-map.js']) {
        const r = pick(f);
        assert.equal(r.all, true, f);
        assert.equal(r.files.length, total);
    }
    // A source file no test maps to is not assumed safe.
    const unmapped = [...map.fileSet].find((f) => /^backend\/[^/]+\.js$/.test(f) && ![...map.tests.values()].some((i) => i.deps.has(f)));
    if (unmapped) assert.equal(pick(unmapped).all, true, `${unmapped} has no test and must run the suite`);
    // One unmapped file among mapped ones still runs everything.
    if (unmapped) assert.equal(pick('backend/connector-notices.js', unmapped).all, true);
});

test('directory scans and company data are followed', () => {
    // A new page is seen by the tests that list the pages folder.
    assert.ok(names(pick('frontend-v2/screener.html')).includes('profile-consolidation.test.js'));
    assert.ok(names(pick('frontend-v2/screener.html')).includes('legacy-html-redirects.test.js'));
    // Company data reaches the tests of the code that reads it.
    const data = pick('frontend/data/quotes.json');
    assert.equal(data.all, false);
    assert.ok(names(data).includes('sec-coverage.test.js'));
    assert.ok(data.files.length > 30);
    // Words and pictures no test names need no test.
    assert.deepEqual(pick('notes/some-new-note.md').files, []);
});
