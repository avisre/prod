// Portfolio X-Ray — look-through fundamentals of the user's whole portfolio.
// Treats the portfolio as one business: weighted margins, growth, ROE and
// valuation, plus a health roll-up and concentration read. All deterministic,
// computed from the SEC-backed fundamentals cache. No competitor offers this.

const aiChat = require('./ai-chat');

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function computeXray(holdings) {
    const positions = [];
    let totalValue = 0;
    for (const h of holdings || []) {
        const symbol = String(h.symbol || '').toUpperCase();
        const shares = num(h.shares) || 0;
        const price = num(h.currentPrice) !== null ? num(h.currentPrice) : num(h.purchasePrice);
        if (!symbol || shares <= 0 || price === null) continue;
        const value = shares * price;
        totalValue += value;
        positions.push({
            symbol, shares, price, value,
            name: h.name || symbol,
            assetType: String(h.assetType || 'stock'),
            category: h.category || h.sector || ''
        });
    }
    if (!positions.length || totalValue <= 0) return { empty: true };

    let coveredWeight = 0;
    const agg = { earningsYield: 0, eyWeight: 0 }; // for harmonic portfolio P/E
    const weightedSums = {}; const weightedW = {};
    const wAdd = (key, val, w) => {
        if (val === null) return;
        weightedSums[key] = (weightedSums[key] || 0) + val * w;
        weightedW[key] = (weightedW[key] || 0) + w;
    };
    const sectorWeights = {};
    let healthPassWeighted = 0; let healthWeight = 0;

    for (const p of positions) {
        p.weightPct = Number(((p.value / totalValue) * 100).toFixed(1));
        const w = p.value / totalValue;
        if (p.assetType === 'etf' || p.assetType === 'mutual_fund') {
            const bucket = p.category || (p.assetType === 'etf' ? 'ETF' : 'Mutual fund');
            sectorWeights[bucket] = (sectorWeights[bucket] || 0) + w;
            p.covered = false;
            p.coverageNote = 'Fund position — included in value and concentration, excluded from company-fundamental averages.';
            continue;
        }
        const m = aiChat.metricsFor(p.symbol);
        const sector = (m && m.sector) || 'Other / not covered';
        sectorWeights[sector] = (sectorWeights[sector] || 0) + w;
        if (!m) { p.covered = false; continue; }
        p.covered = true;
        coveredWeight += w;
        p.pe = m.pe; p.netMarginPct = m.netMarginPct; p.roePct = m.roePct;
        p.revCagr5Pct = m.revCagr5Pct; p.divYieldPct = m.divYieldPct;
        p.qtrEarningsYoYPct = m.qtrNetIncomeYoYPct;
        wAdd('netMarginPct', m.netMarginPct, w);
        wAdd('roePct', m.roePct, w);
        wAdd('revCagr5Pct', m.revCagr5Pct, w);
        wAdd('divYieldPct', m.divYieldPct !== null ? m.divYieldPct : 0, w);
        if (m.pe !== null && m.pe > 0) { agg.earningsYield += (1 / m.pe) * w; agg.eyWeight += w; }

        // Health roll-up: weight-average pass rate, plus per-holding score
        const hc = aiChat.runTool('get_health_checks', { symbol: p.symbol });
        if (hc && Array.isArray(hc.checks) && hc.checks.length) {
            const passed = hc.checks.filter((c) => c.pass).length;
            p.healthScore = `${passed}/${hc.checks.length}`;
            p.healthPassRate = passed / hc.checks.length;
            p.healthFails = hc.checks.filter((c) => !c.pass).map((c) => c.label);
            healthPassWeighted += (passed / hc.checks.length) * w;
            healthWeight += w;
        }
    }

    positions.sort((a, b) => b.value - a.value);
    const wavg = (key, dp = 1) => (weightedW[key] ? Number((weightedSums[key] / weightedW[key]).toFixed(dp)) : null);
    const sectors = Object.entries(sectorWeights)
        .map(([sector, w]) => ({ sector, weightPct: Number((w * 100).toFixed(1)) }))
        .sort((a, b) => b.weightPct - a.weightPct);

    return {
        totalValue: Number(totalValue.toFixed(2)),
        holdings: positions.length,
        coveragePct: Number((coveredWeight * 100).toFixed(0)),
        lookThrough: {
            peRatio: agg.earningsYield > 0 ? Number(((agg.eyWeight || 1) / agg.earningsYield).toFixed(1)) : null,
            netMarginPct: wavg('netMarginPct'),
            roePct: wavg('roePct'),
            revCagr5Pct: wavg('revCagr5Pct'),
            divYieldPct: wavg('divYieldPct', 2),
            healthPassPct: healthWeight ? Number(((healthPassWeighted / healthWeight) * 100).toFixed(0)) : null
        },
        concentration: {
            topHoldingPct: positions[0] ? positions[0].weightPct : null,
            topHolding: positions[0] ? positions[0].symbol : null,
            top3Pct: Number(positions.slice(0, 3).reduce((s, p) => s + (p.weightPct || 0), 0).toFixed(1)),
            topSector: sectors[0] || null
        },
        sectors,
        positions: positions.map((p) => ({
            symbol: p.symbol, name: p.name, assetType: p.assetType, category: p.category || null,
            weightPct: p.weightPct, value: Number(p.value.toFixed(2)),
            covered: p.covered !== false,
            coverageNote: p.coverageNote || null,
            pe: p.pe ?? null, netMarginPct: p.netMarginPct ?? null, roePct: p.roePct ?? null,
            revCagr5Pct: p.revCagr5Pct ?? null, qtrEarningsYoYPct: p.qtrEarningsYoYPct ?? null,
            healthScore: p.healthScore || null, healthFails: (p.healthFails || []).slice(0, 4)
        }))
    };
}

module.exports = { computeXray };
