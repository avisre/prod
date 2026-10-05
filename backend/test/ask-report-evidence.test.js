'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';process.env.DISABLE_BACKGROUND_JOBS='1';
const evidence=require('../ask-report-evidence'),tool=require('../ask-evidence'),ai=require('../ai-chat');

test('filing metadata compaction preserves every financial source after audit expansion',()=>{
 const shared={type:'sec_xbrl_fact',cik:'0000002488',form:'10-Q',filingDate:'2026-07-30',filingUrl:'https://www.sec.gov/Archives/edgar/data/2488/filing-index.html',retrievedAt:'2026-10-05T00:00:00Z',extractionVersion:'v2',unit:'USD',periodStart:'2026-03-29',periodEnd:'2026-06-27',accessionNumber:'0000002488-26-000001',linkage:'xbrl_fact'};
 const sources=Object.fromEntries(Array.from({length:8},(_,i)=>['f'+i,{...shared,concept:'FinancialConcept'+i,rawValue:100+i}]));
 const original={symbol:'AMD',observations:[{periodEnd:'2026-06-27',fields:{revenue:{value:100,unit:'USD',sourceIds:Object.keys(sources)}}}],provenance:{financialDigest:'sha',sources}};
 const compact=evidence.compact(original),roundTrip=evidence.expand(JSON.parse(JSON.stringify(compact)));
 assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(JSON.stringify(original)));
 assert.deepEqual(roundTrip,original);
});

test('full report AMD statement tools keep five annual and four quarterly periods under per-tool context cap',async()=>{
 let combinedBytes=0;
 for(const [statement,basis,limit,expected] of [['income','annual',5,5],['balance','annual',5,5],['cash','annual',5,5],['income','quarterly',4,4]]){
  const defaults=evidence.defaults('AMD',statement,basis);
  const result=await ai.runTool('get_financials',{symbol:'AMD',statement,basis,limit,fields:defaults.fields},{companyReportEvidence:true});
  assert.equal(result.history.returnedPeriods,expected,statement+' '+basis);
  assert.equal(result.observations.length,expected);
  assert.equal(result.provenance.encoding,'filing-metadata-ref-v1');
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=tool.MAX_RESULT_BYTES,statement+' '+basis+' byte cap');
  combinedBytes+=Buffer.byteLength(JSON.stringify(result));
  assert.ok(result.observations.some(row=>Object.values(row.fields).some(field=>field.value!==null)),statement+' observations populated');
  const expanded=evidence.expand(JSON.parse(JSON.stringify(result)));
  assert.ok(Object.values(expanded.provenance.sources).every(source=>source.filingUrl && source.cik && source.form));
  assert.ok(tool.filingLinks(expanded).length>0);
 }
});

test('industry-selected ratios retain exact values while shrinking unused columns',async()=>{
 const metrics=evidence.defaults('AMD','income','annual').metrics;
 const result=await ai.runTool('get_ratios_history',{symbol:'AMD',basis:'annual',limit:5,metrics},{companyReportEvidence:true});
 assert.equal(result.history.returnedPeriods,5);
 assert.deepEqual(new Set(Object.keys(result.observations[0].metrics)),new Set(metrics));
 const labels={grossMarginPct:'grossMargin%',opMarginPct:'opMargin%',netMarginPct:'netMargin%',rdIntensityPct:'rdIntensity%',fcfMarginPct:'fcfMargin%',roePct:'ROE%',roaPct:'ROA%',currentRatio:'currentRatio',debtToEquity:'debtToEquity',ocfToNetIncome:'ocfToNetIncome',capexPctRevenue:'capexPctRevenue',sharesOutM:'sharesOutM'};
 assert.equal(result.table.split('\n')[0],'fiscal_year_end|'+Object.keys(result.observations[0].metrics).map(name=>labels[name]).join('|'));
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=tool.MAX_RESULT_BYTES);
 const expanded=evidence.expand(JSON.parse(JSON.stringify(result)));
 const metric=Object.values(result.observations[0].metrics).find(value=>value.value!==null && value.sourceIds.length);
 assert.ok(metric);
 assert.ok(metric.sourceIds.every(id=>expanded.provenance.sources[id]));
});

test('all six full report statement and ratio payloads fit Ask usable context',async()=>{
 let bytes=0;
 for(const [statement,basis,limit] of [['income','annual',5],['income','quarterly',4],['balance','annual',5],['cash','annual',5]]){
  const args={symbol:'AMD',statement,basis,limit,fields:evidence.defaults('AMD',statement,basis).fields};
  const result=await ai.runTool('get_financials',args,{companyReportEvidence:true});bytes+=Buffer.byteLength(JSON.stringify(result));
 }
 for(const basis of ['annual','quarterly']){
  const result=await ai.runTool('get_ratios_history',{symbol:'AMD',basis,limit:basis==='annual'?5:4,metrics:evidence.defaults('AMD','income',basis).metrics},{companyReportEvidence:true});
  assert.equal(result.history.returnedPeriods,basis==='annual'?5:4);bytes+=Buffer.byteLength(JSON.stringify(result));
 }
 assert.ok(bytes<=160*1024,`financial evidence uses ${bytes} bytes of 160 KiB`);
});
