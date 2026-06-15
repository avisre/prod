// ESG — filings-grounded, no paid ratings. The honest edge over a black-box
// third-party score: every point is sourced to a SEC filing and the score
// measures DISCLOSURE COMPLETENESS, not performance.
//
// Three legs:
//   Governance (strongest) — reuses the DEF 14A extraction from governance.js.
//   Environmental — VOLUNTARY, principles-based. The SEC's prescriptive climate
//     rule (adopted Mar-2024) was stayed and never took effect, and on 3-Jun-2026
//     the SEC proposed to rescind it entirely. So we read whatever the company
//     volunteers in its 10-K (targets, net-zero, renewables, Scope 1/2) and say so.
//   Human capital (Social) — MANDATED since 9-Nov-2020 under Reg S-K Item 101(c):
//     headcount + the human-capital measures management focuses on.
// Plus a litigation read from Item 3 / Item 1A. The transparency score weights
// governance 40 / environmental 35 / human-capital 25 — toward where investors
// actually hold levers and where disclosure is most complete.

const filing = require('./filing-fetcher');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// 0 from the model on these fields means "not disclosed", not a real zero.
const posNum = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

const ESG_SYSTEM = [
    'You extract Environmental, Social (human-capital), and litigation disclosures from a company 10-K text. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"environmental": {"discussesClimate": true|false, "emissionsTarget": str|null, "netZeroCommitment": true|false|null, "renewablePct": number|null, "scope1": str|null, "scope2": str|null, "summary": str}, "humanCapital": {"employeeCount": int|null, "turnoverPct": number|null, "deiDisclosed": true|false, "safetyDisclosed": true|false, "trainingDisclosed": true|false, "summary": str}, "litigation": {"materiality": "high"|"medium"|"low"|"none", "summary": str}}',
    'Rules: use ONLY what the supplied text states. Null/false when not disclosed (do NOT infer). emissionsTarget/scope1/scope2 are short verbatim-ish phrases (e.g. "net zero by 2040", "1.2M tCO2e") or null. summary fields are one neutral sentence each, drawn from the text, no advice. materiality "none" only if no material proceedings are described.'
].join('\n');

function guard(o) { return o && typeof o === 'object' && o.environmental && o.humanCapital && o.litigation; }

async function extractEsgFromTenK(symbol) {
    const got = await filing.getFilingText(symbol, '10-K', { maxChars: 420000 });
    if (!got || got.error) return { error: (got && got.error) || 'No 10-K found.' };
    const text = filing.windows(got.text, [
        /sustainab|emissions|climate|greenhouse|carbon|renewable|net[- ]zero/i,
        /human capital|workforce|our employees|talent|diversity|inclusion|turnover/i,
        /legal proceedings|litigation|regulatory proceeding/i
    ], { before: 400, after: 7000, maxChars: 30000 });
    const ext = await filing.extractJson(ESG_SYSTEM, `10-K text (windowed):\n${text}\n\nExtract E / human-capital / litigation disclosures.`, guard, { maxTokens: 1400 });
    if (!ext) return { error: 'Could not parse the 10-K ESG sections reliably.', filing: { date: got.date, url: got.url } };

    const e = ext.environmental || {}, s = ext.humanCapital || {}, l = ext.litigation || {};
    const MAT = new Set(['high', 'medium', 'low', 'none']);
    return {
        environmental: {
            discussesClimate: !!e.discussesClimate || !!e.emissionsTarget || /climate|emission|carbon|renewable/i.test(String(e.summary || '')),
            emissionsTarget: e.emissionsTarget ? String(e.emissionsTarget).slice(0, 120) : null,
            netZeroCommitment: typeof e.netZeroCommitment === 'boolean' ? e.netZeroCommitment : null,
            renewablePct: posNum(e.renewablePct),
            scope1: e.scope1 ? String(e.scope1).slice(0, 60) : null,
            scope2: e.scope2 ? String(e.scope2).slice(0, 60) : null,
            summary: String(e.summary || '').slice(0, 280),
            basis: 'Voluntary, principles-based disclosure — the SEC climate rule was stayed and is proposed for rescission (Jun 2026); there is no mandated climate format.'
        },
        humanCapital: {
            employeeCount: posNum(s.employeeCount),
            turnoverPct: posNum(s.turnoverPct),
            deiDisclosed: !!s.deiDisclosed,
            safetyDisclosed: !!s.safetyDisclosed,
            trainingDisclosed: !!s.trainingDisclosed,
            summary: String(s.summary || '').slice(0, 280),
            basis: 'Mandated since Nov-2020 (Reg S-K Item 101(c)): headcount plus the human-capital measures management focuses on.'
        },
        litigation: { materiality: MAT.has(l.materiality) ? l.materiality : 'low', summary: String(l.summary || '').slice(0, 280) },
        filing: { date: got.date, url: got.url, accession: got.accession }
    };
}

// completeness 0-100 = share of the pillar's fields actually disclosed
function govCompleteness(g) {
    if (!g) return 0;
    const fields = [g.boardSize, g.independencePct, g.womenPct, g.ceoChairCombined, g.sayOnPayApprovalPct, g.dualClassShares, g.ceoPayRatio, (g.committees && g.committees.length ? 1 : null), g.auditor];
    const got = fields.filter((x) => x !== null && x !== undefined).length;
    return Math.round((got / fields.length) * 100);
}
function envCompleteness(e) {
    if (!e) return 0;
    const fields = [e.discussesClimate ? 1 : null, e.emissionsTarget, e.netZeroCommitment, e.renewablePct, e.scope1, e.scope2];
    const got = fields.filter((x) => x !== null && x !== undefined && x !== false).length;
    return Math.round((got / fields.length) * 100);
}
function hcCompleteness(s) {
    if (!s) return 0;
    const fields = [s.employeeCount, s.turnoverPct, s.deiDisclosed ? 1 : null, s.safetyDisclosed ? 1 : null, s.trainingDisclosed ? 1 : null];
    const got = fields.filter((x) => x !== null && x !== undefined && x !== false).length;
    return Math.round((got / fields.length) * 100);
}

// `governance` may be passed in (from governance.js) so the DEF 14A isn't
// re-extracted; the board leg is otherwise null and the score skips it.
async function buildESG(symbol, { governance = null } = {}) {
    const esg = await extractEsgFromTenK(symbol).catch((e) => ({ error: String(e && e.message || e) }));
    const gov = governance && governance.board ? governance.board : null;

    // A FAILED 10-K fetch must NOT score as "0% disclosure" — that falsely implies
    // the company discloses nothing. Unavailable pillars are null and excluded from
    // the score; the score is reweighted over the pillars we could actually read.
    const tenKOk = esg && !esg.error;
    const byPillar = {
        governance: gov ? govCompleteness(gov) : null,
        environmental: tenKOk ? envCompleteness(esg.environmental) : null,
        humanCapital: tenKOk ? hcCompleteness(esg.humanCapital) : null
    };
    const W = { governance: 0.40, environmental: 0.35, humanCapital: 0.25 };
    let numer = 0, denom = 0;
    for (const k of Object.keys(W)) if (byPillar[k] != null) { numer += W[k] * byPillar[k]; denom += W[k]; }
    const overall = denom > 0 ? Math.round(numer / denom) : null;
    const verdict = overall == null ? null : overall >= 70 ? 'Transparent disclosure' : overall >= 45 ? 'Selective disclosure' : 'Minimal ESG disclosure';
    const partial = !tenKOk; // 10-K legs couldn't be read

    // Whole section is withheld only when NOTHING could be read.
    if (overall == null) return { error: (esg && esg.error) || 'ESG data unavailable.', transparency: null };

    return {
        error: null,
        transparency: { overall, byPillar, verdict, partial, unavailable: partial ? "Couldn't read the 10-K — environmental & human-capital pillars are unavailable; score reflects governance only." : null },
        governance: gov ? {
            boardSize: gov.boardSize, independencePct: gov.independencePct, womenPct: gov.womenPct,
            ceoChairCombined: gov.ceoChairCombined, sayOnPayApprovalPct: gov.sayOnPayApprovalPct,
            dualClassShares: gov.dualClassShares, ceoPayRatio: gov.ceoPayRatio,
            source: governance.boardFiling || null
        } : null,
        environmental: esg && !esg.error ? esg.environmental : null,
        humanCapital: esg && !esg.error ? esg.humanCapital : null,
        litigation: esg && !esg.error ? esg.litigation : null,
        filing: esg && esg.filing ? esg.filing : null,
        honesty: 'Sourced only from SEC filings — DEF 14A (governance) and the 10-K (human capital under Reg S-K Item 101(c); environmental disclosure is voluntary). No third-party ESG rating (MSCI/Sustainalytics) is applied. The transparency score reflects how COMPLETELY a company discloses, not how it performs — strong practices can still score low if under-disclosed.'
    };
}

module.exports = { buildESG, extractEsgFromTenK };
