'use strict';
// The offline builder and bounded refresh share values, capabilities and dates.
const p=require('./sec-coverage');
const metrics=require('./financial-metrics');
const {usd}=require('./sec-presentation');
function content(company,view,classification,financialDigest,{asOf=p.day(new Date().toISOString()),previous=null,rates={}}={}) {
 const eligible=company.securityType==='stock' && classification.financialCoverage==='ready';
 const metricSlugs=eligible?metrics.capabilities(view):[];
 const prices=Object.entries(view.monthly?.['Monthly Adjusted Time Series'] || {}).filter(([date,row])=>p.day(date) && p.number(row['5. adjusted close'])>0).sort(([a],[b])=>a.localeCompare(b)).map(([date,row])=>[date,p.number(row['5. adjusted close']),p.number(row['4. close']),p.number(row['6. volume']),p.number(row['7. dividend amount'])]);
 const priceHistory=company.securityType==='stock' && prices.length>=2;
 const priceDigest=p.digest(prices),marketDigest=p.digest(view.marketData);
 const screenRow=eligible?{...metrics.screenRow(company,view,usd(view,rates)),financialDigest}:null;
 const contentDigest=p.digest({company,classification,financialDigest,supplementalDigest:view.provenance?.supplementalDigest || null,metricSlugs,priceDigest,marketDigest,screenRow});
 return {entry:{metricSlugs,priceHistory,financialPeriod:view.income.annualReports[0]?.fiscalDateEnding || null,contentDigest,lastmod:previous?.contentDigest===contentDigest?previous.lastmod:asOf},screenRow,priceDigest,marketDigest};
}
module.exports={content};
