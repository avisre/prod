'use strict';
const fs=require('node:fs'),path=require('node:path'),p=require('./sec-coverage');
let cached;
function load(datasetId){
 if(cached?.datasetId===datasetId)return cached;
 const raw=fs.readFileSync(path.join(p.DATA_DIR,'screen-index.json'),'utf8');if(Buffer.byteLength(raw)>=8*1024*1024)throw new Error('Screen snapshot exceeds 8 MiB');
 const doc=JSON.parse(raw);
 if(doc.v!==3 || doc.policyVersion!==1 || doc.datasetId!==datasetId || !Array.isArray(doc.rows) || doc.count!==doc.rows.length || !p.day(doc.asOf))throw new Error('Incompatible screen snapshot generation');
 cached=doc;return doc;
}
function invalidate(){cached=null;}
module.exports={load,invalidate};
