#!/usr/bin/env node
'use strict';
// Public-cache promotion. Never reads account/portfolio collections.
const fs=require('node:fs'),path=require('node:path');
const p=require('../backend/sec-coverage'),obs=require('../backend/company-observations');
async function promote(collection,{asOf=p.day(new Date().toISOString()),refresh=require('../backend/yahoo-source').fetchSupplementalSnapshot}={}) {
 const stocks=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8')).companies.filter(c=>c.securityType==='stock');
 const allowed=new Set(stocks.map(c=>p.cik(c.cik) || 'listing:'+c.symbol.replace(/\./g,'-'))),symbolFor=new Map(stocks.map(c=>[p.cik(c.cik) || 'listing:'+c.symbol.replace(/\./g,'-'),c.symbol]));const seen=new Set();let promoted=0,rejected=0,refreshFailures=0;
 // Order the small heads here and fetch bodies in batches: a server-side sort
 // over whole requests exceeds the database's in-memory sort limit (code 292).
 async function* candidates(){const heads=[];for await(const head of collection.find({},{projection:{issuer:1,createdAt:1}}))heads.push(head);
  heads.sort((a,b)=>new Date(b.createdAt || 0)-new Date(a.createdAt || 0));
  for(let i=0;i<heads.length;i+=10){const ids=heads.slice(i,i+10).map(head=>head._id),rows=new Map();
   for await(const row of collection.find({_id:{$in:ids}},{projection:{issuer:1,value:1,createdAt:1}}))rows.set(String(row._id),row);
   for(const id of ids)if(rows.has(String(id)))yield rows.get(String(id));}
  for(const record of require('../backend/committed-supplements').readAll())yield {issuer:record.issuer,value:{supplemental:record.doc.observations}};}
 for await(const row of candidates()) {
  if(!allowed.has(row.issuer) || seen.has(row.issuer))continue;
  let facts=(row.value?.supplemental || []).filter(f=>obs.validSupplement(f,row.issuer) && f.sourceType!=='sec_filing' && f.basis!=='market' && f.periodEnd<=asOf && obs.sourceDate(f)<=asOf && p.day(f.retrievedAt)<=asOf && f.state==='available');
  rejected+=(row.value?.supplemental?.length || 0)-facts.length;if(!facts.length)continue;seen.add(row.issuer);
  let refreshStatus='not_required';const provider=facts.filter(f=>f.sourceName==='Yahoo Finance');
  if(provider.length)try{const live=await refresh(symbolFor.get(row.issuer),[...new Set(provider.map(f=>f.statement))]);facts=facts.map(f=>{
   if(f.sourceName!=='Yahoo Finance')return f;
   const updated=live.statements?.[f.statement]?.[f.historyBasis+'Reports']?.find(r=>r.fiscalDateEnding===f.periodEnd && r.reportedCurrency===f.currency);
   if(!updated || p.number(updated[f.field])===null)return {...f,lastRefreshResult:'not_supplied',lastRefreshAttemptAt:live.fetchedAt};
   return {...f,value:p.number(updated[f.field]),publicationDate:null,sourceDataDate:p.day(live.fetchedAt),sourceDateKind:'retrieval',retrievedAt:live.fetchedAt,sourceVersions:[p.digest(updated)],sourceIds:['provider:'+p.digest({issuer:f.issuer,field:f.field,periodEnd:f.periodEnd,version:p.digest(updated)}).slice(0,24)],lastRefreshResult:'success'};
  }).filter(f=>obs.validSupplement(f,row.issuer));refreshStatus='success';}catch(_){refreshStatus='retrieval_failed';refreshFailures++;}
  // Retain previously committed evidence when a provider no longer supplies it.
  const file=path.join(p.DATA_DIR,'supplemental-financials',row.issuer.replace(':','-')+'.json');let previous=[];try{previous=JSON.parse(fs.readFileSync(file,'utf8')).observations || [];}catch(e){if(e.code!=='ENOENT')throw e;}
  p.atomicWrite(file,{schemaVersion:1,issuer:row.issuer,cik:p.cik(row.issuer),symbol:symbolFor.get(row.issuer),checkedAt:new Date().toISOString(),refreshStatus,observations:obs.reconcile([],[...previous.filter(f=>obs.validSupplement(f,row.issuer)),...facts])});promoted++;
 }
 return {promotedIssuers:promoted,rejectedObservations:rejected,refreshFailures,source:'public_financial_requests'};
}
async function main() {
 const uri=await cacheUri();
 if(!uri)throw Object.assign(new Error('Public financial cache export credential is unavailable'),{code:'PUBLIC_CACHE_NOT_CONFIGURED'});
 const mongoose=require('node:module').createRequire(path.join(__dirname,'../backend/package.json'))('mongoose');await mongoose.connect(uri,{serverSelectionTimeoutMS:10000});
 try{console.log(JSON.stringify(await promote(mongoose.connection.collection('public_financial_requests'))));}finally{await mongoose.disconnect();}
}
async function cacheUri({env=process.env,request=fetch}={}) {
 if(env.PUBLIC_FINANCIAL_CACHE_URI)return env.PUBLIC_FINANCIAL_CACHE_URI;
 if(!env.RENDER_API_KEY || !/^srv-[a-z0-9]+$/.test(env.RENDER_SERVICE || ''))return null;
 // Read only the service Mongo setting; never list or print environment secrets.
 const response=await request('https://api.render.com/v1/services/'+env.RENDER_SERVICE+'/env-vars/MONGODB_URI',{headers:{Authorization:'Bearer '+env.RENDER_API_KEY},signal:AbortSignal.timeout(10000)});
 if(!response.ok)return null;
 const body=await response.json();return body.envVar?.value || body.value || null;
}
if(require.main===module)main().catch(e=>{console.error('Public financial cache promotion failed: '+(e.code || 'retrieval_failed'));process.exitCode=1;});
module.exports={promote,main,cacheUri};
