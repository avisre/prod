'use strict';
const p=require('./sec-coverage');
// Company Facts can stop returning a previously captured standard fact. Retain
// its original receipt only within the exact same annual filing version and
// compatible row; never carry an old or partial figure into a new filing.
function preserveSameFiling(incoming,previous,reporting) {
 if(!previous || p.cik(previous.cik)!==p.cik(incoming.cik))return incoming;
 const prior={...previous,reportingSic:reporting.sic || previous.reportingSic};
 const accessions=new Set([reporting.latestAnnual?.accessionNumber,...(reporting.latestAnnual?.amendments || []).map(a=>a.accessionNumber)].filter(Boolean));
 for(const st of ['income','balance','cash'])for(const row of incoming[st]?.annualReports || []) {
  if(row.fiscalDateEnding!==reporting.latestAnnual?.reportDate)continue;
  const old=prior[st]?.annualReports?.find(r=>r.fiscalDateEnding===row.fiscalDateEnding && r.periodStart===row.periodStart && r.reportedCurrency===row.reportedCurrency);
  if(!old)continue;
  for(const field of Object.keys(old._sources || {})){
   if(p.number(row[field])!==null || old._derivations?.[field] || row._states?.[field]==='conflicting_evidence' || !p.verifiedField(prior,old,field,accessions))continue;
   const refs=old._sources[field];if(!refs.every(id=>Object.values(incoming.sources).some(s=>s.accessionNumber===prior.sources[id].accessionNumber)))continue;
   for(const id of refs)incoming.sources[id]=prior.sources[id];row[field]=old[field];
   for(const map of ['_sources','_scopes','_signs'])if(old[map]?.[field]!==undefined)(row[map] ||= {})[field]=structuredClone(old[map][field]);
   (row._retained ||= {})[field]={method:'same_filing_last_good',reason:'Previously validated original observation from the same annual filing version; current aggregate omitted this field'};
  }
 }
 return incoming;
}
module.exports={preserveSameFiling};
