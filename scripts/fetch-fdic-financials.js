#!/usr/bin/env node
'use strict';
// Regulator financials for listed banks that have no SEC statements.
//
// A bank with no holding company files its Exchange Act reports (10-K/10-Q) with
// its bank regulator under Exchange Act §12(i), not with the SEC, so EDGAR has no
// statements for it and its company page showed none. The same bank files a
// quarterly Call Report (FFIEC 031/041/051), which the FDIC publishes through the
// BankFind Suite API. This script maps the Call Report lines whose FDIC
// definition matches one of our statement fields into the committed supplemental
// store (frontend/data/supplemental-financials/<id>.json), attributed to the FDIC.
//
// Field definitions: https://api.fdic.gov/banks/docs/risview_properties.yaml
// (API docs: https://api.fdic.gov/banks/docs/). FDIC values are in $ thousands
// and income fields are calendar year-to-date; the quarterly ones (…Q) are the
// discrete quarter as published by the FDIC, so nothing here is derived.
//
// The bank list was matched by name against every ACTIVE FDIC institution and
// checked by hand (state, website, no holding company or a sole bank subsidiary).
// Each run re-checks that match and refuses a bank whose FDIC record changed.
//
// Usage: node scripts/fetch-fdic-financials.js [--dry-run] [SYMBOL ...]
// Re-runnable: earlier FDIC rows for an issuer are replaced, other rows kept.
const fs=require('node:fs'),path=require('node:path');
const p=require('../backend/sec-coverage'),obs=require('../backend/company-observations');
const API='https://api.fdic.gov/banks';
const SOURCE_NAME='FDIC Call Report (FFIEC 031/041/051) via FDIC BankFind';
const EXTRACTION_VERSION='fdic-20261017';
const ANNUAL_YEARS=10,QUARTERS=20;
// holdingCompany: '' means the listed issuer IS the bank. A named holding
// company is accepted only when the FDIC bank is its sole bank subsidiary,
// and every row then carries the bank-subsidiary scope.
const BANKS=[
 {symbol:'OZK',cert:110,cik:'0001569650',name:'Bank OZK',state:'AR',holdingCompany:''},
 {symbol:'HIFS',cert:90211,name:'Hingham Institution for Savings',state:'MA',holdingCompany:''},
 {symbol:'TOWN',cert:35095,name:'TowneBank',state:'VA',holdingCompany:''},
 {symbol:'NBN',cert:19690,name:'Northeast Bank',state:'ME',holdingCompany:'',fiscalYearEnd:'06-30'},
 {symbol:'SSBI',cert:32203,name:'Summit State Bank',state:'CA',holdingCompany:''},
 {symbol:'RCBC',cert:18983,name:'River City Bank',state:'CA',holdingCompany:''},
 {symbol:'FRBA',cert:58481,name:'First Bank',state:'NJ',holdingCompany:''},
 {symbol:'ASBH',cert:32526,name:'American Savings Bank, National Association',state:'HI',holdingCompany:''},
 {symbol:'WCCB',cert:57591,cik:'0002105965',name:'West Coast Community Bank',state:'CA',holdingCompany:'WEST COAST COMMUNITY BCORP'}
];
// [our field, statement, FDIC YTD field, FDIC quarterly field, definition, scope]
const FIELDS=[
 ['interestIncome','income','INTINC','INTINQ','Total interest income','entity'],
 ['interestExpense','income','EINTEXP','EINTXQ','Total interest expense','entity'],
 ['netInterestIncome','income','NIM','NIMQ','Net interest income (total interest income less total interest expense)','entity'],
 ['nonInterestIncome','income','NONII','NONIIQ','Total noninterest income','entity'],
 ['nonInterestExpense','income','NONIX','NONIXQ','Total noninterest expense','entity'],
 ['provisionForCreditLosses','income','ELNATR','ELNATQ','Provision for credit losses (provision for loan and lease losses before CECL)','entity'],
 ['incomeBeforeTax','income','IBEFTAX','IBEFTXQ','Income before income taxes and discontinued operations','entity'],
 ['incomeTaxExpense','income','ITAX','ITAXQ','Applicable income taxes','entity'],
 ['netIncome','income','NETINC','NETINCQ','Net income attributable to the bank (after noncontrolling interests)','parent'],
 ['totalAssets','balance','ASSET',null,'Total assets','entity'],
 ['totalLiabilities','balance','LIAB',null,'Total liabilities','entity'],
 ['totalShareholderEquity','balance','EQ',null,'Total bank equity capital, excluding noncontrolling interests','parent'],
 ['deposits','balance','DEP',null,'Total deposits','entity'],
 ['loans','balance','LNLSNET',null,'Loans and leases, net of unearned income and allowance','entity']
];
const CHECK_FIELDS=['EQTOT','EQCONSUB','NETIMIN','EXTRA','CALLFORM'];
const iso=d=>d.slice(0,4)+'-'+d.slice(4,6)+'-'+d.slice(6,8);
const issuerOf=bank=>bank.cik || 'listing:'+bank.symbol;
const recordUrl=(cert,repdte)=>`${API}/financials?filters=CERT%3A${cert}%20AND%20REPDTE%3A${repdte}`;
// The identities the FDIC definitions imply. A record that breaks one is not
// the record the definitions describe, so none of its values are used.
function consistent(r){
 const n=k=>Number(r[k]);
 return [n('ASSET')-n('LIAB')-n('EQTOT'),n('EQTOT')-n('EQ')-n('EQCONSUB'),n('INTINC')-n('EINTEXP')-n('NIM'),n('IBEFTAX')-n('ITAX')+n('EXTRA')-n('NETIMIN')-n('NETINC')].every(d=>Number.isFinite(d) && Math.abs(d)<=1);
}
function observationsFor(bank,records,retrievedAt) {
 const issuer=issuerOf(bank),out=[],rejected=[];
 const sub=bank.holdingCompany?`bank_subsidiary:FDIC ${bank.cert}`:null;
 const label=sub?`Bank subsidiary only (${bank.name}, FDIC CERT ${bank.cert}); excludes holding-company-only items. `:'';
 const valid=records.filter(r=>/^\d{8}$/.test(r?.REPDTE || '') && Number(r.CERT)===bank.cert).sort((a,b)=>b.REPDTE.localeCompare(a.REPDTE));
 const latestYear=Number(valid.find(r=>r.REPDTE.endsWith('1231'))?.REPDTE.slice(0,4));
 const quarters=new Set(valid.slice(0,QUARTERS).map(r=>r.REPDTE));
 for(const r of valid) {
  const end=iso(r.REPDTE),year=r.REPDTE.slice(0,4),december=r.REPDTE.endsWith('1231');
  const annual=december && Number(year)>latestYear-ANNUAL_YEARS,quarterly=quarters.has(r.REPDTE);
  if(!annual && !quarterly)continue;
  if(!consistent(r)){rejected.push(r.REPDTE);continue;}
  const version=p.digest(r),quarterStart=iso(year+String(Math.floor((Number(r.REPDTE.slice(4,6))-1)/3)*3+1).padStart(2,'0')+'01');
  const form=Number(r.CALLFORM)?'FFIEC 0'+String(Number(r.CALLFORM)).padStart(2,'0'):null;
  for(const [field,statement,ytd,qtr,definition,scope]of FIELDS) {
   const kinds=statement==='balance'?(annual || quarterly?[[ytd,'instant',null,december?'annual':'quarterly']]:[]):[...(annual?[[ytd,'annual',year+'-01-01','annual']]:[]),...(quarterly && qtr?[[qtr,'quarterly',quarterStart,'quarterly']]:[])];
   for(const [source,basis,periodStart,historyBasis]of kinds) {
    const raw=p.number(r[source]);if(raw===null)continue;
    const periodDefinition=basis==='instant'?'Call Report balance at the report date':basis==='annual'?'Call Report calendar year-to-date, January 1 to December 31'+(bank.fiscalYearEnd && bank.fiscalYearEnd!=='12-31'?`; the bank's own fiscal year ends ${bank.fiscalYearEnd}, so this is not its fiscal year`:''):'Call Report quarter as published by the FDIC';
    const f={issuer,securitySymbol:bank.symbol,field,definition:label+definition+' (FDIC '+source+')',value:raw*1000,scale:1,unit:'USD',currency:'USD',periodStart,periodEnd:end,basis,historyBasis,periodDefinition,accountingBasis:'Regulatory (Call Report)',scope:sub || scope,statement,
     sourceType:'provider',sourceName:SOURCE_NAME,sourceUrl:recordUrl(bank.cert,r.REPDTE),publicationDate:null,sourceDataDate:p.day(retrievedAt),sourceDateKind:'retrieval',retrievedAt,sourceVersions:[version],
     verificationMethod:'structured_regulator',extractionVersion:EXTRACTION_VERSION,state:'available',sourceIds:['provider:'+p.digest({issuer,field,periodEnd:end,basis,version}).slice(0,24)],fdicCert:bank.cert,fdicField:source,callReportForm:form};
    if(obs.validSupplement(f,issuer))out.push(f);
   }
  }
 }
 // Newest first: the company page lists the first 40 rows of a view.
 out.sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd) || FIELDS.findIndex(x=>x[0]===a.field)-FIELDS.findIndex(x=>x[0]===b.field));
 return {observations:out,rejected};
}
function merge(previous,fresh,issuer){return obs.reconcile([],[...(previous || []).filter(f=>f.sourceName!==SOURCE_NAME && obs.validSupplement(f,issuer)),...fresh]);}
// The bank must still be the active, unaffiliated (or sole-subsidiary) bank we checked.
function verifyInstitution(bank,inst,siblings) {
 const problems=[];
 if(!inst)return ['no FDIC institution'];
 if(Number(inst.ACTIVE)!==1)problems.push('not active');
 if(String(inst.STALP)!==bank.state)problems.push('state '+inst.STALP);
 if(String(inst.NAME).toLowerCase()!==bank.name.toLowerCase())problems.push('name '+inst.NAME);
 if(String(inst.NAMEHCR || '')!==bank.holdingCompany)problems.push('holding company '+(inst.NAMEHCR || 'none'));
 if(bank.holdingCompany && siblings!==1)problems.push(siblings+' banks under the holding company');
 return problems;
}
async function getJson(url){const r=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(url+' HTTP '+r.status);return r.json();}
async function fetchBank(bank) {
 const fields=[...new Set(['CERT','REPDTE',...FIELDS.flatMap(f=>[f[2],f[3]]).filter(Boolean),...CHECK_FIELDS])].join(',');
 const inst=(await getJson(`${API}/institutions?filters=CERT%3A${bank.cert}&fields=CERT,NAME,STALP,ACTIVE,NAMEHCR,RSSDHCR`)).data?.[0]?.data;
 const siblings=bank.holdingCompany && inst?.RSSDHCR?(await getJson(`${API}/institutions?filters=RSSDHCR%3A${inst.RSSDHCR}%20AND%20ACTIVE%3A1&fields=CERT`)).totals?.count:0;
 const problems=verifyInstitution(bank,inst,siblings);if(problems.length)throw new Error(bank.symbol+' FDIC match changed: '+problems.join('; '));
 const body=await getJson(`${API}/financials?filters=CERT%3A${bank.cert}&fields=${fields}&sort_by=REPDTE&sort_order=DESC&limit=${4*ANNUAL_YEARS+8}`);
 return (body.data || []).map(x=>x.data);
}
async function main() {
 const args=process.argv.slice(2),dry=args.includes('--dry-run'),only=new Set(args.filter(a=>!a.startsWith('--')).map(s=>s.toUpperCase()));
 const banks=BANKS.filter(b=>!only.size || only.has(b.symbol)),results=[];
 // Nine small requests: four at a time is plenty and polite to a public API.
 for(let i=0;i<banks.length;i+=4)results.push(...await Promise.all(banks.slice(i,i+4).map(async bank=>{try{return {bank,records:await fetchBank(bank)};}catch(e){return {bank,error:e.message};}})));
 const summary=[];
 for(const {bank,records,error}of results) {
  if(error){summary.push({symbol:bank.symbol,error});process.exitCode=1;continue;}
  const issuer=issuerOf(bank),retrievedAt=new Date().toISOString(),{observations,rejected}=observationsFor(bank,records,retrievedAt);
  const file=path.join(p.DATA_DIR,'supplemental-financials',issuer.replace(':','-')+'.json');let previous=null;
  try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const merged=merge(previous?.observations,observations,issuer);
  const years=[...new Set(observations.filter(f=>f.basis==='annual').map(f=>f.periodEnd.slice(0,4)))].sort();
  summary.push({symbol:bank.symbol,cert:bank.cert,issuer,observations:observations.length,kept:merged.length-observations.length,annual:years[0]+'-'+years[years.length-1],latest:observations[0]?.periodEnd,rejectedRecords:rejected});
  if(!dry && observations.length)p.atomicWrite(file,{schemaVersion:1,issuer,...(bank.cik?{cik:bank.cik}:{}),symbol:bank.symbol,checkedAt:retrievedAt,refreshStatus:'success',observations:merged});
 }
 console.log(JSON.stringify(summary,null,1));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={BANKS,FIELDS,SOURCE_NAME,observationsFor,merge,consistent,verifyInstitution};
