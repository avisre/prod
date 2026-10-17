#!/usr/bin/env node
'use strict';
process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
const assert=require('node:assert/strict');
// One shard checks every n-th security and comparison; the sitemap is checked by shard 0. Links are
// checked against every security whichever shard renders the page.
function verify({shard=0,of=1}={}){
 const snapshot=require('../backend/public-stock-index').view(),seo=require('../backend/seo-pages'),extra=require('../backend/seo-extra');
 const securities=new Map(snapshot.securities.map(s=>[s.symbol,s]));let profiles=0,metrics=0,comparisons=0,shards=0;const errors=[];
 function inspect(html,url,indexable){
  try{assert.equal(typeof html,'string');assert.ok(html.includes(`href="https://www.stockportfolio.pro${url}"`),'wrong canonical');assert.ok(html.includes(indexable?'content="index, follow':'content="noindex, follow'),'wrong robots');const prose=html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g,'');assert.ok(!/posted — in revenue|\bfiscal year\s*(?:[.,]|<\/p>)|\b0 years of|zero years of/i.test(prose),'unsupported prose');for(const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g))JSON.parse(m[1]);
   for(const m of html.matchAll(/href="(\/stocks\/([^/?"#]+)\/([^/?"#]+))"/g)){if(m[3].endsWith('.csv'))continue;const s=securities.get(m[2]);assert.ok(s && (m[3]==='price-history'?s.priceHistory:s.indexable && s.metricSlugs.includes(m[3])),'unsupported metric link '+m[1]);}
   for(const m of html.matchAll(/href="\/compare\/([^?"#]+-vs-[^?"#]+)"/g)){const pair=m[1].split('-vs-');assert.ok(pair.every(s=>securities.get(s)?.screenable),'unsupported comparison '+m[1]);}
  }catch(e){errors.push(url+': '+e.message);}
 }
 const mine=(_,i)=>i%of===shard;
 for(const s of snapshot.securities.filter(mine)){try{inspect(seo.renderStockPage(s.symbol),'/stocks/'+s.symbol,s.indexable);profiles++;for(const slug of s.metricSlugs){inspect(extra.renderMetricPage(s.symbol,slug),`/stocks/${s.symbol}/${slug}`,true);metrics++;}if(s.priceHistory){inspect(extra.renderPriceHistoryPage(s.symbol),`/stocks/${s.symbol}/price-history`,s.indexable);metrics++;}}catch(e){errors.push(s.symbol+': '+e.message);}}
 for(const pair of snapshot.comparisonPairs.filter(mine)){try{const rendered=extra.renderComparePage(pair);assert.ok(rendered?.html && !rendered.redirect);inspect(rendered.html,'/compare/'+pair,true);comparisons++;}catch(e){errors.push(pair+': '+e.message);}}
 if(shard===0){const root=seo.buildSitemap();for(const match of root.matchAll(/<loc>[^<]*\/sitemaps\/([^<]+)\.xml<\/loc>/g)){const xml=seo.buildSitemapShard(match[1]);shards++;assert.ok((xml.match(/<url>/g)||[]).length<=5000);for(const m of xml.matchAll(/<loc>[^<]*\/stocks\/([^<]+)<\/loc>/g)){const [symbol,slug]=m[1].split('/'),s=securities.get(symbol);assert.ok(s?.indexable && (!slug || slug==='price-history' && s.priceHistory || s.metricSlugs.includes(slug)),'ineligible sitemap URL '+m[1]);}}}
 return {ok:!errors.length,profiles,metrics,comparisons,shards,errors};
}
// Every page renders on its own, so the run is split over one worker per core (VERIFY_WORKERS overrides).
async function verifyAll(n=Number(process.env.VERIFY_WORKERS)||require('node:os').cpus().length){
 if(n<=1)return verify();
 const {fork}=require('node:child_process');
 const parts=await Promise.all(Array.from({length:n},(_,i)=>new Promise((resolve,reject)=>{
  const child=fork(__filename,[],{env:{...process.env,VERIFY_SHARD:`${i}/${n}`},stdio:['ignore','pipe','inherit','ipc']});let out='';
  child.stdout.on('data',d=>out+=d);child.on('error',reject);
  child.on('exit',code=>{try{resolve(JSON.parse(out));}catch(_){reject(new Error(`worker ${i}/${n} exited ${code} without a report`));}});
 })));
 const sum=k=>parts.reduce((a,r)=>a+r[k],0),errors=parts.flatMap(r=>r.errors);
 return {ok:!errors.length,profiles:sum('profiles'),metrics:sum('metrics'),comparisons:sum('comparisons'),shards:sum('shards'),workers:n,errors};
}
if(require.main===module){
 const [shard,of]=String(process.env.VERIFY_SHARD||'').split('/').map(Number);
 if(of>0){try{process.stdout.write(JSON.stringify(verify({shard,of})));}catch(e){console.error(e.stack);process.exitCode=1;}}
 else verifyAll().then(report=>{console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;},e=>{console.error(e.stack);process.exitCode=1;});
}
module.exports={verify,verifyAll};
