'use strict';

// Five non-recycled invitations bound to email addresses. Checkout failures
// deliberately hold the seat for operator reconciliation, never oversell it.
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const PLAN_ID = 'filing-watch';
const CAPACITY = 5;
const PRICE = 49;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function fail(status, message, code) {
    return Object.assign(new Error(message), { status, statusCode: status, code });
}
function model() {
    if (mongoose.models.FilingWatchSeat) return mongoose.models.FilingWatchSeat;
    const schema = new mongoose.Schema({
        _id: { type: Number, min: 1, max: CAPACITY },
        email: { type: String, default: null },
        inviteHash: { type: String, select: false },
        state: { type: String, enum: ['available', 'invited', 'reserved', 'checkout'], default: 'available' },
        issuedAt: Date,
        reservedAt: Date,
        pendingSignupId: mongoose.Schema.Types.ObjectId,
        stripeSessionId: String,
        userId: mongoose.Schema.Types.ObjectId,
        tickers: { type: [String], default: [] },
        tickersSubmittedAt: Date,
        baselineDueAt: Date,
        baselineSentAt: Date,
        deliveries: [{ weekEnding: String, sentAt: Date, evidence: String }]
    }, { collection: 'filing_watch_seats', timestamps: true });
    schema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
    return mongoose.model('FilingWatchSeat', schema);
}
async function issue(email) {
    assertEnabled();
    const normalized = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw fail(400, 'A valid customer email is required.', 'EMAIL_INVALID');
    const Seat = model();
    await Seat.init();
    for (let i = 1; i <= CAPACITY; i++) {
        try { await Seat.updateOne({ _id: i }, { $setOnInsert: { state: 'available' } }, { upsert: true }); }
        catch (error) { if (error.code !== 11000) throw error; }
    }
    if (await Seat.exists({ email: normalized })) throw fail(409, 'This email already has a pilot invitation.', 'INVITE_EXISTS');
    const token = crypto.randomBytes(32).toString('hex');
    const seat = await Seat.findOneAndUpdate({ state: 'available' }, {
        $set: { email: normalized, inviteHash: hash(token), state: 'invited', issuedAt: new Date() }
    }, { sort: { _id: 1 }, new: true });
    if (!seat) throw fail(409, 'All five pilot invitations have been allocated.', 'PILOT_FULL');
    return { seat: seat._id, token };
}
async function reserve(token, email) {
    assertEnabled();
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) throw fail(403, 'Use your personal Filing Watch invitation to register.', 'INVITE_REQUIRED');
    const seat = await model().findOneAndUpdate({
        inviteHash: hash(token), email: String(email).trim().toLowerCase(), state: 'invited'
    }, { $set: { state: 'reserved', reservedAt: new Date() } }, { new: true });
    if (!seat) throw fail(409, 'This invitation is unavailable or already has a checkout. Contact the founder to resume it.', 'INVITE_UNAVAILABLE');
    return seat;
}
async function bindPending(seat, pending) {
    await model().updateOne({ _id: seat._id, state: 'reserved' }, { $set: { pendingSignupId: pending._id } });
}
async function beginCheckout(pending) {
    assertEnabled();
    if (!pending) throw fail(403, 'Filing Watch is available to invited new customers only.', 'NEW_CUSTOMER_REQUIRED');
    const seat = await model().findOneAndUpdate({ pendingSignupId: pending._id, state: 'reserved' }, {
        $set: { state: 'checkout' }
    }, { new: true });
    if (!seat) throw fail(409, 'This invitation already has a checkout. Contact the founder to resume it.', 'INVITE_UNAVAILABLE');
    return seat;
}
async function recordSession(seat, session) {
    await model().updateOne({ _id: seat._id }, { $set: { stripeSessionId: session.id } });
}
async function linkUser(pendingId, userId) {
    await model().updateOne({ pendingSignupId: pendingId }, { $set: { userId } });
}
function active(user) {
    return user?.subscription?.planId === PLAN_ID && ['active', 'cancel_at_period_end'].includes(user.subscription.status);
}
function assertEnabled() {
    if (process.env.FILING_WATCH_ENABLED !== 'true') throw fail(503, 'Filing Watch pilot checkout is not open yet.', 'PILOT_NOT_OPEN');
}
function normalizeTickers(input) {
    if (!Array.isArray(input) || input.length !== 3) throw fail(400, 'Choose exactly three supported US-listed stocks.', 'THREE_TICKERS_REQUIRED');
    const tickers = input.map(s => String(s).trim().toUpperCase());
    if (new Set(tickers).size !== 3 || tickers.some(s => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(s))) {
        throw fail(400, 'Enter three different stock tickers.', 'TICKERS_INVALID');
    }
    return tickers;
}
async function submitTickers(user, input, covered) {
    if (!active(user)) throw fail(403, 'An active Filing Watch subscription is required.', 'SUBSCRIPTION_REQUIRED');
    const tickers = normalizeTickers(input);
    if (tickers.some(ticker => !covered(ticker))) throw fail(400, 'One or more tickers are not supported. Contact the founder before choosing a replacement.', 'TICKER_UNSUPPORTED');
    const now = new Date();
    const seat = await model().findOneAndUpdate({ userId: user._id, tickersSubmittedAt: null }, {
        $set: { tickers, tickersSubmittedAt: now, baselineDueAt: new Date(now.getTime() + 48 * 3600000) }
    }, { new: true });
    if (!seat) throw fail(409, 'Your stocks are already saved. Contact the founder for changes.', 'TICKERS_ALREADY_SAVED');
    return seat;
}
function mount(app, { auth, admin, User, covered, priceReady, notify }) {
    const wrap = fn => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await fn(req, res); }
        catch (error) { res.status(error.statusCode || 503).json({ message: error.code ? error.message : 'Filing Watch is temporarily unavailable.', code: error.code || 'FILING_WATCH_UNAVAILABLE' }); }
    };
    app.get('/api/filing-watch/status', wrap(async (req, res) => {
        res.json({ enabled: process.env.FILING_WATCH_ENABLED === 'true', price: PRICE, capacity: CAPACITY });
    }));
    app.post('/api/admin/filing-watch/invitations', admin, wrap(async (req, res) => {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (await User.exists({ email })) throw fail(409, 'The pilot is for entirely new customers.', 'EXISTING_CUSTOMER');
        if (!await priceReady()) throw fail(503, 'The $49/month Stripe price has not been verified.', 'PRICE_UNVERIFIED');
        const invite = await issue(email);
        const url = new URL('/register', process.env.PUBLIC_APP_URL || 'https://www.stockportfolio.pro');
        url.searchParams.set('plan', PLAN_ID);
        url.searchParams.set('invite', invite.token);
        url.searchParams.set('next', 'filing-watch/start');
        res.json({ seat: invite.seat, url: url.toString() });
    }));
    app.get('/api/admin/filing-watch', admin, wrap(async (req, res) => {
        const seats = await model().find({ state: { $ne: 'available' } }).sort({ _id: 1 }).lean();
        const rows = await Promise.all(seats.map(async seat => {
            const user = seat.userId ? await User.findById(seat.userId).select('subscription stripeSubscriptionId initialPaymentAt initialRefundStatus').lean() : null;
            return { ...seat, subscription: user?.subscription || null, stripeSubscriptionId: user?.stripeSubscriptionId || null,
                initialPaymentAt: user?.initialPaymentAt || null, initialRefundStatus: user?.initialRefundStatus || null };
        }));
        res.json({ capacity: CAPACITY, allocated: rows.length, rows, revenueNote: 'Verify live Stripe paid invoices and refunds before counting recurring revenue. Invitations and app status are not payment evidence.' });
    }));
    app.post('/api/admin/filing-watch/:seat/revoke', admin, wrap(async (req, res) => {
        // Once checkout starts, a card may already be processing. Never free
        // that slot without a separate Stripe reconciliation by the operator.
        const seat = await model().findOneAndUpdate({ _id: Number(req.params.seat), state: 'invited' }, {
            $set: { state: 'available', email: null }, $unset: { inviteHash: '', issuedAt: '' }
        });
        if (!seat) throw fail(409, 'Only an unused invitation can be revoked. A started checkout needs Stripe reconciliation.', 'CHECKOUT_RECONCILIATION_REQUIRED');
        res.json({ revoked: true });
    }));
    app.post('/api/admin/filing-watch/:seat/deliveries', admin, wrap(async (req, res) => {
        const { weekEnding, evidence, baseline } = req.body || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekEnding)) || !Number.isFinite(Date.parse(weekEnding)) || !String(evidence || '').trim() || String(evidence).length > 1000) throw fail(400, 'Provide the delivery date and a sent-message reference.', 'DELIVERY_EVIDENCE_REQUIRED');
        const seat = await model().findById(Number(req.params.seat));
        const user = seat?.userId ? await User.findById(seat.userId) : null;
        if (!active(user) || !seat?.tickersSubmittedAt) throw fail(409, 'No active, onboarded customer in this seat.', 'CUSTOMER_NOT_READY');
        const update = { $push: { deliveries: { weekEnding, evidence: String(evidence).trim(), sentAt: new Date() } } };
        if (baseline === true) update.$set = { baselineSentAt: new Date() };
        const saved = await model().findOneAndUpdate({ _id: seat._id, 'deliveries.evidence': { $ne: String(evidence).trim() } }, update, { new: true });
        res.json({ recorded: !!saved });
    }));
    app.get('/api/filing-watch', auth, wrap(async (req, res) => {
        const user = await User.findById(req.user._id);
        if (!active(user)) throw fail(403, 'An active Filing Watch subscription is required.', 'SUBSCRIPTION_REQUIRED');
        const seat = await model().findOne({ userId: user._id }).select('tickers tickersSubmittedAt baselineDueAt baselineSentAt').lean();
        res.json({ seat });
    }));
    app.post('/api/filing-watch/tickers', auth, wrap(async (req, res) => {
        const user = await User.findById(req.user._id);
        const seat = await submitTickers(user, req.body?.tickers, covered);
        // A durable queue row is the source of truth if notification fails.
        const notified = await notify({ name: user.name, email: user.email, subject: 'Filing Watch starting brief due', message: `Seat ${seat._id}: ${seat.tickers.join(', ')}. Starting brief due ${seat.baselineDueAt.toISOString()}. Check /api/admin/filing-watch daily.` }).catch(() => false);
        res.json({ tickers: seat.tickers, baselineDueAt: seat.baselineDueAt, notificationAccepted: !!notified });
    }));
}
module.exports = { PLAN_ID, PRICE, CAPACITY, model, issue, reserve, bindPending, beginCheckout, recordSession, linkUser, active, normalizeTickers, submitTickers, mount };
