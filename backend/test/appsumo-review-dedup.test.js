'use strict';

// Structural checks (same convention as test/profile-consolidation.test.js —
// app.js is an ~11000-line monolith that isn't worth booting a real server
// for). These pin the duplicate-review-ask invariants in place.
//
// Why they exist: on 2026-08-21 one AppSumo buyer received the identical
// stage-2 review ask twice, two minutes apart (Sent #49/#50 in the support
// inbox). Two independent senders can produce that email:
//
//   1. the in-process sweep — runAppSumoReviewSweep in backend/app.js, and
//   2. the standalone worker — scripts/run-scheduled-emails.js, template
//      appsumo_review_5d.
//
// Both protect themselves with ONE user-level claim pair
// (reviewRequestSentAt / reviewRequestClaimedAt) claimed atomically before
// sending. The structural tests below pin each half of that contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const workerSource = fs.readFileSync(require.resolve('../../scripts/run-scheduled-emails'), 'utf8');

function sweepSource() {
    const idx = appSource.indexOf('async function runAppSumoReviewSweep');
    assert.notEqual(idx, -1, 'the sweep must exist');
    return appSource.slice(idx, idx + 5500);
}

test('the sweep refuses to send its stage-2 copy when the worker has a review job queued or sent', () => {
    assert.match(
        sweepSource(),
        /appsumo-review-5d:\$\{String\(u\._id\)\}`, status: \{ \$in: \['scheduled', 'sent'\] \}/,
        'before sending stage >= 2 the sweep must skip a user whose appsumo-review-5d job is scheduled or sent — both paths produce the identical email'
    );
});

test('both claimers guard on the same persisted claim pair, atomically, before sending', () => {
    const guard = 'reviewRequestSentAt: null, reviewRequestClaimedAt: null';
    assert.ok(sweepSource().includes(guard), 'the sweep must claim on the sent/claimed pair');
    assert.ok(workerSource.includes(guard), 'the worker must claim on the same pair');
    assert.ok(workerSource.includes('returnDocument'), 'the worker claim must be an atomic findOneAndUpdate');
});

test('the sweep marks the send durably even if the write races — suppress direction only', () => {
    const sweep = sweepSource();
    const okSend = sweep.indexOf('if (await mailer.sendMail(');
    const successWrite = sweep.slice(okSend, okSend + 900);
    // The success write must not be conditioned on re-verifying the claim:
    // a guarded success write that loses its race strands the claim (email
    // sent, claim standing, user eligible again after any manual reset).
    // Unconditional stage 3 + sentAt is the safe direction — it can only
    // suppress further asks, never enable one.
    assert.match(successWrite, /\$set: \{ appsumoReviewStage: 3, reviewRequestSentAt: sentAt \}/);
    assert.doesNotMatch(successWrite, /_id: claimed\._id, reviewRequestClaimedAt: claimedAt[,}]/);
});

test('the worker claims before sending, releases once, and never releases a sent email', () => {
    // Claim → send → mark sent + unset claim; on send failure, release.
    assert.match(workerSource, /reviewClaimedAt = new Date\(\)/);
    assert.match(
        workerSource,
        /\{ \$unset: \{ reviewRequestClaimedAt: '' \} \}\);\n\s*await db\.collection\('scheduled_emails'\)\.updateOne\(\{ _id: job\._id \}, \{ \$set: \{ status: 'failed', lastError: 'mailer returned false' \} \}\);/
    );
    assert.match(workerSource, /updates\.reviewRequestSentAt = new Date\(\)/);
});