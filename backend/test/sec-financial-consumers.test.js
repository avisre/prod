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
 const gef=require('../fundamentals-cache').loadFundamentals('GEF-B');assert.equal(gef.overview.PERatio,null);assert.equal(gef.income.annualReports[0].dilutedEPS,null);
 const brk=require('../fundamentals-cache').loadFundamentals('BRK.B');assert.ok(brk.overview.PERatio>0);assert.ok(brk.income.annualReports[0].eps>0 && brk.income.annualReports[0].eps<1000);
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
// SK hynix (SKHY) listed its ADSs in July 2026 and has no 20-F yet; the page's only figures were
// provider observations in KRW, listed unconverted beside a USD presentation.
test('provider observations convert on the statement basis and keep the figure they were reported as',()=>{
 const pres=require('../sec-presentation'),rates=Array.from({length:12},(_,i)=>({month:`2025-${String(i+1).padStart(2,'0')}`,rate:i<11?0.001:0.002}));
 const f={field:'totalRevenue',value:1200,unit:'KRW',currency:'KRW',periodStart:null,periodEnd:'2025-12-31',basis:'annual',historyBasis:'annual',statement:'income'};
 const data={supplementalObservations:[f,{...f,field:'totalAssets',statement:'balance',value:5000},{...f,field:'eps',unit:'KRW/shares',value:7},{...f,periodEnd:'2024-12-31'}]};
 assert.equal(pres.observedCurrency(data),'KRW');
 const [rev,assets,eps,old]=pres.usdObservations(data,'KRW',rates).supplementalObservations;
 // twelve months to the period end, averaged; a balance at its month's close
 assert.equal(rev.value,1.3);assert.equal(rev.unit,'USD');assert.equal(rev.presentation.originalValue,1200);assert.equal(rev.presentation.originalCurrency,'KRW');assert.equal(rev.presentation.intervalStart,'2025-01');
 assert.equal(assets.value,10);
 // a per-share figure is not a currency amount, and a period without rates stays as reported
 assert.equal(eps,data.supplementalObservations[2]);assert.equal(old,data.supplementalObservations[3]);
 assert.equal(f.value,1200);
 assert.equal(pres.observedCurrency({supplementalObservations:[{unit:'%',currency:'KRW'}]}),'');
});
// Measured 2026-10-17: GGAL's 2023 revenue, restated into December-2025 pesos by its 2025 20-F, came to
// $35B at 2023's average rate; Telecom Argentina's FY25 P$8,328,814M is about $5.7B at the year-end close.
test('IAS 29 restated amounts convert at the closing rate of the date their filing measures in',()=>{
 const {usd}=require('../sec-presentation');
 const rates=[['2022-12',0.0057],['2023-06',0.0039],['2023-12',0.0012],['2024-12',0.00097],['2025-03',0.0009],['2025-09',0.0007],['2025-12',0.0007]].map(([month,rate])=>({month,rate}));
 for(let m=1;m<=12;m++)if(!rates.some(x=>x.month===`2023-${String(m).padStart(2,'0')}`))rates.push({month:`2023-${String(m).padStart(2,'0')}`,rate:0.003});
 const sources={a:{form:'20-F',filingDate:'2026-04-16',accessionNumber:'A',periodEnd:'2023-12-31'},b:{form:'20-F',filingDate:'2024-04-26',accessionNumber:'B',periodEnd:'2021-12-31'},c:{form:'6-K',filingDate:'2025-06-10',accessionNumber:'C',periodEnd:'2023-12-31'},d:{form:'6-K',filingDate:'2025-11-20',accessionNumber:'D',periodEnd:'2025-09-30'}};
 const row={fiscalDateEnding:'2023-12-31',periodStart:'2023-01-01',reportedCurrency:'ARS',totalRevenue:1000,netIncome:100,operatingIncome:50,grossProfit:70,_sources:{totalRevenue:['a'],netIncome:['b'],operatingIncome:['c'],grossProfit:['a','b']}};
 const data={coverage:{latestAnnual:{reportDate:'2025-12-31'}},provenance:{sources},income:{annualReports:[row],quarterlyReports:[{...row,fiscalDateEnding:'2025-09-30',periodStart:'2025-07-01',_sources:{totalRevenue:['d']}}]}};
 const out=usd(data,{ARS:rates}).income;const r=out.annualReports[0];
 // the 2025 20-F measures in December-2025 pesos, the 2023 one in December-2023 pesos
 assert.ok(Math.abs(r.totalRevenue-0.7)<1e-9);assert.equal(r._presentations.totalRevenue.intervalEnd,'2025-12');
 assert.ok(Math.abs(r.netIncome-0.12)<1e-9);
 // an interim report furnished long after its latest figure, and a sum of two measuring units, are not dated
 assert.equal(r.operatingIncome,null);assert.equal(r.grossProfit,null);
 assert.ok(Math.abs(out.quarterlyReports[0].totalRevenue-0.7)<1e-9);
 // a currency outside hyperinflation keeps the period average
 assert.ok(Math.abs(usd({...data,income:{annualReports:[{...row,reportedCurrency:'CNY'}]}},{CNY:rates}).income.annualReports[0].totalRevenue-(10*0.003+0.0039+0.0012)/12*1000)<1e-9);
});
test('MCP observations are linked to their own fact accession rather than a period lookup',async()=>{
 const result=await require('../mcp-financials').companyFinancials({company:'AAPL',metrics:['revenue'],periods:2});for(const observation of result.metrics[0].observations){assert.equal(observation.source.linkage,'xbrl_fact');assert.equal(observation.source.rawValue,observation.value);assert.equal(observation.source.periodEnd,observation.period_end);assert.equal(observation.source.cik,'0000320193');}
 assert.ok(result.coverage);
});
