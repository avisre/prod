'use strict';
// A row as the sum of the parts one filing reports when it files no total line (sec-facts PART_SUMS).
// Measured 2026-11-05: FENC/SDEV file G&A and selling separately, Collegium files depreciation and
// intangible amortization separately; Fiserv files further D&A lines, so the two-part sum is refused.
const test=require('node:test');
const assert=require('node:assert/strict');
const {extract}=require('../sec-facts');
const p=require('../sec-coverage');
const CIK='0000000123',ACC='0000000123-26-000001';
const Q1='0000000123-25-000002',Q2='0000000123-25-000003';
function fixture(){
 const doc={cik:123,entityName:'Example',facts:{'us-gaap':{}}};
 const g=doc.facts['us-gaap'];
 const fy=(val,extra={})=>({val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01',...extra});
 g.Revenues={units:{USD:[fy(1000)]}};g.NetIncomeLoss={units:{USD:[fy(100)]}};
 g.Assets={units:{USD:[{val:500,end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};
 g.StockholdersEquity={units:{USD:[{val:200,end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};
 g.NetCashProvidedByUsedInOperatingActivities={units:{USD:[fy(150)]}};
 const evidence={cik:CIK,lastSuccessfulCheckAt:'2026-10-03',latestAnnual:{form:'10-K',filingDate:'2026-02-01',reportDate:'2025-12-31',accessionNumber:ACC,amendments:[]}};
 return {doc,g,fy,evidence};
}
const annual=d=>d.income.annualReports.find(r=>r.fiscalDateEnding==='2025-12-31');
const fact=(...rows)=>({units:{USD:rows}});

test('SG&A is G&A plus selling when the filing reports no SG&A line, and the validator proves it',()=>{
 const {doc,g,fy,evidence}=fixture();
 g.GeneralAndAdministrativeExpense=fact(fy(46));g.SellingAndMarketingExpense=fact(fy(31));
 const d=extract(doc,evidence,{asOf:'2026-10-03'}),r=annual(d);
 assert.equal(r.sellingGeneralAndAdministrative,77);
 assert.equal(r._derivations.sellingGeneralAndAdministrative.formula,'sum_of_parts');
 assert.equal(p.verifiedField(d,r,'sellingGeneralAndAdministrative'),true);
 r.sellingGeneralAndAdministrative=78;
 assert.equal(p.verifiedField(d,r,'sellingGeneralAndAdministrative'),false,'a value that is not the sum fails');
});

test('a filed SG&A total is used as filed, never replaced by a sum',()=>{
 const {doc,g,fy,evidence}=fixture();
 g.GeneralAndAdministrativeExpense=fact(fy(46));g.SellingAndMarketingExpense=fact(fy(31));
 g.SellingGeneralAndAdministrativeExpense=fact(fy(80));
 const r=annual(extract(doc,evidence,{asOf:'2026-10-03'}));
 assert.equal(r.sellingGeneralAndAdministrative,80);
 assert.equal(r._derivations?.sellingGeneralAndAdministrative,undefined);
});

test('D&A is depreciation plus intangible amortization; another D&A line in the filing refuses it (Fiserv)',()=>{
 const da=(extra)=>{const {doc,g,fy,evidence}=fixture();g.Depreciation=fact(fy(4));g.AmortizationOfIntangibleAssets=fact(fy(222));for(const [t,v] of extra)g[t]=fact(fy(v));const d=extract(doc,evidence,{asOf:'2026-10-03'});return {d,r:annual(d)};};
 const {d,r}=da([]);
 assert.equal(r.depreciationAndAmortization,226);assert.equal(p.verifiedField(d,r,'depreciationAndAmortization'),true);
 assert.equal(da([['OtherDepreciationAndAmortization',1857]]).r.depreciationAndAmortization ?? null,null,'Fiserv-like extra D&A line');
 assert.equal(da([['CostOfGoodsAndServicesSoldAmortization',222]]).r.depreciationAndAmortization,226,'the same amortization shown inside cost of sales (Collegium)');
 assert.equal(da([['CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization',95]]).r.depreciationAndAmortization,226,'a cost line that excludes D&A');
 assert.equal(da([['AmortizationOfDebtDiscountPremium',5]]).r.depreciationAndAmortization,226,'debt discount amortization is not D&A');
});

test('a quarter is the year-to-date sum of the parts less the previous year-to-date sum',()=>{
 const {doc,g,fy,evidence}=fixture();
 const q=(val,accn,start,end,filed)=>({val,start,end,accn,form:'10-Q',filed});
 g.Revenues.units.USD.push(q(240,Q1,'2025-01-01','2025-03-31','2025-05-01'),q(260,Q2,'2025-04-01','2025-06-30','2025-08-01'),q(500,Q2,'2025-01-01','2025-06-30','2025-08-01'));
 g.GeneralAndAdministrativeExpense=fact(fy(46),q(10,Q1,'2025-01-01','2025-03-31','2025-05-01'),q(22,Q2,'2025-01-01','2025-06-30','2025-08-01'));
 g.SellingAndMarketingExpense=fact(fy(31),q(7,Q1,'2025-01-01','2025-03-31','2025-05-01'),q(15,Q2,'2025-01-01','2025-06-30','2025-08-01'));
 const d=extract(doc,evidence,{asOf:'2026-10-03'});
 const q1=d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-03-31'),q2=d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-06-30');
 assert.equal(q1.sellingGeneralAndAdministrative,17);assert.equal(p.verifiedField(d,q1,'sellingGeneralAndAdministrative'),true);
 assert.equal(q2.sellingGeneralAndAdministrative,20);
 assert.equal(q2._derivations.sellingGeneralAndAdministrative.formula,'sum_of_parts_ytd_difference');
 assert.equal(p.verifiedField(d,q2,'sellingGeneralAndAdministrative'),true);
});
