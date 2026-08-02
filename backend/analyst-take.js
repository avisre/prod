// Analyst take — a compelling, filing-grounded narrative read of a company,
// shown on the public /stocks/:ticker page. This is the conversion surface: it
// has to demonstrate the product's analytical brain to a cold visitor, not just
// list tables. Two layers:
//   • templateTake(facts)  — deterministic prose synthesised from the numbers.
//     Always available, instant, free, never wrong. The floor.
//   • getTake(sym, facts)  — returns a legacy disk-cached take when present,
//     otherwise the deterministic template. It NEVER invokes a model. Public
//     page requests (including crawlers) must remain zero-cost.
//
// Rules mirror the rest of the AI surface: numbers come from the facts the
// caller computed in code; the model only writes prose; strictly descriptive,
// never buy/sell/hold advice or a price target.

const fs = require('fs');
const path = require('path');

const TAKE_DIR = path.join(__dirname, '..', 'frontend', 'data', 'analyst-takes');
const TAKE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — fundamentals move slowly
function cacheFile(sym) {
    return path.join(TAKE_DIR, `${String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}.json`);
}
function readCache(sym) {
    try {
        const f = cacheFile(sym);
        if (!fs.existsSync(f)) return null;
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!j || !j.take || !j.at) return null;
        if (Date.now() - j.at > TAKE_TTL_MS) return null;
        return j;
    } catch (_) { return null; }
}

// ---- Deterministic template (the always-on floor) ----
// `f` is the facts bundle assembled by the caller (see seo-pages.renderStockPage).
function templateTake(f) {
    if (!f || !f.name) return '';
    const name = f.name; const sym = f.sym;
    const P = [];

    // 1) Scale & trajectory
    const traj = [];
    if (f.revFirst && f.revLatest && f.yearsCount >= 3) {
        traj.push(`${name} has grown revenue from ${f.revFirst} to ${f.revLatest} over the last ${f.yearsCount} fiscal years`);
        if (f.revCagr5Pct !== null && f.revCagr5Pct !== undefined) traj.push(`compounding about ${f.revCagr5Pct}% a year`);
    } else if (f.revLatest) {
        traj.push(`${name} posted ${f.revLatest} in revenue in fiscal ${f.latestFY}`);
    }
    let p1 = traj.join(', ');
    if (f.revYoYPct !== null && f.revYoYPct !== undefined) {
        const dir = f.revYoYPct >= 0 ? 'up' : 'down';
        const pace = (f.revCagr5Pct !== null && f.revCagr5Pct !== undefined)
            ? (f.revYoYPct > f.revCagr5Pct + 1 ? ', so growth is actually accelerating'
                : (f.revYoYPct < f.revCagr5Pct - 1 ? ', so growth has cooled from its longer-run pace' : ', roughly in line with its longer-run pace'))
            : '';
        p1 += `. The most recent year was ${dir} ${Math.abs(f.revYoYPct)}%${pace}`;
    }
    if (p1) P.push(p1 + '.');

    // 2) Profitability & cash
    const prof = [];
    if (f.netMarginPct !== null && f.netMarginPct !== undefined) {
        let m = `Net margin sits at ${f.netMarginPct}%`;
        if (f.netMarginChangePts !== null && f.netMarginChangePts !== undefined && Math.abs(f.netMarginChangePts) >= 0.3) {
            m += `, ${f.netMarginChangePts >= 0 ? 'up' : 'down'} ${Math.abs(f.netMarginChangePts)} points year over year`;
        }
        prof.push(m);
    }
    if (f.grossMarginPct !== null && f.grossMarginPct !== undefined) prof.push(`on a ${f.grossMarginPct}% gross margin`);
    let p2 = prof.join(' ');
    const cashBits = [];
    if (f.fcfMarginPct !== null && f.fcfMarginPct !== undefined) cashBits.push(`it converts roughly ${f.fcfMarginPct}% of revenue into free cash flow`);
    if (f.debtTotal && f.debtNote) cashBits.push(f.debtNote);
    else if (f.paysDividend) cashBits.push(`it returns cash through a dividend${f.divYield ? ` yielding about ${f.divYield}` : ''}`);
    if (cashBits.length) {
        let cash = cashBits.join(', ');
        cash = cash.charAt(0).toUpperCase() + cash.slice(1);
        p2 = p2 ? `${p2.replace(/\.\s*$/, '')}. ${cash}` : cash;
    }
    if (p2) P.push(p2.replace(/\.\s*$/, '') + '.');

    // 3) Valuation tension + the watch item
    const v = [];
    if (f.impliedGrowthPct !== null && f.impliedGrowthPct !== undefined) {
        let s = `At today's valuation the market is pricing in roughly ${f.impliedGrowthPct}% annual free-cash-flow growth`;
        if (f.recordFcfCagr5Pct !== null && f.recordFcfCagr5Pct !== undefined) {
            const gap = f.impliedGrowthPct - f.recordFcfCagr5Pct;
            s += ` — versus the ${f.recordFcfCagr5Pct}% it actually delivered over the last five years`;
            s += gap > 3 ? ', so the price already assumes a step-up from the recent record'
                : (gap < -3 ? ', so the price is arguably undemanding against what it has already proven' : ', broadly in line with what it has delivered');
        }
        v.push(s);
    }
    if (f.healthTotal) v.push(`it clears ${f.healthPassed} of ${f.healthTotal} deterministic health checks`);
    if (f.redFlagsCount > 0 && f.topRedFlag) v.push(`the one thing worth a second look in the filings is ${f.topRedFlag.toLowerCase()}`);
    else if (f.healthTotal && f.redFlagsCount === 0) v.push(`nothing in the filed statements trips our red-flag scan`);
    let p3 = v.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('. ');
    if (p3) P.push(p3.replace(/\.\s*$/, '') + '.');

    return P.join('\n\n');
}

// Synchronous and zero-cost: never blocks the page render and never invokes AI.
// Existing cached prose may still be served, but no page view can create it.
function getTake(sym, facts) {
    const key = String(sym || '').toUpperCase();
    const cached = readCache(key);
    if (cached && cached.take) return { take: cached.take, source: 'ai' };
    return { take: templateTake(facts), source: 'template' };
}

module.exports = { getTake, templateTake };
