'use strict';

// The stored Yahoo Finance snapshot, used ONLY to fill gaps in the verified SEC
// data — never to replace it, and never unlabelled.
//
// Why this exists: a metric being absent from the issuer's XBRL facts is not the
// same as the metric being unavailable. EBITDA and EBIT have no XBRL concept at
// all, so they are null for every company in the store, and eight balance/cash
// lines (propertyPlantEquipment, shortTermInvestments, currentLongTermDebt,
// deferredRevenue, the change-in-* lines) were measured non-null zero times
// across all 175,147 shipped annual rows. The stored fundamentals file already
// carries the provider's own figure for each of them, and the verified
// projection's overview whitelist was discarding its valuation fields as well.
//
// The product's claim is that figures trace to a filed fact, so a provider value
// must always arrive attributed and dated, kept out of the verified table and out
// of every chart. Substituting one silently would be a false claim about a filed
// number — the exact error the verify pages exist to catch.

const cache = require('./fundamentals-cache');

const PROVIDER = 'Yahoo Finance';

// Yahoo stores numbers as strings, sometimes with thousands separators, and uses
// '' for "not reported" — a gap, which must never be read as zero.
function pnum(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/,/g, '').trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
}

function snapshot(symbol) {
    try {
        const raw = cache.loadRawFundamentals(symbol);
        return raw && raw.overview ? raw : null;
    } catch (_) { return null; }
}

const ATTRIBUTION = 'Provider-reported values, not the issuer’s filed figures. Name Yahoo Finance and this date in the same sentence, keep them out of every verified table and chart, and never describe them as filed, reported by the issuer or SEC-verified.';

// ---- Market and valuation fields the verified projection does not carry ----
// get_quote already declares forwardPE, dividendYield, beta, priceToBook and
// evToEbitda, but reads them from the adapted overview, whose whitelist drops
// them all — so those five fields were silently null on every request while the
// stored file carried them (measured on AMD, 2026-10-04).
function valuation(symbol, { perShareAllowed = false } = {}) {
    const raw = snapshot(symbol);
    if (!raw) return null;
    const ov = raw.overview;
    // P/E, PEG, P/B and EV/EBITDA are all priced off a share count or a market
    // value, so an unverified share class or ADR basis disqualifies them exactly
    // as it disqualifies EPS — the same gate get_quote already applies.
    const price = (v) => perShareAllowed ? pnum(v) : null;
    // The provider writes "0" where it has no value here too, not only in the
    // statement rows: sampled across the store, ProfitMargin is exactly "0" for
    // 91 of 605 companies and OperatingMarginTTM for 75, and they include
    // AllianceBernstein — which filed $299.8m of net income on $332.8m of
    // revenue, a 90% margin, and is recorded at 0% — and Absci, at -4,113%.
    // No company earns exactly zero, so a zero multiple or margin is a
    // placeholder; publishing it would state a measurement the provider never
    // made. Dividend yield is the exception: zero is a real fact there (a
    // non-payer), and the provider writes "" for those anyway.
    const ZERO_IS_PLACEHOLDER = new Set(['forwardPE', 'pegRatio', 'priceToBook', 'evToEbitda', 'beta', 'ebitdaTtm', 'profitMarginTtm', 'operatingMarginTtm', 'returnOnEquityTtm']);
    // EBITDA is deliberately absent: it is the one money field here, and the
    // snapshot carries no statement currency to put beside it — TSM's overview
    // reads EBITDA 3167467077632 with Currency "USD", which is NT$3.17tn, so
    // labelling it from that field would state New Taiwan dollars as US dollars.
    // statementGaps supplies EBITDA per period in the filed row's own verified
    // currency instead, which is both safer and the period the model asked about.
    const fields = {
        forwardPE: price(ov.ForwardPE),
        pegRatio: price(ov.PEGRatio),
        priceToBook: price(ov.PriceToBookRatio),
        evToEbitda: price(ov.EVToEBITDA),
        beta: pnum(ov.Beta),
        dividendYield: pnum(ov.DividendYield),
        profitMarginTtm: pnum(ov.ProfitMargin),
        operatingMarginTtm: pnum(ov.OperatingMarginTTM),
        returnOnEquityTtm: pnum(ov.ReturnOnEquityTTM)
    };
    const present = Object.fromEntries(Object.entries(fields)
        .filter(([k, v]) => v !== null && !(ZERO_IS_PLACEHOLDER.has(k) && v === 0)));
    if (!Object.keys(present).length) return null;
    return {
        source: PROVIDER,
        asOf: raw.fetchedAt || null,
        fields: present,
        units: 'Ratios and margins are decimals or multiples as reported by the provider; every field here is unitless, so none of them carries a currency.',
        note: ATTRIBUTION
    };
}

// ---- Statement lines the issuer's XBRL facts cannot supply ----
// SEC field name -> provider field name. Only mappings whose meaning and sign are
// unambiguous are listed; a value with a different sign convention would be a
// wrong number wearing a right number's label.
const GAP_FIELDS = {
    income: [['ebitda', 'ebitda'], ['ebit', 'ebit']],
    balance: [
        ['propertyPlantEquipment', 'propertyPlantEquipment'],
        ['shortTermInvestments', 'shortTermInvestments'],
        ['currentLongTermDebt', 'currentLongTermDebt'],
        ['deferredRevenue', 'deferredRevenue'],
        ['longTermDebt', 'longTermDebt'],
        ['totalLiabilities', 'totalLiabilities'],
        ['totalShareholderEquity', 'totalShareholderEquity'],
        ['goodwill', 'goodwill'],
        ['inventory', 'inventory']
    ],
    // The provider signs outflows negative; the verified rows carry their own
    // sign convention, so these are supplied as magnitudes and labelled as such.
    cash: [
        ['capitalExpenditures', 'capitalExpenditures', true],
        ['dividendPayout', 'dividendPayout', true],
        ['paymentsForRepurchaseOfCommonStock', 'paymentsForRepurchaseOfCommonStock', true],
        ['changeInCashAndCashEquivalents', 'changeInCashAndCashEquivalents']
    ]
};

// Fiscal-period matching cannot be exact-date: the provider normalises a 52/53-week
// fiscal year to a calendar month-end (AMD's FY2025 is filed 2025-12-27 and stored
// by the provider as 2025-12-31). Annual rows match on fiscal year; quarterly rows
// match on the nearest quarter-end within three weeks, and only when that match is
// unique — otherwise the period is left alone rather than guessed.
function providerRow(rows, periodEnd, annual) {
    if (!Array.isArray(rows) || !periodEnd) return null;
    if (annual) {
        const year = String(periodEnd).slice(0, 4);
        const sameYear = rows.filter(r => String(r.fiscalDateEnding || '').slice(0, 4) === year);
        if (sameYear.length === 1) return sameYear[0];
        if (!sameYear.length) return null;
        return sameYear.slice().sort((a, b) =>
            Math.abs(Date.parse(a.fiscalDateEnding) - Date.parse(periodEnd)) - Math.abs(Date.parse(b.fiscalDateEnding) - Date.parse(periodEnd)))[0];
    }
    const target = Date.parse(periodEnd);
    const near = rows
        .map(r => ({ row: r, days: Math.abs(Date.parse(r.fiscalDateEnding) - target) / 86400000 }))
        .filter(c => Number.isFinite(c.days) && c.days <= 21)
        .sort((a, b) => a.days - b.days);
    if (!near.length) return null;
    if (near[1] && near[1].days === near[0].days) return null;
    return near[0].row;
}

// `verifiedRows` are the rows the caller is about to hand the model, so a field
// only appears here when the verified side has nothing for that exact period.
function statementGaps(symbol, statement, basis, verifiedRows) {
    const map = GAP_FIELDS[statement];
    if (!map || !Array.isArray(verifiedRows) || !verifiedRows.length) return null;
    const raw = snapshot(symbol);
    if (!raw) return null;
    const providerRows = raw[statement]?.[basis === 'quarterly' ? 'quarterlyReports' : 'annualReports'];
    if (!Array.isArray(providerRows) || !providerRows.length) return null;
    const annual = basis !== 'quarterly';
    const fields = {};
    for (const row of verifiedRows) {
        const provider = providerRow(providerRows, row.fiscalDateEnding, annual);
        if (!provider) continue;
        for (const [field, providerField, magnitude] of map) {
            const verified = row[field];
            if (verified !== null && verified !== undefined) continue;
            const raw = pnum(provider[providerField]);
            if (raw === null) continue;
            // The provider writes "0" where it has no value for a line it still
            // emits: measured on AMD, Realty Income and JPMorgan, EBIT is "0" for
            // all three, which is impossible for companies with filed operating
            // income. A false zero is worse than an omitted figure — the whole
            // point of this path is that a gap is stated, never filled wrongly.
            if (raw === 0) continue;
            (fields[field] ||= []).push({
                periodEnd: row.fiscalDateEnding,
                providerPeriodEnd: provider.fiscalDateEnding || null,
                value: magnitude ? Math.abs(raw) : raw,
                ...(magnitude ? { magnitude: true } : {}),
                currency: String(provider.reportedCurrency || row.reportedCurrency || 'USD').toUpperCase(),
                providerField
            });
        }
    }
    if (!Object.keys(fields).length) return null;
    return {
        source: PROVIDER,
        asOf: raw.fetchedAt || null,
        fields,
        units: 'Unscaled values in the row currency; magnitudes are unsigned cash outflows.',
        note: `${ATTRIBUTION} These fields are absent from the issuer’s XBRL facts for the listed periods, so nothing here contradicts a filed figure — it supplements it.`
    };
}

module.exports = { PROVIDER, ATTRIBUTION, valuation, statementGaps, snapshot, pnum };
