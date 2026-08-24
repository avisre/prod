// Unit economics — "how much does this company make on the thing it actually
// sells". Revenue and gross profit are already in the fundamentals cache, but
// the volume behind them (cars delivered, subscribers, same-store sales,
// available seat miles, barrels/day…) only exists as prose in the 10-K. This
// extracts that volume, per company, and derives revenue/cost/profit PER UNIT
// deterministically in JS — the model only ever reads a number off the page,
// it never computes the economics itself.
//
// Same shape as segments.js: latest 10-K → keyword windows → strict-JSON
// extraction → cache per (symbol, accession). A company with no natural unit
// (a bank, a holding company) must come back with an empty metrics list, not
// an invented one.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const aiClient = require('./ai-client');
const segments = require('./segments');

const FUND_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');
const MAX_EXTRACT_CHARS = 28000;

// Broad, industry-agnostic — covers autos, retail, travel/hospitality,
// energy, telecom/subscription, shipping/logistics, semis, marketplaces,
// software and asset managers. Deliberately over-inclusive: a miss here just
// means the window falls back to the first MAX_EXTRACT_CHARS of the filing.
const ANCHORS = [
    /vehicles? (?:produced|delivered|manufactured)/gi, /units? (?:sold|delivered|shipped)/gi,
    /average selling price/gi, /\bASP\b/g,
    /(?:paid )?subscribers?/gi, /average revenue per (?:user|subscriber|member)/gi, /\bARPU\b/g,
    /same[- ]store sales/gi, /comparable(?: store)? sales/gi, /stores? (?:opened|operated|in operation)/gi,
    /available seat miles/gi, /revenue passenger miles/gi, /load factor/gi,
    /RevPAR/gi, /occupancy rate/gi, /rooms? (?:available|sold)/gi,
    /barrels? per day/gi, /production volumes?/gi,
    /tons? shipped/gi, /twenty[- ]foot equivalent/gi, /\bTEU\b/g,
    /wafers? shipped/gi, /gross merchandise value/gi, /\bGMV\b/g,
    /daily active users/gi, /monthly active users/gi, /\bDAU\b/g, /\bMAU\b/g,
    /assets under management/gi, /\bAUM\b/g,
    /remaining performance obligation/gi, /backlog/gi, /bookings/gi
];

async function latestTenK(symbol) { return segments.latestTenK(symbol); }

const EXTRACT_SYSTEM = [
    'You extract operating/unit-economics metrics from SEC 10-K text — the physical or usage volume behind the revenue (e.g. vehicles delivered, subscribers, same-store sales growth, available seat miles, barrels/day, GMV, AUM).',
    'Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"fiscalYear": "FY2025", "unitLabel": str|null, "metrics": [{"name": str, "value": number|null, "unit": str, "period": str, "basis": str}], "note": str|null}',
    '"unitLabel" is the single natural unit this company sells (e.g. "vehicle", "subscriber", "room-night") or null if the business has none. "value" is the plain number (convert from thousands/millions as stated) — a percentage stays a percentage (e.g. 3.2 for 3.2%), do not scale it. "period" is the fiscal period the number covers (e.g. "FY2025" or "FY2025 vs FY2024"). "basis" is a short source note (e.g. "MD&A production and deliveries table").',
    'STRICT GROUNDING: only use numbers that literally appear in the supplied text. If a figure is not stated, omit that metric — never estimate, infer, or recall from memory.',
    'If the company has no natural per-unit volume (e.g. a bank, insurer, diversified holding company), return {"unitLabel": null, "metrics": []} — do not force a fit.',
    'Prefer the most recent TWO comparable periods when the text states both (so year-over-year change is visible); cap at 8 metrics.'
].join('\n');

function tryParse(msg) {
    try {
        const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
        const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        return Array.isArray(p.metrics) ? p : null;
    } catch (_) { return null; }
}

async function extractRaw(symbol) {
    const tenK = await latestTenK(symbol);
    if (!tenK || !tenK.url || !/\.htm/i.test(tenK.url)) return { error: 'No 10-K found for this company.' };

    const col = mongoose.connection.collection('company_unit_economics');
    try {
        const hit = await col.findOne({ symbol, accession: tenK.accession });
        if (hit) return { ...hit.payload, cached: true };
    } catch (_) { /* cache is best-effort */ }

    const r = await axios.get(tenK.url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 40e6 });
    const text = segments.anchorWindows(segments.htmlToText(r.data), ANCHORS, { maxChars: MAX_EXTRACT_CHARS });
    if (text.length < 500) return { error: 'Could not read the 10-K text.' };

    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `Company: ${symbol}. 10-K filed ${tenK.date}. Extract its operating/unit metrics.${extra}\n\n${text}` }
    ], { purpose: 'summary', temperature: 0, maxTokens: 3000 });

    let parsed = tryParse(await callModel(''));
    if (!parsed) {
        parsed = tryParse(await callModel(' REPLY WITH ONLY THE JSON OBJECT — your entire reply must parse as JSON. If there is no natural unit, return {"unitLabel": null, "metrics": []}.'));
    }
    if (!parsed) return { error: 'Extraction failed — try again later.' };

    const payload = {
        symbol,
        fiscalYear: typeof parsed.fiscalYear === 'string' ? parsed.fiscalYear.slice(0, 12) : null,
        unitLabel: typeof parsed.unitLabel === 'string' ? parsed.unitLabel.slice(0, 40) : null,
        metrics: (Array.isArray(parsed.metrics) ? parsed.metrics : []).slice(0, 8).map((m) => ({
            name: String(m.name || '').slice(0, 60),
            value: Number.isFinite(m.value) ? m.value : null,
            unit: String(m.unit || '').slice(0, 20),
            period: String(m.period || '').slice(0, 40),
            basis: String(m.basis || '').slice(0, 120)
        })).filter((m) => m.name && m.value !== null),
        note: typeof parsed.note === 'string' ? parsed.note.slice(0, 240) : null,
        filing: { form: '10-K', date: tenK.date, url: tenK.url },
        extractedAt: new Date().toISOString()
    };
    try {
        await col.updateOne(
            { symbol, accession: tenK.accession },
            { $set: { payload, at: new Date() } },
            { upsert: true }
        );
    } catch (_) { /* cache is best-effort */ }
    return payload;
}

// Latest + prior annual income-statement rows straight from the fundamentals
// cache — the anchor for deterministic per-unit revenue/cost/profit, same
// pattern as segments.js's filedRevenue().
function annualIncome(symbol) {
    try {
        const f = path.join(FUND_DIR, `${String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '_')}.json`);
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        const rows = ((d.income || {}).annualReports || []).slice(0, 2); // newest-first
        return rows.map((r) => ({
            fiscalDateEnding: r.fiscalDateEnding,
            totalRevenue: Number(r.totalRevenue),
            costOfRevenue: Number(r.costOfRevenue),
            grossProfit: Number(r.grossProfit)
        })).filter((r) => Number.isFinite(r.totalRevenue) && r.totalRevenue > 0);
    } catch (_) { return []; }
}

// A plausible per-unit revenue band ($1 to $10M) — outside this, the unit
// figure and the revenue figure almost certainly don't refer to the same
// thing (wrong period, wrong scale, wrong segment) and we say so rather than
// print a nonsense number. Deterministic, no AI judgement — the analogue of
// segments.js's repairUnits().
function plausiblePerUnit(revenuePerUnit) {
    // Lower bound is a cent, not a dollar: per-mile and per-kWh units are
    // legitimately fractional (Delta earns ~$0.21 per available seat mile).
    return Number.isFinite(revenuePerUnit) && revenuePerUnit >= 0.01 && revenuePerUnit <= 10e6;
}

// Counts that appear in nearly every filing but are not the thing the company
// sells. Picked as a denominator they yield a confident, entirely fabricated
// figure — NFLX FY2025 chose "Full-time employees" and produced $2.8m of
// revenue per "subscriber".
const NOT_A_SALEABLE_UNIT = /employee|headcount|staff|personnel|workforce|countr(?:y|ies)|jurisdiction|shareholder|stockholder|director|patent|trademark|lawsuit/i;

// A metric denominated in money is an amount, not a count of units sold.
// BlackRock's "Total AUM" (millions USD) yielded "$1,725 per AUM", which is
// revenue per million dollars of assets — not unit economics.
const MONETARY_UNIT = /\busd\b|\bdollars?\b|\$|\beur\b|\bgbp\b/i;

// Counts of things that were not sold in the period — capacity, unsold stock,
// future promises, reversals. Pfizer's "EUA-labeled treatment courses
// returned" is a refund count, not volume sold.
const NOT_SOLD_IN_PERIOD = /returned|recalled|backlog|inventory|capacity|on order|\borders?\b|available for sale|authorized|outstanding/i;

// totalRevenue is worldwide, so a volume restricted to one region understates
// the denominator and inflates the per-unit figure. Ford's "U.S. Sales - Total
// Vehicles" (~2.1m) against worldwide revenue read $78,941 per vehicle against
// a true figure nearer $42k.
const REGIONAL_SCOPE = /\bu\.?s\.?\b|united states|north america|\beurope\b|\bemea\b|asia|latin america|domestic|international/i;

// Filings state volumes in their own scale while totalRevenue from the
// fundamentals cache is absolute. Ignoring this read Carnival as $1.95m of
// revenue per cruise passenger and Delta as $253,885 per seat-mile.
const UNIT_SCALES = [[/\bbillions?\b/i, 1e9], [/\bmillions?\b/i, 1e6], [/\bthousands?\b/i, 1e3]];
function unitScale(unit) {
    const hit = UNIT_SCALES.find(([re]) => re.test(String(unit || '')));
    return hit ? hit[1] : 1;
}

// The metric must actually name the unit the company sells. Marriott discloses
// both "Total Properties" and "Total Rooms"; D.R. Horton both "Net Sales
// Orders" and "Homes Closed". Taking whichever came first in the array picked
// the wrong one in both cases. Fails closed: no naming match, no derived
// figure.
function pickVolumeMetric(metrics, unitLabel, latestYear) {
    const usable = metrics.filter((m) => Number.isFinite(m.value) && m.value > 0
        && !NOT_A_SALEABLE_UNIT.test(`${m.name || ''} ${m.unit || ''}`)
        && !MONETARY_UNIT.test(m.unit || '')
        && !NOT_SOLD_IN_PERIOD.test(m.name || '')
        && !REGIONAL_SCOPE.test(m.name || '')
        && !/%|percent|ratio/i.test(m.unit || ''));
    if (!usable.length) return null;

    const tokens = String(unitLabel || '').toLowerCase().replace(/s$/, '')
        .split(/[^a-z0-9]+/).filter(Boolean)
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!tokens.length) return null;
    // Separator-insensitive so a "seat-mile" label matches "Available Seat Miles".
    const labelRe = new RegExp(`\\b${tokens.join('[\\s\\-]*')}s?\\b`, 'i');
    const onLabel = usable.filter((m) => labelRe.test(m.name || ''));
    if (!onLabel.length) return null;

    // Divide the revenue year by the volume for that same year.
    return onLabel.find((m) => latestYear && String(m.period || '').includes(String(latestYear))) || onLabel[0];
}

// The public entry point: raw extraction + deterministic per-unit derivation.
// Never lets the model compute economics — only reads a stated figure.
async function extract(symbol) {
    const raw = await extractRaw(symbol);
    if (raw.error) return raw;

    const income = annualIncome(symbol);
    const latest = income[0], prior = income[1];
    const latestYear = latest ? String(latest.fiscalDateEnding || '').slice(0, 4) : null;
    const volume = raw.metrics.length ? pickVolumeMetric(raw.metrics, raw.unitLabel, latestYear) : null;
    // Restate the disclosed figure in absolute units before dividing.
    const volumeValue = volume ? volume.value * unitScale(volume.unit) : null;

    let derived = null;
    if (volume && latest && volumeValue > 0) {
        const revenuePerUnit = latest.totalRevenue / volumeValue;
        if (plausiblePerUnit(revenuePerUnit)) {
            // A zero here means the filing reported no separate cost line, not
            // that the company earns nothing per unit — service businesses
            // (airlines, hotels, telecoms) commonly omit COGS. Treat it as
            // missing so the UI shows nothing rather than "$0.00 profit".
            const costPerUnit = latest.costOfRevenue > 0 ? latest.costOfRevenue / volumeValue : null;
            const grossProfitPerUnit = latest.grossProfit > 0 ? latest.grossProfit / volumeValue : (costPerUnit !== null ? revenuePerUnit - costPerUnit : null);
            derived = {
                unitLabel: raw.unitLabel || volume.name,
                volumeMetric: volume.name,
                volume: volumeValue,
                period: volume.period || latest.fiscalDateEnding,
                revenuePerUnit,
                costPerUnit,
                grossProfitPerUnit
            };
        } else {
            derived = { note: 'Reported volume and filed revenue do not reconcile to a plausible per-unit figure — shown as disclosed, not derived.' };
        }
    }

    return { ...raw, derived };
}

// ---- Monitor support: a YoY delta row from within one 10-K's own MD&A ----
// Tesla-style MD&A states both periods in the same sentence ("X delivered,
// up from Y a year ago"), so the extractor is prompted to return two entries
// with the same metric name at two different periods when the text has them.
// This pairs those up into the SAME shape filing-monitor.js's computeDeltas()
// produces internally, so it can be unshifted straight into deltasObj.deltas
// and flow through scoreMateriality/summaryFacts/the payload map unchanged.
function yearsIn(period) {
    const m = String(period || '').match(/20\d{2}/g);
    return m ? m.map(Number) : [];
}
function findVolumePair(metrics) {
    const byName = new Map();
    for (const m of metrics) {
        const key = String(m.name || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(m);
    }
    for (const list of byName.values()) {
        if (list.length < 2) continue;
        const withYear = list
            .map((m) => ({ ...m, year: Math.max(0, ...yearsIn(m.period)) }))
            .filter((m) => m.year > 0);
        if (withYear.length < 2) continue;
        withYear.sort((a, b) => b.year - a.year);
        if (withYear[0].year === withYear[1].year) continue; // not actually two periods
        return { latest: withYear[0], prior: withYear[1] };
    }
    return null;
}
function computeUnitDelta(ue) {
    if (!ue || !Array.isArray(ue.metrics) || ue.metrics.length < 2) return null;
    const pair = findVolumePair(ue.metrics);
    if (!pair) return null;
    const { latest, prior } = pair;
    if (!Number.isFinite(latest.value) || !Number.isFinite(prior.value) || prior.value === 0) return null;
    const delta = Math.round(((latest.value - prior.value) / Math.abs(prior.value)) * 1000) / 10;
    const unitSuffix = latest.unit && !/^(count|units?|#)$/i.test(latest.unit.trim()) ? ` ${latest.unit}` : '';
    const fmt = (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unitSuffix}`;
    return {
        label: String(latest.name || 'Unit volume').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40),
        kind: 'unit',
        latest: latest.value, prior: prior.value, delta,
        fmtLatest: fmt(latest.value), fmtPrior: fmt(prior.value)
    };
}

module.exports = { extract, extractRaw, computeUnitDelta };
