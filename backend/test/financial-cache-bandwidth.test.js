'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCache,MAX_PERSISTENT}=require('../public-financial-cache');
function fixture(){
 const rows=new Map(),queries=[];let uploads=0,bytes=0;
 const col={
  createIndex:async()=>{},
  findOne:async(q,options)=>{queries.push({q,options});return q._id?rows.get(q._id)||null:[...rows.values()].reverse().find(r=>r.issuer===q.issuer)||null;},
  insertOne:async row=>{uploads++;bytes+=Buffer.byteLength(JSON.stringify(row));if(rows.has(row._id))throw Object.assign(Error('duplicate'),{code:11000});rows.set(row._id,row);}
 };
 const connection={readyState:1,db:{createCollection:async()=>{},listCollections:()=>({next:async()=>({options:{capped:true,size:MAX_PERSISTENT}})})},collection:()=>col};
 return {connection,rows,queries,stats:()=>({uploads,bytes})};
}
test('concurrent identical evidence uploads once; a new process checks its small content hash',async()=>{
 const db=fixture(),cache=createCache({connection:()=>db.connection});
 const value={financial:{text:'public evidence '.repeat(10000)},reporting:{lastSuccessfulCheckAt:'2026-11-01T00:00:00Z'}};
 const results=await Promise.all(Array.from({length:8},()=>cache.set('issuer',value)));
 assert.ok(results.every(r=>r.persisted));assert.equal(db.stats().uploads,1);
 const priorBytes=db.stats().bytes;
 const restarted=createCache({connection:()=>db.connection});await restarted.set('issuer',value);
 assert.equal(db.stats().uploads,1);assert.equal(db.stats().bytes,priorBytes);
 const query=db.queries.at(-1);assert.deepEqual(query.options.projection,{_id:1});
 assert.ok(Buffer.byteLength(JSON.stringify(query.q))<100);
 restarted.clear();assert.deepEqual(await restarted.get('issuer'),value,'stored document remains compatible with existing readers');
});
test('new figures and attempt metadata remain new evidence and are persisted',async()=>{
 const db=fixture(),cache=createCache({connection:()=>db.connection});
 await cache.set('issuer',{financial:{value:0},reporting:{lastSuccessfulCheckAt:'2026-11-01T00:00:00Z'}});
 await cache.set('issuer',{financial:{value:0},reporting:{lastSuccessfulCheckAt:'2026-11-02T00:00:00Z'}});
 await cache.set('issuer',{financial:{value:1},reporting:{lastSuccessfulCheckAt:'2026-11-02T00:00:00Z'}});
 assert.equal(db.stats().uploads,3);assert.equal(db.rows.size,3);
});
