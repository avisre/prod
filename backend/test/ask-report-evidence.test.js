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

test('complete report request budgets instructions, history, every research tool and supplementation',async()=>{
 const policy=require('../ask-report-policy');process.env.OLLAMA_API_KEY='test-only-key';
 const receipts=[],captured=[];
 try {
 for(const mode of ['normal','analyst']){
  const required=policy.missingResearch(policy.select('AMD',mode),[]);let calls=0;
  ai.__setDeps({chatRaw:async(messages)=>{
   calls++;
   if(calls===1)return {tool_calls:required.map((r,i)=>({id:'r'+i,type:'function',function:{name:r.tool,arguments:JSON.stringify(r.args)}}))};
   const tools=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
   const bytes=Buffer.byteLength(messages.map(m=>m.content||'').join('\n'));
   receipts.push({mode,bytes,toolReplies:tools.length});captured.push({mode,bytes,tools});
   assert.ok(bytes<=tool.MAX_CONTEXT_BYTES-32*1024,`${mode}: complete request ${bytes} bytes`);
   assert.ok(tools.every(r=>r.code!=='TOOL_CONTEXT_LIMIT'),`${mode}: report tools dropped`);
   for(const result of tools.filter(r=>['annual','quarterly'].includes(r.basis)&&r.observations))assert.equal(result.observations.length,result.basis==='annual'?5:4);
   return {content:'Products and customers require the original disclosure. Divisions and competitive differences remain uncertain. Risks and valuation remain unavailable. **The read** — The original context supplies the report evidence.\n> Next: Which division matters?'};
  },runTool:async(name,args,ctx)=>{
   if(['get_financials','get_ratios_history'].includes(name))return ai.runTool(name,args,ctx);
   if(name==='get_key_points')return {symbol:'AMD',sections:[{heading:'Business',text:'Official business context. '.repeat(1080)}],sourceUrl:'https://www.sec.gov/Archives/company-report.htm'};
   if(name==='get_supplemental_context')return {symbol:'AMD',businessContext:[{text:'Supplemental original disclosure. '.repeat(300),sourceUrl:'https://issuer.example/report.htm'}],remainingGaps:[{field:'segments',state:'not_disclosed'}]};
   return {symbol:'AMD',error:'Reviewed source fixture is unavailable',context:'Source context. '.repeat(120)};
  }});
  await ai.ask({question:'AMD',mode,history:[{role:'assistant',content:'Previous detailed report. '.repeat(1200)}]});
  assert.ok(calls>=3,'supplement and synthesis exercised');
 }
 for(const {mode,bytes,tools}of captured){assert.ok(bytes<=tool.MAX_CONTEXT_BYTES-32*1024,mode);assert.ok(tools.every(r=>r.code!=='TOOL_CONTEXT_LIMIT'),mode);for(const result of tools.filter(r=>['annual','quarterly'].includes(r.basis)&&r.observations))assert.equal(result.observations.length,result.basis==='annual'?5:4);}
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
