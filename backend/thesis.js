// Thesis Tracker — the personalized through-line the Monitor cannot be.
//
// The Monitor ranks a filing by GENERIC materiality (size of the deltas). It
// does not know WHY you own the stock. Here the user writes their thesis in
// plain English ("data-center revenue keeps growing >30%, gross margin holds
// above 70%, no single customer >15%"). We split it into discrete claims and,
// against the latest filing, grade each one: holding / weakening / broken /
// unclear — with the specific figure or filing quote that supports the grade.
// Grounded: the grader is handed the same finished facts the Monitor computes
// (YoY deltas) plus the verbatim filing-diff narrative; it judges, it never
// fabricates numbers.

const mongoose = require('mongoose');
const aiClient = require('./ai-client');
const filingMonitor = require('./filing-monitor');

const ThesisSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true },
    text: { type: String, required: true },          // the user's thesis, plain English
    claims: { type: [String], default: [] },          // split out by the model at save time
    lastGrade: { type: mongoose.Schema.Types.Mixed, default: null },
    lastGradedAccession: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
ThesisSchema.index({ user: 1, symbol: 1 }, { unique: true });
const Thesis = mongoose.models.Thesis || mongoose.model('Thesis', ThesisSchema);

const SPLIT_SYSTEM = [
    'You split an investor\'s plain-English stock thesis into discrete, individually-checkable claims. Reply with ONLY a JSON object, no prose, no fences.',
    'Schema: {"claims": [str]}. 1-6 claims, each a single testable assertion (e.g. "Revenue grows faster than 20% per year", "Gross margin stays above 70%", "Debt stays manageable"). Preserve the investor\'s intent; do not add claims they did not make.'
].join('\n');

const GRADE_SYSTEM = [
    'You grade an investor\'s thesis claims about a company against the latest SEC filing evidence supplied. Reply with ONLY a JSON object, no prose, no fences.',
    'Schema: {"claims": [{"claim": str, "status": "holding"|"weakening"|"broken"|"unclear", "evidence": str}], "overall": "intact"|"mixed"|"impaired", "summary": str}',
    'Use ONLY the supplied facts (year-over-year deltas computed from filings, and the verbatim what-changed narrative). Never invent numbers or use outside knowledge. "evidence" cites the specific figure or quoted change behind the grade; if the filing does not speak to a claim, status="unclear".',
    '"summary" is one neutral sentence on whether the thesis still holds. No advice, no buy/sell language.'
].join('\n');

function digestForGrading(report) {
    const lines = [];
    if (report.reportedPeriod) lines.push(`Latest reported period: ${report.reportedPeriod} (vs ${report.priorPeriod || 'year-ago'}).`);
    if (report.deltas && report.deltas.length) {
        lines.push('Year-over-year figures:');
        for (const d of report.deltas) lines.push(`- ${d.label}: ${d.latest} (${d.change} vs ${d.prior})`);
    }
    if (report.narrative && report.narrative.headline) {
        lines.push(`What changed (from the filing): ${report.narrative.headline}`);
        for (const c of (report.narrative.changes || []).slice(0, 6)) {
            lines.push(`- ${c.area}: ${c.what}${c.quote ? ` ("${c.quote}")` : ''}`);
        }
    }
    return lines.join('\n');
}

function parseJson(msg, guard) {
    try {
        const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
        const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        return guard(p) ? p : null;
    } catch (_) { return null; }
}

async function splitClaims(text) {
    try {
        const msg = await aiClient.chatRaw([
            { role: 'system', content: SPLIT_SYSTEM },
            { role: 'user', content: `Thesis:\n${text}` }
        ], { purpose: 'summary', temperature: 0, maxTokens: 600, timeoutMs: 30000 });
        const p = parseJson(msg, (x) => Array.isArray(x.claims));
        if (p) return p.claims.slice(0, 6).map((c) => String(c).slice(0, 200)).filter(Boolean);
    } catch (_) { /* fall through */ }
    // fallback: split on sentences/semicolons
    return String(text).split(/[.;\n]+/).map((s) => s.trim()).filter((s) => s.length > 4).slice(0, 6);
}

async function saveThesis(userId, symbol, text) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) throw Object.assign(new Error('Invalid ticker'), { status: 400 });
    const body = String(text || '').trim();
    if (body.length < 8) throw Object.assign(new Error('Write a sentence or two on why you own (or are watching) it.'), { status: 400 });
    if (body.length > 2000) throw Object.assign(new Error('Keep the thesis under 2000 characters.'), { status: 400 });
    const claims = await splitClaims(body);
    const doc = await Thesis.findOneAndUpdate(
        { user: userId, symbol: sym },
        { $set: { text: body, claims, updatedAt: new Date(), lastGrade: null, lastGradedAccession: null }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, new: true }
    );
    return doc;
}

async function listTheses(userId) {
    return Thesis.find({ user: userId }).sort({ updatedAt: -1 }).lean();
}

async function deleteThesis(userId, symbol) {
    await Thesis.deleteOne({ user: userId, symbol: String(symbol || '').toUpperCase().trim() });
}

// Grade a thesis against the latest filing. Reuses the Monitor's report (cached
// per accession), so grading is cheap once the report exists. Re-grades only
// when a new filing has landed, unless force=true.
async function gradeThesis(userId, symbol, { force = false } = {}) {
    const sym = String(symbol || '').toUpperCase().trim();
    const doc = await Thesis.findOne({ user: userId, symbol: sym });
    if (!doc) return { error: 'No thesis saved for this ticker.' };

    let report = null;
    try { report = await filingMonitor.buildReport(sym); } catch (_) { report = null; }
    if (!report || report.error) return { error: (report && report.error) || 'Could not read the latest filing.' };
    const accession = (report.periodic && report.periodic.accession) || (report.latestFiling && report.latestFiling.date) || null;

    if (!force && doc.lastGrade && doc.lastGradedAccession && accession && doc.lastGradedAccession === accession) {
        // lastGrade already carries the graded per-claim objects + gradedFiling.
        return { ...doc.lastGrade, cached: true, thesis: doc.text };
    }

    const digest = digestForGrading(report);
    let parsed = null;
    try {
        const msg = await aiClient.chatRaw([
            { role: 'system', content: GRADE_SYSTEM },
            { role: 'user', content: `Company: ${sym}.\nInvestor's thesis claims:\n${doc.claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nLatest filing evidence:\n${digest}\n\nGrade each claim.` }
        ], { purpose: 'summary', temperature: 0.1, maxTokens: 1600, timeoutMs: 45000 });
        parsed = parseJson(msg, (x) => Array.isArray(x.claims) && typeof x.overall === 'string');
    } catch (_) { parsed = null; }
    if (!parsed) return { error: 'Grading failed — try again in a moment.' };

    const STATUS = new Set(['holding', 'weakening', 'broken', 'unclear']);
    const grade = {
        overall: ['intact', 'mixed', 'impaired'].includes(parsed.overall) ? parsed.overall : 'mixed',
        summary: String(parsed.summary || '').slice(0, 400),
        claims: parsed.claims.slice(0, 6).map((c) => ({
            claim: String(c.claim || '').slice(0, 200),
            status: STATUS.has(c.status) ? c.status : 'unclear',
            evidence: String(c.evidence || '').slice(0, 300)
        })).filter((c) => c.claim),
        gradedFiling: report.periodic || report.latestFiling,
        gradedAt: new Date().toISOString(),
        note: 'Graded from year-over-year figures computed off filed statements and the verbatim what-changed narrative. Not investment advice.'
    };
    try {
        await Thesis.updateOne({ _id: doc._id }, { $set: { lastGrade: grade, lastGradedAccession: accession } });
    } catch (_) { /* best-effort */ }
    // grade.claims is the graded per-claim array (claim/status/evidence) the UI needs.
    return { ...grade, thesis: doc.text };
}

module.exports = { saveThesis, listTheses, deleteThesis, gradeThesis, Thesis };
