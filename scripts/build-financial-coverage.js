#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const p=require('../backend/sec-coverage');
const {EXTRACTION_VERSION,VALIDATION_VERSION,MAPS}=require('../backend/sec-facts');
const requirements=require('../backend/financial-requirements').requirements;
function build({write=true}={}) {
 const directory=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8'));
 const reporting=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'sec-reporting.json'),'utf8'));
 const publicIndex=require('../backend/public-stock-index').load();
 let manifest=null;try{manifest=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'stock-universe-manifest.json'),'utf8'));}catch(_){}
 const grouped=new Map();for(const c of directory.companies.filter(c=>c.securityType==='stock')){const key=p.cik(c.cik) || 'listing:'+c.symbol;const group=grouped.get(key) || [];group.push(c);grouped.set(key,group);}
 const counts={stockListings:directory.companies.filter(c=>c.securityType==='stock').length,uniqueIssuers:[...grouped.keys()].filter(k=>!k.startsWith('listing:')).length,unresolvedStockListings:[...grouped.entries()].filter(([k])=>k.startsWith('listing:')).reduce((n,[,cs])=>n+cs.length,0),unresolvedSupplementalNeededListings:0,accessibleSecFilings:0,usableStructuredSecFinancials:0,coreAnnualFinancialIssuers:0,fiveAnnualCorePeriods:0,fourConsecutiveIncomeQuarters:0,relevantIndustryCoreFields:0,supplementalNeededIssuers:0,failedFilingChecks:0,failedFinancialChecks:0};
 const supplements=require('../backend/committed-supplements').readAll();
 const records=[],fieldCoverage={},industryCoverage={};
 for(const [key,companies]of grouped) {
  const e=reporting.issuers[key] || {};let data=null;
  try{const raw=fs.readFileSync(path.join(p.DATA_DIR,'sec-financials',key+'.json'),'utf8');if(p.digest(raw)!==e.financialDigest)throw new Error('DIGEST_MISMATCH');data=JSON.parse(raw);}catch(err){if(err.code!=='ENOENT' && e.financialDigest)throw err;}
  let overview={Sector:companies[0].sector};try{overview={...overview,...JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'fundamentals',companies[0].symbol.toLowerCase().replace(/[.-]/g,'_')+'.json'),'utf8')).overview};}catch(_){}
  const req=requirements(overview,e.sic),fields={},periods={annual:{},quarterly:{}};
  for(const [st,defs]of Object.entries(MAPS))for(const field of Object.keys(defs))for(const basis of ['annual','quarterly']) {
   const rows=data?.[st]?.[basis+'Reports'] || [];
   const ends=rows.filter(row=>p.verifiedField(data,row,field)).map(row=>row.fiscalDateEnding);
   (fields[field] ||= {})[basis]={state:ends.length?'available':rows.some(row=>row._states?.[field]==='conflicting_evidence')?'conflicting_evidence':'missing',periodCount:ends.length,latestPeriod:ends[0] || null};
   for(const end of ends)(periods[basis][end] ||= new Set()).add(field);
   if(ends.length){const k=field+':'+basis;fieldCoverage[k]=(fieldCoverage[k] || 0)+1;}
  }
  const industryFieldSeen=new Set();
  for(const f of data?.industryObservations || [])if(require('../backend/sec-industry-tables').validObservation(f,key)) {
   const basis=f.historyBasis || f.basis;if(!['annual','quarterly'].includes(basis))continue;
   (fields[f.field] ||= {annual:{state:'missing',periodCount:0,latestPeriod:null},quarterly:{state:'missing',periodCount:0,latestPeriod:null}})[basis]={state:'available',periodCount:(fields[f.field]?.[basis]?.periodCount || 0)+1,latestPeriod:[fields[f.field]?.[basis]?.latestPeriod,f.periodEnd].filter(Boolean).sort().pop()};
   (periods[basis][f.periodEnd] ||= new Set()).add(f.field);const metric=f.field+':'+basis;if(!industryFieldSeen.has(metric)){fieldCoverage[metric]=(fieldCoverage[metric] || 0)+1;industryFieldSeen.add(metric);}
  }
  const annualEnds=Object.keys(periods.annual).sort().reverse(),quarterEnds=Object.keys(periods.quarterly).sort().reverse();
  const corePeriods=annualEnds.filter(end=>{const rows=['income','balance','cash'].map(st=>data?.[st]?.annualReports.find(r=>r.fiscalDateEnding===end));return rows.every(Boolean) && new Set(rows.map(r=>r.reportedCurrency)).size===1 && req.core.every(f=>periods.annual[end].has(f));});
  const incomeQuarters=quarterEnds.filter(end=>['totalRevenue','netIncome'].every(f=>periods.quarterly[end].has(f))).slice(0,4);
  const quarterRows=incomeQuarters.map(end=>data?.income?.quarterlyReports.find(r=>r.fiscalDateEnding===end));
  const consecutive=incomeQuarters.length===4 && quarterRows.every(Boolean) && new Set(quarterRows.map(r=>r.reportedCurrency)).size===1 && ['totalRevenue','netIncome'].every(f=>new Set(quarterRows.map(r=>r._scopes?.[f])).size===1) && incomeQuarters.slice(1).every((end,i)=>{const days=(Date.parse(incomeQuarters[i])-Date.parse(end))/86400000;return days>=75 && days<=105;});
  const required=req.industry.map(field=>({field,...(fields[field]?.annual || {state:'missing',periodCount:0,latestPeriod:null}),reason:!fields[field]?'Original disclosure and a reviewed definition/context mapping are required':null}));
  const industryCore=required.filter(f=>Object.values(MAPS).some(defs=>defs[f.field]));const industryComplete=industryCore.length>0 && industryCore.every(f=>f.state==='available');
  const industry=industryCoverage[req.archetype] ||= {issuers:0,withCoreIndustryFields:0,fields:{}};if(p.cik(key))industry.issuers++;else industry.unresolvedListings=(industry.unresolvedListings || 0)+companies.length;if(industryComplete)industry.withCoreIndustryFields++;for(const f of required)if(f.state==='available')industry.fields[f.field]=(industry.fields[f.field] || 0)+1;
  const accessible=!!e.latestAnnual || !!e.latestPeriodic;const usable=!!data && Object.values(fields).some(f=>f.annual.state==='available' || f.quarterly.state==='available');
  if(accessible)counts.accessibleSecFilings++;if(usable)counts.usableStructuredSecFinancials++;
  if(corePeriods.includes(e.latestAnnual?.reportDate))counts.coreAnnualFinancialIssuers++;
  if(corePeriods.length>=5)counts.fiveAnnualCorePeriods++;if(consecutive)counts.fourConsecutiveIncomeQuarters++;if(industryComplete)counts.relevantIndustryCoreFields++;
  const gaps=[];if(!p.cik(key))gaps.push({state:'missing',reason:'SEC issuer identity unresolved'});
  if(!accessible)gaps.push({state:e.lastAttemptResult==='transient_failure'?'retrieval_failed':'missing',reason:'No accessible applicable filing identified'});
  for(const field of req.core)if(!fields[field]?.annual.periodCount)gaps.push({field,state:fields[field]?.annual.state || 'missing',reason:e.originalExtraction?.status==='retrieval_failed'?'Original filing retrieval failed':e.latestAnnual?'No compatible mapped disclosure':'Applicable financial filing unavailable'});
  if(!consecutive)gaps.push({state:'missing',reason:/^(20-F|40-F)$/.test(e.latestAnnual?.form || '')?'Issuer-specific interim cadence; quarterly disclosures require original or supplemental sources':'Four consecutive income quarters unavailable'});
  gaps.push(...required.filter(f=>f.state!=='available').map(f=>({field:f.field,state:'missing',reason:f.reason || 'No compatible industry disclosure extracted'})));
  if(gaps.length){if(p.cik(key))counts.supplementalNeededIssuers++;else counts.unresolvedSupplementalNeededListings+=companies.length;}
  if(e.lastAttemptResult==='transient_failure')counts.failedFilingChecks++;if(e.lastFinancialResult==='transient_failure')counts.failedFinancialChecks++;
  records.push({cik:p.cik(key),symbols:companies.map(c=>c.symbol),secTier:!accessible?'unavailable':usable?'structured_financials':'filings_only',classification:p.classify(e,data,publicIndex.asOf),reportingCadence:e.reportingCadence || (/^(20-F|40-F)$/.test(e.latestAnnual?.form || '')?'issuer_specific_interim':'quarterly'),latestAnnual:e.latestAnnual?.reportDate || null,latestInterim:e.latestPeriodic?.reportDate || null,lastSuccessfulCheckAt:e.lastSuccessfulCheckAt || null,lastAttemptResult:e.lastAttemptResult || 'unverified',financialAttemptResult:e.lastFinancialResult || 'unverified',financialFailureType:e.financialFailureType || (e.lastErrorCode?.startsWith('EXTRACTION_')?'unsupported_extraction':null),financialFailureReason:e.lastErrorCode || null,extractionVersion:data?.extractionVersion || null,validationVersion:data?.validationVersion || null,annualCorePeriods:corePeriods.length,fourConsecutiveIncomeQuarters:consecutive,fields:Object.fromEntries(Object.entries(fields).filter(([f])=>[...req.core,...req.industry].includes(f))),industry:{archetype:req.archetype,notApplicable:req.notApplicable,classificationSource:req.classificationSource,requirements:required,extraction:e.industryExtraction || data?.industryExtraction || null,segmentPeriods:data?.segmentObservations?.length || 0},gaps});
 }
 const output={schemaVersion:1,extractionVersion:EXTRACTION_VERSION,validationVersion:VALIDATION_VERSION,asOf:publicIndex.asOf,generatedAt:new Date().toISOString(),datasetId:publicIndex.datasetId,counts,denominators:{stockListings:'In-scope exchange listings, including distinct common share classes',issuerCounts:'Unique in-scope SEC CIKs; unresolved identities are separate listing records',accessibleSecFilings:'Identified applicable annual or interim filings in checked SEC submissions; original-document retrieval is reported separately',historicalIndustryFields:'Availability within retained history; field period dates and unsupported custom-disclosure gaps are listed separately',legacyCounts:'Legacy listedSecurities counts retained instrument records, including legacy units and rights',industryCoverage:'Relevant standard statement fields; separately listed custom-disclosure gaps are not counted as complete'},sourceBreakdown:{sec:counts.usableStructuredSecFinancials,committedProviderSupplemental:supplements.filter(r=>r.doc.observations.some(f=>f.sourceType==='provider')).length,committedIssuerRelease:supplements.filter(r=>r.doc.observations.some(f=>f.sourceType==='issuer_release')).length},fieldCoverage,industryCoverage,universe:manifest?{generatedAt:manifest.generatedAt,counts:manifest.counts,sources:manifest.sources,changes:manifest.changes}:null,records};
 if(write)p.atomicWrite(path.join(p.DATA_DIR,'financial-coverage.json'),output);return output;
}
if(require.main===module){try{const result=build();console.log(JSON.stringify({counts:result.counts,datasetId:result.datasetId},null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build};
