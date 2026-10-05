'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../sec-coverage'),{extract}=require('../sec-facts'),{mergeFacts}=require('../sec-original');
const {fixture,CIK,ACC}=require('./fixtures/sec-fixture');
test('reviewed Realty Income FFO reconciles; AFFO retains undefined table inputs',()=>{
 const fixture=require('./fixtures/sec-original/O.json'),original=require('./fixtures/sec-original/O-inline.json').original;
 const data=extract(mergeFacts(fixture.facts,original),fixture.evidence,{asOf:'2026-10-04'});
 const ffo=data.industryObservations.find(f=>f.field==='ffo' && f.periodEnd==='2025-12-31'),affo=data.industryObservations.find(f=>f.field==='affo' && f.periodEnd==='2025-12-31');
 assert.equal(ffo.value,3860323000);assert.equal(affo.value,3885898000);assert.equal(ffo.reconciliation.status,'reconciled');assert.equal(affo.reconciliation.status,'reported_table_with_undefined_inputs');
 assert.ok(require('../sec-industry-tables').validObservation(ffo,data.cik));
 const altered=structuredClone(ffo);altered.value++;assert.equal(require('../sec-industry-tables').validObservation(altered,data.cik),false);
});
test('segment eliminations remain signed and incomplete groups remain partial',()=>{
 const {doc,evidence}=fixture();doc.facts['us-gaap'].Revenues.units.USD[0].val=100;
 const data=extract(doc,evidence,{asOf:'2026-10-04'});
 const rows=[['x:ProductsMember',110],['x:EliminationsMember',-10]].map(([member,val])=>({val,start:'2025-01-01',end:'2025-12-31',unit:'USD',accn:ACC,taxonomy:'us-gaap',filed:'2026-02-01',_original:{dimensions:[{axis:'x:StatementBusinessSegmentsAxis',member}],decimals:'0',contextRef:member,documentUrl:'https://www.sec.gov/report.htm'}}));
 const filing={url:'https://www.sec.gov/report.htm'};
 let result=require('../sec-segment-observations').extract(rows,data,filing);assert.equal(result[0].reconciliationStatus,'reconciled');assert.equal(result[0].entries[1].value,-10);
 result=require('../sec-segment-observations').extract(rows.slice(0,1),data,filing);assert.equal(result[0].reconciliationStatus,'partial');assert.equal(result[0].sum,110);
});
test('incompatible legacy quarters are retained as superseded evidence without changing valid annual values',()=>{
 const {doc,evidence}=fixture();const data=extract(doc,evidence,{asOf:'2026-10-04'});const annual=data.income.annualReports[0];
 const invalid=structuredClone(annual);invalid.periodType='quarterly';invalid.periodStart='2025-10-01';invalid._derivations.totalRevenue={formula:'ytd_difference',inputValues:[0,0]};data.income.quarterlyReports.push(invalid);
 const result=require('../../scripts/normalize-financial-source-ids').sanitize(data);assert.ok(result.excluded>0);assert.equal(annual.totalRevenue,0);assert.equal(invalid.totalRevenue,null);assert.equal(invalid._superseded.totalRevenue.value,0);assert.equal(invalid._states.totalRevenue,'conflicting_evidence');assert.deepEqual(p.validateFinancial(data,CIK),[]);
});
test('newer issuer-release inline figures stay separately attributed with their actual period and basis',()=>{
 const {doc}=fixture();const release={...doc,originalDocument:{url:'https://www.sec.gov/Archives/edgar/data/123/'+ACC.replace(/-/g,'')+'/release.htm',accessionNumber:ACC,filingDate:'2026-02-01'}};
 doc.facts['us-gaap'].Revenues.units.USD[0]._original={contextRef:'reported'};
 const values=require('../issuer-release').observations(release,CIK,['totalRevenue']);assert.equal(values.length,1);assert.equal(values[0].value,0);assert.equal(values[0].sourceType,'issuer_release');assert.equal(values[0].accountingBasis,'US GAAP');
 const filed={...values[0],sourceType:'sec_filing',value:100};assert.deepEqual(require('../company-observations').reconcile([filed],values),[]);
 const adjusted={...values[0],accountingBasis:'issuer-adjusted'};assert.equal(require('../company-observations').reconcile([filed],[adjusted]).length,1);
});
test('cache export reads only the Render Mongo setting and never lists secrets',async()=>{
 let url;const {cacheUri}=require('../../scripts/promote-financial-cache');assert.equal(await cacheUri({env:{RENDER_API_KEY:'test-key',RENDER_SERVICE:'srv-test'},request:async u=>{url=u;return {ok:true,json:async()=>({envVar:{value:'mongodb://localhost/test'}})};}}),'mongodb://localhost/test');assert.match(url,/\/env-vars\/MONGODB_URI$/);
});
test('supplemental numbers pass the audit only with attribution; mixed financial chart sources fail',()=>{
 const q=require('../ask-answer-quality');
 const f={issuer:CIK,field:'totalRevenue',definition:'Reported revenue',value:100000000,scale:1,unit:'USD',currency:'USD',periodStart:'2025-01-01',periodEnd:'2025-12-31',basis:'annual',historyBasis:'annual',accountingBasis:'provider-reported',scope:'entity',statement:'income',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/EX/financials/',publicationDate:'2026-02-01',retrievedAt:'2026-02-01T00:00:00Z',sourceIds:['provider:test'],state:'available'};
 const results=[{tool:'get_financials',result:{supplementalObservations:[f]}}];
 assert.deepEqual(q.numericClaims('Revenue was USD 100 million (Yahoo Finance, 2026-02-01).',results),[]);
 assert.ok(q.numericClaims('Revenue was USD 999 million.',results).length);
 const source=q.audit('Revenue was USD 100 million.',results,{question:'Revenue?'});assert.ok(source.some(s=>s.includes('source name and date')));
 const sec={...f,value:90000000,periodStart:'2024-01-01',periodEnd:'2024-12-31',sourceType:'sec_filing',sourceName:'SEC',accountingBasis:'US GAAP'};results[0].result.supplementalObservations.push(sec);
 const text='```viz\n'+JSON.stringify({unit:'USD',title:'Revenue',series:[{name:'Revenue',points:[['2024-12-31',90000000],['2025-12-31',100000000]]}]})+'\n```';
 assert.ok(q.audit(text,results,{question:'Show revenue history.'}).some(s=>s.includes('do not splice')));
});
test('compatible supplemental ratios are validated; zero revenue remains undefined',()=>{
 const {calculate,validCalculation}=require('../company-calculations'),q=require('../ask-answer-quality');
 const common={issuer:CIK,definition:'Reported provider field',scale:1,unit:'USD',currency:'USD',periodStart:null,periodDefinition:'Provider fiscal annual period ending on its date',periodEnd:'2025-12-31',basis:'annual',historyBasis:'annual',accountingBasis:'provider-reported',scope:'entity',statement:'income',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/EX/financials/',publicationDate:null,sourceDataDate:'2026-10-04',sourceDateKind:'retrieval',retrievedAt:'2026-10-04T00:00:00Z',sourceVersions:['one-row'],state:'available'};
 const facts=[{...common,field:'totalRevenue',value:100,sourceIds:['rev']},{...common,field:'grossProfit',value:25,sourceIds:['gross']}];
 const c=calculate(facts)[0];assert.equal(c.value,25);assert.ok(validCalculation(c));assert.deepEqual(q.numericClaims('The gross margin is 25%.',[{result:{supplementalObservations:facts,calculations:[c]}}]),[]);
 assert.equal(validCalculation({...c,value:99}),false);facts[0].value=0;assert.equal(calculate(facts)[0].state,'undefined_calculation');
 facts[0].value=100;facts[1].currency='EUR';assert.deepEqual(calculate(facts),[]);
});
test('unreviewed numeric locale formats cannot turn original filing text into a figure',()=>{
 const n=require('../sec-inline-number').number;assert.equal(n({rawText:'1,234.56',format:'ixt:num-dot-decimal',scale:6}),1234560000);assert.equal(n({rawText:'1.234,56',format:'ixt:numcommadot',scale:6}),null);assert.equal(n({rawText:'1,23,4',format:'ixt:num-dot-decimal'}),null);
});

test('real AMD and Broadcom segment witnesses survive transport and remain auditable',()=>{
 const seg=require('../sec-segment-observations'),quality=require('../ask-answer-quality');
 for(const symbol of ['AMD','AVGO']){const fixture=require('./fixtures/sec-original/'+symbol+'.json'),original=require('./fixtures/sec-original/'+symbol+'-inline.json').original;const data=extract(mergeFacts(fixture.facts,original),fixture.evidence,{asOf:'2026-10-04'});const group=data.segmentObservations.find(g=>g.periodEnd===fixture.evidence.latestAnnual.reportDate && g.reconciliationStatus==='reconciled');assert.ok(group);assert.ok(seg.validGroup(group,data));const payload=seg.toolPayload(group,data,symbol);assert.ok(payload.storedSegmentsReceipt);assert.ok(seg.validGroup(payload.storedSegmentsReceipt,payload.financialWitness));assert.equal(payload.verificationStatus,'reconciled');assert.ok(payload.segments.every(s=>s.name));const altered=structuredClone(payload.storedSegmentsReceipt);altered.entries[0].value++;assert.equal(seg.validGroup(altered,payload.financialWitness),false);}
});

test('provider-only charts and fallback receipts use retrieval dates without claiming SEC verification',()=>{
 const q=require('../ask-answer-quality'),f={issuer:CIK,field:'totalRevenue',definition:'Reported revenue',value:100000000,scale:1,unit:'USD',currency:'USD',periodStart:null,periodDefinition:'Provider fiscal annual period',periodEnd:'2025-12-31',basis:'annual',historyBasis:'annual',accountingBasis:'provider-reported',scope:'entity',statement:'income',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/EX/financials/',publicationDate:null,sourceDataDate:'2026-10-04',sourceDateKind:'retrieval',retrievedAt:'2026-10-04T00:00:00Z',sourceIds:['provider:test'],state:'available'};
 const results=[{tool:'get_financials',result:{symbol:'EX',statement:'income',supplementalObservations:[f]}}];
 const chart='```viz\n'+JSON.stringify({unit:'USD',title:'Revenue — Yahoo Finance, 2026-10-04',series:[{name:'Revenue',points:[['2025-12-31',100000000]]}]})+'\n```';assert.ok(!q.audit(chart,results,{question:'Revenue history?'}).some(s=>s.includes('provider and data date')));
 const receipt=q.fallback(results,'Revenue?');assert.match(receipt,/Yahoo Finance 2026-10-04/);assert.match(receipt,/100000000/);assert.doesNotMatch(receipt,/verified SEC evidence/);assert.deepEqual(q.audit(receipt,results,{question:'Revenue?'}),[]);
 assert.ok(q.audit('SEC-verified revenue was USD 100 million (Yahoo Finance 2026-10-04).',results,{question:'Revenue?'}).some(s=>s.includes('must not be described as SEC-verified')));
});
