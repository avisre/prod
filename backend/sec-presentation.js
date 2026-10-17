'use strict';
// Optional presentation values. SEC source observations remain immutable.
const p=require('./sec-coverage'),fx=require('./fx-conversion');
// A balance converts at the closing rate of its month; a flow at the average of the month rates it spans, all of them present.
function rateFor(points,statement,start,end){
 if(statement==='balance')return points.find(x=>x.month===end)?.rate || null;
 const window=points.filter(x=>x.month>=start && x.month<=end);
 const months=start?((Number(end.slice(0,4))-Number(start.slice(0,4)))*12+Number(end.slice(5))-Number(start.slice(5))+1):0;
 return months && new Set(window.map(x=>x.month)).size===months?window.reduce((a,x)=>a+x.rate,0)/window.length:null;
}
// Argentina and Turkey report under IAS 29: each filing restates every amount, comparatives included,
// into pesos or lira of its own balance-sheet date, and IAS 21.42 translates all of them at that date's
// closing rate. The average rate of the period a figure covers overstates it several times over: Grupo
// Galicia's 2023 revenue, as its 2025 20-F restates it, came to $35B. The months are the first period
// ends each country's reporters restated (periods ending on or after 1 July 2018 and 30 June 2022).
const HYPERINFLATION={ARS:'2018-07',TRY:'2022-06'};
const monthsApart=(a,b)=>(Number(b.slice(0,4))-Number(a.slice(0,4)))*12+Number(b.slice(5,7))-Number(a.slice(5,7));
// An annual report is measured at the fiscal year end it was filed after; an interim report at the
// latest period it reports, unless it was furnished long after that, when its date is not known.
function measuredMonth(id,ctx){
 const s=ctx.sources?.[id];if(!s?.filingDate)return '';
 if(/^(10-K|20-F|40-F)(\/A)?$/.test(s.form)){
  if(!/^\d{2}-\d{2}$/.test(ctx.fye || ''))return '';
  let year=Number(s.filingDate.slice(0,4));if(`${year}-${ctx.fye}`>s.filingDate)year--;
  return `${year}-${ctx.fye}`.slice(0,7);
 }
 const end=ctx.latest?.get(s.accessionNumber) || '';
 return end && monthsApart(end,s.filingDate)<=6?end.slice(0,7):'';
}
function convertRow(row,statement,series,ctx={}){
 const currency=row?.reportedCurrency;if(!row || currency==='USD')return row;
 const end=String(row.fiscalDateEnding).slice(0,7),start=String(row.periodStart || '').slice(0,7);
 const points=fx.normalizeSeries(series),rate=rateFor(points,statement,start,end),restated=HYPERINFLATION[currency];
 const out={...row,originalReportedCurrency:currency,reportedCurrency:'USD',_presentations:{}};
 for(const field of Object.keys(row._sources || {})){
  if(/Shares/.test(field))continue;
  let r=rate,basis=statement==='balance'?'period-end month closing rate':'period-average monthly closing rates',intervalStart=statement==='balance'?row.fiscalDateEnding:row.periodStart,intervalEnd=row.fiscalDateEnding;
  if(restated){
   const months=[...new Set(row._sources[field].map(id=>measuredMonth(id,ctx)))],month=months.length===1?months[0]:'';
   if(!month || month>=restated){r=month?points.find(x=>x.month===month)?.rate || null:null;basis='closing rate of the month the filing measures in (IAS 29, IAS 21.42)';intervalStart=intervalEnd=month;}
  }
  const value=p.number(row[field]);out[field]=value!==null && r>0?value*r:null;
  if(out[field]!==null)out._presentations[field]={type:'calculated_currency_presentation',originalValue:value,originalCurrency:currency,rate:r,basis,source:'Yahoo Finance historical FX',intervalStart,intervalEnd,inputSources:row._sources[field],approximate:true};
 }
 return out;
}
function usd(data,rates={}){
 const sources=data.provenance?.sources || {},latest=new Map();
 for(const x of Object.values(sources))if(x?.accessionNumber && String(x.periodEnd || '')>(latest.get(x.accessionNumber) || ''))latest.set(x.accessionNumber,x.periodEnd);
 const ctx={sources,latest,fye:String(data.coverage?.latestAnnual?.reportDate || '').slice(5)};
 const out={...data};for(const st of ['income','balance','cash']){out[st]={};for(const basis of ['annualReports','quarterlyReports'])out[st][basis]=(data[st]?.[basis] || []).map(r=>convertRow(r,st,rates[r.reportedCurrency],ctx));}return out;
}
// Provider and issuer-defined observations beside the statements (all SK hynix has until its first
// 20-F) convert on the same basis. One without a start date covers the twelve or three months its
// basis names; one with no rate for its period stays as reported, under its own unit.
const money=f=>/^[A-Z]{3}$/.test(f?.currency || '') && f.unit===f.currency;
function convertObservation(f,series){
 if(!money(f) || f.currency==='USD')return f;
 const value=p.number(f.value),end=String(f.periodEnd || '').slice(0,7),length={annual:12,quarterly:3}[f.historyBasis || f.basis];
 let start=String(f.periodStart || '').slice(0,7);
 if(!start && length && /^\d{4}-\d{2}$/.test(end))start=new Date(Date.UTC(Number(end.slice(0,4)),Number(end.slice(5))-length,1)).toISOString().slice(0,7);
 const rate=rateFor(fx.normalizeSeries(series),f.statement,start,end);
 if(value===null || !(rate>0))return f;
 return {...f,value:Math.round(value*rate*100)/100,unit:'USD',currency:'USD',presentation:{type:'calculated_currency_presentation',originalValue:value,originalCurrency:f.currency,rate,basis:f.statement==='balance'?'period-end month closing rate':'period-average monthly closing rates',intervalStart:f.statement==='balance'?f.periodEnd:start,intervalEnd:f.periodEnd,source:'Yahoo Finance historical FX',approximate:true}};
}
function observedCurrency(data){return [...(data?.supplementalObservations || []),...(data?.industryObservations || [])].find(money)?.currency || '';}
function usdObservations(data,source,series){const out={};for(const k of ['supplementalObservations','industryObservations'])if(Array.isArray(data?.[k]))out[k]=data[k].map(f=>f?.currency===source?convertObservation(f,series):f);return out;}
module.exports={HYPERINFLATION,convertRow,usd,convertObservation,observedCurrency,usdObservations};
