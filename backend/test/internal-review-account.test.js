'use strict';

// Accounts we create for an outside reviewer to sign in with — today only the
// OpenAI plugin review account — are not customers and must not appear in any
// count that claims to describe customers.
//
// The trap this file exists to catch: `reviewAccount` is written straight to
// the collection by scripts/create-openai-reviewer.js, so it survives in Mongo
// and every query looks like it works. But mongoose strips paths the schema
// does not declare, so a hydrated read (User.findById in oauthCurrentUser, for
// one) silently returns undefined for the flag and the guard never fires. Both
// halves are pinned below: the field has to be declared, AND the reads that
// count people have to exclude it.
//
// The document builder is exercised for real; the routes are pinned as source,
// because app.js reads Mongo and cannot be booted in this suite — the same
// reason oauth-oidc.test.js pins its routes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildReviewerDoc } = require('../../scripts/create-openai-reviewer.js');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('the provisioned reviewer document is marked and fully opted out', () => {
    const doc = buildReviewerDoc({ email: 'OpenAI-Review@Example.com', passwordHash: 'hash' });
    assert.equal(doc.reviewAccount, true, 'the flag is what every exclusion below keys off');
    assert.equal(doc.email, 'openai-review@example.com', 'stored lowercased, like every other account');
    // A reviewer must never be mailed, and their traffic must not look like a
    // customer's — the script sets all four opt-outs rather than relying on any
    // one mailer to remember to check.
    for (const field of ['digestOptOut', 'appsumoEmailsOptOut', 'trialEmailsOptOut', 'customerMessageEmailsOptOut']) {
        assert.equal(doc[field], true, `${field} must be set`);
    }
    assert.equal(doc.analyticsConsent, false);
});

test('reviewAccount is a declared schema path so hydrated reads can see it', () => {
    assert.match(appSource, /reviewAccount: \{ type: Boolean, default: false \}/);
});

test('approving the OAuth client from a review account is not counted as demand', () => {
    // The developer funnel reads mcp_oauth_authorized as "a real user approved
    // a client". The reviewer walks that exact flow to exercise the plugin.
    assert.match(appSource, /if \(!user\.reviewAccount\) \{\s*\n\s*trackFunnel\('mcp_oauth_authorized'/);
});

test('a review account never lands in the activation funnel', () => {
    assert.match(appSource, /if \(user && user\.reviewAccount\) return false;/);
    // The guard only works if the projection actually loads the flag.
    assert.match(appSource, /select\(\{ firstActivationAt: 1, subscription: 1, reviewAccount: 1 \}\)/);
});

test('the customer registry excludes review accounts from every source view', () => {
    assert.match(appSource, /const filter = \{ reviewAccount: \{ \$ne: true \} \};/);
});

test('the trial lifecycle drip cannot mail a review account', () => {
    const sweep = appSource.slice(appSource.indexOf('async function runTrialLifecycleSweep'));
    assert.match(sweep, /reviewAccount: \{ \$ne: true \},/);
});
