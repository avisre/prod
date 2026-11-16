'use strict';
const p=require('./sec-coverage');
// Company Facts can stop returning a previously captured standard fact. Retain
// its original receipt only within the exact same annual filing version and
// compatible row; never carry an old or partial figure into a new filing.
function preserveSameFiling(incoming,previous,reporting) {
 if(!previous || p.cik(previous.cik)!==p.cik(incoming.cik))return incoming;
 const prior={...previous,reportingSic:reporting.sic || previous.reportingSic};
 const accessions=new Set([reporting.latestAnnual?.accessionNumber,...(reporting.latestAnnual?.amendments || []).map(a=>a.accessionNumber)].filter(Boolean));
 const current={...incoming,reportingSic:prior.reportingSic};
 for(const st of ['income','balance','cash'])for(const row of incoming[st]?.annualReports || []) {
  if(row.fiscalDateEnding!==reporting.latestAnnual?.reportDate)continue;
  const old=prior[st]?.annualReports?.find(r=>r.fiscalDateEnding===row.fiscalDateEnding && r.periodStart===row.periodStart && r.reportedCurrency===row.reportedCurrency);
  if(!old)continue;
  for(const field of Object.keys(old._sources || {})){
   // A later report's comparative column can carry the year-end under another concept and value (Zoetis's Q3 2026
   // 10-Q: cash $2,450M beside the 10-K's $2,312M; Lumentum's: receivables 0 beside $520M). The annual row is the
   // annual report's own figure. Before this, the guard in refresh-sec-coverage refused the whole update and the
   // company's new quarter never arrived (16 issuers on 2026-11-14).
   const replaced=p.number(row[field])!==null;
   if(replaced && (row[field]===old[field] || p.verifiedField(current,row,field,accessions)))continue;
   // A replaced sum returns only when every part is still on the row, unchanged and from the same filing: then it is the
   // same sum (Legacy Education, Upexi, KLX Energy: short-term debt = borrowings + current long-term debt, replaced by one
   // part). A sum that is simply absent stays absent: the extractor may have refused it (PRESENTED_TOTAL_REFUSED).
   const derived=old._derivations?.[field];
   if(derived && !(replaced && Array.isArray(derived.inputs) && derived.inputs.length && derived.inputs.every(f=>p.number(row[f])!==null && row[f]===old[f] && p.verifiedField(current,row,f,accessions))))continue;
   if(row._states?.[field]==='conflicting_evidence' || !p.verifiedField(prior,old,field,accessions))continue;
   // The extractor turned this figure down (a part of the line, sec-facts.js REJECTED_PART); it is not an omission.
   if((incoming.issues || []).some(i=>i.code==='REJECTED_PART' && i.statement===st && i.basis==='annual' && i.field===field && i.periodEnd===row.fiscalDateEnding))continue;
   const refs=old._sources[field];if(!derived && !refs.every(id=>Object.values(incoming.sources).some(s=>s.accessionNumber===prior.sources[id].accessionNumber)))continue;
   const MAPS=['_sources','_scopes','_signs','_derivations','_states'],saved={value:row[field],maps:MAPS.map(m=>row[m]?.[field])};
   for(const map of MAPS)if(row[map])delete row[map][field];
   row[field]=old[field];
   if(derived){
    // Cite the parts as they are on the row now, as sec-facts would have.
    (row._sources ||= {})[field]=derived.inputs.flatMap(f=>row._sources[f]);
    if(row._scopes?.[derived.inputs[0]]!==undefined)row._scopes[field]=row._scopes[derived.inputs[0]];
    (row._derivations ||= {})[field]={...structuredClone(derived),inputValues:derived.inputs.map(f=>row[f])};
   }else{
    for(const id of refs)incoming.sources[id]=prior.sources[id];
    for(const map of ['_sources','_scopes','_signs'])if(old[map]?.[field]!==undefined)(row[map] ||= {})[field]=structuredClone(old[map][field]);
   }
   // Never keep a figure the verifier refuses: put back what the extraction produced.
   if(!p.verifiedField(current,row,field,accessions)){
    row[field]=saved.value;
    MAPS.forEach((m,i)=>{if(saved.maps[i]!==undefined)(row[m] ||= {})[field]=saved.maps[i];else if(row[m])delete row[m][field];});
    continue;
   }
   (row._retained ||= {})[field]={method:'same_filing_last_good',reason:replaced?'Previously validated original observation from the same annual filing version; a later report\'s comparative carried another figure':'Previously validated original observation from the same annual filing version; current aggregate omitted this field'};
  }
 }
 return incoming;
}
module.exports={preserveSameFiling};
