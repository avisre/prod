#!/usr/bin/env node
'use strict';

// Cap the filing_text cache with a TTL so it stops growing without bound.
//
// filing_text is a pure re-derivable cache: backend/filing-fetcher.js stores the
// de-tagged plain text of one SEC filing per (symbol, accession, form), capped at
// 220k chars, and both the read and the write are best-effort. A miss just
// re-fetches from EDGAR. Nothing was ever evicted, so the cache had grown to the
// point where it dominated the Atlas free-tier 512 MB budget (which is measured
// against logical dataSize, not compressed storageSize).
//
// Default is a read-only dry run. It never prints connection strings or filing text.
const path = require('node:path');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

function arg(name, fallback = '') {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}

const INDEX_NAME = 'filing_text_at_ttl';

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is required for the TTL migration');
    const apply = String(arg('apply', 'false')).toLowerCase() === 'true';
    const days = Number(arg('days', '30'));
    if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive number of days');
    const expireAfterSeconds = Math.round(days * 86400);

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const collection = mongoose.connection.db.collection('filing_text');

    const cutoff = new Date(Date.now() - expireAfterSeconds * 1000);
    const [totals] = await collection.aggregate([
        { $group: { _id: null, docs: { $sum: 1 }, bytes: { $sum: { $strLenBytes: { $ifNull: ['$text', ''] } } } } }
    ]).toArray();
    const [expiring] = await collection.aggregate([
        { $match: { at: { $lt: cutoff } } },
        { $group: { _id: null, docs: { $sum: 1 }, bytes: { $sum: { $strLenBytes: { $ifNull: ['$text', ''] } } } } }
    ]).toArray();
    const missingAt = await collection.countDocuments({ at: { $exists: false } });

    const existing = await collection.listIndexes().toArray();
    const current = existing.find((index) => index.name === INDEX_NAME);
    const result = {
        dryRun: !apply,
        ttlDays: days,
        totalDocs: Number(totals?.docs || 0),
        totalTextMb: Number(((totals?.bytes || 0) / 1048576).toFixed(1)),
        expiringDocs: Number(expiring?.docs || 0),
        expiringTextMb: Number(((expiring?.bytes || 0) / 1048576).toFixed(1)),
        docsMissingAt: missingAt,
        existingTtlSeconds: current ? current.expireAfterSeconds : null,
        action: 'none'
    };

    if (apply) {
        if (current && current.expireAfterSeconds !== expireAfterSeconds) {
            await mongoose.connection.db.command({
                collMod: 'filing_text',
                index: { name: INDEX_NAME, expireAfterSeconds }
            });
            result.action = 'ttl-updated';
        } else if (!current) {
            await collection.createIndex({ at: 1 }, { name: INDEX_NAME, expireAfterSeconds });
            result.action = 'ttl-created';
        } else {
            result.action = 'already-current';
        }
    }

    console.log(JSON.stringify(result, null, 2));
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(`filing cache TTL migration failed: ${error.message}`);
    try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
    process.exit(1);
});
