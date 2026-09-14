'use strict';

// OAuth 2.1 + Dynamic Client Registration for the hosted MCP endpoint.
//
// WHY THIS EXISTS: ChatGPT and claude.ai are full MCP clients, but neither can
// send a static `Authorization: Bearer sp_live_...` to a custom connector.
// ChatGPT mandates OAuth 2.1 + DCR and states bearer tokens are not accepted;
// claude.ai exposes only OAuth client id/secret fields in its advanced settings
// (anthropics/claude-ai-mcp#112 is the open request for static-header support).
// mcp-anon.js opened a keyless tier so those two products can reach the server
// at all — but a keyless caller gets 2 free asks and then a paywall it has no
// way to pass FROM INSIDE THAT CLIENT. This module is that missing step: it is
// the only route by which a paying customer can authenticate from a chatbot.
//
// Clients here are PUBLIC (no client_secret). That is deliberate and is what
// the MCP clients actually do: a connector registered by ChatGPT or claude.ai
// cannot keep a secret, so security rests on PKCE (S256) binding the token
// exchange to whoever started the flow, plus exact redirect_uri matching.
//
// Tokens are opaque random strings stored only as SHA-256 hashes — the same
// shape as api-keys.js, and for the same two reasons: a database disclosure
// must not yield usable credentials, and revocation has to be immediate rather
// than waiting for a JWT to expire. That rules out self-contained JWTs here
// even though the app already signs them elsewhere.

const crypto = require('crypto');
const mongoose = require('mongoose');

// Short-lived: the authorization code is a one-time bearer of the user's
// identity in a URL, where it lands in browser history and referrer headers.
// RFC 6749 recommends a maximum of ten minutes; five is ample for a redirect.
const CODE_TTL_MS = 5 * 60 * 1000;
// An access token is replayable for its lifetime, so it stays short and the
// refresh token carries longevity instead.
const ACCESS_TTL_MS = 60 * 60 * 1000;
// Long enough that a connector configured once keeps working without the user
// re-authorising every week, which is the whole point of a chatbot connector.
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const ACCESS_PREFIX = 'sp_mcp_';
const REFRESH_PREFIX = 'sp_mcr_';

function clients() { return mongoose.connection.collection('oauth_clients'); }
function codes() { return mongoose.connection.collection('oauth_codes'); }
function tokens() { return mongoose.connection.collection('oauth_tokens'); }

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(prefix) {
    return prefix + crypto.randomBytes(32).toString('hex');
}

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Redirect URI validation -------------------------------------------------
// The redirect_uri is the one thing standing between a registered client and
// an authorization code being delivered to an attacker, so it is validated at
// registration AND compared byte-for-byte at both /authorize and /token.
//
// http is permitted ONLY on loopback, which is not a loosening: native and
// desktop MCP clients (Claude Code among them) genuinely receive their callback
// on 127.0.0.1 with an ephemeral port, and OAuth 2.1 keeps loopback exactly for
// that case. Everything else must be https.
function isValidRedirectUri(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch (_) {
        return false;
    }
    if (url.hash) return false; // a fragment would silently drop the query we append
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
    // Custom schemes (myapp://callback) are how some native clients come back.
    return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && url.protocol !== 'javascript:' && url.protocol !== 'data:';
}

/**
 * Dynamic Client Registration (RFC 7591). Open registration by design — that is
 * what "dynamic" means here, and ChatGPT will not connect without it. The
 * exposure is bounded: a registration grants nothing on its own. A client can
 * only ever obtain a token by sending a real user through /authorize, where
 * that user must already be signed in and must consent, and the token it
 * receives is scoped to that one user's own wallet.
 */
async function registerClient({ clientName, redirectUris, softwareId } = {}) {
    const uris = Array.isArray(redirectUris) ? redirectUris.filter(Boolean).map(String) : [];
    if (!uris.length) {
        const err = new Error('At least one redirect_uri is required.');
        err.code = 'invalid_redirect_uri';
        throw err;
    }
    const invalid = uris.find((u) => !isValidRedirectUri(u));
    if (invalid) {
        const err = new Error(`redirect_uri is not acceptable: ${invalid}`);
        err.code = 'invalid_redirect_uri';
        throw err;
    }
    const clientId = 'mcpc_' + crypto.randomBytes(16).toString('hex');
    const doc = {
        _id: clientId,
        clientName: String(clientName || 'MCP client').slice(0, 200),
        redirectUris: uris,
        softwareId: softwareId ? String(softwareId).slice(0, 200) : null,
        createdAt: new Date()
    };
    await clients().insertOne(doc);
    return doc;
}

async function getClient(clientId) {
    if (!clientId) return null;
    return clients().findOne({ _id: String(clientId) });
}

/**
 * Issues a one-time authorization code bound to the user who consented, the
 * client that asked, the exact redirect_uri, and the PKCE challenge. Only the
 * hash is stored: the code lives in a URL, so a database copy of it would be a
 * second place the credential exists.
 */
async function issueCode({ clientId, userId, redirectUri, codeChallenge, codeChallengeMethod, scope }) {
    const raw = crypto.randomBytes(32).toString('hex');
    await codes().insertOne({
        _id: hash(raw),
        clientId: String(clientId),
        userId: String(userId),
        redirectUri: String(redirectUri),
        codeChallenge: String(codeChallenge),
        codeChallengeMethod: String(codeChallengeMethod || 'S256'),
        scope: String(scope || 'mcp'),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + CODE_TTL_MS)
    });
    return raw;
}

/**
 * Redeems a code exactly once. Every failure path returns null rather than a
 * reason, so the endpoint cannot be used to probe which codes exist.
 *
 * The delete is the concurrency control: findOneAndDelete is atomic in MongoDB,
 * so two simultaneous redemptions of the same stolen code cannot both win — the
 * loser gets null. Checking-then-deleting would leave exactly that race open.
 */
async function redeemCode({ code, clientId, redirectUri, codeVerifier }) {
    if (!code || !clientId || !codeVerifier) return null;
    const result = await codes().findOneAndDelete({ _id: hash(code) });
    const doc = result && (result.value !== undefined ? result.value : result);
    if (!doc || !doc._id) return null;

    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return null;
    if (doc.clientId !== String(clientId)) return null;
    // Exact match, not prefix: a "starts with" comparison lets an attacker who
    // controls a path under a registered origin receive the code.
    if (doc.redirectUri !== String(redirectUri)) return null;

    // PKCE. S256 only — "plain" offers no protection against an interception
    // that already has the authorization request, and OAuth 2.1 drops it.
    if (doc.codeChallengeMethod !== 'S256') return null;
    const derived = base64url(crypto.createHash('sha256').update(String(codeVerifier)).digest());
    // Fixed-length hex/base64url comparison, timing-safe.
    const a = Buffer.from(derived);
    const b = Buffer.from(String(doc.codeChallenge));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    return { userId: doc.userId, scope: doc.scope, clientId: doc.clientId };
}

async function issueTokens({ userId, clientId, scope }) {
    const accessToken = randomToken(ACCESS_PREFIX);
    const refreshToken = randomToken(REFRESH_PREFIX);
    const now = Date.now();
    await tokens().insertMany([
        {
            _id: hash(accessToken),
            type: 'access',
            userId: String(userId),
            clientId: String(clientId),
            scope: String(scope || 'mcp'),
            createdAt: new Date(now),
            expiresAt: new Date(now + ACCESS_TTL_MS)
        },
        {
            _id: hash(refreshToken),
            type: 'refresh',
            userId: String(userId),
            clientId: String(clientId),
            scope: String(scope || 'mcp'),
            createdAt: new Date(now),
            expiresAt: new Date(now + REFRESH_TTL_MS)
        }
    ]);
    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        scope: String(scope || 'mcp')
    };
}

/**
 * Resolves an access token to its owner. Returns null for anything expired,
 * revoked, unknown, or of the wrong type — a refresh token presented as a
 * bearer credential must not authenticate a request.
 */
async function resolveAccessToken(raw) {
    const value = String(raw || '');
    if (!value.startsWith(ACCESS_PREFIX)) return null;
    const doc = await tokens().findOne({ _id: hash(value), type: 'access' });
    if (!doc) return null;
    if (doc.revokedAt) return null;
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return null;
    return { userId: doc.userId, clientId: doc.clientId, scope: doc.scope };
}

/**
 * Refresh-token grant with rotation: the presented refresh token is consumed
 * and a new pair issued. Rotation is what makes a leaked refresh token
 * detectable and short-lived — replaying a consumed one simply fails.
 */
async function refresh({ refreshToken, clientId }) {
    const value = String(refreshToken || '');
    if (!value.startsWith(REFRESH_PREFIX)) return null;
    const result = await tokens().findOneAndDelete({ _id: hash(value), type: 'refresh' });
    const doc = result && (result.value !== undefined ? result.value : result);
    if (!doc || !doc._id) return null;
    if (doc.revokedAt) return null;
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return null;
    if (clientId && doc.clientId !== String(clientId)) return null;
    return issueTokens({ userId: doc.userId, clientId: doc.clientId, scope: doc.scope });
}

/** Revokes every token held by one user — used when they sign out everywhere. */
async function revokeAllForUser(userId) {
    await tokens().updateMany({ userId: String(userId), revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
}

// Expired rows are not self-cleaning without a TTL index, and this collection
// grows with every authorization. Called opportunistically rather than on a
// timer so it cannot become a background job that fails silently.
async function pruneExpired() {
    const now = new Date();
    await codes().deleteMany({ expiresAt: { $lt: now } });
    await tokens().deleteMany({ expiresAt: { $lt: now } });
}

module.exports = {
    ACCESS_PREFIX,
    REFRESH_PREFIX,
    CODE_TTL_MS,
    ACCESS_TTL_MS,
    REFRESH_TTL_MS,
    isValidRedirectUri,
    registerClient,
    getClient,
    issueCode,
    redeemCode,
    issueTokens,
    resolveAccessToken,
    refresh,
    revokeAllForUser,
    pruneExpired
};
