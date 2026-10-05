'use strict';
const p=require('./sec-coverage'),{extract}=require('./sec-facts'),original=require('./sec-original');
const VERSION='20261005-industry2';
function enrich(financial,document,reporting,{asOf=p.day(new Date().toISOString())}={}) {
 const facts=original.mergeFacts({cik:Number(financial.cik),facts:{}},document);
 const incoming=extract(facts,{...reporting,reportingCurrency:document.reportingCurrency || reporting.reportingCurrency},{asOf});
 const out=structuredClone(financial);out.sources={...out.sources,...incoming.sources};
 for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports'])for(const row of incoming[st][basis]) {
  const old=out[st][basis].find(r=>r.fiscalDateEnding===row.fiscalDateEnding);
  if(!old || old.reportedCurrency!==row.reportedCurrency || old.periodStart!==row.periodStart)continue;
  const oldVersions=new Set(Object.values(old._sources).flat().map(id=>out.sources[id]?.accessionNumber));
  for(const field of Object.keys(row._sources)) {
   if(p.verifiedField(out,old,field) || !row._sources[field].every(id=>oldVersions.has(incoming.sources[id].accessionNumber)))continue;
   old[field]=row[field];for(const map of ['_sources','_derivations','_scopes','_signs'])if(row[map]?.[field]!==undefined)old[map][field]=row[map][field];
  }
 }
 out.industryObservations=incoming.industryObservations || out.industryObservations || [];
 const segments=require('./sec-segment-observations'),groups=segments.extract(document.segments,out,document.originalDocument);
 out.segmentObservations=groups.filter(g=>{if(segments.validGroup(g,out))return true;out.issues.push({code:'UNSUPPORTED_SEGMENT_PROVENANCE',periodEnd:g.periodEnd,reason:'The original segment context or numerical receipt did not pass validation'});return false;});
 out.industryExtraction={version:VERSION,sourceVersion:document.originalDocument.accessionNumber,sourceUrl:document.originalDocument.url,checkedAt:new Date().toISOString(),status:'success',remainingReason:'Only standard mapped concepts and reviewed issuer tables are eligible; unsupported custom disclosures remain explicit gaps'};
 const errors=p.validateFinancial(out,out.cik,asOf);if(errors.length)throw new Error('INVALID_INDUSTRY_EXTRACTION: '+errors[0]);
 return out;
}
module.exports={enrich,VERSION};
