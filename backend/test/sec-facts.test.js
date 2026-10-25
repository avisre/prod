'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {extract}=require('../sec-facts');
const p=require('../sec-coverage');
const CIK='0000000123',ACC='0000000123-26-000001';
function fixture(taxonomy='us-gaap',currency='USD') {
 const keys=taxonomy==='us-gaap'?['Revenues','NetIncomeLoss','Assets','StockholdersEquity','NetCashProvidedByUsedInOperatingActivities']:['Revenue','ProfitLossAttributableToOwnersOfParent','Assets','EquityAttributableToOwnersOfParent','CashFlowsFromUsedInOperatingActivities'];
 const doc={cik:123,entityName:'Example',facts:{[taxonomy]:{}}};
 for(const [i,k] of keys.entries())doc.facts[taxonomy][k]={units:{[currency]:[{val:i===0?0:100,start:[2,3].includes(i)?undefined:'2025-01-01',end:'2025-12-31',accn:ACC,form:taxonomy==='us-gaap'?'10-K':'20-F',filed:'2026-02-01'}]}};
 const evidence={cik:CIK,lastSuccessfulCheckAt:'2026-10-03',latestAnnual:{form:taxonomy==='us-gaap'?'10-K':'20-F',filingDate:'2026-02-01',reportDate:'2025-12-31',accessionNumber:ACC,amendments:[]}};
 return {doc,evidence};
}
test('US GAAP and IFRS extraction retain reported zero, exact accessions, native units and core completeness',()=>{
 for(const [tax,cur] of [['us-gaap','USD'],['ifrs-full','EUR']]){const {doc,evidence}=fixture(tax,cur);const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].totalRevenue,0);assert.equal(d.income.annualReports[0].reportedCurrency,cur);assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'ready');assert.equal(Object.values(d.sources)[0].accessionNumber,ACC);}
});
test('conflicting values from the same accession are missing rather than guessed',()=>{
 const {doc,evidence}=fixture();const arr=doc.facts['us-gaap'].NetIncomeLoss.units.USD;arr.push({...arr[0],val:999});const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].netIncome,null);assert.ok(d.issues.some(i=>i.code==='AMBIGUOUS_FACT'));assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'partial');
});
test('multiple currencies without SEC reporting currency do not borrow a provider stamp',()=>{
 const {doc,evidence}=fixture();for(const fact of Object.values(doc.facts['us-gaap']))fact.units.EUR=fact.units.USD.map(r=>({...r,val:222}));const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports.length,0);assert.ok(d.issues.some(i=>i.code==='AMBIGUOUS_CURRENCY'));
});
test('a later quarterly restatement cannot replace the qualifying annual cohort',()=>{
 const {doc,evidence}=fixture();const row=doc.facts['us-gaap'].NetIncomeLoss.units.USD[0];doc.facts['us-gaap'].NetIncomeLoss.units.USD.push({...row,val:777,form:'10-Q',filed:'2026-08-01',accn:'0000000123-26-000002'});const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].netIncome,100);
});
test('quarterly EPS is never inferred by subtracting YTD EPS',()=>{
 const {doc,evidence}=fixture();doc.facts['us-gaap'].EarningsPerShareDiluted={units:{'USD/shares':[{val:5,start:'2025-01-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:ACC},{val:2,start:'2025-01-01',end:'2025-03-31',filed:'2025-05-01',form:'10-Q',accn:ACC}]}};doc.facts['us-gaap'].Revenues.units.USD.push({val:10,start:'2025-04-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:ACC});const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-06-30').dilutedEPS,null);
});
test('identity mismatch is rejected before financial extraction',()=>{
 const {doc,evidence}=fixture();assert.throws(()=>extract({...doc,cik:456},evidence),/IDENTITY/);
});
test('an issuer filing investment-company highlights in a recent 10-K is marked as one; one tag or an old filing is not',()=>{
 const mark=(tags,filed='2026-02-01')=>{const {doc,evidence}=fixture();for(const t of tags)doc.facts['us-gaap'][t]={units:{USD:[{val:1,end:'2025-12-31',accn:ACC,form:'10-K',filed}]}};return extract(doc,evidence,{asOf:'2026-10-03'}).investmentCompany;};
 const bdc=['NetAssetValuePerShare','InvestmentCompanyTotalReturn','InvestmentCompanyExpenseRatioIncludingFeeWaiver','InvestmentCompanyInvestmentIncomeLossRatio'];
 assert.equal(mark(bdc),true);
 assert.equal(mark(bdc.slice(1)),undefined,'no net asset value per share');
 assert.equal(mark(bdc.slice(0,3)),undefined,'two ratios are not the highlights (Rapport Therapeutics files one)');
 assert.equal(mark(bdc,'2023-02-01'),undefined,'not filed in the last two years');
});
test('continuing-operations EPS fills EPS only when the filing reports no discontinued operations, and never displaces it',()=>{
 const eps=(extra)=>{const {doc,evidence}=fixture();const fact=(val,unit='USD/shares')=>({units:{[unit]:[{val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}});
  doc.facts['us-gaap'].IncomeLossFromContinuingOperationsPerDilutedShare=fact(1.5);doc.facts['us-gaap'].IncomeLossFromContinuingOperationsPerBasicShare=fact(1.6);
  for(const [t,v,u] of extra)doc.facts['us-gaap'][t]=fact(v,u);const d=extract(doc,evidence,{asOf:'2026-10-03'}),r=d.income.annualReports[0];return {d,r};};
 const {d,r}=eps([]);
 assert.equal(r.dilutedEPS,1.5);assert.equal(r.eps,1.6);assert.equal(p.verifiedField(d,r,'dilutedEPS'),true);
 assert.equal(eps([['IncomeLossFromDiscontinuedOperationsNetOfTaxPerDilutedShare',-0.2]]).r.dilutedEPS,null,'a discontinued per-share line');
 assert.equal(eps([['IncomeLossFromDiscontinuedOperationsNetOfTax',-20,'USD']]).r.eps,null,'a discontinued income line');
 assert.equal(eps([['EarningsPerShareDiluted',1.3]]).r.dilutedEPS,1.3,'the filed EPS line wins');
});
module.exports={fixture};

// Measured 2026-10-06: 1,104 stock issuers lacked a core figure in their newest
// annual report and whole companies were dropped from coverage for it.
const swap=(doc,from,to)=>{doc.facts['us-gaap'][to]=doc.facts['us-gaap'][from];delete doc.facts['us-gaap'][from];};
test('net revenues, utility revenue, partners capital and balance-sheet totals are read under the tags filers use',()=>{
 for(const tag of ['RevenuesNetOfInterestExpense','RegulatedAndUnregulatedOperatingRevenue']){const {doc,evidence}=fixture();swap(doc,'Revenues',tag);doc.facts['us-gaap'][tag].units.USD[0].val=500;assert.equal(extract(doc,evidence,{asOf:'2026-10-03'}).income.annualReports[0].totalRevenue,500,tag);}
 const {doc,evidence}=fixture();swap(doc,'StockholdersEquity','PartnersCapital');swap(doc,'Assets','LiabilitiesAndStockholdersEquity');
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.balance.annualReports[0].totalShareholderEquity,100);assert.equal(d.balance.annualReports[0].totalAssets,100);
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'ready');
});
test('a narrower tag stands in only when the filing shows no difference, and never displaces an original tag',()=>{
 let {doc,evidence}=fixture();swap(doc,'NetCashProvidedByUsedInOperatingActivities','NetCashProvidedByUsedInOperatingActivitiesContinuingOperations');swap(doc,'NetIncomeLoss','NetIncomeLossAvailableToCommonStockholdersBasic');
 let d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.cash.annualReports[0].operatingCashflow,100);assert.equal(d.income.annualReports[0].netIncome,100);
 const period={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'};
 doc.facts['us-gaap'].CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations={units:{USD:[{...period,val:7}]}};doc.facts['us-gaap'].DividendsPreferredStock={units:{USD:[{...period,val:3}]}};
 d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.cash.annualReports[0].operatingCashflow,107);assert.equal(d.income.annualReports[0].netIncome,null);
 ({doc,evidence}=fixture());doc.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivitiesContinuingOperations={units:{USD:[{...period,val:999}]}};
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03'}).cash.annualReports[0].operatingCashflow,100);
});
test('a dollar convenience translation of the current year does not hide the reporting currency',()=>{
 const {doc,evidence}=fixture('us-gaap','CNY');
 for(const fact of Object.values(doc.facts['us-gaap'])){const row=fact.units.CNY[0];fact.units.CNY.push({...row,...(row.start?{start:'2024-01-01'}:{}),end:'2024-12-31'});fact.units.USD=[{...row,val:row.val/7}];}
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].reportedCurrency,'CNY');assert.equal(d.income.annualReports[0].netIncome,100);
 assert.ok(!d.issues.some(i=>i.code==='AMBIGUOUS_CURRENCY' && i.periodEnd==='2025-12-31'));
});
test('net sales and other revenues are added only when gross profit plus cost of sales confirms the total',()=>{
 const build=gross=>{const {doc,evidence}=fixture('ifrs-full','EUR');delete doc.facts['ifrs-full'].Revenue;const f=(val)=>({units:{EUR:[{val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'20-F',filed:'2026-02-01'}]}});
  Object.assign(doc.facts['ifrs-full'],{RevenueFromSaleOfGoods:f(900),OtherRevenue:f(100),GrossProfit:f(gross),CostOfSales:f(300)});return {d:extract(doc,evidence,{asOf:'2026-10-03'}),evidence};};
 const ok=build(700);assert.equal(ok.d.income.annualReports[0].totalRevenue,1000);assert.deepEqual(p.validateFinancial(ok.d,CIK,'2026-10-03'),[]);
 assert.equal(build(650).d.income.annualReports[0].totalRevenue,null);
});
test('operating cash flow filed as continuing and discontinued parts is their sum',()=>{
 const {doc,evidence}=fixture();swap(doc,'NetCashProvidedByUsedInOperatingActivities','NetCashProvidedByUsedInOperatingActivitiesContinuingOperations');
 doc.facts['us-gaap'].CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations={units:{USD:[{val:-30,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.cash.annualReports[0].operatingCashflow,70);assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'ready');
});
// 187 covered companies were understated on 2026-10-06 because the customer-contract line won.
test('revenue is the largest revenue line of the filing, or net revenues where a financial firm reports them',()=>{
 const period={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'},f=val=>({units:{USD:[{...period,val}]}});
 const rev=(extra,sic)=>{const {doc,evidence}=fixture();if(sic)evidence.sic=sic;Object.assign(doc.facts['us-gaap'],extra);return extract(doc,evidence,{asOf:'2026-10-03'}).income.annualReports[0].totalRevenue;};
 assert.equal(rev({Revenues:f(10600),RevenueFromContractWithCustomerExcludingAssessedTax:f(900)}),10600);
 assert.equal(rev({Revenues:f(130),RevenueFromContractWithCustomerExcludingAssessedTax:f(980)}),980);
 assert.equal(rev({Revenues:f(126000),RevenuesNetOfInterestExpense:f(58000),RevenueFromContractWithCustomerExcludingAssessedTax:f(20000)},'6211'),58000);
 // The net-revenue tag on a manufacturer's filing is a mis-tag, not its top line (Kornit).
 assert.equal(rev({Revenues:f(193),RevenuesNetOfInterestExpense:f(77)},'3555'),193);
 // Including taxes collected is not a larger total; an exact x1000 line is a scale slip; equal confirmed lines are one total.
 assert.equal(rev({RevenueFromContractWithCustomerExcludingAssessedTax:f(146),RevenueFromContractWithCustomerIncludingAssessedTax:f(193)}),146);
 assert.equal(rev({RevenueFromContractWithCustomerExcludingAssessedTax:f(1436),SalesRevenueNet:f(1436000)}),1436);
 assert.equal(rev({Revenues:f(8562),RevenueFromContractWithCustomerExcludingAssessedTax:f(8562),RevenueFromContractWithCustomerIncludingAssessedTax:f(8273),GrossProfit:f(3212),CostOfRevenue:f(5350),OperatingIncomeLoss:f(1009),SellingGeneralAndAdministrativeExpense:f(1911)}),8562);
 assert.equal(rev({Revenues:f(500)}),500);
 // A gap under a fifth with nothing to arbitrate keeps the original line.
 assert.equal(rev({Revenues:f(1900),RevenueFromContractWithCustomerExcludingAssessedTax:f(1660)}),1660);
 // StoneX: a small net figure beside a far larger total is not the top line.
 assert.equal(rev({Revenues:f(132000),RevenuesNetOfInterestExpense:f(2000)},'6200'),132000);
 // Sales before excise tax are larger, but gross profit plus cost names net sales as the total.
 assert.equal(rev({Revenues:f(9756),RevenueFromContractWithCustomerExcludingAssessedTax:f(9139),GrossProfit:f(4639),CostOfGoodsAndServicesSold:f(4500)}),9139);
 assert.equal(rev({Revenues:f(10600),RevenueFromContractWithCustomerExcludingAssessedTax:f(900),OperatingIncomeLoss:f(4600),CostsAndExpenses:f(6000)}),10600);
});
// Quarter and bank rules added after the 2026-10-06 audit.
test('a 16-week first quarter is a quarter, and a full-year figure mis-dated as a quarter is not',()=>{
 const {doc,evidence}=fixture();const q=(start,end,val,accn,form='10-Q',filed)=>({val,start,end,accn,form,filed:filed||end});
 doc.facts['us-gaap'].Revenues.units.USD=[{val:1000,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'},q('2025-01-01','2025-04-22',400,'0000000123-25-000002'),
  q('2025-10-01','2025-12-31',1000,ACC,'10-K','2026-02-01')];
 const d=extract(doc,evidence,{asOf:'2026-10-03'});const ends=d.income.quarterlyReports.map(r=>r.fiscalDateEnding);
 assert.ok(ends.includes('2025-04-22'));assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-04-22').totalRevenue,400);
 assert.notEqual(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31')?.totalRevenue,1000);
});
test('a bank that files net interest and noninterest income is measured on their sum, not a stray Revenues tag',()=>{
 const {doc,evidence}=fixture();evidence.sic='6022';const f=val=>({units:{USD:[{val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}});
 Object.assign(doc.facts['us-gaap'],{Revenues:f(68),InterestIncomeExpenseNet:f(300),NoninterestIncome:f(90)});
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].totalRevenue,390);assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
});
// 2026-10-25 revenue audit: lenders without a total, IFRS banks, equity REITs, a year filed on a quarter's dates.
test('a card or consumer lender\'s two income parts fill a blank revenue, but never replace a filed one',()=>{
 const f=val=>({units:{USD:[{val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}});
 const rev=(extra)=>{const {doc,evidence}=fixture();evidence.sic='6199';delete doc.facts['us-gaap'].Revenues;Object.assign(doc.facts['us-gaap'],extra);const d=extract(doc,evidence,{asOf:'2026-10-03'});return [d.income.annualReports[0].totalRevenue,p.validateFinancial(d,CIK,'2026-10-03')];};
 assert.deepEqual(rev({InterestIncomeExpenseNet:f(18466),NoninterestIncome:f(520)}),[18986,[]]);
 assert.equal(rev({Revenues:f(20000),InterestIncomeExpenseNet:f(18466),NoninterestIncome:f(520)})[0],20000);
});
test('an IFRS bank\'s gross-income line is its revenue, moved off gross profit; not where a cost of sales is filed',()=>{
 const f=val=>({units:{EUR:[{val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'20-F',filed:'2026-02-01'}]}});
 const run=(extra,sic='6029')=>{const {doc,evidence}=fixture('ifrs-full','EUR');evidence.sic=sic;delete doc.facts['ifrs-full'].Revenue;Object.assign(doc.facts['ifrs-full'],extra);const d=extract(doc,evidence,{asOf:'2026-10-03'});return {r:d.income.annualReports[0],issues:p.validateFinancial(d,CIK,'2026-10-03')};};
 const bank=run({GrossProfit:f(36931),InterestRevenueExpense:f(26280)});
 assert.equal(bank.r.totalRevenue,36931);assert.equal(bank.r.grossProfit,null);assert.equal(bank.r.netInterestIncome,26280);assert.deepEqual(bank.issues,[]);
 assert.equal(run({GrossProfit:f(36931),CostOfSales:f(1000)}).r.totalRevenue,null,'a cost of sales makes it a gross profit');
 assert.equal(run({GrossProfit:f(36931)},'2834').r.totalRevenue,null,'only a bank');
});
test('an equity REIT\'s lease income is its revenue when it files no total; not for a lender or below its profit',()=>{
 const f=(val,accn=ACC)=>({units:{USD:[{val,start:'2025-01-01',end:'2025-12-31',accn,form:'10-K',filed:'2026-02-01'}]}});
 const rev=(extra,sic='6798')=>{const {doc,evidence}=fixture();evidence.sic=sic;delete doc.facts['us-gaap'].Revenues;Object.assign(doc.facts['us-gaap'],extra);const d=extract(doc,evidence,{asOf:'2026-10-03'});return [d.income.annualReports[0]?.totalRevenue ?? null,p.validateFinancial(d,CIK,'2026-10-03')];};
 assert.deepEqual(rev({OperatingLeaseLeaseIncome:f(1850)}),[1850,[]]);
 assert.equal(rev({OperatingLeaseLeaseIncome:f(1850),Revenues:f(1900)})[0],1900,'a filed total stays');
 assert.equal(rev({OperatingLeaseLeaseIncome:f(1850),InterestIncomeExpenseNet:f(300)})[0],null,'a mortgage REIT');
 assert.equal(rev({OperatingLeaseLeaseIncome:f(150),InterestIncomeOperating:f(1300)})[0],null,'a lender\'s rent from foreclosed property (BXMT)');
 assert.equal(rev({OperatingLeaseLeaseIncome:f(1850),NoninterestIncome:f(159)})[0],null,'an "other income" total marks a lender');
 assert.equal(rev({OperatingLeaseLeaseIncome:f(60)})[0],null,'below the 100 of net income');
 assert.equal(rev({OperatingLeaseLeaseIncome:f(1850)},'6500')[0],null,'only an equity REIT');
 assert.equal(rev({OperatingLeaseLeaseIncome:f(1850,'0000000123-25-000009')})[0],null,'another filing than the net income');
});
test('a year filed on a quarter\'s dates is read as the year; a real fourth quarter is not',()=>{
 const run=q4=>{
  const {doc,evidence}=fixture();const g=doc.facts['us-gaap'];
  evidence.latestAnnual.reportDate='2026-01-02';
  for(const k of Object.keys(g))for(const r of g[k].units.USD){r.end='2026-01-02';if(r.start)r.start='2025-01-04';}
  // The filing's own tell: its prior year sits on both the year's and the fourth quarter's dates (L3Harris FY2025).
  const k=(val,start,end)=>({val,start,end,accn:ACC,form:'10-K',filed:'2026-02-01'});
  g.Revenues.units.USD=[k(q4,'2025-10-04','2026-01-02'),k(21325,'2023-12-30','2025-01-03'),k(21325,'2024-09-28','2025-01-03'),{val:16217,start:'2025-01-04',end:'2025-10-03',accn:'0000000123-25-000003',form:'10-Q',filed:'2025-10-28'}];
  return extract(doc,evidence,{asOf:'2026-10-03'});
 };
 const d=run(21865),year=d.income.annualReports[0];
 assert.equal(year.totalRevenue,21865);assert.equal(d.sources[year._sources.totalRevenue[0]].periodCorrection,'year_tagged_on_quarter_context');
 assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-01-02').totalRevenue,5648);
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
 const real=run(5648);assert.equal(real.income.annualReports[0].totalRevenue,null,'a quarter below nine months is a quarter');
});

// 2026-10-10: only goodwill was read out of the long-term assets, so the
// Stocks & funds page had nothing to unfold "Total long-term assets" into.
test('long-term asset lines are read as filed and never add a reporting period',()=>{
 const {doc,evidence}=fixture();const before=extract(doc,evidence,{asOf:'2026-10-03'});
 const instant=(val,end='2025-12-31')=>({units:{USD:[{val,end,accn:ACC,form:'10-K',filed:'2026-02-01'}]}});
 Object.assign(doc.facts['us-gaap'],{PropertyPlantAndEquipmentNet:instant(68),OperatingLeaseRightOfUseAsset:instant(26),MarketableSecuritiesNoncurrent:instant(55),DeferredIncomeTaxAssetsNet:instant(119),OtherAssetsNoncurrent:instant(113),IntangibleAssetsNetExcludingGoodwill:instant(7,'2023-12-31')});
 const d=extract(doc,evidence,{asOf:'2026-10-03'}),row=d.balance.annualReports[0];
 assert.deepEqual([row.propertyPlantEquipment,row.operatingLeaseRightOfUseAsset,row.longTermInvestments,row.deferredTaxAssets,row.otherNonCurrentAssets],[68,26,55,119,113]);
 assert.equal(d.sources[row._sources.propertyPlantEquipment[0]].concept,'PropertyPlantAndEquipmentNet');
 // not filed for this year: missing, not a remainder
 assert.equal(row.intangibleAssetsExcludingGoodwill,null);assert.equal(row.totalNonCurrentAssets,null);
 assert.deepEqual(d.balance.annualReports.map(r=>r.fiscalDateEnding),before.balance.annualReports.map(r=>r.fiscalDateEnding));
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
});
test('one EPS figure tagged basic-and-diluted fills both EPS rows but never adds a period',()=>{
 const {doc,evidence}=fixture();doc.facts['us-gaap'].EarningsPerShareBasicAndDiluted={units:{'USD/shares':[{val:1.23,start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',form:'10-K',accn:ACC},{val:0.9,start:'2024-01-01',end:'2024-12-31',filed:'2026-02-01',form:'10-K',accn:ACC}]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});
 assert.deepEqual(d.income.annualReports.map(r=>r.fiscalDateEnding),['2025-12-31']);
 assert.equal(d.income.annualReports[0].dilutedEPS,1.23);assert.equal(d.income.annualReports[0].eps,1.23);
});
test('a quarter keeps its filed diluted EPS when its year was filled from the basic-and-diluted tag',()=>{
 const {doc,evidence}=fixture();const g=doc.facts['us-gaap'];
 g.Revenues.units.USD.push({val:10,start:'2025-04-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:'0000000123-25-000009'});
 g.EarningsPerShareDiluted={units:{'USD/shares':[{val:-11.81,start:'2025-04-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:'0000000123-25-000009'}]}};
 g.EarningsPerShareBasicAndDiluted={units:{'USD/shares':[{val:1.5,start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',form:'10-K',accn:ACC},{val:-59.05,start:'2025-04-01',end:'2025-06-30',filed:'2026-02-01',form:'10-K',accn:ACC}]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});
 assert.equal(d.income.annualReports[0].dilutedEPS,1.5);
 assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-06-30').dilutedEPS,-11.81);
});
test('an IFRS filer keeps its own diluted EPS over a US GAAP basic-and-diluted figure',()=>{
 const {doc,evidence}=fixture('ifrs-full','EUR');
 doc.facts['ifrs-full'].DilutedEarningsLossPerShare={units:{'EUR/shares':[{val:0.55,start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',form:'20-F',accn:ACC}]}};
 doc.facts['us-gaap']={EarningsPerShareBasicAndDiluted:{units:{'EUR/shares':[{val:0.67,start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',form:'20-F',accn:ACC}]}}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});
 assert.equal(d.income.annualReports[0].dilutedEPS,0.55);
});
test('a partnership that files one per-unit figure as basic and diluted gets both EPS rows',()=>{
 const {doc,evidence}=fixture();doc.facts['us-gaap'].NetIncomeLossPerOutstandingLimitedPartnershipAndGeneralPartnershipUnitBasicAndDiluted={units:{'USD/shares':[{val:5.17,start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',form:'10-K',accn:ACC}]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});
 assert.equal(d.income.annualReports[0].dilutedEPS,5.17);assert.equal(d.income.annualReports[0].eps,5.17);
});
// Canadian National files its audited annual statements in a 6-K on the day of its 40-F, whose
// own XBRL is one cover-page share count; the page had no fiscal year at all.
test('a 6-K filed the same day as a 40-F that tags no statements is that year\'s annual report',()=>{
 const K6='0000000123-26-000002';
 const build=filed=>{const {doc,evidence}=fixture();evidence.latestAnnual={...evidence.latestAnnual,form:'40-F'};for(const f of Object.values(doc.facts['us-gaap']))for(const r of f.units.USD)Object.assign(r,{form:'6-K',accn:K6,filed});doc.facts.dei={EntityCommonStockSharesOutstanding:{units:{shares:[{val:5,end:'2025-12-31',filed:'2026-02-01',form:'40-F',accn:ACC}]}}};return {doc,evidence};};
 const same=build('2026-02-01'),d=extract(same.doc,same.evidence,{asOf:'2026-10-03'});
 assert.deepEqual(d.income.annualReports.map(r=>r.fiscalDateEnding),['2025-12-31']);assert.equal(d.income.annualReports[0].netIncome,100);
 const s=d.sources[d.income.annualReports[0]._sources.netIncome[0]];assert.equal(s.form,'6-K');assert.equal(s.accessionNumber,K6);assert.deepEqual(s.annualFiling,{form:'40-F',accessionNumber:ACC,filingDate:'2026-02-01'});
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
 const other=build('2026-01-15'),e=extract(other.doc,other.evidence,{asOf:'2026-10-03'});
 assert.equal(e.income.annualReports.length,0);
});

// 2026-10-17 scan: Dossier fields blank where SEC holds the line under another tag.
test('an IFRS filer\'s SG&A, interest expense, D&A, share-based payments, buybacks and share count fill, never add a period',()=>{
 const {doc,evidence}=fixture('ifrs-full','EUR'),g=doc.facts['ifrs-full'];
 const flow=(val,start='2025-01-01',end='2025-12-31')=>({units:{EUR:[{val,start,end,accn:ACC,form:'20-F',filed:'2026-02-01'}]}});
 Object.assign(g,{SellingGeneralAndAdministrativeExpense:flow(40),InterestExpense:flow(9),DepreciationAndAmortisationExpense:flow(12),AdjustmentsForSharebasedPayments:flow(5),PaymentsToAcquireOrRedeemEntitysShares:flow(7),
  NumberOfSharesOutstanding:{units:{shares:[{val:1000,end:'2025-12-31',accn:ACC,form:'20-F',filed:'2026-02-01'}]}}});
 // A year no original tag reports stays absent.
 g.InterestExpense.units.EUR.push({val:8,start:'2024-01-01',end:'2024-12-31',accn:ACC,form:'20-F',filed:'2026-02-01'});
 const d=extract(doc,evidence,{asOf:'2026-10-03'}),inc=d.income.annualReports[0],cash=d.cash.annualReports[0];
 assert.deepEqual([inc.sellingGeneralAndAdministrative,inc.interestExpense,inc.depreciationAndAmortization],[40,9,12]);
 assert.deepEqual([cash.shareBasedCompensation,cash.paymentsForRepurchaseOfCommonStock],[5,-7]);
 assert.equal(d.balance.annualReports[0].commonStockSharesOutstanding,1000);
 assert.deepEqual(d.income.annualReports.map(r=>r.fiscalDateEnding),['2025-12-31']);
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
});
test('a narrower US GAAP line fills a blank row and never displaces the broader one',()=>{
 const period={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'},f=val=>({units:{USD:[{...period,val}]}});
 const run=extra=>{const {doc,evidence}=fixture();Object.assign(doc.facts['us-gaap'],extra);return extract(doc,evidence,{asOf:'2026-10-03'});};
 let d=run({PaymentsOfDividendsCommonStock:f(15),ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost:f(30),AllocatedShareBasedCompensationExpense:f(4),PaymentsForRepurchaseOfEquity:f(6),
  WeightedAverageNumberOfShareOutstandingBasicAndDiluted:{units:{shares:[{...period,val:500}]}}});
 assert.deepEqual([d.cash.annualReports[0].dividendPayout,d.cash.annualReports[0].shareBasedCompensation,d.cash.annualReports[0].paymentsForRepurchaseOfCommonStock],[-15,4,-6]);
 assert.deepEqual([d.income.annualReports[0].researchAndDevelopment,d.income.annualReports[0].weightedAverageSharesOutstanding,d.income.annualReports[0].weightedAverageSharesDiluted],[30,500,500]);
 d=run({PaymentsOfDividends:f(20),PaymentsOfDividendsCommonStock:f(15),ShareBasedCompensation:f(5),AllocatedShareBasedCompensationExpense:f(4),WeightedAverageNumberOfDilutedSharesOutstanding:{units:{shares:[{...period,val:510}]}},
  WeightedAverageNumberOfShareOutstandingBasicAndDiluted:{units:{shares:[{...period,val:500}]}}});
 assert.deepEqual([d.cash.annualReports[0].dividendPayout,d.cash.annualReports[0].shareBasedCompensation,d.income.annualReports[0].weightedAverageSharesDiluted],[-20,5,510]);
});
// CIK 27093, July 2015 quarter: 2,801,284 basic shares as filed; following its year onto the
// basic-and-diluted line picked 933,761, a later filing's figure restated for a reverse split.
test('a quarter keeps its own filed line when its year was filled from a fill-only tag',()=>{
 const {doc,evidence}=fixture(),g=doc.facts['us-gaap'],Q='0000000123-25-000009';
 g.Revenues.units.USD.push({val:10,start:'2025-04-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:Q});
 g.WeightedAverageNumberOfSharesOutstandingBasic={units:{shares:[{val:2801284,start:'2025-04-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:Q}]}};
 g.WeightedAverageNumberOfShareOutstandingBasicAndDiluted={units:{shares:[{val:950000,start:'2025-01-01',end:'2025-12-31',filed:'2026-02-01',form:'10-K',accn:ACC},{val:933761,start:'2025-04-01',end:'2025-06-30',filed:'2026-02-01',form:'10-K',accn:ACC}]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});
 assert.equal(d.income.annualReports[0].weightedAverageSharesOutstanding,950000);
 assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-06-30').weightedAverageSharesOutstanding,2801284);
});
// CIK 313838 filed US GAAP until 2021 and IFRS since; its 2021 dividends are the IFRS figure of its
// later 20-F, not a US GAAP common-dividend fact read ahead of it.
test('an IFRS filer\'s own line wins over a fill-only US GAAP tag from its earlier filings',()=>{
 const {doc,evidence}=fixture('ifrs-full','JPY'),later={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'20-F',filed:'2026-02-01'};
 doc.facts['ifrs-full'].DividendsPaid={units:{JPY:[{...later,val:743}]}};
 doc.facts['us-gaap']={PaymentsOfDividendsCommonStock:{units:{JPY:[{...later,accn:'0000000123-25-000001',filed:'2025-06-01',val:612}]}}};
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03'}).cash.annualReports[0].dividendPayout,-743);
});
// CIK 1070750, 2010: common stock issued $109m over a year filed from 2009-12-31; allocated
// share-based compensation, a fill-only tag, filed from 2010-01-01 had set the row's start and
// dropped the filed line as an incompatible period.
test('a fill-only tag never sets the period that decides which filed lines a row keeps',()=>{
 const {doc,evidence}=fixture(),g=doc.facts['us-gaap'],at={end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'};
 delete g.NetCashProvidedByUsedInOperatingActivities;g.Revenues.units.USD[0].start=g.NetIncomeLoss.units.USD[0].start='2024-12-31';
 g.ProceedsFromIssuanceOfCommonStock={units:{USD:[{...at,start:'2024-12-31',val:109}]}};
 g.AllocatedShareBasedCompensationExpense={units:{USD:[{...at,start:'2025-01-01',val:4}]}};
 const row=extract(doc,evidence,{asOf:'2026-10-03'}).cash.annualReports[0];
 assert.deepEqual([row.periodStart,row.proceedsFromIssuanceOfCommonStock],['2024-12-31',109]);
});

// 2026-10-17: 0 of 581 IFRS filers tag the US GAAP name the map listed for basic weighted shares; 491
// tag ifrs-full:WeightedAverageShares (HUB Cyber's 20-F, R3: 1,122 / 176 / 64). Rows that read only US
// GAAP get their exact IFRS counterparts, which fill a year but never add one.
test('an IFRS filer\'s basic shares, non-current liabilities, payables, share issues and change in cash fill, never add a period',()=>{
 const {doc,evidence}=fixture('ifrs-full','EUR'),g=doc.facts['ifrs-full'];
 const at={accn:ACC,form:'20-F',filed:'2026-02-01'},flow=(val,unit='EUR')=>({units:{[unit]:[{...at,val,start:'2025-01-01',end:'2025-12-31'}]}}),inst=val=>({units:{EUR:[{...at,val,end:'2025-12-31'}]}});
 Object.assign(g,{WeightedAverageShares:flow(1122,'shares'),NoncurrentLiabilities:inst(300),TradeAndOtherCurrentPayablesToTradeSuppliers:inst(45),IssuedCapital:inst(20),
  ProceedsFromIssueOfOrdinaryShares:flow(15),RepaymentsOfNoncurrentBorrowings:flow(30),IncreaseDecreaseInCashAndCashEquivalents:flow(-4)});
 g.NoncurrentLiabilities.units.EUR.push({...at,val:290,end:'2023-12-31'});
 const d=extract(doc,evidence,{asOf:'2026-10-03'}),inc=d.income.annualReports[0],bal=d.balance.annualReports[0],cash=d.cash.annualReports[0];
 assert.equal(inc.weightedAverageSharesOutstanding,1122);
 assert.deepEqual([bal.totalNonCurrentLiabilities,bal.currentAccountsPayable,bal.commonStock],[300,45,20]);
 assert.deepEqual([cash.proceedsFromIssuanceOfCommonStock,cash.repaymentsOfLongTermDebt,cash.changeInCashAndCashEquivalents],[15,-30,-4]);
 assert.ok(!d.balance.annualReports.some(r=>r.fiscalDateEnding==='2023-12-31'));
 assert.deepEqual(p.validateFinancial(d,evidence.cik),[]);
});

// 2026-10-17 audit of every blank row against SEC's facts: the same line filed under another tag. Each fills a
// year that has its core figures, never adds one, and never displaces the tag the row already read.
test('the same line under another filer\'s tag fills a blank row, never adds a period and never displaces the original',()=>{
 const at={accn:ACC,form:'10-K',filed:'2026-02-01'},flow=val=>({units:{USD:[{...at,val,start:'2025-01-01',end:'2025-12-31'}]}}),inst=(val,end='2025-12-31')=>({units:{USD:[{...at,val,end}]}});
 const run=extra=>{const {doc,evidence}=fixture();Object.assign(doc.facts['us-gaap'],extra);return extract(doc,evidence,{asOf:'2026-10-03'});};
 const tags={InterestExpenseOperating:flow(12),InterestAndDividendIncomeOperating:flow(80),Cash:inst(40),ReceivablesNetCurrent:inst(25),CommonStockValueOutstanding:inst(3),
  PaymentsOfCapitalDistribution:flow(9),IncreaseDecreaseInRetailRelatedInventories:flow(6),LiabilitiesAndStockholdersEquity:inst(130),
  NetCashProvidedByUsedInInvestingActivitiesContinuingOperations:flow(-50),NetCashProvidedByUsedInFinancingActivitiesContinuingOperations:flow(-20)};
 for(const t of Object.values(tags))t.units.USD.push({...t.units.USD[0],start:t.units.USD[0].start && '2023-01-01',end:'2023-12-31'});
 let d=run(tags);const inc=d.income.annualReports[0],bal=d.balance.annualReports[0],cash=d.cash.annualReports[0];
 assert.deepEqual([inc.interestExpense,inc.interestIncome],[12,80]);
 assert.deepEqual([bal.cashAndCashEquivalentsAtCarryingValue,bal.currentNetReceivables,bal.commonStock,bal.totalLiabilitiesAndEquity],[40,25,3,130]);
 assert.deepEqual([cash.dividendPayout,cash.changeInInventory,cash.cashflowFromInvestment,cash.cashflowFromFinancing],[-9,6,-50,-20]);
 for(const st of ['income','balance','cash'])assert.deepEqual(d[st].annualReports.map(r=>r.fiscalDateEnding),['2025-12-31'],st);
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
 d=run({...tags,AccountsReceivableNet:inst(31),AccountsReceivableNetCurrent:inst(22),CashAndCashEquivalentsAtCarryingValue:inst(35),CommonStockValue:inst(2),PaymentsOfDividends:flow(8),
  NetCashProvidedByUsedInInvestingActivities:flow(-55),NetCashProvidedByUsedInFinancingActivities:flow(-25)});
 assert.deepEqual([d.balance.annualReports[0].currentNetReceivables,d.balance.annualReports[0].cashAndCashEquivalentsAtCarryingValue,d.balance.annualReports[0].commonStock],[22,35,2]);
 assert.deepEqual([d.cash.annualReports[0].dividendPayout,d.cash.annualReports[0].cashflowFromInvestment,d.cash.annualReports[0].cashflowFromFinancing],[-8,-55,-25]);
 assert.equal(run({AccountsReceivableNet:inst(31)}).balance.annualReports[0].currentNetReceivables,31);
});
test('continuing-operations investing and financing cash flow stands in only when no discontinued flow is reported',()=>{
 const at={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'},flow=val=>({units:{USD:[{...at,val}]}});
 const {doc,evidence}=fixture();Object.assign(doc.facts['us-gaap'],{NetCashProvidedByUsedInInvestingActivitiesContinuingOperations:flow(-50),NetCashProvidedByUsedInFinancingActivitiesContinuingOperations:flow(-20),
  CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations:flow(-7),CashProvidedByUsedInFinancingActivitiesDiscontinuedOperations:flow(0)});
 const cash=extract(doc,evidence,{asOf:'2026-10-03'}).cash.annualReports[0];
 assert.deepEqual([cash.cashflowFromInvestment,cash.cashflowFromFinancing],[null,-20]);
});
// 2026-10-17: with the continuing tags read last-resort, 91 quarters followed their year onto them and took later
// filings' restated figures (Rithm Capital Q3 2014 investing: -$497.6m as filed, -$13.0m restated).
test('a quarter keeps its own filed investing and financing totals when its year was filled from the continuing line',()=>{
 const {doc,evidence}=fixture(),g=doc.facts['us-gaap'],Q1='0000000123-25-000002',Q2='0000000123-25-000003',L='0000000123-26-000009';
 const at=(val,start,end,accn,form='10-Q',filed='2025-08-01')=>({val,start,end,accn,form,filed});
 g.Revenues.units.USD.push(at(10,'2025-04-01','2025-06-30',Q2));
 g.NetCashProvidedByUsedInInvestingActivities={units:{USD:[at(-30,'2025-01-01','2025-03-31',Q1,'10-Q','2025-05-01'),at(-80,'2025-01-01','2025-06-30',Q2)]}};
 g.NetCashProvidedByUsedInInvestingActivitiesContinuingOperations={units:{USD:[at(-50,'2025-01-01','2025-12-31',ACC,'10-K','2026-02-01'),at(-20,'2025-01-01','2025-03-31',L,'10-Q','2026-05-01'),at(-25,'2025-01-01','2025-06-30',L,'10-Q','2026-05-01')]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});
 assert.equal(d.cash.annualReports[0].cashflowFromInvestment,-50);
 assert.equal(d.cash.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-06-30').cashflowFromInvestment,-50);
});
test('a quarter derived from year-to-date continuing figures needs both to pass the stand-in test',()=>{
 const {doc,evidence}=fixture(),g=doc.facts['us-gaap'],Q1='0000000123-25-000002',Q2='0000000123-25-000003';
 const at=(val,start,end,accn,filed)=>({val,start,end,accn,form:'10-Q',filed});
 g.Revenues.units.USD.push(at(10,'2025-04-01','2025-06-30',Q2,'2025-08-01'));
 g.NetCashProvidedByUsedInOperatingActivitiesContinuingOperations={units:{USD:[at(40,'2025-01-01','2025-03-31',Q1,'2025-05-01'),at(90,'2025-01-01','2025-06-30',Q2,'2025-08-01')]}};
 const quarter=()=>extract(doc,evidence,{asOf:'2026-10-03'}).cash.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-06-30')?.operatingCashflow ?? null;
 assert.equal(quarter(),50);
 g.CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations={units:{USD:[at(-6,'2025-01-01','2025-06-30',Q2,'2025-08-01')]}};
 assert.notEqual(quarter(),50);
});
test('cash, receivables and distributions fill only when the filing reports no other part of the line',()=>{
 const at={accn:ACC,form:'10-K',filed:'2026-02-01'},flow=val=>({units:{USD:[{...at,val,start:'2025-01-01',end:'2025-12-31'}]}}),inst=val=>({units:{USD:[{...at,val,end:'2025-12-31'}]}});
 const run=extra=>{const {doc,evidence}=fixture();Object.assign(doc.facts['us-gaap'],extra);const d=extract(doc,evidence,{asOf:'2026-10-03'});return [d.balance.annualReports[0].cashAndCashEquivalentsAtCarryingValue,d.balance.annualReports[0].currentNetReceivables,d.cash.annualReports[0].dividendPayout];};
 assert.deepEqual(run({Cash:inst(40),AccountsReceivableNet:inst(31),PaymentsOfCapitalDistribution:flow(9)}),[40,31,-9]);
 assert.deepEqual(run({Cash:inst(40),CashEquivalentsAtCarryingValue:inst(60),AccountsReceivableNet:inst(31),AccountsReceivableNetNoncurrent:inst(5),
  PaymentsOfCapitalDistribution:flow(9),PaymentsOfOrdinaryDividends:{units:{USD:[{...at,val:20,start:'2025-07-01',end:'2025-12-31'}]}}}),[null,null,null]);
 assert.deepEqual(run({Cash:inst(40),CashEquivalentsAtCarryingValue:inst(0)}).slice(0,1),[40]);
});

test('interest income reads the filed total when the tagged figure is below the filing\'s own net interest income',()=>{
 const at={accn:ACC,form:'10-K',filed:'2026-02-01'},flow=val=>({units:{USD:[{...at,val,start:'2025-01-01',end:'2025-12-31'}]}});
 const run=extra=>{const {doc,evidence}=fixture();Object.assign(doc.facts['us-gaap'],extra);return extract(doc,evidence,{asOf:'2026-10-03'}).income.annualReports[0].interestIncome;};
 // CIK 862831 FY2012: other interest income $0.56m tagged InterestIncomeOperating beside $97.6m total and $88.5m net.
 assert.equal(run({InterestIncomeOperating:flow(555),InterestAndDividendIncomeOperating:flow(97567),InterestIncomeExpenseNet:flow(88516)}),97567);
 assert.equal(run({InvestmentIncomeInterest:flow(555),InterestAndDividendIncomeOperating:flow(97567),InterestAndFeeIncomeLoansAndLeases:flow(80000)}),97567);
 // A total at or above its net interest income is the line, even beside a larger interest-and-dividend figure.
 assert.equal(run({InterestIncomeOperating:flow(55620),InterestAndDividendIncomeOperating:flow(66677),InterestIncomeExpenseNet:flow(40000)}),55620);
 // Without that larger filed total the figure stands: a non-bank's "net" line signed as an expense (CIK 887733) or
 // interest and fee income that includes fees is not a floor on its own.
 assert.equal(run({InvestmentIncomeInterest:flow(119),InterestIncomeExpenseNet:flow(33587)}),119);
 assert.equal(run({InterestIncomeOperating:flow(416969),InterestAndFeeIncomeLoansAndLeases:flow(500000)}),416969);
});

test('total liabilities and equity comes from the filing that gave the row its total assets, or one that agrees with it',()=>{
 const q=(accn,filed,val)=>({val,end:'2024-12-31',accn,form:'10-K',filed});
 const A='0000000123-25-000002',B='0000000123-26-000003',C='0000000123-26-000004';
 const run=(assets,lae)=>{const {doc,evidence}=fixture();const g=doc.facts['us-gaap'];g.Assets.units.USD.push(...assets);g.LiabilitiesAndStockholdersEquity={units:{USD:lae}};g.NetIncomeLoss.units.USD.push({...q(A,'2025-08-01',7),start:'2024-01-01'});
  const r=extract(doc,evidence,{asOf:'2026-10-03'}).balance.annualReports.find(r=>r.fiscalDateEnding==='2024-12-31');return [r.totalAssets,r.totalLiabilitiesAndEquity];};
 // U-Haul 2023-12-31: a later filing tags another figure at a date that is not its balance-sheet date.
 assert.deepEqual(run([q(A,'2025-08-01',50)],[q(A,'2025-08-01',50),q(B,'2026-08-01',70)]),[50,50]);
 // The assets' filing reports no total; a filing whose total equals the assets is the line.
 assert.deepEqual(run([q(A,'2025-08-01',50),q(C,'2026-09-01',50)],[q(A,'2025-08-01',50),q(B,'2026-08-01',70)]),[50,50]);
 // American Express 2021: assets restated in round billions; the precise filed total stays.
 assert.deepEqual(run([q(A,'2025-08-01',49),q(C,'2026-09-01',50)],[q(A,'2025-08-01',49.4)]),[50,49.4]);
});

test('a figure a guard turned down is not put back by the same-filing last-good rule or a presented line',()=>{
 const {preserveSameFiling}=require('../sec-last-good');
 const at={accn:ACC,form:'10-K',filed:'2026-02-01'},inst=val=>({units:{USD:[{...at,val,end:'2025-12-31'}]}});
 const run=extra=>{const {doc,evidence}=fixture();Object.assign(doc.facts['us-gaap'],extra);return {d:extract(doc,evidence,{asOf:'2026-10-03'}),evidence};};
 const cash=d=>d.balance.annualReports[0].cashAndCashEquivalentsAtCarryingValue;
 const {d:previous}=run({Cash:inst(40)});assert.equal(cash(previous),40);
 // FBS Global 2025: cash beside its cash equivalents in the same filing is a part of the line.
 const {d:guarded,evidence}=run({Cash:inst(40),CashEquivalentsAtCarryingValue:inst(60)});
 assert.equal(cash(guarded),null);assert.ok(guarded.issues.some(i=>i.code==='REJECTED_PART' && i.field==='cashAndCashEquivalentsAtCarryingValue'));
 assert.equal(cash(preserveSameFiling(guarded,structuredClone(previous),evidence)),null);
 // An omission is still covered: the same filing's validated figure returns when the aggregate leaves it out.
 const {d:omitted}=run({});assert.equal(cash(preserveSameFiling(omitted,structuredClone(previous),evidence)),40);
});

// 2026-10-18: the industry stage reads the annual report alone, which often lacks the line that showed a figure to be
// a part (cash equivalents beside cash, a discontinued flow beside a continuing one), and put back 140 turned-down cells.
test('the industry stage does not put back a figure the full extraction turned down',()=>{
 const {fixture,ACC}=require('./fixtures/sec-fixture'),industry=require('../sec-industry');
 const {doc,evidence}=fixture(),fact=val=>({units:{USD:[{val,end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}});
 const full=structuredClone(doc);full.facts['us-gaap'].Cash=fact(40);full.facts['us-gaap'].CashEquivalentsAtCarryingValue=fact(13);
 const financial=extract(full,evidence,{asOf:'2026-10-03'});assert.equal(financial.balance.annualReports[0].cashAndCashEquivalentsAtCarryingValue,null);
 const filing=structuredClone(doc);filing.facts['us-gaap'].Cash=fact(40);
 const url='https://www.sec.gov/Archives/edgar/data/123/000000012326000001/a.htm';
 const document={...filing,segments:[],operatingExpenseLines:[],originalDocument:{form:'10-K',accessionNumber:ACC,documentUrl:url,url,filingDate:'2026-02-01'}};
 assert.equal(industry.enrich(financial,document,evidence,{asOf:'2026-10-03'}).balance.annualReports[0].cashAndCashEquivalentsAtCarryingValue,null);
 // A blank the full extraction did not turn down is still filled from the filing.
 const plain=extract(doc,evidence,{asOf:'2026-10-03'});
 assert.equal(industry.enrich(plain,document,evidence,{asOf:'2026-10-03'}).balance.annualReports[0].cashAndCashEquivalentsAtCarryingValue,40);
});
test('discontinued operations are read as filed and never add a reporting period',()=>{
 const {doc,evidence}=fixture();const before=extract(doc,evidence,{asOf:'2026-10-03'});
 const flow=(val,start,end)=>({val,start,end,accn:ACC,form:'10-K',filed:'2026-02-01'});
 // AppLovin's FY2025 10-K: -$99.4m for 2025 and -$9.7m for a 2024 with no other line here.
 doc.facts['us-gaap'].IncomeLossFromDiscontinuedOperationsNetOfTaxAttributableToReportingEntity={units:{USD:[flow(-99444000,'2025-01-01','2025-12-31'),flow(-9748000,'2024-01-01','2024-12-31')]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'}),row=d.income.annualReports[0];
 assert.equal(row.discontinuedOperations,-99444000);
 assert.equal(d.sources[row._sources.discontinuedOperations[0]].concept,'IncomeLossFromDiscontinuedOperationsNetOfTaxAttributableToReportingEntity');
 assert.deepEqual(d.income.annualReports.map(r=>r.fiscalDateEnding),before.income.annualReports.map(r=>r.fiscalDateEnding));
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
});
