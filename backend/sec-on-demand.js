'use strict';
// Single-issuer refresh only. The daily builder owns universe-wide maintenance.
const fs=require('node:fs'),path=require('node:path');
const p=require('./sec-coverage'),index=require('./public-stock-index');
const pending=new Map(),cooldowns=new Map(),rows=new Map(),listeners=new Set();
let requests=[];
function onChange(fn){listeners.add(fn);return ()=>listeners.delete(fn);}
function screenOverrides(){for(const item of Object.values(index.view().issuers))for(const row of item.runtimeScreenRows || [])rows.set(row.symbol,row);return rows;}
async function refresh(symbol){
 if(process.env.SEC_COVERAGE_DISABLE_ON_DEMAND==='1')return false;
 const stocks=require('./stock-universe'),company=stocks.lookup(symbol),id=p.cik(company?.cik);
 if(!id || company.securityType!=='stock')return false;
 if(!index.canOverride(id))return false;
 if(pending.has(id))return pending.get(id);
 const now=Date.now();requests=requests.filter(t=>now-t<600000);
 if(pending.size || requests.length>=60 || now-(cooldowns.get(id)||0)<21600000 || process.memoryUsage().rss>320*1024*1024)return false;
 // Data commits are immutable in production. Local writable overrides are opt-in.
 // A bounded refresh must never race an offline build in the same data directory.
 const lock=path.join(p.DATA_DIR,'.sec-refresh.lock');let fd;
 try{fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));}catch(_){return false;}
 requests.push(now);cooldowns.set(id,now);while(cooldowns.size>1024)cooldowns.delete(cooldowns.keys().next().value);
 const work=(async()=>{try{
  const file=path.join(p.DATA_DIR,'sec-reporting.json'),report=JSON.parse(fs.readFileSync(file,'utf8'));
  const securities=stocks.companies().filter(c=>p.cik(c.cik)===id);
  const evidence=await require('../scripts/refresh-sec-coverage').refreshIssuer({cik:id,symbols:securities.map(c=>c.symbol)},report.issuers[id],{asOf:p.day(new Date().toISOString()),force:true,clientImpl:{fetchReporting:require('./sec-reporting').fetchReporting,fetchFacts:cik=>require('./sec-reporting').fetchFacts(cik,{request:url=>require('./sec-reporting').getJson(url,{maxBytes:12*1024*1024})})}});
  report.issuers[id]=evidence;report.generatedAt=new Date().toISOString();p.atomicWrite(file,report);
  require('./verified-fundamentals').invalidate(id);
  const data=require('./verified-fundamentals').loadIssuer(id,evidence.financialDigest),classification=p.classify(evidence,data);
  const override={evidence,classification,entry:{financialDigest:evidence.financialDigest},securities:{}};
  for(const c of securities){
   require('./fundamentals-cache').invalidate(c.symbol);
   const view=require('./verified-fundamentals').adapt(c,require('./fundamentals-cache').loadRawFundamentals(c.symbol),data,classification,{evidence,financialDigest:evidence.financialDigest});
   override.securities[c.symbol]={financialDigest:evidence.financialDigest,metricSlugs:require('./financial-metrics').capabilities(view),lastmod:p.day(new Date().toISOString())};
   rows.set(c.symbol,{...require('./financial-metrics').screenRow(c,view),financialDigest:evidence.financialDigest});
  }
  while(rows.size>192)rows.delete(rows.keys().next().value);
  override.entry.runtimeScreenRows=securities.map(c=>rows.get(c.symbol));
  index.updateIssuer(id,override);index.persistOverrides();require('./seo-pages').invalidateSitemapInventory();
  for(const fn of listeners)fn(securities.map(c=>c.symbol));return evidence.lastAttemptResult==='success' && evidence.lastFinancialResult==='success';
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);pending.delete(id);}})();
 pending.set(id,work);return work;
}
module.exports={refresh,onChange,screenOverrides};
