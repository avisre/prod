'use strict';

// Screens a signed-in user has saved, kept on the account so they follow the
// user across browsers. Until 2026-10-10 saved screens lived only in the
// Screener page's localStorage, and Ask had no way to save one at all — two of
// the four customers who used Ask that month asked it to "create a screener".
//
// A saved screen is a name and one set of screen_universe criteria. Callers
// pass criteria ALREADY cleaned by aiChat.screenArgsFromClient(), the same
// whitelist /api/screener applies, so nothing outside the screen's own
// arguments can be stored or replayed. This module does not import ai-chat
// (ai-chat imports this one for the save_screen tool).

const mongoose = require('mongoose');

const MAX_PER_ACCOUNT = 20;
const NAME_MAX = 60;

function col() { return mongoose.connection.collection('saved_screens'); }

function cleanName(raw) {
    return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function view(doc) {
    return { id: String(doc._id), name: doc.name, criteria: doc.criteria || {}, source: doc.source || 'screener', updatedAt: doc.updatedAt || doc.createdAt || null };
}

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

async function list(userId) {
    const docs = await col().find({ userId: String(userId) }).sort({ updatedAt: -1 }).limit(MAX_PER_ACCOUNT).toArray();
    return docs.map(view);
}

/**
 * Saves a screen. A name the account already uses is replaced, so "save this
 * as Value screen" twice leaves one screen, not two.
 */
async function save(userId, { name, criteria, source } = {}) {
    const uid = String(userId || '');
    if (!uid) throw fail('SIGN_IN_REQUIRED', 'Sign in to save screens.');
    const clean = cleanName(name);
    if (!clean) throw fail('NAME_REQUIRED', 'Give the screen a name.');
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) || !Object.keys(criteria).length) {
        throw fail('CRITERIA_REQUIRED', 'A screen needs at least one filter.');
    }
    const nameKey = clean.toLowerCase();
    const now = new Date();
    const existing = await col().findOne({ userId: uid, nameKey }, { projection: { _id: 1 } });
    if (!existing && (await col().countDocuments({ userId: uid })) >= MAX_PER_ACCOUNT) {
        throw fail('LIMIT_REACHED', `You can keep ${MAX_PER_ACCOUNT} saved screens. Delete one to save another.`);
    }
    await col().updateOne(
        { userId: uid, nameKey },
        { $set: { name: clean, criteria, source: source === 'ask' ? 'ask' : 'screener', updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true }
    );
    return view(await col().findOne({ userId: uid, nameKey }));
}

function oid(id) {
    try { return new mongoose.Types.ObjectId(String(id)); } catch (_) { return null; }
}

// Always scoped by userId: an id alone never reads or deletes another account's screen.
async function get(userId, id) {
    const _id = oid(id);
    if (!_id) return null;
    const doc = await col().findOne({ _id, userId: String(userId) });
    return doc ? view(doc) : null;
}

async function remove(userId, id) {
    const _id = oid(id);
    if (!_id) return false;
    const r = await col().deleteOne({ _id, userId: String(userId) });
    return r.deletedCount === 1;
}

module.exports = { MAX_PER_ACCOUNT, NAME_MAX, cleanName, list, save, get, remove };
