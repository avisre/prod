'use strict';

// oauth-mcp.js — the OAuth 2.1 + PKCE flow that lets a PAYING customer
// authenticate to /mcp from ChatGPT or claude.ai, neither of which can send a
// static bearer token. Real Mongo (in-memory), same pattern as
// test/api-keys.test.js: these are security properties, and a hand-rolled fake
// of the store would prove nothing about the atomic single-use redemption that
// stops a stolen code being replayed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const oauth = require('../oauth-mcp');

function pkcePair() {
    const verifier = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { verifier, challenge };
}

async function withMongo(t) {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });
}

test('redirect_uri validation: https anywhere, http only on loopback', () => {
    assert.equal(oauth.isValidRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect'), true);
    assert.equal(oauth.isValidRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
    // Native and desktop clients genuinely land on an ephemeral loopback port.
    assert.equal(oauth.isValidRedirectUri('http://127.0.0.1:54321/callback'), true);
    assert.equal(oauth.isValidRedirectUri('http://localhost:8080/cb'), true);
    // Plain http to a remote host would put the code on the wire in clear.
    assert.equal(oauth.isValidRedirectUri('http://evil.example.com/cb'), false);
    // A fragment would silently swallow the query string we append the code to.
    assert.equal(oauth.isValidRedirectUri('https://example.com/cb#frag'), false);
    assert.equal(oauth.isValidRedirectUri('javascript:alert(1)'), false);
    assert.equal(oauth.isValidRedirectUri('not a url'), false);
});

test('the consent screen names the real destination, not the self-chosen client name', () => {
    assert.equal(oauth.redirectDisplayHost('https://chatgpt.com/connector_platform_oauth_redirect'), 'chatgpt.com');
    assert.equal(oauth.redirectDisplayHost('https://attacker-alpha.example.com:8443/cb'), 'attacker-alpha.example.com:8443');
    // Userinfo must not be able to dress an attacker host up as a trusted one.
    assert.equal(oauth.redirectDisplayHost('https://chatgpt.com@evil.example.com/cb'), 'evil.example.com');
    assert.equal(oauth.redirectDisplayHost('http://127.0.0.1:54321/callback'), '127.0.0.1:54321 (this device)');
    assert.equal(oauth.redirectDisplayHost('myapp://callback'), 'the myapp app on this device');
    assert.equal(oauth.redirectDisplayHost('not a url'), '');
});

test('registration rejects a client with no usable redirect_uri', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    await assert.rejects(() => oauth.registerClient({ clientName: 'x', redirectUris: [] }), /redirect_uri is required/);
    await assert.rejects(
        () => oauth.registerClient({ clientName: 'x', redirectUris: ['http://evil.example.com/cb'] }),
        /not acceptable/
    );
});

test('the full authorization-code + PKCE flow issues a token bound to the user', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const client = await oauth.registerClient({ clientName: 'ChatGPT', redirectUris: ['https://chatgpt.com/cb'] });
    assert.match(client._id, /^mcpc_/, 'a client id is issued');
    assert.equal(client.redirectUris[0], 'https://chatgpt.com/cb');

    const { verifier, challenge } = pkcePair();
    const code = await oauth.issueCode({
        clientId: client._id, userId: 'user-42', redirectUri: 'https://chatgpt.com/cb',
        codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'mcp'
    });

    const redeemed = await oauth.redeemCode({
        code, clientId: client._id, redirectUri: 'https://chatgpt.com/cb', codeVerifier: verifier
    });
    assert.ok(redeemed, 'a correct exchange succeeds');
    assert.equal(redeemed.userId, 'user-42', 'the token will be bound to the consenting user');

    const issued = await oauth.issueTokens(redeemed);
    assert.match(issued.access_token, /^sp_mcp_/);
    assert.match(issued.refresh_token, /^sp_mcr_/);
    assert.equal(issued.token_type, 'Bearer');
    assert.equal(issued.expires_in, 3600);

    const resolved = await oauth.resolveAccessToken(issued.access_token);
    assert.equal(resolved.userId, 'user-42', 'the access token resolves to its owner');
});

test('an authorization code is single-use — a replay cannot win', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const client = await oauth.registerClient({ clientName: 'c', redirectUris: ['https://a.example/cb'] });
    const { verifier, challenge } = pkcePair();
    const args = { clientId: client._id, redirectUri: 'https://a.example/cb', codeVerifier: verifier };
    const code = await oauth.issueCode({ ...args, userId: 'u1', codeChallenge: challenge, codeChallengeMethod: 'S256' });

    assert.ok(await oauth.redeemCode({ code, ...args }), 'first redemption succeeds');
    assert.equal(await oauth.redeemCode({ code, ...args }), null, 'the same code cannot be redeemed twice');
});

test('PKCE, client and redirect_uri are all enforced at redemption', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const client = await oauth.registerClient({ clientName: 'c', redirectUris: ['https://a.example/cb'] });
    const other = await oauth.registerClient({ clientName: 'o', redirectUris: ['https://b.example/cb'] });

    const mint = async () => {
        const { verifier, challenge } = pkcePair();
        const code = await oauth.issueCode({
            clientId: client._id, userId: 'u1', redirectUri: 'https://a.example/cb',
            codeChallenge: challenge, codeChallengeMethod: 'S256'
        });
        return { code, verifier };
    };

    // Wrong verifier: this is the attack PKCE exists to stop — an intercepted
    // code is useless without the verifier that never left the initiating client.
    let { code, verifier } = await mint();
    assert.equal(
        await oauth.redeemCode({ code, clientId: client._id, redirectUri: 'https://a.example/cb', codeVerifier: 'wrong-verifier' }),
        null, 'a mismatched PKCE verifier is refused'
    );

    // A different registered client cannot redeem someone else's code.
    ({ code, verifier } = await mint());
    assert.equal(
        await oauth.redeemCode({ code, clientId: other._id, redirectUri: 'https://a.example/cb', codeVerifier: verifier }),
        null, 'the code is bound to the client that requested it'
    );

    // Exact redirect_uri match — a path under the same origin must not pass.
    ({ code, verifier } = await mint());
    assert.equal(
        await oauth.redeemCode({ code, clientId: client._id, redirectUri: 'https://a.example/cb/evil', codeVerifier: verifier }),
        null, 'redirect_uri is compared exactly, not by prefix'
    );
});

test('a refresh token rotates, and the consumed one stops working', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const client = await oauth.registerClient({ clientName: 'c', redirectUris: ['https://a.example/cb'] });
    const first = await oauth.issueTokens({ userId: 'u9', clientId: client._id, scope: 'mcp' });

    const second = await oauth.refresh({ refreshToken: first.refresh_token, clientId: client._id });
    assert.ok(second, 'a valid refresh token yields a new pair');
    assert.notEqual(second.access_token, first.access_token, 'a fresh access token is issued');

    // Rotation is what makes a leaked refresh token short-lived rather than permanent.
    assert.equal(await oauth.refresh({ refreshToken: first.refresh_token, clientId: client._id }), null,
        'the consumed refresh token is dead');
    assert.ok(await oauth.resolveAccessToken(second.access_token), 'the new access token works');
});

test('a refresh token is not accepted as a bearer credential', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const issued = await oauth.issueTokens({ userId: 'u1', clientId: 'mcpc_x', scope: 'mcp' });
    // Distinct prefixes exist precisely so this confusion is impossible.
    assert.equal(await oauth.resolveAccessToken(issued.refresh_token), null,
        'presenting a refresh token to the resource server authenticates nothing');
    assert.equal(await oauth.resolveAccessToken('sp_live_some_api_key'), null, 'an API key is not an OAuth token');
    assert.equal(await oauth.resolveAccessToken(''), null);
});

test('revocation is immediate, which is why tokens are stored rather than signed', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const issued = await oauth.issueTokens({ userId: 'u-revoke', clientId: 'mcpc_x', scope: 'mcp' });
    assert.ok(await oauth.resolveAccessToken(issued.access_token), 'works before revocation');

    await oauth.revokeAllForUser('u-revoke');
    assert.equal(await oauth.resolveAccessToken(issued.access_token), null,
        'a revoked token stops working at once, not when it would have expired');
});

test('an expired access token does not authenticate', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const issued = await oauth.issueTokens({ userId: 'u-exp', clientId: 'mcpc_x', scope: 'mcp' });
    const hashed = crypto.createHash('sha256').update(issued.access_token).digest('hex');
    await mongoose.connection.collection('oauth_tokens')
        .updateOne({ _id: hashed }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    assert.equal(await oauth.resolveAccessToken(issued.access_token), null, 'expiry is enforced on read');

    await oauth.pruneExpired();
    assert.equal(await mongoose.connection.collection('oauth_tokens').countDocuments({ _id: hashed }), 0,
        'pruning clears the expired row');
});

test('scopes and the RFC 8707 resource are carried from code to token and refresh', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const client = await oauth.registerClient({ clientName: 'ChatGPT', redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'] });
    const { verifier, challenge } = pkcePair();
    const code = await oauth.issueCode({
        clientId: client._id,
        userId: 'user-scopes',
        redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scope: 'financials:read filings:read research:read',
        resource: 'https://www.stockportfolio.pro/mcp/apps'
    });

    const redeemed = await oauth.redeemCode({
        code,
        clientId: client._id,
        redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        codeVerifier: verifier,
        resource: 'https://www.stockportfolio.pro/mcp/apps'
    });
    assert.equal(redeemed.resource, 'https://www.stockportfolio.pro/mcp/apps', 'the code keeps the resource binding');

    const issued = await oauth.issueTokens(redeemed);
    assert.equal(issued.scope, 'financials:read filings:read research:read');
    const resolved = await oauth.resolveAccessToken(issued.access_token);
    assert.deepEqual(resolved.scopes, ['financials:read', 'filings:read', 'research:read']);
    assert.equal(resolved.resource, 'https://www.stockportfolio.pro/mcp/apps');

    const rotated = await oauth.refresh({ refreshToken: issued.refresh_token, clientId: client._id });
    const afterRefresh = await oauth.resolveAccessToken(rotated.access_token);
    assert.deepEqual(afterRefresh.scopes, ['financials:read', 'filings:read', 'research:read'], 'refresh preserves scopes');
    assert.equal(afterRefresh.resource, 'https://www.stockportfolio.pro/mcp/apps', 'refresh preserves the resource binding');
});

test('a code minted for one resource cannot be redeemed against another', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const client = await oauth.registerClient({ clientName: 'c', redirectUris: ['https://a.example/cb'] });
    const { verifier, challenge } = pkcePair();
    const code = await oauth.issueCode({
        clientId: client._id, userId: 'u1', redirectUri: 'https://a.example/cb',
        codeChallenge: challenge, codeChallengeMethod: 'S256',
        resource: 'https://www.stockportfolio.pro/mcp'
    });
    assert.equal(
        await oauth.redeemCode({
            code, clientId: client._id, redirectUri: 'https://a.example/cb',
            codeVerifier: verifier, resource: 'https://www.stockportfolio.pro/mcp/apps'
        }),
        null,
        'the token endpoint cannot move a code to a different MCP endpoint'
    );
});

test('a legacy token with no stored scope resolves as the mcp scope, not as full access', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const issued = await oauth.issueTokens({ userId: 'u-legacy', clientId: 'mcpc_x' });
    const resolved = await oauth.resolveAccessToken(issued.access_token);
    assert.deepEqual(resolved.scopes, ['mcp']);
    assert.equal(resolved.resource, null);
});

// ---------------------------------------------------------------------------
// Client secrets (2026-10-09): Microsoft 365 Copilot and Perplexity will not
// connect to a server whose registration issues none. Everyone already
// connected is a public client and must stay exactly as they were.
// ---------------------------------------------------------------------------

test('a client that asks for no secret still gets none, as before', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    for (const authMethod of [undefined, 'none', '', 'private_key_jwt']) {
        const client = await oauth.registerClient({ clientName: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], authMethod });
        assert.equal(client.clientSecret, undefined, `no secret for method ${JSON.stringify(authMethod)}`);
        assert.equal(client.secretHash, undefined);
        assert.equal(await oauth.clientIsConfidential(client._id), false);
        // Public clients are not authenticated at the token endpoint; PKCE binds the exchange.
        assert.equal(await oauth.authenticateClient({ clientId: client._id }), true);
        assert.equal(await oauth.authenticateClient({ clientId: client._id, clientSecret: 'anything' }), true);
    }
});

test('a confidential client is issued a secret, stored only as a hash, and must present it', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    for (const authMethod of ['client_secret_post', 'client_secret_basic']) {
        const client = await oauth.registerClient({ clientName: 'Copilot', redirectUris: ['https://a.example/cb'], authMethod });
        assert.match(client.clientSecret, /^sp_mcps_[0-9a-f]{64}$/);
        assert.equal(client.authMethod, authMethod);
        const stored = await mongoose.connection.collection('oauth_clients').findOne({ _id: client._id });
        assert.equal(stored.clientSecret, undefined, 'the raw secret is never stored');
        assert.ok(!JSON.stringify(stored).includes(client.clientSecret));
        assert.match(stored.secretHash, /^[0-9a-f]{64}$/);

        assert.equal(await oauth.clientIsConfidential(client._id), true);
        assert.equal(await oauth.authenticateClient({ clientId: client._id, clientSecret: client.clientSecret }), true);
        assert.equal(await oauth.authenticateClient({ clientId: client._id }), false, 'no secret, no token');
        assert.equal(await oauth.authenticateClient({ clientId: client._id, clientSecret: `${client.clientSecret}0` }), false);
        assert.equal(await oauth.authenticateClient({ clientId: client._id, clientSecret: 'sp_mcps_wrong' }), false);
    }
});

test('Perplexity and Microsoft registrations get a secret even when they register as public', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    for (const uri of ['https://www.perplexity.ai/rest/connections/oauth_callback', 'https://perplexity.ai/cb', 'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect']) {
        const client = await oauth.registerClient({ clientName: 'x', redirectUris: [uri], authMethod: 'none' });
        assert.match(client.clientSecret, /^sp_mcps_/, uri);
        assert.equal(client.authMethod, 'none', 'it asked to be public and is recorded as public');
        assert.equal(await oauth.clientIsConfidential(client._id), false);
        // The secret is optional for it, but a wrong one is never waved through.
        assert.equal(await oauth.authenticateClient({ clientId: client._id }), true);
        assert.equal(await oauth.authenticateClient({ clientId: client._id, clientSecret: client.clientSecret }), true);
        assert.equal(await oauth.authenticateClient({ clientId: client._id, clientSecret: 'wrong' }), false);
    }
    // A lookalike host is not on the list.
    for (const uri of ['https://perplexity.ai.evil.example/cb', 'https://notperplexity.ai/cb', 'https://evil.example/perplexity.ai']) {
        const client = await oauth.registerClient({ clientName: 'x', redirectUris: [uri], authMethod: 'none' });
        assert.equal(client.clientSecret, undefined, uri);
    }
    assert.deepEqual(oauth.secretRedirectHosts({ OAUTH_SECRET_REDIRECT_HOSTS: ' Example.com , ' }), ['perplexity.ai', 'teams.microsoft.com', 'example.com']);
});

test('a confidential client’s refresh token cannot be used by leaving the client out', { timeout: 60000 }, async (t) => {
    await withMongo(t);
    const flow = async (client) => {
        const { verifier, challenge } = pkcePair();
        const code = await oauth.issueCode({ clientId: client._id, userId: 'user-1', redirectUri: client.redirectUris[0], codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'mcp' });
        return oauth.issueTokens(await oauth.redeemCode({ code, clientId: client._id, redirectUri: client.redirectUris[0], codeVerifier: verifier }));
    };
    const confidential = await oauth.registerClient({ clientName: 'c', redirectUris: ['https://a.example/cb'], authMethod: 'client_secret_post' });
    const first = await flow(confidential);
    assert.equal(await oauth.refresh({ refreshToken: first.refresh_token, clientId: '' }), null, 'an unnamed, unauthenticated caller is refused');
    const second = await flow(confidential);
    assert.ok(await oauth.refresh({ refreshToken: second.refresh_token, clientId: confidential._id }), 'the authenticated client refreshes');

    // A public client keeps the behaviour it had: a refresh that names no client still works.
    const pub = await oauth.registerClient({ clientName: 'p', redirectUris: ['https://b.example/cb'] });
    const third = await flow(pub);
    assert.ok(await oauth.refresh({ refreshToken: third.refresh_token, clientId: '' }));
});

// ---------------------------------------------------------------------------
// RFC 9207 (`iss`) and authorize-page telemetry — asserted against the app.js
// source, same pattern as test/api-access-gating.test.js: requiring app.js
// boots the whole server, and these routes live only there.
// ---------------------------------------------------------------------------

test('every authorization redirect carries iss = the metadata issuer, and the metadata says so', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

    // GET /oauth/authorize: fail() is the one helper every error redirect goes
    // through, and it must stamp iss on the URL it redirects to.
    const authorize = src.slice(src.indexOf("app.get('/oauth/authorize'"), src.indexOf("app.get('/oauth/session'"));
    const fail = authorize.slice(authorize.indexOf('const fail = (code, description)'), authorize.indexOf("if (String(q.response_type || '') !== 'code')"));
    assert.match(fail, /url\.searchParams\.set\('iss', oauthBase\(req\)\)/, 'fail() stamps iss on every error redirect');

    // POST /oauth/authorize/decision: one shared `url` carries the code and
    // every error, so iss set on it reaches all of them.
    const decision = src.slice(src.indexOf("app.post('/oauth/authorize/decision'"), src.indexOf("app.post('/oauth/token'"));
    assert.match(decision, /url\.searchParams\.set\('iss', oauthBase\(req\)\)/, 'the decision route stamps iss on its shared redirect URL');

    // The value must equal what the discovery documents publish as `issuer`:
    // both are oauthBase(req).
    const metadata = src.slice(src.indexOf("app.get('/.well-known/oauth-authorization-server'"), src.indexOf("app.get('/.well-known/openid-configuration'"));
    assert.match(metadata, /issuer: base/, 'the authorization-server document publishes an issuer');
    assert.match(src.slice(src.indexOf('function oauthBase(req)'), src.indexOf('const OAUTH_SCOPES =')), /`\$\{proto\}:\/\/\$\{host\}`/, 'oauthBase is the same origin the iss parameter uses');

    // The RFC 9207 capability flag, on both discovery documents.
    const openidStart = src.indexOf("app.get('/.well-known/openid-configuration'");
    const openid = src.slice(openidStart, src.indexOf('app.get(\'/oauth/userinfo\''));
    assert.match(metadata, /authorization_response_iss_parameter_supported: true/, 'the AS metadata declares the iss parameter');
    assert.match(openid, /authorization_response_iss_parameter_supported: true/, 'and so does the OIDC discovery document');
});

test('the authorize view is measured: the event is registered and recorded before rendering', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const growth = require('../growth-measurement');
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

    // trackFunnel silently drops unregistered names (normalizeEventName), so
    // the registration IS the feature. mcp_apps_keyless_cap_hit was emitted
    // from app.js but unregistered until 2026-10-20 — it logged nothing.
    assert.equal(growth.EVENT_NAMES.has('mcp_oauth_authorize_view'), true, 'the authorize-view event is canonical');
    assert.equal(growth.EVENT_NAMES.has('mcp_apps_keyless_cap_hit'), true, 'the Apps-surface cap hit is canonical too');

    // The view is recorded after client + redirect validation and before either
    // consent screen renders, deduped per client per signed-in state per day,
    // and skipping review accounts like mcp_oauth_authorized does.
    const authorize = src.slice(src.indexOf("app.get('/oauth/authorize'"), src.indexOf("app.get('/oauth/session'"));
    const viewCall = authorize.slice(authorize.indexOf('if (!user || !user.reviewAccount)'), authorize.indexOf('const selfUrl = oauthBase(req) + req.originalUrl;'));
    assert.ok(viewCall.length > 0, 'the authorize-view call sits before the render');
    assert.match(viewCall, /dedupeKey: `mcp_oauth_authorize_view:\$\{clientId\}:\$\{user \? 1 : 0\}:\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}`/);
    assert.match(viewCall, /signedIn: Boolean\(user\)/);
    assert.match(viewCall, /hasAccess: Boolean\(user && hasApiAccess\(/);
    assert.match(viewCall, /if \(!user \|\| !user\.reviewAccount\)/, 'review accounts are excluded, as for mcp_oauth_authorized');

    // The cohort reads it back alongside the Apps-surface cap hits.
    const cohort = src.slice(src.indexOf('async function collectMcpCohort'), src.indexOf('function marketingDashboardOnly'));
    assert.match(cohort, /'mcp_apps_keyless_cap_hit'/, 'Apps cap hits are counted');
    assert.match(cohort, /appsCapHits/, 'and broken out');
    assert.match(cohort, /authorizeViews/, 'authorize views are counted');
    assert.match(cohort, /authorizeViewsSignedIn/, 'including the signed-in share');
});
