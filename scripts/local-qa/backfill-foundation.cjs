'use strict';
// Local, resumable implementation backfill. Release still requires the full
// test suite, browser/API checks and an explicit final publishing command.
const {spawnSync}=require('node:child_process'),path=require('node:path');
function main(){const asOf=process.env.FINANCIAL_AS_OF || new Date().toISOString().slice(0,10),stages=[
 ['core reconciliation',['--max-old-space-size=768','scripts/refresh-sec-coverage.js','--weekly','--as-of',asOf,'--concurrency','2']],
 ['retry incomplete core issuers',['--max-old-space-size=768','scripts/refresh-sec-coverage.js','--weekly','--as-of',asOf,'--concurrency','2']],
 ['preserve superseded incompatible observations',['scripts/normalize-financial-source-ids.js']],
 ['reconcile classified listings',['scripts/build-us-companies.js']],
 ['review fund and ambiguous identities',['scripts/audit-listing-identities.js']],
 ['publish the classified directory',['scripts/build-us-companies.js']],
 ['reconcile newly classified stock identities',['--max-old-space-size=768','scripts/refresh-sec-coverage.js','--weekly','--as-of',asOf,'--concurrency','2']],
 ['revalidate the final stock financial universe',['scripts/normalize-financial-source-ids.js']],
 ['original industry disclosures',['--max-old-space-size=768','scripts/refresh-sec-industry.js']],
 ['retry transient original-document failures',['--max-old-space-size=768','scripts/refresh-sec-industry.js','--retry']],
 ['build matching public, screening and coverage generations',['--max-old-space-size=768','scripts/build-public-stock-index.js']],
 ['validate dated generation',['scripts/validate-stock-coverage.js','--bootstrap']]
 ];
 for(const [name,args]of stages){console.log(JSON.stringify({stage:name,status:'started',at:new Date().toISOString()}));const r=spawnSync(process.execPath,args,{cwd:path.join(__dirname,'../..'),stdio:'inherit',env:{...process.env,FINANCIAL_AS_OF:asOf,SEC_COVERAGE_DISABLE_ON_DEMAND:'1',DISABLE_BACKGROUND_JOBS:'1'}});if(r.status!==0)throw new Error(name+' failed with exit '+r.status);console.log(JSON.stringify({stage:name,status:'completed',at:new Date().toISOString()}));}
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}module.exports={main};
