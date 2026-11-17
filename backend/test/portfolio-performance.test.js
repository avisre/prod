'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {closes}=require('../price-series'),singleFlight=require('../single-flight');
const dashboard=fs.readFileSync(path.join(__dirname,'../../frontend-v2/assets/dashboard.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const number=v=>{if(v===null||v===undefined||(typeof v==='string'&&/^(?:none|null)?$/i.test(v.trim())))return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function historyHarness(fetch){
 const source=dashboard.slice(dashboard.indexOf('    const perfRequests ='),dashboard.indexOf('    function aggregate('));
 return vm.runInNewContext(source+';({fetchDaily,ensurePerformance,perfSeries});',{fetch,API:'/api',DEMO:false,auth:{},num:number,perfSeries:{compact:null,full:null}});
}
test('close projection preserves all dates, adjusted prices, missing values and fallback closes',()=>{
 const raw={'Time Series (Daily)':{'2026-11-03':{'5. adjusted close':'','4. close':'8'},'2026-11-01':{'5. adjusted close':'4.25','4. close':'9'},'2026-11-02':{'5. adjusted close':'None','4. close':null},'2026-11-04':{'5. adjusted close':'0','4. close':'7'}}};
 assert.deepEqual(closes(raw),{prices:[['2026-11-01',4.25],['2026-11-02',null],['2026-11-03',8],['2026-11-04',0]]});
 assert.equal(Object.keys(raw['Time Series (Daily)']).length,4);
});
test('history response keeps the complete full-range series',()=>{
 const daily=Object.fromEntries(Array.from({length:5500},(_,i)=>[String(i).padStart(8,'0'),{'4. close':String(i)}]));
 assert.equal(closes({'Time Series (Daily)':daily}).prices.length,5500);
 for(const route of ["app.get('/api/alpha/time-series/daily'","app.get('/api/demo/alpha/time-series/daily'"]){
  const code=app.slice(app.indexOf(route),app.indexOf('\n});',app.indexOf(route)));
  assert.match(code,/req\.query\.format === 'close'.*closes\(data\) : data/);
 }
});
test('overlapping backend requests share work, while distinct keys run independently',async()=>{
 const run=singleFlight(),gate=deferred();let calls=0;
 const jobs=Array.from({length:10},()=>run('same',()=>{calls++;return gate.promise;}));
 const other=run('other',()=>++calls);await other;assert.equal(calls,2);
 gate.resolve(42);assert.deepEqual(await Promise.all(jobs),Array(10).fill(42));
 assert.equal(await run('same',()=>43),43,'completed work is not an extra cache');
});
test('rejected shared work can be retried',async()=>{
 const run=singleFlight();await assert.rejects(run('key',()=>{throw Error('temporary');}));
 assert.equal(await run('key',()=>7),7);
});
test('duplicate holdings and simultaneous chart loads use one request per symbol',async()=>{
 const gate=deferred();let calls=0;
 const h=historyHarness(async()=>{calls++;await gate.promise;return {ok:true,json:async()=>({prices:[['2026-01-01',4]]})};});
 const a=h.fetchDaily(['AAA','AAA'],'compact'),b=h.fetchDaily(['AAA'],'compact');
 assert.equal(calls,1);gate.resolve();await Promise.all([a,b]);
 assert.equal(calls,1);
});
test('switching portfolios fills new symbols and reuses already-loaded history',async()=>{
 const seen=[];const h=historyHarness(async url=>{seen.push(url);return {ok:true,json:async()=>({prices:[['2026-01-01',4]]})};});
 await h.ensurePerformance([{symbol:'AAA',shares:1}],'compact');
 await h.ensurePerformance([{symbol:'AAA',shares:2},{symbol:'BBB',shares:1}],'compact');
 assert.equal(seen.length,2);assert.ok(h.perfSeries.compact.AAA&&h.perfSeries.compact.BBB);
});
test('failed history is not cached and legacy responses remain usable',async()=>{
 let calls=0;const h=historyHarness(async()=>++calls===1?{ok:false}:{ok:true,json:async()=>({'Time Series (Daily)':{'2026-01-01':{'4. close':'5'}}})});
 assert.equal(Object.keys(await h.fetchDaily(['AAA'],'compact')).length,0);
 const retried=await h.fetchDaily(['AAA'],'compact');assert.equal(retried.AAA[0].close,5);assert.equal(calls,2);
});
test('cached upstream function shares failures and never caches rate-limit responses',async()=>{
 const source=app.slice(app.indexOf('async function fetchAlphaCached('),app.indexOf('// MongoDB connection',app.indexOf('async function fetchAlphaCached(')));
 let calls=0;const cache=new Map(),gate=deferred();
 const ctx={coalesceAlpha:singleFlight(),normalizeTicker:s=>s.toUpperCase(),alphaResponseCache:cache,cacheGet:(c,k)=>c.get(k),cacheSet:(c,k,v)=>c.set(k,v),isAlphaRateLimitPayload:d=>Boolean(d.Note),fetchAlpha:async()=>{calls++;return gate.promise;},console:{warn(){}}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const a=ctx.fetchAlphaCached('DAILY',{symbol:'aaa'},1000),b=ctx.fetchAlphaCached('DAILY',{symbol:'AAA'},1000);
 await Promise.resolve();assert.equal(calls,1);gate.resolve({Note:'slow down'});await Promise.all([a,b]);assert.equal(cache.size,0);
});

function holdingsHarness(fetch){
 const elements=new Map();const ctx={fetch,API:'/api',DEMO:false,auth:{},portfolioRefreshVersion:0,pfSelection:'all',lastRows:[],pfScopeQuery:()=>'',holdingToRow:r=>r,
  $:id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',hidden:false});return elements.get(id);},loadPerformance:()=>{},drawPerf:()=>{},
  renderHoldings:rows=>{ctx.lastRows=rows;},refreshLiveHoldingPrices:async()=>{}};
 const source=dashboard.slice(dashboard.indexOf('    async function loadHoldings()'),dashboard.indexOf('    // The look-through reveal.'));
 vm.createContext(ctx);vm.runInContext(source,ctx);return ctx;
}
test('first holdings and history render without waiting for the live quote refresh',async()=>{
 const refresh=deferred(),events=[];
 const ctx=holdingsHarness(async url=>{assert.match(url,/prices=stored/);return {ok:true,status:200,json:async()=>[{symbol:'AAA'}]};});
 ctx.loadPerformance=()=>events.push('history');
 ctx.refreshLiveHoldingPrices=async()=>{events.push('live requested');await refresh.promise;events.push('live finished');};
 assert.equal(await ctx.loadHoldings(),true);assert.equal(ctx.lastRows[0].symbol,'AAA');
 assert.deepEqual(events,['history','live requested']);refresh.resolve();await Promise.resolve();
});
test('an obsolete scope response or failure cannot replace the current portfolio',async()=>{
 for(const fail of [false,true]){
  const old=deferred();let calls=0;
  const ctx=holdingsHarness(async()=>++calls===1?old.promise:{ok:true,status:200,json:async()=>[{symbol:'BBB'}]});
  const pending=ctx.loadHoldings();await ctx.loadHoldings();
  if(fail)old.reject(Error('old request failed'));else old.resolve({ok:true,status:200,json:async()=>[{symbol:'AAA'}]});
  assert.equal(await pending,false);assert.equal(ctx.lastRows[0].symbol,'BBB');
  assert.equal(ctx.$('holdings-loading').innerHTML,'');
 }
});
test('live refresh reconciles the chart and replaces its pending label on failure',async()=>{
 const el={textContent:'Stored prices · refreshing live prices…'},events=[];
 const ctx={fetch:async()=>({ok:true,json:async()=>[{symbol:'AAA',currentPrice:110}]}),API:'/api',auth:{},pfScopeQuery:()=>'',portfolioRefreshVersion:1,lastRows:[],holdingToRow:r=>r,
  $:()=>el,renderHoldings:rows=>{ctx.lastRows=rows;events.push('holdings');},drawPerf:rows=>events.push(rows[0].currentPrice)};
 const source=dashboard.slice(dashboard.indexOf('    async function refreshLiveHoldingPrices('),dashboard.indexOf('    // ---- multiple portfolios: switcher, create, delete'));
 vm.createContext(ctx);vm.runInContext(source,ctx);
 await ctx.refreshLiveHoldingPrices(1);assert.deepEqual(events,['holdings',110]);
 ctx.fetch=async()=>{throw Error('offline');};await ctx.refreshLiveHoldingPrices(1);
 assert.equal(el.textContent,'Stored prices · live update unavailable');
});
