'use strict';

// Durable accounting for the public Filing Monitor allowance. The caller
// supplies a one-way client hash; raw IP addresses are never persisted.

function createModel(mongoose) {
    const schema = new mongoose.Schema({
        clientHash: { type: String, required: true },
        dayKey: { type: String, required: true },
        symbols: { type: [String], default: [] },
        expiresAt: { type: Date, required: true }
    }, { timestamps: true, versionKey: false, collection: 'monitor_free_usage' });
    schema.index({ clientHash: 1, dayKey: 1 }, { unique: true });
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return mongoose.models.MonitorFreeUsage || mongoose.model('MonitorFreeUsage', schema);
}

async function getOrCreate(Model, { clientHash, dayKey, expiresAt }) {
    try {
        return await Model.findOneAndUpdate(
            { clientHash, dayKey },
            { $setOnInsert: { clientHash, dayKey, symbols: [], expiresAt } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        // Two first requests from the same client can race on the unique key.
        if (error && error.code === 11000) return Model.findOne({ clientHash, dayKey });
        throw error;
    }
}

async function findUsage(Model, { clientHash, dayKey }) {
    return Model.findOne({ clientHash, dayKey }).lean();
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
