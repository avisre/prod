'use strict';

// Durable accounting for the free Key Points allowance: N distinct stocks per
// calendar month. Logged-in free users are keyed by user id; anonymous visitors
// by a one-way client hash, so raw IP addresses are never persisted. Re-reading
// a stock already claimed this month is free, so the allowance counts distinct
// companies rather than page views.

function createModel(mongoose) {
    const schema = new mongoose.Schema({
        clientKey: { type: String, required: true },
        monthKey: { type: String, required: true },
        symbols: { type: [String], default: [] },
        expiresAt: { type: Date, required: true }
    }, { timestamps: true, versionKey: false, collection: 'keypoint_free_usage' });
    schema.index({ clientKey: 1, monthKey: 1 }, { unique: true });
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return mongoose.models.KeypointFreeUsage || mongoose.model('KeypointFreeUsage', schema);
}

async function getOrCreate(Model, { clientKey, monthKey, expiresAt }) {
    try {
        return await Model.findOneAndUpdate(
            { clientKey, monthKey },
            { $setOnInsert: { clientKey, monthKey, symbols: [], expiresAt } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        // Two first requests from the same client can race on the unique key.
        if (error && error.code === 11000) return Model.findOne({ clientKey, monthKey });
        throw error;
    }
}

async function findUsage(Model, { clientKey, monthKey }) {
    return Model.findOne({ clientKey, monthKey }).lean();
}

async function claim(Model, context, symbol, limit) {
    const normalized = String(symbol || '').toUpperCase();
    const record = await getOrCreate(Model, context);
    const currentSymbols = Array.isArray(record.symbols) ? record.symbols : [];
    if (currentSymbols.includes(normalized)) {
        return { allowed: true, known: true, claimed: false, id: record._id, symbols: currentSymbols, remaining: Math.max(0, limit - currentSymbols.length) };
    }

    const updated = await Model.findOneAndUpdate({
        _id: record._id,
        symbols: { $ne: normalized },
        $expr: { $lt: [{ $size: { $ifNull: ['$symbols', []] } }, limit] }
    }, { $addToSet: { symbols: normalized } }, { new: true });

    if (updated) {
        const symbols = Array.isArray(updated.symbols) ? updated.symbols : [];
        return { allowed: true, known: false, claimed: true, id: updated._id, symbols, remaining: Math.max(0, limit - symbols.length) };
    }

    // A concurrent request may have claimed this same symbol. Re-read before
    // calling the allowance exhausted.
    const latest = await Model.findById(record._id).lean();
    const symbols = Array.isArray(latest && latest.symbols) ? latest.symbols : [];
    if (symbols.includes(normalized)) {
        return { allowed: true, known: true, claimed: false, id: record._id, symbols, remaining: Math.max(0, limit - symbols.length) };
    }
    return { allowed: false, known: false, claimed: false, id: record._id, symbols, remaining: 0 };
}

async function release(Model, id, symbol) {
    if (!id) return;
    await Model.updateOne({ _id: id }, { $pull: { symbols: String(symbol || '').toUpperCase() } });
}

module.exports = { createModel, getOrCreate, findUsage, claim, release };
