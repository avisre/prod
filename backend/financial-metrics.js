'use strict';
const {number:n}=require('./sec-coverage');
const ratio=(a,b)=>n(a)!==null && n(b)>0?n(a)/n(b):null;
const debt=b=>n(b.shortLongTermDebtTotal)!==null?n(b.shortLongTermDebtTotal):n(b.longTermDebt)!==null && n(b.shortTermDebt)!==null?n(b.longTermDebt)+n(b.shortTermDebt):null;
function annualWindow(rows,end,count,field) {
 const window=rows.filter(r=>r.fiscalDateEnding<=end).sort((a,b)=>b.fiscalDateEnding.localeCompare(a.fiscalDateEnding)).slice(0,count);
 if(window.length!==count || window[0].fiscalDateEnding!==end || window.some(r=>n(r[field])===null || r.reportedCurrency!==window[0].reportedCurrency || r._scopes?.[field]!==window[0]._scopes?.[field]))return null;
 for(let i=1;i<window.length;i++){const days=(Date.parse(window[i-1].fiscalDateEnding)-Date.parse(window[i].fiscalDateEnding))/86400000;if(days<340 || days>380)return null;}
 return window;
}
function history(data,slug) {
 const section=['free-cash-flow','dividend-history'].includes(slug)?'cash':['total-debt','shares-outstanding'].includes(slug)?'balance':'income';
 const fields={revenue:'totalRevenue','net-income':'netIncome','gross-profit':'grossProfit',eps:'dilutedEPS',ebitda:'ebitda','shares-outstanding':'commonStockSharesOutstanding'};
 return (data[section]?.annualReports || []).map(r=>{
  let value=null,sourceFields=[];
  if(fields[slug]){const field=slug==='eps' && n(r.dilutedEPS)===null?'eps':fields[slug];value=n(r[field]);sourceFields=[field];}
  if(slug==='free-cash-flow'){value=n(r.operatingCashflow)!==null && n(r.capitalExpenditures)!==null?n(r.operatingCashflow)-Math.abs(n(r.capitalExpenditures)):null;sourceFields=['operatingCashflow','capitalExpenditures'];}
  if(slug==='total-debt'){value=debt(r);sourceFields=n(r.shortLongTermDebtTotal)!==null?['shortLongTermDebtTotal']:['longTermDebt','shortTermDebt'];}
  if(slug==='dividend-history'){const f=n(r.dividendPayoutCommonStock)!==null?'dividendPayoutCommonStock':'dividendPayout';value=n(r[f])===null?null:Math.abs(n(r[f]));sourceFields=[f];}
  return {period:r.fiscalDateEnding,year:r.fiscalDateEnding.slice(0,4),currency:r.reportedCurrency,value,sourceIds:[...new Set(sourceFields.flatMap(f=>r._sources?.[f] || []))],derived:sourceFields.length>1 || sourceFields.some(f=>r._derivations?.[f]),sourceFields,row:r};
 });
}
const SLUGS=['revenue','net-income','gross-profit','eps','ebitda','free-cash-flow','total-debt','shares-outstanding','dividend-history','pe-ratio'];
function capabilities(data){return SLUGS.filter(slug=>{const rows=history(data,slug).filter(r=>r.value!==null && r.sourceIds.length),cur=rows[0]?.currency;return new Set(rows.filter(r=>r.currency===cur).map(r=>r.period)).size>=2;});}
function screenRow(company,data,usdData=data) {
 const annual=data.coverage.latestAnnual?.reportDate;
 const find=st=>(data[st]?.annualReports || []).find(r=>r.fiscalDateEnding===annual) || {};
 const i=find('income'),b=find('balance'),c=find('cash'),quote=data.marketData;
 const rev=n(i.totalRevenue),ni=n(i.netIncome),ocf=n(c.operatingCashflow),capex=n(c.capitalExpenditures),fcf=ocf!==null && capex!==null?ocf-Math.abs(capex):null;
 const currency=i.reportedCurrency || b.reportedCurrency;
 const dollars=currency==='USD';
 const usdRow=st=>(usdData[st]?.annualReports || []).find(r=>r.fiscalDateEnding===annual) || {};
 const ui=usdRow('income'),ub=usdRow('balance'),uc=usdRow('cash');
 const presented=(r,f)=>r.reportedCurrency==='USD'?n(r[f]):null;
 const currentDate=Date.parse(annual),prior=(data.income.annualReports || []).find(r=>Math.abs((currentDate-Date.parse(r.fiscalDateEnding))/86400000/365.2425-5)<0.12 && n(r.totalRevenue)>0 && r.reportedCurrency===currency);
 const years=prior?(currentDate-Date.parse(prior.fiscalDateEnding))/86400000/365.2425:null;
 // Fix calculation precision so snapshots reconcile across supported Node runtimes.
 const cagr=prior && rev>0?Number(((Math.pow(rev/n(prior.totalRevenue),1/years)-1)*100).toFixed(10)):null;
 const profitable=annualWindow(data.income.annualReports || [],annual,10,'netIncome');
 const q0=data.income.quarterlyReports[0],qPrior=q0?data.income.quarterlyReports.find(r=>Math.abs((Date.parse(q0.fiscalDateEnding)-Date.parse(r.fiscalDateEnding))/86400000-365.2425)<=14 && r.reportedCurrency===q0.reportedCurrency):null;
 const yoy=f=>q0 && qPrior && n(q0[f])!==null && n(qPrior[f])>0?(n(q0[f])/n(qPrior[f])-1)*100:null;
 const pe=data.coverage.perShareAllowed?n(quote?.trailingPE):null;
 const roe=i._scopes?.netIncome===b._scopes?.totalShareholderEquity?ratio(ni,b.totalShareholderEquity):null;
 // Screen extras. Profit growth stands in for EPS growth: filed EPS is not
 // restated across stock splits (Nvidia's reads 3.85 then 0.17), so a 5-year
 // EPS CAGR would be wrong for every company that split.
 const niPrior=(data.income.annualReports || []).find(r=>Math.abs((currentDate-Date.parse(r.fiscalDateEnding))/86400000/365.2425-5)<0.12 && n(r.netIncome)>0 && r.reportedCurrency===currency && r._scopes?.netIncome===i._scopes?.netIncome);
 const niCagr=niPrior && ni>0?Number(((Math.pow(ni/n(niPrior.netIncome),1/((currentDate-Date.parse(niPrior.fiscalDateEnding))/86400000/365.2425))-1)*100).toFixed(4)):null;
 const price=quote?.currency==='USD' && n(quote.price)>0?n(quote.price):null;
 // Price against the average of the last ten month-end closes: the monthly
 // counterpart of the 200-day average (the stored daily series is 145 days).
 const closes=Object.entries(data.monthly?.['Monthly Adjusted Time Series'] || {}).filter(([,r])=>n(r['4. close'])>0).sort(([x],[y])=>y.localeCompare(x)).slice(0,10);
 const fresh=closes.length===10 && quote?.asOf && Math.abs(Date.parse(quote.asOf)-Date.parse(closes[0][0]))/86400000<=45 && (Date.parse(closes[0][0])-Date.parse(closes[9][0]))/86400000<=320;
 const vsAvg=price!==null && fresh?Number(((price/(closes.reduce((t,[,r])=>t+n(r['4. close']),0)/10)-1)*100).toFixed(2)):null;
 return {symbol:company.symbol,name:company.name,sector:company.sector || '',cik:company.cik,coverageStatus:'ready',currencyPresentation:currency==='USD'?null:{income:ui._presentations?.totalRevenue || null,balance:ub._presentations?.totalAssets || null,cash:uc._presentations?.operatingCashflow || null},financialPeriod:annual,financialCurrency:currency,sources:[...new Set([...['totalRevenue','netIncome','eps','dilutedEPS','grossProfit'].flatMap(f=>i._sources?.[f] || []),...['totalAssets','totalShareholderEquity','longTermDebt','shortTermDebt','shortLongTermDebtTotal','commonStockSharesOutstanding'].flatMap(f=>b._sources?.[f] || []),...['operatingCashflow','capitalExpenditures','dividendPayout','dividendPayoutCommonStock'].flatMap(f=>c._sources?.[f] || []),...(prior?._sources?.totalRevenue || [])])],marketDataAsOf:quote?.asOf || null,marketDataSource:quote?.source || null,availableMetrics:capabilities(data),marketCapB:quote?.currency==='USD' && n(quote.marketCap)!==null?n(quote.marketCap)/1e9:null,pe,divYieldPct:null,revCagr5Pct:cagr,netMarginPct:ratio(ni,rev)!==null?ratio(ni,rev)*100:null,roePct:roe!==null?roe*100:null,fcfPositive:fcf!==null?fcf>0:null,fcfAbs:presented(uc,'operatingCashflow')!==null && presented(uc,'capitalExpenditures')!==null?presented(uc,'operatingCashflow')-Math.abs(presented(uc,'capitalExpenditures')):null,pegRatio:pe>0 && cagr>0?pe/cagr:null,priceToBook:null,profitableYears10:profitable?profitable.filter(r=>n(r.netIncome)>0).length:null,qtrNetIncomeYoYPct:yoy('netIncome'),qtrEpsYoYPct:yoy('dilutedEPS'),latestQuarterEnd:q0?.fiscalDateEnding || null,latestFiscalYearEnd:annual,latestRevenue:presented(ui,'totalRevenue'),latestNetIncome:presented(ui,'netIncome'),latestEps:dollars?n(i.dilutedEPS) ?? n(i.eps):null,latestGrossProfit:presented(ui,'grossProfit'),latestEbitda:null,latestTotalDebt:ub.reportedCurrency==='USD'?debt(ub):null,latestSharesOutstanding:n(b.commonStockSharesOutstanding),latestDividendPayout:dollars?(n(c.dividendPayoutCommonStock)===null?n(c.dividendPayout)===null?null:Math.abs(n(c.dividendPayout)):Math.abs(n(c.dividendPayoutCommonStock))):null,price,netIncomeCagr5Pct:niCagr,priceVsAvg10mPct:vsAvg};
}
module.exports={history,capabilities,screenRow,SLUGS,debt,ratio,annualWindow};
