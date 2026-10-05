#!/usr/bin/env node
'use strict';
// Run separately: node --max-old-space-size=256 scripts/check-stock-coverage-performance.js
process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
const {performance}=require('node:perf_hooks'),http=require('node:http');
async function main(){
 const timings={},measure=(name,fn)=>{const t=performance.now(),value=fn();timings[name]=performance.now()-t;return value;};
 const index=measure('coldPublicSnapshotMs',()=>require('../backend/public-stock-index').view());
 measure('coldReportingMetadataMs',()=>require('../backend/company-reporting').load(index));
 measure('coldFinancialCoverageMs',()=>require('../backend/financial-coverage').summary(index.datasetId));
 const ai=measure('coldScreenSnapshotMs',()=>require('../backend/ai-chat').buildScreenIndex());
 const seo=require('../backend/seo-pages'),extra=require('../backend/seo-extra');
 const root=measure('coldSitemapMs',()=>seo.buildSitemap());
 measure('allSitemapShardsMs',()=>{for(const m of root.matchAll(/<loc>[^<]*\/sitemaps\/([^<]+)\.xml<\/loc>/g))seo.buildSitemapShard(m[1]);});
 const ready=index.securities.filter(s=>s.indexable),representatives=['AAPL','BRK.B','MUFG','MSFT',ready[0]?.symbol].filter(Boolean);
 measure('representativeProfilesMs',()=>{for(const symbol of representatives)seo.renderStockPage(symbol);});
 measure('representativeMetricsMs',()=>{for(const s of ready.filter(s=>s.metricSlugs.length).slice(0,3))extra.renderMetricPage(s.symbol,s.metricSlugs[0]);});
 let delay=0,last=performance.now(),maxRss=process.memoryUsage().rss;const timer=setInterval(()=>{const now=performance.now();delay=Math.max(delay,now-last-10);last=now;maxRss=Math.max(maxRss,process.memoryUsage().rss);},10);
 const middleware=require('../backend/ssr-cache').middleware();
 const server=http.createServer((req,res)=>{
  res.send=body=>res.end(body);res.status=code=>{res.statusCode=code;return res;};res.type=type=>{res.setHeader('Content-Type',type);return res;};req.path=req.url;req.query={};
  if(req.url==='/health')return res.end('ok');
  middleware(req,res,()=>{res.setHeader('Content-Type',req.url==='/sitemap.xml'?'application/xml':'text/html');res.send(req.url==='/sitemap.xml'?seo.buildSitemap():seo.renderStockPage(req.url.split('/')[2]));});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 let maxHealth=0;
 for(let i=0;i<50;i++){const t=performance.now();const responses=await Promise.all([fetch(base+'/health'),fetch(base+'/sitemap.xml'),fetch(base+'/stocks/'+representatives[i%representatives.length])]);await Promise.all(responses.map(r=>r.text()));maxHealth=Math.max(maxHealth,performance.now()-t);}
 await new Promise(r=>setTimeout(r,20));clearInterval(timer);await new Promise(r=>server.close(r));
 const report={ok:timings.coldSitemapMs<500 && maxRss<400*1024*1024 && delay<500 && maxHealth<500,heapLimitMiB:256,timings,rssMiB:maxRss/1024/1024,maxEventLoopDelayMs:delay,maxHealthBatchMs:maxHealth,screenRows:ai.length,cache:middleware.stats(),scope:'Isolated local HTTP harness; not a production load test or full application startup.'};
 console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
