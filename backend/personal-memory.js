// Personal memory — ChatGPT-style "saved memories": one document per user in
// `personal_memory`, holding up to PM_KEEP short durable facts the Ask
// assistant picked up unprompted (and any the user imported from another
// provider's export). Split out of app.js so ai-chat.js's remember tool and
// the routes share ONE implementation without a require cycle — this module
// touches raw collections on the default mongoose connection only.
//
// The user's toggle (User.askMemoryEnabled, default ON) gates the ASSISTANT's
// writes in the chat loop; it does not lock this module. The Profile UI can
// always view/edit/import the list — same as ChatGPT letting you manage
// settings while memory is paused.

const crypto = require('crypto');
const PM_MAX = 500;      // chars per fact
const PM_KEEP = 50;      // facts per user
const PM_NORM_RE = /[^a-z0-9]+/g;
const COLLECTION = 'personal_memory';
const BOOT_MARKER = 'boot:ask-memory-default-on';

function normFact(f) {
    return String(f || '').toLowerCase().replace(PM_NORM_RE, ' ').trim();
}
function cleanFact(f) {
    return String(f || '').replace(/\s+/g, ' ').trim().slice(0, PM_MAX);
}
// Screen out secrets ChatGPT-style memory must never hold — the same rule the
// remember-tool prompt states, enforced mechanically for imports too.
function disallowedFact(f) {
    const t = String(f || '');
    return /\b(sk[-_]?|pk[-_]?|api[\s_-]?key|secret|password|passwd|passphrase|token|bearer)\b\s*[:=]\s*\S|^\s*\d[\d\s-]{8,}\s*$|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(t);
}
function toObjectIdSafe(v) {
    try {
        if (v && typeof v.toHexString === 'function') return v;
        const s = String(v || '');
        return /^[0-9a-fA-F]{24}$/.test(s) ? new (require('mongoose').Types.ObjectId)(s) : null;
    } catch (_) { return null; }
}
function mkFact(text, at) {
    return { id: crypto.randomBytes(12).toString('hex'), fact: text, at: at || new Date() };
}

// Read one user's fact list (oldest first), capped.
async function readFacts(userId, limit = PM_KEEP) {
    const col = require('mongoose').connection.collection(COLLECTION);
    const doc = await col.findOne({ userId }, { projection: { facts: 1 } });
    return ((doc && doc.facts) || []).slice(-limit)
        .map((f) => ({ id: f.id != null ? f.id : null, fact: String(f.fact || ''), at: f.at }));
}

// Add one fact with dedup + cap. `existingFacts` lets the chat-loop path reuse
// an already-fetched list instead of a second read.
async function addFact(userId, fact, opts = {}) {
    const factText = cleanFact(fact);
    if (!factText) return { ok: false, note: 'Empty fact.' };
    if (disallowedFact(factText)) return { ok: false, note: 'Refused: looks like a credential or private identifier — not saved.' };
    const uid = toObjectIdSafe(userId);
    if (!uid) return { ok: false, note: 'Requires a signed-in account.' };
    const facts = opts.existingFacts || await readFacts(uid);
    const norm = normFact(factText);
    if (facts.some((f) => normFact(f.fact) === norm)) {
        return { ok: true, note: 'Already remembered — unchanged.' };
    }
    const fdoc = mkFact(factText);
    // facts are oldest-first; beyond the cap the OLDEST fall off the front
    await require('mongoose').connection.collection(COLLECTION).updateOne(
        { userId: uid },
        { $set: { facts: [...facts, fdoc].slice(-PM_KEEP), updatedAt: new Date() } },
        { upsert: true }
    );
    return { ok: true, saved: fdoc.fact, id: fdoc.id };
}

async function removeFact(userId, identifier) {
    const uid = toObjectIdSafe(userId);
    if (!uid || !identifier) return false;
    const s = String(identifier);
    const byId = /^[0-9a-fA-F]{24}$/.test(s) ? { 'facts.id': s } : null;
    const pull = byId || { 'facts.fact': s };
    const out = await require('mongoose').connection.collection(COLLECTION).updateOne(
        { userId: uid },
        { $pull: pull, $set: { updatedAt: new Date() } }
    );
    return !!(out && out.modifiedCount);
}

async function clearFacts(userId) {
    const uid = toObjectIdSafe(userId);
    if (!uid) return;
    await require('mongoose').connection.collection(COLLECTION).deleteMany({ userId: uid });
}

// Bulk import (Profile → Import from another provider's export). Respects the
// cap, dedupes against existing AND within the batch. Returns how many landed.
async function importFacts(userId, facts) {
    const list = (Array.isArray(facts) ? facts : [])
        .map(cleanFact).filter(Boolean);
    if (!list.length) return { ok: false, imported: 0, note: 'No usable facts in that selection.' };
    const uid = toObjectIdSafe(userId);
    if (!uid) return { ok: false, imported: 0, note: 'Requires a signed-in account.' };
    const existing = await readFacts(uid);
    const seen = new Set();
    const fresh = [];
    for (const f of list) {
        const norm = normFact(f);
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (existing.some((e) => normFact(e.fact) === norm)) continue;
        if (disallowedFact(f)) continue;
        fresh.push(mkFact(f));
    }
    const merged = [...existing, ...fresh].slice(-PM_KEEP);
    await require('mongoose').connection.collection(COLLECTION).updateOne(
        { userId: uid },
        { $set: { facts: merged, updatedAt: new Date() } },
        { upsert: true }
    );
    return { ok: true, imported: fresh.length };
}

// Boot-time, one-shot: (b) migrate legacy `ask_memories` rows (one row per
// fact) into each user's personal_memory doc; (a) flip the pre-default explicit
// opt-outs back ON, so memory is ChatGPT-style default-ON for everyone. The
// marker only lets this run once — a user who opts out from now on keeps their
// choice across restarts.
async function bootMigrate() {
    const conn = require('mongoose').connection;
    try {
        const marker = await conn.collection('boot_migrations').findOne({ _id: BOOT_MARKER });
        if (marker) return;
        const col = conn.collection(COLLECTION);
        const legacy = await conn.collection('ask_memories').find({}).toArray();
        for (const row of legacy) {
            const factText = cleanFact(row.content);
            const uid = row.userId;
            if (!factText || !(uid && uid._bsontype === 'ObjectId')) continue;
            const doc = await col.findOne({ userId: uid });
            const facts = (doc && doc.facts) || [];
            const norm = normFact(factText);
            if (facts.some((f) => normFact(f.fact) === norm)) continue;
            await col.updateOne(
                { userId: uid },
                { $set: { facts: [...facts, mkFact(factText, row.createdAt)].slice(-PM_KEEP), updatedAt: new Date() } },
                { upsert: true }
            );
        }
        await conn.collection('ask_memories').drop().catch(() => {});
        await conn.collection('users').updateMany({ askMemoryEnabled: false }, { $set: { askMemoryEnabled: true } });
        await conn.collection('boot_migrations').insertOne({ _id: BOOT_MARKER, at: new Date() }).catch(() => {});
        console.log('[ask-memory] boot migration done:', legacy.length, 'legacy facts carried over');
    } catch (error) {
        console.error('[ask-memory] boot migration failed (will retry next boot):', error && error.message);
    }
}

module.exports = {
    PM_MAX, PM_KEEP, COLLECTION, BOOT_MARKER,
    normFact, cleanFact, disallowedFact, toObjectIdSafe,
    readFacts, addFact, removeFact, clearFacts, importFacts, bootMigrate
};