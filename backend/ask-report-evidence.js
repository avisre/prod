'use strict';
// Repeat filing metadata once per accession, preserving every source fact and
// canonical source id. The auditor expands this lossless representation.
const SHARED=['cik','form','filingDate','filingUrl','retrievedAt','extractionVersion','accessionNumber','taxonomy','linkage'];
const CONTEXT=['periodStart','periodEnd','currency','unit','scope'];
// Leave room for the correction directive and control messages appended after
// retrieval, in addition to the engine's existing 32 KiB reserve.
const CONTEXT_RESERVE_BYTES=36*1024;
function compact(result) {
 if(!result || typeof result!=='object')return result;
 if(result.reportEvidence?.encoding==='observation-context-ref-v1' || result.provenance?.encoding==='filing-metadata-ref-v1')return result;
 let out=result;
 if(result.provenance?.sources){
 const sources={},filings={},sourceContexts={},refs=new Map(),contextRefs=new Map();
 for(const [id,source]of Object.entries(result.provenance.sources)){
  const meta=Object.fromEntries(SHARED.filter(k=>source[k]!==undefined).map(k=>[k,source[k]]));
  const signature=JSON.stringify(meta);if(!refs.has(signature))refs.set(signature,'f'+refs.size);const key=refs.get(signature);
  filings[key]=meta;sources[id]={...source,filingRef:key};for(const k of SHARED)delete sources[id][k];
  const context=Object.fromEntries(CONTEXT.filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]));
  if(Object.keys(context).length){const signature=JSON.stringify(context);if(!contextRefs.has(signature))contextRefs.set(signature,'p'+contextRefs.size);const ref=contextRefs.get(signature);sourceContexts[ref]=context;sources[id].sourceContextRef=ref;for(const k of Object.keys(context))delete sources[id][k];}
 }
 out={...result,provenance:{...result.provenance,sources,filings,sourceContexts,encoding:'filing-metadata-ref-v1'}};
 }
 const contexts={},refs=new Map(),sourceIds=Object.keys(out.provenance?.sources || {}),aliases=Object.fromEntries(sourceIds.map((id,index)=>[id,'s'+index]));
 if(sourceIds.length)out={...out,provenance:{...out.provenance,sources:Object.fromEntries(sourceIds.map(id=>[aliases[id],out.provenance.sources[id]]))}};
 function visit(value){
  if(Array.isArray(value))return value.map(visit);
  if(!value || typeof value!=='object')return value;
  const copy=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='sourceIds'&&Array.isArray(item)?item.map(id=>aliases[id]||id):visit(item)]));
  if(Object.hasOwn(value,'value') && Array.isArray(value.sourceIds)){
   const meta=Object.fromEntries(CONTEXT.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
   if(Object.keys(meta).length){const signature=JSON.stringify(meta);if(!refs.has(signature))refs.set(signature,'c'+refs.size);const ref=refs.get(signature);contexts[ref]=meta;copy.reportContextRef=ref;for(const key of Object.keys(meta))delete copy[key];}
  }
  return copy;
 }
 out=visit(out);
 // Repeated calculation inputs remain exact; transmit their definitions once.
 const counts=new Map(),facts={},factRefs=new Map();
 function count(value){if(Array.isArray(value)){value.forEach(count);return;}if(!value || typeof value!=='object')return;
  if(Object.hasOwn(value,'value')&&Array.isArray(value.sourceIds)){const key=JSON.stringify(value);counts.set(key,(counts.get(key)||0)+1);}
  Object.values(value).forEach(count);
 }
 count(out);
 function dedup(value){if(Array.isArray(value))return value.map(dedup);if(!value || typeof value!=='object')return value;
  const key=JSON.stringify(value);
  if(Object.hasOwn(value,'value')&&Array.isArray(value.sourceIds)&&counts.get(key)>1){if(!factRefs.has(key)){const ref='v'+factRefs.size;factRefs.set(key,ref);facts[ref]=value;}return {factRef:factRefs.get(key)};}
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,dedup(item)]));
 }
 out=dedup(out);
 // Column names are shared across source rows, while every original property
 // (including explicit nulls) is restored before validation.
 if(out.provenance?.sources){
  const columns=[...new Set(Object.values(out.provenance.sources).flatMap(source=>Object.keys(source)))],nulls={};
  const sources=Object.fromEntries(Object.entries(out.provenance.sources).map(([id,source])=>{
   const explicitNulls=columns.flatMap((key,index)=>Object.hasOwn(source,key)&&source[key]===null?[index]:[]);if(explicitNulls.length)nulls[id]=explicitNulls;
   return [id,columns.map(key=>Object.hasOwn(source,key)?source[key]:null)];
  }));
  out={...out,provenance:{...out.provenance,sources,sourceColumns:columns,sourceNulls:nulls}};
 }
 return Object.keys(contexts).length||sourceIds.length?{...out,reportEvidence:{encoding:'observation-context-ref-v1',contexts,facts,sourceIds:Object.fromEntries(sourceIds.map(id=>[aliases[id],id]))}}:out;
}
function expand(result){
 if(result?.reportEvidence?.encoding==='observation-context-ref-v1'){
  const {reportEvidence,...payload}=result;
  function visit(value){if(Array.isArray(value))return value.map(visit);if(!value || typeof value!=='object')return value;
   if(value.factRef && reportEvidence.facts?.[value.factRef])return visit(reportEvidence.facts[value.factRef]);
   const contextRef=Object.hasOwn(reportEvidence.contexts,value.reportContextRef)?value.reportContextRef:null;const rest={...value};if(contextRef)delete rest.reportContextRef;const copy=Object.fromEntries(Object.entries(rest).map(([key,item])=>[key,key==='sourceIds'&&Array.isArray(item)?item.map(id=>reportEvidence.sourceIds?.[id]||id):visit(item)]));
   return contextRef?{...reportEvidence.contexts[contextRef],...copy}:copy;
  }
  result=visit(payload);
  if(result.provenance?.sources)result={...result,provenance:{...result.provenance,sources:Object.fromEntries(Object.entries(result.provenance.sources).map(([id,source])=>[reportEvidence.sourceIds?.[id]||id,source])),sourceNulls:Object.fromEntries(Object.entries(result.provenance.sourceNulls||{}).map(([id,indices])=>[reportEvidence.sourceIds?.[id]||id,indices]))}};
 }
 if(result?.provenance?.encoding!=='filing-metadata-ref-v1')return result;
 const {encoding,filings,sourceContexts,sources,sourceColumns,sourceNulls,...meta}=result.provenance;
 return {...result,provenance:{...meta,sources:Object.fromEntries(Object.entries(sources || {}).map(([id,source])=>{
  if(Array.isArray(source)&&sourceColumns)source=Object.fromEntries(sourceColumns.flatMap((key,index)=>source[index]!==null || sourceNulls?.[id]?.includes(index)?[[key,source[index]]]:[]));
  const {filingRef,sourceContextRef,...fact}=source;return [id,{...filings?.[filingRef],...sourceContexts?.[sourceContextRef],...fact}];
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
  :[...new Set([...(profile.metrics || []).slice(0,4),'netMarginPct',...(['semis-hardware','pharma-biotech'].includes(profile.archetype)?['rdIntensityPct']:[])])];
 return {fields,metrics};
}
function boundNarrative(result,maxBytes=8192){
 const slots=[];
 function collect(value){if(Array.isArray(value)){value.forEach(collect);return;}if(!value || typeof value!=='object')return;
  for(const [key,item]of Object.entries(value)){if(['text','context','description'].includes(key)&&typeof item==='string')slots.push({owner:value,key,text:item});else if(item&&typeof item==='object')collect(item);}
 }
 const out=structuredClone(result);collect(out);const total=slots.reduce((n,s)=>n+Buffer.byteLength(s.text),0);
 if(total<=maxBytes)return out;
 for(const slot of slots){const allocation=Math.floor(maxBytes*Buffer.byteLength(slot.text)/total);const bytes=Buffer.from(slot.text);let end=allocation;while(end>0 && (bytes[end]&0xc0)===0x80)end--;slot.owner[slot.key]=bytes.subarray(0,end).toString('utf8');}
 return {...out,contextNote:'Original-document excerpts shortened to fit the shared report context; all supplied financial observations and source references are retained.'};
}
function serialize(result,remaining){
 const evidence=require('./ask-evidence'),cap=Math.min(evidence.MAX_RESULT_BYTES,remaining);
 // The filing business context is the only source for the segment, product
 // and risk tables, so it keeps more of its text than other excerpts.
 let narrativeBytes=result?.sourceType==='sec_filing_context'?20480:8192,packed=compact(boundNarrative(result,narrativeBytes));
 // Only excerpts can shrink. Typed values, calculation inputs, filing
 // identities and source dates remain intact; if those cannot fit, the
 // existing context-limit error still reports that nothing was supplied.
 while(Buffer.byteLength(JSON.stringify(packed))>cap && narrativeBytes>0){
  narrativeBytes=Math.max(0,Math.min(Math.floor(narrativeBytes/2),narrativeBytes-(Buffer.byteLength(JSON.stringify(packed))-cap)-256));
  packed=compact(boundNarrative(result,narrativeBytes));
 }
 // The dossier is the densest part of the business context; when even the
 // empty excerpts leave it too large, drop its last sections, never all of it.
 if(Buffer.byteLength(JSON.stringify(packed))>cap && result?.dossier?.sections?.length>1){
  let trimmed=structuredClone(result);
  while(trimmed.dossier.sections.length>1 && Buffer.byteLength(JSON.stringify(packed))>cap){trimmed.dossier.sections.pop();packed=compact(boundNarrative(trimmed,narrativeBytes));}
 }
 return evidence.serializeResult(packed,remaining);
}
// What the model reads versus what the answer check needs are different things.
// A statement result carries a source record, period, unit and scope for every
// figure, the list of sources tried for every gap, and provider rows with their
// full audit trail — 17–26 KB each on the live data path, six of them per
// report. Measured on Visa (2026-10-06): those six used 116 KB of the 160 KB
// budget, so segments, business text and filing changes were rejected as "over
// budget" and the answer listed them as gaps. The model only ever reads the
// values, the periods and the table, so that is all it is sent; the full
// record stays with the engine, where the audit resolves every claim.
const SUPPLEMENT_KEYS=['field','value','currency','unit','periodEnd','basis','accountingBasis','sourceName','sourceUrl','publicationDate','sourceDataDate'];
const scalars=o=>Object.fromEntries(Object.entries(o || {}).filter(([,v])=>v!==undefined && (v===null || typeof v!=='object')));
const supplements=list=>(Array.isArray(list)?list:[]).filter(f=>f && f.state==='available').map(f=>Object.fromEntries(SUPPLEMENT_KEYS.filter(k=>f[k]!==undefined && f[k]!==null).map(k=>[k,f[k]])));
function coverageView(c){
 if(!c || typeof c!=='object')return undefined;
 const gaps=[...new Map((Array.isArray(c.remainingGaps)?c.remainingGaps:[]).map(g=>[[g.field,g.basis].join('|'),{field:g.field,basis:g.basis,reason:g.reason || g.state}])).values()].slice(0,10);
 return {financialCoverage:c.financialCoverage,perShareAllowed:c.perShareAllowed,
  ...(c.latestAnnual?{latestAnnual:{form:c.latestAnnual.form,filingDate:c.latestAnnual.filingDate,reportDate:c.latestAnnual.reportDate}}:{}),
  ...(c.missingReason?{missingReason:c.missingReason}:{}),...(gaps.length?{remainingGaps:gaps}:{})};
}
function comparisonView(c){
 if(!c || typeof c!=='object')return c;
 const side=s=>s && typeof s==='object'?{periodEnd:s.periodEnd,...(s.missingReason?{missingReason:s.missingReason}:{}),
  changePct:Object.fromEntries(Object.entries(s.metrics || {}).filter(([,m])=>m && m.changePct!==null && m.changePct!==undefined).map(([k,m])=>[k,Number(Number(m.changePct).toFixed(2))]))}:undefined;
 return {periodEnd:c.periodEnd,...(c.yoy?{yoy:side(c.yoy)}:{}),...(c.qoq?{qoq:side(c.qoq)}:{})};
}
function modelView(tool,full){
 if(!full || typeof full!=='object')return full;
 // A statement with no filed history still arrives with a full provider trail
 // and gap log (Exxon's annual statements: 22–36 KB each with no observations).
 if((tool==='get_financials' || tool==='get_ratios_history') && !Array.isArray(full.observations)){
  const {provenance,freshness,coverage,reportEvidence,sourceAttempts,verifiedObservations,...rest}=full;
  return {...rest,...(coverage?{coverage:coverageView(coverage)}:{}),
   ...(Array.isArray(full.supplementalObservations)?{supplementalObservations:supplements(full.supplementalObservations)}:{})};
 }
 if(full.error)return full;
 if(tool==='get_financials' && Array.isArray(full.observations)){
  const {provenance,freshness,coverage,reportEvidence,latestPeriodAgeDays,...rest}=full;
  return {...rest,coverage:coverageView(coverage),
   observations:full.observations.map(o=>({periodEnd:o.periodEnd,periodStart:o.periodStart,currency:o.currency,
    fields:Object.fromEntries(Object.entries(o.fields || {}).map(([k,f])=>[k,f && typeof f==='object'?f.value ?? null:f]))})),
   comparisons:comparisonView(full.comparisons),
   calculations:(full.calculations || []).filter(c=>c && c.value!==null && c.value!==undefined).map(scalars),
   capitalReturns:(full.capitalReturns || []).filter(c=>c && (c.totalDistributions!==null && c.totalDistributions!==undefined || c.freeCashflow!==null && c.freeCashflow!==undefined)).map(scalars),
   supplementalObservations:supplements(full.supplementalObservations),
   industryObservations:(full.industryObservations || []).map(scalars)};
 }
 if(tool==='get_ratios_history' && Array.isArray(full.observations)){
  const {provenance,coverage,reportEvidence,...rest}=full;
  return {...rest,coverage:coverageView(coverage),
   observations:full.observations.map(o=>({periodEnd:o.periodEnd,currency:o.currency,
    metrics:Object.fromEntries(Object.entries(o.metrics || {}).map(([k,m])=>[k,m && typeof m==='object'?m.value ?? null:m]))}))};
 }
 if(tool==='get_quote'){
  const {coverage,provenance,epsObservation,marketObservations,reportEvidence,...rest}=full;
  return {...rest,coverage:coverageView(coverage)};
 }
 if(tool==='get_segments'){
  const {storedSegmentsReceipt,financialWitness,observations,provenance,reportEvidence,...rest}=full;
  return rest;
 }
 if(tool==='get_supplemental_context'){
  const {provenance,reportEvidence,coverage,sourceAttempts,...rest}=full;
  return {...rest,...(coverage?{coverage:coverageView(coverage)}:{}),
   ...(Array.isArray(full.supplementalObservations)?{supplementalObservations:supplements(full.supplementalObservations)}:{}),
   ...(Array.isArray(full.remainingGaps)?{remainingGaps:full.remainingGaps.map(g=>({field:g.field,section:g.section,basis:g.basis,reason:g.reason || g.state})).slice(0,10)}:{})};
 }
 return full;
}
// content is what the model is sent; supplied is what the engine checks claims
// against. For the tools with a lean view that is the full record; for the
// rest it is exactly what was sent, as before.
// report: a company report shares one budget across eleven pulls, so its
// excerpts are shortened to fit; a focused question keeps a page it fetched whole.
function forModel(tool,result,remaining,{report=true}={}){
 const full=expand(result),view=modelView(tool,full),lean=view!==full;
 const content=lean || !report?require('./ask-evidence').serializeResult(lean?view:result,remaining):serialize(result,remaining);
 const parsed=JSON.parse(content);
 if(parsed && parsed.code==='TOOL_CONTEXT_LIMIT')return {content,supplied:parsed};
 return {content,supplied:lean?full:expand(parsed)};
}
module.exports={compact,expand,defaults,boundNarrative,serialize,modelView,forModel,CONTEXT_RESERVE_BYTES};
