'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('statement consumers preserve source-backed reported zeros',()=>{
 const repaired=require('../income-statement').repairIncome({totalRevenue:100,grossProfit:0,costOfRevenue:100,operatingIncome:0,operatingExpenses:0,incomeTaxExpense:0,_sources:{grossProfit:['gp'],costOfRevenue:['cost'],operatingIncome:['op'],operatingExpenses:['opex'],incomeTaxExpense:['tax']}});
 assert.equal(repaired.grossProfit,0);assert.equal(repaired.operatingIncome,0);assert.equal(repaired.tax,0);
});
test('debt calculations never double-count current maturities or replace missing components with zero',()=>{
 const {totalDebt,liquidCash}=require('../financial-row');assert.equal(totalDebt({shortTermDebt:30,currentLongTermDebt:20,longTermDebt:100}),130);assert.equal(totalDebt({shortLongTermDebtTotal:0}),0);assert.equal(totalDebt({longTermDebt:100}),null);assert.equal(totalDebt({_sources:{},shortTermDebt:30,longTermDebt:100}),null);assert.equal(liquidCash({cashAndCashEquivalentsAtCarryingValue:20}),null);
});
test('dossier history keeps missing figures null and exact fiscal periods distinct',()=>{
 const {financialHistory}=require('../dossier-analysis');
 const data={income:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'USD',totalRevenue:100,grossProfit:0,_sources:{grossProfit:['zero']}}]},balance:{annualReports:[{fiscalDateEnding:'2025-06-30',reportedCurrency:'USD',totalAssets:100,totalShareholderEquity:100}]},cash:{annualReports:[]}};
 const row=financialHistory(data).find(r=>r.periodEnd==='2025-12-31');assert.equal(row.grossMarginPct,0);assert.equal(row.netIncome,null);assert.equal(row.fcf,null);assert.equal(row.roaPct,null);assert.equal(row.debtToEquity,null);assert.equal(row.roicPct,null);
 assert.ok(!JSON.stringify(financialHistory(data)).includes('NaN'));
});
test('DCF with missing debt or liquidity returns a specific gap instead of assuming a zero balance',async()=>{
 const result=await require('../valuation-dcf').buildValuation('EX',{data:{overview:{MarketCapitalization:100},income:{annualReports:[]},balance:{annualReports:[]},cash:{annualReports:[]}}});assert.match(result.error,/missing inputs are not treated as zero/);
});
test('financial HTTP tools use the shared resolver and return its coverage and source metadata',async t=>{
 const p=require('../sec-coverage'),{fixture}=require('./fixtures/sec-fixture'),{doc,evidence}=fixture(),financial=require('../sec-facts').extract(doc,evidence);
 const adapter=require('../verified-fundamentals'),company=require('../stock-universe').lookup('AAPL'),data=adapter.adapt(company,{},financial,{financialCoverage:'ready',annualReportingStatus:'recent_annual'},{evidence});
 data.freshness={lastSuccessfulCheckAt:'2026-10-05T00:00:00Z',backgroundStatus:'idle'};data.supplementalObservations=[];
 const before={disabled:process.env.SEC_COVERAGE_DISABLE_ON_DEMAND,readOnly:process.env.SEC_COVERAGE_READ_ONLY};process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='0';process.env.SEC_COVERAGE_READ_ONLY='0';t.after(()=>{for(const [name,value]of [['SEC_COVERAGE_DISABLE_ON_DEMAND',before.disabled],['SEC_COVERAGE_READ_ONLY',before.readOnly]])if(value===undefined)delete process.env[name];else process.env[name]=value;});
 let calls=0;t.mock.method(adapter,'getCompanyEvidence',async symbol=>{assert.equal(symbol,'AAPL');calls++;return {data};});
 const result=await require('../free-tools').getToolResult('earnings-quality','AAPL');assert.equal(calls,1);assert.equal(result.status,200);assert.equal(result.body.revenue,0);assert.equal(result.body.freshness.backgroundStatus,'idle');assert.deepEqual(result.body.supplementalObservations,[]);
});
