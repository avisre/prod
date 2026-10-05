'use strict';
const {test,afterEach}=require('node:test'),assert=require('node:assert/strict'),axios=require('axios');
const keypoints=require('../keypoints'),watchdog=require('../watchdog'),client=require('../ai-client'),filing=require('../filing-fetcher');
const original={get:axios.get,recent:watchdog.fetchRecentFilings,chat:client.chatRaw,filing:filing.getFilingText};
const env={read:process.env.SEC_COVERAGE_READ_ONLY,disabled:process.env.SEC_COVERAGE_DISABLE_ON_DEMAND};
afterEach(()=>{axios.get=original.get;watchdog.fetchRecentFilings=original.recent;client.chatRaw=original.chat;filing.getFilingText=original.filing;for(const [key,val]of [['SEC_COVERAGE_READ_ONLY',env.read],['SEC_COVERAGE_DISABLE_ON_DEMAND',env.disabled]])if(val===undefined)delete process.env[key];else process.env[key]=val;});
test('offline business context avoids both SEC network and model extraction',async()=>{
 process.env.SEC_COVERAGE_READ_ONLY='1';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='1';
 watchdog.fetchRecentFilings=axios.get=client.chatRaw=async()=>{throw Error('Unexpected network/model call');};
 const r=await keypoints.extractKeyPoints('AMD',{allowAi:false,contextOnly:true});assert.match(r.error,/disabled/);
});
test('original annual business excerpts are bounded, dated and obtained without a second model',async()=>{
 process.env.SEC_COVERAGE_READ_ONLY='0';process.env.SEC_COVERAGE_DISABLE_ON_DEMAND='0';
 let documentUrl,options;watchdog.fetchRecentFilings=client.chatRaw=async()=>{throw Error('Unnecessary filing lookup/model extraction');};
 axios.get=async(url,opts)=>{documentUrl=url;options=opts;return {data:'<html><h1>Item 1. Business</h1><p>'+('The company sells processors to customers. '.repeat(450))+'</p><h1>Item 1A. Risk Factors</h1><p>'+('Competition and manufacturing risks affect operations. '.repeat(400))+'</p><h1>Item 2. Properties</h1><p>Offices.</p></html>'};};
 const r=await keypoints.extractKeyPoints('AMD',{allowAi:false,contextOnly:true});assert.equal(r.sourceType,'sec_filing_context');assert.match(documentUrl,/www.sec.gov\/Archives/);assert.doesNotMatch(documentUrl,/-index.htm$/);assert.equal(options.timeout,15000);assert.ok(r.sections.some(s=>/business/i.test(s.heading)));assert.ok(r.sections.reduce((n,s)=>n+s.text.length,0)<=28000);assert.ok(r.filing.accession);assert.ok(r.retrievedAt);
});
test('Ask peer context can use deterministic medians without a hidden model extraction',async()=>{
 filing.getFilingText=client.chatRaw=async()=>{throw Error('Unexpected source/model call');};
 const r=await require('../industry').buildIndustry('AMD',{overview:{Sector:''},allowAi:false});assert.deepEqual(r.drivers,[]);assert.match(r.note,/No cached/);
});
