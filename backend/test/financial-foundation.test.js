'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extract}=require('../sec-facts'),p=require('../sec-coverage'),{fixture,ACC}=require('./fixtures/sec-fixture');
test('real AMD and Broadcom Q4 income is derived with both original source observations',()=>{
 for(const [symbol,end,revenue]of [['AMD','2025-12-27',10270000000],['AVGO','2025-11-02',18015000000]]) {
  const f=require('./fixtures/sec-original/'+symbol+'.json');const data=extract(f.facts,f.evidence,{asOf:'2026-10-04'}),row=data.income.quarterlyReports.find(r=>r.fiscalDateEnding===end);assert.equal(row.totalRevenue,revenue);assert.equal(row._derivations.totalRevenue.formula,'ytd_difference');assert.equal(row._sources.totalRevenue.length,2);assert.ok(p.verifiedField(data,row,'totalRevenue'));assert.equal(row.dilutedEPS,null);
 }
});
test('real bank net revenue uses compatible reported net interest and noninterest income',()=>{
 const f=require('./fixtures/sec-original/JPM.json');const data=extract(f.facts,{...f.evidence,sic:'6021'},{asOf:'2026-10-04'});const row=data.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31');assert.ok(row.totalRevenue>0);assert.equal(row.totalRevenue,row.netInterestIncome+row.nonInterestIncome);assert.equal(row._derivations.totalRevenue.formula,'sum_fields');assert.ok(p.verifiedField(data,row,'totalRevenue'));
 const other=extract(f.facts,{...f.evidence,sic:'2834'},{asOf:'2026-10-04'});assert.equal(other.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31').totalRevenue,null);
});
test('debt components sum only when current maturities and noncurrent borrowing are separately supplied',()=>{
 const {doc,evidence}=fixture();const gaap=doc.facts['us-gaap'];for(const [tag,val]of [['ShortTermBorrowings',10],['LongTermDebtCurrent',20],['LongTermDebtNoncurrent',100]])gaap[tag]={units:{USD:[{val,end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};
 let d=extract(doc,evidence,{asOf:'2026-10-04'}),row=d.balance.annualReports[0];assert.equal(row.shortTermDebt,30);assert.equal(row.longTermDebt,100);assert.equal(row.shortLongTermDebtTotal,130);assert.ok(p.verifiedField(d,row,'shortLongTermDebtTotal'));
 delete gaap.LongTermDebtCurrent;d=extract(doc,evidence,{asOf:'2026-10-04'});assert.equal(d.balance.annualReports[0].shortLongTermDebtTotal,null);
});
test('quarter derivation rejects mismatched fiscal starts and annual-only amendments',()=>{
 const {doc,evidence}=fixture();const r=doc.facts['us-gaap'].Revenues.units.USD[0];r.val=100;doc.facts['us-gaap'].Revenues.units.USD.push({...r,start:'2025-01-02',end:'2025-09-30',val:70,form:'10-Q',filed:'2025-11-01',accn:'0000000123-25-000001'});
 let data=extract(doc,evidence,{asOf:'2026-10-04'});assert.ok(!data.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31') || data.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31').totalRevenue===null);
 doc.facts['us-gaap'].Revenues.units.USD[1].start='2025-01-01';r.form='10-K/A';data=extract(doc,evidence,{asOf:'2026-10-04'});assert.ok(!data.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31') || data.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31').totalRevenue===null);
});
test('listing outcomes distinguish confirmed funds and uncertain names while retaining legacy URLs',()=>{
 const {securityType}=require('../../scripts/lib/us-listings');assert.equal(securityType({symbol:'CEF',name:'Income Trust - Closed End Fund'}),'closed_end_fund');assert.equal(securityType({symbol:'SPACU',name:'Acquisition Corporation - Unit.'}),'unit');
});

test('stale and future exchange-directory snapshots are rejected',()=>{
 const {validateTimestamp}=require('../../scripts/lib/us-listings'),now=Date.parse('2026-10-05T06:00:00Z');
 assert.equal(validateTimestamp('File Creation Time: 1002202621:31',now),'2026-10-02T21:31:00.000Z');
 for(const stamp of ['0901202621:31','1009202621:31','0231202621:31','broken'])assert.throws(()=>validateTimestamp('File Creation Time: '+stamp,now),/timestamp/);
});
test('Yahoo statement shapers do not substitute differently defined financial concepts',()=>{
 const y=require('../yahoo-source');
 const row=y.buildBalanceReportsFromFTS([{date:'2025-12-31',currentDebt:30,leases:1,grossPPE:99,totalEquityGrossMinorityInterest:100,shareIssued:10}])[0];
 assert.equal(row.shortTermDebt,'30');for(const field of ['currentLongTermDebt','capitalLeaseObligations','propertyPlantEquipment','totalShareholderEquity','commonStockSharesOutstanding'])assert.equal(row[field],'');
 const cash=y.buildCashReportsFromFTS([{date:'2025-12-31',cashDividendsPaid:-10,cashFlowFromContinuingOperatingActivities:90,netIncomeFromContinuingOperations:50}])[0];
 assert.equal(cash.dividendPayout,'-10');for(const field of ['dividendPayoutCommonStock','operatingCashflow','netIncome'])assert.equal(cash[field],'');
 const income=y.buildIncomeReportsFromFTS([{date:'2025-12-31',netIncomeCommonStockholders:20}])[0];assert.equal(income.comprehensiveIncomeNetOfTax,'');
});

test('legacy quote responses retain exact provider timestamps and closed-market/NAV labels',()=>{
 const q=require('../yahoo-source').buildGlobalQuote('EX',{regularMarketPrice:12,regularMarketPreviousClose:10,regularMarketTime:new Date('2026-10-02T20:00:03Z'),marketState:'CLOSED'});assert.equal(q.marketData.asOf,'2026-10-02T20:00:03.000Z');assert.equal(q.marketData.freshness,'market_closed');assert.equal(q['Global Quote']['05. price'],'12');
 const nav=require('../yahoo-source').buildGlobalQuote('FUND',{quoteType:'MUTUALFUND',regularMarketPrice:12});assert.equal(nav.marketData.asOf,null);assert.equal(nav.marketData.freshness,'dated_nav');
});
