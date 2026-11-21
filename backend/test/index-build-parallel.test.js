'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');

// The worker-pool build must reassemble its chunks into exactly what the
// one-thread build produces: same issuers, same order, same digests.
test('parallel index build matches the serial build',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'index-build-parallel-'));
 const script=`
 const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
 const root=${JSON.stringify(root)},dir=process.env.SEC_COVERAGE_DATA_DIR;
 const p=require(root+'/backend/sec-coverage');
 const {fixture,CIK}=require(root+'/backend/test/fixtures/sec-fixture');
 const issuers={},companies=[];
 ['0000000101','0000000102','0000000103'].forEach((cik,i)=>{
  const {doc,evidence}=fixture('us-gaap','USD');
  evidence.lastAttemptResult='success';evidence.issuerName='Example '+i;evidence.lastFinancialResult='success';
  const data=require(root+'/backend/sec-facts').extract(doc,evidence,{asOf:'2026-10-03'});
  const file=path.join(dir,'sec-financials',cik+'.json');p.atomicWrite(file,data);
  issuers[cik]={...evidence,cik,financialDigest:p.digest(fs.readFileSync(file,'utf8'))};
  companies.push({symbol:'ZQX'+i,name:'Example '+i,exchange:'NASDAQ',securityType:'stock',cik});
 });
 companies.splice(1,0,{symbol:'ZQX0.B',name:'Example 0 class B',exchange:'NYSE',securityType:'stock',cik:'0000000101'},{symbol:'ZQXN',name:'No filer',exchange:'NYSE',securityType:'stock'});
 p.atomicWrite(path.join(dir,'us-companies.json'),{companies});
 p.atomicWrite(path.join(dir,'sec-reporting.json'),{schemaVersion:1,asOf:'2026-10-03',issuers});
 p.atomicWrite(path.join(dir,'sec-fx.json'),{schemaVersion:1,rates:{}});
 const {build,buildParallel}=require(root+'/scripts/build-public-stock-index');
 const strip=r=>JSON.parse(JSON.stringify(r,(k,v)=>k==='generatedAt'?undefined:v));
 const serial=strip(build({write:false}));
 (async()=>{
  const parallel=strip(await buildParallel({write:false,workers:3}));
  assert.deepEqual(parallel,serial);
  assert.deepEqual(Object.keys(serial.publicSnapshot.issuers),['0000000101','0000000102','0000000103']);
  assert.deepEqual(serial.publicSnapshot.securities.map(s=>s.symbol),companies.map(c=>c.symbol));
 })().catch(e=>{console.error(e.stack);process.exitCode=1;});
 `;
 try {
  const result=spawnSync(process.execPath,['-e',script],{cwd:root,encoding:'utf8',timeout:60000,env:{...process.env,SEC_COVERAGE_DATA_DIR:dir,SEC_COVERAGE_DISABLE_ON_DEMAND:'1',SEC_COVERAGE_READ_ONLY:'1',DISABLE_BACKGROUND_JOBS:'1'}});
  assert.equal(result.status,0,result.stdout+result.stderr+(result.error || ''));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
