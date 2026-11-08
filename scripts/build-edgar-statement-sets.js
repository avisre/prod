#!/usr/bin/env node
'use strict';
// Writes a Financial Statement and Notes data set (the tables of SEC's monthly 2026_10_notes.zip: sub, pre, num, dim,
// tag) for the filings SEC's published sets do not reach yet, read from each filing's own XBRL on EDGAR
// (https://www.sec.gov/Archives/edgar/data/<cik>/<accession>/<accession>-xbrl.zip: the inline document, its schema and
// its presentation and label linkbases). SEC publishes a month's set some days after the month ends; until then the
// statement lines of the latest 10-Qs (scripts/build-statement-lines.js) had nothing to read: 1,599 filings of
// November 2026, the third quarter of most issuers, among them 316 balance sheets whose debt total stayed empty.
//
//   node scripts/build-edgar-statement-sets.js [--since 2026-11-01] [--out ~/.cache/stockportfolio/fsds/2026_11_edgar.zip]
//      [--accessions a,b,...] [--cache ~/.cache/stockportfolio/edgar-xbrl]
//
// --since defaults to the day after the latest month a *_notes.zip in the fsds directory covers. The filings are the
// accessions our sec-financials files cite with a filing date from then on. Each download is cached; at most ~6
// requests a second (SEC's fair-access limit is 10). Delete the _edgar.zip once SEC's own set for the month is in
// the directory: the builder reads both, and the published set is the reference.
//
// The tables follow SEC's conventions, checked against 2026_10_notes.zip: ddate and period are rounded to the
// nearest month end, qtrs is the duration in quarters (0 for an instant), uom is the currency alone for a per-share
// figure, segments lists Axis=Member; pairs sorted with prefixes and the Axis/Member suffixes removed, a legal-entity
// member is also the fact's coreg, version is <taxonomy>/<year> or the accession for a company's own element, and a
// statement is classified by its role title (scripts/lib/edgar-statements.js), the first of each kind in the filing.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const backend=path.join(__dirname,'../backend'),req=m=>require(path.join(backend,'node_modules',m));
const {Parser}=req('htmlparser2'),yauzl=req('yauzl');
const p=require('../backend/sec-coverage'),{number}=require('../backend/sec-inline-number'),{assignStatements}=require('./lib/edgar-statements');
const FORM=/^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/,UA='stockportfolio.pro contact@stockportfolio.pro';
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const FSDS=path.join(os.homedir(),'.cache/stockportfolio/fsds');
const ymd=d=>d.toISOString().slice(0,10).replace(/-/g,'');

// The month end nearest a date (SEC: "rounded to nearest month-end"): 2026-09-27 and 2026-10-03 are both 20260930.
function monthEnd(s) {
 const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());if(!m)return '';
 const d=Date.UTC(+m[1],+m[2]-1,+m[3]),end=Date.UTC(+m[1],+m[2],0),prev=Date.UTC(+m[1],+m[2]-1,0);
 return ymd(new Date(end-d<=d-prev?end:prev));
}
const strip=s=>String(s || '').trim().split(':').pop();
// SEC's tables also drop a leading Statement from an axis (StatementClassOfStockAxis is ClassOfStock), not from a
// StatementOf... axis (StatementOfIncomeLocationBalance stays).
const segName=(axis,member)=>strip(axis).replace(/Axis$/,'').replace(/^Statement(?!Of[A-Z])(?=[A-Z])/,'')+'='+strip(member).replace(/Member$/,'');

function unzipEntries(file) {
 return new Promise((res,rej)=>yauzl.open(file,{lazyEntries:true},(e,zf)=>{
  if(e)return rej(e);const out=new Map();
  zf.on('entry',en=>{if(/\/$/.test(en.fileName) || en.uncompressedSize>200*1024*1024){zf.readEntry();return;}zf.openReadStream(en,(err,rs)=>{if(err)return rej(err);const parts=[];rs.on('data',d=>parts.push(d));rs.on('end',()=>{out.set(en.fileName,Buffer.concat(parts).toString('utf8'));zf.readEntry();});rs.on('error',rej);});});
  zf.on('end',()=>res(out));zf.on('error',rej);zf.readEntry();
 }));
}

// Schema and linkbases: role titles, elements (custom ones' balance), presentation trees and labels, from every
// .xsd and .xml of the filing (a schema may hold its linkbases inline).
function readTaxonomy(files) {
 const roles=new Map(),elements=new Map(),links=[],labels=new Map(),labelLocs=new Map(),labelRes=new Map(),labelArcs=[];
 for(const [name,text] of files) {
  if(!/\.(xsd|xml)$/i.test(name))continue;
  let role=null,roleText=null,inDefinition=false,link=null,lab=null;
  const parser=new Parser({
   onopentag(tag,a) {
    const t=tag.split(':').pop();
    if(t==='roletype'){role=a.roleuri;roleText=null;inDefinition=false;}
    else if(t==='definition' && role!==null){roleText='';inDefinition=true;}
    else if(t==='element' && a.id)elements.set(a.id,{name:a.name,balance:a['xbrli:balance'] || a.balance || ''});
    else if(t==='presentationlink'){link={role:a['xlink:role'],locs:new Map(),arcs:[]};links.push(link);}
    else if(t==='loc' && link)link.locs.set(a['xlink:label'],a['xlink:href']);
    else if(t==='presentationarc' && link)link.arcs.push({from:a['xlink:from'],to:a['xlink:to'],order:Number(a.order || 0),pref:a.preferredlabel || ''});
    else if(t==='labellink')lab={locs:new Map()};
    else if(t==='loc' && lab)labelLocs.set(name+'|'+a['xlink:label'],a['xlink:href']);
    else if(t==='label' && lab && a['xlink:label']){lab.cur={key:name+'|'+a['xlink:label'],role:a['xlink:role'] || 'http://www.xbrl.org/2003/role/label',lang:a['xml:lang'] || '',text:''};}
    else if(t==='labelarc' && lab)labelArcs.push({from:name+'|'+a['xlink:from'],to:name+'|'+a['xlink:to']});
   },
   ontext(v){if(inDefinition)roleText+=v;if(lab?.cur)lab.cur.text+=v;},
   onclosetag(tag) {
    const t=tag.split(':').pop();
    if(t==='definition')inDefinition=false;
    else if(t==='roletype'){roles.set(role,(roleText || '').trim());role=null;roleText=null;}
    else if(t==='presentationlink')link=null;
    else if(t==='label' && lab?.cur){if(!labelRes.has(lab.cur.key))labelRes.set(lab.cur.key,[]);labelRes.get(lab.cur.key).push(lab.cur);lab.cur=null;}
    else if(t==='labellink')lab=null;
   }
  },{xmlMode:true,decodeEntities:true,lowerCaseTags:true,lowerCaseAttributeNames:true});
  parser.end(text);
 }
 // Label text per element href fragment and role, English first.
 for(const {from,to} of labelArcs) {
  const href=labelLocs.get(from),res=labelRes.get(to);if(!href || !res)continue;
  const id=href.split('#').pop();if(!labels.has(id))labels.set(id,new Map());const by=labels.get(id);
  for(const r of res){const prev=by.get(r.role);if(!prev || !/^en/i.test(prev.lang) && /^en/i.test(r.lang))by.set(r.role,{lang:r.lang,text:r.text.replace(/\s+/g,' ').trim()});}
 }
 return {roles,elements,links,labels};
}

// A presented element: its tag, and its version as the data sets write it (us-gaap/2026, ifrs/2025, or the accession).
function elementOf(href,adsh,elements) {
 const [url,id]=String(href || '').split('#');if(!id)return null;
 if(!/^https?:/i.test(url)) {const el=elements.get(id);return el?.name?{tag:el.name,version:adsh,prefix:id.slice(0,id.length-el.name.length-1),custom:true,balance:el.balance}:null;}
 const i=id.indexOf('_');if(i<1)return null;
 const prefix=id.slice(0,i),tag=id.slice(i+1),year=(/(\d{4})(?:-\d{2}-\d{2})?/.exec(url.replace(/^https?:\/\/[^/]+/,'')) || [])[1] || '';
 return {tag,prefix,version:(prefix==='ifrs-full'?'ifrs':prefix)+'/'+year,custom:false};
}

// The inline XBRL facts of every document of the filing (one inline document set shares one header), or the facts of
// a plain instance document.
function readFacts(files) {
 const contexts=new Map(),units=new Map(),facts=[],nonNumeric=[],namespaces=new Map(),textFacts=new Set();
 // The nil attribute under whatever prefix the document binds to XMLSchema-instance (Boot Barn's 10-Q writes xs:nil).
 const nil=a=>Object.entries(a).some(([k,v])=>/(?:^|:)nil$/.test(k) && v==='true')?'true':undefined;
 for(const [name,text] of files) {
  const inline=/\.html?$/i.test(name) && /<ix:(?:header|nonfraction)/i.test(text);
  const instance=/\.xml$/i.test(name) && !/_(?:pre|lab|cal|def)\.xml$/i.test(name) && /<(?:xbrli:)?xbrl[\s>]/i.test(text.slice(0,5000));
  if(!inline && !instance)continue;
  const stack=[],open=[];let context=null,unit=null,dim=null,nn=null,plain=null;
  const parser=new Parser({
   onopentag(tag,a) {
    const t=tag.split(':').pop().toLowerCase();stack.push(t);
    if(stack.length===1)for(const [k,v] of Object.entries(a))if(/^xmlns:/i.test(k))namespaces.set(k.slice(6),v);
    if(t==='context')context={id:a.id,dims:[],start:'',end:''};
    else if(context && (t==='explicitmember' || t==='typedmember')){dim={axis:a.dimension,member:'',typed:t==='typedmember'};context.dims.push(dim);}
    else if(t==='unit')unit={id:a.id,num:[],den:[],part:'num'};
    else if(unit && t==='unitdenominator')unit.part='den';
    else if(inline && t==='nonfraction')open.push({name:a.name,contextref:a.contextref,unitref:a.unitref,decimals:a.decimals,format:a.format,scale:a.scale,sign:a.sign,nil:nil(a),text:''});
    if(inline && t==='nonnumeric' && a.name)textFacts.add(a.name);
    if(inline && t==='nonnumeric' && /^dei:Document(?:PeriodEndDate|Type)$/.test(a.name || ''))nn={name:a.name,contextref:a.contextref,text:''};
    else if(instance && !inline && a.contextref && a.unitref && stack.length===2)plain={name:tag,contextref:a.contextref,unitref:a.unitref,decimals:a.decimals,nil:nil(a),text:''};
    else if(instance && !inline && a.contextref && /^dei:Document(?:PeriodEndDate|Type)$/i.test(tag))nn={name:tag,contextref:a.contextref,text:''};
   },
   ontext(v) {
    const t=stack[stack.length-1];
    if(context){if(t==='startdate')context.start+=v;else if(t==='enddate' || t==='instant')context.end+=v;else if(dim && (t==='explicitmember' || dim.typed))dim.member+=v;}
    if(unit && t==='measure')unit[unit.part].push(v.trim());
    for(const f of open)f.text+=v;
    if(nn)nn.text+=v;if(plain)plain.text+=v;
   },
   onclosetag(tag) {
    const t=tag.split(':').pop().toLowerCase();stack.pop();
    if(t==='context' && context){contexts.set(context.id,context);context=null;}
    else if(t==='explicitmember' || t==='typedmember')dim=null;
    else if(t==='unit' && unit){units.set(unit.id,unit);unit=null;}
    else if(inline && t==='nonfraction' && open.length)facts.push(open.pop());
    else if(nn && (t==='nonnumeric' || tag.toLowerCase()===nn.name.toLowerCase())){nonNumeric.push(nn);nn=null;}
    else if(plain && tag===plain.name){facts.push(plain);plain=null;}
   }
  },{xmlMode:!inline,decodeEntities:true,lowerCaseTags:inline,lowerCaseAttributeNames:true,recognizeSelfClosing:true});
  parser.end(text);
 }
 return {contexts,units,facts,nonNumeric,namespaces,textFacts};
}

function factValue(f) {
 if(f.nil==='true')return '';
 // Harmony Gold's 20-F writes 8 624 (a no-break space between thousands) under num-dot-decimal, which allows it.
 const format=f.format || '';let text=f.text.replace(/[\u00a0\u202f]/g,' ').trim();
 if(/num-?dot-?decimal$/i.test(format) && /^\d{1,3}(?: \d{3})+(?:\.\d+)?$/.test(text))text=text.replace(/ /g,'');
 if(/(?:fixed-zero|zerodash)$/i.test(format) || /numwordsen$/i.test(format) && /^(?:no|none|nil|zero)$/i.test(text))return 0;
 if(!format && f.scale===undefined && !f.sign){const v=Number(text);return text!=='' && Number.isFinite(v)?v:null;}
 return number({rawText:text,format:format.replace(/numdotdecimal$/i,'num-dot-decimal').replace(/numcommadecimal$/i,'num-comma-decimal'),scale:f.scale || 0,sign:f.sign});
}

// SEC's tables keep ASCII only (179 October filings): "Total shareholders’ equity" is "Total shareholders equity", a
// dash, quote, £ or € is dropped, and a non-breaking hyphen is a hyphen ("non‑current" is "non-current"). A no-break
// space, seen in none of them, is read as a space so that two words never run together.
const ascii=s=>s.replace(/[\u2010\u2011]/g,'-').replace(/[\u00a0\u202f]/g,' ').replace(/[^\x00-\x7f]/g,'');

function buildFiling(files,filing,sic) {
 const adsh=filing.accession,{roles,elements,links,labels}=readTaxonomy(files),{contexts,units,facts,nonNumeric,namespaces,textFacts}=readFacts(files);
 const versionOf=new Map(),tags=new Map(),pre=[];
 // Roles in the order SEC's renderer lists them, by the sort code that leads each title.
 const ordered=[...new Set(links.map(l=>l.role))].filter(r=>roles.has(r)).sort((a,b)=>{const x=roles.get(a),y=roles.get(b),nx=/^\s*(\d+)/.exec(x)?.[1],ny=/^\s*(\d+)/.exec(y)?.[1];return nx && ny && nx.length===ny.length?nx.localeCompare(ny):x.localeCompare(y);});
 const kinds=assignStatements(ordered.map(r=>roles.get(r)));
 ordered.forEach((role,i)=>{
  const k=kinds[i];if(!k.stmt)return;
  const locs=new Map(),arcs=[];for(const l of links.filter(x=>x.role===role)){for(const [lab,href] of l.locs)locs.set(lab,href);arcs.push(...l.arcs);}
  const kids=new Map(),hasParent=new Set();for(const a of arcs){if(!kids.has(a.from))kids.set(a.from,[]);kids.get(a.from).push(a);hasParent.add(a.to);}
  for(const v of kids.values())v.sort((x,y)=>x.order-y.order);
  let line=0;const seen=new Set();
  const visit=(label,pref)=>{
   if(seen.has(label))return;seen.add(label);
   const href=locs.get(label),el=elementOf(href,adsh,elements);line++;
   if(el){
    versionOf.set(el.prefix,el.version);
    const id=href.split('#').pop(),by=labels.get(id),text=ascii((pref && by?.get(pref)?.text) || by?.get('http://www.xbrl.org/2003/role/label')?.text || '');
    pre.push([adsh,i+1,line,k.stmt,k.inpth,el.tag,el.version,text]);
    if(el.custom)tags.set(el.tag+'|'+el.version,{tag:el.tag,version:el.version,custom:1,crdr:el.balance==='credit'?'C':el.balance==='debit'?'D':'',tlabel:by?.get('http://www.xbrl.org/2003/role/label')?.text || text});
    else tags.set(el.tag+'|'+el.version,{tag:el.tag,version:el.version,custom:0});
   }
   for(const a of kids.get(label) || [])visit(a.to,a.pref);
   seen.delete(label);
  };
  for(const label of locs.keys())if(!hasParent.has(label))visit(label,'');
 });
 // Facts: one row per element, period, unit, dimensions and figure. A figure tagged again, rounded, in the discussion
 // ($197.5m beside $197,502k) stays a second row, as in SEC's tables.
 const dims=new Map(),best=new Map(),withFacts=new Set();
 for(const f of facts) {
  const c=contexts.get(f.contextref),u=units.get(f.unitref);if(!c || !u || !f.name)continue;
  const value=factValue(f);if(value===null || value!=='' && !Number.isFinite(value))continue;
  const [prefix,tag]=f.name.includes(':')?f.name.split(':'):['',f.name];
  const version=versionOf.get(prefix) || (elements.has(prefix+'_'+tag)?adsh:'') || namespaceVersion(namespaces.get(prefix),prefix,adsh);if(!version)continue;
  const end=monthEnd(c.end);if(!end)continue;
  let qtrs=0;if(c.start.trim()){const days=(Date.parse(c.end.trim())-Date.parse(c.start.trim()))/864e5+1;qtrs=Math.round(days/(365.25/4));}
  const num=u.num.map(strip),den=u.den.map(strip);
  const uom=den.length===1 && den[0].toLowerCase()==='shares' && num.length===1?num[0]:den.length?num.join('*')+'/'+den.join('*'):num.join('*');
  const segs=c.dims.map(d=>segName(d.axis,d.member)).sort(),segments=segs.length?segs.join(';')+';':'';
  const coreg=c.dims.filter(d=>strip(d.axis)==='LegalEntityAxis').map(d=>strip(d.member).replace(/Member$/,'')).join(';');
  if(segments)dims.set(segments,segments);
  const key=[tag,version,c.start.trim(),c.end.trim(),uom,segments].join('|'),prev=best.get(key) || [];best.set(key,prev);
  const row={tag,version,ddate:end,qtrs,uom,dimh:segments,value:value===''?'':Number(value.toFixed(4)),coreg};
  if(!prev.some(r=>r.value===row.value))prev.push(row);
  withFacts.add(tag+'|'+version);
 }
 const num=[...best.values()].flat().map(r=>[adsh,r.tag,r.version,r.ddate,r.qtrs,r.uom,r.dimh,r.value,r.coreg]);
 // SEC's tables are the rendered statements: a presented element with no fact in the filing is not a row (Vicor's
 // 10-Q for 2026-09-30 presents "Long-term deferred revenue" with no figure).
 for(const name of textFacts){const [prefix,tag]=name.split(':');if(versionOf.has(prefix))withFacts.add(tag+'|'+versionOf.get(prefix));}
 const rows=pre.filter(r=>withFacts.has(r[5]+'|'+r[6]));
 // The balance-sheet date: the end of the period the cover page's document period end date is tagged for.
 const dpe=nonNumeric.find(x=>/DocumentPeriodEndDate$/i.test(x.name)),dpeContext=dpe && contexts.get(dpe.contextref);
 const period=monthEnd(dpeContext?.end) || monthEnd(filing.reportDate);
 const sub=[adsh,Number(filing.cik),sic || '',filing.form,period,filing.filed.replace(/-/g,'')];
 return {sub,pre:rows,num,dims,tags:new Map([...tags].filter(([k])=>withFacts.has(k)))};
}

// An element no statement presents: its version from the namespace the document declares for its prefix
// (http://fasb.org/us-gaap/2026 is us-gaap/2026; a company's own namespace is the accession).
function namespaceVersion(uri,prefix,adsh) {
 if(!uri)return '';
 if(!/^https?:\/\/(?:[\w.-]*\.)?(?:fasb\.org|sec\.gov|ifrs\.org|xbrl\.org|w3\.org)\//i.test(uri))return adsh;
 const year=(/\/(\d{4})(?:-\d{2}-\d{2})?(?:\/|$)/.exec(uri) || [])[1];return year?(prefix==='ifrs-full'?'ifrs':prefix)+'/'+year:'';
}
const tsv=v=>String(v ?? '').replace(/[\t\r\n]+/g,' ');

// crdr and standard label of each standard element, from the tag tables of the data sets already downloaded.
async function standardTags() {
 const readline=require('node:readline'),out=new Map();
 const zips=fs.readdirSync(FSDS).filter(f=>/^\d{4}q[1-4]\.zip$|^\d{4}_\d{2}_notes\.zip$/.test(f)).sort().slice(-3);
 for(const z of zips) {
  const name=/_notes\.zip$/.test(z)?'tag.tsv':'tag.txt';
  const zf=await new Promise((res,rej)=>yauzl.open(path.join(FSDS,z),{lazyEntries:true,autoClose:false},(e,f)=>e?rej(e):res(f)));
  const entry=await new Promise((res,rej)=>{zf.on('entry',en=>{if(en.fileName===name)res(en);else zf.readEntry();});zf.on('end',()=>res(null));zf.on('error',rej);zf.readEntry();});
  if(entry){const rs=await new Promise((res,rej)=>zf.openReadStream(entry,(e,s)=>e?rej(e):res(s)));let head=null;
   for await(const text of readline.createInterface({input:rs,crlfDelay:Infinity})){const c=text.split('\t');if(!head){head=Object.fromEntries(c.map((h,i)=>[h,i]));continue;}if(c[head.custom]!=='0')continue;const v={crdr:c[head.crdr] || '',tlabel:c[head.tlabel] || '',datatype:c[head.datatype] || '',iord:c[head.iord] || ''};out.set(c[head.tag]+'|'+c[head.version],v);out.set(c[head.tag]+'|'+c[head.version].split('/')[0],v);}}
  zf.close();
 }
 return out;
}

function filingsSince(since,only) {
 const dir=path.join(p.DATA_DIR,'sec-financials'),out=new Map();
 for(const f of fs.readdirSync(dir)) {
  if(!/^\d{10}\.json$/.test(f))continue;
  const doc=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
  for(const s of Object.values(doc.sources || {})) {
   const a=s.accessionNumber;if(!a || out.has(a) || !FORM.test(s.form || '') || !s.filingDate)continue;
   if(only?!only.has(a):s.filingDate<since)continue;
   out.set(a,{accession:a,cik:p.cik(s.cik || doc.cik),form:s.form,filed:s.filingDate,reportDate:s.periodEnd,sic:doc.reportingSic || ''});
  }
 }
 return [...out.values()].sort((x,y)=>x.filed.localeCompare(y.filed) || x.accession.localeCompare(y.accession));
}

function defaultSince() {
 const months=fs.readdirSync(FSDS).map(f=>/^(\d{4})_(\d{2})_notes\.zip$/.exec(f)).filter(Boolean).map(m=>Date.UTC(+m[1],+m[2],1)).sort((a,b)=>b-a);
 if(!months.length)throw new Error('no _notes.zip in '+FSDS+': pass --since');
 return new Date(months[0]).toISOString().slice(0,10);
}

let last=0;
async function fetchZip(filing,cache) {
 const file=path.join(cache,filing.accession+'-xbrl.zip');
 if(fs.existsSync(file) && fs.statSync(file).size>0)return file;
 const wait=last+170-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));last=Date.now();
 const url=`https://www.sec.gov/Archives/edgar/data/${Number(filing.cik)}/${filing.accession.replace(/-/g,'')}/${filing.accession}-xbrl.zip`;
 for(let attempt=0;attempt<3;attempt++) {
  const r=await fetch(url,{headers:{'User-Agent':UA,'Accept-Encoding':'gzip, deflate'}});
  if(r.status===404)return null;
  if(r.ok){const buf=Buffer.from(await r.arrayBuffer());fs.writeFileSync(file+'.part',buf);fs.renameSync(file+'.part',file);return file;}
  await new Promise(res=>setTimeout(res,2000*(attempt+1)));
 }
 throw new Error(`${url}: download failed`);
}

async function main() {
 const only=arg('--accessions')?new Set(arg('--accessions').split(',')):null,since=only?'':arg('--since',defaultSince());
 const out=arg('--out',path.join(FSDS,(since || 'x').slice(0,7).replace('-','_')+'_edgar.zip'));
 const cache=arg('--cache',path.join(os.homedir(),'.cache/stockportfolio/edgar-xbrl'));fs.mkdirSync(cache,{recursive:true});
 const filings=filingsSince(since,only),std=await standardTags();
 console.log(`${filings.length} filings${since?' filed from '+since:''} -> ${out}`);
 const work=fs.mkdtempSync(path.join(path.dirname(out),'.edgar-set-'));
 const w={sub:fs.createWriteStream(path.join(work,'sub.tsv')),pre:fs.createWriteStream(path.join(work,'pre.tsv')),num:fs.createWriteStream(path.join(work,'num.tsv')),dim:fs.createWriteStream(path.join(work,'dim.tsv')),tag:fs.createWriteStream(path.join(work,'tag.tsv'))};
 w.sub.write('adsh\tcik\tsic\tform\tperiod\tfiled\n');w.pre.write('adsh\treport\tline\tstmt\tinpth\ttag\tversion\tplabel\n');
 w.num.write('adsh\ttag\tversion\tddate\tqtrs\tuom\tdimh\tvalue\tcoreg\n');w.dim.write('dimhash\tsegments\n');w.tag.write('tag\tversion\tcustom\tcrdr\ttlabel\n');
 const allDims=new Set(),allTags=new Set(),stats={read:0,missing:0,noFacts:0,noStatements:0,failed:0};
 for(const [i,filing] of filings.entries()) {
  try {
   const file=await fetchZip(filing,cache);if(!file){stats.missing++;continue;}
   const set=buildFiling(await unzipEntries(file),filing,filing.sic);
   if(!set.num.length)stats.noFacts++;if(!set.pre.some(r=>['BS','IS','CF'].includes(r[3])))stats.noStatements++;
   w.sub.write(set.sub.map(tsv).join('\t')+'\n');
   for(const r of set.pre)w.pre.write(r.map(tsv).join('\t')+'\n');
   for(const r of set.num)w.num.write(r.map(tsv).join('\t')+'\n');
   for(const d of set.dims.keys())if(!allDims.has(d)){allDims.add(d);w.dim.write(tsv(d)+'\t'+tsv(d)+'\n');}
   for(const [k,t] of set.tags){if(allTags.has(k))continue;allTags.add(k);const s=t.custom?t:(std.get(k) || std.get(t.tag+'|'+t.version.split('/')[0]) || {});w.tag.write([t.tag,t.version,t.custom,s.crdr || '',s.tlabel || ''].map(tsv).join('\t')+'\n');}
   stats.read++;
  } catch(e){stats.failed++;console.error(filing.accession,e.message);}
  if((i+1)%100===0)console.log(`${i+1}/${filings.length}`,JSON.stringify(stats));
 }
 await Promise.all(Object.values(w).map(s=>new Promise(r=>s.end(r))));
 const tmp=out+'.part';fs.rmSync(tmp,{force:true});
 execFileSync('zip',['-q','-j',tmp,...['sub','pre','num','dim','tag'].map(t=>path.join(work,t+'.tsv'))]);
 fs.renameSync(tmp,out);fs.rmSync(work,{recursive:true,force:true});
 console.log(JSON.stringify(stats),'->',out);
}
if(require.main===module)main().catch(e=>{console.error(e.stack || e.message);process.exit(1);});
module.exports={monthEnd,buildFiling,readTaxonomy,readFacts};
