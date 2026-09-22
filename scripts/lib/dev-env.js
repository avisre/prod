'use strict';

/**
 * Guards for scripts that run against a LOCAL database but need the real AI
 * provider credentials.
 *
 * The hazard these exist for, twice realised:
 *   backend/.env carries BOTH the provider keys AND the production Atlas
 *   MONGODB_URI. Any script that calls dotenv.config({path: backend/.env}) to
 *   get an API key silently inherits the production database too — and dotenv
 *   never overrides an already-set variable, so nothing downstream stops it.
 *   That is how a local review session wrote cache collections into the live
 *   database on 2026-09-07, and how a model-comparison harness deleted live
 *   company_keypoints rows on 2026-09-22.
 *
 * loadAiEnvOnly() parses that file WITHOUT applying it, then copies across an
 * explicit allowlist. An allowlist fails closed: a key nobody thought about
 * stays behind, rather than leaking in because it was not on a denylist.
 *
 * assertLocalMongo() is the backstop for when the allowlist is wrong anyway.
 */

const fs = require('fs');
const path = require('path');

// Everything the AI surfaces need to reach the provider, and nothing else.
// Deliberately absent: MONGODB_URI, STRIPE_*, SMTP_*, JWT_SECRET, GOOGLE_*,
// ADMIN_TOKEN, AFFILIATE_* — a local harness has no business with any of them.
const AI_ENV_ALLOWLIST = [
    'OLLAMA_API_KEY',
    'AI_BRIEFING_API_KEY',
    'AI_BRIEFING_BASE_URL',
    'OPENROUTER_API_KEY',
    'AI_MODEL_CHAT',
    'AI_MODEL_SUMMARY',
    'AI_MODEL_BRIEFING',
    'AI_MODEL_VISION',
    'AI_SUMMARY_REASONING_EFFORT',
    'AI_CHAT_REASONING_EFFORT',
    // market-data key; not a secret store and not a database
    'ALPHA_VANTAGE_API_KEY'
];

/**
 * Copy the allowlisted AI variables out of backend/.env into process.env,
 * without applying anything else from that file. Existing values win, so a
 * caller can still override on the command line.
 * Returns { loaded: [...names], missing: [...names] } for banner printing.
 */
function loadAiEnvOnly(backendDir) {
    const file = path.join(backendDir, '.env');
    let parsed = {};
    try {
        const dotenv = require(path.join(backendDir, 'node_modules', 'dotenv'));
        parsed = dotenv.parse(fs.readFileSync(file)); // parse, never config
    } catch (e) {
        return { loaded: [], missing: AI_ENV_ALLOWLIST.slice(), error: e.message };
    }
    const loaded = [];
    const missing = [];
    for (const key of AI_ENV_ALLOWLIST) {
        if (process.env[key] !== undefined) continue; // caller's value wins
        if (parsed[key] === undefined || parsed[key] === '') { missing.push(key); continue; }
        process.env[key] = parsed[key];
        loaded.push(key);
    }
    return { loaded, missing };
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/**
 * Throw unless the URI points at a database on this machine. Called before any
 * connect, and again after any env loading, so a future edit that admits
 * MONGODB_URI to the allowlist crashes the script instead of writing to Atlas.
 */
function assertLocalMongo(uri, context = 'this script') {
    const raw = String(uri || '');
    if (!raw) throw new Error(`[dev-env] No MONGODB_URI set — ${context} refuses to guess.`);
    // mongodb+srv:// is Atlas by construction; never local.
    if (/^mongodb\+srv:/i.test(raw)) {
        throw new Error(`[dev-env] REFUSING TO RUN: MONGODB_URI is a mongodb+srv:// (Atlas) URI. ${context} only runs against a local database.`);
    }
    let hosts = [];
    try {
        // mongodb://[user:pass@]host1[:p][,host2[:p]]/db?opts
        const after = raw.replace(/^mongodb:\/\//i, '');
        const hostPart = after.split('/')[0].split('@').pop();
        hosts = hostPart.split(',').map((h) => h.split(':')[0].trim()).filter(Boolean);
    } catch (_) { hosts = []; }
    if (!hosts.length) throw new Error(`[dev-env] Could not parse a host out of MONGODB_URI — ${context} refuses to connect.`);
    const remote = hosts.filter((h) => !LOCAL_HOSTS.has(h));
    if (remote.length) {
        throw new Error(`[dev-env] REFUSING TO RUN: MONGODB_URI host ${remote.join(', ')} is not local. ${context} only runs against a local database.`);
    }
    return true;
}

/** Redacted form for banners — never print a key. */
function maskKey(v) {
    const s = String(v || '');
    return s ? `set (…${s.slice(-4)})` : 'MISSING';
}

module.exports = { loadAiEnvOnly, assertLocalMongo, maskKey, AI_ENV_ALLOWLIST };
