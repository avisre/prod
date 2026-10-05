'use strict';
const fs=require('node:fs'),path=require('node:path'),p=require('./sec-coverage');
let cached=null;
const fields=['latestPeriodic','latestEarningsRelease','lastAttemptAt','lastFinancialAttemptAt','lastFinancialCheckAt','lastFinancialResult','financialFailureType','lastErrorCode','lastReconciledCycle','validationVersion','industryExtraction'];
function metadata(report){return Object.fromEntries(Object.entries(report.issuers || {}).map(([id,e])=>[id,Object.fromEntries(fields.filter(field=>e[field]!==undefined).map(field=>[field,e[field]]))]));}
function load(snapshot=require('./public-stock-index').load()) {
 if(!snapshot.sourceFingerprints?.reportingMetadataDigest)return {};
 if(cached?.datasetId===snapshot.datasetId)return cached.issuers;
 const raw=fs.readFileSync(path.join(p.DATA_DIR,'financial-reporting-index.json'),'utf8');if(Buffer.byteLength(raw)>8*1024*1024)throw new Error('Reporting metadata exceeds bound');
 const doc=JSON.parse(raw);if(doc.schemaVersion!==1 || doc.datasetId!==snapshot.datasetId || doc.reportingDigest!==snapshot.sourceFingerprints.reportingDigest || p.digest(doc.issuers)!==snapshot.sourceFingerprints.reportingMetadataDigest)throw new Error('Reporting metadata generation mismatch');
 cached=doc;return doc.issuers;
}
function get(cik,snapshot){return load(snapshot)[p.cik(cik)] || {};}
module.exports={metadata,load,get,invalidate:()=>{cached=null;}};
