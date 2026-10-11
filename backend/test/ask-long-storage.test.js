'use strict';
const {test,afterEach}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
process.env.OLLAMA_API_KEY='test-only-key';
const engine=require('../ai-chat'),mongoose=require('mongoose'),policy=require('../ask-report-policy');
const originalCollection=mongoose.connection.collection;
afterEach(()=>{mongoose.connection.collection=originalCollection;engine.__resetDeps();});
const source=fs.readFileSync(require.resolve('../app'),'utf8');
function actualFunction(name,context) {const start=source.indexOf((name==='saveAskReport'?'function ':'async function ')+name+'('),end=source.indexOf('\n}',start)+2;return vm.runInNewContext('('+source.slice(start,end)+')',{require:()=>policy,console,...context});}
const userId='000000000000000000000001',threadId='000000000000000000000002',answer='a'.repeat(24000)+'END_OF_REPORT';
const find=()=>({sort(){return this;},skip(){return this;},lean:async()=>[]});
test('saved reports and reopened thread follow-ups retain long assistant answers with unchanged question caps',async()=>{
 let report,thread;
 const saveReport=actualFunction('saveAskReport',{ASK_REPORT_KEEP:30,AskReport:{create:async doc=>{report=doc;return doc;},find}});
 saveReport(userId,'AMD',answer,'analyst',[]);await new Promise(resolve=>setImmediate(resolve));assert.equal(report.answer,answer);
 const saveThread=actualFunction('saveThreadExchange',{THREAD_ID_RE:/^[0-9a-f]{24}$/,ASK_THREAD_KEEP:50,ASK_THREAD_MSG_KEEP:80,askSurface:v=>v==='paper'?'paper':'ask',surfaceMatch:v=>v==='paper'?{surface:'paper'}:{surface:{$ne:'paper'}},AskThread:{create:async doc=>{thread={...doc,_id:threadId};return thread;},find}});
 assert.equal(await saveThread(userId,null,'q'.repeat(9000),answer,'analyst',[]),threadId);assert.equal(thread.messages[0].content.length,8000);assert.equal(thread.messages[1].content,answer);
 mongoose.connection.collection=()=>({findOne:async query=>{assert.equal(String(query.userId),userId);return thread;}});
 const reopened=await engine.threadHistory(userId,threadId);assert.equal(reopened[1].content,answer);
 let sent;engine.__setDeps({chatRaw:async messages=>{sent=messages;return {content:'The prior report remains in this conversation.'};}});
 await engine.ask({question:'Explain the earlier report in plain language.',history:reopened});assert.ok(sent.some(m=>m.role==='assistant'&&m.content.endsWith('END_OF_REPORT')));
});
test('exchange fallback history uses the same 32000-character answer ceiling',async()=>{
 let document;
 mongoose.connection.collection=()=>({updateOne:async(query,update)=>{document={turns:update.$push.turns.$each};},findOne:async()=>document});
 await engine.saveExchange(userId,'q'.repeat(9000),'a'.repeat(33000));const reopened=await engine.recentHistory(userId);assert.equal(reopened[0].content.length,8000);assert.equal(reopened[1].content.length,32000);
});
