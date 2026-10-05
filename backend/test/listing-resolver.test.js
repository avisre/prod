'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'listing-identity-'));process.env.SEC_COVERAGE_DATA_DIR=dir;fs.writeFileSync(path.join(dir,'us-companies.json'),JSON.stringify({companies:[]}));
const {resolveListing}=require('../listing-resolver');
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('a newly requested common-share fund is classified before company evidence is allowed',async()=>{
 const d=new Date(),stamp=String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0')+d.getUTCFullYear()+'00:00';
 const nasdaq='Symbol|Security Name|ETF|Test Issue\nNEWCEF|New Income Fund - Common Shares|N|N\nNEWCORP|New Corporation - Common Stock|N|N\nFile Creation Time: '+stamp+'\n';
 const other='ACT Symbol|Security Name|ETF|Test Issue|Exchange\nFile Creation Time: '+stamp+'\n';
 let directoryCalls=0,reportingCalls=0;
 const fetchImpl=async url=>{directoryCalls++;return {ok:true,text:async()=>url.includes('nasdaqlisted')?nasdaq:url.includes('otherlisted')?other:JSON.stringify({fields:['cik','ticker'],data:[[123,'NEWCEF'],[456,'NEWCORP']]})};};
 const fetchReporting=async issuer=>{reportingCalls++;return {fundRegistrant:issuer.cik==='0000000123',entityType:issuer.cik==='0000000123'?'investment':'operating'};};
 const fund=await resolveListing('NEWCEF',{fetchImpl,fetchReporting});assert.equal(fund.securityType,'closed_end_fund');
 const corp=await resolveListing('NEWCORP',{fetchImpl,fetchReporting});assert.equal(corp.securityType,'stock');assert.equal(directoryCalls,3);assert.equal(reportingCalls,2);
 assert.equal((await resolveListing('NEWCEF',{fetchImpl,fetchReporting})).securityType,'closed_end_fund');assert.equal(reportingCalls,2);
});
