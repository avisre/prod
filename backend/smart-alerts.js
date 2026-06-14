'use strict';

/**
 * Smart fundamental alerts — the Pro intelligence layer on the watchdog sweep.
 * Price alerts are commodity (every broker has them); these watch what price
 * alerts can't:
 *
 *   1. Insider cluster buys — 2+ distinct insiders filing open-market BUYS
 *      (Form 4, code P) within a 14-day window. Single buys are noise;
 *      clusters are the studied signal.
 *   2. Dividend-cut risk — the dividend vs the cash that funds it, from filed
 *      statements: payout stretched over ~95% of net income or above free
 *      cash flow, or an actual cut in the latest fiscal year.
 *   3. User valuation thresholds — "tell me when AAPL's P/E drops below 25",
 *      checked against the nightly-refreshed screener index. Fires once per
 *      crossing (re-arms when the condition goes false again).
 *
 * All detectors are deterministic; alerts route through the same idempotent
 * Alert collection as the filing watchdog.
 */

const mongoose = require('mongoose');
const aiChat = require('./ai-chat');
const insiders = require('./insiders');

const CLUSTER_WINDOW_DAYS = 14;
const CLUSTER_MIN_INSIDERS = 2;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---- user alert rules (valuation thresholds) ----
const AlertRuleSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true },
    metric: { type: String, enum: ['pe', 'divYieldPct', 'marketCapB', 'revCagr5Pct'], required: true },
    op: { type: String, enum: ['lt', 'gt'], required: true },
    value: { type: Number, required: true },
    armed: { type: Boolean, default: true }, // re-arms when condition goes false
    createdAt: { type: Date, default: Date.now },
    lastFiredAt: { type: Date, default: null }
});
AlertRuleSchema.index({ user: 1, symbol: 1, metric: 1, op: 1, value: 1 }, { unique: true });
const AlertRule = mongoose.models.AlertRule || mongoose.model('AlertRule', AlertRuleSchema);

const METRIC_LABEL = {
    pe: 'P/E',
    divYieldPct: 'dividend yield %',
    marketCapB: 'market cap ($B)',
    revCagr5Pct: 'revenue CAGR 5y %'
};

// Smart alerts go to Pro subscribers only, unless AI_PRO_FOR_ALL=true
// (grandfathering mode — must match the gate default in app.js).
async function proFilter(userIds) {
    if (process.env.AI_PRO_FOR_ALL === 'true') return userIds;
    try {
        const User = mongoose.models.User;
        if (!User) return [];
        const users = await User.find(
            { _id: { $in: userIds }, 'subscription.planId': { $in: ['pro', 'pro-annual', 'power', 'power-monthly', 'desk', 'enterprise'] }, 'subscription.status': { $in: ['active', 'trialing', 'cancel_at_period_end'] } },
            { _id: 1 }
        ).lean();
        return users.map((u) => String(u._id));
    } catch (_) { return []; }
}

// ---- 1. insider cluster buys ----
// Uses the same parsed-Form-4 store the company page builds (incremental,
// SEC-paced); a sweep call only fetches filings it hasn't seen.
async function scanInsiderCluster(symbol, holderIds, createAlerts) {
    await insiders.buildHistory(symbol).catch(() => {});
    const col = mongoose.connection.collection('insider_form4');
    const cutoff = new Date(Date.now() - CLUSTER_WINDOW_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const docs = await col.find({ symbol, date: { $gte: cutoff } }).toArray();
    const buyers = new Map(); // owner -> { shares, value, lastDate }
    for (const d of docs) {
        for (const t of d.txns || []) {
            if (t.side !== 'buy') continue;
            const date = t.date || d.date;
            if (!date || date < cutoff) continue;
            const key = d.owner || 'unknown';
            const b = buyers.get(key) || { shares: 0, value: 0, lastDate: '' };
            b.shares += t.shares || 0;
            b.value += t.value || 0;
            if (date > b.lastDate) b.lastDate = date;
            buyers.set(key, b);
        }
    }
    if (buyers.size < CLUSTER_MIN_INSIDERS) return;
    const total = [...buyers.values()].reduce((a, b) => a + (b.value || 0), 0);
    const lastDate = [...buyers.values()].map((b) => b.lastDate).sort().pop();
    const ids = await proFilter(holderIds);
    if (!ids.length) return;
    await createAlerts(ids, {
        symbol,
        type: 'insider-cluster',
        // lastDate in the title keys idempotency: a new buy extends the
        // cluster and produces one fresh alert, repeat scans don't.
        title: `${symbol}: insider cluster buying — ${buyers.size} insiders bought through ${lastDate}`,
        detail: `${buyers.size} distinct insiders filed open-market purchases in the last ${CLUSTER_WINDOW_DAYS} days${total > 0 ? `, ~$${Math.round(total).toLocaleString('en-US')} combined` : ''}. Source: SEC Form 4 filings.`,
        url: `/company.html?symbol=${encodeURIComponent(symbol)}`
    });
}

// ---- 2. dividend-cut risk ----
async function scanDividendRisk(symbol, holderIds, createAlerts) {
    const data = await aiChat.loadFundAny(symbol);
    if (!data) return;
    const cash = ((data.cash || {}).annualReports) || [];
    const incomeR = ((data.income || {}).annualReports) || [];
    if (!cash.length) return;
    const div = (r) => { const d = num(r && r.dividendPayout); return d === null ? null : Math.abs(d); };
    const d0 = div(cash[0]);
    if (d0 === null || d0 === 0) return; // no dividend — nothing to watch
    const fy = String(cash[0].fiscalDateEnding || '').slice(0, 4);
    const ocf = num(cash[0].operatingCashflow);
    const capex = num(cash[0].capitalExpenditures);
    const fcf = ocf !== null && capex !== null ? ocf + capex : null;
    const ni = num((incomeR[0] || {}).netIncome);

    const problems = [];
    if (fcf !== null && fcf <= 0) problems.push('free cash flow was negative');
    else if (fcf !== null && d0 / fcf > 1) problems.push(`the payout was ${Math.round((d0 / fcf) * 100)}% of free cash flow`);
    if (ni !== null && ni <= 0) problems.push('net income was negative');
    else if (ni !== null && d0 / ni > 0.95) problems.push(`the payout was ${Math.round((d0 / ni) * 100)}% of net income`);
    const d1 = div(cash[1]);
    if (d1 !== null && d1 > 0 && d0 < d1 * 0.85) {
        problems.push(`the dividend was reduced ~${Math.round((1 - d0 / d1) * 100)}% vs the prior year`);
    }
    if (!problems.length) return;
    const ids = await proFilter(holderIds);
    if (!ids.length) return;
    await createAlerts(ids, {
        symbol,
        type: 'dividend-risk',
        // FY in the title: one alert per company per fiscal year of stretched data
        title: `${symbol}: dividend stretch in FY${fy} filings`,
        detail: `In the fiscal year ending ${cash[0].fiscalDateEnding}, ${problems.join('; ')}. Computed from filed statements — a flag to investigate, not a prediction.`,
        url: `/company.html?symbol=${encodeURIComponent(symbol)}`
    });
}

// ---- 3. user valuation thresholds ----
async function scanRules(createAlerts) {
    if (mongoose.connection.readyState !== 1) return;
    const rules = await AlertRule.find({}).lean();
    for (const rule of rules) {
        try {
            const m = aiChat.metricsFor(rule.symbol);
            const current = m ? num(m[rule.metric]) : null;
            if (current === null) continue;
            const hit = rule.op === 'lt' ? current < rule.value : current > rule.value;
            if (hit && rule.armed) {
                const ids = await proFilter([String(rule.user)]);
                if (ids.length) {
                    await createAlerts(ids, {
                        symbol: rule.symbol,
                        type: 'threshold',
                        title: `${rule.symbol}: ${METRIC_LABEL[rule.metric]} ${rule.op === 'lt' ? 'below' : 'above'} ${rule.value} (now ${Math.round(current * 100) / 100})`,
                        detail: `Your alert rule fired: ${rule.symbol} ${METRIC_LABEL[rule.metric]} is now ${Math.round(current * 100) / 100}. It re-arms if the condition reverses.`,
                        url: `/company.html?symbol=${encodeURIComponent(rule.symbol)}`
                    });
                }
                await AlertRule.updateOne({ _id: rule._id }, { $set: { armed: false, lastFiredAt: new Date() } });
            } else if (!hit && !rule.armed) {
                await AlertRule.updateOne({ _id: rule._id }, { $set: { armed: true } });
            }
        } catch (_) { /* per-rule fail-open */ }
    }
}

// ---- rule CRUD for routes ----
async function listRules(userId) {
    return AlertRule.find({ user: userId }).sort({ createdAt: -1 }).lean();
}
async function createRule(userId, { symbol, metric, op, value }) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) throw Object.assign(new Error('Invalid symbol'), { status: 400 });
    if (!METRIC_LABEL[metric]) throw Object.assign(new Error('Invalid metric'), { status: 400 });
    if (!['lt', 'gt'].includes(op)) throw Object.assign(new Error('Invalid comparison'), { status: 400 });
    const v = num(value);
    if (v === null) throw Object.assign(new Error('Invalid value'), { status: 400 });
    const count = await AlertRule.countDocuments({ user: userId });
    if (count >= 50) throw Object.assign(new Error('Rule limit reached (50)'), { status: 400 });
    try {
        return await AlertRule.create({ user: userId, symbol: sym, metric, op, value: v });
    } catch (e) {
        if (e && e.code === 11000) throw Object.assign(new Error('You already have this rule'), { status: 409 });
        throw e;
    }
}
async function deleteRule(userId, ruleId) {
    await AlertRule.deleteOne({ _id: ruleId, user: userId });
}

module.exports = { scanInsiderCluster, scanDividendRisk, scanRules, listRules, createRule, deleteRule, AlertRule, proFilter };
