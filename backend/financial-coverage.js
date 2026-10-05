'use strict';
const fs=require('node:fs'),path=require('node:path'),p=require('./sec-coverage');
let cached=null;
function summary(datasetId) {
 if(!cached){const file=path.join(p.DATA_DIR,'financial-coverage.json');const raw=fs.readFileSync(file,'utf8');if(Buffer.byteLength(raw)>16*1024*1024)throw new Error('Coverage audit exceeds bound');const doc=JSON.parse(raw);const {records,...summary}=doc;cached=summary;}
 if(cached.datasetId!==datasetId)throw new Error('Financial coverage and public generation differ');return cached;
}
module.exports={summary,invalidate:()=>{cached=null;}};
