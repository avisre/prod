'use strict';
const {test,afterEach}=require('node:test'),assert=require('node:assert/strict');
process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
const verified=require('../verified-fundamentals'),orig=verified.getCompanyEvidence,tool=require('../ask-supplemental-context'),q=require('../ask-answer-quality');
afterEach(()=>{verified.getCompanyEvidence=orig;});
function provider(value=123,currency='TWD') {return {issuer:'0000002488',field:'totalRevenue',definition:'Provider-reported revenue',value,scale:1,unit:currency,currency,periodStart:'2025-01-01',periodEnd:'2025-12-31',basis:'annual',accountingBasis:'provider-reported',scope:'entity',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/financials/',sourceDataDate:'2026-10-05',sourceDateKind:'retrieval',retrievedAt:'2026-10-05T00:00:00Z',sourceIds:['provider:fixture'],state:'available'};}
test('supplements use the shared resolver with bounded fields/periods and preserve attributed native-currency evidence',async()=>{
 let args;const source=provider();verified.getCompanyEvidence=async(...a)=>{args=a;return {statements:null,data:{supplementalObservations:[source],sourceAttempts:[{source:'Yahoo Finance',status:'success'}],freshness:{},coverage:{}},remainingGaps:[]};};
 const r=await tool.getSupplementalContext({symbol:'AMD',missingFields:['totalRevenue'],periods:{annual:5,quarterly:4}});
 assert.equal(args[0],'AMD');assert.equal(args[3],false);assert.equal(r.supplementalObservations[0].currency,'TWD');assert.equal(r.supplementalObservations[0].sourceName,'Yahoo Finance');assert.equal(r.supplementalObservations[0].sourceDataDate,'2026-10-05');
 const result=[{tool:'get_supplemental_context',result:r}], good='Yahoo Finance data 2026-10-05: revenue for 2025-12-31 was TWD 123.';
 assert.deepEqual(q.audit(good,result),[]);assert.ok(q.audit('SEC-verified revenue was TWD 123.',result).length);assert.ok(q.audit('Revenue was TWD 999.',result).length);
});
test('newest requested periods are retained; a business request does not overwrite shared gaps',async()=>{
 const gaps=[{field:'netIncome',state:'missing',reason:'Not disclosed'}];
 verified.getCompanyEvidence=async()=>({statements:null,data:{supplementalObservations:[2021,2022,2023,2024,2025].map((year,i)=>({...provider(i),periodStart:year+'-01-01',periodEnd:year+'-12-31'}))},remainingGaps:gaps});
 const r=await tool.getSupplementalContext({symbol:'AMD',missingFields:['totalRevenue'],missingSections:['business','segments'],periods:{annual:2,quarterly:0}});
 assert.deepEqual(r.supplementalObservations.map(f=>f.periodEnd),['2025-12-31','2024-12-31']);assert.equal(gaps.length,1);assert.ok(r.remainingGaps.some(g=>g.section==='business'));assert.ok(r.remainingGaps.some(g=>g.section==='segments'));assert.ok(Buffer.byteLength(JSON.stringify(r))<=60000);
});
test('funds and unresolved identities cannot borrow company observations',async()=>{
 verified.getCompanyEvidence=async()=>{throw Error('Must not call');};
 for(const symbol of ['NEA','NO_SUCH_TICKER'])assert.ok((await tool.getSupplementalContext({symbol})).error);
});
test('financial retrieval failures never authorise invented numbers',()=>{
 const failed=[{tool:'get_supplemental_context',result:{remainingGaps:[{field:'totalRevenue',state:'retrieval_failed'}]}}];
 assert.ok(q.audit('Revenue was USD 999 billion.',failed).length);
 assert.deepEqual(q.audit('Revenue could not be retrieved; the provider failed.',failed),[]);
});
test('business-only supplementation returns a bounded description without repeating financial history',async()=>{
 verified.getCompanyEvidence=async()=>({statements:null,data:{supplementalObservations:[provider()],businessProfile:{overview:{Description:'Products and customers. '.repeat(600)},sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/profile/',retrievedAt:'2026-10-05T00:00:00Z'}}});
 const r=await tool.getSupplementalContext({symbol:'AMD',missingSections:['business']});assert.deepEqual(r.observations,[]);assert.deepEqual(r.supplementalObservations,[]);assert.deepEqual(r.calculations,[]);assert.equal(r.businessContext.text.length,9000);assert.equal(r.businessContext.effectiveDate,null);
});
test('industry fields are recognised and unsupported identifiers remain explicit gaps',async()=>{
 let fields;verified.getCompanyEvidence=async(symbol,requested)=>{fields=requested;return {statements:null,data:{}};};
 const r=await tool.getSupplementalContext({symbol:'O',missingFields:['ffo','inventedField']});assert.deepEqual(fields,['ffo']);assert.ok(r.remainingGaps.some(g=>g.field==='inventedField'&&/No supported mapping/.test(g.reason)));
});
test('unverified listing per-share bases are withheld from supplements',async()=>{
 verified.getCompanyEvidence=async()=>({statements:null,data:{coverage:{perShareAllowed:false},supplementalObservations:[{...provider(),field:'eps',unit:'TWD/shares'}]}});
 const r=await tool.getSupplementalContext({symbol:'TSM',missingFields:['eps']});assert.deepEqual(r.supplementalObservations,[]);assert.ok(r.remainingGaps.some(g=>/ADR basis/.test(g.reason)));
});
