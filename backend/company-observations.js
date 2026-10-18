'use strict';
const p=require('./sec-coverage');
const STATES=['available','missing','not_applicable','not_disclosed','undefined_calculation','conflicting_evidence','retrieval_failed'];
const definitions={totalRevenue:'Reported company revenue; bank net revenue where explicitly supported',netIncome:'Net income with entity or parent scope retained',longTermDebt:'Noncurrent borrowing debt, excluding current maturities',shortTermDebt:'Current borrowing debt including current maturities',shortLongTermDebtTotal:'Current plus noncurrent borrowing debt',currentLongTermDebt:'Current portion of long-term borrowing debt'};
function observations(data) {
 const out=[];if(!data)return out;
 for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports'])for(const row of data[st]?.[basis] || [])for(const field of Object.keys(row._sources || {})) {
  if(!p.verifiedField(data,row,field))continue;
  const sources=row._sources[field].map(id=>data.sources[id]);const currency=row.reportedCurrency;
  out.push({issuer:data.cik,field,definition:definitions[field] || field,value:row[field],scale:1,unit:/EPS|^eps$/.test(field)?currency+'/shares':/Shares/.test(field)?'shares':currency,currency,
   periodStart:row.periodStart,periodEnd:row.fiscalDateEnding,basis:row.periodType==='instant'?'instant':basis==='annualReports'?'annual':'quarterly',historyBasis:basis==='annualReports'?'annual':'quarterly',accountingBasis:sources[0].taxonomy==='ifrs-full'?'IFRS':'US GAAP',scope:row._scopes[field] || 'entity',statement:st,
   sourceType:'sec_filing',sourceName:'SEC',sourceUrl:sources[0].filingUrl,publicationDate:sources.map(s=>s.filingDate).sort().pop(),retrievedAt:data.fetchedAt,sourceIds:row._sources[field],sourceVersions:sources.map(s=>s.accessionNumber),verificationMethod:row._derivations[field]?.formula || sources[0].verificationMethod || 'company_facts',extractionVersion:data.extractionVersion || 'legacy',derivation:row._derivations[field] || null,state:'available'});
 }
 for(const f of data.industryObservations || [])if(require('./sec-industry-tables').validObservation(f,data.cik))out.push(f);
 return out;
}
function identity(value){return p.cik(value) || (/^listing:[A-Z0-9]+(?:-[A-Z0-9]+)?$/.test(String(value || ''))?value:null);}
function validSupplement(f,issuer) {
 if(!identity(issuer) || identity(f?.issuer)!==identity(issuer) || p.number(f?.value)===null || !f.field || !f.definition || !p.day(f.periodEnd) || !Number.isFinite(Date.parse(f.retrievedAt || '')) || !f.scope || !f.unit || !f.accountingBasis || f.scale!==1)return false;
 if(String(issuer).startsWith('listing:') && f.sourceType!=='provider')return false;
 const date=sourceDate(f);if(!date || (!p.day(f.publicationDate) && !(f.sourceType==='provider' && f.sourceDateKind==='retrieval' && f.sourceDataDate===p.day(f.retrievedAt))))return false;
 if(Date.parse(f.retrievedAt)>Date.now()+5*60*1000 || date>p.day(new Date().toISOString()) || f.periodEnd>p.day(new Date().toISOString()) || date<f.periodEnd || p.day(f.retrievedAt)<date)return false;
 if(!Array.isArray(f.sourceIds) || !f.sourceIds.length || f.sourceIds.some(id=>typeof id!=='string' || !id) || !STATES.includes(f.state) || ![f.currency,f.currency+'/shares','shares','%'].includes(f.unit))return false;
 if(!/^[A-Z]{3}$/.test(f.currency || '') || !['annual','quarterly','instant','market'].includes(f.basis) || !['provider','issuer_release','sec_filing'].includes(f.sourceType))return false;
 if(['annual','quarterly'].includes(f.basis) && !p.day(f.periodStart) && !(f.sourceType==='provider' && f.periodDefinition))return false;
 try{const u=new URL(f.sourceUrl);if(u.protocol!=='https:' || !u.hostname || !f.sourceName)return false;}catch(_){return false;}
 return true;
}
function sourceDate(f){return p.day(f?.publicationDate) || p.day(f?.sourceDataDate);}
function key(f){return [f.issuer,f.field,f.periodStart || '',f.periodEnd,f.unit,f.accountingBasis,f.scope,f.basis].join('|');}
function reconcile(filed,supplemental) {
 const filedKeys=new Set(filed.map(key)),out=new Map();
 const priority={sec_filing:3,issuer_release:2,provider:1};
 for(const f of supplemental) {
  if(filedKeys.has(key(f)))continue;
  const old=out.get(key(f));
  const newDate=sourceDate(f) || '',oldDate=sourceDate(old) || '';
  if(old && old.value!==f.value && priority[old.sourceType]===priority[f.sourceType] && newDate===oldDate && !(old.sourceUrl===f.sourceUrl && Date.parse(f.retrievedAt)>Date.parse(old.retrievedAt))){out.set(key(f),{...old,state:'conflicting_evidence',conflictingSources:[old.sourceUrl,f.sourceUrl]});continue;}
  if(!old || priority[f.sourceType]>priority[old.sourceType] || (priority[f.sourceType]===priority[old.sourceType] && (newDate>oldDate || newDate===oldDate && old.sourceUrl===f.sourceUrl && Date.parse(f.retrievedAt)>Date.parse(old.retrievedAt))))out.set(key(f),f);
 }
 return [...out.values()];
}
function gaps(facts,fields,periods,cadence='quarterly',reporting={}) {
 const out=[];
 for(const basis of ['annual','quarterly']) {
  const count=Math.max(0,Math.min(basis==='annual'?25:48,Number(periods?.[basis] ?? (basis==='annual'?5:4))));
  for(const field of fields) {
   if(!count)continue;
   const selected=facts.filter(f=>f.field===field && (f.historyBasis || f.basis)===basis && f.state==='available');
   const groups=new Map();for(const f of selected){const group=[f.issuer,f.unit,f.accountingBasis,f.scope].join('|');if(!groups.has(group))groups.set(group,[]);groups.get(group).push(f.periodEnd);}
   const histories=[...groups.values()].map(values=>[...new Set(values)].sort().reverse());
   const dates=histories.sort((a,b)=>b.length-a.length || (b[0] || '').localeCompare(a[0] || ''))[0] || [];
   if(dates.length<count)out.push({field,basis,state:'missing',reason:cadence!=='quarterly' && basis==='quarterly'?'Issuer interim cadence must be checked in original disclosures':'Insufficient compatible reported periods',availablePeriods:dates.length,requiredPeriods:count});
   if(basis==='quarterly' && cadence==='quarterly')for(let i=1;i<Math.min(count,dates.length);i++){const delta=(Date.parse(dates[i-1])-Date.parse(dates[i]))/86400000;if(delta<75 || delta>105){out.push({field,basis,state:'missing',reason:'Nonconsecutive quarterly history',after:dates[i],before:dates[i-1]});break;}}
   const latest=basis==='annual'?reporting.latestAnnual:cadence==='quarterly' && /^(10-Q|10-K)(\/A)?$/.test(reporting.latestPeriodic?.form || '')?reporting.latestPeriodic:null;
   const requiredEnd=p.day(latest?.reportDate);
   // When other lines of that period were extracted, the filing was read and reports no value for this one
   // (AppLovin files no capital-expenditure line from FY2025): saying it "has not been extracted" read as our failure.
   const reaches=f=>Date.parse(f.periodEnd)>=Date.parse(requiredEnd)-14*86400000;
   if(requiredEnd && !selected.some(reaches))out.push({field,basis,state:'missing',reason:facts.some(f=>(f.historyBasis || f.basis)===basis && f.state==='available' && reaches(f))?'The latest filed reporting period reports no value for this line':'The latest filed reporting period has not been extracted',requiredPeriodEnd:requiredEnd,filingUrl:latest.filingUrl || null});
  }
 }
 return out;
}
module.exports={STATES,definitions,observations,validSupplement,reconcile,key,gaps,sourceDate,identity};
