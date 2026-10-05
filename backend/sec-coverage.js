'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const DAY = 86400000;
const DATA_DIR = process.env.SEC_COVERAGE_DATA_DIR || path.join(__dirname, '../frontend/data');
function number(value) {
    if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && (!value.trim() || /^(none|null)$/i.test(value.trim())))) return null;
    const n = Number(value); return Number.isFinite(n) ? n : null;
}
function cik(value) {
    const s = String(value ?? '').trim();
    return /^\d{1,10}$/.test(s) && Number(s) > 0 ? s.padStart(10, '0') : null;
}
function day(value) {
    const s = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const t = Date.parse(s + 'T00:00:00Z');
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : null;
}
function monthsBefore(value, months) {
    const d = new Date(day(value) + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime())) throw new Error('Invalid asOf date');
    const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
    const max = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
    n.setUTCDate(Math.min(d.getUTCDate(), max)); return n.toISOString().slice(0, 10);
}
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function selectAnnual(filings, asOf = day(new Date().toISOString())) {
    const originals = filings.filter(f => /^(10-K|20-F|40-F)$/.test(f.form) && day(f.filingDate) && day(f.reportDate) && f.filingDate <= asOf && f.reportDate <= asOf);
    originals.sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filingDate.localeCompare(a.filingDate) || b.accessionNumber.localeCompare(a.accessionNumber));
    if (!originals.length) return null;
    const annual = originals[0];
    return { ...annual, amendments: filings.filter(f => f.form === annual.form + '/A' && f.reportDate === annual.reportDate && day(f.filingDate) && f.filingDate >= annual.filingDate && f.filingDate <= asOf) };
}
function reportingStatus(evidence, asOf = day(new Date().toISOString())) {
    if (!day(asOf)) throw new Error('Invalid asOf date');
    const checked = day(evidence?.lastSuccessfulCheckAt);
    if (!cik(evidence?.cik) || evidence?.lastAttemptResult === 'invalid_identity' || !checked || checked > asOf || Date.parse(asOf) - Date.parse(checked) > 35 * DAY) return 'unverified';
    const a = evidence.latestAnnual;
    if (!a) return evidence.amendmentOnly ? 'unverified' : 'no_recent_annual';
    if (!/^(10-K|20-F|40-F)$/.test(a.form) || !day(a.filingDate) || !day(a.reportDate) || a.filingDate > asOf || a.reportDate > asOf) return 'unverified';
    return a.filingDate >= monthsBefore(asOf, 12) && a.reportDate >= monthsBefore(asOf, 18) ? 'recent_annual' : 'no_recent_annual';
}
function validSource(source, issuerCik) {
    if(source?.verificationMethod==='original_inline_xbrl' && require('./sec-inline-number').number(source.originalDocument?.numericReceipt)!==source.rawValue)return false;
    return !!(source && source.type === 'sec_xbrl_fact' && source.linkage === 'xbrl_fact' && cik(source.cik) === cik(issuerCik) && source.taxonomy && source.concept && source.unit && number(source.rawValue) !== null && day(source.periodEnd) && (source.periodStart===null || day(source.periodStart)) && day(source.filingDate) && source.filingDate>=source.periodEnd && /^\d{10}-\d{2}-\d{6}$/.test(source.accessionNumber || '') && source.filingUrl === `https://www.sec.gov/Archives/edgar/data/${Number(issuerCik)}/${source.accessionNumber.replace(/-/g, '')}/${source.accessionNumber}-index.htm`);
}
function verifiedField(data, row, field, accessions) {
    if (number(row?.[field]) === null) return false;
    const ids = row._sources?.[field];
    if (!Array.isArray(ids) || !ids.length) return false;
    const sources = ids.map(id => data.sources?.[id]);
    const derived = row._derivations?.[field];
    if(field==='totalRevenue' && sources.some(s=>require('./sec-facts').partialRevenueConcept(data.reportingSic,s?.concept)))return false;
    // These narrower/broader concepts are not equivalent to the displayed field.
    const incompatible={longTermDebt:['LongTermDebt','LongTermBorrowings'],shortTermDebt:['ShortTermBorrowings'],sellingGeneralAndAdministrative:['GeneralAndAdministrativeExpense','AdministrativeExpense'],interestExpense:['InterestExpenseDebt','FinanceCosts'],depreciationDepletionAndAmortization:['DepreciationDepletionAndAmortizationPropertyPlantAndEquipment','DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss']};
    if(!derived && sources.some(s=>incompatible[field]?.includes(s?.concept)))return false;
    if(field==='grossProfit' && derived && /^(602|603|609|63)/.test(String(data.reportingSic || '')))return false;
    if(['sum_fields','difference_fields'].includes(derived?.formula)) {
        const permitted={totalRevenue:['netInterestIncome','nonInterestIncome'],grossProfit:['totalRevenue','costOfRevenue'],shortTermDebt:['shortTermBorrowings','currentLongTermDebt'],shortLongTermDebtTotal:['shortTermDebt','longTermDebt']};
        const inputs=permitted[field];
        if(!inputs || JSON.stringify(derived.inputs)!==JSON.stringify(inputs) || !inputs.every(f=>verifiedField(data,row,f,accessions)))return false;
        if(row._scopes?.[inputs[0]]!==row._scopes?.[inputs[1]])return false;
        const versions=field=>[...new Set((row._sources[field] || []).map(id=>data.sources[id]?.accessionNumber))].sort().join('|');
        if(versions(inputs[0])!==versions(inputs[1]))return false;
        const expectedRefs=inputs.flatMap(f=>row._sources[f]);
        const operation=field==='grossProfit'?'difference_fields':'sum_fields';
        const value=operation==='sum_fields'?row[inputs[0]]+row[inputs[1]]:row[inputs[0]]-row[inputs[1]];
        return derived.formula===operation && number(row[field])===value && JSON.stringify(ids)===JSON.stringify(expectedRefs);
    }
    if (!sources.every(s => validSource(s, data.cik) && /^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/.test(s.form) && (!accessions || accessions.has(s.accessionNumber)) && (s.periodEnd === row.fiscalDateEnding || derived?.formula === 'ytd_difference') && s.unit === (/(?:EPS|^eps$)/.test(field) ? row.reportedCurrency + '/shares' : /Shares/.test(field) ? 'shares' : row.reportedCurrency))) return false;
    if (row.periodType==='instant' && sources.some(s=>s.periodStart!==null)) return false;
    if (row.periodType!=='instant' && !derived && sources.some(s=>s.periodStart!==row.periodStart)) return false;
    if (row.periodType==='annual' && sources.some(s=>! /^(10-K|20-F|40-F)(\/A)?$/.test(s.form) || (Date.parse(s.periodEnd)-Date.parse(s.periodStart))/DAY+1<340 || (Date.parse(s.periodEnd)-Date.parse(s.periodStart))/DAY+1>380)) return false;
    if (!row._derivations?.[field] && sources.length !== 1) return false;
    if (!row._derivations?.[field] && number(row[field]) !== (row._signs?.[field] === -1 ? -Math.abs(number(sources[0].rawValue)) : number(sources[0].rawValue))) return false;
    if (derived) {
        if (sources.length !== 2 || !['ytd_difference','revenue_minus_cost'].includes(derived.formula)) return false;
        if (derived.formula === 'ytd_difference' && (sources[0].periodStart !== sources[1].periodStart || sources[0].periodEnd !== row.fiscalDateEnding || sources[1].periodEnd >= row.fiscalDateEnding || /EPS|^eps$|Shares/.test(field) || sources[0].taxonomy!==sources[1].taxonomy || sources[0].concept!==sources[1].concept || sources[1].filingDate>sources[0].filingDate || (/\/A$/.test(sources[0].form) && sources[0].accessionNumber!==sources[1].accessionNumber) || row.periodType!=='quarterly' || row.periodStart!==new Date(Date.parse(sources[1].periodEnd)+DAY).toISOString().slice(0,10) || (Date.parse(row.fiscalDateEnding)-Date.parse(row.periodStart))/DAY+1<75 || (Date.parse(row.fiscalDateEnding)-Date.parse(row.periodStart))/DAY+1>105)) return false;
        if (derived.formula === 'revenue_minus_cost' && (sources[0].periodStart !== sources[1].periodStart || sources[0].periodEnd !== sources[1].periodEnd)) return false;
        const value = number(sources[0].rawValue) - number(sources[1].rawValue);
        if (number(row[field]) !== (row._signs?.[field] === -1 ? -Math.abs(value) : value)) return false;
    }
    return true;
}
function classify(evidence, data, asOf = day(new Date().toISOString())) {
    const annualReportingStatus = reportingStatus(evidence, asOf);
    const sameIssuer = data?.schemaVersion === 1 && cik(data.cik) === cik(evidence?.cik);
    let hasHistory = false;
    if (sameIssuer) for (const st of ['income','balance','cash']) for (const basis of ['annualReports','quarterlyReports']) for (const row of data[st]?.[basis] || []) {
        if (Object.keys(row._sources || {}).some(f => verifiedField(data, row, f))) hasHistory = true;
    }
    const a = evidence?.latestAnnual;
    const accessions = new Set(a ? [a.accessionNumber, ...(a.amendments || []).map(x => x.accessionNumber)] : []);
    const row = st => sameIssuer && a ? (data[st]?.annualReports || []).find(r => r.fiscalDateEnding === a.reportDate) : null;
    const has = (st, f) => verifiedField(data, row(st), f, accessions) && (row(st)._sources[f] || []).every(id=>[a.form,a.form+'/A'].includes(data.sources[id].form));
    const current = annualReportingStatus === 'recent_annual';
    const duration = r => r && day(r.periodStart) && (Date.parse(r.fiscalDateEnding) - Date.parse(r.periodStart)) / DAY + 1 >= 340 && (Date.parse(r.fiscalDateEnding) - Date.parse(r.periodStart)) / DAY + 1 <= 380;
    const ready = current && row('income')?.reportedCurrency===row('balance')?.reportedCurrency && row('income')?.reportedCurrency===row('cash')?.reportedCurrency && duration(row('income')) && duration(row('cash')) && has('income','netIncome') && has('balance','totalAssets') && has('balance','totalShareholderEquity') && has('cash','operatingCashflow') && ['totalRevenue','eps','dilutedEPS'].some(f => has('income',f));
    const currentFacts = current && ['income','balance','cash'].some(st => Object.keys(row(st)?._sources || {}).some(f => has(st,f)));
    return { annualReportingStatus, financialCoverage: ready ? 'ready' : currentFacts ? 'partial' : hasHistory ? 'historical_only' : 'unavailable' };
}
function count(securities, issuers) {
    const ids = new Set(securities.filter(s => s.securityType === 'stock' && cik(s.cik)).map(s => cik(s.cik)));
    const out = { listedSecurities: securities.length, identifiedIssuers: ids.size, recentAnnualIssuers: 0, financialReadyIssuers: 0, partialFinancialIssuers: 0, historicalOnlyIssuers: 0, unavailableFinancialIssuers: 0, screenableListings: 0, screenableIssuers: 0 };
    const fields = { ready:'financialReadyIssuers', partial:'partialFinancialIssuers', historical_only:'historicalOnlyIssuers', unavailable:'unavailableFinancialIssuers' };
    for (const id of ids) { const c = issuers[id] || { financialCoverage:'unavailable' }; if(c.annualReportingStatus === 'recent_annual') out.recentAnnualIssuers++; out[fields[c.financialCoverage]]++; }
    const screen = securities.filter(s => s.screenable); out.screenableListings = screen.length; out.screenableIssuers = new Set(screen.map(s => s.cik)).size;
    return out;
}
function atomicWrite(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive:true });
    const tmp = file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp,file); } finally { try {fs.unlinkSync(tmp);} catch (_) {} }
}
function validateFinancial(data, expectedCik, asOf=day(new Date().toISOString())) {
    const errors=[];
    if(data?.schemaVersion!==1 || data.cik!==cik(expectedCik))return ['Invalid financial identity or schema'];
    const metadata=new Set(['fiscalDateEnding','periodStart','reportedCurrency','periodType']);
    for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports']) {
        if(!Array.isArray(data[st]?.[basis])){errors.push('Missing '+st+'.'+basis);continue;}
        const periods=new Set();
        for(const row of data[st][basis]) {
            const label=st+'.'+basis+'.'+row.fiscalDateEnding;
            if(!day(row.fiscalDateEnding) || row.fiscalDateEnding>asOf || periods.has(row.fiscalDateEnding))errors.push(label+': invalid or duplicate period');
            periods.add(row.fiscalDateEnding);
            if(!/^[A-Z]{3}$/.test(row.reportedCurrency || '') || row.periodType!==(st==='balance'?'instant':basis==='annualReports'?'annual':'quarterly'))errors.push(label+': invalid currency or period type');
            for(const [field,value]of Object.entries(row)) {
                if(metadata.has(field)||field.startsWith('_')||value===null)continue;
                if(number(value)===null || !verifiedField(data,row,field))errors.push(label+'.'+field+': invalid provenance or value');
                for(const id of row._sources?.[field] || [])if(data.sources?.[id]?.filingDate>asOf)errors.push(label+'.'+field+': future source');
            }
        }
    }
    for(const f of data.industryObservations || [])if(!require('./sec-industry-tables').validObservation(f,expectedCik))errors.push('Invalid industry disclosure provenance '+f.field);
    for(const g of data.segmentObservations || [])if(!require('./sec-segment-observations').validGroup(g,data))errors.push('Invalid segment disclosure provenance '+g.periodEnd);
    return errors;
}
module.exports = { DATA_DIR, number, cik, day, monthsBefore, digest, selectAnnual, reportingStatus, validSource, verifiedField, classify, count, atomicWrite, validateFinancial };
