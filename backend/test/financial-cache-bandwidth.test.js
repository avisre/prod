'use strict';
// The company-evidence cache is the largest attributable slice of the Render
// bill, so what these tests protect is bytes on the wire, not insert counts.
// The evidence (statements, filings, observations) must be uploaded only when
// it actually changes; the volatile check timestamps that `sec-reporting.js`
// stamps on every fetch go to a separate few-hundred-byte document.
const test=require('node:test'),assert=require('node:assert/strict');
const {createCache,MAX_PERSISTENT}=require('../public-financial-cache');

// `{kind:{$in:['evidence',null]}}` must also match legacy rows written before
// the evidence/bookkeeping split, which carry no `kind` at all.
function matches(row,q){
 return Object.entries(q).every(([k,v])=>{
  if(k==='kind'){
   const actual=row.kind===undefined?'evidence':row.kind;
   return (v&&v.$in)?v.$in.includes(actual):actual===v;
  }
  return row[k]===v;
 });
}

function fixture(){
 const rows=new Map(),queries=[];let evidenceUploads=0,metaUploads=0,evidenceBytes=0,metaBytes=0;
 const col={
  createIndex:async()=>{},
  findOne:async(q,options)=>{queries.push({q,options});
   if(q._id)return rows.get(q._id)||null;
   return [...rows.values()].reverse().find(r=>matches(r,q))||null;},
  insertOne:async row=>{
   if(row._id&&rows.has(row._id))throw Object.assign(Error('duplicate'),{code:11000});
   const size=Buffer.byteLength(JSON.stringify(row));
   if(row.kind==='meta'){metaUploads++;metaBytes+=size;}else{evidenceUploads++;evidenceBytes+=size;}
   rows.set(row._id||('meta'+rows.size),row);
  }
 };
 const connection={readyState:1,db:{createCollection:async()=>{},listCollections:()=>({next:async()=>({options:{capped:true,size:MAX_PERSISTENT}})})},collection:()=>col};
 return {connection,rows,queries,stats:()=>({evidenceUploads,metaUploads,evidenceBytes,metaBytes,all:evidenceUploads+metaUploads})};
}

test('concurrent identical evidence uploads once, and a restart re-uploads no evidence',async()=>{
 const db=fixture(),cache=createCache({connection:()=>db.connection});
 const value={financial:{text:'public evidence '.repeat(10000)},reporting:{lastSuccessfulCheckAt:'2026-11-01T00:00:00Z'}};
 const results=await Promise.all(Array.from({length:8},()=>cache.set('issuer',value)));
 assert.ok(results.every(r=>r.persisted));
 assert.equal(db.stats().evidenceUploads,1,'eight concurrent writers upload the evidence once');

 const restarted=createCache({connection:()=>db.connection});
 await restarted.set('issuer',value);
 assert.equal(db.stats().evidenceUploads,1,'a new process still uploads no evidence');
 // The dedupe probe carries a 12-byte _id, never the payload.
 const probe=db.queries.at(-1);
 assert.deepEqual(Object.keys(probe.q),['_id']);
 assert.ok(probe.q._id.length<80);

 restarted.clear();
 const reread=await restarted.get('issuer');
 assert.equal(reread.financial.text,value.financial.text,'stored document remains readable');
});

test('a check that changed only its timestamps moves no evidence, only bookkeeping',async()=>{
 // This is the exact waste the audit found: sec-reporting.js stamps
 // lastSuccessfulCheckAt/lastAttemptAt with new Date() on every fetch, so the
 // whole 2.9 MB document used to be rewritten every six hours.
 const db=fixture(),cache=createCache({connection:()=>db.connection});
 // A realistic statement size: the point is that the bookkeeping does not scale
 // with it.
 const financial={observations:Array.from({length:4000},(_,i)=>({field:'f'+i,periodEnd:'2025-12-31',value:i}))};
 await cache.set('issuer',{financial,reporting:{lastSuccessfulCheckAt:'2026-11-01T00:00:00Z'},attempts:[{source:'SEC',status:'success'}],lastAttemptAt:'2026-11-01T00:00:00Z'});
 const afterFirst=db.stats().evidenceBytes;
 await cache.set('issuer',{financial,reporting:{lastSuccessfulCheckAt:'2026-11-01T06:00:00Z'},attempts:[{source:'SEC',status:'success'}],lastAttemptAt:'2026-11-01T06:00:00Z'});
 await cache.set('issuer',{financial,reporting:{lastSuccessfulCheckAt:'2026-11-01T12:00:00Z'},attempts:[{source:'SEC',status:'success'}],lastAttemptAt:'2026-11-01T12:00:00Z'});
 assert.equal(db.stats().evidenceUploads,1,'unchanged statements are never re-uploaded');
 assert.equal(db.stats().evidenceBytes,afterFirst);
 assert.equal(db.stats().metaUploads,3,'each check still records when it ran');
 assert.ok(db.stats().metaBytes<db.stats().evidenceBytes/10,'bookkeeping is a small fraction of the evidence');

 // The reader still sees the freshest check time: the freshness gate depends on it.
 cache.clear();
 const reread=await cache.get('issuer');
 assert.equal(reread.reporting.lastSuccessfulCheckAt,'2026-11-01T12:00:00Z');
 assert.equal(reread.lastAttemptAt,'2026-11-01T12:00:00Z');
 assert.equal(reread.financial.observations.length,4000,'the evidence survived the split');
});

test('new figures are still new evidence and are persisted',async()=>{
 const db=fixture(),cache=createCache({connection:()=>db.connection});
 await cache.set('issuer',{financial:{value:0},reporting:{lastSuccessfulCheckAt:'2026-11-01T00:00:00Z'}});
 await cache.set('issuer',{financial:{value:0},reporting:{lastSuccessfulCheckAt:'2026-11-02T00:00:00Z'}});
 await cache.set('issuer',{financial:{value:1},reporting:{lastSuccessfulCheckAt:'2026-11-02T00:00:00Z'}});
 assert.equal(db.stats().evidenceUploads,2,'the two distinct sets of figures were both stored; the timestamp-only repeat was not');
 assert.equal(db.stats().metaUploads,3);
});

test('the stored evidence is compressed, and an uncompressed legacy row still reads',async()=>{
 const db=fixture(),cache=createCache({connection:()=>db.connection});
 const big={financial:{rows:Array.from({length:2000},(_,i)=>({field:'f'+i,value:i,periodEnd:'2025-12-31'}))}};
 await cache.set('issuer',big);
 const evidence=[...db.rows.values()].find(r=>r.kind==='evidence');
 assert.equal(evidence.codec,'zlib','evidence is deflated before it is stored');
 assert.ok(Buffer.isBuffer(evidence.value));
 assert.ok(evidence.value.length<Buffer.byteLength(JSON.stringify(big))/4,'financial grids compress by at least 4x');

 // A document written before this change has no codec and must keep working.
 const legacy=new Map(db.rows);
 legacy.set('legacy',{_id:'legacy',issuer:'legacy-issuer',value:{financial:{value:42}},createdAt:new Date()});
 const legacyCol={createIndex:async()=>{},findOne:async(q)=>q._id?legacy.get(q._id)||null:[...legacy.values()].reverse().find(r=>matches(r,q))||null,insertOne:async()=>{}};
 const legacyCache=createCache({connection:()=>({readyState:1,db:{createCollection:async()=>{},listCollections:()=>({next:async()=>({options:{capped:true,size:MAX_PERSISTENT}})})},collection:()=>legacyCol})});
 assert.deepEqual(await legacyCache.get('legacy-issuer'),{financial:{value:42}},'legacy plain-JSON rows are still readable');
});
