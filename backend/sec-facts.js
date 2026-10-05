'use strict';
// Deterministic extraction. No network, provider data, split guesses, or FX.
const p = require('./sec-coverage');
const DAY = 86400000;
const EXTRACTION_VERSION = '20261005-core2';
const VALIDATION_VERSION = '20261005-validation3';
function partialRevenueConcept(sic, concept) { return /^(602|603|609|63)/.test(String(sic || '')) && /RevenueFromContract|SalesRevenue/.test(concept || ''); }
const mapping = (gaap, ifrs = [], scope = 'entity') => ({ 'us-gaap': gaap, 'ifrs-full': ifrs, scope });
const MAPS = {
 income: {
  totalRevenue:mapping(['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet','RevenueFromContractWithCustomerIncludingAssessedTax','RevenueNetOfInterestExpense'],['RevenueFromContractsWithCustomers','Revenue']),
  netIncome:mapping(['NetIncomeLoss','ProfitLoss'],['ProfitLossAttributableToOwnersOfParent','ProfitLoss']),
  operatingIncome:mapping(['OperatingIncomeLoss'],['ProfitLossFromOperatingActivities']),
  grossProfit:mapping(['GrossProfit'],['GrossProfit']),
  costOfRevenue:mapping(['CostOfRevenue','CostOfGoodsAndServicesSold','CostOfGoodsSold'],['CostOfSales']),
  sellingGeneralAndAdministrative:mapping(['SellingGeneralAndAdministrativeExpense'],[]),
  researchAndDevelopment:mapping(['ResearchAndDevelopmentExpense'],['ResearchAndDevelopmentExpense']),
  operatingExpenses:mapping(['OperatingExpenses'],[]),
  interestExpense:mapping(['InterestExpense'],[]),
  premiums:mapping(['PremiumsEarnedNet'],['InsuranceRevenue']),
  investmentIncome:mapping(['InvestmentIncomeNet'],[]),
  interestIncome:mapping(['InvestmentIncomeInterest','InterestIncomeOperating'],['InterestIncome']),
  netInterestIncome:mapping(['InterestIncomeExpenseNet'],[]),
  nonInterestIncome:mapping(['NoninterestIncome'],[]),
  incomeTaxExpense:mapping(['IncomeTaxExpenseBenefit'],['IncomeTaxExpenseContinuingOperations']),
  incomeBeforeTax:mapping(['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],['ProfitLossBeforeTax']),
  eps:mapping(['EarningsPerShareBasic'],['BasicEarningsLossPerShare'],'parent'),
  weightedAverageSharesOutstanding:mapping(['WeightedAverageNumberOfSharesOutstandingBasic'],['WeightedAverageNumberOfSharesOutstandingBasic'],'parent'),
  weightedAverageSharesDiluted:mapping(['WeightedAverageNumberOfDilutedSharesOutstanding'],['AdjustedWeightedAverageShares'],'parent'),
  dilutedEPS:mapping(['EarningsPerShareDiluted'],['DilutedEarningsLossPerShare'],'parent')
 },
 balance: {
  totalAssets:mapping(['Assets'],['Assets']),
  totalShareholderEquity:mapping(['StockholdersEquity','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],['EquityAttributableToOwnersOfParent','Equity']),
  totalLiabilities:mapping(['Liabilities'],['Liabilities']),
  totalCurrentAssets:mapping(['AssetsCurrent'],['CurrentAssets']),
  totalCurrentLiabilities:mapping(['LiabilitiesCurrent'],['CurrentLiabilities']),
  cashAndCashEquivalentsAtCarryingValue:mapping(['CashAndCashEquivalentsAtCarryingValue'],['CashAndCashEquivalents']),
  loans:mapping(['FinancingReceivableRecordedInvestmentExcludingAccruedInterestAfterAllowanceForCreditLoss'],[]),
  deposits:mapping(['Deposits'],[]),
  inventory:mapping(['InventoryNet'],['Inventories']),
  currentNetReceivables:mapping(['AccountsReceivableNetCurrent'],['TradeAndOtherCurrentReceivables']),
  goodwill:mapping(['Goodwill'],['Goodwill']),
  longTermDebt:mapping(['LongTermDebtNoncurrent'],['NoncurrentBorrowings']),
  shortTermDebt:mapping(['DebtCurrent'],['CurrentBorrowings']),
  shortTermBorrowings:mapping(['ShortTermBorrowings'],[]),
  currentLongTermDebt:mapping(['LongTermDebtCurrent'],['CurrentPortionOfLongtermBorrowings','CurrentPortionOfNoncurrentBorrowings']),
  shortLongTermDebtTotal:mapping(['DebtLongtermAndShorttermCombinedAmount','LongTermDebtAndShortTermBorrowings'],['Borrowings']),
  commonStockSharesOutstanding:mapping(['CommonStockSharesOutstanding'],[]),
  retainedEarnings:mapping(['RetainedEarningsAccumulatedDeficit'],['RetainedEarnings'])
 },
 cash: {
  operatingCashflow:mapping(['NetCashProvidedByUsedInOperatingActivities'],['CashFlowsFromUsedInOperatingActivities']),
  capitalExpenditures:mapping(['PaymentsToAcquirePropertyPlantAndEquipment'],['PurchaseOfPropertyPlantAndEquipment']),
  cashflowFromInvestment:mapping(['NetCashProvidedByUsedInInvestingActivities'],['CashFlowsFromUsedInInvestingActivities']),
  cashflowFromFinancing:mapping(['NetCashProvidedByUsedInFinancingActivities'],['CashFlowsFromUsedInFinancingActivities']),
  dividendPayout:mapping(['PaymentsOfDividends'],['DividendsPaid']),
  dividendPayoutCommonStock:mapping(['PaymentsOfDividendsCommonStock'],[]),
  paymentsForRepurchaseOfCommonStock:mapping(['PaymentsForRepurchaseOfCommonStock'],[]),
  shareBasedCompensation:mapping(['ShareBasedCompensation'],[]),
  depreciationDepletionAndAmortization:mapping(['DepreciationDepletionAndAmortization'],[])
 }
};
const OUTFLOWS = new Set(['capitalExpenditures','dividendPayout','dividendPayoutCommonStock','paymentsForRepurchaseOfCommonStock']);
const FORM = /^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/;
function scope(concept, fallback) {
 if (['NetIncomeLoss','StockholdersEquity','ProfitLossAttributableToOwnersOfParent','EquityAttributableToOwnersOfParent'].includes(concept)) return 'parent';
 if (['ProfitLoss','StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest','Equity'].includes(concept)) return 'consolidated';
 return fallback;
}
function extract(document, evidence, {asOf = p.day(new Date().toISOString())} = {}) {
 const issuer = p.cik(document?.cik);
 if (!issuer || issuer !== p.cik(evidence?.cik) || !document.facts || typeof document.facts !== 'object') throw new Error('SEC_IDENTITY_MISMATCH');
 const out = {schemaVersion:1,extractionVersion:EXTRACTION_VERSION,reportingSic:String(evidence.sic || ''),validationVersion:VALIDATION_VERSION,cik:issuer,issuerName:document.entityName || evidence.issuerName || '',fetchedAt:new Date().toISOString(),factsDigest:p.digest(document),income:{annualReports:[],quarterlyReports:[]},balance:{annualReports:[],quarterlyReports:[]},cash:{annualReports:[],quarterlyReports:[]},sources:{},issues:[]};
 const rows = [];
 const wanted = new Map();
 for(const fields of Object.values(MAPS)) for(const def of Object.values(fields)) for(const taxonomy of ['us-gaap','ifrs-full']) for(const concept of def[taxonomy]) wanted.set(taxonomy + ':' + concept,true);
 for(const [taxonomy, concepts] of Object.entries(document.facts)) for(const [concept, def] of Object.entries(concepts)) {
  if(!wanted.has(taxonomy + ':' + concept)) continue;
  for(const [unit, facts] of Object.entries(def.units || {})) for(const f of facts) {
   const end=p.day(f.end),start=f.start?p.day(f.start):null,filed=p.day(f.filed),val=p.number(f.val);
   if(val===null || !end || !filed || end>asOf || filed>asOf || !FORM.test(f.form || '') || !/^\d{10}-\d{2}-\d{6}$/.test(f.accn || '') || (f.start && !start)) continue;
   const days=start?(Date.parse(end)-Date.parse(start))/DAY+1:null;
   if(days !== null && days <= 0) continue;
   rows.push({taxonomy,concept,unit,val,start,end,days,filed,form:f.form,accn:f.accn,original:f._original || null});
  }
 }
 const byConceptUnit=new Map(),byEnd=new Map(),sourceCache=new Map();
 for(const row of rows){const key=row.taxonomy+':'+row.concept+'|'+row.unit;const concept=byConceptUnit.get(key) || [];concept.push(row);byConceptUnit.set(key,concept);const ending=byEnd.get(row.end) || [];ending.push(row);byEnd.set(row.end,ending);}
 const a=evidence.latestAnnual;
 const annualAccessions=new Set(a?[a.accessionNumber,...(a.amendments || []).map(x=>x.accessionNumber)]:[]);
 const annualEnds=new Set(rows.filter(r=>r.days>=340 && r.days<=380 && /^(10-K|20-F|40-F)(\/A)?$/.test(r.form)).map(r=>r.end));
 if(a) annualEnds.add(a.reportDate);
 const quarterEnds=new Set(rows.filter(r=>r.days>=75 && r.days<=105).map(r=>r.end));
 for(const end of annualEnds) quarterEnds.add(end);
 function currency(end, annual) {
  const restrict = annual && a?.reportDate===end;
  const sets=[];
  for(const [st,field] of [['income','netIncome'],['income','totalRevenue'],['balance','totalAssets'],['balance','totalShareholderEquity'],['cash','operatingCashflow']]) {
   const def=MAPS[st][field];
   const found=new Set((byEnd.get(end) || []).filter(r=>r.end===end && /^[A-Z]{3}$/.test(r.unit) && def[r.taxonomy]?.includes(r.concept) && (!restrict || annualAccessions.has(r.accn)) && (st==='balance'?r.days===null:annual?r.days>=340&&r.days<=380:r.days!==null&&r.days<=380)).map(r=>r.unit));
   if(found.size) sets.push(found);
  }
  const possible=sets.length?[...sets[0]].filter(u=>sets.every(s=>s.has(u))):[];
  // Reporting-currency facts are strings and intentionally kept outside numeric rows.
  const declared=new Set();
  if(/^[A-Z]{3}$/.test(evidence.reportingCurrency || ''))declared.add(evidence.reportingCurrency);
  for(const concept of ['EntityReportingCurrencyISOCode','EntityReportingCurrency']) for(const facts of Object.values(document.facts.dei?.[concept]?.units || {})) for(const f of facts) if(annualAccessions.has(f.accn) && /^[A-Z]{3}$/.test(String(f.val))) declared.add(f.val);
  if(declared.size===1 && possible.includes([...declared][0])) return [...declared][0];
  if(possible.length===1) return possible[0];
  out.issues.push({code:'AMBIGUOUS_CURRENCY',periodEnd:end,currencies:possible});return null;
 }
 function select(candidates, key) {
  if(!candidates.length)return null;
  candidates.sort((x,y)=>y.filed.localeCompare(x.filed)||y.accn.localeCompare(x.accn));
  const first=candidates[0];
  const same=candidates.filter(r=>r.accn===first.accn && r.start===first.start && r.end===first.end);
  if(new Set(same.map(r=>r.val)).size>1){out.issues.push({code:'AMBIGUOUS_FACT',field:key,accession:first.accn,periodEnd:first.end});return {ambiguous:true};}
  return first;
 }
 function source(f) {
  if(sourceCache.has(f))return sourceCache.get(f);
  const s={type:'sec_xbrl_fact',cik:issuer,taxonomy:f.taxonomy,concept:f.concept,unit:f.unit,rawValue:f.val,periodStart:f.start,periodEnd:f.end,form:f.form,filingDate:f.filed,accessionNumber:f.accn,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(issuer)}/${f.accn.replace(/-/g,'')}/${f.accn}-index.htm`,linkage:'xbrl_fact',...(f.original?{originalDocument:f.original,verificationMethod:'original_inline_xbrl'}:{verificationMethod:'company_facts'}),accountingBasis:f.taxonomy==='ifrs-full'?'IFRS':'US GAAP',scope:scope(f.concept,'entity'),retrievedAt:out.fetchedAt,extractionVersion:EXTRACTION_VERSION};
  const id=p.digest({...s,retrievedAt:null}).slice(0,24);out.sources[id]=s;sourceCache.set(f,id);return id;
 }
 function resolve(st,field,end,cur,basis) {
  const def=MAPS[st][field],unit=/(?:EPS|^eps$)/.test(field)?cur+'/shares':/Shares/.test(field)?'shares':cur;
  const restrict=basis==='annual' && a?.reportDate===end;
  for(const taxonomy of ['us-gaap','ifrs-full']) for(const concept of def[taxonomy]) {
   if(field==='totalRevenue' && partialRevenueConcept(out.reportingSic,concept))continue;
   const all=(byConceptUnit.get(taxonomy+':'+concept+'|'+unit) || []).filter(r=>!restrict || annualAccessions.has(r.accn));
   const candidates=all.filter(r=>r.end===end && (st==='balance'?r.days===null:basis==='annual'?r.days>=340&&r.days<=380 && /^(10-K|20-F|40-F)(\/A)?$/.test(r.form):r.days>=75&&r.days<=105));
   const selected=select(candidates,field);
   if(selected?.ambiguous)return null;
   if(selected)return {value:selected.val,refs:[source(selected)],start:selected.start,scope:scope(concept,def.scope)};
   if(basis==='quarterly' && st!=='balance' && unit===cur) {
    const ytd=select(all.filter(r=>r.end===end && r.days>=160 && r.days<=380),field);
    if(ytd?.ambiguous)return null;
    if(ytd) {
     const prev=select(all.filter(r=>r.start===ytd.start && r.end<end && r.days>=ytd.days-105 && r.days<=ytd.days-75 && r.filed<=ytd.filed && (!/\/A$/.test(ytd.form) || r.accn===ytd.accn)),field);
     if(prev?.ambiguous)return null;
     if(prev){const start=new Date(Date.parse(prev.end)+DAY).toISOString().slice(0,10);return {value:ytd.val-prev.val,refs:[source(ytd),source(prev)],start,scope:scope(concept,def.scope),derivation:{formula:'ytd_difference',inputValues:[ytd.val,prev.val]}};}
    }
   }
  }
  return null;
 }
 for(const basis of ['annual','quarterly']) for(const end of [...(basis==='annual'?annualEnds:quarterEnds)].filter(p.day).sort().reverse().slice(0,basis==='annual'?25:48)) {
  const cur=currency(end,basis==='annual');if(!cur)continue;
  for(const st of ['income','balance','cash']) {
   const row={fiscalDateEnding:end,periodStart:null,reportedCurrency:cur,periodType:st==='balance'?'instant':basis,_sources:{},_derivations:{},_scopes:{},_signs:{}};
   for(const field of Object.keys(MAPS[st])) {
    const found=resolve(st,field,end,cur,basis);row[field]=null;if(!found)continue;
    const negate=OUTFLOWS.has(field);
    row[field]=negate?-Math.abs(found.value):found.value;
    row._sources[field]=found.refs;row._scopes[field]=found.scope;
    if(negate)row._signs[field]=-1;
    if(found.derivation)row._derivations[field]=found.derivation;
    if(found.start && !row.periodStart)row.periodStart=found.start;
   }
   function combine(field, left, right, operation) {
    if(row[field]!==null || row[left]===null || row[right]===null || !p.verifiedField(out,row,left) || !p.verifiedField(out,row,right))return;
    const refs=[...row._sources[left],...row._sources[right]];
    const scopes=[row._scopes[left],row._scopes[right]];
    if(scopes[0]!==scopes[1])return;
    const versions=field=>[...new Set(row._sources[field].map(id=>out.sources[id].accessionNumber))].sort().join('|');
    if(versions(left)!==versions(right))return;
    row[field]=operation==='sum_fields'?row[left]+row[right]:row[left]-row[right];
    row._sources[field]=refs;row._scopes[field]=scopes[0];row._derivations[field]={formula:operation,inputs:[left,right],inputValues:[row[left],row[right]]};
   }
   if(st==='income') {
    // Bank net revenue is a monetary flow, not gross interest income.
    if(/^(602|603|609)/.test(String(evidence.sic || '')))combine('totalRevenue','netInterestIncome','nonInterestIncome','sum_fields');
    if(!/^(602|603|609|63)/.test(out.reportingSic))combine('grossProfit','totalRevenue','costOfRevenue','difference_fields');
   }
   if(st==='balance') {
    combine('shortTermDebt','shortTermBorrowings','currentLongTermDebt','sum_fields');
    combine('shortLongTermDebtTotal','shortTermDebt','longTermDebt','sum_fields');
   }
   for(const field of Object.keys(row._sources))if(!p.verifiedField(out,row,field)){row[field]=null;delete row._sources[field];delete row._derivations[field];out.issues.push({code:'INCOMPATIBLE_PERIOD',field,periodEnd:end});}
   if(Object.keys(row._sources).length)out[st][basis+'Reports'].push(row);
  }
 }
 if(document.segmentFacts?.length){const segments=require('./sec-segment-observations'),groups=segments.extract(document.segmentFacts,out,document.industryFiling);out.segmentObservations=groups.filter(g=>{if(segments.validGroup(g,out))return true;out.issues.push({code:'UNSUPPORTED_SEGMENT_PROVENANCE',periodEnd:g.periodEnd,reason:'The original segment context or numerical receipt did not pass validation'});return false;});}
 if(document.industryTables?.length)out.industryObservations=require('./sec-industry-tables').extractTables(document.industryTables,document.industryFiling,issuer,out);
 return out;
}
module.exports={extract,MAPS,OUTFLOWS,EXTRACTION_VERSION,VALIDATION_VERSION,partialRevenueConcept,scope};
