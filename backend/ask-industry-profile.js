'use strict';
const sectorVocab = require('./sector');
const industryMetrics = require('../frontend-v2/assets/industry-metrics');

// Personalises the answer's metric rows to the company's industry. This module
// decides WHICH metrics to lead with, never what they are worth — the values come
// from get_ratios_history, where each carries its own formula, inputs and
// sourceIds. Nothing outside RATIOS + LINES is ever named: FFO, net interest
// margin, ARR, combined ratio, same-store sales and EBITDA have no XBRL concept
// behind them here, so promising them would guarantee an unsourceable figure.
const RATIOS = [
    'grossMarginPct', 'opMarginPct', 'netMarginPct', 'fcfMarginPct', 'roePct', 'roaPct',
    'currentRatio', 'debtToEquity', 'ocfToNetIncome', 'capexPctRevenue', 'sharesOutM'
];
const LINES = [
    'totalRevenue', 'netIncome', 'operatingCashflow', 'capitalExpenditures',
    'depreciationDepletionAndAmortization', 'shareBasedCompensation',
    'researchAndDevelopment', 'dividendPayout', 'paymentsForRepurchaseOfCommonStock'
];

// Industries whose metric set is the same but whose omissions need different
// explanations (a bank has no gross margin; an insurer has no capex line).
const FINANCIAL_RATIOS = ['netMarginPct', 'roaPct', 'roePct', 'ocfToNetIncome'];

const PROFILES = {
    bank: {
        metrics: FINANCIAL_RATIOS,
        lines: ['totalRevenue', 'netIncome'],
        note: 'Banks are not compared on gross margin, capex intensity or working-capital ratios — they do not report those lines, so a blank means "not applicable", not "zero".'
    },
    insurer: {
        metrics: FINANCIAL_RATIOS,
        lines: ['totalRevenue', 'netIncome'],
        note: 'Insurers are judged on underwriting and investment returns, not on gross margin or capex — those lines are not reported and any blank is "not applicable".'
    },
    'capital-markets': {
        metrics: FINANCIAL_RATIOS,
        lines: ['totalRevenue', 'netIncome'],
        note: 'Asset managers and capital-markets firms are measured on margins and returns on assets and equity; gross margin and capex are not reported lines.'
    },
    reit: {
        metrics: ['netMarginPct', 'roaPct', 'ocfToNetIncome', 'debtToEquity'],
        lines: ['totalRevenue', 'netIncome', 'depreciationDepletionAndAmortization'],
        note: 'Property companies carry heavy depreciation, so net margin understates cash generation — read it with the depreciation line and leverage. Use FFO/AFFO only when typed issuer disclosures supply the reported definition and reconciliation; never infer them from generic net income.'
    },
    software: {
        metrics: ['grossMarginPct', 'opMarginPct', 'fcfMarginPct', 'capexPctRevenue'],
        lines: ['totalRevenue', 'netIncome', 'operatingCashflow', 'shareBasedCompensation'],
        note: 'Software economics show up in gross margin and cash conversion; share-based compensation is a real cost to read alongside them.'
    },
    'semis-hardware': {
        metrics: ['grossMarginPct', 'opMarginPct', 'fcfMarginPct', 'capexPctRevenue'],
        lines: ['totalRevenue', 'netIncome', 'researchAndDevelopment', 'operatingCashflow'],
        note: 'Semiconductor and hardware economics turn on gross margin and capital intensity — a cyclical fab or inventory cycle shows up in both.'
    },
    'pharma-biotech': {
        metrics: ['grossMarginPct', 'opMarginPct', 'fcfMarginPct', 'roaPct'],
        lines: ['totalRevenue', 'netIncome', 'researchAndDevelopment', 'operatingCashflow'],
        note: 'Research spending is the defining cost line; a pre-revenue developer will show null margins, and that must be stated as no revenue reported rather than as a loss ratio.'
    },
    energy: {
        metrics: ['capexPctRevenue', 'fcfMarginPct', 'debtToEquity'],
        lines: ['totalRevenue', 'operatingCashflow', 'capitalExpenditures'],
        note: 'Commodity producers are read on cash margin and the capital needed to sustain production, with leverage against a cyclical revenue base.'
    },
    utility: {
        metrics: ['capexPctRevenue', 'debtToEquity', 'fcfMarginPct'],
        lines: ['totalRevenue', 'operatingCashflow', 'capitalExpenditures'],
        note: 'Regulated utilities are capital-intensive and rate-base driven: capex intensity and leverage matter more than gross margin.'
    },
    consumer: {
        metrics: ['grossMarginPct', 'opMarginPct', 'currentRatio', 'ocfToNetIncome'],
        lines: ['totalRevenue', 'netIncome', 'operatingCashflow'],
        note: 'Consumer businesses are read on gross margin and how reliably profit converts to cash, with inventory and payables visible in the current ratio.',
    },
    industrial: {
        metrics: ['opMarginPct', 'netMarginPct', 'debtToEquity', 'ocfToNetIncome'],
        lines: ['totalRevenue', 'netIncome', 'depreciationDepletionAndAmortization'],
        note: 'Industrials and transport are capital- and labour-heavy: operating margin, leverage and cash conversion carry the story.'
    },
    shell: {
        metrics: [],
        lines: [],
        note: 'This listing reports no operating business, so there are no margins, returns or trends to compare. Say so plainly instead of showing empty metric rows.'
    },
    mining: {
        metrics: ['opMarginPct', 'fcfMarginPct', 'capexPctRevenue', 'debtToEquity'],
        lines: ['totalRevenue', 'operatingCashflow', 'capitalExpenditures'],
        note: 'Miners and metals producers sell a commodity at a price they do not set: read the operating margin against the capital needed to keep the mines running, and leverage against a cyclical revenue base.'
    },
    'telecom-media': {
        metrics: ['opMarginPct', 'fcfMarginPct', 'capexPctRevenue', 'debtToEquity'],
        lines: ['totalRevenue', 'operatingCashflow', 'capitalExpenditures'],
        note: 'Telecom, cable and media companies carry heavy networks or content budgets financed with debt: cash left after capital spending and leverage matter more than gross margin.'
    },
    services: {
        metrics: ['opMarginPct', 'netMarginPct', 'fcfMarginPct', 'ocfToNetIncome'],
        lines: ['totalRevenue', 'netIncome', 'operatingCashflow'],
        note: 'Service businesses own few hard assets: the story is in operating margin and how reliably profit turns into cash.'
    },
    generic: {
        metrics: ['grossMarginPct', 'opMarginPct', 'netMarginPct', 'fcfMarginPct'],
        lines: ['totalRevenue', 'netIncome'],
        note: 'No industry-specific metric set applies; these four are the broadest measures the engine can source for this company.'
    }
};

// Ordered: the first match wins, so the more specific industries are tested first.
const RULES = [
    [/^shell companies$/i, 'shell'],
    [/\bbanks?\b|savings|thrift|mortgage finance/i, 'bank'],
    [/insurance (?:agents|brokers)|insurance broker/i, 'capital-markets'],
    [/\binsurance\b|reinsurance/i, 'insurer'],
    [/\breit\b|real estate (?:services|development|diversified)/i, 'reit'],
    [/asset management|capital markets|credit services|financial (?:data|exchanges|conglomerates)/i, 'capital-markets'],
    [/\bsoftware\b|internet content|information technology services/i, 'software'],
    [/semiconductor|consumer electronics|computer hardware|communication equipment|electronic (?:components|distribution)|scientific & technical instruments|data storage/i, 'semis-hardware'],
    [/\bbiotechnology\b|drug manufacturers|medical (?:devices|instruments|care|distribution|specialities|facilities)|pharmaceutical|diagnostics|health information/i, 'pharma-biotech'],
    [/\butilities\b|utility|water|independent power|regulated (?:electric|gas|water)/i, 'utility'],
    [/oil & gas|coal|uranium|solar|thermal/i, 'energy'],
    [/retail|stores|restaurants|grocery|food|beverage|household|personal products|apparel|footwear|tobacco|luxury|packaging|confectioners|farm products|education & training|leisure|resorts|gambling|travel/i, 'consumer'],
    [/aerospace|defense|railroads|trucking|airlines|airports|marine shipping|integrated freight|logistics|industrial distribution|farm & heavy construction|metal fabrication|tools & accessories|specialty industrial|building products|engineering & construction|infrastructure|waste management|pollution|electrical equipment|specialty business/i, 'industrial']
];

// Used only when the company has no Industry label: the coarse sector still
// narrows the metric set usefully.
const SECTOR_TO_ARCHETYPE = {
    'Financials': 'capital-markets',
    'Real Estate': 'reit',
    'Energy': 'energy',
    'Utilities': 'utility',
    'Information Technology': 'software',
    'Health Care': 'pharma-biotech',
    'Consumer Staples': 'consumer',
    'Consumer Discretionary': 'consumer',
    'Materials': 'industrial',
    'Industrials': 'industrial',
    'Communication Services': 'software'
};

// Half the covered universe (2,248 of 4,649 on 2026-10-06 — foreign filers and
// most small caps) arrives with no industry label and no sector, and was being
// answered with the catch-all metric set. Every SEC registrant has a SIC code,
// so the code decides whenever the labels cannot. Ordered: first match wins.
const SIC_RULES = [
    [/^6770$/, 'shell'],
    [/^6411$/, 'capital-markets'],
    [/^6798$|^65/, 'reit'],
    [/^6795$/, 'mining'],
    [/^6794$/, 'services'],
    [/^6[127]/, 'capital-markets'],
    [/^283|^384|^3826$|^5122$|^80|^8731$|^8734$/, 'pharma-biotech'],
    [/^737/, 'software'],
    [/^357|^36[67]|^3651$|^3861$|^38[1-3]|^3695$/, 'semis-hardware'],
    [/^13|^29|^46|^5171$|^5172$|^12/, 'energy'],
    [/^49(?!5)/, 'utility'],
    [/^1[04]/, 'mining'],
    [/^48|^27|^78|^731/, 'telecom-media'],
    [/^0[1-9]|^2[0-35]|^31|^39|^5[2-9]|^514|^518|^70|^72|^79|^82|^284/, 'consumer'],
    [/^7[3-6]|^8[1-9]/, 'services'],
    [/^1[5-7]|^2[4-9]|^3[0-9]|^4[0-7]|^495|^5[01]/, 'industrial']
];
function sicArchetype(sic) {
    const code = String(sic || '').trim();
    if (!/^\d{3,4}$/.test(code)) return null;
    const financial = industryMetrics.kindFromSic(code);
    if (financial) return financial;
    const padded = code.padStart(4, '0');
    for (const [re, key] of SIC_RULES) if (re.test(padded)) return key;
    return null;
}
// The registrant's SIC code from the stored SEC issuer record; null when unknown.
function sicFor(symbol) {
    try {
        const company = require('./stock-universe').lookup(symbol);
        return require('./public-stock-index').view().issuers[company?.cik]?.evidence?.sic || null;
    } catch (_) { return null; }
}
function archetypeFor(industry, sector, sic) {
    const ind = String(industry || '').trim();
    if (ind) for (const [re, key] of RULES) if (re.test(ind)) return key;
    const bySic = sicArchetype(sic);
    if (bySic) return bySic;
    const sec = sectorVocab.canonical(sector);
    if (sec && SECTOR_TO_ARCHETYPE[sec]) return SECTOR_TO_ARCHETYPE[sec];
    return 'generic';
}

// `industryProfile` is handed to the model as a tool result, so it must be
// self-explaining: which archetype was chosen, from which label, and what the
// omitted metrics mean.
function profile(industry, sector, sic) {
    const archetype = archetypeFor(industry, sector, sic);
    const p = PROFILES[archetype];
    return {
        archetype,
        basis: String(industry || '').trim() || sectorVocab.canonical(sector) || null,
        sector: sectorVocab.canonical(sector) || null,
        metrics: p.metrics.slice(),
        lines: p.lines.slice(),
        note: p.note,
        vocabulary: { ratios: RATIOS, lines: LINES }
    };
}

// Keeps the archetype's metrics that actually have a value in the newest period,
// so an answer never offers a row the engine cannot fill. `history` is the
// get_ratios_history payload (observations newest first).
function select(profileOrIndustry, history) {
    const p = profileOrIndustry && profileOrIndustry.metrics ? profileOrIndustry
        : profile(profileOrIndustry, null);
    const latest = ((history || {}).observations || [])[0] || null;
    if (!p.metrics.length) return { archetype: p.archetype, periodEnd: null, metrics: [], missing: [] };
    const available = (name) => !!(latest && latest.metrics && latest.metrics[name] && Number.isFinite(latest.metrics[name].value));
    const metrics = p.metrics.filter(available);
    return {
        archetype: p.archetype,
        periodEnd: latest ? latest.periodEnd || null : null,
        currency: latest ? latest.currency || null : null,
        metrics,
        // Named so the answer can say why a metric is absent instead of implying zero.
        missing: p.metrics.filter((m) => !available(m))
    };
}

module.exports = { profile, select, archetypeFor, sicArchetype, sicFor, RATIOS, LINES, PROFILES, SECTOR_TO_ARCHETYPE };
