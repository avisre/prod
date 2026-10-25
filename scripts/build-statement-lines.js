#!/usr/bin/env node
'use strict';
// Builds frontend/data/sec-statement-lines/<cik>.json from SEC's Financial Statement
// Data Sets (https://www.sec.gov/dera/data/financial-statement-data-sets): the
// statement lines the company-facts feed leaves out (company-defined tags, and
// EPS filed per class of stock). See backend/statement-lines.js for the rules.
//
//   node scripts/build-statement-lines.js [--dir ~/.cache/stockportfolio/fsds] [--jobs N]
//
// --dir holds the quarterly zips (2026q3.zip, ...) as SEC publishes them. One child
// process reads each zip, streamed, so N quarters run on N cores. Only issuers we
// cover (a file in frontend/data/sec-financials) are kept.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),readline=require('node:readline'),{spawn}=require('node:child_process');
const backend=path.join(__dirname,'../backend'),req=m=>require(path.join(backend,'node_modules',m));
const lines=require('../backend/statement-lines'),p=require('../backend/sec-coverage'),{MAPS}=require('../backend/sec-facts');
const FORM=/^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/;
// A balance-sheet face tag and the one field it maps to (MAPS.balance us-gaap list); a tag on two
// fields (LiabilitiesAndStockholdersEquity) and custom tags are not read as columns.
const BALANCE_TAG=new Map();for(const [field,def] of Object.entries(MAPS.balance))for(const c of def['us-gaap'] || []){if(!BALANCE_TAG.has(c))BALANCE_TAG.set(c,new Set());BALANCE_TAG.get(c).add(field);}
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const day=s=>/^\d{8}$/.test(s || '')?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:null;

function openZip(file){const yauzl=req('yauzl');return new Promise((res,rej)=>yauzl.open(file,{lazyEntries:true,autoClose:false},(e,zf)=>{if(e)return rej(e);const entries=new Map();zf.on('entry',en=>{entries.set(en.fileName,en);zf.readEntry();});zf.on('end',()=>res({zf,entries}));zf.on('error',rej);zf.readEntry();}));}
// Each table is tab-separated with a header row (FSDS readme, section 2).
async function table(zip,name,fn){
 const entry=zip.entries.get(name);if(!entry)throw new Error(`${name} missing`);
 const stream=await new Promise((res,rej)=>zip.zf.openReadStream(entry,(e,rs)=>e?rej(e):res(rs)));
 const rl=readline.createInterface({input:stream,crlfDelay:Infinity});let head=null;
 for await(const text of rl){const c=text.split('\t');if(!head){head=Object.fromEntries(c.map((h,i)=>[h,i]));continue;}fn(c,head);}
}

async function child(file,out,covered){
 const zip=await openZip(file),subs=new Map();
 await table(zip,'sub.txt',(c,h)=>{const cik=p.cik(c[h.cik]);if(covered.has(cik) && FORM.test(c[h.form]))subs.set(c[h.adsh],{cik,form:c[h.form],filed:day(c[h.filed]),period:day(c[h.period])});});
 // Statement lines first, the noncontrolling-interest flag of each statement with them:
 // the flag can come after the line it qualifies, so fields are settled once it is known.
 const raw=new Map(),nci=new Set(),mapped=lines.mappedTags(),debt=new Map(),capex=new Map(),face=new Map(),columns=new Map();
 await table(zip,'pre.txt',(c,h)=>{
  const adsh=c[h.adsh],stmt=c[h.stmt];if(!subs.has(adsh) || !lines.STATEMENT[stmt] || c[h.inpth]!=='0')return;
  const tag=c[h.tag],version=c[h.version],plabel=c[h.plabel];
  if(stmt==='BS' && (tag==='Assets' || BALANCE_TAG.get(tag)?.size===1))face.set(adsh+'|'+tag+'|'+version,plabel);
  if(stmt==='BS' && lines.debtLine(tag,plabel)){if(!debt.has(adsh))debt.set(adsh,new Map());debt.get(adsh).set(tag+'|'+version,tag);}
  if(stmt==='CF' && lines.capexLine(tag,plabel)){const k=adsh+'|'+tag+'|'+version;if(!capex.has(k))capex.set(k,{tag,custom:version===adsh,version,plabel});}
  if(/noncontrolling|minority/i.test(tag+' '+plabel))nci.add(adsh+'|'+stmt);
  if(!lines.fieldsFor(stmt,plabel,tag,{custom:version===adsh,mapped,memberTotal:true}).length)return;
  const key=adsh+'|'+tag+'|'+version;if(!raw.has(key))raw.set(key,[]);raw.get(key).push({stmt,plabel});
 });
 const crdr=new Map();for(const key of raw.keys()){const [,tag,version]=key.split('|');crdr.set(tag+'|'+version,undefined);}
 for(const tags of debt.values())for(const k of tags.keys())crdr.set(k,undefined);
 await table(zip,'tag.txt',(c,h)=>{const k=c[h.tag]+'|'+c[h.version];if(crdr.has(k))crdr.set(k,c[h.crdr] || '');});
 const wanted=new Map();
 for(const [key,uses] of raw){
  const [adsh,tag,version]=key.split('|'),custom=version===adsh,found=new Map();
  for(const {stmt,plabel} of uses)for(const field of lines.fieldsFor(stmt,plabel,tag,{custom,mapped,noncontrolling:nci.has(adsh+'|'+stmt),crdr:crdr.get(tag+'|'+version),memberTotal:true})){const k=stmt+'|'+field;if(!found.has(k))found.set(k,{stmt,field,plabel});}
  // One line, one field: a tag shown under two different fields of one statement is not read.
  const per=new Map();for(const x of found.values())per.set(x.stmt,(per.get(x.stmt) || 0)+1);
  const kept=[...found.values()].filter(x=>per.get(x.stmt)===1 || (x.field==='eps' || x.field==='dilutedEPS') && per.get(x.stmt)===2 && [...found.values()].filter(y=>y.stmt===x.stmt).every(y=>/^(eps|dilutedEPS)$/.test(y.field)));
  if(kept.length)wanted.set(key,{custom,tag,kept});
 }
 const w=fs.createWriteStream(out);let n=0;
 // The debt lines each balance sheet presents, credit lines only (a debit "debt securities" line is an asset).
 for(const [adsh,tags] of debt){
  const sub=subs.get(adsh),kept=[...tags].filter(([k])=>crdr.get(k)!=='D').map(([,tag])=>tag);
  if(sub.period && kept.length){w.write(JSON.stringify([sub.cik,{s:'balance',k:'debt',f:'',e:sub.period,c:[...new Set(kept)].sort(),a:adsh,m:sub.form,d:sub.filed}])+'\n');n++;}
 }
 // The capital-spending lines each cash-flow statement presents, with their figures per period
 // (statement-lines capexLine): one record per filing, period and currency, summed in sec-facts.
 const spent=new Map(),revenue=new Map(),plainRevenue=new Set(),revenueTags=new Set(Object.values(require('../backend/sec-facts').MAPS.income.totalRevenue).filter(Array.isArray).flat());
 await table(zip,'num.txt',(c,h)=>{
  const adsh=c[h.adsh],key=adsh+'|'+c[h.tag]+'|'+c[h.version],want=wanted.get(key),line=capex.get(key),column=face.has(key);
  if(!c[h.segments] && !c[h.coreg] && revenueTags.has(c[h.tag]) && c[h.value]!=='')plainRevenue.add([adsh,day(c[h.ddate]),c[h.qtrs],c[h.uom]].join('|'));
  if(!want && !line && !column || c[h.coreg])return;
  const value=Number(c[h.value]),end=day(c[h.ddate]),qtrs=c[h.qtrs],uom=c[h.uom],segments=c[h.segments] || '',sub=subs.get(adsh);
  if(!Number.isFinite(value) || c[h.value]==='' || !end || end>sub.filed || !/^[A-Z]{3}(\/shares)?$/.test(uom))return;
  // A balance sheet presented in segment columns (statement-lines columnSum): plain value and
  // single-dimension member values per filing, date and currency; a member seen twice with two
  // figures is NaN and skips the line.
  if(column && qtrs==='0' && /^[A-Z]{3}$/.test(uom)){
   const k=adsh+'|'+end+'|'+uom;if(!columns.has(k))columns.set(k,new Map());
   const by=columns.get(k);if(!by.has(key))by.set(key,{plain:null,axes:new Map()});const e=by.get(key);
   if(!segments)e.plain=e.plain!==null && e.plain!==value?NaN:value;
   else{const mm=/^([^=;]+)=([^=;]+);?$/.exec(segments);if(mm){if(!e.axes.has(mm[1]))e.axes.set(mm[1],new Map());const m=e.axes.get(mm[1]);m.set(mm[2],m.has(mm[2]) && m.get(mm[2])!==value?NaN:value);}}
  }
  if(line && !segments && (qtrs==='1' || qtrs==='4') && /^[A-Z]{3}$/.test(uom)){
   const k=adsh+'|'+end+'|'+qtrs+'|'+uom;if(!spent.has(k))spent.set(k,new Map());
   const by=spent.get(k),id=line.tag+'|'+line.version;if(!by.has(id))by.set(id,{line,values:new Set()});by.get(id).values.add(value);
  }
  if(!want)return;
  for(const {stmt,field,plabel} of want.kept){
   if(stmt==='BS'?qtrs!=='0':qtrs!=='1' && qtrs!=='4')continue;
   if(field==='totalRevenue'){
    const k=[adsh,stmt,want.tag,c[h.version],end,qtrs,uom].join('|'),r=revenue.get(k) || {plain:false,members:new Map(),rec:null};revenue.set(k,r);
    if(!segments){r.plain=true;plainRevenue.add([adsh,end,qtrs,uom].join('|'));}
    else if(/^ProductOrService=[^;=]+;?$/.test(segments) && /^total\b/i.test(plabel)){const m=segments.replace(/^ProductOrService=|;$/g,'');if(!r.members.has(m))r.members.set(m,new Set());r.members.get(m).add(value);r.rec={s:lines.STATEMENT[stmt],f:field,t:want.custom?'custom':String(c[h.version]).split('/')[0],c:want.tag,l:plabel,u:uom,e:end,q:Number(qtrs),a:adsh,m:sub.form,d:sub.filed};}
   }
   if(!lines.acceptedDimension(segments,field))continue;
   // A standard EPS tag is in the company-facts feed already, unless it is filed per class.
   if(!want.custom && mapped.has(want.tag) && !segments)continue;
   const rec={s:lines.STATEMENT[stmt],f:field,t:want.custom?'custom':String(c[h.version]).split('/')[0],c:want.tag,l:plabel,u:uom,v:value,e:end,q:Number(qtrs),a:adsh,m:sub.form,d:sub.filed};
   if(segments)rec.g=segments.replace(/;$/,'');
   w.write(JSON.stringify([sub.cik,rec])+'\n');n++;
  }
 });
 for(const [k,by] of spent){
  const [adsh,end,qtrs,uom]=k.split('|'),sub=subs.get(adsh),parts=[...by.values()].sort((x,y)=>x.line.tag.localeCompare(y.line.tag));
  // A line with two figures for one period is not read, and neither is that period's capital spending.
  if(parts.some(x=>x.values.size!==1))continue;
  w.write(JSON.stringify([sub.cik,{s:'cash',k:'capex',f:'',e:end,q:Number(qtrs),u:uom,c:parts.map(x=>x.line.tag),t:parts.map(x=>x.line.custom?'custom':String(x.line.version).split('/')[0]),l:parts.map(x=>x.line.plabel),v:parts.map(x=>[...x.values][0]),a:adsh,m:sub.form,d:sub.filed}])+'\n');n++;
 }
 // A balance sheet presented in segment columns (statement-lines columnSum): Berkshire's 10-Q for
 // 2026-06-30 files cash and property, plant and equipment only per InsuranceAndOther and
 // RailroadUtilitiesAndEnergy column, and the company-facts feed drops every dimensional fact.
 for(const [k,by] of columns){
  const [adsh,end,uom]=k.split('|'),sub=subs.get(adsh),anchors=[...by.keys()].filter(id=>id.split('|')[1]==='Assets');
  if(anchors.length!==1)continue;
  const anchor=by.get(anchors[0]);
  for(const [id,e] of by){
   const tag=id.split('|')[1];if(tag==='Assets')continue;
   const fields=[...BALANCE_TAG.get(tag) || []];if(fields.length!==1)continue;
   const sum=lines.columnSum(anchor,e);
   if(!sum)continue;
   const version=id.split('|')[2];
   w.write(JSON.stringify([sub.cik,{s:'balance',k:'columns',f:fields[0],e:end,q:0,u:uom,t:version===adsh?'custom':String(version).split('/')[0],c:tag,l:face.get(id),x:sum.axis,g:sum.members,v:sum.values,ta:sum.assets,a:adsh,m:sub.form,d:sub.filed}])+'\n');n++;
  }
 }
 // A total revenue line filed only under one product member, never on its own: APA's 2025 "Total revenues" of
 // $8,920m is ProductOrService=OilAndGas, its own production plus purchased oil and gas ($7,229m + $1,691m), and
 // Meritage's "Total closing revenue" is RealEstate, homes plus land. Only where the statement shows no revenue
 // figure on no dimension for the period under any revenue tag (Plug Power's equipment member sums its parts too,
 // beside a $709.9m total), the line is labelled a total (Hilltop's "Revenue" is a fee line), and it is the largest member and the only one that is the exact sum of two or more of the others.
 for(const r of revenue.values()){
  // Only for the filing's own period: Newsmax's Q1 2026 10-Q files its Q1 2025 members again under a year ended 2025-12-31.
  if(r.plain || !r.rec || r.rec.e!==subs.get(r.rec.a).period || plainRevenue.has([r.rec.a,r.rec.e,String(r.rec.q),r.rec.u].join('|')) || [...r.members.values()].some(v=>v.size!==1))continue;
  const total=lines.memberTotal([...r.members].map(([k,v])=>[k,[...v][0]]));
  if(!total)continue;
  w.write(JSON.stringify([subs.get(r.rec.a).cik,{...r.rec,v:total[1],g:'ProductOrService='+total[0]}])+'\n');n++;
 }
 await new Promise(r=>w.end(r));zip.zf.close();
 return n;
}

async function main(){
 const covered=new Set(fs.readdirSync(path.join(p.DATA_DIR,'sec-financials')).map(f=>f.replace(/\.json$/,'')).filter(f=>/^\d{10}$/.test(f)));
 if(process.argv[2]==='--child'){const n=await child(process.argv[3],process.argv[4],covered);console.log(path.basename(process.argv[3]),n,'lines');return;}
 const dir=arg('--dir',path.join(os.homedir(),'.cache/stockportfolio/fsds')),jobs=Number(arg('--jobs',os.cpus().length));
 const zips=fs.readdirSync(dir).filter(f=>/^\d{4}q[1-4]\.zip$/.test(f)).sort();
 if(!zips.length)throw new Error(`no quarterly zips in ${dir}`);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'statement-lines-'));
 const queue=[...zips];let failed=0;
 await Promise.all(Array.from({length:Math.min(jobs,zips.length)},async()=>{for(let z;(z=queue.shift());){
  const code=await new Promise(res=>{const c=spawn(process.execPath,[__filename,'--child',path.join(dir,z),path.join(tmp,z+'.ndjson')],{stdio:['ignore','inherit','inherit']});c.on('exit',res);});
  if(code!==0){failed++;console.error(z,'failed with',code);}
 }}));
 if(failed)throw new Error(`${failed} quarter(s) failed; nothing written`);
 const by=new Map();
 for(const z of zips){const rl=readline.createInterface({input:fs.createReadStream(path.join(tmp,z+'.ndjson')),crlfDelay:Infinity});for await(const text of rl){if(!text)continue;const [cik,rec]=JSON.parse(text);if(!by.has(cik))by.set(cik,new Map());by.get(cik).set(JSON.stringify(rec),rec);}}
 const outDir=lines.DIR();fs.mkdirSync(outDir,{recursive:true});
 const builtFrom=zips.map(z=>z.replace(/\.zip$/,''));let total=0;
 for(const [cik,recs] of by){
  const list=[...recs.values()].sort((x,y)=>y.e.localeCompare(x.e)||x.s.localeCompare(y.s)||x.f.localeCompare(y.f)||y.d.localeCompare(x.d)||x.a.localeCompare(y.a)||String(x.g || '').localeCompare(String(y.g || ''))||String(x.k || '').localeCompare(String(y.k || ''))||(x.q ?? -1)-(y.q ?? -1)||String(x.u || '').localeCompare(String(y.u || ''))||String(x.x || '').localeCompare(String(y.x || ''))||String(x.v ?? '').localeCompare(String(y.v ?? ''))||String(x.ta ?? '').localeCompare(String(y.ta ?? '')));
  total+=list.length;
  p.atomicWrite(path.join(outDir,cik+'.json'),{schemaVersion:1,cik,builtFrom,lines:list});
 }
 for(const f of fs.readdirSync(outDir))if(/^\d{10}\.json$/.test(f) && !by.has(f.slice(0,10)))fs.unlinkSync(path.join(outDir,f));
 fs.rmSync(tmp,{recursive:true,force:true});
 console.log(`${by.size} issuers, ${total} lines from ${zips.length} quarters -> ${path.relative(process.cwd(),outDir)}`);
}
main().catch(e=>{console.error(e.stack || e.message);process.exit(1);});
