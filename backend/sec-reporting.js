'use strict';
const axios = require('axios');
require('./sec-throttle');
const p = require('./sec-coverage');
const HEADERS={'User-Agent':'stockportfolio.pro contact@stockportfolio.pro',Accept:'application/json','Accept-Encoding':'gzip, deflate'};
async function getJson(url,{get=axios.get,wait=ms=>new Promise(r=>setTimeout(r,ms)),maxBytes=64*1024*1024}={}) {
 for(let attempt=0;attempt<3;attempt++) {
  try {const r=await get(url,{headers:HEADERS,timeout:20000,maxContentLength:maxBytes,responseType:'json',transitional:{silentJSONParsing:false}});if(!r.data || typeof r.data!=='object' || Array.isArray(r.data))throw Object.assign(new Error('INVALID_SEC_JSON'),{permanent:true});return r.data;}
  catch(e){const status=e.response?.status;if(e.permanent || e instanceof SyntaxError || e.cause instanceof SyntaxError || /maxContentLength/.test(e.message) || status===404 || (status && status<500 && ![408,429].includes(status)) || attempt===2)throw e;const retry=Number(e.response?.headers?.['retry-after']);await wait(Math.max(attempt===0?1000:3000,Number.isFinite(retry)?Math.min(60,retry)*1000:0));}
 }
}
function parseFilings(columns,cik) {
 if(!columns || !Array.isArray(columns.accessionNumber))throw new Error('INVALID_SEC_SUBMISSIONS');
 const fields=['form','filingDate','reportDate','primaryDocument'];
 if(fields.some(k=>!Array.isArray(columns[k]) || columns[k].length!==columns.accessionNumber.length))throw new Error('MALFORMED_SEC_COLUMNS');
 return columns.accessionNumber.map((acc,i)=>({form:columns.form[i],accessionNumber:acc,filingDate:columns.filingDate[i],reportDate:columns.reportDate[i],items:columns.items?.[i] || '',primaryDocument:columns.primaryDocument[i] || null,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(acc).replace(/-/g,'')}/${acc}-index.htm`})).filter(f=>p.day(f.filingDate) && /^\d{10}-\d{2}-\d{6}$/.test(f.accessionNumber));
}
async function fetchReporting(issuer,{asOf=p.day(new Date().toISOString()),request=getJson}={}) {
 const id=p.cik(issuer.cik);if(!id)throw new Error('SEC_IDENTITY_MISMATCH');
 const raw=await request(`https://data.sec.gov/submissions/CIK${id}.json`);
 if(p.cik(raw.cik)!==id)throw new Error('SEC_IDENTITY_MISMATCH');
 let filings=parseFilings(raw.filings?.recent,id);
 const boundary=p.monthsBefore(asOf,24);
 let historyRequests=0;
 for(const file of [...(raw.filings?.files || [])].sort((a,b)=>b.filingTo.localeCompare(a.filingTo))) {
  if(file.filingFrom>asOf || (file.filingTo<boundary && p.selectAnnual(filings,asOf)) || historyRequests>=3)continue;
  const needsOriginal=!p.selectAnnual(filings,asOf);
  const rangeMissing=file.filingTo>=(p.selectAnnual(filings,asOf)?.filingDate || boundary);
  if(!needsOriginal && !rangeMissing)continue;
  if(!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name))throw new Error('INVALID_SEC_HISTORY_PATH');
  historyRequests++;
  filings=filings.concat(parseFilings(await request(`https://data.sec.gov/submissions/${file.name}`),id));
 }
 // A holding-company reorganisation (scripts/lib/us-listings.js): the listing follows the registration that
 // holds the history, and the other side of that pair continues it — the successor's reports while the listing
 // is on the predecessor, the predecessor's ten years of reports once continuity() moves the listing over.
 const other=continuing(id,asOf);
 if(other) {
  const next=await request(`https://data.sec.gov/submissions/CIK${other.cik}.json`);
  if(p.cik(next.cik)!==other.cik)throw new Error('SEC_IDENTITY_MISMATCH');
  const known=new Set(filings.map(f=>f.accessionNumber));
  filings=filings.concat(parseFilings(next.filings?.recent,other.linkCik).filter(f=>!known.has(f.accessionNumber)));
 }
 const latestAnnual=p.selectAnnual(filings,asOf);
 const latestPeriodic=filings.filter(f=>/^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/.test(f.form) && f.filingDate<=asOf).sort((a,b)=>b.filingDate.localeCompare(a.filingDate))[0] || null;
 // The quarterly report before the newest one in the same fiscal year: a later 10-Q gives cash
 // flow only year to date, and when SEC's facts feed lacks this one the quarter cannot be derived.
 const previousPeriodic=latestPeriodic?.form==='10-Q'?filings.filter(f=>f.form==='10-Q' && f.filingDate<latestPeriodic.filingDate && f.reportDate<latestPeriodic.reportDate && (!latestAnnual || f.reportDate>latestAnnual.reportDate)).sort((a,b)=>b.filingDate.localeCompare(a.filingDate))[0] || null:null;
 // Every quarterly report of the fiscal year so far: the refresh reads one whose quarter lacks a line.
 const yearPeriodics=latestAnnual?filings.filter(f=>f.form==='10-Q' && f.filingDate<=asOf && f.reportDate>latestAnnual.reportDate):[];
 const latestEarningsRelease=filings.filter(f=>(/^8-K(\/A)?$/.test(f.form) && /(?:^|,)\s*2\.02(?:,|$)/.test(f.items)) && f.filingDate<=asOf).sort((a,b)=>b.filingDate.localeCompare(a.filingDate))[0] || null;
 const registeredFundReport=filings.filter(f=>/^(N-CSR|N-CSRS|N-CEN|N-PORT-P|485APOS|485BPOS)(\/A)?$/.test(f.form) && f.filingDate<=asOf).sort((a,b)=>b.filingDate.localeCompare(a.filingDate))[0] || null;
 return {cik:id,latestEarningsRelease,sic:String(raw.sic || ''),entityType:raw.entityType || null,registeredFundReport,fundRegistrant:!!registeredFundReport && (!latestAnnual || registeredFundReport.filingDate>=latestAnnual.filingDate),reportingCadence:/^(20-F|40-F)$/.test(latestAnnual?.form || '')?'issuer_specific_interim':'quarterly',issuerName:raw.name || '',symbols:issuer.symbols || [],lastSuccessfulCheckAt:new Date().toISOString(),lastAttemptAt:new Date().toISOString(),lastAttemptResult:'success',latestAnnual,latestPeriodic,previousPeriodic,yearPeriodics,amendmentOnly:!latestAnnual && filings.some(f=>/^(10-K|20-F|40-F)\/A$/.test(f.form)),financialFile:`sec-financials/${id}.json`,lastErrorCode:null};
}
// The registration that continues this issuer's history, and the number its filings are served under. EDGAR
// serves a successor's filings under the predecessor's number too, so on the predecessor a filing keeps the
// issuer's own number; the predecessor's own filings are only under the predecessor's number.
function continuing(cik,asOf) {
 const listings=require('../scripts/lib/us-listings'),id=p.cik(cik);
 const successor=listings.successorOf(id,asOf);
 if(successor)return {cik:successor,linkCik:id};
 const predecessor=listings.predecessorOf(id,asOf);
 return predecessor?{cik:predecessor,linkCik:predecessor}:null;
}
// The predecessor's facts with the successor's added (each fact once): the successor's feed starts at the reorganisation.
function mergeFacts(base,extra) {
 const out={...base,facts:{...(base.facts || {})}};
 for(const [tax,concepts] of Object.entries(extra.facts || {})) {
  const into=out.facts[tax]={...(out.facts[tax] || {})};
  for(const [concept,fact] of Object.entries(concepts)) {
   const have=into[concept]?{...into[concept],units:{...into[concept].units}}:{...fact,units:{}};
   for(const [unit,rows] of Object.entries(fact.units || {})) {
    const list=[...(have.units[unit] || [])],seen=new Set(list.map(f=>[f.accn,f.start,f.end,f.val].join('|')));
    for(const f of rows)if(!seen.has([f.accn,f.start,f.end,f.val].join('|')))list.push(f);
    have.units[unit]=list;
   }
   into[concept]=have;
  }
 }
 return out;
}
async function fetchFacts(cik,{request=getJson,asOf=p.day(new Date().toISOString())}={}) {
 const id=p.cik(cik),raw=await request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`);
 const other=continuing(id,asOf);
 if(!other)return raw;
 let extra;try{extra=await request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${other.cik}.json`);}catch(e){if(e.response?.status===404)return raw;throw e;}
 return mergeFacts(raw,extra);
}
// EDGAR's daily index lists every filing disseminated on a business day. Reading it tells a refresh which
// registrants filed anything that can move what fetchReporting returns (annual, periodic, 8-K and fund
// reports), so the rest of the universe need not be asked one submissions request at a time.
const INDEX_FORMS=/^(10-K|10-KT|10-Q|10-QT|20-F|40-F|6-K|8-K|N-CSR|N-CSRS|N-CEN|N-PORT-P|485APOS|485BPOS)(\/A)?$/;
function parseDailyIndex(text){
 const ciks=new Set();
 for(const line of String(text).split('\n')){const c=line.split('|');if(c.length<5 || !/^\d+$/.test(c[0]) || !INDEX_FORMS.test(c[2].trim()))continue;ciks.add(p.cik(c[0]));}
 return ciks;
}
// Business days after `after` through `through`. A day whose index is not there (SEC answers 403 or 404) is a
// holiday or not yet published; it is not counted as read, so the next run asks for it again.
async function fetchFilersSince(after,through,{get=axios.get}={}) {
 const ciks=new Set(),read=[];
 for(let t=Date.parse(after+'T00:00:00Z')+86400000;t<=Date.parse(through+'T00:00:00Z');t+=86400000){
  const d=new Date(t);if([0,6].includes(d.getUTCDay()))continue;
  const day=d.toISOString().slice(0,10),stamp=day.replace(/-/g,'');
  const url=`https://www.sec.gov/Archives/edgar/daily-index/${day.slice(0,4)}/QTR${Math.floor(d.getUTCMonth()/3)+1}/master.${stamp}.idx`;
  let r;try{r=await get(url,{headers:{...HEADERS,Accept:'text/plain'},timeout:30000,responseType:'text'});}
  catch(e){if([403,404].includes(e.response?.status))continue;throw e;}
  if(!/Daily Index of EDGAR/.test(String(r.data).slice(0,400)))throw new Error('INVALID_SEC_DAILY_INDEX '+day);
  for(const id of parseDailyIndex(r.data))ciks.add(id);read.push(day);
 }
 return {ciks,read,lastRead:read.at(-1) || null};
}
module.exports={HEADERS,getJson,parseFilings,fetchReporting,fetchFacts,mergeFacts,continuing,parseDailyIndex,fetchFilersSince,INDEX_FORMS};
