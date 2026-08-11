#!/usr/bin/env node
'use strict';

// Controlled, idempotent index check for Growth Measurement V1. The default is
// a read-only dry run. It never prints connection strings or event contents.
const path = require('node:path');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

function arg(name, fallback = '') {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}

const REQUIRED_INDEXES = [
    { key: { dedupeKey: 1 }, options: {
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: 'string' } },
        name: 'funnel_dedupe_key_unique'
    } },
    { key: { eventName: 1, occurredAt: -1 }, options: { name: 'funnel_event_name_occurred_at' } },
    { key: { opaqueUserId: 1, occurredAt: -1 }, options: { name: 'funnel_opaque_user_occurred_at' } }
];

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is required for the index dry run');
    const apply = String(arg('apply', 'false')).toLowerCase() === 'true';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const collection = mongoose.connection.db.collection('funnel_events');
    const duplicateDedupeKeys = await collection.aggregate([
        { $match: { dedupeKey: { $exists: true, $nin: [null, ''] } } },
        { $group: { _id: '$dedupeKey', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $count: 'duplicates' }
    ]).toArray();
    const existing = await collection.listIndexes().toArray();
    const existingNames = new Set(existing.map((index) => index.name));
    const result = {
        dryRun: !apply,
        duplicateDedupeKeys: Number(duplicateDedupeKeys[0]?.duplicates || 0),
        existingIndexes: existing.map((index) => index.name),
        requiredIndexes: REQUIRED_INDEXES.map((index) => index.options.name),
        created: []
    };
    if (result.duplicateDedupeKeys) throw new Error('Duplicate dedupe keys must be reconciled before applying the unique index.');
    if (apply) {
        for (const index of REQUIRED_INDEXES) {
            if (existingNames.has(index.options.name)) continue;
            await collection.createIndex(index.key, index.options);
            result.created.push(index.options.name);
        }
    }
    console.log(JSON.stringify(result, null, 2));
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error.message);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exitCode = 1;
});
