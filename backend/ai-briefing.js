// AI weekly portfolio briefing.
//
// Design rule: the LLM never does arithmetic. We compute every number
// deterministically in computePortfolioFacts() and hand the model only the
// finished facts; it just turns them into calm, plain-English prose. That
// makes the briefing impossible to get numerically wrong regardless of model
// size, and keeps us provider-agnostic (any OpenAI-compatible endpoint:
// OpenRouter, Moonshot/Kimi, Ollama Cloud, etc.).
//
// Privacy: only aggregates + public tickers are sent to the model — never the
// user's name, email, or account identifiers.
//
// Config (env, all optional — without a key we serve a deterministic template):
//   AI_BRIEFING_API_KEY    provider key
//   AI_BRIEFING_BASE_URL   default https://openrouter.ai/api/v1
//   AI_BRIEFING_MODEL      default moonshotai/kimi-k2.6

const aiClient = require('./ai-client');

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function pct1(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }
function gbp0(v) { return `$${Math.round(v).toLocaleString()}`; }

// ---- 1. Deterministic facts (the LLM never recomputes these) ----
function computePortfolioFacts(holdings) {
    const rows = (Array.isArray(holdings) ? holdings : [])
        .map((h) => {
            const shares = n(h.shares);
            const buy = n(h.purchasePrice);
            const cur = n(h.currentPrice) || buy;
            const value = shares * cur;
            const cost = shares * buy;
            return {
                symbol: String(h.symbol || '').toUpperCase(),
                name: h.name || h.symbol,
                sector: h.sector || 'Unknown',
                value, cost,
                pl: value - cost,
                plPct: cost > 0 ? ((value - cost) / cost) * 100 : 0
            };
        })
        .filter((r) => r.symbol && r.value > 0);

    if (!rows.length) return { empty: true };

    const totalValue = rows.reduce((s, r) => s + r.value, 0);
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    const totalPL = totalValue - totalCost;
    const totalPLPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

    rows.forEach((r) => { r.weight = totalValue > 0 ? (r.value / totalValue) * 100 : 0; });
    const byWeight = rows.slice().sort((a, b) => b.weight - a.weight);
    const byPerf = rows.slice().sort((a, b) => b.plPct - a.plPct);

    // sector allocation
    const sectorMap = {};
    rows.forEach((r) => { sectorMap[r.sector] = (sectorMap[r.sector] || 0) + r.value; });
    const sectors = Object.entries(sectorMap)
        .map(([sector, value]) => ({ sector, weight: (value / totalValue) * 100 }))
        .sort((a, b) => b.weight - a.weight);

    const largest = byWeight[0];
    const topSector = sectors[0];

    return {
        empty: false,
        holdingsCount: rows.length,
        totalValue: Math.round(totalValue),
        totalCost: Math.round(totalCost),
        totalPL: Math.round(totalPL),
        totalPLPct: Number(totalPLPct.toFixed(1)),
        positions: byWeight.map((r) => ({
            symbol: r.symbol, weightPct: Number(r.weight.toFixed(1)), plPct: Number(r.plPct.toFixed(1))
        })),
        largestPosition: { symbol: largest.symbol, weightPct: Number(largest.weight.toFixed(1)) },
        concentrationFlag: largest.weight >= 25,
        bestPerformer: { symbol: byPerf[0].symbol, plPct: Number(byPerf[0].plPct.toFixed(1)) },
        worstPerformer: { symbol: byPerf[byPerf.length - 1].symbol, plPct: Number(byPerf[byPerf.length - 1].plPct.toFixed(1)) },
        sectors: sectors.map((s) => ({ sector: s.sector, weightPct: Number(s.weight.toFixed(1)) })),
        topSector: { sector: topSector.sector, weightPct: Number(topSector.weight.toFixed(1)) },
        sectorConcentrationFlag: topSector.weight >= 40
    };
}

// ---- 2. Deterministic template (used as fallback + as the model's source) ----
function buildTemplateBriefing(f) {
    if (f.empty) return 'Your portfolio is empty. Add a few holdings to get your first weekly briefing.';
    const lines = [];
    lines.push(`Your portfolio is worth ${gbp0(f.totalValue)} across ${f.holdingsCount} holding${f.holdingsCount === 1 ? '' : 's'}, ${f.totalPL >= 0 ? 'up' : 'down'} ${gbp0(Math.abs(f.totalPL))} (${pct1(f.totalPLPct)}) versus what you paid.`);
    lines.push(`Your largest position is ${f.largestPosition.symbol} at ${f.largestPosition.weightPct}% of the portfolio${f.concentrationFlag ? ' — that is a sizeable single-name concentration worth being aware of' : ''}.`);
    lines.push(`Your strongest holding is ${f.bestPerformer.symbol} (${pct1(f.bestPerformer.plPct)}) and your weakest is ${f.worstPerformer.symbol} (${pct1(f.worstPerformer.plPct)}).`);
    lines.push(`By sector you are most exposed to ${f.topSector.sector} at ${f.topSector.weightPct}%${f.sectorConcentrationFlag ? ', a meaningful sector tilt' : ''}.`);
    return lines.join(' ');
}

// ---- 3. LLM prose (provider-agnostic, OpenAI-compatible) ----
const SYSTEM_PROMPT = [
    'You are a calm, factual portfolio assistant for a long-term investor.',
    'Write a short weekly briefing (3-5 sentences or compact bullet points) in plain English.',
    'Use ONLY the numbers in the provided facts JSON. Never invent or recompute any number.',
    'Be descriptive and educational, never prescriptive: do NOT tell the user to buy, sell, hold, or rebalance, and do not predict prices.',
    'It is fine to neutrally point out concentration or sector tilts as observations.',
    'No greetings, no sign-off, no disclaimers (the app adds its own). British English. Keep it tight.'
].join(' ');

async function callModel(facts) {
    return aiClient.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Portfolio facts (JSON):\n${JSON.stringify(facts)}\n\nWrite the weekly briefing.` }
    ], { temperature: 0.4, maxTokens: 320 });
}

// Returns { briefing, facts, source } — never throws; falls back to template.
async function generateBriefing(holdings) {
    const facts = computePortfolioFacts(holdings);
    if (facts.empty) {
        return { briefing: buildTemplateBriefing(facts), facts, source: 'empty' };
    }
    if (!aiClient.AI_CONFIGURED) {
        return { briefing: buildTemplateBriefing(facts), facts, source: 'template' };
    }
    try {
        const briefing = await callModel(facts);
        return { briefing, facts, source: 'ai' };
    } catch (err) {
        console.warn(`[ai-briefing] model call failed, using template: ${err.message}`);
        return { briefing: buildTemplateBriefing(facts), facts, source: 'template-fallback' };
    }
}

module.exports = { computePortfolioFacts, buildTemplateBriefing, generateBriefing, AI_CONFIGURED: aiClient.AI_CONFIGURED };
