'use strict';
// FDIC Call Report rows for listed banks that file with their regulator, not the SEC.
// Pure mapping only: the fixture is a trimmed copy of Bank OZK's FDIC records.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fdic=require('../../scripts/fetch-fdic-financials'),obs=require('../company-observations');
const OZK=fdic.BANKS.find(b=>b.symbol==='OZK'),HIFS=fdic.BANKS.find(b=>b.symbol==='HIFS'),WCCB=fdic.BANKS.find(b=>b.symbol==='WCCB');
const NOW='2026-10-17T00:00:00.000Z';
// 2025-12-31 and 2026-03-31 as returned by api.fdic.gov/banks/financials for CERT 110 ($ thousands).
const DEC={CERT:110,REPDTE:'20251231',CALLFORM:41,ASSET:40785840,LIAB:34655989,EQ:6129851,EQTOT:6129851,EQCONSUB:0,DEP:33384965,LNLSNET:31842064,
 INTINC:2670119,EINTEXP:1077956,NIM:1592163,NONII:135696,NONIX:621075,ELNATR:172514,IBEFTAX:934270,ITAX:218811,EXTRA:0,NETIMIN:-21,NETINC:715480,
 INTINQ:671009,EINTXQ:263960,NIMQ:407049,NONIIQ:33603,NONIXQ:161650,ELNATQ:50569,IBEFTXQ:229000,ITAXQ:52523,NETINCQ:175962};
const MAR={CERT:110,REPDTE:'20260331',CALLFORM:41,ASSET:41663976,LIAB:35507766,EQ:6156210,EQTOT:6156210,EQCONSUB:0,DEP:33764925,LNLSNET:32495265,
 INTINC:629016,EINTEXP:243448,NIM:385568,NONII:32531,NONIX:164540,ELNATR:41948,IBEFTAX:211611,ITAX:48247,EXTRA:0,NETIMIN:0,NETINC:163364,
 INTINQ:629016,EINTXQ:243448,NIMQ:385568,NONIIQ:32531,NONIXQ:164540,ELNATQ:41948,IBEFTXQ:211611,ITAXQ:48247,NETINCQ:163364};
const find=(facts,field,basis,end)=>facts.find(f=>f.field===field && f.basis===basis && f.periodEnd===end);

test('annual rows are the December year-to-date figures, scaled from $ thousands to dollars',()=>{
 const {observations}=fdic.observationsFor(OZK,[DEC,MAR],NOW);
 const ni=find(observations,'netIncome','annual','2025-12-31');
 assert.equal(ni.value,715480000);assert.equal(ni.scale,1);assert.equal(ni.unit,'USD');assert.equal(ni.periodStart,'2025-01-01');assert.equal(ni.historyBasis,'annual');
 assert.equal(ni.scope,'parent');assert.equal(ni.fdicField,'NETINC');assert.equal(ni.issuer,'0001569650');assert.equal(ni.callReportForm,'FFIEC 041');
 assert.equal(find(observations,'totalAssets','instant','2025-12-31').value,40785840000);
 assert.equal(find(observations,'totalAssets','instant','2025-12-31').historyBasis,'annual');
 assert.equal(find(observations,'totalShareholderEquity','instant','2025-12-31').fdicField,'EQ');
 assert.equal(find(observations,'loans','instant','2025-12-31').value,31842064000);
 // No annual row for a year that has not ended.
 assert.equal(observations.filter(f=>f.basis==='annual' && f.periodEnd==='2026-03-31').length,0);
});

test('quarterly rows use the FDIC published quarter fields, never a year-to-date total',()=>{
 const {observations}=fdic.observationsFor(OZK,[DEC,MAR],NOW);
 const q4=find(observations,'netIncome','quarterly','2025-12-31');
 assert.equal(q4.value,175962000);assert.equal(q4.periodStart,'2025-10-01');assert.equal(q4.fdicField,'NETINCQ');
 const q1=find(observations,'interestIncome','quarterly','2026-03-31');
 assert.equal(q1.value,629016000);assert.equal(q1.periodStart,'2026-01-01');
 const bal=find(observations,'deposits','instant','2026-03-31');
 assert.equal(bal.historyBasis,'quarterly');assert.equal(bal.value,33764925000);
});

test('every row passes the shared supplement validator for a CIK and a listing issuer',()=>{
 for(const bank of [OZK,HIFS]) {
  const issuer=bank.cik || 'listing:'+bank.symbol;
  const {observations}=fdic.observationsFor(bank,[{...DEC,CERT:bank.cert},{...MAR,CERT:bank.cert}],NOW);
  // December: 9 annual flows, 9 quarterly flows, 5 balances; March: 9 quarterly flows, 5 balances.
  assert.equal(observations.length,9+9+5+9+5,bank.symbol);
  for(const f of observations){assert.ok(obs.validSupplement(f,issuer),bank.symbol+' '+f.field);assert.equal(f.sourceType,'provider');assert.equal(f.sourceDateKind,'retrieval');assert.equal(f.sourceDataDate,'2026-10-17');assert.match(f.sourceUrl,/^https:\/\/api\.fdic\.gov\/banks\/financials\?filters=CERT%3A\d+%20AND%20REPDTE%3A\d{8}$/);}
 }
 // A listing issuer may only carry provider evidence.
 const {observations}=fdic.observationsFor(HIFS,[{...DEC,CERT:HIFS.cert}],NOW);
 assert.equal(obs.validSupplement({...observations[0],sourceType:'issuer_release'},'listing:HIFS'),false);
});

test('a record that breaks the FDIC identities is dropped whole',()=>{
 assert.equal(fdic.consistent(DEC),true);
 const broken={...DEC,LIAB:DEC.LIAB+5000};
 const {observations,rejected}=fdic.observationsFor(OZK,[broken,MAR],NOW);
 assert.deepEqual(rejected,['20251231']);assert.equal(observations.some(f=>f.periodEnd==='2025-12-31'),false);
 // Records for another bank are ignored rather than attributed.
 assert.equal(fdic.observationsFor(OZK,[{...DEC,CERT:999}],NOW).observations.length,0);
});

test('a holding company is covered only as its sole bank subsidiary, and labelled so',()=>{
 const {observations}=fdic.observationsFor(WCCB,[{...DEC,CERT:WCCB.cert}],NOW);
 for(const f of observations){assert.equal(f.scope,'bank_subsidiary:FDIC 57591');assert.match(f.definition,/^Bank subsidiary only \(West Coast Community Bank, FDIC CERT 57591\)/);}
 const inst={NAME:'West Coast Community Bank',STALP:'CA',ACTIVE:1,NAMEHCR:'WEST COAST COMMUNITY BCORP'};
 assert.deepEqual(fdic.verifyInstitution(WCCB,inst,1),[]);
 assert.ok(fdic.verifyInstitution(WCCB,inst,2).length);
 assert.ok(fdic.verifyInstitution(OZK,{NAME:'Bank OZK',STALP:'AR',ACTIVE:1,NAMEHCR:'NEW HOLDCO INC'},0).length);
 assert.deepEqual(fdic.verifyInstitution(OZK,{NAME:'Bank OZK',STALP:'AR',ACTIVE:1,NAMEHCR:''},0),[]);
});

test('a June fiscal year is not passed off as the calendar-year Call Report total',()=>{
 const NBN=fdic.BANKS.find(b=>b.symbol==='NBN');
 const {observations}=fdic.observationsFor(NBN,[{...DEC,CERT:NBN.cert}],NOW);
 assert.match(find(observations,'netIncome','annual','2025-12-31').periodDefinition,/fiscal year ends 06-30, so this is not its fiscal year/);
});

test('a re-run replaces earlier FDIC rows and keeps other sources',()=>{
 const first=fdic.observationsFor(OZK,[DEC],'2026-10-16T00:00:00.000Z').observations,second=fdic.observationsFor(OZK,[DEC],NOW).observations;
 const other={...first[0],field:'sellingGeneralAndAdministrative',sourceName:'Yahoo Finance',accountingBasis:'provider-reported',sourceUrl:'https://finance.yahoo.com/quote/OZK/financials/'};
 const merged=fdic.merge([...first,other],second,'0001569650');
 assert.equal(merged.length,second.length+1);
 assert.ok(merged.filter(f=>f.sourceName===fdic.SOURCE_NAME).every(f=>f.retrievedAt===NOW));
 assert.ok(merged.some(f=>f.sourceName==='Yahoo Finance'));
});
