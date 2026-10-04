#!/usr/bin/env node
'use strict';
// Full app startup with a disposable local database and an explicit test env.
// Run from a clean checkout after npm ci in the root and backend directories.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function stop(child){if(!child || child.exitCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
async function main(){
 for(const name of ['.env','backend/.env','backend/prod.env'])assert.equal(fs.existsSync(path.join(root,name)),false,'Startup checkout must not contain '+name);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sec-clean-startup-')),dbpath=path.join(directory,'db');fs.mkdirSync(dbpath);
 const appPort=await freePort(),dbPort=await freePort(),debug=path.join(directory,'app.log'),out=fs.openSync(debug,'w');
 let mongo,app;
 try {
  mongo=spawn(process.env.MONGOD_BINARY || 'mongod',['--bind_ip','127.0.0.1','--port',String(dbPort),'--dbpath',dbpath,'--logpath',path.join(directory,'mongo.log'),'--quiet'],{stdio:'ignore'});
  let spawnError;mongo.once('error',e=>{spawnError=e;});
  for(let i=0;i<100;i++){if(spawnError)throw spawnError;if(mongo.exitCode!==null)throw new Error('Local mongod exited before startup');const available=await new Promise(resolve=>{const socket=net.connect(dbPort,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});if(available)break;if(i===99)throw new Error('Local mongod startup timed out');await delay(100);}
  // Do not inherit configured databases, API keys, mail credentials or job flags.
  const env={PATH:process.env.PATH,TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',NODE_ENV:'production',PORT:String(appPort),MONGODB_URI:`mongodb://127.0.0.1:${dbPort}/sec_release_startup`,JWT_SECRET:'local-release-startup-test-secret-not-a-production-credential',DISABLE_BACKGROUND_JOBS:'1',SEC_COVERAGE_READ_ONLY:'1',SEC_COVERAGE_DISABLE_ON_DEMAND:'1',WATCHDOG:'0',GURU_PREWARM:'0',PREWARM:'off'};
  app=spawn(process.execPath,['backend/app.js'],{cwd:root,env,stdio:['ignore',out,out]});let appError;app.once('error',e=>{appError=e;});
  const base=`http://127.0.0.1:${appPort}`;let healthy=false;
  for(let i=0;i<100;i++){if(appError)throw appError;if(app.exitCode!==null)throw new Error('Application exited before health became ready');try{const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)});if(response.status===200 && (await response.json()).ok){healthy=true;break;}}catch(_){}await delay(100);}
  assert.ok(healthy,'Application health did not become ready');
  const coverageResponse=await fetch(base+'/api/stock-coverage');assert.equal(coverageResponse.status,200);const coverage=await coverageResponse.json();
  const expected=require('../backend/public-stock-index').view();assert.deepEqual(coverage.counts,expected.counts);
  const screen=await fetch(base+'/api/screener?limit=2');assert.equal(screen.status,200);
  const representatives=['ready','partial','historical_only','unavailable'].map(status=>expected.securities.find(s=>s.securityType==='stock' && s.financialCoverage===status)).filter(Boolean);
  representatives.push(...['unit','right'].map(type=>expected.securities.find(s=>s.securityType===type)).filter(Boolean));
  const profiles=[];for(const security of representatives){const response=await fetch(base+'/stocks/'+security.symbol);assert.equal(response.status,200,security.symbol);const html=await response.text();assert.ok(html.includes('href="https://www.stockportfolio.pro/stocks/'+security.symbol+'"'));assert.ok(html.includes(security.indexable?'content="index, follow':'content="noindex, follow'));profiles.push({symbol:security.symbol,type:security.securityType,coverage:security.financialCoverage,status:response.status});}
  const sitemap=await fetch(base+'/sitemap.xml');assert.equal(sitemap.status,200);assert.match(await sitemap.text(),/<sitemapindex/);
  console.log(JSON.stringify({ok:true,scope:'Full application startup, production mode, clean checkout dependencies and disposable local MongoDB; no production credentials or deployment.',nodeVersion:process.version,health:200,coverage:200,screener:200,sitemap:200,profiles,counts:coverage.counts},null,2));
 }catch(error){console.error(JSON.stringify({ok:false,error:error.message,debugLog:debug}));process.exitCode=1;}
 finally{await stop(app);fs.closeSync(out);await stop(mongo);if(!process.exitCode)fs.rmSync(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
