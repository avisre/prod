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
const lines=require('../backend/statement-lines'),p=require('../backend/sec-coverage');
const FORM=/^(10-K|10-Q|20-F|40-F|6-K)(\/A)?$/;
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
 const raw=new Map(),nci=new Set(),mapped=lines.mappedTags(),debt=new Map();
 await table(zip,'pre.txt',(c,h)=>{
  const adsh=c[h.adsh],stmt=c[h.stmt];if(!subs.has(adsh) || !lines.STATEMENT[stmt] || c[h.inpth]!=='0')return;
  const tag=c[h.tag],version=c[h.version],plabel=c[h.plabel];
  if(stmt==='BS' && lines.debtLine(tag,plabel)){if(!debt.has(adsh))debt.set(adsh,new Map());debt.get(adsh).set(tag+'|'+version,tag);}
  if(/noncontrolling|minority/i.test(tag+' '+plabel))nci.add(adsh+'|'+stmt);
  if(!lines.fieldsFor(stmt,plabel,tag,{custom:version===adsh,mapped}).length)return;
  const key=adsh+'|'+tag+'|'+version;if(!raw.has(key))raw.set(key,[]);raw.get(key).push({stmt,plabel});
 });
 const crdr=new Map();for(const key of raw.keys()){const [,tag,version]=key.split('|');crdr.set(tag+'|'+version,undefined);}
 for(const tags of debt.values())for(const k of tags.keys())crdr.set(k,undefined);
 await table(zip,'tag.txt',(c,h)=>{const k=c[h.tag]+'|'+c[h.version];if(crdr.has(k))crdr.set(k,c[h.crdr] || '');});
 const wanted=new Map();
 for(const [key,uses] of raw){
  const [adsh,tag,version]=key.split('|'),custom=version===adsh,found=new Map();
  for(const {stmt,plabel} of uses)for(const field of lines.fieldsFor(stmt,plabel,tag,{custom,mapped,noncontrolling:nci.has(adsh+'|'+stmt),crdr:crdr.get(tag+'|'+version)})){const k=stmt+'|'+field;if(!found.has(k))found.set(k,{stmt,field,plabel});}
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
 await table(zip,'num.txt',(c,h)=>{
  const adsh=c[h.adsh],key=adsh+'|'+c[h.tag]+'|'+c[h.version],want=wanted.get(key);if(!want || c[h.coreg])return;
  const value=Number(c[h.value]),end=day(c[h.ddate]),qtrs=c[h.qtrs],uom=c[h.uom],segments=c[h.segments] || '',sub=subs.get(adsh);
  if(!Number.isFinite(value) || c[h.value]==='' || !end || end>sub.filed || !/^[A-Z]{3}(\/shares)?$/.test(uom))return;
  for(const {stmt,field,plabel} of want.kept){
   if(stmt==='BS'?qtrs!=='0':qtrs!=='1' && qtrs!=='4')continue;
   if(!lines.acceptedDimension(segments,field))continue;
   // A standard EPS tag is in the company-facts feed already, unless it is filed per class.
   if(!want.custom && mapped.has(want.tag) && !segments)continue;
   const rec={s:lines.STATEMENT[stmt],f:field,t:want.custom?'custom':String(c[h.version]).split('/')[0],c:want.tag,l:plabel,u:uom,v:value,e:end,q:Number(qtrs),a:adsh,m:sub.form,d:sub.filed};
   if(segments)rec.g=segments.replace(/;$/,'');
   w.write(JSON.stringify([sub.cik,rec])+'\n');n++;
  }
 });
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
  const list=[...recs.values()].sort((x,y)=>y.e.localeCompare(x.e)||x.s.localeCompare(y.s)||x.f.localeCompare(y.f)||y.d.localeCompare(x.d)||x.a.localeCompare(y.a)||String(x.g || '').localeCompare(String(y.g || '')));
  total+=list.length;
  p.atomicWrite(path.join(outDir,cik+'.json'),{schemaVersion:1,cik,builtFrom,lines:list});
 }
 for(const f of fs.readdirSync(outDir))if(/^\d{10}\.json$/.test(f) && !by.has(f.slice(0,10)))fs.unlinkSync(path.join(outDir,f));
 fs.rmSync(tmp,{recursive:true,force:true});
 console.log(`${by.size} issuers, ${total} lines from ${zips.length} quarters -> ${path.relative(process.cwd(),outDir)}`);
}
main().catch(e=>{console.error(e.stack || e.message);process.exit(1);});
