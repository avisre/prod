'use strict';

// Progressive dossier serving: a build publishes a "partial" (every data
// section, narrative empty) the moment gathering finishes, polls serve it,
// and the finished payload overwrites it when the writing round completes.
// These are structural checks against source text (the convention of
// test/dossier-credits.test.js): the live route needs Mongo + Stripe + the AI
// provider, so we pin the exact shape the fast-feeling build depends on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dossierSource = fs.readFileSync(require.resolve('../dossier'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'dossier.js'), 'utf8');

test('the partial is published before the writing stage, and the full payload overwrites it', () => {
    const partialWriteIdx = dossierSource.indexOf('await writeDossierDoc(col, sym, fyEnd, depth, payload)');
    assert.ok(partialWriteIdx !== -1, 'buildDossier must write the doc through writeDossierDoc');

    const writes = dossierSource.match(/await writeDossierDoc\(col, sym, fyEnd, depth, payload\)/g) || [];
    assert.equal(writes.length, 2, 'exactly two writes: the published partial and the finished overwrite');

    const writingIdx = dossierSource.indexOf("onStage('writing')");
    assert.ok(writingIdx !== -1);
    assert.ok(
        partialWriteIdx < writingIdx,
        'the partial must be cached BEFORE the writing stage — the data sections are done and users should see them while the narrative is drafted'
    );

    const mergeIdx = dossierSource.indexOf('delete payload.partial');
    const secondWriteIdx = dossierSource.indexOf('await writeDossierDoc(col, sym, fyEnd, depth, payload)', partialWriteIdx + 10);
    assert.ok(mergeIdx !== -1 && mergeIdx < secondWriteIdx, 'the narrative merge must strip the partial flag before the final write');
    assert.match(dossierSource, /executiveSummary: summary/, 'the final payload must carry the written executive summary');
});

test('cachedDossier treats partials as not-done; only peekDossier serves them', () => {
    const cachedFn = dossierSource.slice(dossierSource.indexOf('async function cachedDossier'), dossierSource.indexOf('async function acquireDossierLease'));
    assert.match(cachedFn, /!hit\.payload\.partial/, 'the lease/build-time re-check read must skip partials: a draft served there would be treated as final and stop a concurrent requester from polling');

    const peekFn = dossierSource.slice(dossierSource.indexOf('async function peekDossier'));
    assert.match(peekFn, /hit\.payload\.partial/, 'peek (the poll/pre-cache read) must see partials');
    assert.match(peekFn, /DOSSIER_PARTIAL_STALE_MS/, 'a stale partial (builder died mid-write) must be a miss so the next non-poll request rebuilds');
});

test('the poll path peeks the cache before returning 202 — even while this instance builds', () => {
    const routeStart = appSource.indexOf("app.get('/api/dossier/:symbol'");
    const routeEnd = appSource.indexOf('\napp.', routeStart + 10);
    const route = appSource.slice(routeStart, routeEnd);
    const pollIdx = route.indexOf("req.query.poll === '1'");
    assert.ok(pollIdx !== -1, 'the poll path must exist');
    const pollBranch = route.slice(pollIdx, pollIdx + 900);

    const peekIdx = pollBranch.indexOf('dossier.peekDossier');
    const buildingIdx = pollBranch.indexOf("status(202)");
    assert.ok(peekIdx !== -1 && buildingIdx !== -1);
    assert.ok(peekIdx < buildingIdx, 'the cache peek must precede the 202 — the partial published mid-build is what makes the build feel fast');
    assert.doesNotMatch(pollBranch, /credits\.spend/, 'polling must never charge');

    assert.match(pollBranch, /if \(!cached\.partial\) recordDossierView/, 'a partial hit must not be recorded as a completed view');
});

test('the frontend renders a partial and keeps polling until the full dossier lands', () => {
    const loopIdx = frontendSource.indexOf('if (d && d.dossier) {');
    assert.ok(loopIdx !== -1, 'the poll loop\'s dossier branch must exist');
    const branch = frontendSource.slice(loopIdx, loopIdx + 400);
    assert.match(branch, /render\(out, d\.dossier, sym\);/, 'a partial must be rendered immediately');
    assert.match(branch, /d\.dossier\.partial/, 'a partial must be detected so polling continues');
    assert.match(branch, /partialNote\(out\)/, 'the in-progress note must be shown above the partial render');
});

test('the frontend asset stamp is bumped for the progressive change', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'dossier.html'), 'utf8');
    assert.match(html, /dossier\.js\?v=20260911-progserve1/, 'the dossier.js cache stamp must change whenever the asset does');
});