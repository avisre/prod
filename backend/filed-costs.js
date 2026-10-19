'use strict';
// The cost lines a company prints between revenue and operating income, under its
// own labels and in its own order, for a company that files no cost of revenue.
//
// Texas Roadhouse files "Restaurant operating costs" as four lines (food and
// beverage, labor, rent, other operating) with no subtotal, so no standard tag
// carries a cost of revenue and the page showed nothing between revenue and
// operating income (2026-10-19). Summing the four would be our figure, not the
// filing's; these lines are shown as filed instead. 1,730 of 5,169 covered
// companies' latest annual statements had revenue and no cost of revenue.
//
// Lines and values come from SEC's Financial Statement Data Sets, which carry
// every line on the face of each statement with its printed label (pre.txt) but
// leave out the headings above them; the headings come from the filing's own
// presentation and label files (scripts/build-filed-costs.js).
//
// Record keys (one file per issuer): c concept, l printed label, d depth,
// h heading (no values), t total, v values by FSDS period end, as printed
// (a cost positive, a gain or other reduction negative). FSDS rounds each
// period end to the nearest month end (2025-12-30 is filed as 2025-12-31), so a
// value is matched to a statement row by that rounded month.
const fs=require('node:fs'),path=require('node:path'),p=require('./sec-coverage');
const DIR=()=>path.join(p.DATA_DIR,'filed-costs');
const OPERATING_INCOME=new Set(['OperatingIncomeLoss','ProfitLossFromOperatingActivities']);
const TOTAL_COSTS=new Set(['CostsAndExpenses','OperatingExpenses','OperatingCostsAndExpenses','BenefitsLossesAndExpenses']);
const REVENUE=new Set([...require('./sec-facts').MAPS.income.totalRevenue['us-gaap'],...require('./sec-facts').MAPS.income.totalRevenue['ifrs-full'],'Revenues']);
const isRevenue=(tag,label)=>REVENUE.has(tag) || /^total (?:net )?(?:operating )?(?:revenues?|sales)\b/i.test(label);
const isTotal=(tag,label)=>TOTAL_COSTS.has(tag) || /^total (?:operating )?(?:costs|expenses)\b/i.test(label);

// A printed label as a reader should see it: no element suffix ("Costs and Expenses
// [Abstract]"), footnote marker ("... held for sale [1]") or trailing colon, and a
// heading set in capitals ("COSTS AND EXPENSES") in sentence case.
function label(text) {
 let s=String(text || '').replace(/\s*\[Abstract\]\s*$|\s+Abstract$/i,'').replace(/(?:\s*\[\d+\])+\s*$/,'').replace(/\s*:\s*$/,'').replace(/\s+/g,' ').trim();
 if(/[A-Z]{3}/.test(s) && s===s.toUpperCase())s=s.charAt(0)+s.slice(1).toLowerCase();
 return s;
}

// lines: one statement's rows from pre.txt, [{line, tag, label}]. Returns the rows
// strictly after the last revenue line and before operating income, or through
// the costs total where a statement shows no operating income; null when the
// statement has no such section.
function costSection(lines) {
 const rows=[...lines].sort((a,b)=>a.line-b.line);
 let end=rows.findIndex(r=>OPERATING_INCOME.has(r.tag)),through=false;
 if(end<0){end=rows.map(r=>isTotal(r.tag,r.label)).lastIndexOf(true);through=true;}
 if(end<0)return null;
 let start=-1;for(let i=0;i<end;i++)if(isRevenue(rows[i].tag,rows[i].label))start=i;
 if(start<0)return null;
 const section=rows.slice(start+1,through?end+1:end).filter(r=>!isRevenue(r.tag,r.label));
 // A gross profit line means the statement has a cost of revenue after all.
 if(section.some(r=>r.tag==='GrossProfit'))return null;
 // One cost line, or a total alone, is no breakdown. Only the section's last total
 // is its total: a line tagged OperatingExpenses can be one of the parts (ALX).
 const total=section.map(r=>isTotal(r.tag,r.label)).lastIndexOf(true);
 return section.filter((r,i)=>i!==total).length>=2?section:null;
}

// The abstract headings a filing prints above its cost lines ("Restaurant operating
// costs (excluding depreciation and amortization shown separately below):"), from
// its presentation linkbase. tags: the section's concepts in order. Returns
// [{tag, depth}|{heading, depth}], or null when no statement tree holds them all.
function withHeadings(preXml, labels, tags) {
 const attr=(t,n)=>t.match(new RegExp('\\b'+n+'\\s*=\\s*"([^"]*)"'))?.[1];
 const want=new Set(tags);let best=null;
 for(const link of String(preXml).matchAll(/<(?:link:)?presentationLink\b[^>]*>([\s\S]*?)<\/(?:link:)?presentationLink>/g)) {
  const loc=new Map();for(const m of link[1].matchAll(/<(?:link:)?loc\b[^>]*>/g)){const id=(attr(m[0],'xlink:href') || '').split('#')[1] || '';loc.set(attr(m[0],'xlink:label'),id.includes('_')?id.replace('_',':'):id);}
  const local=new Set([...loc.values()].map(n=>n.split(':').pop()));
  if(![...want].every(t=>local.has(t)) || (best && loc.size>=best.loc.size))continue;
  best={loc,body:link[1]};
 }
 if(!best)return null;
 const kids=new Map(),child=new Set();
 for(const m of best.body.matchAll(/<(?:link:)?presentationArc\b[^>]*>/g)){const from=attr(m[0],'xlink:from'),to=attr(m[0],'xlink:to');if(!kids.has(from))kids.set(from,[]);kids.get(from).push({to,order:Number(attr(m[0],'order')) || 0});child.add(to);}
 const order=[];const walk=(node,depth,seen)=>{if(seen.has(node))return;seen.add(node);order.push({name:best.loc.get(node) || '',depth});for(const k of (kids.get(node) || []).sort((a,b)=>a.order-b.order))walk(k.to,depth+1,seen);};
 for(const root of best.loc.keys())if(!child.has(root))walk(root,0,new Set());
 const at=order.map(n=>want.has(n.name.split(':').pop()));
 let first=at.indexOf(true);const last=at.lastIndexOf(true);
 while(first>0 && /Abstract$/.test(order[first-1].name))first--;
 const out=[];
 for(let i=first;i<=last;i++) {
  const n=order[i],tag=n.name.split(':').pop();
  if(want.has(tag)){out.push({tag,depth:n.depth});continue;}
  // A heading counts only when one of the section's lines sits beneath it.
  if(!/Abstract$/.test(n.name))continue;
  let used=false;for(let j=i+1;j<order.length && order[j].depth>n.depth;j++)if(want.has(order[j].name.split(':').pop())){used=true;break;}
  const label=labels.get(n.name);
  if(used && label)out.push({heading:label,depth:n.depth});
 }
 const min=Math.min(...out.map(n=>n.depth));
 return out.map(n=>({...n,depth:n.depth-min}));
}

// Whether a period's lines add up to what the filing says they total. lines: the
// section in print order, [{l, d, h?, t?, v}]. target: the filed total, or revenue
// less operating income where the section prints none. A line with lines indented
// beneath it, or one printed as "Total ..." inside the section, is a subtotal and
// not counted again. Lines that do not add up are not shown for that period: a
// partial breakdown would read as the whole (two lines under one tag told apart
// only by a segment, as Halliburton files its cost of services and of sales, carry
// no value of their own in SEC's data sets).
function reconciles(lines, end, target) {
 if(target==null || !Number.isFinite(target) || target===0)return false;
 let sum=0,any=false;
 lines.forEach((l,i)=>{const next=lines[i+1];if(l.h || l.t || /^total\b/i.test(l.l) || (next && !next.h && !next.t && next.d>l.d))return;const v=l.v?.[end];if(v!=null){sum+=v;any=true;}});
 return any && Math.abs(sum-target)<=Math.abs(target)*0.0025;
}

// Nearest month end, as FSDS rounds a period end (2025-12-30 → 2025-12, 2025-01-02 → 2024-12).
function month(day) {
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));if(!m)return null;
 let y=Number(m[1]),mo=Number(m[2]);if(Number(m[3])<=15){mo--;if(!mo){mo=12;y--;}}
 return y+'-'+String(mo).padStart(2,'0');
}

// The page's view of an issuer's filed cost lines, keyed by the statement rows'
// own period ends. annual: the income statement's annual rows.
function forIssuer(cik, annual) {
 const id=p.cik(cik);if(!id)return null;
 let doc;try{doc=JSON.parse(fs.readFileSync(path.join(DIR(),id+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(doc.cik!==id || !Array.isArray(doc.lines))return null;
 const rows=new Map();for(const r of annual || [])if(r.reportedCurrency===doc.currency && month(r.fiscalDateEnding))rows.set(month(r.fiscalDateEnding),r.fiscalDateEnding);
 const values=v=>{const out={};for(const [end,val] of Object.entries(v || {})){const day=rows.get(end.slice(0,7));if(day)out[day]=val;}return out;};
 const lines=doc.lines.map(l=>l.h?{heading:true,label:l.l,depth:l.d || 0}:{concept:l.c,label:l.l,depth:l.d || 0,...(l.t?{total:true}:{}),values:values(l.v)})
  .filter(l=>l.heading || Object.keys(l.values).length);
 if(lines.filter(l=>!l.heading && !l.total).length<2)return null;
 const sources={};for(const [end,a] of Object.entries(doc.sources || {})){const day=rows.get(end.slice(0,7));if(day)sources[day]={accession:a,url:`https://www.sec.gov/Archives/edgar/data/${Number(id)}/${a.replace(/-/g,'')}/${a}-index.htm`};}
 return {currency:doc.currency,heading:doc.heading || null,filing:doc.filing,lines,sources};
}
module.exports={costSection,withHeadings,month,forIssuer,label,isTotal,reconciles,DIR};
