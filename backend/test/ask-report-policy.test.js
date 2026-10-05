'use strict';
const {test, afterEach} = require('node:test'), assert = require('node:assert/strict');
process.env.OLLAMA_API_KEY='test-only-key';
process.env.SEC_COVERAGE_READ_ONLY='1'; process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
const p=require('../ask-report-policy'), q=require('../ask-answer-quality'), engine=require('../ai-chat');
afterEach(()=>engine.__resetDeps());
test('names, tickers and open questions select the same full policy in both modes',()=>{
 for(const question of ['AVGO','Broadcom','AMD','Advanced Micro Devices','JPM','JPMorgan','O','Realty Income','Meta','Micron','Broadcom stock','What do you think about AMD?','How is AMD doing?'])for(const mode of ['normal','analyst']) {
  const policy=p.select(question,mode);assert.equal(policy.kind,'company_report',question);assert.equal(policy.targetWords,null);assert.equal(policy.ceiling,1600);assert.equal(policy.tableRows,70);assert.equal(q.wordLimit(question,mode),policy.maxWords);
 }
});
test('identity precedes keyword exclusions; ambiguous listings and funds keep their own treatment',()=>{
 assert.equal(p.select('Realty Income').company.symbol,'O');
 const choice=p.select('Alphabet');assert.equal(choice.kind,'listing_choice');assert.deepEqual(new Set(choice.choices.map(c=>c.symbol)),new Set(['GOOG','GOOGL']));
 assert.equal(p.select('SPY').kind,'fund');assert.equal(p.select('NEA').kind,'fund');
 const mutual={symbol:'VTSAX',name:'Vanguard Total Stock Market',securityType:'mutual_fund'};assert.equal(p.select('VTSAX','normal',{companies:[mutual]}).kind,'fund');
 for(const question of ['AMD revenue last quarter','Compare AMD and NVDA','How is my portfolio doing?','Summarise AMD latest results'])assert.equal(p.select(question).kind,'focused',question);
 for(const question of ['companies like AMD','Tell me about peers of AMD','similar to AMD'])assert.equal(p.select(question,'analyst',{company:{symbol:'AMD',securityType:'stock'}}).kind,'focused');
});
test('explicit limits are strict and explicit requests can omit visuals',()=>{
 assert.equal(p.select('AMD under 100 words').ceiling,100);
 assert.equal(p.select('AMD under 10 words').visualRequired,false);
 assert.equal(p.select('AMD without charts').visualRequired,false);
 assert.equal(p.select('Explain AMD business','normal',{company:{symbol:'AMD',securityType:'stock'}}).kind,'company_report');
});
test('full-table allowance excludes rows from prose but remains bounded',()=>{
 const table=n=>'\n'+Array.from({length:n},()=> '| field | not disclosed |').join('\n');
 assert.equal(q.wordCount('Clear explanation.'+table(70)),2);
 assert.deepEqual(q.audit('Clear explanation.'+table(70),[],{question:'AMD'}),[]);
 assert.match(q.audit('Clear explanation.'+table(71),[],{question:'AMD'}).join(' '),/table rows/);
});
test('history keeps long answers, question caps and a strict aggregate byte budget',()=>{
 const long='a'.repeat(25000)+'END_OF_REPORT';
 const retained=p.historyMessages([{role:'user',content:'q'.repeat(9000)},{role:'assistant',content:long}]);
 assert.equal(retained[0].content.length,8000);assert.equal(retained[1].content,long);
 const many=p.historyMessages(Array.from({length:8},(_,i)=>({role:'assistant',content:'₹'.repeat(32000)+i})));
 assert.ok(many.reduce((n,m)=>n+Buffer.byteLength(m.content),0)<=64000);assert.ok(many.every(m=>!m.content.includes('\uFFFD')));
});
test('required evidence recognises honest retrieval failures but not wrong periods or insufficient history',()=>{
 const policy=p.select('AMD'), missing=p.missingResearch(policy,[]);assert.equal(missing.length,11);
 assert.equal(p.missingResearch(policy,missing.map(r=>({...r,ok:false}))).length,0);
 assert.ok(p.missingResearch(policy,missing.map(r=>({...r,args:{...r.args,limit:1}}))).length>=6);
 assert.deepEqual(p.missingResearch(p.select('AMD under 80 words'),[]),[]);
});
const tc=(id,tool,args)=>({id,type:'function',function:{name:tool,arguments:JSON.stringify(args)}});
test('bare tickers cannot publish an interjection without research, and listing choices use no model calls',async()=>{
 let calls=0;engine.__setDeps({chatRaw:async()=>{calls++;return {content:'Oh, interesting.'};},runTool:async()=>({error:'Offline test fixture'})});
 const noEvidence=await engine.ask({question:'O',mode:'analyst'});assert.equal(noEvidence.source,'partial');assert.notEqual(noEvidence.answer,'Oh, interesting.');assert.equal(calls,2);
 calls=0;const choice=await engine.ask({question:'Alphabet'});assert.equal(choice.source,'disambiguation');assert.match(choice.answer,/GOOG/);assert.equal(calls,0);
});
test('full reports preload required evidence once, supplement gaps, then draft from the prepared results',async()=>{
 const policy=p.select('AMD'), required=p.missingResearch(policy,[]);let calls=0,supplements=0;
 engine.__setDeps({chatRaw:async(messages)=>{
  calls++;
  if(calls===1){const supplied=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));assert.ok(supplied.some(r=>r.statement==='income'));assert.ok(supplied.some(r=>r.sourceAttempts?.some(a=>a.source==='Yahoo Finance')));return {tool_calls:required.map((r,i)=>tc('r'+i,r.tool,r.args))};}
  return {content:'The requested company history is unavailable. The source outage prevents a full supported report.'};
 },runTool:async(tool,args)=>{
  if(tool==='get_supplemental_context'){supplements++;return {symbol:'AMD',sourceAttempts:[{source:'Yahoo Finance',status:'retrieval_failed'}],remainingGaps:[{field:'totalRevenue',state:'retrieval_failed',reason:'Provider outage'}]};}
  if(tool==='get_quote')return {symbol:'AMD',price:null};
  if(tool==='get_financials')return {symbol:'AMD',statement:args.statement,basis:args.basis,observations:[],coverage:{remainingGaps:[{field:'totalRevenue',state:'missing'}]}};
  return {symbol:'AMD',error:'Evidence unavailable in scripted fixture'};
 }});
 const out=await engine.ask({question:'AMD',mode:'normal'});assert.equal(supplements,1);assert.equal(calls,2);assert.equal(out.quality.policy.kind,'company_report');assert.ok(out.quality.sourceAttempts.some(a=>a.source==='Yahoo Finance'));assert.ok(out.quality.remainingGaps.some(g=>g.reason==='Provider outage'));assert.ok(out.toolsUsed.filter(t=>required.some(r=>r.tool===t.tool)).slice(required.length).every(t=>t.reused));assert.doesNotMatch(out.answer,/```/);
});
test('a failed full-report synthesis keeps every sourced period and names unavailable evidence',()=>{
 const policy=p.select('AMD'),money=value=>({value,unit:'USD',currency:'USD'});
 const results=[
  {tool:'get_financials',result:{symbol:'AMD',statement:'income',basis:'annual',observations:[
   {periodEnd:'2025-12-27',currency:'USD',fields:{totalRevenue:money(34000000000),netIncome:money(4200000000),grossProfit:money(null),totalAssets:money(0)}},
   {periodEnd:'2024-12-28',currency:'USD',fields:{totalRevenue:money(25000000000),netIncome:money(1200000000)}}]}},
  {tool:'get_financials',result:{symbol:'AMD',statement:'income',basis:'quarterly',observations:[
   {periodEnd:'2026-06-27',currency:'USD',fields:{totalRevenue:money(8000000000)}},
   {periodEnd:'2026-03-28',currency:'USD',fields:{totalRevenue:money(7500000000)}}]}},
  {tool:'get_key_points',result:{symbol:'AMD',sections:[{heading:'Business',text:'The company designs processors and graphics products for data centers and consumer devices.'}]}},
  {tool:'get_segments',result:{symbol:'AMD',error:'No usable segment table',sankeyEvidence:{status:'unverified',reason:'No reconciled segment table was returned.'}}},
  {tool:'get_quote',result:{symbol:'AMD',error:'Quote provider unavailable'}},
  {tool:'get_peer_context',result:{symbol:'AMD',error:'Peer snapshot unavailable'}},
  {tool:'get_supplemental_context',result:{symbol:'AMD',remainingGaps:[{field:'quarterly grossProfit',state:'retrieval_failed',reason:'Yahoo statement module unavailable'}]}}
 ];
 const answer=q.fallback(results,'AMD',{policy,terminalReason:'validation_after_correction'});
 assert.match(answer,/2025-12-27/);assert.match(answer,/2024-12-28/);assert.match(answer,/2026-06-27/);assert.match(answer,/2026-03-28/);
 assert.match(answer,/USD 34,000,000,000/);assert.match(answer,/designs processors and graphics products/);
 assert.match(answer,/\| Total assets \|/);assert.match(answer,/\| 2025-12-27 \| .*USD 0/);assert.doesNotMatch(answer,/\| Gross profit \|/);
 assert.match(answer,/quarterly grossProfit: Yahoo statement module unavailable/);assert.match(answer,/segment disclosures: No reconciled segment table was returned/);
 assert.match(answer,/dated valuation data: the source returned no usable evidence/);assert.match(answer,/peer and industry context: the source returned no usable evidence/);
});
test('deterministic report recovery retains attributed provider facts and reports source checks',()=>{
 const today=new Date().toISOString(),policy=p.select('AMD');
 const fact=(value,periodEnd)=>({issuer:'0000002488',field:'totalRevenue',definition:'Provider-reported revenue',value,scale:1,unit:'USD',currency:'USD',periodStart:(Number(periodEnd.slice(0,4))-1)+'-01-01',periodEnd,basis:'annual',historyBasis:'annual',accountingBasis:'provider-reported',scope:'entity',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/financials/',sourceDataDate:today.slice(0,10),sourceDateKind:'retrieval',retrievedAt:today,sourceIds:['provider:'+periodEnd],state:'available'});
 const results=[
  {tool:'get_financials',result:{symbol:'AMD',basis:'annual',observations:[{periodEnd:'2025-12-27',currency:'USD',fields:{totalRevenue:{value:34000000000,currency:'USD'}}}]}},
  {tool:'get_supplemental_context',result:{symbol:'AMD',supplementalObservations:[fact(99900000000,'2025-12-27'),fact(123000000,'2024-12-28')],businessContext:{text:'AMD makes compute processors and graphics products for data centers.','sourceName':'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/profile/',effectiveDate:null,retrievedAt:today},sourceAttempts:[{source:'Yahoo Finance',status:'retrieval_failed',reason:'Timed out during refresh'}],remainingGaps:[{field:'grossProfit',reason:'Provider response omitted the field'}]}}
 ];
 const answer=q.fallback(results,'AMD',{policy,terminalReason:'validation_after_correction'});
 assert.match(answer,/USD 123,000,000/);assert.match(answer,/\[Yahoo Finance\]\(https:\/\/finance\.yahoo\.com\/quote\/AMD\/financials\/\) 2026-/);
 assert.doesNotMatch(answer,/USD 99,900,000,000/,'the matching filed period takes precedence');
 assert.match(answer,/Yahoo Finance: retrieval_failed — Timed out during refresh/);
 assert.match(answer,/Attributed company profile context/);assert.match(answer,/business description from \[Yahoo Finance\].*retrieved 2026-/);
 assert.match(answer,/grossProfit: Provider response omitted the field/);
});
test('full-report terminal failures preserve the retrieved source gaps instead of the generic receipt',async()=>{
 let calls=0;engine.__setDeps({chatRaw:async()=>{calls++;return {content:'Revenue was USD 9 trillion.'};},runTool:async()=>({error:'Offline test fixture'})});
 const out=await engine.ask({question:'AMD',mode:'analyst'});
 assert.equal(calls,2,'unsupported synthesis gets one grounding retry');assert.equal(out.source,'partial');
 assert.equal(out.quality.terminalReason,'no_research_evidence');assert.match(out.answer,/\*\*Specific evidence gaps\*\*/);
 assert.match(out.answer,/annual income statements: the source returned no usable evidence/);
 assert.match(out.answer,/Sections not synthesized/);assert.doesNotMatch(out.answer,/I could not obtain verified data for those figures/);
});
test('a follow-up request carries its own prior INTC thread context into the shared engine',async()=>{
 let calls=0,toolCalls=[];
 const prior='Prior thread subject: INTC; THREAD_CONTEXT_SENTINEL';
 engine.__setDeps({chatRaw:async messages=>{
  calls++;
  assert.ok(messages.some(m=>m.role==='assistant'&&m.content.includes(prior)),'prior assistant context reaches each model generation');
  if(calls===1)return {tool_calls:[tc('diff','get_filing_diff',{symbol:'INTC'})]};
  return {content:'The retrieved latest-quarter filing describes a change in Intel\'s operating results; this answer uses the earlier INTC thread context.'};
 },runTool:async(tool,args)=>{toolCalls.push({tool,args});return {symbol:'INTC',periodEnd:'2026-06-27',sourceUrl:'https://www.sec.gov/Archives/edgar/data/50863/quarter.htm',changes:[{text:'The latest quarter describes a changed operating result.'}]};}});
 const out=await engine.ask({question:'And what changed in its latest quarter?',mode:'normal',history:[{role:'user',content:'INTC'},{role:'assistant',content:prior}]});
 assert.equal(out.source,'ai');assert.equal(calls,2);assert.equal(toolCalls[0].args.symbol,'INTC');assert.match(out.answer,/latest-quarter filing/);
});
test('corrections keep an 8000-token allowance and strict requested prose limits',async()=>{
 let calls=0,correctionOptions;
 engine.__setDeps({chatRaw:async(messages,opts)=>{calls++;if(calls===1)return {tool_calls:[tc('quote','get_quote',{symbol:'AMD'})]};if(calls===2)return {content:'word '.repeat(101)};correctionOptions=opts;return {content:'The dated quote is available; a longer report was not requested.'};},runTool:async()=>({symbol:'AMD',price:100,asOf:'2026-10-02'})});
 const out=await engine.ask({question:'AMD under 100 words',mode:'normal'});assert.equal(correctionOptions.maxTokens,8000);assert.equal(out.source,'ai');assert.equal(out.quality.policy.ceiling,100);assert.ok(out.quality.proseWords<=100);
});
test('quarterly ratios use four actual quarters and do not present annualised return metrics',async()=>{
 for(const symbol of ['AMD','AVGO']) {
  const result=await engine.runTool('get_ratios_history',{symbol,basis:'quarterly',limit:4});assert.equal(result.basis,'quarterly');assert.equal(result.observations.length,4);assert.match(result.table,/fiscal_quarter_end/);
  for(const row of result.observations)assert.deepEqual(Object.keys(row.metrics),['grossMarginPct','opMarginPct','netMarginPct','rdIntensityPct']);
  const first=result.observations[0],metric=first.metrics.netMarginPct;assert.ok(metric.sourceIds.length);assert.ok(metric.inputs);assert.deepEqual(q.audit('Net margin was '+metric.value.toFixed(1)+'%.',[{tool:'get_ratios_history',result}]),[]);
 }
 const foreign=await engine.runTool('get_ratios_history',{symbol:'TSM',basis:'quarterly',limit:4});assert.ok(foreign.error);assert.doesNotMatch(foreign.error,/annual data/);
});
test('strict prose limits include automatically appended source citations',async()=>{
 const financial=await engine.runTool('get_financials',{symbol:'AMD',statement:'income',basis:'annual',limit:1});let calls=0;
 engine.__setDeps({chatRaw:async()=>{calls++;return calls===1?{tool_calls:[tc('income','get_financials',{symbol:'AMD',statement:'income',basis:'annual',limit:1})]}:{content:'word '.repeat(calls===2?59:35)};},runTool:async()=>financial});
 const out=await engine.ask({question:'AMD revenue under 60 words',mode:'analyst'});assert.equal(calls,3);assert.equal(out.source,'ai');assert.ok(q.wordCount(out.answer)<=60);assert.match(out.answer,/SEC sources/);
});
test('unavailable data respects an explicitly tiny answer limit',async()=>{
 engine.__setDeps({chatRaw:async()=>({content:'Revenue was USD 999 billion.'}),runTool:async()=>({error:'Source unavailable'})});
 const out=await engine.ask({question:'AMD revenue under 3 words'});assert.equal(out.source,'partial');assert.ok(q.wordCount(out.answer)<=3);
});
test('full report coverage is checked without fixing headings or chart layout',()=>{
 const policy=p.select('AMD'),results=[{tool:'get_financials',result:{statement:'income',basis:'annual',observations:[{periodEnd:'2025-12-31'}]}},{tool:'get_financials',result:{statement:'income',basis:'quarterly',observations:[{periodEnd:'2026-06-27'}]}}];
 assert.ok(p.reportIssues('Revenue improved.',policy,results).some(issue=>/annual financial periods/.test(issue)));
 const flexible='Products and customers\nDivisions\n| 2025-12-31 | Revenue unavailable |\n| 2026-06-27 | Revenue unavailable |\nPricing power\nRisk disclosures unavailable\nValuation unavailable\n**The read** — Evidence gaps remain.\n> Next: Which business division matters?';
 assert.deepEqual(p.reportIssues(flexible,policy,results),[]);assert.deepEqual(p.reportIssues('Short lookup.',p.select('AMD under 100 words'),results),[]);
});

test('company stories allow the 1363-word reference length in both modes without changing bare-name reports',()=>{
 for(const mode of ['normal','analyst'])for(const question of ['Tell the Micron story','Write a story about Micron','Micron story','Tell me the story of MU']){
  const policy=p.select(question,mode);assert.equal(policy.kind,'company_report');assert.equal(policy.company.symbol,'MU');assert.equal(policy.story,true);assert.equal(policy.maxWords,1600);assert.equal(policy.ceiling,1600);assert.equal(policy.targetWords,null);
  assert.equal(p.missingResearch(policy,[]).length,2);assert.match(p.prompt(policy),/chronological narrative/);assert.deepEqual(q.audit('Narrative '.repeat(1363),[],{question,mode}),[]);assert.deepEqual(p.reportIssues('Narrative '.repeat(1363),policy,[]),[]);
 }
 assert.equal(p.select('Micron').maxWords,1600);assert.equal(p.select('Tell the Micron story under 100 words').ceiling,100);assert.equal(p.select('SPY story').kind,'fund');
});
test('long stories generate with the 8000-token allowance and keep unsupported numbers rejected',async()=>{
 for(const mode of ['normal','analyst']){
  const policy=p.select('Tell the Micron story',mode),required=p.missingResearch(policy,[]);let calls=0,allowance;
  const financial=require('../ask-report-evidence').expand(await engine.runTool('get_financials',{symbol:'MU',statement:'income',basis:'annual',limit:5},{companyReportEvidence:true}));
  engine.__setDeps({chatRaw:async(messages,opts)=>{calls++;allowance=opts.maxTokens;assert.match(messages[0].content,/COMPANY STORY/);if(calls===1)return {tool_calls:required.map((r,i)=>tc('story'+i,r.tool,r.args))};return {content:'## The company story\n'+('Narrative context. '.repeat(675))+'\n**The read** — Use the dated evidence.\n> Next: Which era matters?'};},runTool:async name=>name==='get_financials'?financial:{symbol:'MU',sections:[{heading:'Business',text:'Source-backed business context.'}],sourceUrl:'https://www.sec.gov/report.htm'}});
  const result=await engine.ask({question:'Tell the Micron story',mode});assert.equal(result.source,'ai');assert.equal(allowance,8000);assert.ok(result.quality.proseWords>1300);assert.ok(result.answer.length<32000);assert.match(result.answer,/```(?:viz|bars)/);
  assert.ok(q.audit('Revenue was USD 999999999999999 billion.',[{tool:'get_financials',result:financial}],{question:'Tell the Micron story',mode}).length);
 }
});

test('one firm 1600-word ceiling lets both modes choose length freely across scopes',()=>{
 for(const mode of ['normal','analyst'])for(const question of ['AMD','AMD revenue last quarter','Tell the Micron story','Give a detailed analysis of JPM','SPY']){const policy=p.select(question,mode);assert.equal(policy.maxWords,1600);assert.equal(policy.ceiling,1600);assert.equal(policy.targetWords,null);assert.deepEqual(q.audit('Narrative '.repeat(1600),[],{question,mode}),[]);assert.match(q.audit('Narrative '.repeat(1601),[],{question,mode}).join(' '),/1600-word limit/);assert.doesNotMatch(p.prompt(policy),/aim for/);}
 assert.equal(p.select('AMD under 100 words').ceiling,100);assert.equal(p.select('AMD under 2000 words').ceiling,1600);assert.doesNotMatch(engine.ASK_SYSTEM,/480 words|normal mode: 320/);assert.doesNotMatch(engine.FRAMEWORK_ANALYST,/600–900|1,200-word/);
});

test('company story spelling and history requests resolve the listing before selecting research',()=>{
 for(const mode of ['normal','analyst'])for(const question of ['tell me thes touy of amd','tell me the stroy of AMD','tell me stoy of AMD','tell me the story of AMD','tell me the history of AMD']) {
  const policy=p.select(question,mode);assert.equal(policy.kind,'company_report',question);assert.equal(policy.story,true,question);assert.equal(policy.company.symbol,'AMD',question);
  assert.deepEqual(p.missingResearch(policy,[]).map(r=>r.tool),['get_financials','get_key_points']);
 }
 for(const question of ['AMD price history','AMD stock price','tell me the stock of AMD'])assert.equal(p.select(question).story,false,question);
 assert.equal(p.select('Tell me the stroy of Alphabet').kind,'listing_choice');assert.equal(p.select('Tell me the stroy of SPY').kind,'fund');
});

test('AMD story evidence precedes generation even when the model chooses only a quote',async()=>{
 const financial=await engine.runTool('get_financials',{symbol:'AMD',statement:'income',basis:'annual',limit:5},{companyReportEvidence:true});
 for(const mode of ['normal','analyst'])for(const question of ['tell me thes touy of amd','Tell me the story of AMD']) {
  let calls=0;const requested=[];
  engine.__setDeps({chatRaw:async(messages)=>{
   calls++;
   if(calls===1){
    assert.match(messages[0].content,/COMPANY STORY/);assert.doesNotMatch(messages[0].content,/ANSWER FRAMEWORK|ANSWER SHAPE/);
    const supplied=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
    assert.ok(supplied.some(r=>r.statement==='income'&&r.observations.length===5));assert.ok(supplied.some(r=>r.sections?.some(s=>s.text==='Original business disclosure.')));
    assert.ok(supplied.some(r=>r.text==='Original older business history.'));
    return {tool_calls:[tc('quote','get_quote',{symbol:'AMD'})]};
   }
   return {content:'## AMD’s story\nThe supplied business disclosure describes AMD’s products and customers. Its filed financial history shows how the business has evolved.\n**The read** — Evaluate the business using dated evidence.\n> Next: Which era should we explore?'};
  },runTool:async(tool,args)=>{
   requested.push({tool,args});
   if(tool==='get_financials')return financial;
   if(tool==='get_key_points')return {symbol:'AMD',sections:[{heading:'Business',text:'Original business disclosure.'}],sourceUrl:'https://www.sec.gov/Archives/amd-business.htm'};
   if(tool==='get_quote')return {symbol:'AMD',price:633.91,currency:'USD',asOf:'2026-10-02T20:00:01.000Z'};
   if(tool==='search_filings'){assert.equal(args.end_date,'2021-12-25');return {results:[{url:'https://www.sec.gov/Archives/edgar/data/2488/000000248821000001/annual.htm',form:'10-K',filed:'2021-02-01'}]};}
   if(tool==='fetch_page')return {url:args.url,text:'Original older business history.'};
   throw Error('Unexpected report request: '+tool);
  }});
  const out=await engine.ask({question,mode});assert.equal(calls,2);assert.equal(out.source,'ai');assert.equal(out.quality.policy.story,true);assert.equal(out.quality.fallback,false);
  assert.deepEqual(requested.map(r=>r.tool),['get_financials','get_key_points','search_filings','fetch_page','get_quote']);assert.match(out.answer,/AMD’s story/);assert.match(out.answer,/```(?:bars|viz)/);assert.doesNotMatch(out.answer,/partial answer|stored price|Some requested research was unavailable/);
 }
});

test('story source failures trigger one shared supplement before generation and keep explicit limits',async()=>{
 const financial=await engine.runTool('get_financials',{symbol:'AMD',statement:'income',basis:'annual',limit:5},{companyReportEvidence:true});let supplements=0,calls=0;
 engine.__setDeps({runTool:async(tool)=>{
  if(tool==='get_financials')return financial;
  if(tool==='get_key_points')throw Error('Official filing retrieval failed');
  if(tool==='get_supplemental_context'){supplements++;return {symbol:'AMD',businessContext:{text:'The provider describes processors and graphics products.',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/profile/'},sourceAttempts:[{source:'Yahoo Finance',status:'available'}],remainingGaps:[{section:'early_history',state:'missing',reason:'Founding-era documents unavailable'}]};}
  throw Error('Unexpected tool');
 },chatRaw:async(messages)=>{
  calls++;assert.ok(messages.some(m=>m.role==='tool'&&JSON.parse(m.content).businessContext?.sourceName==='Yahoo Finance'));
  return {content:'AMD sells processors and graphics products, according to Yahoo Finance’s company profile. Founding-era documents were unavailable.\n**The read** — The present business is documented; the earlier history remains a source gap.\n> Next: Explore its processor business?'};
 }});
 const out=await engine.ask({question:'Tell me the story of AMD under 100 words',mode:'normal'});assert.equal(calls,1);assert.equal(supplements,1);assert.equal(out.source,'ai');assert.ok(q.wordCount(out.answer)<=100);assert.ok(out.quality.remainingGaps.some(g=>g.section==='early_history'));assert.ok(out.quality.sourceAttempts.some(a=>a.source==='Yahoo Finance'));
});

test('story prefetch does not permit an invented financial figure after correction',async()=>{
 const financial=await engine.runTool('get_financials',{symbol:'AMD',statement:'income',basis:'annual',limit:5},{companyReportEvidence:true});let calls=0;
 engine.__setDeps({runTool:async name=>name==='get_financials'?financial:{symbol:'AMD',sections:[{text:'Original processor-business disclosure.'}],sourceUrl:'https://www.sec.gov/Archives/amd-business.htm'},chatRaw:async()=>{calls++;return {content:'AMD revenue was USD 999999999999999 billion.'};}});
 const out=await engine.ask({question:'Tell me the story of AMD'});assert.equal(calls,2);assert.equal(out.source,'partial');assert.ok(out.quality.auditFindings.length);assert.doesNotMatch(out.answer,/999999999999999/);
});
