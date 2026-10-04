'use strict';

// A currency symbol alone does not identify a foreign filer's currency.
const TOKENS = '(?:USD|CAD|AUD|HKD|SGD|NZD|EUR|GBP|CNY|JPY|CHF|INR|KRW|SEK|NOK|DKK|BRL|MXN|ZAR|ILS|TWD|US dollars?|U\\.S\\. dollars?|United States dollars?|Canadian dollars?|Australian dollars?|Hong Kong dollars?|euros?|pounds? sterling|Japanese yen|renminbi)';
function code(token, basis = null) {
    const upper = String(token || '').toUpperCase();
    const direct = { 'US$': 'USD', 'U.S.$': 'USD', 'C$': 'CAD', 'A$': 'AUD', 'HK$': 'HKD', 'S$': 'SGD', 'NZ$': 'NZD', '€': 'EUR', '£': 'GBP', RMB: 'CNY' };
    if (direct[upper]) return direct[upper];
    if (/^[A-Z]{3}$/.test(upper)) return upper;
    if (/^(?:US|U\.S\.|UNITED STATES) DOLLARS?$/.test(upper)) return 'USD';
    if (/^CANADIAN DOLLARS?$/.test(upper)) return 'CAD';
    if (/^AUSTRALIAN DOLLARS?$/.test(upper)) return 'AUD';
    if (/^HONG KONG DOLLARS?$/.test(upper)) return 'HKD';
    if (/^EUROS?$/.test(upper)) return 'EUR';
    if (/^POUNDS? STERLING$/.test(upper)) return 'GBP';
    if (/^JAPANESE YEN$/.test(upper)) return 'JPY';
    if (/^RENMINBI$/.test(upper)) return 'CNY';
    if (upper === '$') return /^(?:USD|CAD|AUD|HKD|SGD|NZD|TWD)$/.test(basis || '') ? basis : null;
    if (upper === '¥') return /^(?:JPY|CNY)$/.test(basis || '') ? basis : null;
    return null;
}
function declaration(text) {
    const pattern = new RegExp(`\\b(?:all (?:amounts|figures|dollar amounts)(?:[^.!?]{0,50})? (?:are|expressed|denominated|presented|stated) (?:expressed |denominated |presented |stated )?in|(?:our )?(?:consolidated )?financial statements are (?:presented|expressed) in)\\s+(${TOKENS})(?![A-Za-z])`, 'gi');
    const declarations = [...String(text || '').matchAll(pattern)].map(m => ({ currency: code(m[1]), excerpt: m[0] })).filter(d => d.currency);
    const units = new Set(declarations.map(d => d.currency));
    return units.size === 1 ? declarations[0] : null;
}
// Establish a filing currency from consistent core monetary inline XBRL
// facts when the prose has no explicit currency declaration. Retain literal
// unit/fact receipts so validation can repeat this without the full document.
function inlineCurrency(html) {
    const units = new Map(), currencies = new Set(), concepts = new Set(), facts = [];
    const core = /^(?:us-gaap:(?:Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|SalesRevenueNet|NetIncomeLoss|Assets|StockholdersEquity|NetCashProvidedByUsedInOperatingActivities)|ifrs-full:(?:Revenue|ProfitLoss|ProfitLossAttributableToOwnersOfParent|Assets|Equity|EquityAttributableToOwnersOfParent|CashFlowsFromUsedInOperatingActivities))$/;
    const attr = (text, name) => text.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1];
    for (const m of String(html || '').matchAll(/<(?:[\w.-]+:)?unit\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?unit>/gi)) {
        const id = attr(m[0], 'id');
        const currency = m[0].match(/<(?:[\w.-]+:)?measure>\s*iso4217:([A-Z]{3})\s*<\/(?:[\w.-]+:)?measure>/)?.[1];
        if (id && currency && !/divide/i.test(m[0]) && m[0].length < 1500) units.set(id, { currency, excerpt: m[0] });
        if (units.size > 1000) return null;
    }
    for (const m of String(html || '').matchAll(/<ix:nonfraction\b[^>]*>[\s\S]*?<\/ix:nonfraction>/gi)) {
        const concept = attr(m[0], 'name');
        if (!core.test(concept || '')) continue;
        const unit = units.get(attr(m[0], 'unitRef'));
        if (!unit || m[0].length > 1500) return null;
        currencies.add(unit.currency); concepts.add(concept);
        if (currencies.size > 1) return null;
        if (facts.length < 30 && !facts.some(f => f.concept === concept)) facts.push({ concept, fact: m[0], unit: unit.excerpt });
    }
    if (currencies.size !== 1 || concepts.size < 3) return null;
    return { type: 'sec_inline_xbrl_currency', currency: [...currencies][0], facts };
}
function verifiedReceipt(receipt) {
    if (receipt?.type !== 'sec_inline_xbrl_currency') return declaration(receipt?.excerpt)?.currency === receipt?.currency;
    if (!Array.isArray(receipt.facts) || receipt.facts.length > 30) return false;
    const witness = receipt.facts.map(f => String(f.unit || '') + String(f.fact || '')).join('');
    return witness.length <= 90000 && inlineCurrency(witness)?.currency === receipt.currency;
}

function filingBasis(results, page) {
    const units = new Set();
    const fromText = declaration(page.text);
    if (fromText) units.add(fromText.currency);
    if (page.currencyEvidence?.sourceUrl === page.url && verifiedReceipt(page.currencyEvidence))
        units.add(page.currencyEvidence.currency);
    for (const row of results) {
        const other = row.result || row;
        if (row.tool !== 'fetch_page' || other.url !== page.url) continue;
        const declared = declaration(other.text);
        if (declared) units.add(declared.currency);
        if (other.currencyEvidence?.sourceUrl === page.url && verifiedReceipt(other.currencyEvidence)) units.add(other.currencyEvidence.currency);
    }
    const match = /\/Archives\/edgar\/data\/(\d+)\/(\d{18})\//i.exec(String(page.url || ''));
    if (match) for (const row of results) for (const source of Object.values((row.result || row).provenance?.sources || {})) {
        if (source.type === 'sec_xbrl_fact' && source.linkage === 'xbrl_fact' && Number(source.cik) === Number(match[1]) &&
            String(source.accessionNumber || '').replace(/\D/g, '') === match[2] && /^[A-Z]{3}$/.test(source.unit || '')) units.add(source.unit);
    }
    return units.size === 1 ? [...units][0] : null;
}
module.exports = { code, declaration, inlineCurrency, filingBasis };
