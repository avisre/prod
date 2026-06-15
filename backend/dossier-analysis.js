// Dossier analysis — the deterministic layer that makes the report an
// initiation, not a summary: peer/competitive positioning, peer-multiples
// valuation, and a set of forensic "edge" signals a generic AI write-up
// misses (earnings quality, capital allocation, the expectation gap, margin
// trajectory, Rule of 40, leverage). All computed in code from filed numbers;
// the model only narrates the standouts.

const aiChat = require('./ai-chat');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const median = (arr) => {
    const a = arr.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
// fraction of peers strictly below the company's value (0-100)
const percentile = (val, peers) => {
    const a = peers.filter((x) => x !== null && Number.isFinite(x));
    if (val === null || !a.length) return null;
    return Math.round((a.filter((x) => x < val).length / a.length) * 100);
};
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

// ---- Competitive positioning + peer-multiples valuation ----
function peerAnalysis(symbol, overview) {
    const sym = String(symbol || '').toUpperCase();
    const sector = (overview && overview.Sector) || '';
    if (!sector) return null;
    let rows = [];
    try { rows = (aiChat.screenRows({ sector, limit: 600, maxLimit: 600 }) || {}).rows || []; } catch (_) { rows = []; }
    const me = aiChat.metricsFor(sym) || {};
    const peers = rows.filter((r) => r.symbol !== sym);
    if (peers.length < 3) return null;

    const col = (k) => peers.map((r) => num(r[k]));
    const meds = {
        pe: median(col('pe').filter((v) => v !== null && v > 0)),
        revCagr5Pct: median(col('revCagr5Pct')),
        netMarginPct: median(col('netMarginPct')),
        roePct: median(col('roePct')),
        divYieldPct: median(col('divYieldPct'))
    };
    const mine = {
        pe: num(me.pe), revCagr5Pct: num(me.revCagr5Pct), netMarginPct: num(me.netMarginPct),
        roePct: num(me.roePct), divYieldPct: num(me.divYieldPct), marketCapB: num(me.marketCapB)
    };
    const rank = {
        revCagr5Pct: percentile(mine.revCagr5Pct, col('revCagr5Pct')),
        netMarginPct: percentile(mine.netMarginPct, col('netMarginPct')),
        roePct: percentile(mine.roePct, col('roePct'))
    };

    // peer-multiples valuation: where it trades vs the peer-median P/E
    let multiples = null;
    if (mine.pe && mine.pe > 0 && meds.pe && meds.pe > 0) {
        const premiumPct = r1((mine.pe / meds.pe - 1) * 100);
        const repriceToMedianPct = r1((meds.pe / mine.pe - 1) * 100); // +ve = upside if it re-rated to peer median
        multiples = { companyPe: r1(mine.pe), peerMedianPe: r1(meds.pe), premiumPct, repriceToMedianPct };
    }

    // a one-line computed verdict (no AI) — growth/quality vs valuation
    const hi = (p) => p !== null && p >= 67;
    const lo = (p) => p !== null && p <= 33;
    const growthWord = hi(rank.revCagr5Pct) ? 'top-third growth' : lo(rank.revCagr5Pct) ? 'bottom-third growth' : 'mid-pack growth';
    const qualWord = hi(rank.netMarginPct) || hi(rank.roePct) ? 'above-peer profitability' : (lo(rank.netMarginPct) && lo(rank.roePct)) ? 'below-peer profitability' : 'in-line profitability';
    const valWord = multiples ? (multiples.premiumPct > 15 ? 'at a premium multiple' : multiples.premiumPct < -15 ? 'at a discount multiple' : 'in line on multiple') : null;
    const verdict = [growthWord, qualWord].join(', ') + (valWord ? `, trading ${valWord}` : '') + ` versus its ${peers.length} sector peers.`;

    // a compact peer comp table: the 5 nearest-by-market-cap peers
    const near = peers
        .filter((r) => num(r.marketCapB) !== null)
        .sort((a, b) => Math.abs((num(a.marketCapB) || 0) - (mine.marketCapB || 0)) - Math.abs((num(b.marketCapB) || 0) - (mine.marketCapB || 0)))
        .slice(0, 6)
        .map((r) => ({ symbol: r.symbol, name: r.name, marketCapB: r1(num(r.marketCapB)), pe: r1(num(r.pe)), revCagr5Pct: r1(num(r.revCagr5Pct)), netMarginPct: r1(num(r.netMarginPct)), roePct: r1(num(r.roePct)) }));

    return {
        sector,
        peerCount: peers.length,
        company: { pe: r1(mine.pe), revCagr5Pct: r1(mine.revCagr5Pct), netMarginPct: r1(mine.netMarginPct), roePct: r1(mine.roePct), divYieldPct: r1(mine.divYieldPct) },
        medians: { pe: r1(meds.pe), revCagr5Pct: r1(meds.revCagr5Pct), netMarginPct: r1(meds.netMarginPct), roePct: r1(meds.roePct), divYieldPct: r1(meds.divYieldPct) },
        rank,
        multiples,
        verdict,
        comps: near
    };
}

// ---- Forensic "edge" signals — non-obvious, decision-relevant, all computed ----
function annual(data, st) { return (((data || {})[st] || {}).annualReports) || []; }

function forensicSignals(data, rdcf, overview) {
    const inc = annual(data, 'income'), cash = annual(data, 'cash'), bal = annual(data, 'balance');
    const sig = [];
    const push = (key, label, value, read, flag) => sig.push({ key, label, value, read, flag: flag || 'neutral' });
    const i0 = inc[0] || {}, c0 = cash[0] || {}, b0 = bal[0] || {};
    const mc = num(overview && overview.MarketCapitalization);

    const ni = num(i0.netIncome);
    const ocf = num(c0.operatingCashflow);
    const capex = num(c0.capitalExpenditures);
    const fcf = (ocf !== null && capex !== null) ? ocf + capex : null;

    // 1) FCF conversion — how much reported profit becomes cash
    if (fcf !== null && ni && ni > 0) {
        const conv = fcf / ni;
        push('fcf_conversion', 'FCF conversion (FCF ÷ net income)', `${Math.round(conv * 100)}%`,
            conv >= 1 ? 'Earnings convert fully to cash — high-quality profit.' : conv >= 0.7 ? 'Most profit becomes cash.' : 'A chunk of reported profit is not turning into cash — worth understanding why.',
            conv >= 1 ? 'good' : conv >= 0.6 ? 'neutral' : 'watch');
    }

    // 2) Accruals / earnings-quality flag — NI persistently above OCF
    const nis = inc.slice(0, 3).map((r) => num(r.netIncome));
    const ocfs = cash.slice(0, 3).map((r) => num(r.operatingCashflow));
    if (nis.every((x) => x !== null) && ocfs.every((x) => x !== null) && ocfs.reduce((a, b) => a + b, 0) > 0) {
        const ratio = nis.reduce((a, b) => a + b, 0) / ocfs.reduce((a, b) => a + b, 0);
        if (ratio > 1.15) push('accruals', 'Earnings quality (3yr net income ÷ operating cash flow)', `${ratio.toFixed(2)}×`,
            'Reported earnings run ahead of operating cash over three years — an accruals red flag to investigate.', 'watch');
    }

    // 3) Capital allocation — buyback yield + payout discipline
    const repurch = Math.abs(num(c0.paymentsForRepurchaseOfCommonStock) || 0);
    if (mc && repurch > 0) {
        const by = (repurch / mc) * 100;
        push('buyback_yield', 'Buyback yield (repurchases ÷ market cap)', `${by.toFixed(1)}%`,
            by >= 3 ? 'Aggressive buybacks — material shareholder return on top of any dividend.' : 'Some shares being repurchased.',
            by >= 2 ? 'good' : 'neutral');
    }
    const div = Math.abs(num(c0.dividendPayout) || 0);
    if (div > 0 && fcf !== null && fcf > 0) {
        const cover = div / fcf;
        push('div_coverage', 'Dividend coverage (dividend ÷ free cash flow)', `${Math.round(cover * 100)}% of FCF`,
            cover > 1 ? 'The dividend costs more than free cash flow — funded from balance sheet, a sustainability risk.' : cover > 0.8 ? 'The dividend eats most of free cash flow — little cushion.' : 'The dividend is comfortably covered by free cash flow.',
            cover > 1 ? 'bad' : cover > 0.8 ? 'watch' : 'good');
    }

    // 4) Rule of 40 (growth + margin) — the quality-of-growth lens
    const g = rdcf && rdcf.record ? num(rdcf.record.revCagr5Pct) : null;
    const nm = (num(i0.totalRevenue) && ni !== null) ? (ni / num(i0.totalRevenue)) * 100 : null;
    if (g !== null && nm !== null) {
        const ro40 = g + nm;
        push('rule_of_40', 'Rule of 40 (5yr revenue growth + net margin)', `${Math.round(ro40)}`,
            ro40 >= 40 ? 'Clears the Rule of 40 — growth and profitability together are strong.' : 'Below the Rule of 40 — the growth/profit trade-off is middling.',
            ro40 >= 40 ? 'good' : 'neutral');
    }

    // 5) Margin trajectory — operating margin now vs 5 years ago
    const opm = (r) => (num(r && r.totalRevenue) && num(r && r.operatingIncome) !== null) ? (num(r.operatingIncome) / num(r.totalRevenue)) * 100 : null;
    const om0 = opm(i0), om5 = inc.length > 5 ? opm(inc[5]) : null;
    if (om0 !== null && om5 !== null && Math.abs(om0 - om5) >= 1) {
        push('margin_trend', 'Operating margin trajectory (vs 5 years ago)', `${om5.toFixed(1)}% → ${om0.toFixed(1)}%`,
            om0 > om5 ? 'Operating margins have expanded over five years — improving unit economics.' : 'Operating margins have compressed over five years — a structural watch-item.',
            om0 > om5 ? 'good' : 'watch');
    }

    // 6) The expectation gap — what the price assumes vs what's been delivered
    if (rdcf && rdcf.impliedGrowthPct !== null && rdcf.record && num(rdcf.record.fcfCagr5Pct) !== null) {
        const gap = rdcf.impliedGrowthPct - num(rdcf.record.fcfCagr5Pct);
        push('expectation_gap', 'Expectation gap (priced-in vs delivered FCF growth)', `${gap >= 0 ? '+' : ''}${Math.round(gap)} pts`,
            gap > 8 ? 'The price assumes materially faster FCF growth than the company has delivered — a high bar to clear.' : gap < -3 ? 'The price assumes slower growth than the recent record — a low bar / possible value setup.' : 'The price roughly assumes a continuation of the delivered growth rate.',
            gap > 8 ? 'watch' : gap < -3 ? 'good' : 'neutral');
    }

    // 7) Revenue deceleration — latest YoY vs the 5yr trend
    const rev0 = num(i0.totalRevenue), rev1 = num((inc[1] || {}).totalRevenue);
    if (rev0 && rev1 && rev1 > 0 && g !== null) {
        const yoy = (rev0 / rev1 - 1) * 100;
        if (Math.abs(yoy - g) >= 5) push('rev_decel', 'Revenue momentum (latest year vs 5yr average)', `${yoy >= 0 ? '+' : ''}${yoy.toFixed(0)}% vs ${g.toFixed(0)}%/yr`,
            yoy < g ? 'Growth is decelerating versus its five-year average.' : 'Growth is accelerating versus its five-year average.',
            yoy < g ? 'watch' : 'good');
    }

    // 8) Leverage — net debt vs equity
    const debt = (num(b0.shortTermDebt) || 0) + (num(b0.longTermDebt) || 0) + (num(b0.currentLongTermDebt) || 0);
    const cashEq = (num(b0.cashAndCashEquivalentsAtCarryingValue) || 0) + (num(b0.shortTermInvestments) || 0);
    const eq = num(b0.totalShareholderEquity);
    if (debt > 0 && eq && eq > 0) {
        const netDebt = debt - cashEq;
        const nd2e = netDebt / eq;
        push('leverage', 'Net debt ÷ equity', `${nd2e.toFixed(2)}×`,
            netDebt <= 0 ? 'Net cash — more cash and investments than total debt.' : nd2e > 1.5 ? 'Heavily levered relative to equity — financial-risk watch.' : 'Moderate leverage.',
            netDebt <= 0 ? 'good' : nd2e > 1.5 ? 'watch' : 'neutral');
    }

    return sig;
}

module.exports = { peerAnalysis, forensicSignals };
