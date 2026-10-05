#!/usr/bin/env node
'use strict';
// One shared SEC allocator across the weekly runner and production workers.
const mongoose=require('node:module').createRequire(require('node:path').join(__dirname,'../backend/package.json'))('mongoose');
const {cacheUri,promote}=require('./promote-financial-cache');
async function main() {
 const uri=await cacheUri();if(!uri)throw Object.assign(new Error('Public financial infrastructure is unavailable'),{code:'PUBLIC_CACHE_NOT_CONFIGURED'});
 await mongoose.connect(uri,{serverSelectionTimeoutMS:10000});
 try {
  const stage=process.argv[2];
  if(stage==='listings')await require('./build-us-companies').main();
  else if(stage==='identities')await require('./audit-listing-identities').main();
  else if(stage==='core')await require('./refresh-sec-coverage').main(['--weekly','--concurrency','2','--as-of',process.env.FINANCIAL_AS_OF || new Date().toISOString().slice(0,10)]);
  else if(stage==='industry')await require('./refresh-sec-industry').main();
  else if(stage==='promote')console.log(JSON.stringify(await promote(mongoose.connection.collection('public_financial_requests'),{asOf:process.env.FINANCIAL_AS_OF})));
  else throw new Error('Unknown financial stage');
 }finally{await mongoose.disconnect();}
}
if(require.main===module)main().catch(e=>{console.error('Financial stage failed: '+(e.code || 'stage_failed'));process.exitCode=1;});module.exports={main};
