'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mongoose=require('mongoose'),{MongoMemoryServer}=require('mongodb-memory-server');
const {createCache,MAX_PERSISTENT}=require('../public-financial-cache');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
test('public financial cache survives a new reader and client restart; its collection stays capped',async t=>{
 const server=await MongoMemoryServer.create({binary:{version:'8.2.6'}});
 t.after(async()=>{await mongoose.disconnect();await server.stop();});
 const uri=server.getUri('public_financial_fixture');await mongoose.connect(uri);
 const a=createCache();assert.deepEqual(await a.set('0000000123',{financial:{value:0},supplemental:[],reporting:{lastSuccessfulCheckAt:'2026-10-04T00:00:00Z'}}),{persisted:true});
 a.clear();await mongoose.disconnect();await mongoose.connect(uri);
 const b=createCache();assert.equal((await b.get('0000000123')).financial.value,0);
 const metadata=await mongoose.connection.db.listCollections({name:'public_financial_requests'}).next();assert.equal(metadata.options.capped,true);assert.equal(metadata.options.size,MAX_PERSISTENT);
 const names=(await mongoose.connection.db.listCollections().toArray()).map(c=>c.name);assert.deepEqual(names,['public_financial_requests']);
 const code="const mongoose=require('mongoose');(async()=>{await mongoose.connect(process.env.FINANCIAL_TEST_URI);const throttle=require('./sec-throttle');const times=[];for(let i=0;i<4;i++){await throttle.take();times.push(Date.now());}console.log(JSON.stringify(times));await mongoose.disconnect();})().catch(()=>process.exit(1));";
 const readers=await Promise.all([1,2].map(()=>promisify(execFile)(process.execPath,['-e',code],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,FINANCIAL_TEST_URI:uri},timeout:10000})));
 const times=readers.flatMap(r=>JSON.parse(r.stdout.trim())).sort((a,b)=>a-b);assert.equal(times.length,8);assert.ok(times.at(-1)-times[0]>=850,'two independent processes share the eight-per-second SEC allocator');
});
