'use strict';

async function getSupplementalContext({ symbol, missingFields = [], missingSections = [], periods = {} } = {}) {
    const stocks = require('./stock-universe');
    const online = process.env.SEC_COVERAGE_READ_ONLY !== '1' && process.env.SEC_COVERAGE_DISABLE_ON_DEMAND !== '1';
    const company = stocks.lookup(symbol) || (online ? await stocks.resolveListing(symbol) : null);
    if (!company || company.securityType !== 'stock') return { error: 'Supplemental company evidence requires a resolved stock listing.' };
    const available = new Set([...Object.values(require('./sec-facts').MAPS).flatMap(m => Object.keys(m)), ...Object.values(require('./financial-requirements').fields).flat()]);
    const requestedFields = [...new Set((Array.isArray(missingFields) ? missingFields : []).filter(f => typeof f === 'string' && f.length < 100))].slice(0, 40);
    const fields = requestedFields.filter(f => available.has(f));
    const sections = (Array.isArray(missingSections) ? missingSections : []).filter(s => ['business','customers','products','segments','risks','valuation'].includes(s));
    const requestedPeriods = { annual: Math.max(0, Math.min(25, Number(periods.annual ?? 5) || 0)), quarterly: Math.max(0, Math.min(48, Number(periods.quarterly ?? 4) || 0)), businessProfile: sections.some(s => ['business','customers','products'].includes(s)) };
    const evidence = await require('./verified-fundamentals').getCompanyEvidence(company.symbol, fields, requestedPeriods, online);
    const data = evidence.data, all = require('./company-observations').observations(evidence.statements);
    const select = facts => {
        if (!fields.length) return [];
        const groups = new Map();
        for (const f of facts) {
            if ((fields.length && !fields.includes(f.field)) || f.state !== 'available') continue;
            if (/EPS|^eps$|Shares/.test(f.field) && data.coverage?.perShareAllowed !== true) continue;
            const basis = f.historyBasis || f.basis;
            if (!requestedPeriods[basis]) continue;
            const key = [f.field, basis, f.unit, f.accountingBasis, f.scope].join('|');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
        }
        return [...groups.values()].flatMap(group => group.sort((a,b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, requestedPeriods[group[0].historyBasis || group[0].basis]));
    };
    const result = { symbol: company.symbol,
        observations: select(all).slice(0, 60), supplementalObservations: select(data.supplementalObservations || []).slice(0, 60),
        calculations: fields.length ? (data.compatibleCalculations || []).filter(f => f.inputs?.some(i => fields.includes(i.field))).slice(0, 12) : [],
        businessContext: data.businessProfile?.overview?.Description ? { text: String(data.businessProfile.overview.Description).slice(0, 9000),
            sourceName: data.businessProfile.sourceName, sourceUrl: data.businessProfile.sourceUrl,
            effectiveDate: null, retrievedAt: data.businessProfile.retrievedAt,
            note: 'Attributed provider business context. Financial values still require compatible typed observations.' } : null,
        sourceAttempts: (data.sourceAttempts || []).slice(-20), remainingGaps: [...(evidence.remainingGaps || data.coverage?.remainingGaps || [])].slice(0, 100),
        freshness: data.freshness,
        note: 'Source order: filed SEC evidence, original issuer releases, Yahoo Finance. Supplemental values are not SEC-verified. Financial history and calculations retain their unit, currency, period, definition and accounting basis. No committed financial file is overwritten.' };
    if (requestedPeriods.businessProfile && !result.businessContext) result.remainingGaps.push({ section: 'business', state: 'missing', reason: 'No attributed provider business description is available; use supplied official filing context or the existing bounded original-document tools.' });
    for (const field of requestedFields.filter(f => !available.has(f))) result.remainingGaps.push({ field, state: 'missing', reason: 'No supported mapping exists for this field. Use a canonical metric identifier or an attributable original disclosure; no substitute was invented.' });
    if (data.coverage?.perShareAllowed !== true) for (const field of fields.filter(f => /EPS|^eps$|Shares/.test(f))) result.remainingGaps.push({field,state:'missing',reason:'The requested listing share-class or ADR basis is unverified; issuer per-share observations were withheld.'});
    for (const section of sections.filter(s => ['segments','risks','valuation'].includes(s))) result.remainingGaps.push({ section, state: 'missing', reason: 'This supplemental financial resolver does not establish that section. Use the dedicated segment, quote or original-document tool; preserve a gap when those sources fail.' });
    let omitted = 0;
    while (Buffer.byteLength(JSON.stringify(result)) > 60000 && (result.observations.length || result.supplementalObservations.length || result.calculations.length)) {
        if (result.observations.length >= result.supplementalObservations.length && result.observations.length) result.observations.pop();
        else if (result.supplementalObservations.length) result.supplementalObservations.pop(); else result.calculations.pop();
        omitted++;
    }
    result.omittedForContextBudget = omitted;
    return result;
}
module.exports = { getSupplementalContext };
