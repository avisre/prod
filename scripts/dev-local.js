#!/usr/bin/env node
/**
 * dev-local.js — run the app locally without touching production.
 *
 * `node backend/app.js` on a laptop connects to the PRODUCTION Atlas cluster:
 * backend/.env carries the real MONGODB_URI, and dotenv never overrides a
 * variable already present in process.env, so nothing in the app stops it.
 * That is how a local review session ended up writing cache collections into
 * the live database on 2026-09-07.
 *
 * This launcher sets the environment BEFORE requiring the app, so the app boots
 * against a throwaway in-process MongoDB (mongodb-memory-server, already a
 * dependency — nothing to install) and can never reach Atlas. It also seeds one
 * signed-in Pro account so the gated features render.
 *
 * NOTE: stop this before running `npm test`. The suite spins up its own
 * mongodb-memory-server instances, and leaving this one running makes several
 * database-backed tests fail spuriously (measured: 4 failures that all pass
 * individually and disappear once this process is stopped).
 *
 * Usage:  node scripts/dev-local.js          (defaults to port 5055)
 *         PORT=3000 node scripts/dev-local.js
 */

const path = require('path');
const BACKEND = path.join(__dirname, '..', 'backend');
const { MongoMemoryServer } = require(path.join(BACKEND, 'node_modules', 'mongodb-memory-server'));
const bcrypt = require(path.join(BACKEND, 'node_modules', 'bcryptjs'));
const { MongoClient, ObjectId } = require(path.join(BACKEND, 'node_modules', 'mongodb'));

// FIXED id, not a generated one. The in-memory database starts empty on every
// restart, so a fresh ObjectId each boot leaves the browser holding a JWT that
// references a user who no longer exists — the session dies silently and every
// gated call answers 401 "Invalid token". A stable id keeps you signed in
// across restarts, which matters because iterating on CSS means restarting a lot.
const DEV_USER_ID = new ObjectId('000000000000000000000001');

const DEV_EMAIL = 'dev@localhost.test';
const DEV_PASSWORD = 'devlocal';

async function main() {
    const mongo = await MongoMemoryServer.create();
    const uri = `${mongo.getUri()}devlocal`;

    // Set before requiring the app: dotenv leaves existing values alone, so
    // these win over backend/.env.
    process.env.MONGODB_URI = uri;
    process.env.PORT = process.env.PORT || '5055';
    process.env.AI_PRO_FOR_ALL = '1';              // gated features render
    // app.js falls back to crypto.randomBytes(32) when JWT_SECRET is unset
    // outside production — and it IS unset here, because app.js loads dotenv
    // relative to the working directory and this launcher runs from the repo
    // root, where there is no .env (that is deliberate: backend/.env carries the
    // production Mongo URI). Without a fixed secret every restart silently
    // invalidates the browser's session and gated calls answer 401.
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-local-fixed-secret-not-for-production';
    process.env.REQUIRE_ACTIVE_SUBSCRIPTION = 'false';
    process.env.REQUIRE_INITIAL_STRIPE_PAYMENT = 'false';

    const client = new MongoClient(uri);
    await client.connect();
    await client.db().collection('users').insertOne({
        _id: DEV_USER_ID,
        name: 'Dev Local',
        email: DEV_EMAIL,
        password: await bcrypt.hash(DEV_PASSWORD, 10),
        authVersion: 0,
        subscription: {
            planId: 'pro',
            status: 'active',
            currentPeriodEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000)
        },
        createdAt: new Date()
    });
    await client.close();

    console.log('─'.repeat(64));
    console.log('  Local dev server — in-memory database, production untouched');
    console.log(`  http://localhost:${process.env.PORT}`);
    console.log(`  sign in:  ${DEV_EMAIL}  /  ${DEV_PASSWORD}`);
    console.log('  data is discarded when this process exits');
    console.log('─'.repeat(64));

    require(path.join(BACKEND, 'app.js'));

    const shutdown = async () => { await mongo.stop().catch(() => {}); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => { console.error(error); process.exit(1); });
