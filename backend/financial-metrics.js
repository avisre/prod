'use strict';
const {number:n}=require('./sec-coverage');
const ratio=(a,b)=>n(a)!==null && n(b)>0?n(a)/n(b):null;
const debt=b=>n(b.shortLongTermDebtTotal)!==null?n(b.shortLongTermDebtTotal):n(b.longTermDebt)!==null && n(b.shortTermDebt)!==null?n(b.longTermDebt)+n(b.shortTermDebt):null;
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
 const cagr=prior && rev>0?(Math.pow(rev/n(prior.totalRevenue),1/years)-1)*100:null;
 const profitable=(data.income.annualReports || []).filter(r=>n(r.netIncome)!==null).slice(0,10);
 const q0=data.income.quarterlyReports[0],qPrior=q0?data.income.quarterlyReports.find(r=>Math.abs((Date.parse(q0.fiscalDateEnding)-Date.parse(r.fiscalDateEnding))/86400000-365.2425)<=14 && r.reportedCurrency===q0.reportedCurrency):null;
 const yoy=f=>q0 && qPrior && n(q0[f])!==null && n(qPrior[f])>0?(n(q0[f])/n(qPrior[f])-1)*100:null;
 const pe=data.coverage.perShareAllowed?n(quote?.trailingPE):null;
 const roe=i._scopes?.netIncome===b._scopes?.totalShareholderEquity?ratio(ni,b.totalShareholderEquity):null;
 return {symbol:company.symbol,name:company.name,sector:company.sector || '',cik:company.cik,coverageStatus:'ready',currencyPresentation:currency==='USD'?null:{income:ui._presentations?.totalRevenue || null,balance:ub._presentations?.totalAssets || null,cash:uc._presentations?.operatingCashflow || null},financialPeriod:annual,financialCurrency:currency,sources:[...new Set([...['totalRevenue','netIncome','eps','dilutedEPS','grossProfit'].flatMap(f=>i._sources?.[f] || []),...['totalAssets','totalShareholderEquity','longTermDebt','shortTermDebt','shortLongTermDebtTotal','commonStockSharesOutstanding'].flatMap(f=>b._sources?.[f] || []),...['operatingCashflow','capitalExpenditures','dividendPayout','dividendPayoutCommonStock'].flatMap(f=>c._sources?.[f] || []),...(prior?._sources?.totalRevenue || [])])],marketDataAsOf:quote?.asOf || null,marketDataSource:quote?.source || null,availableMetrics:capabilities(data),marketCapB:quote?.currency==='USD' && n(quote.marketCap)!==null?n(quote.marketCap)/1e9:null,pe,divYieldPct:null,revCagr5Pct:cagr,netMarginPct:ratio(ni,rev)!==null?ratio(ni,rev)*100:null,roePct:roe!==null?roe*100:null,fcfPositive:fcf!==null?fcf>0:null,fcfAbs:presented(uc,'operatingCashflow')!==null && presented(uc,'capitalExpenditures')!==null?presented(uc,'operatingCashflow')-Math.abs(presented(uc,'capitalExpenditures')):null,pegRatio:pe>0 && cagr>0?pe/cagr:null,priceToBook:null,profitableYears10:profitable.length===10?profitable.filter(r=>n(r.netIncome)>0).length:null,qtrNetIncomeYoYPct:yoy('netIncome'),qtrEpsYoYPct:yoy('dilutedEPS'),latestQuarterEnd:q0?.fiscalDateEnding || null,latestFiscalYearEnd:annual,latestRevenue:presented(ui,'totalRevenue'),latestNetIncome:presented(ui,'netIncome'),latestEps:dollars?n(i.dilutedEPS) ?? n(i.eps):null,latestGrossProfit:presented(ui,'grossProfit'),latestEbitda:null,latestTotalDebt:ub.reportedCurrency==='USD'?debt(ub):null,latestSharesOutstanding:n(b.commonStockSharesOutstanding),latestDividendPayout:dollars?(n(c.dividendPayoutCommonStock)===null?n(c.dividendPayout)===null?null:Math.abs(n(c.dividendPayout)):Math.abs(n(c.dividendPayoutCommonStock))):null};
}
module.exports={history,capabilities,screenRow,SLUGS,debt,ratio};
