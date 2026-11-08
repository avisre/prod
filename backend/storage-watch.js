'use strict';

// Early warning for the Atlas free-tier storage quota.
//
// On 2026-11-08 the cluster reached 514 of 512 MB at 02:01 UTC and Atlas
// blocked every insert and update: Ask threads, credits, connector sign-in,
// sign-ups. Nothing watched the size, so it ran for 17 hours before anyone
// looked. Atlas counts logical dataSize + indexSize across EVERY database on
// the cluster (other apps share it), not the compressed storageSize, so that
// is the number summed here.

const mongoose = require('mongoose');

const QUOTA_MB = Number(process.env.STORAGE_QUOTA_MB) || 512;
const LEVELS = [0.9, 0.8]; // highest first
const SKIP_DBS = new Set(['admin', 'local', 'config']);
const MB = 1024 * 1024;

let alerted = 0; // highest level already mailed since the last time usage fell below 80%

async function usageMb(db = mongoose.connection.db) {
    const { databases } = await db.admin().listDatabases({ nameOnly: true });
    let bytes = 0;
    const skipped = [];
    for (const { name } of databases) {
        if (SKIP_DBS.has(name)) continue;
        try {
            const s = await db.client.db(name).stats();
            bytes += Number(s.dataSize || 0) + Number(s.indexSize || 0);
        } catch (_) { skipped.push(name); }
    }
    return { usedMb: Math.round((bytes / MB) * 10) / 10, quotaMb: QUOTA_MB, skipped };
}

// The level to mail now, or 0. Mails once per level on the way up and re-arms
// once usage drops back below the lowest level, so a cleanup followed by new
// growth warns again.
function levelToAlert(usedMb, quotaMb = QUOTA_MB) {
    const share = usedMb / quotaMb;
    const level = LEVELS.find((l) => share >= l) || 0;
    if (!level) { alerted = 0; return 0; }
    if (level <= alerted) return 0;
    alerted = level;
    return level;
}

async function check({ send } = {}) {
    const usage = await usageMb();
    const share = usage.usedMb / usage.quotaMb;
    const line = `[storage] ${usage.usedMb} of ${usage.quotaMb} MB (${Math.round(share * 100)}%)${usage.skipped.length ? `; unreadable: ${usage.skipped.join(', ')}` : ''}`;
    if (share >= LEVELS[LEVELS.length - 1]) console.warn(line); else console.log(line);
    const level = levelToAlert(usage.usedMb, usage.quotaMb);
    if (level && send) {
        const text = [
            `The MongoDB cluster is at ${usage.usedMb} of ${usage.quotaMb} MB (${Math.round(share * 100)}%).`,
            'At 100% Atlas blocks every insert and update: Ask threads, credits, connector sign-in and sign-ups all fail.',
            'First check: per-collection sizes (dataSize + indexSize) in the DAT database. funnel_events filled it on 2026-11-08.',
            `When: ${new Date().toISOString()}`
        ].join('\n');
        await send({
            to: process.env.SUPPORT_INBOX_EMAIL || 'support@stockportfolio.pro',
            subject: `Database storage at ${Math.round(share * 100)}% of the free-tier limit`,
            text
        });
    }
    return { ...usage, level };
}

function start({ send, intervalMs = 3600 * 1000, firstMs = 5 * 60 * 1000 } = {}) {
    const run = () => check({ send }).catch((e) => console.error('[storage] check failed:', e && e.message));
    setTimeout(run, firstMs).unref?.();
    setInterval(run, intervalMs).unref?.();
    console.log('[storage] quota watch scheduled hourly');
}

function _reset() { alerted = 0; }

module.exports = { usageMb, levelToAlert, check, start, QUOTA_MB, _reset };
