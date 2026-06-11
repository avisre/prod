// Insights — the analyst's reading, not a numbers recital.
//
// Everything quantitative is computed HERE, deterministically, from the
// fundamentals cache and the screen index: growth/margin trajectories,
// valuation against the company's own 10-year P/E record, capital returns,
// sector position. The model receives that fact pack and is allowed to do
// exactly one thing: connect facts into decision-relevant observations.
// No fact outside the pack may appear. Cached in Mongo per fiscal year.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const aiClient = require('./ai-client');
const aiChat = require('./ai-chat');

const FUND_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r1 = (v) => v === null ? null : Math.round(v * 10) / 10;
function cagr(first, last, years) {
    if (!first || !last || first <= 0 || last <= 0 || years < 1.5) return null;
    return (Math.pow(last / first, 1 / years) - 1) * 100;
}

function loadFund(symbol) {
    try {
        const f = path.join(FUND_DIR, `${String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '_')}.json`);
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) { return null; }
}

function joined(d) {
    const by = new Map();
    for (const st of ['income', 'balance', 'cash']) {
        for (const r of ((d[st] || {}).annualReports) || []) {
            const k = String(r.fiscalDateEnding || '').slice(0, 7);
            if (!k) continue;
            if (!by.has(k)) by.set(k, { end: r.fiscalDateEnding });
            by.get(k)[st] = r;
        }
    }
    return [...by.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)));
}

function buildFactPack(symbol) {
    const d = loadFund(symbol);
    if (!d) return null;
    const ov = d.overview || {};
    const years = joined(d);
    if (years.length < 4) return null;
    const L = [];
    const g = (y, st, f) => num(((y || {})[st] || {})[f]);
    const yr = (i) => years[years.length - 1 - i];
    const fyName = (y) => 'FY' + new Date(y.end).getFullYear();
    const last = yr(0);
    const span = years.length - 1;

    const rev = (y) => g(y, 'income', 'totalRevenue');
    const ni = (y) => g(y, 'income', 'netIncome');
    const nm = (y) => { const a = ni(y); const b = rev(y); return (a !== null && b) ? a / b * 100 : null; };
    const gp = (y) => {
        const r = rev(y); let v = g(y, 'income', 'grossProfit'); if (v === 0) v = null;
        let c = g(y, 'income', 'costOfRevenue'); if (c === 0) c = null;
        if (v === null && r !== null && c !== null) v = r - c;
        return (v !== null && r) ? v / r * 100 : null;
    };
    const om = (y) => { const a = g(y, 'income', 'operatingIncome'); const b = rev(y); return (a !== null && b) ? a / b * 100 : null; };
    const fcf = (y) => {
        const o = g(y, 'cash', 'operatingCashflow'); const c = g(y, 'cash', 'capitalExpenditures');
        return (o !== null && c !== null) ? o + c : null;
    };
    const sh = (y) => g(y, 'balance', 'commonStockSharesOutstanding');
    const debt = (y) => ['shortTermDebt', 'currentLongTermDebt', 'longTermDebt']
        .map((k) => g(y, 'balance', k)).filter((v) => v !== null).reduce((a, v) => a + v, 0) || null;
    const eq = (y) => g(y, 'balance', 'totalShareholderEquity');

    L.push(`COMPANY ${ov.Name || symbol} (${symbol}), sector ${ov.Sector || '?'}, latest fiscal year ${fyName(last)} (ended ${last.end}). ${years.length} fiscal years on record.`);
    L.push(`REVENUE: latest $${r1(rev(last) / 1e9)}B. CAGR ${span}y ${r1(cagr(rev(years[0]), rev(last), span))}%, 5y ${years.length > 5 ? r1(cagr(rev(yr(5)), rev(last), 5)) : '—'}%, 3y ${years.length > 3 ? r1(cagr(rev(yr(3)), rev(last), 3)) : '—'}%, 1y ${r1((rev(last) / rev(yr(1)) - 1) * 100)}%.`);
    L.push(`NET INCOME: latest $${r1(ni(last) / 1e9)}B. 5y CAGR ${years.length > 5 ? r1(cagr(ni(yr(5)), ni(last), 5)) : '—'}%, 1y ${ni(yr(1)) > 0 ? r1((ni(last) / ni(yr(1)) - 1) * 100) : '—'}%.`);
    L.push(`MARGINS (gross/operating/net %): now ${r1(gp(last))}/${r1(om(last))}/${r1(nm(last))}; 5y ago ${years.length > 5 ? `${r1(gp(yr(5)))}/${r1(om(yr(5)))}/${r1(nm(yr(5)))}` : '—'}; 10y ago ${years.length > 10 ? `${r1(gp(yr(10)))}/${r1(om(yr(10)))}/${r1(nm(yr(10)))}` : '—'}.`);
    const f0 = fcf(last); const o0 = g(last, 'cash', 'operatingCashflow');
    L.push(`CASH: FCF latest $${f0 === null ? '—' : r1(f0 / 1e9)}B (FCF margin ${f0 !== null && rev(last) ? r1(f0 / rev(last) * 100) : '—'}%). OCF/netIncome ${o0 !== null && ni(last) ? r1(o0 / ni(last) * 100) / 100 : '—'}.`);
    const s0 = sh(last); const s5 = years.length > 5 ? sh(yr(5)) : null; const s10 = years.length > 10 ? sh(yr(10)) : null;
    L.push(`SHARES OUT: ${s0 ? r1(s0 / 1e9) + 'B' : '—'}; change 5y ${s0 && s5 ? r1((s0 / s5 - 1) * 100) + '%' : '—'}, 10y ${s0 && s10 ? r1((s0 / s10 - 1) * 100) + '%' : '—'}. Buybacks latest yr $${g(last, 'cash', 'paymentsForRepurchaseOfCommonStock') !== null ? r1(Math.abs(g(last, 'cash', 'paymentsForRepurchaseOfCommonStock')) / 1e9) : '—'}B, dividends $${g(last, 'cash', 'dividendPayout') !== null ? r1(Math.abs(g(last, 'cash', 'dividendPayout')) / 1e9) : '—'}B.`);
    const d0 = debt(last); const e0 = eq(last);
    L.push(`BALANCE SHEET: debt/equity now ${d0 !== null && e0 ? (d0 / e0).toFixed(2) : '—'} vs 5y ago ${years.length > 5 && debt(yr(5)) !== null && eq(yr(5)) ? (debt(yr(5)) / eq(yr(5))).toFixed(2) : '—'}. ROE now ${ni(last) !== null && e0 ? r1(ni(last) / e0 * 100) : '—'}%.`);

    // valuation vs the company's own record: avg P/E per fiscal year
    const ts = (d.monthly || {})['Monthly Adjusted Time Series'] || {};
    const months = Object.keys(ts).sort().map((k) => ({
        month: k.slice(0, 7),
        close: num(ts[k]['5. adjusted close']) !== null ? num(ts[k]['5. adjusted close']) : num(ts[k]['4. close'])
    })).filter((m) => m.close !== null);
    const peHist = [];
    for (let i = 0; i < Math.min(10, years.length); i++) {
        const y = yr(i);
        const eps = g(y, 'income', 'dilutedEPS');
        if (eps === null || eps <= 0) continue;
        const end = String(y.end).slice(0, 7);
        const idx = months.findIndex((m) => m.month >= end);
        const win = months.slice(Math.max(0, (idx === -1 ? months.length : idx) - 11), (idx === -1 ? months.length : idx) + 1);
        if (win.length) peHist.push(win.reduce((a, m) => a + m.close, 0) / win.length / eps);
    }
    const peNow = num(ov.PERatio);
    const peAvg = peHist.length >= 5 ? peHist.reduce((a, v) => a + v, 0) / peHist.length : null;
    L.push(`VALUATION: P/E now ${peNow === null ? '—' : r1(peNow)}; own ${peHist.length}-yr average P/E ${peAvg === null ? '—' : r1(peAvg)} (range ${peHist.length ? r1(Math.min(...peHist)) + '–' + r1(Math.max(...peHist)) : '—'}). Market cap $${num(ov.MarketCapitalization) !== null ? r1(num(ov.MarketCapitalization) / 1e12 * 100) / 100 : '—'}T. Dividend yield ${num(ov.DividendYield) !== null ? r1(num(ov.DividendYield) * 100 * 100) / 100 : '—'}%.`);
    const pCagr = (n) => months.length > n * 12 ? r1(cagr(months[months.length - 1 - n * 12].close, months[months.length - 1].close, n)) : null;
    L.push(`STOCK PRICE CAGR: 10y ${pCagr(10)}%, 5y ${pCagr(5)}%, 3y ${pCagr(3)}% (split-adjusted).`);

    // sector context from the screen index
    try {
        const sector = (ov.Sector || '').trim();
        if (sector) {
            const { rows } = aiChat.screenRows({ sector, limit: 100, maxLimit: 100 });
            const med = (key) => {
                const vs = rows.map((x) => x[key]).filter((v) => v !== null).sort((a, b) => a - b);
                return vs.length ? r1(vs[Math.floor(vs.length / 2)]) : null;
            };
            L.push(`SECTOR (${sector}, ${rows.length} companies) MEDIANS: P/E ${med('pe')}, net margin ${med('netMarginPct')}%, revenue CAGR 5y ${med('revCagr5Pct')}%, ROE ${med('roePct')}%.`);
        }
    } catch (_) { /* sector context optional */ }
    return { lines: L.join('\n'), fyEnd: String(last.end) };
}

const SYSTEM = [
    'You are an equity analyst writing for a long-term investor. You receive a fact pack about one company.',
    'Write 4 to 6 INSIGHTS about what makes THIS business distinctive — the things an investor could not learn from any other company\'s page:',
    '- the shape of the business: which products/segments make the money, which one drives the growth, what the mix shift means for margins;',
    '- the economics: why its margin/returns structure looks the way it does versus its sector, where the operating leverage or capital intensity sits;',
    '- the record: whether shareholder returns came from the business or from multiple expansion; capital returns vs dilution; cash conversion quality;',
    '- the price: valuation against the company\'s OWN history and its current growth rate.',
    'An insight must CONNECT two or more facts. When BUSINESS SEGMENTS or 10-K DOSSIER facts are present in the pack, at least TWO insights MUST be about the shape of the business itself — its segment/product mix, where the growth and margin actually come from, concentration in one region or product — not pure financial ratios.',
    'Reply with ONLY JSON: {"insights": [{"title": str, "body": str}]}. Title ≤ 8 words, sharp, specific. Body 2-3 sentences, containing the concrete numbers it draws on.',
    'FORBIDDEN: restating a single metric as an "insight"; generic statements that fit any company; praise; buy/sell/hold language or advice; any number not present in the fact pack; repeating anything listed under ALREADY SHOWN — the reader has read those, go beyond them.',
    'If two facts tension each other (e.g. premium valuation + slowing growth), say so plainly. British English.'
].join('\n');

// Segment + dossier context (cached only — never trigger an extraction here):
// segments give the model the product/revenue split; key-point headings tell
// it what the reader has ALREADY seen, so Insights goes beyond, not over.
async function businessContext(symbol) {
    const out = { lines: [], shown: [] };
    try {
        const seg = await mongoose.connection.collection('company_segments')
            .find({ symbol }).sort({ at: -1 }).limit(1).next();
        const segs = (((seg || {}).payload) || {}).segments || [];
        if (segs.length) {
            out.lines.push('BUSINESS SEGMENTS (latest 10-K): ' + segs.map((s) =>
                `${s.name} $${s.revenueUsd !== null && s.revenueUsd !== undefined ? Math.round(s.revenueUsd / 1e6) : '—'}M${s.revenuePct ? ` (${s.revenuePct}%)` : ''}`).join('; ') + '.');
        }
    } catch (_) { /* optional */ }
    try {
        const kp = await mongoose.connection.collection('company_keypoints')
            .find({ symbol }).sort({ at: -1 }).limit(1).next();
        const sections = (((kp || {}).payload) || {}).sections || [];
        if (sections.length) {
            out.shown = sections.map((s) => s.heading);
            // the points themselves are raw material the model may build on
            out.lines.push('FROM THE 10-K DOSSIER: ' + sections.map((s) =>
                `${s.heading}: ${(s.points || []).slice(0, 3).join(' | ')}`).join(' || '));
        }
    } catch (_) { /* optional */ }
    return out;
}

async function generateInsights(symbol) {
    const pack = buildFactPack(symbol);
    if (!pack) return { error: 'Not enough filed history for insights.' };

    const col = mongoose.connection.collection('company_insights');
    try {
        const hit = await col.findOne({ symbol, fyEnd: pack.fyEnd });
        if (hit && Date.now() - new Date(hit.at).getTime() < CACHE_TTL_MS) return { ...hit.payload, cached: true };
    } catch (_) { /* cache best-effort */ }

    const biz = await businessContext(symbol);
    const packText = pack.lines
        + (biz.lines.length ? `\n${biz.lines.join('\n')}` : '')
        + (biz.shown.length ? `\nALREADY SHOWN to the reader as Key Points (do NOT restate): ${biz.shown.join('; ')}.` : '');
    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Fact pack:\n${packText}${extra}` }
    ], { purpose: 'summary', temperature: 0.2, maxTokens: 6000 });
    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return Array.isArray(p.insights) ? p : null;
        } catch (_) { return null; }
    };
    let parsed = tryParse(await callModel(''));
    if (!parsed) parsed = tryParse(await callModel('\nREPLY WITH ONLY THE JSON OBJECT.'));
    if (!parsed) return { error: 'Insight generation failed — try again later.' };

    const payload = {
        symbol,
        insights: parsed.insights.slice(0, 6).map((i) => ({
            title: String(i.title || '').slice(0, 80),
            body: String(i.body || '').slice(0, 500)
        })).filter((i) => i.title && i.body),
        basis: 'Computed from SEC-filed statements, the company’s own 10-year valuation record, and sector medians across our S&P 1500 universe.',
        generatedAt: new Date().toISOString()
    };
    if (!payload.insights.length) return { error: 'Insight generation failed — try again later.' };
    try {
        await col.updateOne({ symbol, fyEnd: pack.fyEnd }, { $set: { payload, at: new Date() } }, { upsert: true });
    } catch (_) { /* cache best-effort */ }
    return payload;
}

module.exports = { generateInsights, buildFactPack };
