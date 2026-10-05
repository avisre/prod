'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../ask-report-policy'),v=require('../ask-visualization'),q=require('../ask-answer-quality');
const result=(currency='USD')=>({tool:'get_financials',result:{symbol:'AMD',statement:'income',basis:'annual',currency,observations:[2021,2022,2023,2024,2025].map((year,i)=>({periodEnd:year+'-12-31',currency,fields:{totalRevenue:{value:i===0?0:100*(i+1),unit:currency,sourceIds:['revenue'+i]},netIncome:{value:i+1,unit:currency,sourceIds:['profit'+i]}}}))}});
test('a omitted chart is supplied from validated observations, with reported zero and all five periods',()=>{
 const results=[result()], text=v.ensure('Business explanation.\n\n> Next: What drives revenue?',results,p.select('AMD'));
 const spec=v.specs(text)[0];assert.equal(spec.type,'viz');assert.equal(spec.series[0].points.length,5);assert.equal(spec.series[0].points[0][1],0);assert.deepEqual(q.audit(text,results,{question:'Show annual revenue'}),[]);assert.ok(text.indexOf('```')<text.indexOf('> Next:'));
});
test('model visual choice, placement and multiple visuals are retained when valid',()=>{
 const spec={title:'Annual revenue',unit:'USD',orientation:'vertical',series:[{name:'Revenue',points:result().result.observations.map(o=>[o.periodEnd,o.fields.totalRevenue.value])}]};
 const text='My chosen structure.\n```bars\n'+JSON.stringify(spec)+'\n```';assert.equal(v.ensure(text,[result()],p.select('AMD')),text);
});
test('split scales convert to faceted bars without altering any values',()=>{
 const r=result(), points=field=>r.result.observations.map(o=>[o.periodEnd,o.fields[field].value]);
 const spec={title:'Annual metrics',unit:'USD',facet:true,series:[{name:'Revenue',points:points('totalRevenue')},{name:'Net income',points:points('netIncome')}]};
 const normalized=q.normalizeFacetedViz('```viz\n'+JSON.stringify(spec)+'\n```');assert.match(normalized,/```bars/);assert.deepEqual(v.specs(normalized)[0].series,spec.series);assert.deepEqual(q.audit(normalized,[r],{question:'Show annual revenue'}),[]);
});
test('no invented chart on absent data; incompatible currencies remain separate',()=>{
 assert.equal(v.ensure('History is unavailable.',[],p.select('AMD')),'History is unavailable.');
 const r=result();r.result.observations[1].fields.totalRevenue.unit='EUR';r.result.observations[1].currency='EUR';
 const text=v.ensure('Business.',[r],p.select('AMD')), spec=v.specs(text)[0];assert.equal(spec.unit,'USD');assert.ok(spec.series[0].points.every(p=>p[0]!=='2022-12-31'));assert.deepEqual(q.audit(text,[r],{question:'Show annual revenue'}),[]);
});
test('model quarterly visuals do not replace the required available annual trend',()=>{
 const text='```bars\n'+JSON.stringify({unit:'USD',rows:[['Revenue as of 2025-12-31',500]]})+'\n```';
 assert.equal(v.specs(v.ensure(text,[result()],p.select('AMD'))).length,2);
});
test('a single supplied annual observation yields a useful single-value bar',()=>{
 const r=result();r.result.observations=r.result.observations.slice(-1);const text=v.ensure('One reported period.',[r],p.select('AMD'));assert.equal(v.specs(text)[0].type,'bars');assert.deepEqual(q.audit(text,[r],{question:'Show annual revenue'}),[]);
});
test('a compatible attributed provider annual series can fill a chart when filed history is insufficient',()=>{
 const r=result();r.result.observations=r.result.observations.slice(-1);
 const provider={issuer:'0000002488',field:'totalRevenue',definition:'Provider revenue',scale:1,unit:'USD',currency:'USD',basis:'annual',accountingBasis:'provider-reported',scope:'entity',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/financials/',sourceDataDate:'2026-10-05',sourceDateKind:'retrieval',retrievedAt:'2026-10-05T00:00:00Z',state:'available'};
 const supplemental={tool:'get_supplemental_context',result:{supplementalObservations:[2021,2022,2023,2024,2025].map((year,i)=>({...provider,value:(i+1)*100,periodStart:year+'-01-01',periodEnd:year+'-12-31',sourceIds:['provider'+i]}))}};
 const text=v.ensure('Financial history.',[r,supplemental],p.select('AMD')), spec=v.specs(text)[0];assert.equal(spec.series[0].points.length,5);assert.match(spec.title,/Yahoo Finance data 2026-10-05/);assert.deepEqual(q.audit(text,[r,supplemental],{question:'Show annual revenue'}),[]);
});
test('a dated quote supports a single price bar with visible attribution and date',()=>{
 const fact={issuer:'listing:AMD',field:'price',definition:'Dated price per share',value:100,scale:1,unit:'USD',currency:'USD',periodEnd:'2026-10-02',basis:'market',accountingBasis:'market quote',scope:'listed share',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/AMD/',publicationDate:'2026-10-02',retrievedAt:'2026-10-05T00:00:00Z',sourceIds:['quote'],state:'available'};
 const results=[{tool:'get_quote',result:{symbol:'AMD',marketObservations:[fact]}}],text=v.ensure('Dated price.',results,{...p.select('AMD price','analyst',{company:{symbol:'AMD',securityType:'stock'}}),visualRequired:true,question:'AMD price'});assert.match(text,/```bars/);assert.match(text,/Yahoo Finance data 2026-10-02/);assert.deepEqual(q.audit(text,results,{question:'AMD price'}),[]);
});
test('a rapidly growing single metric remains a line chart, and visual count is chosen freely',()=>{
 const r=result();r.result.observations[0].fields.totalRevenue.value=1;
 const spec={title:'Annual revenue',unit:'USD',series:[{name:'Revenue',points:r.result.observations.map(o=>[o.periodEnd,o.fields.totalRevenue.value])}]};
 const chart='```viz\n'+JSON.stringify(spec)+'\n```';assert.equal(q.normalizeFacetedViz(chart),chart);assert.deepEqual(q.audit(chart,[r]),[]);
 assert.deepEqual(q.audit(Array.from({length:4},()=>chart).join('\n\n'),[r]),[]);
});
