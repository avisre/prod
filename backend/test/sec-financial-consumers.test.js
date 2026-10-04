'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../sec-coverage'),adapter=require('../verified-fundamentals'),fm=require('../financial-metrics');
test('all visible company numbers have their exact fact values or explicit derivations',()=>{
 for(const symbol of ['AAPL','BRK.B','MUFG']){const d=require('../fundamentals-cache').loadFundamentals(symbol);assert.ok(d.provenance);const issuer={cik:d.overview.CIK,sources:d.provenance.sources};for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports'])for(const row of d[st][basis])for(const field of Object.keys(row._sources))assert.ok(p.verifiedField(issuer,row,field),symbol+'.'+field);}
});
test('units and rights never expose issuer statements, EPS or ratios',async()=>{
 for(const symbol of ['HCACU','GENVR']){const d=require('../fundamentals-cache').loadFundamentals(symbol);assert.equal(d.income.annualReports.length,0);assert.equal(d.overview.EPS,null);await assert.rejects(require('../ai-chat').loadFundAny(symbol),{code:'UNSUPPORTED_SECURITY_TYPE'});await assert.rejects(require('../mcp-financials').companyFinancials({company:symbol}),{code:'UNSUPPORTED_SECURITY_TYPE'});}
});
test('native currency is preserved and per-share class ambiguity is suppressed',()=>{
 const foreign=require('../fundamentals-cache').loadFundamentals('MUFG');assert.equal(foreign.income.annualReports[0].reportedCurrency,'JPY');assert.equal(foreign.overview.EPS,null);
 const brk=require('../fundamentals-cache').loadFundamentals('BRK.B');assert.equal(brk.overview.PERatio,null);assert.equal(brk.income.annualReports[0].dilutedEPS,null);
 assert.equal(require('../verified-seo').amount(100,'JPY'),'JPY 100');assert.equal(require('../verified-seo').amount(null),'—');
});
test('screener uses ready issuers and missing fields stay null',()=>{
 const index=require('../public-stock-index').view(),rows=require('../ai-chat').buildScreenIndex();assert.ok(rows.length);for(const r of rows){assert.equal(index.securities.find(s=>s.symbol===r.symbol).screenable,true);assert.equal(r.coverageStatus,'ready');assert.ok(r.cik);assert.ok(Array.isArray(r.sources));}
 const d={income:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'USD',netIncome:0,totalRevenue:0}],quarterlyReports:[]},balance:{annualReports:[]},cash:{annualReports:[]},coverage:{latestAnnual:{reportDate:'2025-12-31'},perShareAllowed:true}};
 const row=fm.screenRow({symbol:'EX'},d);assert.equal(row.fcfPositive,null);assert.equal(row.latestTotalDebt,null);assert.equal(row.profitableYears10,null);assert.equal(row.netMarginPct,null);assert.equal(row.latestNetIncome,0);
});
test('FX presentations require complete intervals and preserve inputs',()=>{
 const row={fiscalDateEnding:'2025-12-31',periodStart:'2025-01-01',reportedCurrency:'JPY',totalRevenue:1200,_sources:{totalRevenue:['fact']}};
 const rates=Array.from({length:12},(_,i)=>({month:`2025-${String(i+1).padStart(2,'0')}`,rate:0.01}));
 const convert=require('../sec-presentation').convertRow;assert.equal(convert(row,'income',rates.slice(1)).totalRevenue,null);const v=convert(row,'income',rates);assert.ok(Math.abs(v.totalRevenue-12)<1e-9);assert.equal(v._presentations.totalRevenue.originalValue,1200);assert.deepEqual(v._presentations.totalRevenue.inputSources,['fact']);assert.equal(row.totalRevenue,1200);
});
test('MCP observations are linked to their own fact accession rather than a period lookup',async()=>{
 const result=await require('../mcp-financials').companyFinancials({company:'AAPL',metrics:['revenue'],periods:2});for(const observation of result.metrics[0].observations){assert.equal(observation.source.linkage,'xbrl_fact');assert.equal(observation.source.rawValue,observation.value);assert.equal(observation.source.periodEnd,observation.period_end);assert.equal(observation.source.cik,'0000320193');}
 assert.ok(result.coverage);
});
