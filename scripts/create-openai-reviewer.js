#!/usr/bin/env node
'use strict';

// Creates (or resets) the dedicated OpenAI plugin reviewer account.
//
// Why a script and not a form: OpenAI's remote-MCP review requires a demo
// account that can exercise every submitted tool, needs no MFA/SMS/email
// verification, works off any network, and stays valid for the review. The
// product has no admin "create account" endpoint, and the self-serve signup
// path starts on the free plan with no API/MCP entitlement, so the account has
// to be provisioned directly with the entitlement attached.
//
// Credentials are NEVER stored in the repository. The password is generated at
// run time and printed once to stdout; the email is passed on the command line
// (or in OPENAI_REVIEW_EMAIL) and is the only field written to the database.
// The OpenAI submission form is where the credential pair is entered.
//
// Usage (dry run first — it only prints the document it would write):
//   MONGODB_URI="<production Atlas URI>" node scripts/create-openai-reviewer.js --email <address>
//   MONGODB_URI="<production Atlas URI>" node scripts/create-openai-reviewer.js --email <address> --apply
//
// MONGODB_URI is read from the environment and is never defaulted: this script
// must never fall back to backend/.env, because that file carries the
// production Atlas URI and a mistake there creates (or resets) a real account.

const crypto = require('crypto');
const path = require('path');
const bcrypt = require(path.join(__dirname, '..', 'backend', 'node_modules', 'bcryptjs'));
const mongoose = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mongoose'));

const REVIEW_PLAN = {
    planId: 'dev',
    planName: 'Dev — OpenAI plugin review',
    price: 0,
    currency: 'usd',
    billingInterval: 'month',
    stripePriceId: null,
    status: 'active',
    trialStartedAt: null,
    trialEndsAt: null,
    expiredAt: null,
    activatedAt: null,
    renewedAt: null,
    lastPaymentAt: null,
    chinaAnnualExpiresAt: null
};

function generatePassword() {
    // Long random password: no MFA on this account, so the password is the only
    // factor. base64url keeps it typeable; 24 bytes is ~144 bits.
    return crypto.randomBytes(24).toString('base64url');
}

function buildReviewerDoc({ email, name, passwordHash, now }) {
    const at = now || new Date();
    return {
        name: name || 'OpenAI Plugin Review',
        email: String(email).trim().toLowerCase(),
        password: passwordHash,
        authVersion: 0,
        subscription: {
            ...REVIEW_PLAN,
            trialStartedAt: at,
            activatedAt: at,
            renewedAt: at,
            lastPaymentAt: at
        },
        // Keep the review account out of every lifecycle mailer and out of
        // analytics: a reviewer must never be mailed, and their usage must not
        // look like customer traffic.
        digestOptOut: true,
        appsumoEmailsOptOut: true,
        trialEmailsOptOut: true,
        customerMessageEmailsOptOut: true,
        analyticsConsent: false,
        reviewAccount: true
    };
}

function usage() {
    return [
        'create-openai-reviewer.js — provision the OpenAI plugin review account.',
        '',
        '  MONGODB_URI="<uri>" node scripts/create-openai-reviewer.js --email <address> [--name "Name"] [--apply]',
        '',
        'Without --apply this is a dry run and writes nothing.',
        'The password is generated per run and printed once.',
        'MONGODB_URI must be supplied explicitly; backend/.env is deliberately not read.'
    ].join('\n');
}

function parseArgs(argv) {
    const args = { apply: false, email: process.env.OPENAI_REVIEW_EMAIL || '', name: process.env.OPENAI_REVIEW_NAME || '' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--apply') args.apply = true;
        else if (argv[i] === '--email') args.email = argv[++i] || '';
        else if (argv[i] === '--name') args.name = argv[++i] || '';
        else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    return args;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) { console.log(usage()); return 0; }
    if (!args.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email)) {
        console.error('A valid --email is required.\n');
        console.error(usage());
        return 1;
    }
    const uri = String(process.env.MONGODB_URI || '').trim();
    if (!uri) {
        console.error('MONGODB_URI is not set. This script never reads backend/.env.');
        return 1;
    }
    const host = (() => { try { return new URL(uri).host; } catch (_) { return 'unparsed-host'; } })();
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const doc = buildReviewerDoc({ email: args.email, name: args.name, passwordHash });

    console.log(`Target host: ${host}`);
    console.log(`Email:       ${doc.email}`);
    console.log(`Entitlement: ${REVIEW_PLAN.planId} / ${REVIEW_PLAN.status} (API + MCP access, 200 credits per month)`);
    if (!args.apply) {
        console.log('\nDry run — nothing written. Re-run with --apply to create or reset the account.');
        return 0;
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    try {
        const users = mongoose.connection.collection('users');
        const existing = await users.findOne({ email: doc.email });
        const update = {
            $set: {
                ...doc,
                updatedAt: new Date()
            },
            $setOnInsert: { createdAt: new Date() }
        };
        await users.updateOne({ email: doc.email }, update, { upsert: true });
        console.log(existing ? '\nAccount existed and was reset (password rotated, entitlement re-applied).' : '\nAccount created.');
        console.log('\nEnter these in the OpenAI plugin submission form (login + password only):');
        console.log(`  Email:    ${doc.email}`);
        console.log(`  Password: ${password}`);
        console.log('\nThis password is shown once and is not stored anywhere else.');
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
    return 0;
}

module.exports = { buildReviewerDoc, parseArgs, generatePassword, REVIEW_PLAN, main };

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((error) => {
        console.error('Failed:', error && error.message);
        process.exit(1);
    });
}
