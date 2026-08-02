'use strict';

// A short Mongo-backed lease prevents two Render processes (or a process
// restart overlapping an old worker) from paying to build the same dossier at
// the same time. Expired leases can be taken over automatically, and Mongo's
// TTL cleanup removes abandoned records eventually.

function createModel(mongoose) {
    const schema = new mongoose.Schema({
        _id: { type: String, required: true },
        owner: { type: String, required: true },
        expiresAt: { type: Date, required: true }
    }, { timestamps: true, versionKey: false, collection: 'dossier_build_locks' });
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return mongoose.models.DossierBuildLock || mongoose.model('DossierBuildLock', schema);
}

async function acquire(Model, { key, owner, leaseMs, now = new Date() }) {
    const expiresAt = new Date(now.getTime() + leaseMs);
    try {
        const record = await Model.findOneAndUpdate(
            {
                _id: key,
                $or: [
                    { expiresAt: { $lte: now } },
                    { owner }
                ]
            },
            {
                $set: { owner, expiresAt },
                $setOnInsert: { _id: key }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return { acquired: Boolean(record && record.owner === owner), expiresAt };
    } catch (error) {
        // An unexpired record does not match the update filter. With upsert on,
        // Mongo then attempts to insert the same unique key; that duplicate-key
        // result is the atomic "another worker owns this" signal.
        if (error && error.code === 11000) return { acquired: false, expiresAt: null };
        throw error;
    }
}

async function release(Model, { key, owner }) {
    await Model.deleteOne({ _id: key, owner });
}

module.exports = { createModel, acquire, release };
