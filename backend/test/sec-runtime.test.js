'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('UTC day changes expire reporting without reading financial files',()=>{
 const fs=require('node:fs'),index=require('../public-stock-index');index.view('2026-10-03');let reads=0;const original=fs.readFileSync;
 fs.readFileSync=function(file,...args){if(String(file).includes('sec-financials'))reads++;return original.call(this,file,...args);};
 // Reporting expires more than 35 days after its last check; date the probe
 // from the snapshot so a rebuild on any day keeps this test meaningful.
 const later=new Date(Date.parse(index.load().asOf)+36*86400000).toISOString().slice(0,10);
 try{const expired=index.view(later);assert.equal(expired.counts.financialReadyIssuers,0);assert.equal(expired.counts.screenableIssuers,0);assert.equal(index.get('AAPL',later).indexable,false);assert.equal(reads,0);}finally{fs.readFileSync=original;index.view('2026-10-03');}
});
test('snapshot generations are matched and directories fingerprinted',()=>{
 const index=require('../public-stock-index').load();assert.equal(require('../screen-stock-index').load(index.datasetId).datasetId,index.datasetId);assert.throws(()=>require('../screen-stock-index').load('wrong-generation'),/Incompatible/);
});
test('cache invalidation removes only affected profiles and comparisons',()=>{
 const mw=require('../ssr-cache').middleware();mw.store.set('/stocks/AAPL','a'.repeat(500),'text/html');mw.store.set('/stocks/MSFT','b'.repeat(500),'text/html');mw.store.set('/compare/AAPL-vs-MSFT','c'.repeat(500),'text/html');
 mw.store.invalidateWhere(key=>key.includes('AAPL'));assert.equal(mw.store.get('/stocks/AAPL'),null);assert.equal(mw.store.get('/compare/AAPL-vs-MSFT'),null);assert.ok(mw.store.get('/stocks/MSFT'));
});
test('production cannot invoke the legacy path that writes committed financial files',async()=>{
 const old=process.env.NODE_ENV;process.env.NODE_ENV='production';
 try{assert.equal(await require('../sec-on-demand').refresh('AAPL'),false);}finally{if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old;}
});
