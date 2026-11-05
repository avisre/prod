#!/usr/bin/env node
'use strict';
// Full logical backup of the production MongoDB (read-only on the server).
//
//   node scripts/mongo-backup.js [--out=DIR]
//
// Writes one <collection>.ejson.gz per collection (canonical EJSON, one
// document per line, so ObjectIds/Dates/Decimals round-trip exactly), its
// indexes and collection options, and manifest.json with the counts. Then it
// re-reads every file and checks the count, so a backup that says OK can be
// restored (scripts/mongo-restore.js).
//
// Default destination: ~/Downloads/stockportfolio-backups/mongo-<UTC stamp>/,
// mode 700. It holds customer data: keep it off /tmp (tmpfs, wiped on reboot)
// and out of the repo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { MongoClient } = require('../backend/node_modules/mongodb');
const { EJSON } = require('../backend/node_modules/bson');
const { prodMongoUri, describeUri } = require('./lib/prod-mongo-uri');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const outDir = arg('out') || path.join(os.homedir(), 'Downloads', 'stockportfolio-backups', `mongo-${stamp}`);

async function countLines(file) {
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
        if (!line) continue;
        EJSON.parse(line, { relaxed: false }); // proves every line parses
        n += 1;
    }
    return n;
}

async function main() {
    const uri = prodMongoUri();
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(outDir), 0o700);
    fs.chmodSync(outDir, 0o700);
    console.log(`backup of ${describeUri(uri)} -> ${outDir}`);

    const client = new MongoClient(uri, { readPreference: 'secondaryPreferred', serverSelectionTimeoutMS: 20000 });
    await client.connect();
    const db = client.db();
    const infos = (await db.listCollections({}, { nameOnly: false }).toArray())
        .filter((c) => c.type === 'collection' && !c.name.startsWith('system.'))
        .sort((a, b) => a.name.localeCompare(b.name));

    const manifest = { database: db.databaseName, host: new URL(uri).hostname, startedAt: new Date().toISOString(), collections: [] };
    for (const info of infos) {
        const coll = db.collection(info.name);
        const t0 = Date.now();
        const countAtStart = await coll.countDocuments();
        const indexes = await coll.indexes();
        const file = path.join(outDir, `${info.name}.ejson.gz`);
        let written = 0;
        const cursor = coll.find({}, { batchSize: 1000 });
        const lines = Readable.from((async function* () {
            for await (const doc of cursor) {
                written += 1;
                yield EJSON.stringify(doc, { relaxed: false }) + '\n';
            }
        })());
        await pipeline(lines, zlib.createGzip({ level: 6 }), fs.createWriteStream(file, { mode: 0o600 }));
        fs.writeFileSync(path.join(outDir, `${info.name}.indexes.json`), JSON.stringify({ options: info.options || {}, indexes }, null, 2), { mode: 0o600 });
        const entry = { name: info.name, countAtStart, written, bytes: fs.statSync(file).size, ms: Date.now() - t0 };
        manifest.collections.push(entry);
        console.log(`  ${info.name.padEnd(40)} ${String(written).padStart(9)} docs  ${(entry.bytes / 1048576).toFixed(2).padStart(8)} MB gz`);
    }
    await client.close();
    manifest.finishedAt = new Date().toISOString();

    // Verify: every file decompresses, every line parses, counts match.
    let problems = 0;
    for (const entry of manifest.collections) {
        entry.verifiedLines = await countLines(path.join(outDir, `${entry.name}.ejson.gz`));
        // A live collection can change during the dump, so countAtStart is
        // only reported; what was streamed must be exactly what reads back.
        entry.ok = entry.verifiedLines === entry.written;
        if (!entry.ok) { problems += 1; console.error(`  MISMATCH ${entry.name}: written=${entry.written} read=${entry.verifiedLines} countAtStart=${entry.countAtStart}`); }
        else if (entry.written !== entry.countAtStart) console.log(`  note ${entry.name}: ${entry.countAtStart} at start, ${entry.written} dumped (changed during backup)`);
    }
    manifest.verified = problems === 0;
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const docs = manifest.collections.reduce((s, c) => s + c.written, 0);
    const mb = manifest.collections.reduce((s, c) => s + c.bytes, 0) / 1048576;
    console.log(`${manifest.collections.length} collections, ${docs} documents, ${mb.toFixed(1)} MB compressed; verified=${manifest.verified}`);
    if (problems) process.exit(1);
}

main().catch((e) => { console.error('backup failed:', e.message); process.exit(1); });
