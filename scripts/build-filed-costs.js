#!/usr/bin/env node
'use strict';
// Builds frontend/data/filed-costs/<cik>.json: the cost lines between revenue and
// operating income, as filed, for each covered company whose latest annual income
// statement has revenue and no cost of revenue. See backend/filed-costs.js.
//
//   node scripts/build-filed-costs.js [--dir ~/.cache/stockportfolio/fsds] [--jobs N] [--no-headings] [--only CIK]
//
// --dir holds SEC's quarterly Financial Statement Data Sets zips (2026q3.zip, ...),
// the same ones scripts/build-statement-lines.js reads. Each zip is read, streamed,
// by one child process. The structure is the latest annual filing's; each year's
// value is the one in the latest annual filing that reports it, so a restated year
// shows its restated figure. Headings are then read from that filing's own
// presentation and label files on sec.gov; without them the lines still show.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),readline=require('node:readline'),{spawn}=require('node:child_process');
const backend=path.join(__dirname,'../backend'),req=m=>require(path.join(backend,'node_modules',m));
const costs=require('../backend/filed-costs'),p=require('../backend/sec-coverage');
const ANNUAL=/^(10-K|20-F|40-F)(\/A)?$/;
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

// One quarter: each candidate's annual filings, their cost section and its values.
async function child(file,out,wanted){
 const zip=await openZip(file),subs=new Map();
 await table(zip,'sub.txt',(c,h)=>{const cik=p.cik(c[h.cik]);if(wanted.has(cik) && ANNUAL.test(c[h.form]))subs.set(c[h.adsh],{cik,form:c[h.form],filed:day(c[h.filed])});});
 const reports=new Map();
 await table(zip,'pre.txt',(c,h)=>{
  const adsh=c[h.adsh];if(!subs.has(adsh) || c[h.stmt]!=='IS' || c[h.inpth]!=='0')return;
  const key=adsh+'|'+c[h.report];if(!reports.has(key))reports.set(key,[]);
  reports.get(key).push({line:Number(c[h.line]),tag:c[h.tag],version:c[h.version],label:costs.label(c[h.plabel]),negating:c[h.negating]==='1'});
 });
 // A filing can present more than one income statement (a parent-only schedule);
 // the one with the longest cost section is the consolidated statement.
 const sections=new Map();
 for(const [key,lines] of reports){const adsh=key.split('|')[0],s=costs.costSection(lines);if(s && (!sections.has(adsh) || s.length>sections.get(adsh).length))sections.set(adsh,s);}
 const values=new Map(),byKey=new Map(),segmented=new Map();
 for(const [adsh,s] of sections)for(const l of s)byKey.set(adsh+'|'+l.tag+'|'+l.version,l);
 await table(zip,'num.txt',(c,h)=>{
  const adsh=c[h.adsh],l=byKey.get(adsh+'|'+c[h.tag]+'|'+c[h.version]);
  if(!l || c[h.coreg] || c[h.qtrs]!=='4' || !/^[A-Z]{3}$/.test(c[h.uom]) || c[h.value]==='')return;
  const value=Number(c[h.value]),end=day(c[h.ddate]);if(!Number.isFinite(value) || !end)return;
  // Some filers tag a line on the face of the statement with a segment (Barnwell's
  // "Oil and natural gas operating"); a value with one segment only, and no plain
  // value beside it, is the printed figure.
  if(c[h.segments]){const k=adsh+'|'+l.tag+'|'+c[h.uom]+'|'+end,seen=segmented.get(k);segmented.set(k,seen && seen.segments!==c[h.segments]?{ambiguous:true}:{segments:c[h.segments],value:l.negating?-value:value});return;}
  if(!values.has(adsh))values.set(adsh,{});const v=values.get(adsh);
  // The value as printed: pre.txt's negating flag marks a line the filing shows with
  // the opposite sign to its tag ("Corporate expense" tagged CorporateIncomeExpense,
  // a gain or a capitalized cost that reduces the total).
  (v[l.tag] ||= {})[c[h.uom]+'|'+end]=l.negating?-value:value;
 });
 for(const [k,seg] of segmented){
  if(seg.ambiguous)continue;const [adsh,tag,uom,end]=k.split('|');
  if(!values.has(adsh))values.set(adsh,{});const line=(values.get(adsh)[tag] ||= {});
  if(!((uom+'|'+end) in line))line[uom+'|'+end]=seg.value;
 }
 // Some filings print every cost in parentheses (Alexander's); the page shows costs
 // as positive, so such a filing's section is turned over as a whole, keeping each
 // line's sign relative to its total.
 for(const [adsh,s] of sections){
  const v=values.get(adsh);if(!v)continue;
  const ends=Object.keys(Object.assign({},...Object.values(v))).sort(),last=ends.at(-1);
  const total=s.map(l=>costs.isTotal(l.tag,l.label)).lastIndexOf(true);
  const net=total>=0 && v[s[total].tag]?.[last]!=null?v[s[total].tag][last]:s.reduce((sum,l)=>sum+(v[l.tag]?.[last] || 0),0);
  if(net<0)for(const line of Object.values(v))for(const k of Object.keys(line))line[k]=-line[k];
 }
 const w=fs.createWriteStream(out);
 for(const [adsh,s] of sections)w.write(JSON.stringify({adsh,...subs.get(adsh),lines:s.map(l=>({tag:l.tag,label:l.label})),values:values.get(adsh) || {}})+'\n');
 await new Promise(r=>w.end(r));zip.zf.close();
 return sections.size;
}

// The companies to build: revenue and no cost of revenue in the latest annual year.
function candidates(only){
 const dir=path.join(p.DATA_DIR,'sec-financials'),out=new Map();
 for(const f of fs.readdirSync(dir)){
  if(!/^\d{10}\.json$/.test(f) || (only && f.slice(0,10)!==p.cik(only)))continue;
  const r=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')).income?.annualReports?.[0];
  // A bank's statement has no cost section: its expenses follow interest and fee income.
  if(r && r.totalRevenue!=null && r.costOfRevenue==null && r.netInterestIncome==null)out.set(f.slice(0,10),r.reportedCurrency);
 }
 return out;
}

// Revenue less operating income by FSDS month, in the statements' currency: what a
// section with no printed total should add up to.
function operatingCosts(cik,currency){
 const rows=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'sec-financials',cik+'.json'),'utf8')).income?.annualReports || [],out={};
 for(const r of rows)if(r.reportedCurrency===currency && r.totalRevenue!=null && r.operatingIncome!=null)out[costs.month(r.fiscalDateEnding)]=r.totalRevenue-r.operatingIncome;
 return out;
}

const CACHE=path.join(__dirname,'.cache','filed-costs-headings.json');
async function headings(cik,adsh,tags,cache){
 const key=adsh+'|'+tags.join(',');if(key in cache)return cache[key];
 const tree=await fetchHeadings(cik,adsh,tags);cache[key]=tree;return tree;
}
async function fetchHeadings(cik,adsh,tags){
 const axios=req('axios'),{HEADERS}=require('../backend/sec-reporting'),{parseLabels}=require('../backend/sec-original');
 const base=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g,'')}/`;
 const get=(name,type)=>axios.get(base+name,{headers:HEADERS,timeout:30000,maxContentLength:40*1024*1024,responseType:type,...(type==='text'?{transformResponse:x=>x}:{})}).then(r=>r.data);
 const items=(await get('index.json','json'))?.directory?.item || [];
 const pre=items.find(i=>/_pre\.xml$/.test(i.name)),lab=items.find(i=>/_lab\.xml$/.test(i.name));
 if(!pre || !lab)return null;
 return costs.withHeadings(await get(pre.name,'text'),parseLabels(await get(lab.name,'text')),tags);
}

function assemble(cik,currency,filings){
 // Latest annual filing first; an amendment counts by its own filing date.
 filings.sort((a,b)=>b.filed.localeCompare(a.filed) || b.adsh.localeCompare(a.adsh));
 const latest=filings[0],lines=latest.lines.map(l=>({c:l.tag,l:l.label,d:0,v:{}}));
 // The section's total is its last total line; a line tagged OperatingExpenses can be one
 // part ("Operating", Alexander's) above the filing's own "Total expenses".
 const total=latest.lines.map(l=>costs.isTotal(l.tag,l.label)).lastIndexOf(true);if(total>=0)lines[total].t=1;
 const sources={};
 for(const f of filings)for(const l of lines)for(const [k,val] of Object.entries(f.values[l.c] || {})){
  const [unit,end]=k.split('|');if(unit!==currency || end>f.filed)continue;
  if(!(end in l.v)){l.v[end]=val;if(!sources[end])sources[end]=f.adsh;}
 }
 // A period whose lines do not add up shows its total alone (filed-costs.js reconciles).
 const expected=total<0?operatingCosts(cik,currency):null;
 for(const end of Object.keys(sources)){
  const target=total>=0?lines[total].v[end]:expected[end.slice(0,7)];
  if(!costs.reconciles(lines,end,target)){for(const l of lines)if(!l.t)delete l.v[end];if(total<0)delete sources[end];}
 }
 // A period the latest filing does not cover is taken from an older one; a line
 // that older filing did not show stays empty for it.
 const kept=lines.filter(l=>Object.keys(l.v).length);
 const latestEnd=Object.keys(sources).sort().pop();
 const latestReconciles=!!latestEnd && kept.some(l=>!l.t && latestEnd in l.v);
 return {latestReconciles,schemaVersion:1,cik,currency,filing:{accession:latest.adsh,form:latest.form,filed:latest.filed},heading:null,lines:kept,sources};
}

async function main(){
 const only=arg('--only',null),wanted=candidates(only);
 if(process.argv[2]==='--child'){const n=await child(process.argv[3],process.argv[4],new Set(JSON.parse(fs.readFileSync(process.argv[5],'utf8'))));console.log(path.basename(process.argv[3]),n,'filings');return;}
 const dir=arg('--dir',path.join(os.homedir(),'.cache/stockportfolio/fsds')),jobs=Number(arg('--jobs',Math.max(1,os.cpus().length>>1)));
 const zips=fs.readdirSync(dir).filter(f=>/^\d{4}q[1-4]\.zip$/.test(f)).sort();
 if(!zips.length)throw new Error(`no quarterly zips in ${dir}`);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'filed-costs-')),list=path.join(tmp,'ciks.json');
 fs.writeFileSync(list,JSON.stringify([...wanted.keys()]));
 const queue=[...zips];let failed=0;
 await Promise.all(Array.from({length:Math.min(jobs,zips.length)},async()=>{for(let z;(z=queue.shift());){
  const code=await new Promise(res=>{const c=spawn(process.execPath,[__filename,'--child',path.join(dir,z),path.join(tmp,z+'.ndjson'),list],{stdio:['ignore','inherit','inherit']});c.on('exit',res);});
  if(code!==0){failed++;console.error(z,'failed with',code);}
 }}));
 if(failed)throw new Error(`${failed} quarter(s) failed; nothing written`);
 const by=new Map();
 for(const z of zips){const rl=readline.createInterface({input:fs.createReadStream(path.join(tmp,z+'.ndjson')),crlfDelay:Infinity});for await(const text of rl){if(!text)continue;const f=JSON.parse(text);if(!by.has(f.cik))by.set(f.cik,new Map());by.get(f.cik).set(f.adsh,f);}}
 const outDir=costs.DIR();fs.mkdirSync(outDir,{recursive:true});
 let headed=0,unheaded=0,fetched=0,unreconciled=0;const written=new Set();
 let cache={};try{cache=JSON.parse(fs.readFileSync(CACHE,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const [cik,filings] of by){
  const doc=assemble(cik,wanted.get(cik),[...filings.values()]);
  if(doc.lines.filter(l=>!l.t).length<2 || !doc.latestReconciles){unreconciled++;continue;}
  delete doc.latestReconciles;
  if(!process.argv.includes('--no-headings')) {
   let tree=null;
   try{tree=await headings(cik,doc.filing.accession,doc.lines.map(l=>l.c),cache);}catch(e){console.error(cik,'headings:',e.code || e.message);}
   if(++fetched%50===0){fs.mkdirSync(path.dirname(CACHE),{recursive:true});fs.writeFileSync(CACHE,JSON.stringify(cache));console.error(`headings ${fetched}`);}
   if(tree) {
    const byTag=new Map(doc.lines.map(l=>[l.c,l])),lines=[];
    for(const n of tree){if(n.heading)lines.push({h:1,l:costs.label(n.heading),d:n.depth});else if(byTag.has(n.tag))lines.push({...byTag.get(n.tag),d:n.depth});}
    // The outermost heading over every line ("Costs and expenses") names the section.
    if(lines[0]?.h && lines.slice(1).every(l=>l.d>lines[0].d)){doc.heading=lines.shift().l;for(const l of lines)l.d--;}
    if(lines.filter(l=>!l.h).length===doc.lines.length){doc.lines=lines;headed++;}else unheaded++;
   } else unheaded++;
  }
  p.atomicWrite(path.join(outDir,cik+'.json'),doc);written.add(cik);
 }
 fs.mkdirSync(path.dirname(CACHE),{recursive:true});fs.writeFileSync(CACHE,JSON.stringify(cache));
 if(!only)for(const f of fs.readdirSync(outDir))if(/^\d{10}\.json$/.test(f) && !written.has(f.slice(0,10)))fs.unlinkSync(path.join(outDir,f));
 fs.rmSync(tmp,{recursive:true,force:true});
 console.log(JSON.stringify({candidates:wanted.size,withSection:by.size,written:written.size,unreconciled,headed,unheaded}));
}
main().catch(e=>{console.error(e.stack || e.message);process.exit(1);});
