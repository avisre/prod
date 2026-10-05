'use strict';
// Original issuer releases furnished to EDGAR remain supplemental evidence.
// Untagged/custom tables need a reviewed parser; their values are never guessed.
const axios=require('axios'),{Parser}=require('htmlparser2');
const p=require('./sec-coverage'),obs=require('./company-observations');
const {MAPS,EXTRACTION_VERSION,partialRevenueConcept,scope}=require('./sec-facts');
const {HEADERS}=require('./sec-reporting'),{parseOriginal,MAX_BYTES}=require('./sec-original');
function observations(document,cik,fields,sic) {
 const filing=document.originalDocument,result=[];
 for(const [statement,defs]of Object.entries(MAPS))for(const [field,def]of Object.entries(defs)) {
  if(!fields.includes(field) || /Shares|EPS|^eps$/.test(field))continue;
  const selected=new Map();
  for(const tax of ['us-gaap','ifrs-full'])for(const concept of def[tax])for(const [currency,rows]of Object.entries(document.facts[tax]?.[concept]?.units || {})) {
   if(field==='totalRevenue' && partialRevenueConcept(sic,concept))continue;
   if(!/^[A-Z]{3}$/.test(currency) || (document.reportingCurrency && document.reportingCurrency!==currency))continue;
   for(const row of rows) {
    const duration=row.start?(Date.parse(row.end)-Date.parse(row.start))/86400000+1:null;
    const basis=statement==='balance' && duration===null?'instant':duration>=340 && duration<=380?'annual':duration>=75 && duration<=105?'quarterly':null;
    if(!basis)continue;
    const key=[basis,row.start,row.end].join('|'),old=selected.get(key);
    if(old){if(old.currency!==currency || (old.concept===concept && old.value!==row.val))old.conflict=true;continue;}
    selected.set(key,{issuer:p.cik(cik),field,definition:obs.definitions[field] || field,value:row.val,scale:1,unit:currency,currency,periodStart:row.start || null,periodEnd:row.end,basis,historyBasis:basis==='instant'?'quarterly':basis,accountingBasis:tax==='ifrs-full'?'IFRS':'US GAAP',scope:scope(concept,def.scope || 'entity'),statement,sourceType:'issuer_release',sourceName:'Issuer earnings release (furnished to SEC)',sourceUrl:filing.url,publicationDate:filing.filingDate,retrievedAt:new Date().toISOString(),sourceVersions:[filing.accessionNumber],sourceIds:['release:'+p.digest({cik,field,context:row._original.contextRef,filing:filing.accessionNumber}).slice(0,24)],verificationMethod:'original_inline_xbrl',extractionVersion:EXTRACTION_VERSION,state:'available',concept});
   }
  }
  result.push(...[...selected.values()].filter(f=>!f.conflict && obs.validSupplement(f,cik)));
 }
 return result;
}
async function fetchRelease(cik,filing,fields,{get=axios.get,sic}={}) {
 if(!filing || !(/^(8-K|6-K)(\/A)?$/.test(filing.form)) || !/^[\w.-]+$/.test(filing.primaryDocument || '') || !/^\d{10}-\d{2}-\d{6}$/.test(filing.accessionNumber || ''))return {observations:[],attempts:[{source:'Official issuer release',status:'not_disclosed',reason:'No applicable issuer earnings release has been identified'}]};
 const base=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accessionNumber.replace(/-/g,'')}/`;
 const config={headers:HEADERS,timeout:10000,maxContentLength:MAX_BYTES,responseType:'text'};
 const primary=String((await get(base+filing.primaryDocument,config)).data),links=[];
 new Parser({onopentag(name,a){if(name==='a' && /(?:ex(?:hibit)?[-_]?99|99[-_.]1).*\.html?$/i.test(a.href || '') && /^[\w.-]+$/.test(a.href))links.push(a.href);}},{decodeEntities:true}).end(primary);
 const documents=[{url:base+filing.primaryDocument,text:primary}];
 // At most two page fetches: primary plus its financial-results exhibit.
 if(links[0])documents.push({url:base+links[0],text:String((await get(base+links[0],config)).data)});
 const result=[];for(const doc of documents)result.push(...observations(parseOriginal(doc.text,{...filing,documentUrl:doc.url},cik),cik,fields,sic));
 return {observations:obs.reconcile([],result),attempts:documents.map(doc=>({source:'Official issuer release',url:doc.url,date:filing.filingDate,status:result.length?'success':'unsupported_extraction',reason:result.length?null:'No compatible standard inline facts; untagged financial tables require a reviewed mapping'}))};
}
module.exports={observations,fetchRelease};
