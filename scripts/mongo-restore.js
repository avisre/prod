#!/usr/bin/env node
'use strict';
// Restore a backup written by scripts/mongo-backup.js.
//
//   node scripts/mongo-restore.js --from=DIR --uri=mongodb://127.0.0.1:27017/DAT [--only=a,b] [--drop]
//
// Refuses any non-local target unless --target-is-production is passed, so a
// test restore can never land on Atlas by accident. Without --drop it inserts
// into existing collections (duplicate _ids fail loudly rather than overwrite).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { MongoClient } = require('../backend/node_modules/mongodb');
const { EJSON } = require('../backend/node_modules/bson');

function isLocal(uri) {
    try {
        const u = new URL(uri);
        return u.protocol === 'mongodb:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
    } catch (_) { return false; }
}

async function restore({ from, uri, only = null, drop = false, allowRemote = false, log = console.log }) {
    if (!isLocal(uri) && !allowRemote) throw new Error('Target is not a local MongoDB; pass --target-is-production to restore there on purpose');
    const manifest = JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8'));
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db();
    const results = [];
    try {
        for (const entry of manifest.collections) {
            if (only && !only.includes(entry.name)) continue;
            const meta = JSON.parse(fs.readFileSync(path.join(from, `${entry.name}.indexes.json`), 'utf8'));
            if (drop) await db.collection(entry.name).drop().catch(() => {});
            const exists = (await db.listCollections({ name: entry.name }).toArray()).length > 0;
            if (!exists) {
                const { capped, size, max } = meta.options || {};
                await db.createCollection(entry.name, capped ? { capped, size, max } : {});
            }
            const coll = db.collection(entry.name);
            const rl = readline.createInterface({ input: fs.createReadStream(path.join(from, `${entry.name}.ejson.gz`)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
            let batch = [], inserted = 0;
            for await (const line of rl) {
                if (!line) continue;
                batch.push(EJSON.parse(line, { relaxed: false }));
                if (batch.length >= 1000) { await coll.insertMany(batch, { ordered: true }); inserted += batch.length; batch = []; }
            }
            if (batch.length) { await coll.insertMany(batch, { ordered: true }); inserted += batch.length; }
            for (const ix of meta.indexes || []) {
                if (ix.name === '_id_') continue;
                const { key, name, v, ns, ...opts } = ix;
                await coll.createIndex(key, { name, ...opts });
            }
            const count = await coll.countDocuments();
            results.push({ name: entry.name, expected: entry.written, inserted, count, ok: count === entry.written });
            log(`  ${entry.name.padEnd(40)} ${String(count).padStart(9)} / ${entry.written}${count === entry.written ? '' : '  MISMATCH'}`);
        }
    } finally {
        await client.close();
    }
    return results;
}

if (require.main === module) {
    const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
    const from = arg('from'), uri = arg('uri');
    if (!from || !uri) { console.error('usage: --from=DIR --uri=MONGO_URI [--only=a,b] [--drop] [--target-is-production]'); process.exit(2); }
    restore({ from, uri, only: arg('only') ? arg('only').split(',') : null, drop: process.argv.includes('--drop'), allowRemote: process.argv.includes('--target-is-production') })
        .then((r) => { const bad = r.filter((x) => !x.ok); console.log(`${r.length} collections restored, ${bad.length} mismatched`); process.exit(bad.length ? 1 : 0); })
        .catch((e) => { console.error('restore failed:', e.message); process.exit(1); });
}

module.exports = { restore, isLocal };
