// Deterministic weekly portfolio briefing.
//
// Passive dashboard loads must never consume AI usage. Every sentence is built
// from deterministic portfolio facts; explicit Ask/Insights/Dossier actions
// remain the places where a customer intentionally invokes a model.
//
// Privacy: the briefing is computed in-process; no portfolio data is sent to a
// model or external AI provider.
//
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function pct1(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }
function gbp0(v) { return `$${Math.round(v).toLocaleString()}`; }

// ---- 1. Deterministic facts ----
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
                assetType: String(h.assetType || 'stock'),
                category: h.category || '',
                sector: h.sector || h.category || 'Unknown',
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

    const typeMap = {};
    rows.forEach((r) => { typeMap[r.assetType] = (typeMap[r.assetType] || 0) + r.value; });
    const assetMix = Object.entries(typeMap)
        .map(([assetType, value]) => ({ assetType, count: rows.filter((r) => r.assetType === assetType).length, weightPct: Number(((value / totalValue) * 100).toFixed(1)) }))
        .sort((a, b) => b.weightPct - a.weightPct);

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
            symbol: r.symbol, name: r.name, assetType: r.assetType, category: r.category || null,
            weightPct: Number(r.weight.toFixed(1)), plPct: Number(r.plPct.toFixed(1))
        })),
        assetMix,
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
    const hasFunds = (f.assetMix || []).some((x) => x.assetType === 'etf' || x.assetType === 'mutual_fund');
    lines.push(`By ${hasFunds ? 'sector or fund category' : 'sector'} you are most exposed to ${f.topSector.sector} at ${f.topSector.weightPct}%${f.sectorConcentrationFlag ? ', a meaningful concentration' : ''}.`);
    return lines.join(' ');
}

// Returns { briefing, facts, source } and never performs network/model work.
async function generateBriefing(holdings) {
    const facts = computePortfolioFacts(holdings);
    return { briefing: buildTemplateBriefing(facts), facts, source: facts.empty ? 'empty' : 'template' };
}

module.exports = { computePortfolioFacts, buildTemplateBriefing, generateBriefing, AI_CONFIGURED: false };
