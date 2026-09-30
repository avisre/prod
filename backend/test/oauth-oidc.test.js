'use strict';

// The OpenID Connect surface OpenAI's plugin directory requires before a
// ChatGPT Enterprise workspace can use its verified email domains to stop a
// corporate identity linking the plugin in a personal workspace: published OIDC
// discovery metadata, the `openid` and `email` scopes advertised and issued, and
// a UserInfo endpoint returning `email` with `email_verified: true`.
//
// The claim-building and header-parsing halves are tested for real. The routes
// themselves are pinned as source, because /oauth/userinfo reads Mongo and
// app.js cannot be booted in this suite without a database — the same reason
// api-access-gating.test.js pins its routes the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bearerToken, userInfoClaims } = require('../oauth-oidc');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('bearerToken reads a Bearer credential and nothing else', () => {
    assert.equal(bearerToken('Bearer sp_mcp_abc123'), 'sp_mcp_abc123');
    assert.equal(bearerToken('bearer sp_mcp_abc123'), 'sp_mcp_abc123', 'scheme is case-insensitive per RFC 7235');
    assert.equal(bearerToken('BEARER   sp_mcp_abc123  '), 'sp_mcp_abc123', 'surrounding space is not part of the token');
});

test('bearerToken refuses headers that only resemble one', () => {
    // A Basic credential reaching the token store would be a credential-type
    // confusion, and 'bearer' without the space is not the scheme.
    assert.equal(bearerToken('Basic dXNlcjpwYXNz'), '');
    assert.equal(bearerToken('bearerX sp_mcp_abc123'), '');
    assert.equal(bearerToken('bearer'), '');
    assert.equal(bearerToken(''), '');
    assert.equal(bearerToken(undefined), '');
    assert.equal(bearerToken(null), '');
});

test('userInfoClaims returns the verified email and a stable subject', () => {
    const claims = userInfoClaims({ userId: '68f1c2' }, { email: 'owner@example.com' });
    assert.deepEqual(claims, { sub: '68f1c2', email: 'owner@example.com', email_verified: true });
    // sub is the id, never the address, so it survives an email change.
    assert.notEqual(claims.sub, claims.email);
});

test('userInfoClaims refuses to serve a half claim set', () => {
    // email_verified must never travel without the address it describes, and a
    // token whose user row has gone must not authenticate.
    assert.equal(userInfoClaims({ userId: '68f1c2' }, { email: '' }), null);
    assert.equal(userInfoClaims({ userId: '68f1c2' }, null), null);
    assert.equal(userInfoClaims({ userId: '' }, { email: 'owner@example.com' }), null);
    assert.equal(userInfoClaims(null, { email: 'owner@example.com' }), null);
});

test('both discovery documents advertise the UserInfo endpoint the route serves', () => {
    assert.ok(appSource.includes("app.get('/.well-known/openid-configuration'"),
        'OIDC discovery metadata is not published');
    assert.ok(appSource.includes("app.get('/oauth/userinfo'"), 'the UserInfo endpoint is not routed');

    // Both documents have to point at it: OpenAI reads the OIDC document, and a
    // client that only ever fetched RFC 8414 metadata would otherwise not know
    // the endpoint exists.
    const pointed = (appSource.match(/userinfo_endpoint: `\$\{base\}\/oauth\/userinfo`/g) || []).length;
    assert.ok(pointed >= 2, `only ${pointed} discovery document(s) name the UserInfo endpoint`);
});

test('the identity scopes are advertised and issued, so asking for them cannot fail', () => {
    const oidcLiteral = (appSource.match(/const OIDC_SCOPES = \[([^\]]+)\];/) || [])[1];
    assert.ok(oidcLiteral, 'OIDC_SCOPES is still a literal list this test can read');
    const oidc = oidcLiteral.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(oidc, ['openid', 'email'],
        'OpenAI asks for exactly these two by default once they are advertised');

    // Publishing them in the OIDC document is an invitation to request them;
    // normalizeOauthScope has to accept that request or the connection is
    // refused with invalid_scope and the connector looks dead.
    const oidcDoc = appSource.slice(appSource.indexOf("app.get('/.well-known/openid-configuration'"));
    assert.match(oidcDoc.slice(0, 700), /scopes_supported: OAUTH_SCOPES_SUPPORTED/,
        'the OIDC document advertises a scope list authorize does not validate against');
});
