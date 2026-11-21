'use strict';
// Spread a per-item job over one worker thread per core. The parent splits
// [0,total) into small ranges, hands each to the next free worker, and
// returns the results in range order, so concatenating them gives exactly
// what one thread walking the items in order would have produced.
const os=require('node:os');
const {Worker,parentPort}=require('node:worker_threads');

async function runChunks(file,workerData,total,{workers=os.availableParallelism(),maxOldGenerationSizeMb=1536}={}) {
 workers=Math.max(1,Math.min(workers,total));
 const size=Math.max(1,Math.ceil(total/(workers*8))),ranges=[];
 for(let start=0;start<total;start+=size)ranges.push([start,Math.min(total,start+size)]);
 const parts=new Array(ranges.length),pool=[];let next=0;
 try{await Promise.all(Array.from({length:workers},()=>new Promise((resolve,reject)=>{
  const worker=new Worker(file,{workerData,resourceLimits:{maxOldGenerationSizeMb}});pool.push(worker);
  let current=-1,done=false;
  const send=()=>{if(next>=ranges.length){done=true;worker.postMessage(null);return;}current=next++;worker.postMessage(ranges[current]);};
  worker.on('message',part=>{parts[current]=part;send();});
  worker.on('error',reject);
  worker.on('exit',code=>done && code===0?resolve():reject(new Error(file+' worker exited with code '+code)));
  send();
 })));}catch(e){await Promise.all(pool.map(w=>w.terminate()));throw e;}
 return parts;
}
// Worker side: answer each range with fn(start,end). Exit explicitly so a timer
// some required module starts cannot keep the worker alive.
function serveChunks(fn) {
 parentPort.on('message',range=>{if(!range)process.exit(0);parentPort.postMessage(fn(range[0],range[1]));});
}
module.exports={runChunks,serveChunks};
