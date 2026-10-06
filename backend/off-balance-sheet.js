'use strict';
// Commitments a company has made that are not liabilities on its balance sheet:
// leases signed but not yet commenced, unrecorded purchase obligations,
// guarantees, and exposure to entities it does not consolidate.
//
// Every figure is read from the inline XBRL of the issuer's latest 10-K, 10-Q or
// 20-F, with the sentence it was printed in. Nothing is estimated and no model
// is involved, so the same reader works for every filer. The categories are not
// added together: a filer's own tables overlap (a lease not yet commenced is
// often also inside its contractual-obligations total).
const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const watchdog = require('./watchdog');
const { label } = require('./ask-inline-segments');

const VERSION = 1;
const PERIODIC_FORMS = [...secSource.ANNUAL_FORMS, '10-Q'];
const CATEGORIES = {
    leases_not_commenced: 'Leases signed but not yet commenced',
    purchase_obligations: 'Purchase and contractual commitments',
    guarantees: 'Guarantees',
    unconsolidated_entities: 'Exposure to unconsolidated entities'
};
// Schedule rows ("due in the second year") repeat a total that is already listed.
const SCHEDULE = /(?:Due|Paid|Payments?)(?:In|After|Within|Remainder|NextTwelve|Year)|Anniversary|RemainderOfFiscalYear|NextTwelveMonths|Thereafter|YearOne|YearTwo|YearThree|YearFour|YearFive|AfterYear/;
const BY_CONCEPT = [
    ['leases_not_commenced', /NotYetCommenced/i],
    ['guarantees', /ResidualValueGuarantee|GuaranteeObligationsMaximumExposure|Guarantees?.*(?:Maximum|Exposure)/i],
    ['unconsolidated_entities', /VariableInterestEntity(?:Entity)?MaximumLossExposure|VariableInterestEntityNonconsolidated.*Exposure/i],
    ['purchase_obligations', /UnrecordedUnconditionalPurchaseObligation|^PurchaseObligation$|LongTermPurchaseCommitmentAmount|^ContractualObligation$|^OtherCommitment$|PurchaseCommitment.*Amount/i]
];
const PLAIN = {
    UnrecordedUnconditionalPurchaseObligationBalanceSheetAmount: 'Unrecorded purchase obligations', ContractualObligation: 'Total contractual obligations',
    OtherCommitment: 'Other commitments', LongTermPurchaseCommitmentAmount: 'Long-term purchase commitments', PurchaseObligation: 'Purchase obligations',
    GuaranteeObligationsMaximumExposure: 'Maximum payments under guarantees', VariableInterestEntityEntityMaximumLossExposureAmount: 'Maximum loss exposure'
};
// Standard members that say when or whether, not what; '' drops one that adds nothing.
const SCOPE = { SubsequentEventMember: 'after the period end', ScenarioForecastMember: 'planned', MaximumMember: 'maximum', MinimumMember: 'minimum',
    VariableInterestEntityNotPrimaryBeneficiaryMember: '' };
const title = (category, concept) => category === 'leases_not_commenced' ? 'Leases not yet commenced'
    : /ResidualValueGuarantee/.test(concept) ? 'Residual value guarantee' : PLAIN[concept.split(':').pop()] || label(concept);
const attributes = s => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]));
const text = html => String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(?:p|div|td|th|tr|li|table)>|<br\s*\/?>/gi, ' \u00b6 ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');

function contexts(html) {
    const out = new Map();
    for (const m of html.matchAll(/<(?:[\w.-]+:)?context\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?context>/gi)) {
        const id = attributes(m[1]).id;
        if (!id || m[2].length > 6000) continue;
        const date = tag => m[2].match(new RegExp(`<(?:[\\w.-]+:)?${tag}>\\s*(\\d{4}-\\d{2}-\\d{2})`, 'i'))?.[1] || null;
        const members = [...m[2].matchAll(/<(?:[\w.-]+:)?explicitMember\b([^>]*)>([^<]+)</gi)]
            .map(x => ({ axis: attributes(x[1]).dimension || '', member: x[2].trim() }));
        out.set(id, { end: date('instant') || date('endDate'), members });
    }
    return out;
}
function currencies(html) {
    const out = new Map();
    for (const m of html.matchAll(/<(?:[\w.-]+:)?unit\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?unit>/gi)) {
        const id = attributes(m[1]).id, measure = m[2].match(/^\s*<(?:[\w.-]+:)?measure>\s*iso4217:([A-Z]{3})\s*<\/(?:[\w.-]+:)?measure>\s*$/i);
        if (id && measure) out.set(id, measure[1].toUpperCase());
    }
    return out;
}
// The sentence a figure sits in. A table cell has no sentence, so it yields
// nothing and the concept name carries the meaning instead.
function sentence(html, start, end, printed) {
    const raw = html.slice(Math.max(0, start - 2500), start), after = text(html.slice(end, end + 2500));
    const before = text(raw.slice(raw.indexOf('>') + 1));
    const head = before.split(/\u00b6|(?<=[.;])\s+(?=[A-Z"(0-9])/).pop() || '';
    const tail = after.split(/\u00b6|(?<=[.;])\s+(?=[A-Z"(0-9])/)[0] || '';
    const full = (head + printed + tail).replace(/\s+([,.;)])/g, '$1').replace(/\(\s+/g, '(').replace(/\$\s+(?=\d)/g, '$').replace(/\s+/g, ' ').trim();
    if (full.length < 40 || full.length > 600 || !/[a-z]{3,}\s+[a-z]{2,}\s+[a-z]{2,}/.test(full) || !/[.;]$/.test(full)) return null;
    return full;
}
function categoryOf(concept, context, scope = []) {
    const bare = concept.split(':').pop();
    // A payment already made is cash that has left, not a commitment outstanding.
    if (SCHEDULE.test(bare) || /^(?:Payments?|Prepa)/.test(bare)) return null;
    for (const [category, pattern] of BY_CONCEPT) {
        if (!pattern.test(bare)) continue;
        // Filers put uncommenced leases under the purchase-obligation concept and
        // say what they are in the member or the sentence.
        const said = scope.join(' ') + ' ' + (context || '');
        return category === 'purchase_obligations' && (/not yet commenced/i.test(said) || /\bleases?\b/i.test(said) && /\bcommenc/i.test(said)) ? 'leases_not_commenced' : category;
    }
    // Most filers tag this one with a concept of their own that does not say what it is.
    if (context && /\bnot yet commenced\b/i.test(context) && /\bleases?\b/i.test(context) && !/Liabilit|RightOfUse|Expense|Cost|Payments?$/.test(bare)) return 'leases_not_commenced';
    return null;
}

function read(html) {
    const ctx = contexts(html), units = currencies(html);
    const period = html.match(/<ix:nonnumeric\b[^>]*name=["']dei:DocumentPeriodEndDate["'][^>]*>/i);
    const periodEnd = period ? ctx.get(attributes(period[0]).contextref)?.end || null : null;
    const items = [], seen = new Set(), DAY = 86400000;
    for (const m of html.matchAll(/<ix:nonfraction\b([^>]*)>([\s\S]*?)<\/ix:nonfraction>/gi)) {
        const a = attributes(m[1]), context = ctx.get(a.contextref), currency = units.get(a.unitref);
        if (!a.name || !context?.end || !currency || m[0].length > 2500) continue;
        // An arrangement dated at signing is still in force; a prior-period
        // comparative is dropped below once the current figure is found.
        if (periodEnd && Date.parse(context.end) < Date.parse(periodEnd) - 550 * DAY) continue;
        const printed = text(m[2]).trim(), scale = Number(a.scale || 0);
        const plain = /num-?comma-?decimal/i.test(a.format || '') ? printed.replace(/\./g, '').replace(',', '.') : printed.replace(/,/g, '');
        if (!/^\d+(?:\.\d+)?$/.test(plain) || !Number.isInteger(scale) || scale < 0 || scale > 12) continue;
        const value = Number(plain) * 10 ** scale;
        if (!(value > 0) || a.sign === '-') continue;
        const excerpt = sentence(html, m.index, m.index + m[0].length, printed);
        const scope = context.members.map(x => SCOPE[x.member.split(':').pop()] ?? label(x.member)).filter(Boolean);
        const category = categoryOf(a.name, excerpt, scope);
        if (!category) continue;
        const key = [category, a.name, value, context.end, scope.join('|')].join('~');
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ category, concept: a.name, name: title(category, a.name), value, currency, asOf: context.end, scope, excerpt });
    }
    const current = items.filter(i => !items.some(o => o !== i && o.concept === i.concept && o.scope.join('|') === i.scope.join('|') && o.asOf > i.asOf));
    items.length = 0; items.push(...current);
    // The widest figure in each category leads; a member-scoped part follows it.
    items.sort((x, y) => Object.keys(CATEGORIES).indexOf(x.category) - Object.keys(CATEGORIES).indexOf(y.category) ||
        x.scope.length - y.scope.length || y.value - x.value);
    return { periodEnd, items };
}

async function latestPeriodic(symbol) {
    const filings = await watchdog.fetchRecentFilings(symbol);
    return (filings || []).find(f => PERIODIC_FORMS.includes(f.form) && /\.htm/i.test(f.url || '')) || null;
}

// One filing lookup per symbol per six hours, however many times the page is viewed.
const recent = new Map(), RECENT_MS = 6 * 3600 * 1000;
async function extract(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const held = recent.get(sym);
    if (held && Date.now() - held.at < RECENT_MS) return held.payload;
    const payload = await extractUncached(sym);
    if (!payload.error) { if (recent.size >= 500) recent.delete(recent.keys().next().value); recent.set(sym, { at: Date.now(), payload }); }
    return payload;
}
async function extractUncached(sym) {
    const filing = await latestPeriodic(sym);
    if (!filing) return { error: 'No periodic SEC filing found for this company.' };
    const col = mongoose.connection.readyState === 1 ? mongoose.connection.collection('company_off_balance') : null;
    try {
        const hit = col && await col.findOne({ symbol: sym, accession: filing.accession, version: VERSION });
        if (hit) return { ...hit.payload, cached: true };
    } catch (_) { /* cache is best-effort */ }
    const r = await axios.get(filing.url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 40e6, responseType: 'text', transformResponse: x => x });
    const parsed = read(String(r.data || ''));
    const payload = {
        symbol: sym, periodEnd: parsed.periodEnd,
        categories: Object.entries(CATEGORIES).map(([key, title]) => ({ key, title, items: parsed.items.filter(i => i.category === key).slice(0, 6).map(({ category, ...rest }) => rest) }))
            .filter(c => c.items.length),
        filing: { form: filing.form, date: filing.date, url: filing.url, accessionNumber: filing.accession },
        note: 'Read from the tagged figures in this filing. Categories overlap in a filer’s own tables and are not added together.',
        source: 'SEC inline XBRL, latest periodic filing'
    };
    try {
        if (col) await col.updateOne({ symbol: sym, accession: filing.accession, version: VERSION }, { $set: { payload, at: new Date() } }, { upsert: true });
    } catch (_) { /* cache is best-effort */ }
    return payload;
}

module.exports = { extract, read, categoryOf, CATEGORIES, VERSION };
