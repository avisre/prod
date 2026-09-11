'use strict';

// Public API keys for the /api/v1 REST surface and the hosted MCP endpoint.
// One Mongo collection (`api_keys`), no formal Mongoose schema — same
// raw-collection pattern credits.js uses for `credit_ledger`.
//
// This is the identity bridge credits.js's own header comment calls out as
// missing: a key's owning userId is exactly the userId the credit ledger
// already keys on, so an external caller spends from the SAME wallet as the
// website account that issued the key, rather than a second, disconnected
// quota.
//
// Only the SHA-256 hash of a key is ever persisted. The raw key is generated
// here, returned to the caller once, and never stored or logged again — the
// same "shown once" contract as a Stripe secret key or a GitHub PAT.

const mongoose = require('mongoose');
const crypto = require('crypto');

const KEY_PREFIX = 'sp_live_';
const PREFIX_VISIBLE_CHARS = 6; // keyPrefix shown in the dashboard: "sp_live_ab12cd…"

function col() { return mongoose.connection.collection('api_keys'); }

function hashKey(rawKey) {
    return crypto.createHash('sha256').update(String(rawKey)).digest('hex');
}

function generateRawKey() {
    return KEY_PREFIX + crypto.randomBytes(24).toString('hex');
}

async function createKey(userId, label) {
    const rawKey = generateRawKey();
    const doc = {
        userId: String(userId),
        keyHash: hashKey(rawKey),
        keyPrefix: rawKey.slice(0, KEY_PREFIX.length + PREFIX_VISIBLE_CHARS),
        label: String(label || '').trim().slice(0, 80) || 'Default key',
        createdAt: new Date(),
        revokedAt: null,
        lastUsedAt: null,
    };
    await col().insertOne(doc);
    return { rawKey, keyPrefix: doc.keyPrefix, label: doc.label, createdAt: doc.createdAt };
}

async function listKeys(userId) {
    const rows = await col()
        .find({ userId: String(userId) })
        .project({ keyHash: 0 })
        .sort({ createdAt: -1 })
        .toArray();
    return rows.map((r) => ({
        id: String(r._id), keyPrefix: r.keyPrefix, label: r.label,
        createdAt: r.createdAt, revokedAt: r.revokedAt, lastUsedAt: r.lastUsedAt,
    }));
}

async function revokeKey(userId, keyId) {
    let _id;
    try { _id = new mongoose.Types.ObjectId(String(keyId)); } catch (_) { return false; }
    const result = await col().updateOne(
        { _id, userId: String(userId), revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );
    return result.modifiedCount > 0;
}

// Resolves a raw key (as presented in a request header) to its owning
// userId. Unknown or revoked keys resolve to null — this is the only
// identity an external caller carries, so unlike credits.js's fail-open
// reads, this fails CLOSED: a lookup error must never be treated as
// "anonymous, let it through".
async function resolveKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key.startsWith(KEY_PREFIX)) return null;
    const doc = await col().findOne({ keyHash: hashKey(key), revokedAt: null });
    if (!doc) return null;
    col().updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    return { userId: doc.userId, keyId: String(doc._id) };
}

module.exports = { KEY_PREFIX, hashKey, createKey, listKeys, revokeKey, resolveKey };
