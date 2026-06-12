'use strict';

/**
 * Wash-sale guard — cross-account tax-lot intelligence.
 *
 * Brokers only track wash sales inside their own walls; the IRS §1091 rule
 * spans ALL your accounts (and your IRA, where a washed loss is PERMANENTLY
 * disallowed — it never adjusts basis). Investors discover this at filing
 * time. We take trade history from any broker as CSV, keep tax lots per
 * account, and:
 *
 *   1. Report — every loss sale with a buy of the same ticker within the
 *      61-day window (30 days before through 30 after) in ANY account,
 *      with the disallowed-loss estimate and the IRA poison case flagged.
 *   2. Pre-trade check — "if I sell X at a loss today, is it washed?"
 *
 * Everything is deterministic; FIFO lot matching per account. This is a
 * planning aid, not tax advice — the report says so.
 */

const mongoose = require('mongoose');

const WINDOW_DAYS = 30; // §1091: 30 days before and after the loss sale
const MS_DAY = 24 * 3600 * 1000;

const TradeSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    account: { type: String, required: true },   // user's label, e.g. "Fidelity taxable", "Vanguard IRA"
    accountType: { type: String, enum: ['taxable', 'ira'], default: 'taxable' },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    date: { type: String, required: true },      // YYYY-MM-DD
    shares: { type: Number, required: true },
    price: { type: Number, required: true },     // per share, USD
    importedAt: { type: Date, default: Date.now }
});
TradeSchema.index({ user: 1, symbol: 1, date: 1 });
const Trade = mongoose.models.Trade || mongoose.model('Trade', TradeSchema);

// ---- CSV import: generic header matching across broker exports ----
// Recognised header aliases (lowercased, non-alphanumerics stripped):
const HEADER_ALIASES = {
    date: ['date', 'tradedate', 'rundate', 'activitydate', 'transactiondate', 'datetime', 'dateacquired', 'settlementdate'],
    symbol: ['symbol', 'ticker', 'tickersymbol', 'instrument', 'security', 'stock'],
    side: ['side', 'action', 'transactiontype', 'transcode', 'buysell', 'type', 'activity', 'description'],
    shares: ['shares', 'quantity', 'qty', 'units', 'noofshares'],
    price: ['price', 'priceusd', 'pricepershare', 'shareprice', 'executionprice', 'avgprice', 'tprice', 'unitprice']
};

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
        if (ch === '"') { q = !q; continue; }
        if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

function normalizeDate(raw) {
    const s = String(raw || '').trim().replace(/['"]/g, '');
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);             // ISO
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);            // US MM/DD/YYYY
    if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function normalizeSide(raw) {
    const s = String(raw || '').toLowerCase();
    if (/\b(buy|bought|purchase|reinvest|byo?|bto)\b/.test(s)) return 'buy';
    if (/\b(sell|sold|sale|sto?|stc)\b/.test(s)) return 'sell';
    return null;
}

function parseCsv(csvText) {
    const lines = String(csvText || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (lines.length < 2) return { error: 'The CSV needs a header row and at least one trade.' };
    const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Find the header row (broker exports often lead with disclaimers).
    let headerIdx = -1; let cols = null;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const cells = splitCsvLine(lines[i]).map(norm);
        const map = {};
        for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
            // alias order is priority order: "Trans Code" beats "Description"
            for (const alias of aliases) {
                const at = cells.indexOf(alias);
                if (at >= 0) { map[field] = at; break; }
            }
        }
        if (map.date !== undefined && map.symbol !== undefined && map.shares !== undefined) {
            headerIdx = i; cols = map; break;
        }
    }
    if (headerIdx < 0) {
        return { error: 'Could not find the columns. The CSV needs headers including: date, symbol/ticker, action/side, quantity/shares, price.' };
    }
    const trades = [];
    const skipped = [];
    for (let i = headerIdx + 1; i < lines.length && trades.length < 5000; i++) {
        const cells = splitCsvLine(lines[i]);
        const date = normalizeDate(cells[cols.date]);
        const symbol = String(cells[cols.symbol] || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
        const side = cols.side !== undefined ? normalizeSide(cells[cols.side]) : null;
        const shares = Math.abs(parseFloat(String(cells[cols.shares] || '').replace(/[,$]/g, '')));
        const price = cols.price !== undefined ? Math.abs(parseFloat(String(cells[cols.price] || '').replace(/[,$]/g, ''))) : NaN;
        // Negative quantity with no side column means a sell in some exports.
        const rawQty = cols.side === undefined ? parseFloat(String(cells[cols.shares] || '').replace(/[,$]/g, '')) : null;
        const effSide = side || (rawQty !== null && rawQty < 0 ? 'sell' : rawQty !== null && rawQty > 0 ? 'buy' : null);
        if (!date || !symbol || !effSide || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) {
            if (cells.join('').trim()) skipped.push(i + 1);
            continue;
        }
        trades.push({ date, symbol, side: effSide, shares, price });
    }
    if (!trades.length) return { error: 'No usable trade rows found — check the date, symbol, action, quantity and price columns.' };
    return { trades, skippedLines: skipped.slice(0, 20), skippedCount: skipped.length };
}

async function importCsv(userId, { account, accountType, csv }) {
    const label = String(account || '').trim().slice(0, 60);
    if (!label) throw Object.assign(new Error('Give the account a name (e.g. "Fidelity taxable").'), { status: 400 });
    const type = String(accountType) === 'ira' ? 'ira' : 'taxable';
    const parsed = parseCsv(csv);
    if (parsed.error) throw Object.assign(new Error(parsed.error), { status: 400 });
    // Re-import replaces the account wholesale — idempotent, no dedup puzzles.
    await Trade.deleteMany({ user: userId, account: label });
    await Trade.insertMany(parsed.trades.map((t) => ({ ...t, user: userId, account: label, accountType: type })));
    return { account: label, accountType: type, imported: parsed.trades.length, skipped: parsed.skippedCount || 0 };
}

async function listAccounts(userId) {
    const rows = await Trade.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(String(userId)) } },
        { $group: { _id: { account: '$account', type: '$accountType' }, trades: { $sum: 1 }, last: { $max: '$date' } } }
    ]);
    return rows.map((r) => ({ account: r._id.account, accountType: r._id.type, trades: r.trades, lastTrade: r.last }));
}

async function deleteAccount(userId, account) {
    await Trade.deleteMany({ user: userId, account: String(account) });
}

// ---- the engine: FIFO basis per account, wash detection across accounts ----
function daysBetween(a, b) {
    return Math.round(Math.abs(new Date(a) - new Date(b)) / MS_DAY);
}

function computeWashSales(trades) {
    // group chronologically per symbol
    const bySymbol = new Map();
    for (const t of trades) {
        if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
        bySymbol.get(t.symbol).push(t);
    }
    const findings = [];
    for (const [symbol, list] of bySymbol) {
        list.sort((a, b) => a.date.localeCompare(b.date) || (a.side === 'buy' ? -1 : 1));
        // FIFO open lots per account; each lot keeps a ref to its source buy
        // so the shares SOLD in this very sale never count as "replacement".
        const lots = new Map(); // account -> [{date, shares, price, src}]
        for (const t of list) {
            const acct = lots.get(t.account) || [];
            if (t.side === 'buy') {
                acct.push({ date: t.date, shares: t.shares, price: t.price, src: t });
                lots.set(t.account, acct);
                continue;
            }
            // sell: consume FIFO, compute realized P&L for this sale
            let remaining = t.shares;
            let costBasis = 0;
            let matched = 0;
            const consumed = new Map(); // src buy trade -> shares used by THIS sale
            while (remaining > 0 && acct.length) {
                const lot = acct[0];
                const take = Math.min(lot.shares, remaining);
                costBasis += take * lot.price;
                matched += take;
                lot.shares -= take;
                remaining -= take;
                if (lot.src) consumed.set(lot.src, (consumed.get(lot.src) || 0) + take);
                if (lot.shares <= 1e-9) acct.shift();
            }
            lots.set(t.account, acct);
            if (matched <= 0) continue; // sale without recorded basis — skip honestly
            const proceeds = matched * t.price;
            const pnl = proceeds - costBasis;
            if (pnl >= 0) continue; // gains can't be washed
            // loss sale: buys of the same symbol within ±30 days in ANY account
            // count as replacement shares — net of any portion of that buy that
            // was itself the lot sold here.
            const conflicts = list.filter((b) =>
                b.side === 'buy' && daysBetween(b.date, t.date) <= WINDOW_DAYS
            ).map((b) => ({
                account: b.account, accountType: b.accountType, date: b.date,
                shares: Math.max(0, b.shares - (consumed.get(b) || 0))
            })).filter((b) => b.shares > 1e-9);
            if (!conflicts.length) continue;
            const replacementShares = conflicts.reduce((a, b) => a + b.shares, 0);
            const washedFraction = Math.min(1, replacementShares / matched);
            const disallowed = Math.round(Math.abs(pnl) * washedFraction * 100) / 100;
            const iraPoison = conflicts.some((c) => c.accountType === 'ira');
            findings.push({
                symbol,
                sellDate: t.date,
                sellAccount: t.account,
                sharesSold: matched,
                loss: Math.round(pnl * 100) / 100,
                disallowedEstimate: disallowed,
                crossAccount: conflicts.some((c) => c.account !== t.account),
                iraPoison,
                conflicts: conflicts.slice(0, 10)
            });
        }
    }
    findings.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
    return findings;
}

async function washReport(userId) {
    const trades = await Trade.find({ user: userId }).lean();
    if (!trades.length) return { empty: true };
    const findings = computeWashSales(trades);
    const accounts = [...new Set(trades.map((t) => t.account))];
    return {
        accounts,
        trades: trades.length,
        findings,
        totalDisallowedEstimate: Math.round(findings.reduce((a, f) => a + f.disallowedEstimate, 0) * 100) / 100,
        note: `A loss sale with a buy of the same ticker within ${WINDOW_DAYS} days before or after — in ANY of your accounts — is a wash sale (IRS §1091): the loss is disallowed and rolls into the replacement shares' basis. If the replacement buy is in an IRA, the loss is permanently gone. Estimates assume FIFO lots and "substantially identical" = same ticker. A planning aid, not tax advice.`
    };
}

// Pre-trade: "I'm about to sell <symbol> at a loss — is it washed?"
async function preTradeCheck(userId, symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) throw Object.assign(new Error('Invalid symbol'), { status: 400 });
    const since = new Date(Date.now() - WINDOW_DAYS * MS_DAY).toISOString().slice(0, 10);
    const buys = await Trade.find({ user: userId, symbol: sym, side: 'buy', date: { $gte: since } }).lean();
    return {
        symbol: sym,
        windowDays: WINDOW_DAYS,
        recentBuys: buys.map((b) => ({ account: b.account, accountType: b.accountType, date: b.date, shares: b.shares })),
        wouldWash: buys.length > 0,
        iraPoison: buys.some((b) => b.accountType === 'ira'),
        note: buys.length
            ? `Selling ${sym} at a loss today would be a wash sale — you bought it within the last ${WINDOW_DAYS} days. Buying it back within ${WINDOW_DAYS} days after the sale also washes it.`
            : `No buys of ${sym} in the last ${WINDOW_DAYS} days across your imported accounts. Remember: buying it back within ${WINDOW_DAYS} days AFTER a loss sale also triggers the rule.`
    };
}

module.exports = { importCsv, listAccounts, deleteAccount, washReport, preTradeCheck, computeWashSales, parseCsv, Trade };
