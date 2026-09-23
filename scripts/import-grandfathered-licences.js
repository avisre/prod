#!/usr/bin/env node
'use strict';

// Marks every AppSumo licence PURCHASED on or before the API/MCP cutoff with
// user.grandfatheredLicence = true, so lib/tier-limits.js's
// isLtdApiAccessCohort() grants them API and MCP on whichever tier they bought.
//
// Why this exists: the owner's rule is by PURCHASE date, but the only per-user
// date this system stores is the REDEMPTION date. Those differ for anyone who
// buys a code and redeems it weeks later — and at the time of writing 6 of 25
// licences are sold but not yet redeemed, so this is not a hypothetical. The
// AppSumo Licensing API's `created_at` IS the purchase date (the licence is
// minted at checkout), which makes it the authoritative source and removes any
// need for a manual CSV export.
//
// Unredeemed licences are recorded in `grandfathered_licences` and applied to
// the user at redemption time, so a code bought on the 22nd and redeemed in
// October still lands on the generous side.
//
// Auth: same key and file as scripts/appsumo-licensing-audit.js.
// Usage: node scripts/import-grandfathered-licences.js [--apply]
//        (default is a dry run; --apply writes)

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const DEFAULT_KEY_FILE = path.join(os.homedir(), '.local/share/secrets/appsumo_licensing.txt');
const CUTOFF = process.env.LTD_API_ACCESS_CUTOFF || '2026-09-22T23:59:59.999Z';
const APPLY = process.argv.includes('--apply');

function loadKey() {
    if (process.env.APPSUMO_LICENSING_KEY) return process.env.APPSUMO_LICENSING_KEY.trim();
    const file = process.env.APPSUMO_LICENSING_KEY_FILE || DEFAULT_KEY_FILE;
    if (!fs.existsSync(file)) throw new Error(`No AppSumo Licensing API key found. Put it in ${DEFAULT_KEY_FILE} or set APPSUMO_LICENSING_KEY.`);
    return fs.readFileSync(file, 'utf8').trim();
}

function apiGet(pathname, key) {
    return new Promise((resolve, reject) => {
        https.get({ hostname: 'api.licensing.appsumo.com', path: pathname, headers: { 'X-AppSumo-Licensing-Key': key } }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`${pathname} -> HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Never log a full licence key — these are credentials a buyer redeems with.
const mask = (k) => String(k || '').slice(0, 8) + '…';

async function main() {
    const cutoffMs = Date.parse(CUTOFF);
    if (!Number.isFinite(cutoffMs)) throw new Error(`Unparseable cutoff: ${CUTOFF}`);

    const licences = (await apiGet('/v2/licenses', loadKey())).items || [];
    const eligible = licences.filter((l) => Date.parse(l.created_at) <= cutoffMs);

    console.log(`Cutoff: ${CUTOFF}`);
    console.log(`Licences: ${licences.length} total, ${eligible.length} purchased on or before the cutoff`);
    console.log(APPLY ? 'Mode: APPLY (writing)' : 'Mode: dry run (pass --apply to write)');

    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    const users = mongoose.connection.collection('users');
    const ledger = mongoose.connection.collection('grandfathered_licences');

    let matched = 0, unredeemed = 0;
    for (const l of eligible) {
        const user = await users.findOne({ appsumoLicenseKey: l.license_key }, { projection: { _id: 1, email: 1, appsumoTier: 1, grandfatheredLicence: 1 } });
        if (user) {
            matched++;
            if (user.grandfatheredLicence === true) continue;
            console.log(`  user ${user.email} (tier ${user.appsumoTier}) <- ${mask(l.license_key)} purchased ${l.created_at.slice(0, 10)}`);
            if (APPLY) await users.updateOne({ _id: user._id }, { $set: { grandfatheredLicence: true } });
        } else {
            unredeemed++;
            if (APPLY) {
                // Applied at redemption: see handleAppSumoRedeem in backend/app.js.
                await ledger.updateOne(
                    { licenseKey: l.license_key },
                    { $set: { licenseKey: l.license_key, tier: l.tier, purchasedAt: new Date(l.created_at), importedAt: new Date() } },
                    { upsert: true }
                );
            }
        }
    }

    console.log(`\nRedeemed and matched to an account: ${matched}`);
    console.log(`Purchased but not yet redeemed: ${unredeemed} (recorded for redemption time)`);
    if (!APPLY) console.log('\nNothing was written. Re-run with --apply.');
    await mongoose.disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
