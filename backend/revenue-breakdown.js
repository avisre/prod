'use strict';
// What a company sells, as one answer for every surface. The company page, the
// compare page and Ask each used to pick their own table, name it their own way
// and work out their own shares; four separate defects reached production that
// way in one day. This module is the only place that decides, and what it
// returns is a contract the callers render rather than reinterpret:
//
//   { symbol, grade, reason, kind, fiscalYear, periodEnd, currency, totalRevenue,
//     rows: [{ name, value, share }], remainder, coverage, note, source, filing }
//
//   grade   complete  rows account for revenue (98-102%, or up to 110% where
//                     segments are reported before eliminations)
//           partial   a real table that leaves part of revenue out; `remainder`
//                     is what it leaves, and it must be shown beside the rows
//           none      nothing trustworthy; `reason` says why in plain words
//   share   percent of `totalRevenue` for the row's own fiscal year, never of a
//           different year's revenue
//
// Selection, pruning and naming rules live in sec-segment-observations.js and
// ask-inline-segments.js; this file composes them and adds nothing of its own
// to the numbers.
const store = require('./sec-segment-observations');

const REASONS = {
    single: 'The company reports as a single business, so its filing has no revenue breakdown to show.',
    untagged: 'The latest annual filing does not tag a revenue breakdown that accounts for total revenue.',
    unavailable: 'No revenue breakdown could be read from the latest annual filing.',
    unread: 'A revenue breakdown has not been read from this company’s latest annual filing yet.'
};
const round1 = n => Math.round(n * 10) / 10;

function grade(coverage, rows) {
    if (rows < 2 || !(coverage > 0)) return 'none';
    if (coverage >= 0.98 && coverage <= 1.1) return 'complete';
    return coverage >= 0.6 && coverage < 0.98 ? 'partial' : 'none';
}
function none(symbol, reason) {
    return { symbol, grade: 'none', reason, kind: null, fiscalYear: null, periodEnd: null, currency: null, totalRevenue: null,
        rows: [], remainder: null, coverage: null, note: null, source: null, filing: null };
}
// Why the filing's tagged groups yield nothing: one member holding all of
// revenue is a single-segment company, which is a fact worth stating.
function whyNone(groups) {
    if (!(groups || []).length) return REASONS.unread;
    const single = (groups || []).some(g => { const v = store.shown(g); return v.rows.length === 1 && v.coverage > 0.98 && v.coverage < 1.02; });
    return single ? REASONS.single : REASONS.untagged;
}

// The deterministic answer from the filing's own tagged figures. No model and
// no network: the same input always gives the same contract, which is what the
// audit and the golden set check.
function fromGroups(groups, symbol = null) {
    const choice = store.preferred(groups), group = choice.usable || choice.partial;
    if (!group) return none(symbol, whyNone(groups));
    const view = store.shown(group), byMember = new Map(group.entries.map(e => [e.member, e])), byName = new Map();
    for (const row of view.rows) {
        const name = store.displayName(byMember.get(row.member));
        byName.set(name, (byName.get(name) || 0) + row.value);
    }
    const rows = [...byName].map(([name, value]) => ({ name, value, share: round1(value / group.totalRevenue * 100) })).sort((a, b) => b.value - a.value);
    const listed = rows.reduce((n, r) => n + r.value, 0), gap = group.totalRevenue - listed;
    const level = grade(view.coverage, rows.length);
    if (level === 'none') return none(symbol, whyNone(groups));
    return { symbol, grade: level, reason: null, kind: store.kind(group), fiscalYear: 'FY' + String(group.periodEnd).slice(0, 4), periodEnd: group.periodEnd,
        currency: group.currency, totalRevenue: group.totalRevenue, rows,
        remainder: gap > group.totalRevenue * 0.005 ? { name: 'Not broken out in the filing', value: gap, share: round1(gap / group.totalRevenue * 100) } : null,
        coverage: view.coverage,
        note: view.coverage > 1.02 ? 'Segments are reported before eliminations between them, so they add up to slightly more than total revenue.'
            : level === 'partial' ? `These lines are the filing’s own breakdown and cover ${Math.round(view.coverage * 100)}% of revenue; the rest is not broken out in this table.` : null,
        source: 'SEC inline XBRL', filing: { accessionNumber: group.sourceVersion, date: group.publicationDate, url: group.sourceUrl } };
}

// A breakdown read out of the filing text by the older extraction path. Graded
// by the same rule, against the company's filed revenue.
function fromText(payload, symbol, filedRevenue) {
    const rows = (payload?.segments || []).filter(s => s && s.name && Number(s.revenueUsd) > 0)
        .map(s => ({ name: String(s.name), value: Number(s.revenueUsd) })).sort((a, b) => b.value - a.value);
    if (!rows.length || !(filedRevenue > 0)) return none(symbol, rows.length ? REASONS.unavailable : REASONS.untagged);
    const listed = rows.reduce((n, r) => n + r.value, 0), coverage = listed / filedRevenue, level = grade(coverage, rows.length);
    if (level === 'none') return none(symbol, REASONS.untagged);
    const gap = filedRevenue - listed;
    return { symbol, grade: level, reason: null, kind: 'operating segments', fiscalYear: payload.fiscalYear || null, periodEnd: null, currency: 'USD', totalRevenue: filedRevenue,
        rows: rows.map(r => ({ ...r, share: round1(r.value / filedRevenue * 100) })),
        remainder: gap > filedRevenue * 0.005 ? { name: 'Not broken out in the filing', value: gap, share: round1(gap / filedRevenue * 100) } : null,
        coverage, note: level === 'partial' ? `These segments cover ${Math.round(coverage * 100)}% of filed revenue; the rest is not broken out.` : null,
        source: 'SEC annual report text', filing: payload.filing || null };
}

async function storedGroups(symbol) {
    if (process.env.SEC_COVERAGE_READ_ONLY === '1' || process.env.SEC_COVERAGE_DISABLE_ON_DEMAND === '1') return null;
    const evidence = await require('./verified-fundamentals').getCompanyEvidence(symbol).catch(() => null);
    return evidence?.statements?.segmentObservations || null;
}

// The answer for a symbol. `text: false` never calls the extraction model (a
// cached page read must not), and grades whatever text result is handed in.
async function forSymbol(symbol, { text = true, cachedText = null } = {}) {
    const sym = String(symbol || '').toUpperCase(), groups = await storedGroups(sym);
    const tagged = fromGroups(groups || [], sym);
    if (tagged.grade === 'complete') return tagged;
    const segments = require('./segments');
    let extracted = cachedText;
    if (!extracted && text) extracted = await segments.extractFromText(sym).catch(() => null);
    const read = extracted && !extracted.error ? fromText(extracted, sym, segments.filedRevenue(sym)) : none(sym, tagged.reason);
    // A complete text read beats a partial tagged table; otherwise the tagged one stands.
    if (read.grade === 'complete' || tagged.grade === 'none' && read.grade === 'partial') return read;
    return tagged;
}

// The shape the page and compare scripts have always read (`items`, `revenueUsd`,
// `revenuePct`), now carrying the contract beside it so nothing downstream has
// to work out a share, a remainder or a year for itself.
function forPage(contract) {
    if (!contract) return null;
    return { grade: contract.grade, reason: contract.reason, breakdown: contract.kind, fiscalYear: contract.fiscalYear, periodEnd: contract.periodEnd,
        totalRevenue: contract.totalRevenue, remainder: contract.remainder, note: contract.note, basis: contract.source, filing: contract.filing,
        items: contract.rows.map(r => ({ name: r.name, revenueUsd: contract.currency === 'USD' ? r.value : null, value: r.value, revenuePct: r.share, description: '' })) };
}

// What must be true of anything shown. Returns the list of violations.
function violations(contract) {
    const out = [];
    if (!contract || !['complete', 'partial', 'none'].includes(contract.grade)) return ['no grade'];
    if (contract.grade === 'none') { if (!contract.reason) out.push('nothing shown and no reason given'); if (contract.rows.length) out.push('rows present on a withheld breakdown'); return out; }
    const names = contract.rows.map(r => r.name);
    for (const name of names) if (!name || /:|_|Member$/.test(name)) out.push(`name "${name}" is not in plain words`);
    if (new Set(names).size !== names.length) out.push('duplicate row names');
    if (contract.rows.length < 2) out.push('fewer than two rows');
    if (contract.rows.some(r => !(r.value > 0) || !Number.isFinite(r.share))) out.push('a row without a positive value and share');
    if (!(contract.totalRevenue > 0)) out.push('no revenue to measure against');
    const shares = contract.rows.reduce((n, r) => n + r.share, 0) + (contract.remainder ? contract.remainder.share : 0);
    if (contract.grade === 'complete' && (shares < 97.5 || shares > 110.5)) out.push(`shares add to ${shares.toFixed(1)}%`);
    if (contract.grade === 'partial' && (!contract.remainder || Math.abs(shares - 100) > 1.5)) out.push('partial table without its remainder');
    return out;
}

module.exports = { forSymbol, fromGroups, fromText, forPage, violations, grade, REASONS };
