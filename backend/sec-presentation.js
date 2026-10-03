'use strict';
// Optional presentation values. SEC source observations remain immutable.
const p=require('./sec-coverage'),fx=require('./fx-conversion');
function convertRow(row,statement,series){
 const currency=row?.reportedCurrency;if(!row || currency==='USD')return row;
 const points=fx.normalizeSeries(series),end=String(row.fiscalDateEnding).slice(0,7),start=String(row.periodStart || '').slice(0,7);
 const window=points.filter(x=>x.month>=start && x.month<=end);
 const months=start?((Number(end.slice(0,4))-Number(start.slice(0,4)))*12+Number(end.slice(5))-Number(start.slice(5))+1):0;
 const closing=points.find(x=>x.month===end);
 const rate=statement==='balance'?closing?.rate:months && new Set(window.map(x=>x.month)).size===months?window.reduce((a,x)=>a+x.rate,0)/window.length:null;
 const out={...row,originalReportedCurrency:currency,reportedCurrency:'USD',_presentations:{}};
 for(const field of Object.keys(row._sources || {})){
  if(/Shares/.test(field))continue;
  const value=p.number(row[field]);out[field]=value!==null && rate>0?value*rate:null;
  if(out[field]!==null)out._presentations[field]={type:'calculated_currency_presentation',originalValue:value,originalCurrency:currency,rate,basis:statement==='balance'?'period-end month closing rate':'period-average monthly closing rates',source:'Yahoo Finance historical FX',intervalStart:statement==='balance'?row.fiscalDateEnding:row.periodStart,intervalEnd:row.fiscalDateEnding,inputSources:row._sources[field],approximate:true};
 }
 return out;
}
function usd(data,rates={}){const out={...data};for(const st of ['income','balance','cash']){out[st]={};for(const basis of ['annualReports','quarterlyReports'])out[st][basis]=(data[st]?.[basis] || []).map(r=>convertRow(r,st,rates[r.reportedCurrency]));}return out;}
module.exports={convertRow,usd};
