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
