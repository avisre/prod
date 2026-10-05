#!/usr/bin/env node
'use strict';
// Confirm ambiguous and fund-like identities from their own SEC submissions.
const fs=require('node:fs'),path=require('node:path'),p=require('../backend/sec-coverage'),client=require('../backend/sec-reporting');
async function main() {
 const file=path.join(p.DATA_DIR,'sec-reporting.json'),report=JSON.parse(fs.readFileSync(file,'utf8'));
 const directory=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8'));
 const groups=new Map();for(const c of directory.companies)if(p.cik(c.cik) && (c.securityType==='unresolved' || (!report.issuers[c.cik]?.latestAnnual && /\b(?:fund|trust)\b/i.test(c.securityName || c.name)))){const group=groups.get(c.cik) || {cik:c.cik,symbols:[]};group.symbols.push(c.symbol);groups.set(c.cik,group);}
 const todo=[...groups.values()];let done=0,confirmedFunds=0,failures=0;const save=()=>p.atomicWrite(file,report);
 const lock=path.join(p.DATA_DIR,'.sec-refresh.lock'),fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));
 const unlock=()=>{try{fs.closeSync(fd);fs.unlinkSync(lock);}catch(_){}};process.once('exit',unlock);
 const stop=()=>{save();process.exit(130);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 await Promise.all(Array.from({length:2},async()=>{while(todo.length){const issuer=todo.shift(),old=report.issuers[issuer.cik] || {};try{const fresh=await client.fetchReporting(issuer,{asOf:report.asOf});report.issuers[issuer.cik]={...old,...fresh,symbols:[...new Set([...(old.symbols || []),...issuer.symbols])]};if(fresh.fundRegistrant)confirmedFunds++;}catch(_){failures++;}done++;if(done%20===0){save();console.log(JSON.stringify({identityChecks:done,confirmedFunds,failures,remaining:todo.length}));}}}));save();unlock();process.removeListener('exit',unlock);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);console.log(JSON.stringify({identityChecks:done,confirmedFunds,failures}));
}
if(require.main===module)main().catch(e=>{console.error(e.code || e.message);process.exitCode=1;});module.exports={main};
