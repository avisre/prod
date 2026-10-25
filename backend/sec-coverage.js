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
    if (!cik(evidence?.cik) || evidence?.lastAttemptResult === 'invalid_identity' || !checked || !Number.isFinite(Date.parse(evidence.lastSuccessfulCheckAt)) || Date.parse(evidence.lastSuccessfulCheckAt)>Date.now()+5*60*1000 || Date.parse(asOf) - Date.parse(checked) > 35 * DAY) return 'unverified';
    const a = evidence.latestAnnual;
    if (!a) return evidence.amendmentOnly ? 'unverified' : 'no_recent_annual';
    if (!/^(10-K|20-F|40-F)$/.test(a.form) || !day(a.filingDate) || !day(a.reportDate) || a.filingDate > asOf || a.reportDate > asOf) return 'unverified';
    // A company is current until its next annual report is overdue, not until
    // the anniversary of the last one: Micron filed on 2025-10-03, and a strict
    // twelve months dropped it (and Ferguson, and seven others) from coverage for
    // the days before this year's filing. Fifteen months covers the filing
    // deadline plus a late-filing extension; the 18-month period test is unchanged.
    return a.filingDate >= monthsBefore(asOf, 15) && a.reportDate >= monthsBefore(asOf, 18) ? 'recent_annual' : 'no_recent_annual';
}
function validSource(source, issuerCik) {
    if(source?.verificationMethod==='original_inline_xbrl' && require('./sec-inline-number').number(source.originalDocument?.numericReceipt)!==source.rawValue)return false;
    return !!(source && source.type === 'sec_xbrl_fact' && source.linkage === 'xbrl_fact' && cik(source.cik) === cik(issuerCik) && source.taxonomy && source.concept && source.unit && number(source.rawValue) !== null && day(source.periodEnd) && (source.periodStart===null || day(source.periodStart)) && day(source.filingDate) && source.filingDate>=source.periodEnd && /^\d{10}-\d{2}-\d{6}$/.test(source.accessionNumber || '') && source.filingUrl === `https://www.sec.gov/Archives/edgar/data/${Number(issuerCik)}/${source.accessionNumber.replace(/-/g, '')}/${source.accessionNumber}-index.htm`);
}
// The balance-sheet debt lines a presented total may add up (sec-facts presentedDebt).
const DEBT_PARTS=['longTermDebt','currentLongTermDebt','shortTermBorrowings','shortTermDebt'];
// Presented debt lines the row does not hold as figures (sec-facts presentedDebt): which tags are debt, which
// are presented beside debt but are not (dropped), and which are a whole of other debt tags. A whole beside one
// of its own pieces would count the piece twice, so that face is left unread.
const NOT_DEBT_LINE=/^(PreferredStock|ConvertiblePreferredStock|CommonStockValue|CommitmentsAndContingencies|Allowance)/;
const DEBT_LINE=/Debt|Borrowing|NotesPayable|NotePayable|LoansPayable|LoanPayable|LoansReceived|LoansFrom|LoanFrom|BankLoans|ConstructionLoan|BridgeLoan|LineOfCredit|LinesOfCredit|CommercialPaper|Bonds|Debentures|Mortgage|FederalHomeLoanBank|SubordinatedLiabilities|SecuredFinancings/;
const NOT_DEBT_PART=/Deferred|Derivative|Interest|Receivable|Warrant|Lease(?!Obligation)|Investment|Securities|Asset|Issuance|Fees/;
const DEBT_WHOLE={LongTermDebt:['LongTermDebtCurrent','LongTermDebtNoncurrent'],LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities:['LongTermDebtAndCapitalLeaseObligationsCurrent','LongTermDebtAndCapitalLeaseObligations','LongTermDebtCurrent','LongTermDebtNoncurrent'],
 LongTermDebtAndCapitalLeaseObligations:['LongTermDebtNoncurrent'],LongTermDebtAndCapitalLeaseObligationsCurrent:['LongTermDebtCurrent'],NotesPayable:['NotesPayableCurrent','LongTermNotesPayable'],LoansPayable:['LoansPayableCurrent','LongTermLoansPayable'],
 ConvertibleDebt:['ConvertibleDebtCurrent','ConvertibleDebtNoncurrent'],ConvertibleNotesPayable:['ConvertibleNotesPayableCurrent','ConvertibleLongTermNotesPayable'],LineOfCredit:['LinesOfCreditCurrent','LongTermLineOfCredit'],
 SecuredDebt:['SecuredDebtCurrent','SecuredLongTermDebt'],UnsecuredDebt:['UnsecuredDebtCurrent','UnsecuredLongTermDebt'],SeniorNotes:['SeniorNotesCurrent','SeniorLongTermNotes'],SubordinatedDebt:['SubordinatedDebtCurrent','SubordinatedLongTermDebt'],
 OtherLongTermDebt:['OtherLongTermDebtCurrent','OtherLongTermDebtNoncurrent'],ConstructionLoan:['ConstructionLoanNoncurrent','LongTermConstructionLoanCurrent'],
 DebtCurrent:['LongTermDebtCurrent','ShortTermBorrowings','CommercialPaper','NotesPayableCurrent','LinesOfCreditCurrent','LoansPayableCurrent','ConvertibleNotesPayableCurrent','ConvertibleDebtCurrent','LongTermDebtAndCapitalLeaseObligationsCurrent','OtherShortTermBorrowings','BankOverdrafts','SecuredDebtCurrent','UnsecuredDebtCurrent','ShortTermBankLoansAndNotesPayable'],
 ShortTermBorrowings:['CommercialPaper','ShortTermBankLoansAndNotesPayable','OtherShortTermBorrowings','BankOverdrafts','ShortTermNonBankLoansAndNotesPayable']};
const DEBT_TOTALS=['DebtAndCapitalLeaseObligations','DebtInstrumentCarryingAmount','DebtLongtermAndShorttermCombinedAmount','LongTermDebtAndShortTermBorrowings','Borrowings','DebtInstrumentFaceAmount'];
function presentedDebtFacts(concepts, values, row) {
    if(!concepts.length || concepts.length!==values.length || new Set(concepts).size!==concepts.length)return false;
    if(concepts.some(c=>!DEBT_LINE.test(c) || NOT_DEBT_PART.test(c) || NOT_DEBT_LINE.test(c)) || values.some(v=>number(v)===null || v<0))return false;
    if(concepts.length>1 && concepts.some(c=>DEBT_TOTALS.includes(c)))return false;
    if(concepts.some(c=>(DEBT_WHOLE[c] || []).some(x=>concepts.includes(x))))return false;
    // A line equal to a sum of other lines is their subtotal, or one figure presented twice.
    for(let j=0;j<values.length;j++){const others=values.filter((_,k)=>k!==j);if(values[j]!==0 && others.length<=12)for(let m=1;m<(1<<others.length);m++){let s=0;for(let b=0;b<others.length;b++)if(m>>b&1)s+=others[b];if(s===values[j])return false;}}
    const cap=number(row.totalLiabilities) ?? number(row.totalAssets);
    return cap!==null && values.reduce((a,b)=>a+b,0)<=cap;
}
// The capital-spending lines one cash-flow statement presents for a period (statement-lines capexLine), as
// filed: all one sign, no line the sum of others (a subtotal, or one figure shown twice), and the
// productive-assets total never beside other lines, which can be its own parts (Entergy 2025).
function presentedCapexFacts(concepts, values) {
    if(!concepts.length || concepts.length!==values.length || new Set(concepts).size!==concepts.length || values.some(v=>number(v)===null))return false;
    if(!(values.every(v=>v>=0) || values.every(v=>v<=0)) || values.every(v=>v===0))return false;
    if(concepts.length>1 && concepts.includes('PaymentsToAcquireProductiveAssets'))return false;
    for(let j=0;j<values.length;j++){const others=values.filter((_,k)=>k!==j);if(values[j]!==0 && others.length && others.length<=12)for(let m=1;m<(1<<others.length);m++){let s=0;for(let b=0;b<others.length;b++)if(m>>b&1)s+=others[b];if(s===values[j])return false;}}
    return true;
}
// These narrower/broader concepts are not equivalent to the displayed field.
const INCOMPATIBLE={longTermDebt:['LongTermDebt','LongTermBorrowings'],shortTermDebt:['ShortTermBorrowings'],sellingGeneralAndAdministrative:['GeneralAndAdministrativeExpense','AdministrativeExpense'],interestExpense:['InterestExpenseDebt','FinanceCosts'],depreciationDepletionAndAmortization:['DepreciationDepletionAndAmortizationPropertyPlantAndEquipment','DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss']};
function verifiedField(data, row, field, accessions) {
    if (number(row?.[field]) === null) return false;
    const ids = row._sources?.[field];
    if (!Array.isArray(ids) || !ids.length) return false;
    const sources = ids.map(id => data.sources?.[id]);
    const derived = row._derivations?.[field];
    if(field==='totalRevenue' && sources.some(s=>require('./sec-facts').partialRevenueConcept(data.reportingSic,s?.concept)))return false;
    if(!derived && sources.some(s=>INCOMPATIBLE[field]?.includes(s?.concept)))return false;
    if(field==='grossProfit' && derived && /^(602|603|609|63)/.test(String(data.reportingSic || '')))return false;
    // Total debt as the sum of the debt lines the balance sheet presents, each a filed figure
    // of this row from one filing (sec-facts presentedDebt). The parts are read as filed, never derived.
    if(derived?.formula==='sum_presented_lines') {
        const inputs=derived.inputs;
        if(field!=='shortLongTermDebtTotal' || !Array.isArray(inputs) || !inputs.length || new Set(inputs).size!==inputs.length || !inputs.every(f=>DEBT_PARTS.includes(f)))return false;
        if(inputs.includes('shortTermDebt') && inputs.some(f=>f==='currentLongTermDebt' || f==='shortTermBorrowings'))return false;
        if(!inputs.every(f=>!row._derivations?.[f] && verifiedField(data,row,f,accessions) && row._sources[f].length===1 && row._scopes?.[f]===row._scopes?.[inputs[0]]))return false;
        const parts=inputs.map(f=>data.sources[row._sources[f][0]]);
        if(new Set(parts.map(s=>s.accessionNumber)).size!==1 || JSON.stringify(parts.map(s=>s.concept))!==JSON.stringify(derived.presentedConcepts))return false;
        return number(row[field])===inputs.reduce((sum,f)=>sum+row[f],0) && JSON.stringify(ids)===JSON.stringify(inputs.map(f=>row._sources[f][0]));
    }
    // The same total when the row holds none of the presented lines as figures: each line is a filed instant
    // fact of the filing the row's total assets cite, in the row's currency.
    if(derived?.formula==='sum_presented_facts') {
        const anchor=data.sources?.[(row._sources.totalAssets || [])[0]]?.accessionNumber;
        if(field!=='shortLongTermDebtTotal' || row.periodType!=='instant' || !anchor || !Array.isArray(derived.presentedConcepts) || sources.length!==derived.presentedConcepts.length)return false;
        if(!sources.every((s,i)=>validSource(s,data.cik) && /^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/.test(s.form) && (!accessions || accessions.has(s.accessionNumber)) && s.accessionNumber===anchor && s.periodEnd===row.fiscalDateEnding && s.periodStart===null && s.unit===row.reportedCurrency && s.concept===derived.presentedConcepts[i]))return false;
        const values=sources.map(s=>number(s.rawValue));
        return presentedDebtFacts(derived.presentedConcepts,values,row) && number(row[field])===values.reduce((a,b)=>a+b,0) && !row._signs?.[field];
    }
    if(['sum_fields','difference_fields'].includes(derived?.formula)) {
        const permitted={totalRevenue:['netInterestIncome','nonInterestIncome'],grossProfit:['totalRevenue','costOfRevenue'],shortTermDebt:['shortTermBorrowings','currentLongTermDebt'],shortLongTermDebtTotal:['shortTermDebt','longTermDebt']};
        // Net sales plus other revenues, for IFRS filers that report no total line.
        const alternate={totalRevenue:['revenueFromSaleOfGoods','otherRevenue'],operatingCashflow:['operatingCashflowContinuing','operatingCashflowDiscontinued']};
        const inputs=JSON.stringify(derived.inputs)===JSON.stringify(alternate[field])?alternate[field]:permitted[field];
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
    // A 6-K counts only as the annual statements of the 20-F or 40-F filed that same day.
    const annualSource=s=>/^(10-K|20-F|40-F)(\/A)?$/.test(s.form) || (s.form==='6-K' && /^(20-F|40-F)$/.test(s.annualFiling?.form || '') && /^\d{10}-\d{2}-\d{6}$/.test(s.annualFiling.accessionNumber || '') && s.annualFiling.filingDate===s.filingDate);
    if (row.periodType==='annual' && sources.some(s=>!annualSource(s) ||(Date.parse(s.periodEnd)-Date.parse(s.periodStart))/DAY+1<340 || (Date.parse(s.periodEnd)-Date.parse(s.periodStart))/DAY+1>380)) return false;
    // Capital spending as the sum of the lines one cash-flow statement presents (sec-facts presentedCapex):
    // every part a statement line of one filing, for this row's own span.
    if (derived?.formula === 'sum_presented_capex') {
        if (field !== 'capitalExpenditures' || !Array.isArray(derived.presentedConcepts) || sources.length !== derived.presentedConcepts.length || row.periodType === 'instant') return false;
        if (!sources.every((s, i) => s.verificationMethod === 'statement_line' && s.periodStart === row.periodStart && s.concept === derived.presentedConcepts[i] && s.accessionNumber === sources[0].accessionNumber)) return false;
        const values = sources.map(s => number(s.rawValue)), sum = values.reduce((a, b) => a + b, 0);
        return presentedCapexFacts(derived.presentedConcepts, values) && row._signs?.[field] === -1 && number(row[field]) === -Math.abs(sum);
    }
    // A balance-sheet field as the sum of the segment columns the balance sheet is presented in
    // (sec-facts presentedColumns): one allow-listed axis, one filing, one source per member, and
    // the columns' Assets are this row's own total assets (Berkshire 2026-06-30: 1,010,646 + 252,425 = 1,263,071).
    if (derived?.formula === 'sum_member_columns') {
        const MAPS = require('./sec-facts').MAPS;
        if (!MAPS.balance[field] || row.periodType !== 'instant' || !Array.isArray(derived.members) || derived.members.length < 2 || sources.length !== derived.members.length || new Set(derived.members).size !== derived.members.length) return false;
        if (!['ProductOrService', 'BusinessSegments'].includes(derived.axis)) return false;
        if (!sources.every((s, i) => s.verificationMethod === 'statement_line' && s.periodStart === null && s.concept === derived.presentedConcept && s.dimension === derived.axis + '=' + derived.members[i] && s.accessionNumber === sources[0].accessionNumber)) return false;
        if (!Array.isArray(derived.memberAssets) || derived.memberAssets.length !== derived.members.length || !derived.memberAssets.every(v => number(v) > 0) || derived.memberAssets.reduce((a, b) => a + b, 0) !== number(row.totalAssets)) return false;
        const values = sources.map(s => number(s.rawValue));
        return number(row[field]) === values.reduce((a, b) => a + b, 0) && !row._signs?.[field];
    }
    if (!row._derivations?.[field] && sources.length !== 1) return false;
    if (!row._derivations?.[field] && number(row[field]) !== (row._signs?.[field] === -1 ? -Math.abs(number(sources[0].rawValue)) : number(sources[0].rawValue))) return false;
    if (derived) {
        if (sources.length !== 2 || !['ytd_difference','revenue_minus_cost'].includes(derived.formula)) return false;
        if (derived.formula === 'ytd_difference' && (sources[0].periodStart !== sources[1].periodStart || sources[0].periodEnd !== row.fiscalDateEnding || sources[1].periodEnd >= row.fiscalDateEnding || /EPS|^eps$|Shares/.test(field) || sources[0].taxonomy!==sources[1].taxonomy || sources[0].concept!==sources[1].concept || sources[1].filingDate>sources[0].filingDate || (/\/A$/.test(sources[0].form) && sources[0].accessionNumber!==sources[1].accessionNumber) || row.periodType!=='quarterly' || row.periodStart!==new Date(Date.parse(sources[1].periodEnd)+DAY).toISOString().slice(0,10) || (Date.parse(row.fiscalDateEnding)-Date.parse(row.periodStart))/DAY+1<75 || (Date.parse(row.fiscalDateEnding)-Date.parse(row.periodStart))/DAY+1>119)) return false;
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
module.exports = { DATA_DIR, number, cik, day, monthsBefore, digest, selectAnnual, reportingStatus, validSource, verifiedField, classify, count, atomicWrite, validateFinancial, INCOMPATIBLE, DEBT_PARTS, presentedDebtFacts, presentedCapexFacts };
