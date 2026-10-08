#!/usr/bin/env node
'use strict';
process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
const assert=require('node:assert/strict');
// slice/slices take every slices-th stock, comparison and sitemap file, so --workers can
// split one run across processes. The default is the whole set in this process.
function verify({slice=0,slices=1}={}){
 const mine=(_,i)=>i%slices===slice;
 const snapshot=require('../backend/public-stock-index').view(),seo=require('../backend/seo-pages'),extra=require('../backend/seo-extra');
 const securities=new Map(snapshot.securities.map(s=>[s.symbol,s]));let profiles=0,metrics=0,comparisons=0,shards=0;const errors=[];
 function inspect(html,url,indexable){
  try{assert.equal(typeof html,'string');assert.ok(html.includes(`href="https://www.stockportfolio.pro${url}"`),'wrong canonical');assert.ok(html.includes(indexable?'content="index, follow':'content="noindex, follow'),'wrong robots');const prose=html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g,'');assert.ok(!/posted — in revenue|\bfiscal year\s*(?:[.,]|<\/p>)|\b0 years of|zero years of/i.test(prose),'unsupported prose');for(const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g))JSON.parse(m[1]);
   for(const m of html.matchAll(/href="(\/stocks\/([^/?"#]+)\/([^/?"#]+))"/g)){if(m[3].endsWith('.csv'))continue;const s=securities.get(m[2]);assert.ok(s && (m[3]==='price-history'?s.priceHistory:s.indexable && s.metricSlugs.includes(m[3])),'unsupported metric link '+m[1]);}
   for(const m of html.matchAll(/href="\/compare\/([^?"#]+-vs-[^?"#]+)"/g)){const pair=m[1].split('-vs-');assert.ok(pair.every(s=>securities.get(s)?.screenable),'unsupported comparison '+m[1]);}
  }catch(e){errors.push(url+': '+e.message);}
 }
 for(const s of snapshot.securities.filter(mine)){try{inspect(seo.renderStockPage(s.symbol),'/stocks/'+s.symbol,s.indexable);profiles++;for(const slug of s.metricSlugs){inspect(extra.renderMetricPage(s.symbol,slug),`/stocks/${s.symbol}/${slug}`,true);metrics++;}if(s.priceHistory){inspect(extra.renderPriceHistoryPage(s.symbol),`/stocks/${s.symbol}/price-history`,s.indexable);metrics++;}}catch(e){errors.push(s.symbol+': '+e.message);}}
 for(const pair of snapshot.comparisonPairs.filter(mine)){try{const rendered=extra.renderComparePage(pair);assert.ok(rendered?.html && !rendered.redirect);inspect(rendered.html,'/compare/'+pair,true);comparisons++;}catch(e){errors.push(pair+': '+e.message);}}
 const root=seo.buildSitemap();for(const match of [...root.matchAll(/<loc>[^<]*\/sitemaps\/([^<]+)\.xml<\/loc>/g)].filter(mine)){const xml=seo.buildSitemapShard(match[1]);shards++;assert.ok((xml.match(/<url>/g)||[]).length<=5000);for(const m of xml.matchAll(/<loc>[^<]*\/stocks\/([^<]+)<\/loc>/g)){const [symbol,slug]=m[1].split('/'),s=securities.get(symbol);assert.ok(s?.indexable && (!slug || slug==='price-history' && s.priceHistory || s.metricSlugs.includes(slug)),'ineligible sitemap URL '+m[1]);}}
 return {ok:!errors.length,profiles,metrics,comparisons,shards,errors};
}
// One child process per slice. A child that dies without reporting fails the run: its
// pages were never checked, so their absence must not read as a pass.
function verifyParallel(workers){
 const {fork}=require('node:child_process');
 return Promise.all(Array.from({length:workers},(_,slice)=>new Promise(resolve=>{
  let report=null;const child=fork(__filename,[`--slice=${slice}/${workers}`],{stdio:['ignore','ignore','inherit','ipc']});
  child.on('message',message=>{report=message;});
  child.on('exit',code=>resolve(report || {profiles:0,metrics:0,comparisons:0,shards:0,errors:[`worker ${slice} exited with code ${code} before reporting`]}));
 }))).then(parts=>{
  const total={ok:true,workers,profiles:0,metrics:0,comparisons:0,shards:0,errors:[]};
  for(const part of parts){for(const key of ['profiles','metrics','comparisons','shards'])total[key]+=part[key];total.errors.push(...part.errors);}
  total.ok=!total.errors.length;return total;
 });
}
if(require.main===module){
 const option=name=>{const arg=process.argv.find(a=>a===name || a.startsWith(name+'='));return arg===undefined?undefined:arg.split('=')[1] || '';};
 const finish=report=>{console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;};
 const fail=e=>{console.error(e.stack);process.exitCode=1;};
 try{
  if(option('--slice')!==undefined){const [slice,slices]=option('--slice').split('/').map(Number);assert.ok(Number.isInteger(slice) && Number.isInteger(slices) && slice>=0 && slice<slices,'--slice expects i/n');const report=verify({slice,slices});if(process.send){process.send(report);if(!report.ok)process.exitCode=1;}else finish(report);}
  else if(option('--workers')!==undefined){const workers=Number(option('--workers')) || require('node:os').availableParallelism();assert.ok(Number.isInteger(workers) && workers>0,'--workers expects a positive whole number');verifyParallel(workers).then(finish,fail);}
  else finish(verify());
 }catch(e){fail(e);}
}
module.exports={verify,verifyParallel};
