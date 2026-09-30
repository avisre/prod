'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withConsentFormAction } = require('../oauth-csp');

// The header helmet actually produces in production (trimmed to the directives
// that matter here) — the failure this guards against was only visible against
// a real browser, so the fixture is the real string, not a simplification.
const REAL_CSP = "default-src 'self';object-src 'none';base-uri 'self';"
    + "form-action 'self' https://hooks.stripe.com;frame-ancestors 'self';upgrade-insecure-requests";

test('adds the connector origin to form-action so the post-consent redirect is not blocked', () => {
    const patched = withConsentFormAction(REAL_CSP, 'https://chatgpt.com/connector/oauth/HWbF3Wa8u_Ah');
    assert.match(patched, /form-action 'self' https:\/\/hooks\.stripe\.com https:\/\/chatgpt\.com;/);
    // The rest of the policy has to survive untouched.
    assert.match(patched, /default-src 'self'/);
    assert.match(patched, /frame-ancestors 'self'/);
    assert.match(patched, /upgrade-insecure-requests/);
});

test('is idempotent when the origin is already allowed', () => {
    const once = withConsentFormAction(REAL_CSP, 'https://claude.ai/api/mcp/auth_callback');
    const twice = withConsentFormAction(once, 'https://claude.ai/api/mcp/auth_callback');
    assert.equal(twice, once);
    assert.equal((twice.match(/https:\/\/claude\.ai/g) || []).length, 1);
});

test('leaves the policy alone for an unparseable redirect_uri', () => {
    assert.equal(withConsentFormAction(REAL_CSP, 'not a url'), REAL_CSP);
    assert.equal(withConsentFormAction(REAL_CSP, ''), REAL_CSP);
    assert.equal(withConsentFormAction(REAL_CSP, 'mailto:someone@example.com'), REAL_CSP);
});

test('passes a missing header straight through', () => {
    assert.equal(withConsentFormAction(undefined, 'https://chatgpt.com/cb'), undefined);
    assert.equal(withConsentFormAction('', 'https://chatgpt.com/cb'), '');
});

test('a policy without form-action is returned unchanged rather than half-edited', () => {
    const noFormAction = "default-src 'self';object-src 'none'";
    assert.equal(withConsentFormAction(noFormAction, 'https://chatgpt.com/cb'), noFormAction);
});
