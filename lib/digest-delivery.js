'use strict';

// Per-filing-change delivery log — the idempotency record behind the Monitor
// digest.
//
// A digest email is a bundle, so per-email deduplication is not enough: the
// same 10-Q can easily still be the newest filing for a company across two
// weekly runs, and mailing a customer the same filing change twice is the
// fastest way to teach them to ignore the digest. So the unit of record is
// (user, symbol, accession) — one row per filing change per person, with a
// unique index doing the enforcing rather than a read-then-write race.

const path = require('node:path');
const mongoose = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mongoose'));

const DigestDeliverySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true },
    // The filing this change came from. Reports without an accession are never
    // logged and never included — an item we cannot key, we cannot dedupe.
    accession: { type: String, required: true },
    queueKey: { type: String, default: null },
    at: { type: Date, default: () => new Date() }
}, { versionKey: false, collection: 'digest_deliveries' });

DigestDeliverySchema.index({ userId: 1, symbol: 1, accession: 1 }, { unique: true, name: 'digest_delivery_unique' });

const DigestDelivery = mongoose.models.DigestDelivery || mongoose.model('DigestDelivery', DigestDeliverySchema);

/** Which of these (symbol, accession) pairs has this user already been sent? */
async function alreadyDelivered(userId, pairs) {
    if (!pairs.length) return new Set();
    const docs = await DigestDelivery.find({
        userId,
        $or: pairs.map(({ symbol, accession }) => ({ symbol, accession }))
    }, { symbol: 1, accession: 1 }).lean();
    return new Set(docs.map((d) => `${d.symbol}:${d.accession}`));
}

/**
 * Claim these filing changes for this user. Returns the pairs actually claimed
 * — anything a concurrent run got to first is dropped by the unique index and
 * excluded from the result, so two overlapping sweeps can never both send.
 */
async function claimDeliveries(userId, pairs, queueKey) {
    if (!pairs.length) return [];
    const res = await DigestDelivery.bulkWrite(
        pairs.map(({ symbol, accession }) => ({
            insertOne: { document: { userId, symbol, accession, queueKey, at: new Date() } }
        })),
        { ordered: false }
    ).catch((err) => err && err.result);
    const inserted = (res && (res.insertedCount ?? res.nInserted)) || 0;
    if (inserted === pairs.length) return pairs;
    // Partial success: re-read to find out exactly which rows are ours.
    const failedIdx = new Set(((res && res.getWriteErrors && res.getWriteErrors()) || []).map((e) => e.index));
    return pairs.filter((_, i) => !failedIdx.has(i));
}

module.exports = { DigestDelivery, alreadyDelivered, claimDeliveries };
