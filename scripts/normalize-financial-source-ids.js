#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),p=require('../backend/sec-coverage');
function normalize(data) {
 const ids=new Map(),sources={};for(const [old,source]of Object.entries(data.sources || {})){const id=p.digest({...source,retrievedAt:null}).slice(0,24);ids.set(old,id);sources[id]=source;}
 function replace(value) {
  if(Array.isArray(value))return value.map(replace);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));
  return typeof value==='string' && ids.has(value)?ids.get(value):value;
 }
 const result=replace(data);result.sources=sources;return result;
}
function sanitize(data) {
 const metadata=new Set(['fiscalDateEnding','periodStart','reportedCurrency','periodType']);let excluded=0;
 for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports'])for(const row of data[st]?.[basis] || [])for(const [field,value]of Object.entries(row)) {
  if(field.startsWith('_') || metadata.has(field) || value===null)continue;
  if(p.verifiedField(data,row,field))continue;
  (row._superseded ||= {})[field]={value,sourceIds:row._sources?.[field] || [],derivation:row._derivations?.[field] || null,reason:'Observation fails the current period, unit or reporting-version compatibility rules'};
  (row._states ||= {})[field]='conflicting_evidence';row[field]=null;
  delete row._sources?.[field];delete row._derivations?.[field];excluded++;
 }
 const validSegments=[];for(const g of data.segmentObservations || []){if(require('../backend/sec-segment-observations').validGroup(g,data))validSegments.push(g);else (data.supersededSegmentObservations ||= []).push({...g,remainingReason:'Original context witness must be extracted under current rules'});}if(data.segmentObservations)data.segmentObservations=validSegments;
 return {data,excluded};
}
function main() {
 const file=path.join(p.DATA_DIR,'sec-reporting.json');const report=JSON.parse(fs.readFileSync(file,'utf8'));let changed=0;
 for(const [id,evidence]of Object.entries(report.issuers)) {
  const file=path.join(p.DATA_DIR,'sec-financials',id+'.json');if(!evidence.financialDigest || !fs.existsSync(file))continue;
  const raw=fs.readFileSync(file,'utf8');if(p.digest(raw)!==evidence.financialDigest)throw new Error('Financial digest mismatch '+id);
  const {data:result,excluded}=sanitize(normalize(JSON.parse(raw)));if(excluded)evidence.excludedIncompatibleObservations=excluded;
  const next=JSON.stringify(result);if(raw===next)continue;
  const errors=p.validateFinancial(result,id);if(errors.length)throw new Error(errors[0]);p.atomicWrite(file,result);evidence.financialDigest=p.digest(next);changed++;
 }
 p.atomicWrite(path.join(p.DATA_DIR,'sec-reporting.json'),report);console.log(JSON.stringify({stableSourceIdIssuers:changed}));
}
if(require.main===module)main();module.exports={normalize,sanitize,main};
