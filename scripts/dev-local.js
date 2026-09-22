#!/usr/bin/env node
/**
 * dev-local.js — run the whole app locally without touching production.
 *
 * `node backend/app.js` on a laptop connects to the PRODUCTION Atlas cluster:
 * backend/.env carries the real MONGODB_URI, and dotenv never overrides a
 * variable already present in process.env, so nothing in the app stops it.
 * That is how a local review session ended up writing cache collections into
 * the live database on 2026-09-07, and how a model-comparison harness deleted
 * live company_keypoints rows on 2026-09-22.
 *
 * This launcher sets the environment BEFORE requiring the app, so the app boots
 * against a throwaway in-process MongoDB (mongodb-memory-server, already a
 * dependency) and can never reach Atlas. The provider credentials are pulled in
 * through an allowlist (scripts/lib/dev-env.js) that deliberately cannot carry
 * MONGODB_URI across.
 *
 * It seeds two signed-in accounts, mints their API keys, and prints a runbook
 * so the web UI, the REST API, the MCP endpoint and the admin usage dashboard
 * are all immediately exercisable.
 *
 * NOTE: stop this before running `npm test`. The suite spins up its own
 * mongodb-memory-server instances, and leaving this one running makes several
 * database-backed tests fail spuriously (measured: 4 failures that all pass
 * individually and disappear once this process is stopped).
 *
 * Usage:  node scripts/dev-local.js                 (port 5055)
 *         PORT=3000 node scripts/dev-local.js
 *         WALL_ALL_PAGES=true SIGNUP_TRIAL_DAYS=3 REQUIRE_INITIAL_STRIPE_PAYMENT=true \
 *           node scripts/dev-local.js               (reproduce the production wall)
 */

const path = require('path');
const BACKEND = path.join(__dirname, '..', 'backend');
const { MongoMemoryServer } = require(path.join(BACKEND, 'node_modules', 'mongodb-memory-server'));
const bcrypt = require(path.join(BACKEND, 'node_modules', 'bcryptjs'));
const { MongoClient, ObjectId } = require(path.join(BACKEND, 'node_modules', 'mongodb'));
const { loadAiEnvOnly, assertLocalMongo, maskKey } = require('./lib/dev-env');
const { hashKey, KEY_PREFIX } = require(path.join(BACKEND, 'api-keys'));

// FIXED ids, not generated ones. The in-memory database starts empty on every
// restart, so a fresh ObjectId each boot leaves the browser holding a JWT that
// references a user who no longer exists — the session dies silently and every
// gated call answers 401 "Invalid token". Stable ids keep you signed in across
// restarts, which matters because iterating means restarting a lot.
const DESK_USER_ID = new ObjectId('000000000000000000000001');
const DEV_USER_ID = new ObjectId('000000000000000000000002');

// `rin@gmail.com` is what marketingDashboardOnly (app.js:13224-13229) hardcodes,
// with no env override. Seeding that address locally is what unlocks
// /admin/ollama — and it needs no change to production's auth surface.
const DESK_EMAIL = process.env.DEV_LOCAL_EMAIL || 'rin@gmail.com';
const DEV_EMAIL = 'devapi@localhost.test';
const PASSWORD = 'devlocal';

// Plan choice matters. hasApiAccess (app.js:158-175) wants power|power-monthly|
// desk|dev; monitorGate (app.js:131-145) wants power|power-monthly|desk|
// enterprise|pro-annual. `desk` is in both AND carries the 10,000-credit floor
// (credits.js:171), which a benchmark needs since api_ask costs 8 a call. The
// previous seed of `pro` passed neither gate, so every API/MCP/Monitor call 402'd.
const DESK_PLAN = process.env.DEV_LOCAL_PLAN || 'desk';

// Fixed keys, same reasoning as the fixed user ids and JWT secret: a key that
// regenerates each boot means re-editing your MCP client config every restart.
// These unlock nothing but a throwaway in-memory database.
const DESK_KEY = process.env.DEV_LOCAL_API_KEY || KEY_PREFIX + 'de5c'.repeat(12);
const DEV_KEY = KEY_PREFIX + 'de7a'.repeat(12);

function seedUser({ _id, email, planId, name }) {
    return {
        _id,
        name,
        email,
        password: bcrypt.hashSync(PASSWORD, 10),
        authVersion: 0,
        subscription: { planId, status: 'active', currentPeriodEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000) },
        createdAt: new Date()
    };
}

function apiKeyDoc(userId, rawKey, label) {
    return {
        userId: String(userId),
        keyHash: hashKey(rawKey),
        keyPrefix: rawKey.slice(0, KEY_PREFIX.length + 6),
        label,
        createdAt: new Date(),
        revokedAt: null,
        lastUsedAt: null
    };
}

async function main() {
    const mongo = await MongoMemoryServer.create();
    const uri = `${mongo.getUri()}devlocal`;
    assertLocalMongo(uri, 'dev-local.js'); // memory-server is local by definition; assert anyway

    // Set before requiring the app: dotenv leaves existing values alone, so
    // these win over backend/.env.
    process.env.MONGODB_URI = uri;
    process.env.PORT = process.env.PORT || '5055'; // 5000 is taken by macOS Control Center
    // app.js:79 compares === 'true'. The old value here was '1', which silently
    // did nothing for years.
    process.env.AI_PRO_FOR_ALL = 'true';
    // app.js falls back to crypto.randomBytes(32) when JWT_SECRET is unset
    // outside production — and it IS unset here, because app.js loads dotenv
    // relative to the working directory and this launcher runs from the repo
    // root, where there is no .env (that is deliberate: backend/.env carries the
    // production Mongo URI). Without a fixed secret every restart silently
    // invalidates the browser's session and gated calls answer 401.
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-local-fixed-secret-not-for-production';

    // Provider credentials, allowlisted — never the whole of backend/.env.
    const ai = loadAiEnvOnly(BACKEND);
    // Belt: if the allowlist is ever widened to admit MONGODB_URI, crash here
    // rather than write to Atlas.
    assertLocalMongo(process.env.MONGODB_URI, 'dev-local.js (post-env-load)');

    // Set-if-unset so the real production paths stay locally testable.
    const setIfUnset = (k, v) => { if (process.env[k] === undefined) process.env[k] = v; };
    setIfUnset('REQUIRE_ACTIVE_SUBSCRIPTION', 'false');
    setIfUnset('REQUIRE_INITIAL_STRIPE_PAYMENT', 'false');
    // Background sweeps. WATCHDOG matters for more than tidiness: it calls
    // filing-diff.computeFilingDiff, which is PAID inference, and it would
    // pollute ollama_usage_events in the middle of a benchmark.
    setIfUnset('DISABLE_BACKGROUND_JOBS', '1');
    setIfUnset('WATCHDOG', '0');
    setIfUnset('GURU_PREWARM', '0');
    setIfUnset('PREWARM', 'off');
    // Local limits, raised so a benchmark is not throttled by abuse guards.
    setIfUnset('PUBLIC_API_RATE_LIMIT', '6000');
    setIfUnset('ANON_MCP_ASK_LIMIT', '1000');
    setIfUnset('ANON_MCP_LOOKUP_LIMIT', '10000');
    setIfUnset('ANON_MCP_GLOBAL_ASK_DAY', '10000');
    setIfUnset('ANON_MCP_RATE_LIMIT', '600');
    // The bot blocker treats a client with no sec-fetch-* / accept-language
    // header as automated (bot-blocker.js:120) and rate-limits page navigations
    // to 100 per 5 min (navMax). Both are right in production and both make a
    // local rig fight itself: curl gets a 403 on every HTML page, and clicking
    // around quickly exhausts the nav budget. Dry-run keeps the detection
    // running and counting, but stops it blocking.
    setIfUnset('BOT_BLOCK_DRY_RUN', 'true');
    setIfUnset('BOT_BLOCK_NAV_MAX', '100000');

    const client = new MongoClient(uri);
    await client.connect();
    await client.db().collection('users').insertMany([
        seedUser({ _id: DESK_USER_ID, email: DESK_EMAIL, planId: DESK_PLAN, name: 'Dev Local' }),
        // The `dev` plan is the only one where userTier() reads 'free' while
        // hasApiAccess() is true — the shape that catches web features leaking
        // to API-only subscribers.
        seedUser({ _id: DEV_USER_ID, email: DEV_EMAIL, planId: 'dev', name: 'Dev API Only' })
    ]);
    await client.db().collection('api_keys').insertMany([
        apiKeyDoc(DESK_USER_ID, DESK_KEY, 'dev-local desk'),
        apiKeyDoc(DEV_USER_ID, DEV_KEY, 'dev-local dev-plan')
    ]);
    await client.close();

    const app = require(path.join(BACKEND, 'app.js'));

    // Dev-only model switch. The REST and MCP surfaces resolve the model from
    // the SERVER's env (ai-client.js cfg(), read lazily per call), so a
    // benchmark in another process cannot interleave models over HTTP without
    // this. Lives here, not in app.js, so production has no code path to it.
    app.post('/__dev/model', require(path.join(BACKEND, 'node_modules', 'express')).json(), (req, res) => {
        if (process.env.NODE_ENV === 'production') return res.sendStatus(404);
        const { model, effort } = req.body || {};
        if (model) {
            process.env.AI_MODEL_CHAT = model;
            process.env.AI_MODEL_SUMMARY = model;
            process.env.AI_MODEL_BRIEFING = model;
        }
        if (effort === null || effort === '') {
            delete process.env.AI_CHAT_REASONING_EFFORT;
            process.env.AI_SUMMARY_REASONING_EFFORT = '';
        } else if (effort) {
            process.env.AI_CHAT_REASONING_EFFORT = effort;
            process.env.AI_SUMMARY_REASONING_EFFORT = effort;
        }
        res.json({
            ok: true,
            model: process.env.AI_MODEL_CHAT,
            chatEffort: process.env.AI_CHAT_REASONING_EFFORT || '(provider default)',
            summaryEffort: process.env.AI_SUMMARY_REASONING_EFFORT || '(omitted)'
        });
    });

    const port = process.env.PORT;
    const base = `http://localhost:${port}`;
    const line = '─'.repeat(72);
    const aiReady = !!(process.env.OLLAMA_API_KEY || process.env.AI_BRIEFING_API_KEY);

    // Printed after the routes are mounted so nothing here is a promise the
    // server has not actually kept.
    setTimeout(() => {
        console.log(`\n${line}`);
        console.log('  LOCAL DEV SERVER — in-memory database, production untouched');
        console.log(line);
        console.log(`  Web            ${base}`);
        console.log(`  Sign in        ${DESK_EMAIL}  /  ${PASSWORD}      (plan: ${DESK_PLAN})`);
        console.log(`  API-only user  ${DEV_EMAIL}  /  ${PASSWORD}      (plan: dev)`);
        console.log(`  Provider key   OLLAMA_API_KEY ${maskKey(process.env.OLLAMA_API_KEY)}`);
        if (!aiReady) {
            console.log('  ⚠  NO PROVIDER KEY — every AI surface will serve deterministic');
            console.log('     templates. Ask, dossier and monitor will look like they work.');
        }
        console.log(`  Model          ${process.env.AI_MODEL_CHAT || 'glm-5.1 (ai-client fallback)'}`);
        console.log(line);
        console.log('  CLICK THROUGH');
        console.log(`    ${base}/dashboard`);
        console.log(`    ${base}/company?symbol=AAPL`);
        console.log(`    ${base}/ask`);
        console.log(`    ${base}/dossier?symbol=AAPL`);
        console.log(`    ${base}/monitor`);
        console.log(`    ${base}/compare/AAPL-vs-MSFT`);
        console.log(`    ${base}/admin/ollama        ← live token usage per call`);
        console.log(line);
        console.log('  REST API');
        console.log(`    Key (desk):  ${DESK_KEY}`);
        console.log(`    Key (dev):   ${DEV_KEY}`);
        console.log(`    curl ${base}/api/v1/health`);
        console.log(`    curl -H 'X-Api-Key: ${DESK_KEY}' \\`);
        console.log(`         '${base}/api/v1/financials/AAPL?tool=earnings-quality'     # 2 credits`);
        console.log(`    curl -H 'X-Api-Key: ${DESK_KEY}' -H 'Content-Type: application/json' \\`);
        console.log(`         -d '{"question":"How did AAPL do last year?"}' \\`);
        console.log(`         ${base}/api/v1/ask                                          # 8 credits`);
        console.log(line);
        console.log('  MCP');
        console.log(`    Endpoint     POST ${base}/mcp   (Streamable HTTP, stateless)`);
        console.log('    Keyless      send no auth header at all (mcp-anon limits raised locally)');
        console.log(`    Keyed        X-Api-Key: ${DESK_KEY}`);
        console.log('    Raw curl needs  Accept: application/json, text/event-stream  and an');
        console.log('    initialize handshake — the reliable client is the SDK transport, as in');
        console.log('    backend/test/mcp-endpoint.test.js:46-50.');
        console.log('    Claude Desktop via the bridge (overrides its hardcoded prod URL):');
        console.log(`      STOCKPORTFOLIO_MCP_URL=${base}/mcp  STOCKPORTFOLIO_API_KEY=${DESK_KEY} \\`);
        console.log('        node mcp-server/src/bridge.js');
        console.log(line);
        console.log('  BENCHMARK');
        console.log(`    node scripts/bench-model-latency.js --profile quick --server ${base} \\`);
        console.log(`      --api-key ${DESK_KEY}`);
        console.log(line);
        console.log('  Data is discarded when this process exits.');
        console.log('  STOP THIS before running `npm test` (both use mongodb-memory-server).');
        console.log(`${line}\n`);
    }, 400);

    const shutdown = async () => { await mongo.stop().catch(() => {}); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => { console.error(error); process.exit(1); });
