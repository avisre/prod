'use strict';
// Segment profit and assets read beside the segment revenue table, for the company page's
// "Product segments" view (Screener's Profit % and return columns). As filed, one measure per company.
const test=require('node:test'),assert=require('node:assert/strict');
const {extract}=require('../sec-facts'),seg=require('../sec-segment-observations');
const {fixture,ACC,CIK}=require('./fixtures/sec-fixture');
const URL='https://www.sec.gov/Archives/edgar/data/'+Number(CIK)+'/'+ACC.replace(/-/g,'')+'/report.htm';
const AXIS='us-gaap:StatementBusinessSegmentsAxis';
const fact=(concept,member,val,{start='2025-01-01',end='2025-12-31',extra=[]}={})=>({concept,taxonomy:'us-gaap',val,...(start?{start}:{}),end,unit:'USD',accn:ACC,filed:'2026-02-01',
 _original:{dimensions:[{axis:AXIS,member}],allDimensions:[{axis:AXIS,member},...extra],decimals:'0',contextRef:concept+member+end+extra.length,documentUrl:URL,numericReceipt:{rawText:String(Math.abs(val)),scale:0,sign:val<0?'-':undefined}}});
const setup=()=>{const {doc,evidence}=fixture();doc.facts['us-gaap'].Revenues.units.USD[0].val=100;return extract(doc,evidence,{asOf:'2026-10-04'});};
const revenue=[['x:AMember',70],['x:BMember',30]].map(([m,v])=>fact('Revenues',m,v));

test('segment profit is attached with its receipt, preferring profit before tax, and passes validation',()=>{
 const data=setup();
 const rows=[...revenue,fact('OperatingIncomeLoss','x:AMember',20),fact('OperatingIncomeLoss','x:BMember',5),
  fact('IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','x:AMember',18),
  fact('IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest','x:BMember',-4),
  fact('Assets','x:AMember',500,{start:null}),fact('Assets','x:BMember',100,{start:null})];
 const [g]=seg.extract(rows,data,{url:URL});
 assert.equal(g.profit.measure,'profit before tax');
 assert.deepEqual(Object.fromEntries(Object.entries(g.profit.values).map(([m,v])=>[m,v.value])),{'x:AMember':18,'x:BMember':-4});
 assert.equal(g.assets.values['x:BMember'].value,100);
 assert.equal(g.entries.length,2,'profit and assets never become revenue rows');
 const t=seg.statementTable([g]);
 assert.deepEqual(t.rows.map(r=>[r.sales[0],r.profit[0],r.assets[0]]),[[70,18,500],[30,-4,100]]);
 assert.equal(t.profitMeasure,'profit before tax');
});

test('a tampered profit figure fails validation',()=>{
 const data=setup();
 const rows=[...revenue,fact('OperatingIncomeLoss','x:AMember',20),fact('OperatingIncomeLoss','x:BMember',5)];
 const [g]=seg.extract(rows,data,{url:URL});
 assert.equal(g.profit.measure,'operating profit');
 const bad=structuredClone(g);bad.profit.values['x:AMember'].value=21;
 assert.equal(seg.validGroup(g,data),true);
 assert.equal(seg.validGroup(bad,data),false,'a profit value that disagrees with its receipt');
 const stray=structuredClone(g);stray.profit.values['x:CMember']=stray.profit.values['x:AMember'];
 assert.equal(seg.validGroup(stray,data),false,'a profit row for a member the table does not have');
 const swapped=structuredClone(g);swapped.profit.concept='us-gaap:Revenues';assert.equal(seg.validGroup(swapped,data),false,'only a profit concept');
 assert.equal(seg.segmentMetric('us-gaap','OperatingIncomeLoss'),'profit');
 assert.equal(seg.segmentMetric('us-gaap','Assets'),'assets');
 assert.equal(seg.segmentMetric('us-gaap','Revenues'),null);
});

test('a member filed with two profit figures in one view is left out, and one row alone is no profit table',()=>{
 const data=setup();
 const rows=[...revenue,fact('OperatingIncomeLoss','x:AMember',20),fact('OperatingIncomeLoss','x:AMember',22)];
 const [g]=seg.extract(rows,data,{url:URL});
 assert.equal(g.profit,undefined);
 // The figure on the segment axis alone wins over the one filed under a further consolidation view.
 const view=[...revenue,fact('OperatingIncomeLoss','x:AMember',20),fact('OperatingIncomeLoss','x:AMember',26,{extra:[{axis:'srt:ConsolidationItemsAxis',member:'us-gaap:OperatingSegmentsMember'}]}),fact('OperatingIncomeLoss','x:BMember',5)];
 const [h]=seg.extract(view,data,{url:URL});
 assert.equal(h.profit.values['x:AMember'].value,20);
});
