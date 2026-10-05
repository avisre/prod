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
 const latestAnnual=p.selectAnnual(filings,asOf);
 const latestPeriodic=filings.filter(f=>/^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/.test(f.form) && f.filingDate<=asOf).sort((a,b)=>b.filingDate.localeCompare(a.filingDate))[0] || null;
 const latestEarningsRelease=filings.filter(f=>(/^8-K(\/A)?$/.test(f.form) && /(?:^|,)\s*2\.02(?:,|$)/.test(f.items)) && f.filingDate<=asOf).sort((a,b)=>b.filingDate.localeCompare(a.filingDate))[0] || null;
 const registeredFundReport=filings.filter(f=>/^(N-CSR|N-CSRS|N-CEN|N-PORT-P|485APOS|485BPOS)(\/A)?$/.test(f.form) && f.filingDate<=asOf).sort((a,b)=>b.filingDate.localeCompare(a.filingDate))[0] || null;
 return {cik:id,latestEarningsRelease,sic:String(raw.sic || ''),entityType:raw.entityType || null,registeredFundReport,fundRegistrant:!!registeredFundReport && (!latestAnnual || registeredFundReport.filingDate>=latestAnnual.filingDate),reportingCadence:/^(20-F|40-F)$/.test(latestAnnual?.form || '')?'issuer_specific_interim':'quarterly',issuerName:raw.name || '',symbols:issuer.symbols || [],lastSuccessfulCheckAt:new Date().toISOString(),lastAttemptAt:new Date().toISOString(),lastAttemptResult:'success',latestAnnual,latestPeriodic,amendmentOnly:!latestAnnual && filings.some(f=>/^(10-K|20-F|40-F)\/A$/.test(f.form)),financialFile:`sec-financials/${id}.json`,lastErrorCode:null};
}
async function fetchFacts(cik,{request=getJson}={}) {return request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${p.cik(cik)}.json`);}
module.exports={HEADERS,getJson,parseFilings,fetchReporting,fetchFacts};
