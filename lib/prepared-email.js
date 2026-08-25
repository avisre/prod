'use strict';

// Prepared-but-unsent email queue.
//
// Two jobs (jobs/trial-expiry-check.js, jobs/monitor-digest.js) render a real,
// addressed, ready-to-send email and then deliberately stop. Nothing in this
// module talks to SMTP; a human decides what actually goes out.
//
// `queueKey` is also the idempotency key. It carries the fact that makes the
// mail unique — for a Monitor digest, the user plus the exact filing accession
// — so the same filing change can never be queued (and therefore never sent)
// to the same person twice, no matter how often the sweep runs.

const path = require('node:path');
const mongoose = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mongoose'));

const PreparedEmailSchema = new mongoose.Schema({
    queueKey: { type: String, required: true, unique: true, index: true },
    template: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: String, required: true, lowercase: true, trim: true },
    subject: { type: String, required: true },
    html: { type: String, required: true },
    text: { type: String, default: '' },
    // queued  — rendered, waiting on a human
    // sent    — a human released it (set by whatever sends it, not by us)
    // cancelled — a human decided against it
    status: { type: String, enum: ['queued', 'sent', 'cancelled'], default: 'queued', index: true },
    queuedAt: { type: Date, default: () => new Date() },
    sentAt: { type: Date, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, versionKey: false, collection: 'prepared_emails' });

const PreparedEmail = mongoose.models.PreparedEmail || mongoose.model('PreparedEmail', PreparedEmailSchema);

/**
 * Queue one email. Returns 'queued' on a fresh insert and 'duplicate' when the
 * key already exists — the caller should treat 'duplicate' as "already handled",
 * never as an error.
 */
async function queueEmail(doc) {
    try {
        await PreparedEmail.create({ ...doc, status: 'queued' });
        return 'queued';
    } catch (err) {
        if (err && err.code === 11000) return 'duplicate';
        throw err;
    }
}

module.exports = { PreparedEmail, queueEmail };
