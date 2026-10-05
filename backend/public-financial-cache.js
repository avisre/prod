'use strict';
// Public financial evidence only. A capped Mongo collection enforces the disk
// bound across processes; application checks enforce the memory and BSON bounds.
const { digest } = require('./sec-coverage');
const MAX_MEMORY=8*1024*1024,MAX_PERSISTENT=64*1024*1024;
function createCache({connection=()=>require('mongoose').connection,maxMemory=MAX_MEMORY}={}) {
 const entries=new Map();let bytes=0,setup=null;
 function remember(key,value) {
  const old=entries.get(key);if(old)bytes-=old.bytes;entries.delete(key);
  const size=Buffer.byteLength(JSON.stringify(value));if(size>maxMemory)return value;
  entries.set(key,{value,bytes:size});bytes+=size;
  while(bytes>maxMemory){const key=entries.keys().next().value;bytes-=entries.get(key).bytes;entries.delete(key);}
  return value;
 }
 async function collection() {
  const conn=connection();if(conn?.readyState!==1)return null;
  if(!setup)setup=(async()=>{
   try{await conn.db.createCollection('public_financial_requests',{capped:true,size:MAX_PERSISTENT});}
   catch(e){if(e.code!==48 && e.codeName!=='NamespaceExists')throw e;}
   const info=await conn.db.listCollections({name:'public_financial_requests'}).next();
   if(!info?.options?.capped || info.options.size>MAX_PERSISTENT)throw new Error('FINANCIAL_CACHE_BOUND_NOT_CONFIGURED');
   const col=conn.collection('public_financial_requests');await col.createIndex({issuer:1,createdAt:-1});return col;
  })().catch(e=>{setup=null;throw e;});
  return setup;
 }
 async function get(key) {
  const hit=entries.get(key);if(hit){entries.delete(key);entries.set(key,hit);return hit.value;}
  try{const col=await collection();const row=col && await col.findOne({issuer:key},{sort:{createdAt:-1},maxTimeMS:2000});return row?remember(key,row.value):null;}catch(_){return null;}
 }
 async function set(key,value) {
  remember(key,value);const size=Buffer.byteLength(JSON.stringify(value));
  if(size>MAX_MEMORY)return {persisted:false,reason:'Evidence exceeds request-cache document bound'};
  try{const col=await collection();if(!col)return {persisted:false,reason:'Public financial cache is temporarily disconnected'};
   await col.insertOne({_id:digest({key,value}),issuer:key,value,createdAt:new Date()});return {persisted:true};
  }catch(e){if(e.code===11000)return {persisted:true};return {persisted:false,reason:'Public financial evidence persistence failed'};}
 }
 return {get,set,stats:()=>({entries:entries.size,bytes,maxMemory,maxPersistent:MAX_PERSISTENT}),clear:()=>{entries.clear();bytes=0;}};
}
module.exports={createCache,MAX_MEMORY,MAX_PERSISTENT,...createCache()};
