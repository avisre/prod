'use strict';
// Repeat filing metadata once per accession, preserving every source fact and
// canonical source id. The auditor expands this lossless representation.
const SHARED=['cik','form','filingDate','filingUrl','retrievedAt','extractionVersion'];
function compact(result) {
 if(!result?.provenance?.sources)return result;
 const sources={},filings={};
 for(const [id,source]of Object.entries(result.provenance.sources)){
  const meta=Object.fromEntries(SHARED.filter(k=>source[k]!==undefined).map(k=>[k,source[k]]));
  const key=require('./sec-coverage').digest(meta).slice(0,16);
  filings[key]=meta;sources[id]={...source,filingRef:key};for(const k of SHARED)delete sources[id][k];
 }
 return {...result,provenance:{...result.provenance,sources,filings,encoding:'filing-metadata-ref-v1'}};
}
function expand(result){
 if(result?.provenance?.encoding!=='filing-metadata-ref-v1')return result;
 const {encoding,filings,sources,...meta}=result.provenance;
 return {...result,provenance:{...meta,sources:Object.fromEntries(Object.entries(sources || {}).map(([id,source])=>{
  const {filingRef,...fact}=source;return [id,{...filings?.[filingRef],...fact}];
 }))}};
}
function defaults(symbol,statement,basis){
 const company=require('./stock-universe').lookup(symbol),raw=require('./fundamentals-cache').loadRawFundamentals(symbol)?.overview || {};
 const profile=require('./ask-industry-profile').profile(raw.Industry,raw.Sector || company?.sector);
 const bank=profile.archetype==='bank', financial=['bank','insurer','capital-markets'].includes(profile.archetype);
 const fields=statement==='income'?['totalRevenue','netIncome',...(bank?['netInterestIncome','nonInterestIncome']:['grossProfit','operatingIncome','researchAndDevelopment'])]
  :statement==='balance'?['totalAssets','totalShareholderEquity','shortLongTermDebtTotal','longTermDebt','shortTermDebt','cashAndCashEquivalentsAtCarryingValue']
  :['operatingCashflow','capitalExpenditures','shareBasedCompensation','dividendPayout','paymentsForRepurchaseOfCommonStock'];
 const metrics=basis==='quarterly'?(financial?['netMarginPct']:['grossMarginPct','opMarginPct','netMarginPct','rdIntensityPct'])
  :[...new Set([...(profile.metrics || []).slice(0,4),'netMarginPct',...(['semiconductor','pharma'].includes(profile.archetype)?['rdIntensityPct']:[])])];
 return {fields,metrics};
}
module.exports={compact,expand,defaults};
