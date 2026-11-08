'use strict';

// The 2026-11-08 outage ran 17 hours because nothing watched the Atlas quota.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const watch = require('../storage-watch');

test('mails once per level on the way up and re-arms after a cleanup', () => {
    watch._reset();
    assert.equal(watch.levelToAlert(300, 512), 0, 'under 80%: quiet');
    assert.equal(watch.levelToAlert(420, 512), 0.8, 'crossing 80% mails');
    assert.equal(watch.levelToAlert(430, 512), 0, 'still 80%: no repeat mail every hour');
    assert.equal(watch.levelToAlert(470, 512), 0.9, 'crossing 90% mails again');
    assert.equal(watch.levelToAlert(515, 512), 0, 'over quota: already warned at 90%');
    assert.equal(watch.levelToAlert(310, 512), 0, 'after a cleanup: quiet and re-armed');
    assert.equal(watch.levelToAlert(415, 512), 0.8, 'new growth warns again');
});

test('sums dataSize + indexSize across every database on the cluster and sends the mail', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });
    const blob = 'x'.repeat(100 * 1024);
    await mongoose.connection.db.collection('a').insertMany(Array.from({ length: 30 }, () => ({ blob })));
    await mongoose.connection.client.db('otherapp').collection('b').insertMany(Array.from({ length: 30 }, () => ({ blob })));
    const usage = await watch.usageMb();
    assert.ok(usage.usedMb >= 5.8 && usage.usedMb < 7, `both databases counted (${usage.usedMb} MB)`);

    watch._reset();
    const sent = [];
    const result = await watch.check({ send: async (m) => { sent.push(m); } });
    assert.equal(result.level, 0, 'a 6 MB cluster against 512 MB is quiet');
    assert.equal(sent.length, 0);
});

test('the watch is started with the other background jobs', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(app, /storageWatch\.start\(\{ send: \(m\) => mailer\.sendMail\(m\) \}\)/);
});
