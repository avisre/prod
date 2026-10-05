'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
const engine=require('../ai-chat'),quality=require('../ask-answer-quality'),report=require('../ask-report-evidence');

// Reviewed original AMD FY2025 10-K MD&A, retrieved 2026-10-05. The live
// correction used its prior-year cash amount but the prose audit rejected it.
const url='https://www.sec.gov/Archives/edgar/data/2488/000000248826000018/amd-20251227.htm';
const original={symbol:'AMD',sourceType:'sec_filing_context',sourceUrl:url,filing:{url,accession:'0000002488-26-000018',form:'10-K',date:'2026-02-04'},retrievedAt:'2026-10-05T13:00:00Z',sections:[{heading:'MD&A',text:'Cash, cash equivalents and short-term investments as of December 27, 2025 were $10.6 billion, compared to $5.1 billion at the end of 2024. Our aggregate principal amount of total debt as of December 27, 2025 was $3.3 billion, compared to $1.8 billion as of December 28, 2024.'}]};
const financial=async()=>({tool:'get_financials',result:report.expand(await engine.runTool('get_financials',{symbol:'AMD',statement:'income',basis:'annual',limit:5},{companyReportEvidence:true}))});
test('original dated business amounts are claimable in their own context, without becoming chart observations',async()=>{
 const results=[await financial(),{tool:'get_key_points',result:original}];
 assert.deepEqual(quality.numericClaims('Cash and short-term investments of $10.6bn, up from $5.1bn a year earlier.',results),[]);
 assert.deepEqual(quality.numericClaims('Debt was $3.3bn, compared with $1.8bn in the prior period.',results),[]);
 assert.ok(quality.numericClaims('Revenue was $5.1bn.',results).length,'a cash amount cannot establish revenue');
 assert.ok(quality.numericClaims('Cash was $5.5bn.',results).length,'an unsupplied amount still fails');
 assert.deepEqual(quality.numericClaims('Cash was $5.1bn at the end of 2024.',results),[]);
 assert.ok(quality.numericClaims('Cash was $5.1bn at the end of 2025.',results).length,'an explicitly mismatched period still fails');
 assert.ok(!quality.chartEvidence(results).some(f=>f.value===5100000000),'narrative amounts do not become typed chart inputs');
});
test('generated summaries, mismatched filing identities and unbound sources cannot establish business amounts',async()=>{
 const f=await financial();
 for(const altered of [{...original,sourceType:'generated_summary'},{...original,sourceUrl:'https://example.com/summary'}, {...original,filing:{...original.filing,accession:'0000002488-25-000012'}},{...original,filing:{...original.filing,date:null}}, {...original,sections:[{heading:'MD&A',points:[original.sections[0].text]}]}])assert.ok(quality.numericClaims('Cash was $5.1bn.',[f,{tool:'get_key_points',result:altered}]).length);
});
test('foreign filing dollar amounts require a compatible currency receipt and retain native currency',()=>{
 const foreign={...original,currencyEvidence:{currency:'CAD',excerpt:'Our financial statements are presented in Canadian dollars',sourceUrl:url},sections:[{text:'Cash was $5.1 billion.'}]};
 const attempt={tool:'get_financials',result:{observations:[]}};
 const results=[attempt,{tool:'get_key_points',result:foreign}];
 assert.deepEqual(quality.numericClaims('Cash was CAD 5.1bn.',results),[]);assert.ok(quality.numericClaims('Cash was USD 5.1bn.',results).length);
 assert.ok(quality.numericClaims('Cash was CAD 5.1bn.',[attempt,{tool:'get_key_points',result:{...foreign,currencyEvidence:undefined}}]).length);
});
test('repeated identical amounts keep their own context and conflicting currency evidence fails closed',()=>{
 const attempt={tool:'get_financials',result:{observations:[]}};
 const two={...original,currencyEvidence:{currency:'USD',excerpt:'Our financial statements are presented in US dollars',sourceUrl:url},sections:[{text:'Cash was $5.1 billion and debt was $5.1 billion.'}]};
 assert.deepEqual(quality.numericClaims('Debt was $5.1bn.',[attempt,{tool:'get_key_points',result:two}]),[]);
 const conflict={...two,sections:[{text:'Our financial statements are presented in Canadian dollars. Cash was $5.1 billion.'}]};
 assert.ok(quality.numericClaims('Cash was USD 5.1bn.',[attempt,{tool:'get_key_points',result:conflict}]).length);
});
test('a named business division retains its amount when the prose omits the word revenue',()=>{
 const context={...original,currencyEvidence:{currency:'USD',excerpt:'Our financial statements are presented in US dollars',sourceUrl:url},sections:[{text:'Client and Gaming segment net revenue of $14.6 billion in 2025 increased compared to the prior period.'}]};
 const results=[{tool:'get_financials',result:{observations:[]}},{tool:'get_key_points',result:context}];
 assert.deepEqual(quality.numericClaims('- Client and Gaming: **$14.6bn**, driven by processor sales.',results),[]);
 assert.ok(quality.numericClaims('- Data Center: **$14.6bn**.',results).length,'a different named division cannot borrow the amount');
});
