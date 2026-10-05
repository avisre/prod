'use strict';
// Streaming inline-XBRL extraction: no model, fuzzy custom-tag mapping or HTML DOM.
const { Parser } = require('htmlparser2');
const axios = require('axios');
const p = require('./sec-coverage');
const { MAPS } = require('./sec-facts');
const { HEADERS } = require('./sec-reporting');
const MAX_BYTES = 18 * 1024 * 1024;
function parseOriginal(text, filing, cik) {
 if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('ORIGINAL_DOCUMENT_TOO_LARGE');
 const contexts=new Map(),units=new Map(),facts=[],stack=[];let context=null,unit=null,fact=null,narrative='';
 const local=name=>name.split(':').pop().toLowerCase();
 const parser=new Parser({
  onopentag(name,attrs) {
   const tag=local(name);stack.push(tag);
   if(tag==='context')context={id:attrs.id,dimensions:[],start:null,end:null,issuer:null};
   if(context && ['explicitmember','typedmember'].includes(tag))context.dimensions.push({axis:attrs.dimension,member:''});
   if(tag==='unit')unit={id:attrs.id,measures:[],divide:false};
   if(unit && tag==='divide')unit.divide=true;
   if(tag==='nonfraction')fact={...attrs,text:''};
  },
  ontext(value) {
   const tag=stack[stack.length-1];
   if(context) {
    if(tag==='identifier')context.issuer=(context.issuer || '')+value;
    if(tag==='startdate')context.start=(context.start || '')+value;
    if(['enddate','instant'].includes(tag))context.end=(context.end || '')+value;
    if(tag==='explicitmember')context.dimensions[context.dimensions.length-1].member+=value;
   }
   if(unit && tag==='measure')unit.measures.push(value.trim().split(':').pop());
   if(fact)fact.text+=value;
   if(narrative.length<1024*1024 && !['script','style'].includes(tag))narrative+=' '+value;
  },
  onclosetag(name) {
   const tag=local(name);
   if(tag==='context' && context){contexts.set(context.id,context);context=null;}
   if(tag==='unit' && unit){units.set(unit.id,unit);unit=null;}
   if(tag==='nonfraction' && fact){facts.push(fact);fact=null;}
   stack.pop();
  }
 },{decodeEntities:true,lowerCaseTags:true,lowerCaseAttributeNames:true,recognizeSelfClosing:true});
 parser.end(text);
 const wanted=new Set();for(const fields of Object.values(MAPS))for(const def of Object.values(fields))for(const tax of ['us-gaap','ifrs-full'])for(const tag of def[tax])wanted.add(tax+':'+tag);
 const doc={cik:Number(cik),facts:{},originalDocument:{url:filing.documentUrl,documentUrl:filing.documentUrl,accession:filing.accessionNumber,accessionNumber:filing.accessionNumber,form:filing.form,filingDate:filing.filingDate},segments:[]};
 for(const raw of facts) {
  const c=contexts.get(raw.contextref),u=units.get(raw.unitref),name=raw.name;
  if(!c || p.cik(c.issuer?.trim())!==p.cik(cik) || !u || !name || !p.day(c.end?.trim()))continue;
  if(/:fixed-zero$/.test(raw.format || ''))raw.text='0';
  if(raw['xsi:nil']==='true' || !/^[+-]?(?:\d[\d, .]*|\.\d+)$/.test(raw.text.trim()))continue;
  // Unknown transformation formats cannot establish a numerical value.
  if(raw.format && !/:(?:num(?:dotdecimal|-dot-decimal)|fixed-zero)$/i.test(raw.format))continue;
  const receipt={rawText:raw.text,format:raw.format,scale:raw.scale || 0,sign:raw.sign};
  const val=require('./sec-inline-number').number(receipt);if(val===null)continue;
  const [taxonomy,concept]=name.split(':'),measure=u.divide?u.measures.join('/'):u.measures[0];
  const f={val,start:c.start?.trim() || undefined,end:c.end.trim(),accn:filing.accessionNumber,form:filing.form,filed:filing.filingDate,
   _original:{documentUrl:filing.documentUrl,contextRef:raw.contextref,decimals:raw.decimals || null,dimensions:c.dimensions,numericReceipt:receipt}};
  if(c.dimensions.length) {
   // A single disclosed segment axis is retained separately, never entity revenue.
   const segmentDims=c.dimensions.filter(d=>!(d.axis==='srt:ConsolidationItemsAxis' && d.member==='us-gaap:OperatingSegmentsMember'));
   if(wanted.has(name) && /Revenue/.test(concept) && segmentDims.length===1 && /(?:StatementBusinessSegments|Segments|ProductOrService)Axis$/.test(segmentDims[0].axis || ''))doc.segments.push({concept,taxonomy,unit:measure,...f,_original:{...f._original,dimensions:segmentDims,allDimensions:c.dimensions}});
   continue;
  }
  if(!wanted.has(name))continue;
  ((doc.facts[taxonomy] ||= {})[concept] ||= {units:{}}).units[measure] ||= [];
  doc.facts[taxonomy][concept].units[measure].push(f);
 }
 const plain=narrative.replace(/\s+/g,' ');
 const currencies=[['New Taiwan dollars','TWD'],['Renminbi','CNY'],['Japanese yen','JPY'],['Canadian dollars','CAD'],['euros','EUR'],['U.S. dollars','USD']];
 const declared=currencies.filter(([label])=>new RegExp('(?:publish our financial statements in|financial statements (?:are )?(?:presented|expressed) in) '+label.replace(/\./g,'\\.'),'i').test(plain));
 if(declared.length===1)doc.reportingCurrency=declared[0][1];
 if(require('./sec-industry-tables').REGISTRY[p.cik(cik)])doc.industryTables=require('./sec-industry-tables').tablesFrom(text).filter(t=>/reconciliation/i.test(t.caption) && t.rows.some(r=>r.some(c=>/FFO available to common stockholders/.test(c))));
 return doc;
}
async function fetchOriginal(cik,filing) {
 if(!filing?.primaryDocument || !/^[a-zA-Z0-9_.-]+$/.test(filing.primaryDocument))throw new Error('ORIGINAL_DOCUMENT_PATH_UNAVAILABLE');
 const documentUrl=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accessionNumber.replace(/-/g,'')}/${filing.primaryDocument}`;
 const response=await axios.get(documentUrl,{headers:HEADERS,timeout:20000,maxContentLength:MAX_BYTES,responseType:'text'});
 return parseOriginal(String(response.data),{...filing,documentUrl},cik);
}
function mergeFacts(raw,original) {
 const annual=/^(10-K|20-F|40-F)(\/A)?$/.test(original.originalDocument?.form || '');
 const merged={...raw,facts:{...raw.facts},segmentFacts:[...(raw.segmentFacts || []),...(original.segments || [])],industryTables:original.industryTables || raw.industryTables || [],industryFiling:annual || !raw.industryFiling?original.originalDocument:raw.industryFiling,originalDocuments:[...(raw.originalDocuments || []),original.originalDocument]};
 for(const [tax,defs]of Object.entries(original.facts)) {
  merged.facts[tax]={...merged.facts[tax]};
  for(const [tag,def]of Object.entries(defs)) {
   const old=merged.facts[tax][tag] || {units:{}};const units={...old.units};
   for(const [unit,rows]of Object.entries(def.units))units[unit]=[...(units[unit] || []).filter(f=>!rows.some(n=>n.accn===f.accn && n.start===f.start && n.end===f.end)),...rows];
   merged.facts[tax][tag]={...old,units};
  }
 }
 return merged;
}
module.exports={parseOriginal,fetchOriginal,mergeFacts,MAX_BYTES};
