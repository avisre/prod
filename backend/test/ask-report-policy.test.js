'use strict';
const {test, afterEach} = require('node:test'), assert = require('node:assert/strict');
process.env.OLLAMA_API_KEY='test-only-key';
process.env.SEC_COVERAGE_READ_ONLY='1'; process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
const p=require('../ask-report-policy'), q=require('../ask-answer-quality'), engine=require('../ai-chat');
afterEach(()=>engine.__resetDeps());
test('names, tickers and open questions select the same full policy in both modes',()=>{
 for(const question of ['AVGO','Broadcom','AMD','Advanced Micro Devices','JPM','JPMorgan','O','Realty Income','Meta','Micron','Broadcom stock','What do you think about AMD?','How is AMD doing?'])for(const mode of ['normal','analyst']) {
  const policy=p.select(question,mode);assert.equal(policy.kind,'company_report',question);assert.deepEqual(policy.targetWords,[600,900]);assert.equal(policy.ceiling,1260);assert.equal(policy.tableRows,70);assert.equal(q.wordLimit(question,mode),policy.maxWords);
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
 let calls=0;engine.__setDeps({chatRaw:async()=>{calls++;return {content:'Oh, interesting.'};}});
 const noEvidence=await engine.ask({question:'O',mode:'analyst'});assert.equal(noEvidence.source,'partial');assert.notEqual(noEvidence.answer,'Oh, interesting.');assert.equal(calls,2);
 calls=0;const choice=await engine.ask({question:'Alphabet'});assert.equal(choice.source,'disambiguation');assert.match(choice.answer,/GOOG/);assert.equal(calls,0);
});
test('full-report loop fetches a missing supplement once and reports its attempted sources and gaps',async()=>{
 const policy=p.select('AMD'), required=p.missingResearch(policy,[]);let calls=0,supplements=0;
 engine.__setDeps({chatRaw:async(messages)=>{
  calls++;
  if(calls===1)return {tool_calls:required.map((r,i)=>tc('r'+i,r.tool,r.args))};
  return {content:'The requested company history is unavailable. The source outage prevents a full supported report.'};
 },runTool:async(tool,args)=>{
  if(tool==='get_supplemental_context'){supplements++;return {symbol:'AMD',sourceAttempts:[{source:'Yahoo Finance',status:'retrieval_failed'}],remainingGaps:[{field:'totalRevenue',state:'retrieval_failed',reason:'Provider outage'}]};}
  if(tool==='get_quote')return {symbol:'AMD',price:null};
  if(tool==='get_financials')return {symbol:'AMD',statement:args.statement,basis:args.basis,observations:[],coverage:{remainingGaps:[{field:'totalRevenue',state:'missing'}]}};
  return {symbol:'AMD',error:'Evidence unavailable in scripted fixture'};
 }});
 const out=await engine.ask({question:'AMD',mode:'normal'});assert.equal(supplements,1);assert.equal(calls,3);assert.equal(out.quality.policy.kind,'company_report');assert.ok(out.quality.sourceAttempts.some(a=>a.source==='Yahoo Finance'));assert.ok(out.quality.remainingGaps.some(g=>g.reason==='Provider outage'));assert.doesNotMatch(out.answer,/```/);
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
