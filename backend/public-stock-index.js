'use strict';
const fs=require('node:fs');
const path=require('node:path');
const p=require('./sec-coverage');
let cached=null,lookups=null,currentDay=null,currentView=null;
const overrides=new Map();
function unavailable(message){return Object.assign(new Error(message || 'Verified stock snapshot is unavailable'),{code:'STOCK_COVERAGE_UNAVAILABLE',status:503});}
function load() {
 if(cached)return cached;
 try {
  const file=path.join(p.DATA_DIR,'public-stock-index.json');const raw=fs.readFileSync(file,'utf8');if(Buffer.byteLength(raw)>8*1024*1024)throw new Error('oversized snapshot');
  const doc=JSON.parse(raw),directory=fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8');
  if(doc.schemaVersion!==1 || doc.policyVersion!==1 || !Array.isArray(doc.securities) || !doc.issuers || !p.day(doc.asOf) || !doc.datasetId || doc.sourceFingerprints?.directoryDigest!==p.digest(directory))throw new Error('incompatible snapshot');
  if(!Number.isFinite(Date.parse(doc.generatedAt)) || Date.parse(doc.generatedAt)>Date.now()+60000 || doc.asOf>p.day(new Date().toISOString()))throw new Error('Invalid snapshot timestamps');
  const symbols=new Set();for(const s of doc.securities){if(!s.symbol || symbols.has(s.symbol) || !['stock','unit','right'].includes(s.securityType) || (s.cik && s.cik!==p.cik(s.cik)) || !Array.isArray(s.metricSlugs) || !p.day(s.lastmod))throw new Error('Invalid security snapshot record');symbols.add(s.symbol);}
  require('./screen-stock-index').load(doc.datasetId);
  try{const runtime=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'sec-runtime-overrides.json'),'utf8'));if(runtime.datasetId===doc.datasetId && Object.keys(runtime.issuers || {}).length<=96)for(const [id,value]of Object.entries(runtime.issuers))overrides.set(id,value);}catch(_){}
  cached=doc;lookups=new Map();for(const s of doc.securities)for(const alias of [s.symbol,...(s.aliases || [])])lookups.set(alias.toUpperCase().replace(/[.-]/g,''),s);
  return cached;
 }catch(e){throw unavailable(e.message);}
}
function view(asOf=p.day(new Date().toISOString())) {
 const snap=load();if(currentDay===asOf && currentView)return currentView;
 const issuers={};for(const [id,entry]of Object.entries(snap.issuers)) {
  const override=overrides.get(id),e=override?.evidence || entry.evidence;
  const annualReportingStatus=p.reportingStatus(e,asOf);
  let financialCoverage=override?.classification.financialCoverage || entry.financialCoverage;
  if(annualReportingStatus!=='recent_annual' && ['ready','partial'].includes(financialCoverage))financialCoverage='historical_only';
  issuers[id]={...entry,...(override?.entry || {}),evidence:e,annualReportingStatus,financialCoverage};
 }
 const securities=snap.securities.map(s=>{const issuer=issuers[s.cik],active=s.securityType==='stock' && issuer?.financialCoverage==='ready';const modified=overrides.get(s.cik)?.securities?.[s.symbol];return {...s,...modified,annualReportingStatus:issuer?.annualReportingStatus || 'unverified',financialCoverage:issuer?.financialCoverage || 'unavailable',indexable:!!active,screenable:!!active,metricSlugs:active?(modified?.metricSlugs || s.metricSlugs):[]};});
 currentDay=asOf;currentView={...snap,asOf,issuers,securities,counts:p.count(securities,issuers)};return currentView;
}
function get(symbol,asOf){const original=load() && lookups.get(String(symbol || '').toUpperCase().replace(/[.-]/g,''));if(!original)return null;const v=view(asOf),entry=v.issuers[original.cik];const active=original.securityType==='stock' && entry?.financialCoverage==='ready';return {...original,...overrides.get(original.cik)?.securities?.[original.symbol],annualReportingStatus:entry?.annualReportingStatus || 'unverified',financialCoverage:entry?.financialCoverage || 'unavailable',indexable:!!active,screenable:!!active};}
function updateIssuer(id,value){overrides.delete(id);overrides.set(id,value);while(overrides.size>96)overrides.delete(overrides.keys().next().value);currentDay=null;currentView=null;}
function canOverride(id){load();return overrides.has(id) || overrides.size<96;}
function persistOverrides(){p.atomicWrite(path.join(p.DATA_DIR,'sec-runtime-overrides.json'),{schemaVersion:1,datasetId:load().datasetId,issuers:Object.fromEntries(overrides)});}
function invalidate(){overrides.clear();cached=null;lookups=null;currentDay=null;currentView=null;require('./screen-stock-index').invalidate();}
module.exports={load,view,get,updateIssuer,invalidate,unavailable,canOverride,persistOverrides};
