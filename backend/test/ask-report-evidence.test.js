'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';process.env.DISABLE_BACKGROUND_JOBS='1';
const evidence=require('../ask-report-evidence'),tool=require('../ask-evidence'),ai=require('../ai-chat');

test('remaining context bounds supplemental excerpts without losing typed financial receipts',()=>{
 const input={symbol:'AMD',businessContext:{text:'Original business context. '.repeat(1000),sourceUrl:'https://issuer.example/report',effectiveDate:'2025-12-27'},observations:[{periodEnd:'2025-12-27',fields:{totalRevenue:{value:123456789,unit:'TWD',currency:'TWD',sourceIds:['fixture-source']}}}],provenance:{sources:{'fixture-source':{filingUrl:'https://www.sec.gov/Archives/edgar/data/2488/filing.htm',filingDate:'2026-02-04',unit:'TWD',scope:'entity'}}}};
 const serialized=evidence.serialize(input,1500),result=evidence.expand(JSON.parse(serialized));assert.ok(Buffer.byteLength(serialized)<=1500);assert.notEqual(result.code,'TOOL_CONTEXT_LIMIT');assert.deepEqual(result.observations,input.observations);assert.deepEqual(result.provenance,input.provenance);assert.equal(result.businessContext.sourceUrl,input.businessContext.sourceUrl);assert.equal(result.businessContext.effectiveDate,input.businessContext.effectiveDate);assert.ok(result.businessContext.text.length<input.businessContext.text.length);
 assert.equal(JSON.parse(evidence.serialize(input,100)).code,'TOOL_CONTEXT_LIMIT','unfittable financial receipts are withheld explicitly');
});

function onlineProjection(t) {
 const saved={read:process.env.SEC_COVERAGE_READ_ONLY,demand:process.env.SEC_COVERAGE_DISABLE_ON_DEMAND};
 process.env.SEC_COVERAGE_READ_ONLY='0';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='0';
 t.after(()=>{process.env.SEC_COVERAGE_READ_ONLY=saved.read;process.env.SEC_COVERAGE_DISABLE_ON_DEMAND=saved.demand;ai.__resetDeps();});
 const resolver=require('../company-evidence').createResolver({cache:{get:async()=>null,set:async()=>({persisted:false})},client:{},quote:async()=>null});
 t.mock.method(require('../verified-fundamentals'),'getCompanyEvidence',(symbol,fields,periods)=>resolver.getCompanyEvidence(symbol,fields,periods,false));
 return resolver;
}

test('live resolver calculations stay in the requested statement window and retain source receipts',async t=>{
 const resolver=onlineProjection(t);
 const projected=await resolver.getCompanyEvidence('AMD',['totalRevenue','netIncome'],undefined,false);
 assert.ok(projected.data.compatibleCalculations.length>100,'exercise the full live calculation history that offline reads omit');
 for(const args of [{statement:'income',basis:'annual',limit:5},{statement:'income',basis:'annual',limit:5,before:'2020-01-01'},{statement:'income',basis:'quarterly',limit:4},{statement:'cash',basis:'annual',limit:5},{statement:'income',basis:'annual',limit:20}]){
  const result=await ai.runTool('get_financials',{symbol:'AMD',...args,fields:evidence.defaults('AMD',args.statement,args.basis).fields},{companyReportEvidence:true});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=tool.MAX_RESULT_BYTES,JSON.stringify(args));
  assert.notEqual(JSON.parse(tool.serializeResult(result,160*1024)).code,'TOOL_CONTEXT_LIMIT');
  if(args.limit<=5)assert.equal(result.observations.length,args.limit,'all requested periods survive the live projection');
  const expanded=evidence.expand(result),dates=new Set(expanded.observations.map(o=>o.periodEnd));
  for(const calc of expanded.calculations){assert.ok(dates.has(calc.periodEnd),'no calculation leaks an omitted period');assert.ok(calc.sourceIds.every(id=>expanded.provenance.sources[id]),'every calculation retains its original source');}
  if(args.statement==='income' && args.basis==='annual' && args.limit===5 && !args.before){
   const first=expanded.observations[0].fields;
   const intensity=(first.researchAndDevelopment.value/first.totalRevenue.value*100).toFixed(1);
   assert.deepEqual(require('../ask-answer-quality').numericClaims('R&D spending was '+intensity+'% of revenue.',[{tool:'get_financials',result:expanded}]),[],'deduplicating SEC margins preserves compatible claims from the supplied inputs');
  }
 }
});

test('exact AMD story wording supplies usable live projected history in both modes before synthesis',async t=>{
 onlineProjection(t);process.env.OLLAMA_API_KEY='test-only-key';
 for(const mode of ['normal','analyst']){
  ai.__setDeps({chatRaw:async messages=>{
   const results=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
   assert.ok(results.every(r=>r.code!=='TOOL_CONTEXT_LIMIT'));
   const financial=results.find(r=>r.statement==='income');assert.equal(financial.observations.length,5);
   return {content:'## AMD through its annual financial history\nRevenue was USD 34.6 billion in the latest supplied fiscal year. The annual history shows the business changing over time.\n**The read** — Use the dated financial evidence.\n> Next: Which period should we explore?'};
  },runTool:async(name,args,ctx)=>name==='get_financials'?ai.runTool(name,args,ctx):{symbol:'AMD',error:'Specific older narrative fixture is unavailable'}});
  const answer=await ai.ask({question:'tell me thes touy of amd',mode});assert.equal(answer.source,'ai');assert.ok(answer.toolsUsed.find(t=>t.tool==='get_financials').ok);assert.match(answer.answer,/```(?:bars|viz)/);
 }
});

test('scoping live history preserves attributed supplemental calculations and their native currency',async t=>{
 const resolver=onlineProjection(t),verified=require('../verified-fundamentals');
 const base={issuer:'0000002488',definition:'Toy provider fixture',scale:1,unit:'TWD',currency:'TWD',periodStart:'2024-12-29',periodEnd:'2025-12-27',basis:'annual',historyBasis:'annual',statement:'income',accountingBasis:'provider-reported',scope:'entity',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/financials/',sourceDataDate:'2026-10-05',sourceDateKind:'retrieval',retrievedAt:'2026-10-05T00:00:00Z',sourceVersions:['toy-fixture'],state:'available'};
 const facts=[['netIncome',50],['totalRevenue',200]].map(([field,value])=>({...base,field,value,sourceIds:['provider:fixture:'+field]}));
 const calc=require('../company-calculations').calculate(facts)[0];assert.ok(require('../company-calculations').validCalculation(calc));
 t.mock.method(verified,'getCompanyEvidence',async(symbol,fields,periods)=>{const result=await resolver.getCompanyEvidence(symbol,fields,periods,false);result.data.compatibleCalculations.push(calc);result.data.supplementalObservations.push(...facts);return result;});
 const result=evidence.expand(await ai.runTool('get_financials',{symbol:'AMD',statement:'income',basis:'annual',limit:5,fields:evidence.defaults('AMD','income','annual').fields},{companyReportEvidence:true}));
 assert.deepEqual(result.calculations.find(c=>c.sourceOrigin==='provider'),calc);assert.equal(result.calculations.find(c=>c.sourceOrigin==='provider').currency,'TWD');
});

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
 const metric=Object.values(expanded.observations[0].metrics).find(value=>value.value!==null && value.sourceIds.length);
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

test('complete live projected report budgets instructions, history, every research tool and supplementation',async t=>{
 onlineProjection(t);
 const policy=require('../ask-report-policy');process.env.OLLAMA_API_KEY='test-only-key';
  const receipts=[],captured=[];
 try {
 for(const mode of ['normal','analyst']){
  const required=policy.missingResearch(policy.select('AMD',mode),[]);let calls=0;
  ai.__setDeps({chatRaw:async(messages,opts)=>{
   calls++;
   const tools=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
   const bytes=Buffer.byteLength(messages.map(m=>m.content||'').join('\n'));
   receipts.push({mode,bytes,toolReplies:tools.length});captured.push({mode,bytes,tools,availableTools:(opts.tools||[]).map(x=>x.function.name)});
   assert.ok(bytes<=tool.MAX_CONTEXT_BYTES-32*1024,`${mode}: complete request ${bytes} bytes`);
   assert.ok(tools.every(r=>r.code!=='TOOL_CONTEXT_LIMIT'),`${mode}: ${JSON.stringify(tools.map((r,index)=>({index,code:r.code,bytes:Buffer.byteLength(JSON.stringify(r))})))}`);
   for(const result of tools.filter(r=>['annual','quarterly'].includes(r.basis)&&r.observations))assert.equal(result.observations.length,result.basis==='annual'?5:4);
   const periods=tools.filter(r=>r.statement==='income').flatMap(r=>r.observations||[]).map(o=>o.periodEnd);
   const annual=tools.filter(r=>r.statement==='income'&&String(r.basis||'').startsWith('annual')).flatMap(r=>r.observations||[]).map(o=>o.periodEnd);
   const quarterly=tools.filter(r=>r.statement==='income'&&String(r.basis||'').startsWith('quarterly')).flatMap(r=>r.observations||[]).map(o=>o.periodEnd);
   const rows=[...new Set([...annual,...quarterly])].map(d=>`| ${d} | Revenue unavailable in fixture |`).join('\n');
   assert.ok(periods.length,'financial report evidence is preloaded before first synthesis');
   return {content:`Products are sold to customers.\n\nDivisions are covered by the retrieved disclosures.\n\nAnnual reporting: ${annual.length} periods.\n\nQuarterly reporting: ${quarterly.length} periods.\n\n| Fiscal period ended | Revenue |\n| --- | --- |\n${rows}\n\nCompetitors shape the industry position.\n\nRisks include business uncertainty.\n\nValuation is based on dated market evidence.\n\n**The read** — The supplied observations show the reported periods; the source excerpts support the business context.\n> Next: Which division should we examine?`};
  },runTool:async(name,args,ctx)=>{
   if(['get_financials','get_ratios_history'].includes(name))return ai.runTool(name,args,ctx);
   if(name==='get_key_points')return {symbol:'AMD',sections:[{heading:'Business',text:'Official business context. '.repeat(1080)}],sourceUrl:'https://www.sec.gov/Archives/company-report.htm'};
   if(name==='get_supplemental_context')return {symbol:'AMD',businessContext:[{text:'Supplemental original disclosure. '.repeat(300),sourceUrl:'https://issuer.example/report.htm'}],remainingGaps:[{field:'segments',state:'not_disclosed'}]};
   return {symbol:'AMD',error:'Reviewed source fixture is unavailable',context:'Source context. '.repeat(120)};
  }});
  const result=await ai.ask({question:'AMD',mode,history:[{role:'assistant',content:'Previous detailed report. '.repeat(1200)}]});
  assert.ok(calls>=1 && calls<=2,'evidence is prepared before synthesis; at most one correction generation follows');
  assert.equal(result.source,'ai',JSON.stringify({issues:result.quality.auditFindings,inputs:captured.map(c=>c.tools.filter(r=>r.statement==='income').map(r=>({basis:r.basis,observations:r.observations?.map(o=>o.periodEnd)})))}));
 }
 for(const {mode,bytes,tools,availableTools}of captured){assert.ok(bytes<=tool.MAX_CONTEXT_BYTES-32*1024,mode);assert.ok(tools.every(r=>r.code!=='TOOL_CONTEXT_LIMIT'),`${mode}: ${JSON.stringify(tools.map((r,index)=>({index,code:r.code,bytes:Buffer.byteLength(JSON.stringify(r))})))}`);for(const result of tools.filter(r=>['annual','quarterly'].includes(r.basis)&&r.observations))assert.equal(result.observations.length,result.basis==='annual'?5:4);assert.ok(!availableTools.includes('get_financials'),'prefetched pulls are removed from callable tools');assert.ok(availableTools.includes('search_web'),'independent source research remains available');}
 if(process.env.ASK_REPORT_BUDGET_RECEIPT==='1')require('node:fs').writeFileSync(require('node:path').join(__dirname,'../../docs/qa/ask-reports-2026-10-05/report-context-budget.json'),JSON.stringify({scope:'Complete engine request; real AMD financial tools; bounded narrative fixtures; no model calls',limitBytes:tool.MAX_CONTEXT_BYTES-32*1024,receipts},null,2)+'\n');
 } finally {ai.__resetDeps();}
});

test('source aliases, explicit nulls and repeated calculation inputs round-trip exactly',()=>{
 const source={type:'sec_xbrl_fact',concept:'Revenue',rawValue:100,scope:null,unit:'USD',filingUrl:'https://www.sec.gov/filing.htm'};
 const fact={value:100,periodEnd:'2025-12-31',unit:'USD',currency:'USD',sourceIds:['canonical-source-identity']};
 const original={observations:[{fields:{revenue:fact},calculation:{value:50,sourceIds:fact.sourceIds,inputs:{numerator:fact,denominator:fact}}}],provenance:{sources:{'canonical-source-identity':source}}};
 const compact=evidence.compact(original);assert.deepEqual(evidence.compact(compact),compact);assert.deepEqual(evidence.expand(JSON.parse(JSON.stringify(compact))),original);
 assert.ok(Object.keys(compact.reportEvidence.facts).length);assert.equal(Object.values(evidence.expand(compact).provenance.sources)[0].scope,null);
});
test('narrative bounds retain every financial value and cite shortened excerpts',()=>{
 const original={sections:[{heading:'Business',text:'₹'.repeat(10000)},{heading:'Risks',text:'Risk disclosure. '.repeat(1000)}],observations:[{value:0,unit:'JPY',sourceIds:['fact']}],sourceUrl:'https://issuer.example/report.htm'};
 const bounded=evidence.boundNarrative(original);assert.ok(bounded.sections.reduce((n,s)=>n+Buffer.byteLength(s.text),0)<=8192);assert.equal(bounded.sections.length,2);assert.deepEqual(bounded.observations,original.observations);assert.equal(bounded.sourceUrl,original.sourceUrl);assert.match(bounded.contextNote,/shortened/);assert.ok(bounded.sections.every(s=>!s.text.includes('\uFFFD')));
});

test('original segment XBRL context identifiers survive full-report compaction and auditing',async()=>{
 const original=await ai.runTool('get_segments',{symbol:'AVGO'});assert.equal(require('../ask-answer-quality').verifiedSegmentEvidence([{tool:'get_segments',result:original}]).status,'eligible');
 const expanded=evidence.expand(JSON.parse(JSON.stringify(evidence.compact(original))));assert.deepEqual(expanded,original);assert.equal(require('../ask-answer-quality').verifiedSegmentEvidence([{tool:'get_segments',result:expanded}]).status,'eligible');
});
