'use strict';

// The weekly financial workflow publishes a small cycle marker with its
// validated data. Claim that week once in Mongo, across deploys and restarts.
const fs = require('node:fs');
const path = require('node:path');
const CYCLE_FILE = path.join(__dirname, '../frontend/data/weekly-watchdog.json');

function weekOf(asOf) {
    if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Invalid weekly financial date');
    const day = new Date(`${asOf}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== asOf) throw new Error('Invalid weekly financial date');
    // Saturday is the existing weekly reconciliation day.
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 1) % 7);
    return day.toISOString().slice(0, 10);
}

function readCycle(file = CYCLE_FILE) {
    try {
        if (fs.statSync(file).size > 2048) throw new Error('Weekly watchdog marker is too large');
        const cycle = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cycle.schemaVersion !== 1 || cycle.weekOf !== weekOf(cycle.asOf)) throw new Error('Invalid weekly watchdog marker');
        return cycle;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function runWeekly({ db, scan, cycle = readCycle(), now = () => new Date() }) {
    if (!cycle) return { skipped: 'waiting for the weekly financial refresh' };
    if (cycle.weekOf !== weekOf(cycle.asOf)) throw new Error('Invalid weekly watchdog marker');
    const col = db.collection('watchdog_cycles');
    try {
        await col.insertOne({ _id: cycle.weekOf, asOf: cycle.asOf, status: 'running', startedAt: now() });
    } catch (error) {
        if (error.code === 11000) return { skipped: 'week already claimed', weekOf: cycle.weekOf };
        throw error; // No durable claim means no expensive scan.
    }
    try {
        const result = await scan();
        await col.updateOne({ _id: cycle.weekOf }, { $set: {
            status: result?.skipped ? 'skipped' : 'completed', finishedAt: now(), result
        } });
        return { ...result, weekOf: cycle.weekOf };
    } catch (error) {
        // Retain the claim after an interrupted/failed scan. A restart must
        // not repeat the expensive work in a crash loop. Operators can inspect
        // this status; the next published week remains independently due.
        await col.updateOne({ _id: cycle.weekOf }, { $set: {
            status: 'failed', finishedAt: now(), error: String(error.code || error.name || 'Error')
        } }).catch(() => {});
        throw error;
    }
}

function start({ connection, scan, env = process.env, cycle = readCycle,
    schedule = setTimeout, log = console.log, warn = console.warn } = {}) {
    if (env.WATCHDOG === '0' || env.DISABLE_BACKGROUND_JOBS === '1') {
        log('[watchdog] disabled');
        return null;
    }
    const run = () => {
        if (connection.readyState !== 1) {
            connection.once('connected', run);
            return;
        }
        Promise.resolve().then(() => runWeekly({ db: connection.db, scan, cycle: cycle() }))
            .then(result => log('[watchdog] weekly sweep', JSON.stringify(result)))
            .catch(error => warn('[watchdog] weekly sweep failed', String(error.code || error.name || 'Error')));
    };
    const timer = schedule(run, 90 * 1000);
    timer?.unref?.();
    log('[watchdog] follows the published Saturday financial refresh; once per week');
    return timer;
}

module.exports = { weekOf, readCycle, runWeekly, start, CYCLE_FILE };
