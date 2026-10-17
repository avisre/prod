'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
function isolated(body,{taxonomy='us-gaap',currency='USD'}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sec-release-fixture-'));
 const setup=`
 const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
 const root=${JSON.stringify(root)},dir=process.env.SEC_COVERAGE_DATA_DIR;
 const p=require(root+'/backend/sec-coverage');
 const {fixture,CIK,ACC}=require(root+'/backend/test/fixtures/sec-fixture');
 const {doc,evidence}=fixture(${JSON.stringify(taxonomy)},${JSON.stringify(currency)});
 evidence.lastAttemptResult='success';evidence.issuerName='Example';evidence.lastFinancialResult='success';
 const company={symbol:'AAPL',name:'Example',exchange:'NASDAQ',securityType:'stock',cik:CIK};
 const data=require(root+'/backend/sec-facts').extract(doc,evidence,{asOf:'2026-10-03'});
 const file=path.join(dir,'sec-financials',CIK+'.json');p.atomicWrite(file,data);
 evidence.financialDigest=p.digest(fs.readFileSync(file,'utf8'));
 p.atomicWrite(path.join(dir,'us-companies.json'),{companies:[company]});
 p.atomicWrite(path.join(dir,'sec-reporting.json'),{schemaVersion:1,asOf:'2026-10-03',issuers:{[CIK]:evidence}});
 let quote={asOf:'2026-10-03',currency:'USD',price:100,marketCap:1e9,trailingPE:20};
 require(root+'/backend/quote-store').getDailyQuote=()=>quote;
 let raw={overview:{Symbol:'AAPL',Currency:'USD'},monthly:{'Monthly Adjusted Time Series':{'2026-09-30':{'5. adjusted close':'100'},'2026-08-31':{'5. adjusted close':'95'}}}};
 require(root+'/backend/fundamentals-cache').loadRawFundamentals=()=>raw;
 const rates={${currency}:Array.from({length:12},(_,i)=>({month:'2025-'+String(i+1).padStart(2,'0'),rate:1.2}))};
 p.atomicWrite(path.join(dir,'sec-fx.json'),{schemaVersion:1,rates});
 const {build}=require(root+'/scripts/build-public-stock-index');
 const first=build({asOf:'2026-10-03',write:true});
 `;
 try {
  const result=spawnSync(process.execPath,['-e',setup+'\n(async()=>{'+body+'\n})().catch(e=>{console.error(e.stack);process.exitCode=1;});'],{cwd:root,encoding:'utf8',timeout:20000,env:{...process.env,SEC_COVERAGE_DATA_DIR:dir,SEC_COVERAGE_DISABLE_ON_DEMAND:'1',SEC_COVERAGE_READ_ONLY:'1',DISABLE_BACKGROUND_JOBS:'1'}});
  assert.equal(result.status,0,result.stdout+result.stderr+(result.error || ''));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('adapter rejects numeric fields missing from source maps and security-basis fields',()=>isolated(`
 const adapter=require(root+'/backend/verified-fundamentals'),copy=structuredClone(data),row=copy.income.annualReports[0];
 row.netIncome=999999;delete row._sources.netIncome;row.dilutedEPS=999;row.inventedValue=123;
 const clean=adapter.safeRows(copy,'income','annualReports',false)[0];
 assert.equal(clean.netIncome,null);assert.equal(clean.dilutedEPS,null);assert.equal(clean.inventedValue,null);
 assert.equal(clean.totalRevenue,0);assert.equal(row.netIncome,999999);
 `));
test('failed extraction retains ready data and its digest when a core annual field disappears',()=>isolated(`
 const before=fs.readFileSync(file,'utf8'),incomplete=structuredClone(doc);delete incomplete.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities;
 const updated=await require(root+'/scripts/refresh-sec-coverage').refreshIssuer({cik:CIK,symbols:['AAPL']},evidence,{asOf:'2026-10-03',force:true,clientImpl:{fetchReporting:async()=>evidence,fetchFacts:async()=>incomplete}});
 assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(updated.financialDigest,evidence.financialDigest);
 assert.equal(updated.lastFinancialResult,'transient_failure');assert.match(updated.lastErrorCode,/EXTRACTION_DISCARDED_VALID_PERIOD/);
 assert.equal(p.classify(updated,JSON.parse(before),'2026-10-03').financialCoverage,'ready');assert.ok(updated.lastFinancialAttemptAt);
 `));
test('a genuinely newer annual period may be incomplete without retaining old eligibility',()=>isolated(`
 const next=structuredClone(doc),acc='0000000123-26-000002';
 for(const fact of Object.values(next.facts['us-gaap']))for(const row of fact.units.USD){if(row.start)row.start='2025-07-01';row.end='2026-06-30';row.filed='2026-08-01';row.accn=acc;}
 delete next.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities;
 const e={...evidence,latestAnnual:{...evidence.latestAnnual,accessionNumber:acc,reportDate:'2026-06-30',filingDate:'2026-08-01'}};
 const updated=await require(root+'/scripts/refresh-sec-coverage').refreshIssuer({cik:CIK,symbols:['AAPL']},evidence,{asOf:'2026-10-03',force:true,clientImpl:{fetchReporting:async()=>e,fetchFacts:async()=>next}});
 assert.equal(updated.lastFinancialResult,'success');assert.equal(p.classify(updated,JSON.parse(fs.readFileSync(file)),'2026-10-03').financialCoverage,'partial');
 `));
test('same-period verified corrections and zero values remain accepted',()=>isolated(`
 const corrected=structuredClone(doc);corrected.facts['us-gaap'].NetIncomeLoss.units.USD[0].val=0;
 const updated=await require(root+'/scripts/refresh-sec-coverage').refreshIssuer({cik:CIK,symbols:['AAPL']},evidence,{asOf:'2026-10-03',force:true,clientImpl:{fetchReporting:async()=>evidence,fetchFacts:async()=>corrected}});
 const d=JSON.parse(fs.readFileSync(file));assert.equal(updated.lastFinancialResult,'success');assert.equal(d.income.annualReports[0].netIncome,0);assert.equal(p.classify(updated,d,'2026-10-03').financialCoverage,'ready');
 `));
test('quote and price changes produce a new generation and genuine content date',()=>isolated(`
 const old=structuredClone(first.publicSnapshot);old.securities[0].lastmod='2026-10-02';p.atomicWrite(path.join(dir,'public-stock-index.json'),old);
 quote={...quote,marketCap:2e9,trailingPE:40,price:200};
 const second=build({asOf:'2026-10-03',write:false});assert.notEqual(second.publicSnapshot.datasetId,first.publicSnapshot.datasetId);
 assert.equal(second.screenSnapshot.rows[0].marketCapB,2);assert.equal(second.screenSnapshot.rows[0].pe,40);assert.equal(second.publicSnapshot.securities[0].lastmod,'2026-10-03');
 const unchanged=build({asOf:'2026-10-03',write:false});assert.equal(unchanged.publicSnapshot.datasetId,second.publicSnapshot.datasetId);
 raw.monthly['Monthly Adjusted Time Series']['2026-09-30']['5. adjusted close']='201';
 const third=build({asOf:'2026-10-03',write:false});assert.notEqual(third.publicSnapshot.datasetId,second.publicSnapshot.datasetId);
 `));
test('FX changes fingerprint a new generation and converted screening values',()=>isolated(`
 const changed=structuredClone(rates);for(const point of changed.EUR)point.rate=1.5;p.atomicWrite(path.join(dir,'sec-fx.json'),{rates:changed});
 const second=build({asOf:'2026-10-03',write:false});assert.notEqual(second.publicSnapshot.datasetId,first.publicSnapshot.datasetId);
 assert.ok(Math.abs(first.screenSnapshot.rows[0].latestNetIncome-120)<1e-8);assert.equal(second.screenSnapshot.rows[0].latestNetIncome,150);
 `,{taxonomy:'ifrs-full',currency:'EUR'}));
test('on-demand refresh preserves native-currency screening presentations and no-op lastmod',()=>isolated(`
 const snapshot=structuredClone(first.publicSnapshot);snapshot.securities[0].lastmod='2026-10-02';p.atomicWrite(path.join(dir,'public-stock-index.json'),snapshot);
 require(root+'/backend/public-stock-index').invalidate();
 const client=require(root+'/backend/sec-reporting');client.fetchReporting=async()=>evidence;client.fetchFacts=async()=>doc;
 process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='0';process.env.SEC_COVERAGE_READ_ONLY='0';
 const runtime=require(root+'/backend/sec-on-demand');assert.equal(await runtime.refresh('AAPL'),true);
 const row=runtime.screenOverrides().get('AAPL');assert.deepEqual(row,first.screenSnapshot.rows[0]);
 assert.equal(require(root+'/backend/public-stock-index').get('AAPL').lastmod,'2026-10-02');
 `,{taxonomy:'ifrs-full',currency:'EUR'}));
test('snapshot write errors restore both previous files',()=>isolated(`
 const names=['public-stock-index.json','screen-index.json'],before=names.map(n=>fs.readFileSync(path.join(dir,n),'utf8'));
 quote={...quote,price:200};const next=build({asOf:'2026-10-03',write:false});
 const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to).endsWith('public-stock-index.json') && String(from).endsWith('.tmp'))throw new Error('injected publication failure');return rename(from,to);};
 try{assert.throws(()=>require(root+'/scripts/lib/publish-stock-snapshots').publish(dir,next.publicSnapshot,next.screenSnapshot),/injected/);}finally{fs.renameSync=rename;}
 assert.deepEqual(names.map(n=>fs.readFileSync(path.join(dir,n),'utf8')),before);assert.ok(!fs.readdirSync(dir).some(n=>/\.(tmp|bak)$/.test(n)));
 `));
test('screening rejects old versions and rows changed without a new generation',()=>isolated(`
 const screen=require(root+'/backend/screen-stock-index');let doc=structuredClone(first.screenSnapshot);doc.v=3;p.atomicWrite(path.join(dir,'screen-index.json'),doc);screen.invalidate();assert.throws(()=>screen.load(first.publicSnapshot.datasetId),/Incompatible/);
 doc=structuredClone(first.screenSnapshot);doc.rows[0].marketCapB=999;p.atomicWrite(path.join(dir,'screen-index.json'),doc);screen.invalidate();assert.throws(()=>screen.load(first.publicSnapshot.datasetId),/Incompatible/);
 `));
test('AI preserves reported zero gross profit and omits ratios with nonpositive denominators',()=>isolated(`
 const zero=structuredClone(doc);zero.facts['us-gaap'].Revenues.units.USD[0].val=100;
 zero.facts['us-gaap'].GrossProfit={units:{USD:[{...zero.facts['us-gaap'].Revenues.units.USD[0],val:0}]}};
 const d=require(root+'/backend/sec-facts').extract(zero,evidence,{asOf:'2026-10-03'});
 const view=require(root+'/backend/verified-fundamentals').adapt(company,raw,d,p.classify(evidence,data,'2026-10-03'),{evidence});
 // The tool receives an already verified response; inject it without contacting any service.
 require(root+'/backend/fundamentals-cache').loadFundamentals=()=>view;
 const result=await require(root+'/backend/ai-chat').runTool('get_ratios_history',{symbol:'AAPL'});
 assert.equal(result.table.split(String.fromCharCode(10))[1].split('|')[1],'0.0');
 view.balance.annualReports[0].totalShareholderEquity=-100;
 const negative=await require(root+'/backend/ai-chat').runTool('get_ratios_history',{symbol:'AAPL'});assert.equal(negative.table.split(String.fromCharCode(10))[1].split('|')[5],'-');
 `));
test('recent annual reporting is stated separately from missing current financial facts',()=>{
 const {coverageMessage}=require('../verified-seo');
 const message=coverageMessage('historical_only','recent_annual');assert.match(message,/Recent annual SEC report verified/);assert.match(message,/latest annual report period are not available/);assert.doesNotMatch(message,/reporting has not been verified/);
 assert.match(coverageMessage('unavailable','recent_annual'),/Recent annual SEC report verified/);
});
test('narrow or broader taxonomy concepts do not substitute for displayed financial fields',()=>isolated(`
 const mixed=structuredClone(doc),base=mixed.facts['us-gaap'].NetIncomeLoss.units.USD;
 for(const concept of ['GeneralAndAdministrativeExpense','InterestExpenseDebt','DepreciationDepletionAndAmortizationPropertyPlantAndEquipment'])mixed.facts['us-gaap'][concept]={units:{USD:base}};
 const extracted=require(root+'/backend/sec-facts').extract(mixed,evidence,{asOf:'2026-10-03'});
 assert.equal(extracted.income.annualReports[0].sellingGeneralAndAdministrative,null);assert.equal(extracted.income.annualReports[0].interestExpense,null);assert.equal(extracted.cash.annualReports[0].depreciationDepletionAndAmortization,null);
 `));
test('profitability windows do not skip missing years or mix reporting scopes',()=>{
 const {annualWindow}=require('../financial-metrics');
 const rows=Array.from({length:10},(_,i)=>({fiscalDateEnding:(2025-i)+'-12-31',reportedCurrency:'USD',netIncome:1,_scopes:{netIncome:'parent'}}));
 assert.equal(annualWindow(rows,'2025-12-31',10,'netIncome').length,10);
 const missing=structuredClone(rows);missing[4].netIncome=null;assert.equal(annualWindow(missing,'2025-12-31',10,'netIncome'),null);
 const gaps=structuredClone(rows);gaps[9].fiscalDateEnding='2014-12-31';assert.equal(annualWindow(gaps,'2025-12-31',10,'netIncome'),null);
 const different=structuredClone(rows);different[4]._scopes.netIncome='consolidated';assert.equal(annualWindow(different,'2025-12-31',10,'netIncome'),null);
});
test('MCP year-ago quarters are selected by date when intermediate quarters are missing',()=>{
 const {priorRowFor}=require('../mcp-financials');
 const rows=['2026-06-30','2025-12-31','2025-06-30','2025-03-31'].map(period_end=>({period_end,currency:'USD'}));
 assert.equal(priorRowFor(rows,0,'quarterly').period_end,'2025-06-30');rows[2].currency='EUR';assert.equal(priorRowFor(rows,0,'quarterly'),null);
});
test('verified company quotes preserve missing values and bypass inferred SEC-share overlays',()=>isolated(`
 process.env.QUOTES_FILE=path.join(dir,'quotes.json');process.env.SEC_SHARES_FILE=path.join(dir,'shares.json');
 p.atomicWrite(process.env.QUOTES_FILE,{EX:{price:101,marketCap:10000,sharesOutstanding:100,asOf:'2026-10-03'},NULLX:{price:10,marketCap:null,trailingPE:null,sharesOutstanding:null,asOf:'2026-10-03'}});
 p.atomicWrite(process.env.SEC_SHARES_FILE,{shares:{EX:{shares:95,asOf:'2026-06-30'}}});
 delete require.cache[require.resolve(root+'/backend/quote-store')];const quotes=require(root+'/backend/quote-store');
 assert.equal(quotes.getDailyQuote('EX').marketCap,9595);
 assert.equal(quotes.getDailyQuote('EX',{useLegacySecShares:false}).marketCap,10000);
 const missing=quotes.getDailyQuote('NULLX',{useLegacySecShares:false});assert.equal(missing.marketCap,null);assert.equal(missing.trailingPE,null);assert.equal(missing.sharesOutstanding,null);
 `));

test('public calculators use verified native-currency facts with exact provenance',()=>isolated(`
 const result=await require(root+'/backend/free-tools').getToolResult('earnings-quality','AAPL');
 assert.equal(result.status,200);assert.equal(result.body.currency,'EUR');assert.equal(result.body.revenue,data.income.annualReports[0].totalRevenue);
 assert.equal(result.body.coverage.financialCoverage,'ready');assert.ok(result.body.provenance.sources);assert.ok(result.body.provenance.statements.income[0].sources.netIncome);
 `,{taxonomy:'ifrs-full',currency:'EUR'}));
test('public calculators preserve unknown dividends, buybacks and incomplete debt',()=>isolated(`
 const view=require(root+'/backend/verified-fundamentals').adapt(company,raw,data,p.classify(evidence,data,'2026-10-03'),{evidence});
 view.balance.annualReports[0].currentDebt=12;view.balance.annualReports[0].longTermDebt=null;view.balance.annualReports[0].totalDebt=null;
 require(root+'/backend/fundamentals-cache').loadFundamentals=()=>view;
 const tools=require(root+'/backend/free-tools');
 for(const slug of ['dividend-safety','buybacks-vs-dilution','debt-snapshot']){
  const result=await tools.getToolResult(slug,'AAPL');assert.equal(result.status,200);assert.equal(result.body.metrics[0].value,null);
 }
 `));
test('public company calculators reject units instead of returning issuer financials',()=>isolated(`
 require(root+'/backend/stock-universe').lookup=()=>({...company,securityType:'unit'});
 require(root+'/backend/fundamentals-fetch').lookup=()=>company;
 const tools=require(root+'/backend/free-tools');
 assert.equal((await tools.getToolResult('earnings-quality','AAPL')).body.code,'UNSUPPORTED_SECURITY_TYPE');
 assert.equal((await tools.getToolResult('portfolio-revenue','AAPL')).body.code,'UNSUPPORTED_SECURITY_TYPE');
 `));

test('screen CAGR uses stable declared precision across JavaScript runtimes',()=>{
 const {screenRow}=require('../financial-metrics');
 const data={coverage:{latestAnnual:{reportDate:'2025-12-31'}},income:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'USD',totalRevenue:240.123},{fiscalDateEnding:'2020-12-31',reportedCurrency:'USD',totalRevenue:100}],quarterlyReports:[]},balance:{annualReports:[]},cash:{annualReports:[]}};
 const row=screenRow({symbol:'TEST'},data);assert.equal(row.revCagr5Pct,Number(row.revCagr5Pct.toFixed(10)));
});
test('the weekly run re-reads an issuer only when its filings, extractor or file changed',()=>isolated(`
 const {refreshIssuer}=require(root+'/scripts/refresh-sec-coverage'),{EXTRACTION_VERSION,VALIDATION_VERSION}=require(root+'/backend/sec-facts');
 const old={...evidence,extractionVersion:EXTRACTION_VERSION,validationVersion:VALIDATION_VERSION};
 let reads=0;
 const run=(o,e=old,force=false)=>{const before=reads;return refreshIssuer({cik:CIK,symbols:['AAPL']},o,{asOf:'2026-10-03',force,clientImpl:{fetchReporting:async()=>e,fetchFacts:async()=>{reads++;return doc;},fetchOriginal:async()=>{throw new Error('offline');}}}).then(r=>({read:reads>before,r}));};
 assert.equal((await run(old)).read,false,'nothing changed');
 assert.equal((await run(old,{...old,latestPeriodic:{form:'10-K',accessionNumber:'0000000123-26-000009'}})).read,true,'new filing');
 assert.equal((await run(old,{...old,latestAnnual:{...old.latestAnnual,amendments:[{accessionNumber:'0000000123-26-000010'}]}})).read,true,'amendment');
 assert.equal((await run({...old,extractionVersion:'old'})).read,true,'extractor changed');
 assert.equal((await run({...old,validationVersion:'old'})).read,true,'validator changed');
 assert.equal((await run({...old,financialDigest:'stale'})).read,true,'file no longer matches its digest');
 assert.equal((await run({...old,lastFinancialResult:'transient_failure'})).read,true,'last attempt failed');
 const retried=await run({...old,periodicExtraction:{status:'retrieval_failed'}});
 assert.equal(retried.read,true,'original quarterly report was not returned');
 assert.equal(retried.r.periodicExtraction,undefined,'a finished retry clears the old status');
 assert.equal((await run(old,old,true)).read,true,'forced');
 assert.doesNotMatch(fs.readFileSync(root+'/scripts/refresh-sec-coverage.js','utf8'),/force:[^}]*--weekly/,'--weekly is not forced');
 `));
test('the industry stage reads an annual report once per filing and VERSION',()=>isolated(`
 const original=require(root+'/backend/sec-original'),industry=require(root+'/backend/sec-industry');
 let fetched=0;original.fetchOriginal=async()=>{fetched++;throw new Error('offline');};
 const {main}=require(root+'/scripts/refresh-sec-industry');
 const reportFile=path.join(dir,'sec-reporting.json');
 const write=(marker,entry={})=>{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(marker)d.industryExtraction=marker;else delete d.industryExtraction;p.atomicWrite(file,d);const r=JSON.parse(fs.readFileSync(reportFile,'utf8'));Object.assign(r.issuers[CIK],{financialDigest:p.digest(fs.readFileSync(file,'utf8')),industryExtraction:undefined},entry);p.atomicWrite(reportFile,r);};
 const count=async()=>{const before=fetched;await main([]);return fetched-before;};
 write({version:industry.VERSION,sourceVersion:ACC,checkedAt:'2026-01-01T00:00:00Z',status:'success'});
 assert.equal(await count(),0,'already read for this 10-K, even in an earlier week');
 write(null);
 assert.equal(await count(),1,'a re-extracted file has no marker and is read again');
 write({version:industry.VERSION,sourceVersion:'0000000123-25-000001',status:'success'});
 assert.equal(await count(),1,'a newer 10-K is read');
 write(null,{industryExtraction:{version:industry.VERSION,sourceVersion:ACC,status:'unsupported_extraction'}});
 assert.equal(await count(),0,'an unsupported report is not fetched again until it changes');
 write(null,{industryExtraction:{version:industry.VERSION,sourceVersion:ACC,status:'retrieval_failed'}});
 assert.equal(await count(),1,'a failed fetch is retried');
 `));
