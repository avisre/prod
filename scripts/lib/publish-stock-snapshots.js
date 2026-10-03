'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Stage both complete documents before publication; restore both on write errors.
function publish(directory,publicSnapshot,screenSnapshot) {
 const suffix='.'+process.pid+'.'+crypto.randomUUID();
 const files=[['screen-index.json',screenSnapshot],['public-stock-index.json',publicSnapshot]].map(([name,doc])=>({file:path.join(directory,name),doc}));
 try {
  for(const item of files){item.temp=item.file+suffix+'.tmp';item.backup=item.file+suffix+'.bak';fs.writeFileSync(item.temp,JSON.stringify(item.doc));item.existed=fs.existsSync(item.file);if(item.existed)fs.copyFileSync(item.file,item.backup,fs.constants.COPYFILE_FICLONE);}
  for(const item of files){fs.renameSync(item.temp,item.file);item.published=true;}
 }catch(error){
  for(const item of files)if(item.published){if(item.existed)fs.renameSync(item.backup,item.file);else fs.unlinkSync(item.file);}
  throw error;
 }finally{for(const item of files)for(const file of [item.temp,item.backup])if(file)try{fs.unlinkSync(file);}catch(_){} }
}
module.exports={publish};
