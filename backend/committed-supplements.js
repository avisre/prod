'use strict';
const fs=require('node:fs'),path=require('node:path'),p=require('./sec-coverage'),obs=require('./company-observations');
function readAll({validate=true}={}) {
 const dir=path.join(p.DATA_DIR,'supplemental-financials');let names=[];try{names=fs.readdirSync(dir).filter(n=>/^(?:\d{10}|listing-[A-Z0-9]+(?:-[A-Z0-9]+)?)\.json$/.test(n)).sort();}catch(e){if(e.code!=='ENOENT')throw e;}
 return names.map(name=>{const raw=fs.readFileSync(path.join(dir,name),'utf8'),doc=JSON.parse(raw),issuer=name.replace(/\.json$/,'').replace(/^listing-/, 'listing:');if((doc.issuer || doc.cik)!==issuer || !Array.isArray(doc.observations) || validate && doc.observations.some(f=>!obs.validSupplement(f,issuer) || f.sourceType==='sec_filing' || f.basis==='market'))throw new Error('Invalid committed supplemental evidence '+issuer);return {issuer,doc,digest:p.digest(raw)};});
}
function forIssuer(issuer){const id=obs.identity(issuer);if(!id)return [];try{const doc=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'supplemental-financials',id.replace(':','-')+'.json'),'utf8'));if((doc.issuer || doc.cik)!==id)return [];return (doc.observations || []).filter(f=>obs.validSupplement(f,id) && f.state==='available' && f.sourceType!=='sec_filing' && f.basis!=='market');}catch(e){if(e.code!=='ENOENT')throw e;return [];}}
function fingerprint(){return p.digest(readAll().map(r=>[r.issuer,r.digest]));}
module.exports={readAll,fingerprint,forIssuer};
