'use strict';
// Streaming inline-XBRL extraction: no model, fuzzy custom-tag mapping or HTML DOM.
const { Parser } = require('htmlparser2');
const axios = require('axios');
const p = require('./sec-coverage');
const { MAPS } = require('./sec-facts');
const { HEADERS } = require('./sec-reporting');
// The weekly reconciliation raises this (SEC_ORIGINAL_MAX_MB): large foreign
// annual reports run past 18 MB (National Grid, Korea Electric), and a runner
// has the memory a web instance does not.
const MAX_BYTES = (Number(process.env.SEC_ORIGINAL_MAX_MB) || 18) * 1024 * 1024;
// shared: the periods and units of a multi-document filing are declared once,
// in whichever document carries the header, and referenced from the others.
function parseOriginal(text, filing, cik, shared) {
 if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('ORIGINAL_DOCUMENT_TOO_LARGE');
 const contexts=shared?.contexts || new Map(),units=shared?.units || new Map(),facts=[],stack=[],coverCiks=[],open=[];let context=null,unit=null,coverCik=null,narrative='';
 const local=name=>name.split(':').pop().toLowerCase();
 const parser=new Parser({
  onopentag(name,attrs) {
   const tag=local(name);stack.push(tag);
   if(tag==='context')context={id:attrs.id,dimensions:[],start:null,end:null,issuer:null};
   if(context && ['explicitmember','typedmember'].includes(tag))context.dimensions.push({axis:attrs.dimension,member:''});
   if(tag==='unit')unit={id:attrs.id,measures:[],divide:false};
   if(unit && tag==='divide')unit.divide=true;
   // A nonFraction can wrap another (Alto Ingredients' exact share count holds a nested copy);
   // each open fact keeps reading the text inside it, so the outer one is not lost.
   if(tag==='nonfraction')open.push({...attrs,text:''});
   if(tag==='nonnumeric' && attrs.name==='dei:EntityCentralIndexKey')coverCik={contextref:attrs.contextref,text:''};
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
   for(const f of open)f.text+=value;
   if(coverCik)coverCik.text+=value;
   if(narrative.length<1024*1024 && !['script','style'].includes(tag))narrative+=' '+value;
  },
  onclosetag(name) {
   const tag=local(name);
   if(tag==='context' && context){contexts.set(context.id,context);context=null;}
   if(tag==='unit' && unit){units.set(unit.id,unit);unit=null;}
   if(tag==='nonfraction' && open.length)facts.push(open.pop());
   if(tag==='nonnumeric' && coverCik){coverCiks.push(coverCik);coverCik=null;}
   stack.pop();
  }
 },{decodeEntities:true,lowerCaseTags:true,lowerCaseAttributeNames:true,recognizeSelfClosing:true});
 parser.end(text);
 const wanted=new Set();for(const fields of Object.values(MAPS))for(const def of Object.values(fields))for(const tax of ['us-gaap','ifrs-full'])for(const tag of def[tax])wanted.add(tax+':'+tag);
 // Tanger files one 10-K for itself and its operating partnership and tags both sets of
 // statements with a legal-entity member, leaving none on the plain context (FY2025). Its cover
 // page binds the plain context to Tanger's CIK and the partnership's member to the partnership's,
 // so the one member bound to no other CIK carries the registrant's own statements.
 const legal=c=>c?.dimensions.length===1 && c.dimensions[0].axis==='dei:LegalEntityAxis'?c.dimensions[0].member.trim():null;
 let ownMember=null;
 const core=new Set();for(const [st,field] of [['income','netIncome'],['income','totalRevenue'],['balance','totalAssets'],['balance','totalShareholderEquity'],['cash','operatingCashflow']])for(const tax of ['us-gaap','ifrs-full'])for(const tag of MAPS[st][field][tax])core.add(tax+':'+tag);
 if(!facts.some(f=>core.has(f.name) && contexts.get(f.contextref)?.dimensions.length===0)) {
  const bound=new Map();for(const k of coverCiks){const c=contexts.get(k.contextref);if(c)bound.set(c.dimensions.length?legal(c):'',p.cik(k.text.trim()));}
  const used=new Set(facts.filter(f=>core.has(f.name)).map(f=>legal(contexts.get(f.contextref))).filter(Boolean)),free=[...used].filter(m=>!bound.has(m));
  if(bound.get('')===p.cik(cik) && free.length===1 && [...used].every(m=>m===free[0] || bound.get(m)!==p.cik(cik)))ownMember=free[0];
 }
 // Proficient Auto Logistics shows predecessor and successor columns (FY2025) and tags its whole
 // income and cash-flow statements with a SuccessorMember, leaving the plain context to note figures
 // (depreciation of $88K beside $39.3M on the statement). For a year whose revenue or operating cash
 // flow sits only in the successor column, that column is the registrant's statements; it replaces a
 // note's figure for the same line, and a line only the notes carry stays.
 const period=c=>c.start.trim()+'/'+c.end.trim();
 const successor=c=>c?.dimensions.length===1 && c.start && /(?:^|:)SuccessorMember$/.test(c.dimensions[0].member.trim());
 const successorYears=new Set(),successorLines=new Set();
 if([...contexts.values()].some(c=>c.dimensions.some(d=>/(?:^|:)PredecessorMember$/.test(d.member.trim())))) {
  const lead=new Set();for(const [st,field] of [['income','totalRevenue'],['cash','operatingCashflow']])for(const tax of ['us-gaap','ifrs-full'])for(const tag of MAPS[st][field][tax])lead.add(tax+':'+tag);
  const plainLead=new Set(facts.filter(f=>lead.has(f.name) && contexts.get(f.contextref)?.dimensions.length===0 && contexts.get(f.contextref).start).map(f=>period(contexts.get(f.contextref))));
  for(const f of facts){const c=contexts.get(f.contextref);if(lead.has(f.name) && successor(c) && !plainLead.has(period(c)))successorYears.add(period(c));}
  for(const f of facts){const c=contexts.get(f.contextref);if(successor(c) && successorYears.has(period(c)))successorLines.add(f.name+'|'+period(c));}
 }
 const doc={cik:Number(cik),facts:{},originalDocument:{url:filing.documentUrl,documentUrl:filing.documentUrl,accession:filing.accessionNumber,accessionNumber:filing.accessionNumber,form:filing.form,filingDate:filing.filingDate},segments:[]};
 for(const raw of facts) {
  const c=contexts.get(raw.contextref),u=units.get(raw.unitref),name=raw.name;
  if(!c || p.cik(c.issuer?.trim())!==p.cik(cik) || !u || !name || !p.day(c.end?.trim()))continue;
  if(/:fixed-zero$/.test(raw.format || ''))raw.text='0';
  if(raw['xsi:nil']==='true' || !/^[+-]?(?:\d[\d, .]*|\.\d+)$/.test(raw.text.trim()))continue;
  // Unknown transformation formats cannot establish a numerical value.
  if(raw.format && !/:(?:num(?:dotdecimal|-dot-decimal|-comma-decimal)|fixed-zero)$/i.test(raw.format))continue;
  const receipt={rawText:raw.text,format:raw.format,scale:raw.scale || 0,sign:raw.sign};
  const val=require('./sec-inline-number').number(receipt);if(val===null)continue;
  const [taxonomy,concept]=name.split(':'),measure=u.divide?u.measures.join('/'):u.measures[0];
  const f={val,start:c.start?.trim() || undefined,end:c.end.trim(),accn:filing.accessionNumber,form:filing.form,filed:filing.filingDate,
   _original:{documentUrl:filing.documentUrl,contextRef:raw.contextref,decimals:raw.decimals || null,dimensions:c.dimensions,numericReceipt:receipt}};
  if(!c.dimensions.length && c.start && successorLines.has(name+'|'+period(c)))continue;
  if(c.dimensions.length && !(ownMember && legal(c)===ownMember) && !(successor(c) && successorYears.has(period(c)))) {
   // A single disclosed segment axis is retained separately, never entity revenue.
   const segmentDims=c.dimensions.filter(d=>!(d.axis==='srt:ConsolidationItemsAxis' && d.member==='us-gaap:OperatingSegmentsMember'));
   // Operating segments, product and service lines, and regions; revenue, or the
   // measure a bank or insurer breaks out by segment in its place.
   if((wanted.has(name) && /Revenue/.test(concept) || require('./sec-segment-observations').segmentMeasure(taxonomy,concept)) && segmentDims.length===1 && /(?:StatementBusinessSegments|Segments|ProductOrService|ProductsAndServices|StatementGeographical|GeographicalAreas|GeographicDistribution)Axis$/.test(segmentDims[0].axis || ''))doc.segments.push({concept,taxonomy,unit:measure,...f,_original:{...f._original,dimensions:segmentDims,allDimensions:c.dimensions}});
   continue;
  }
  // The lines a filer breaks operating expenses into on its income statement
  // (research, marketing, fulfillment, administration). Standard or the
  // filer's own concept; kept apart from the mapped statement fields.
  if(OPEX_LINE.test(concept) && f.start && /^[A-Z]{3}$/.test(measure || ''))(doc.operatingExpenseLines ||= []).push({concept,taxonomy,unit:measure,...f});
  if(!wanted.has(name))continue;
  ((doc.facts[taxonomy] ||= {})[concept] ||= {units:{}}).units[measure] ||= [];
  doc.facts[taxonomy][concept].units[measure].push(f);
 }
 // Cadrenal tags its FY2025 net loss on the statement (-13,237,362) and again as "$13.2 million"
 // (decimals -5) in the discussion. A copy that rounds the precise figure to its own decimals is the
 // same fact, as SEC's facts feed treats it; left in, the year's figure read as two conflicting ones.
 const precision=f=>f._original.decimals===null || /^inf$/i.test(f._original.decimals)?Infinity:Number(f._original.decimals);
 for(const defs of Object.values(doc.facts))for(const def of Object.values(defs))for(const [measure,rows] of Object.entries(def.units)) {
  const exact=new Map();for(const f of rows){const k=f.start+'|'+f.end,best=exact.get(k);if(!best || precision(f)>precision(best))exact.set(k,f);}
  def.units[measure]=rows.filter(f=>{const best=exact.get(f.start+'|'+f.end),d=precision(f);
   if(f===best || !Number.isFinite(d) || !(precision(best)>d) || f.val===best.val)return true;
   const step=10**-d;return Math.abs(Math.round(best.val/step)*step-f.val)>step*1e-6;});
 }
 const plain=narrative.replace(/\s+/g,' ');
 const currencies=[['New Taiwan dollars','TWD'],['Renminbi','CNY'],['Japanese yen','JPY'],['Canadian dollars','CAD'],['euros','EUR'],['U.S. dollars','USD']];
 const declared=currencies.filter(([label])=>new RegExp('(?:publish our financial statements in|financial statements (?:are )?(?:presented|expressed) in) '+label.replace(/\./g,'\\.'),'i').test(plain));
 if(declared.length===1)doc.reportingCurrency=declared[0][1];
 if(require('./sec-industry-tables').REGISTRY[p.cik(cik)])doc.industryTables=require('./sec-industry-tables').tablesFrom(text).filter(t=>/reconciliation/i.test(t.caption) && t.rows.some(r=>r.some(c=>/FFO available to common stockholders/.test(c))));
 return doc;
}
// Income-statement expense lines by name. Costs of revenue, totals, taxes,
// interest and one-off charges are not operating-expense components.
const OPEX_LINE=/^(?:ResearchAndDevelopmentExpense(?:ExcludingAcquiredInProcessCost)?|SellingAndMarketingExpense|MarketingExpense|SalesAndMarketingExpense|GeneralAndAdministrativeExpense|SellingGeneralAndAdministrativeExpense|SellingExpense|FulfillmentExpense|TechnologyAndInfrastructureExpense|TechnologyAndContentExpense|TechnologyAndDevelopmentExpense|ProductDevelopmentExpense)$/;
// The label a company prints for each member, from the filing's own label
// file. An element name is the filer's internal shorthand ("DdsMember",
// "Clearingandtransactionfees"); the label is what the filing shows a reader.
function parseLabels(xml) {
 const attr=(tag,name)=>tag.match(new RegExp('\\b'+name+'\\s*=\\s*"([^"]*)"'))?.[1];
 const element=new Map(),target=new Map(),text=new Map();
 for(const m of xml.matchAll(/<(?:link:)?loc\b[^>]*>/g)){const href=attr(m[0],'xlink:href'),label=attr(m[0],'xlink:label'),id=href?.split('#')[1];if(id && label && id.includes('_'))element.set(label,id.replace('_',':'));}
 for(const m of xml.matchAll(/<(?:link:)?labelArc\b[^>]*>/g)){const from=attr(m[0],'xlink:from'),to=attr(m[0],'xlink:to');if(element.has(from) && to)target.set(to,element.get(from));}
 const RANK={'http://www.xbrl.org/2003/role/terseLabel':0,'http://www.xbrl.org/2003/role/label':1,'http://www.xbrl.org/2003/role/verboseLabel':2};
 for(const m of xml.matchAll(/<(?:link:)?label\b([^>]*)>([^<]{1,300})<\/(?:link:)?label>/g)) {
  const name=target.get(attr(m[1],'xlink:label')),rank=RANK[attr(m[1],'xlink:role')],lang=attr(m[1],'xml:lang') || 'en';
  if(!name || rank===undefined || !/^en/i.test(lang))continue;
  const value=m[2].replace(/&amp;/g,'&').replace(/&apos;|&#39;|&#8217;/g,'’').replace(/&quot;/g,'"').replace(/&#\d+;|&[a-z]+;/gi,' ').replace(/\s*\[(?:Member|Domain|Axis)\]\s*$/i,'').replace(/\s+/g,' ').trim();
  if(value && (!text.has(name) || rank<text.get(name).rank))text.set(name,{rank,value});
 }
 return new Map([...text].map(([name,v])=>[name,v.value]));
}
// Best effort: a filing without a readable label file keeps its segments unlabelled.
async function attachLabels(doc,base,listing) {
 if(!doc.segments?.length && !doc.operatingExpenseLines?.length)return doc;
 try {
  listing ||= (await axios.get(base+'index.json',{headers:HEADERS,timeout:20000,maxContentLength:2*1024*1024,responseType:'json'})).data;
  // Some filers embed the label linkbase in the schema instead of a separate file.
  const items=(listing?.directory?.item || []).filter(i=>Number(i.size)<=12*1024*1024);
  const file=items.find(i=>/^[a-zA-Z0-9_.-]+_lab\.xml$/.test(i.name || '')) || items.find(i=>/^[a-zA-Z0-9_.-]+\.xsd$/.test(i.name || ''));
  if(!file)return doc;
  const labels=parseLabels(String((await axios.get(base+file.name,{headers:HEADERS,timeout:20000,maxContentLength:12*1024*1024,responseType:'text',transformResponse:x=>x})).data));
  for(const f of doc.segments){const value=labels.get(f._original.dimensions[0].member);if(value)f._original.memberLabel=value.slice(0,120);}
  for(const f of doc.operatingExpenseLines || []){const value=labels.get(f.taxonomy+':'+f.concept);if(value)f._original.conceptLabel=value.slice(0,120);}
 } catch(error) { if(transient(error))throw error; /* labels are an improvement, never a requirement */ }
 return doc;
}
// A network failure is not an absent document: swallowed, it read the primary alone and the run recorded the filing
// as done, so its exhibit's expense lines and its labelled segments never came back (J.W. Mays and Hawthorn
// Bancshares on 2026-10-18, during a DNS outage). It is thrown, and the caller records a retrieval failure to retry.
const transient=error=>['ECONNRESET','ECONNABORTED','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ENETUNREACH','EPIPE'].includes(error?.code) || error?.response?.status===429 || error?.response?.status>=500;
async function fetchOriginal(cik,filing) {
 if(!filing?.primaryDocument || !/^[a-zA-Z0-9_.-]+$/.test(filing.primaryDocument))throw new Error('ORIGINAL_DOCUMENT_PATH_UNAVAILABLE');
 const documentUrl=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accessionNumber.replace(/-/g,'')}/${filing.primaryDocument}`;
 const response=await axios.get(documentUrl,{headers:HEADERS,timeout:20000,maxContentLength:MAX_BYTES,responseType:'text'});
 const shared={contexts:new Map(),units:new Map()};
 const primary=parseOriginal(String(response.data),{...filing,documentUrl},cik,shared);
 // A cover page can still tag its share count (Gildan's 40-F), so the primary
 // counts as the statements only when it holds an amount in a currency.
 const money=Object.values(primary.facts).some(defs=>Object.values(defs).some(def=>Object.keys(def.units).some(u=>/^[A-Z]{3}$/.test(u))));
 if(money)return attachLabels(primary,documentUrl.replace(/[^/]*$/,''));
 // Some filers put only a cover page in the primary document and the financial
 // statements in a second tagged document of the same filing (Clorox's annual
 // report exhibit, Canadian National's 40-F exhibits). SEC's company-facts feed
 // carries nothing for those filings, so 115 issuers had no current year at
 // all on 2026-10-06. Read the filing's other documents and keep the one that
 // holds the statements; every figure still cites the document it came from.
 const base=documentUrl.replace(/[^/]*$/,'');
 let listing;try{listing=(await axios.get(base+'index.json',{headers:HEADERS,timeout:20000,maxContentLength:2*1024*1024,responseType:'json'})).data;}catch(error){if(transient(error))throw error;return primary;}
 const items=(listing?.directory?.item || []).filter(i=>/^[a-zA-Z0-9_.-]+\.html?$/.test(i.name || '') && i.name!==filing.primaryDocument && Number(i.size)>50000 && Number(i.size)<=MAX_BYTES)
  .sort((a,b)=>Number(b.size)-Number(a.size)).slice(0,4);
 let best=primary,count=0;
 for(const item of items) {
  try {
   const url=base+item.name,text=String((await axios.get(url,{headers:HEADERS,timeout:20000,maxContentLength:MAX_BYTES,responseType:'text'})).data);
   if(!/<ix:nonfraction/i.test(text))continue;
   const doc=parseOriginal(text,{...filing,documentUrl:url},cik,shared),n=Object.values(doc.facts).reduce((sum,defs)=>sum+Object.keys(defs).length,0);
   if(n>count){best=doc;count=n;}
  } catch(error) { if(transient(error))throw error; /* an unreadable exhibit leaves the others to be tried */ }
 }
 return attachLabels(best,base,listing);
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
module.exports={parseOriginal,fetchOriginal,mergeFacts,parseLabels,MAX_BYTES};
