'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { weekOf, readCycle, runWeekly, start } = require('../watchdog-weekly');
const { writeCycle } = require('../../scripts/write-weekly-watchdog-cycle');

function database() {
    const records = new Map();
    const col = {
        async insertOne(row) {
            if (records.has(row._id)) throw Object.assign(new Error('Duplicate'), { code: 11000 });
            records.set(row._id, { ...row });
        },
        async updateOne(query, update) { Object.assign(records.get(query._id), update.$set); }
    };
    return { records, collection: () => col };
}
const cycle = asOf => ({ schemaVersion: 1, asOf, weekOf: weekOf(asOf) });

test('the weekly workflow marker round-trips and manual refreshes in the same week share a claim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-week-'));
    const file = path.join(dir, 'cycle.json');
    try {
        assert.equal(readCycle(file), null, 'no published cycle means no catch-up startup scan');
        writeCycle('2026-11-14', file);
        assert.deepEqual(readCycle(file), cycle('2026-11-14'));
        assert.equal(weekOf('2026-11-15'), '2026-11-14');
        assert.equal(weekOf('2026-11-20'), '2026-11-14');
        assert.throws(() => writeCycle('2026-02-30', file));
        assert.deepEqual(readCycle(file), cycle('2026-11-14'), 'an invalid date cannot replace the marker');
        fs.writeFileSync(file, '{"schemaVersion":1,"asOf":"2026-11-14","weekOf":"2026-11-07"}');
        assert.throws(() => readCycle(file));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a week scans once across restarts, concurrent deploys and repeated weekly publications', async () => {
    const db = database(); let scans = 0;
    const scan = async () => { scans++; return { symbols: 81 }; };
    const results = await Promise.all(Array.from({ length: 5 }, () => runWeekly({ db, scan, cycle: cycle('2026-11-14') })));
    assert.equal(scans, 1);
    assert.equal(results.filter(r => r.skipped === 'week already claimed').length, 4);
    assert.equal(db.records.get('2026-11-14').status, 'completed');
    await runWeekly({ db, scan, cycle: cycle('2026-11-18') });
    assert.equal(scans, 1, 'republishing within the same week does not rescan');
    await runWeekly({ db, scan, cycle: cycle('2026-11-21') });
    assert.equal(scans, 2, 'the next published week runs independently');
});

test('a failed or interrupted scan cannot create another restart loop', async () => {
    const db = database(); let scans = 0;
    const scan = async () => { scans++; throw new Error('Interrupted'); };
    await assert.rejects(runWeekly({ db, scan, cycle: cycle('2026-11-14') }), /Interrupted/);
    assert.equal(db.records.get('2026-11-14').status, 'failed');
    await runWeekly({ db, scan, cycle: cycle('2026-11-14') });
    assert.equal(scans, 1);
    db.records.set('2026-11-21', { status: 'running' });
    await runWeekly({ db, scan, cycle: cycle('2026-11-21') });
    assert.equal(scans, 1, 'a claim left by a killed process is retained');
});

test('no published week or unavailable durable claim starts no expensive scan', async () => {
    let scans = 0; const scan = async () => { scans++; };
    const db = database();
    assert.equal((await runWeekly({ db, scan, cycle: null })).skipped, 'waiting for the weekly financial refresh');
    const unavailable = { collection: () => ({ insertOne: async () => { throw new Error('Database unavailable'); } }) };
    await assert.rejects(runWeekly({ db: unavailable, scan, cycle: cycle('2026-11-14') }), /Database unavailable/);
    assert.equal(scans, 0);
});

test('startup only checks the weekly claim and honors disabled background jobs', async () => {
    const db = database(); let scans = 0, callback, scheduled = 0;
    const connection = Object.assign(new EventEmitter(), { readyState: 0, db });
    const options = { connection, scan: async () => { scans++; return { symbols: 81 }; }, cycle: () => cycle('2026-11-14'),
        schedule: (fn, ms) => { scheduled++; callback = fn; assert.equal(ms, 90000); return { unref() {} }; }, log() {}, warn() {}, env: {} };
    start({ ...options, env: { DISABLE_BACKGROUND_JOBS: '1' } });
    assert.equal(scheduled, 0);
    start(options); callback();
    await new Promise(setImmediate);
    assert.equal(scans, 0, 'wait for the database before claiming a week');
    connection.readyState = 1; connection.emit('connected');
    await new Promise(setImmediate);
    assert.equal(scans, 1);
    start(options); callback(); await new Promise(setImmediate);
    assert.equal(scans, 1, 'another server startup reads the existing durable claim');
});
