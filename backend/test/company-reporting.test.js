'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reporting-index-'));process.env.SEC_COVERAGE_DATA_DIR=dir;
const p=require('../sec-coverage'),reporting=require('../company-reporting'),coverage=require('../financial-coverage');
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('compact reporting metadata preserves the latest interim period and failed financial checks',()=>{
 const report={issuers:{'0000000123':{latestPeriodic:{form:'10-Q',reportDate:'2026-06-30',accessionNumber:'0000000123-26-000001'},lastFinancialResult:'transient_failure',financialFailureType:'retrieval_failed',lastReconciledCycle:'2026-10-05'}}};
 const issuers=reporting.metadata(report),snapshot={datasetId:'fixture-generation',sourceFingerprints:{reportingDigest:p.digest(report),reportingMetadataDigest:p.digest(issuers)}};
 const doc={schemaVersion:1,datasetId:snapshot.datasetId,reportingDigest:p.digest(report),issuers};fs.writeFileSync(path.join(dir,'financial-reporting-index.json'),JSON.stringify(doc));
 const e=reporting.get('123',snapshot);assert.equal(e.latestPeriodic.reportDate,'2026-06-30');assert.equal(e.lastFinancialResult,'transient_failure');assert.equal(e.financialFailureType,'retrieval_failed');
 reporting.invalidate();doc.issuers['0000000123'].latestPeriodic.reportDate='2025-06-30';fs.writeFileSync(path.join(dir,'financial-reporting-index.json'),JSON.stringify(doc));assert.throws(()=>reporting.load(snapshot),/generation mismatch/);
});
test('public coverage reads its bounded summary and refuses another dataset generation',()=>{
 fs.writeFileSync(path.join(dir,'financial-coverage-summary.json'),JSON.stringify({datasetId:'fixture-generation',counts:{stockListings:1}}));
 assert.equal(coverage.summary('fixture-generation').counts.stockListings,1);assert.throws(()=>coverage.summary('different-generation'),/generation differ/);
});
