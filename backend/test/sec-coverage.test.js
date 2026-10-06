'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../sec-coverage');
const annual = {form:'10-K',filingDate:'2025-10-03',reportDate:'2025-06-30',accessionNumber:'0000000123-25-000001',amendments:[]};
const evidence = () => ({cik:'0000000123',lastSuccessfulCheckAt:'2026-10-03',lastAttemptResult:'success',latestAnnual:{...annual}});
function financial() {
    const d={schemaVersion:1,cik:'0000000123',sources:{},income:{annualReports:[]},balance:{annualReports:[]},cash:{annualReports:[]}};
    for(const [st,fields] of Object.entries({income:['netIncome','totalRevenue'],balance:['totalAssets','totalShareholderEquity'],cash:['operatingCashflow']})) {
        const r={fiscalDateEnding:annual.reportDate,periodStart:st==='balance'?null:'2024-07-01',reportedCurrency:'USD',_sources:{}};
        for(const f of fields){r[f]=0;r._sources[f]=[f];d.sources[f]={type:'sec_xbrl_fact',linkage:'xbrl_fact',cik:d.cik,taxonomy:'us-gaap',concept:f,unit:'USD',rawValue:0,periodStart:r.periodStart,periodEnd:r.fiscalDateEnding,form:annual.form,filingDate:annual.filingDate,accessionNumber:annual.accessionNumber,filingUrl:'https://www.sec.gov/Archives/edgar/data/123/000000012325000001/0000000123-25-000001-index.htm'};}
        d[st].annualReports.push(r);
    }
    return d;
}
test('annual clock is inclusive, calendar-based, and distinct from verification freshness',()=>{
    assert.equal(p.monthsBefore('2024-02-29',12),'2023-02-28');
    const e=evidence();assert.equal(p.reportingStatus(e,'2026-10-03'),'recent_annual');
    assert.equal(p.reportingStatus(e,'2026-10-04'),'recent_annual');
    // Current past the filing anniversary, until fifteen months from the filing or eighteen from the period end.
    const late=evidence();late.latestAnnual.reportDate='2025-04-30';late.latestAnnual.filingDate='2025-07-03';assert.equal(p.reportingStatus(late,'2026-10-03'),'recent_annual');
    late.latestAnnual.filingDate='2025-07-02';assert.equal(p.reportingStatus(late,'2026-10-03'),'no_recent_annual');
    const old=evidence();old.latestAnnual.reportDate='2025-04-02';old.latestAnnual.filingDate='2025-09-01';assert.equal(p.reportingStatus(old,'2026-10-03'),'no_recent_annual');
    e.lastSuccessfulCheckAt='2026-08-01';assert.equal(p.reportingStatus(e,'2026-10-03'),'unverified');
});
test('amendments never reset the original filing date and annual selection uses report period',()=>{
    const filings=[annual,{...annual,form:'10-K/A',filingDate:'2026-10-02',accessionNumber:'0000000123-26-000002'},{...annual,filingDate:'2026-10-01',reportDate:'2023-06-30'}];
    const selected=p.selectAnnual(filings,'2026-10-03');assert.equal(selected.reportDate,'2025-06-30');assert.equal(selected.filingDate,'2025-10-03');assert.equal(selected.amendments.length,1);
    assert.equal(p.selectAnnual(filings.filter(f=>f.form==='10-K/A'),'2026-10-03'),null);
});
test('foreign annual forms qualify, future and obsolete periods do not',()=>{
    for(const form of ['20-F','40-F']){const e=evidence();e.latestAnnual.form=form;assert.equal(p.reportingStatus(e,'2026-10-03'),'recent_annual');}
    for(const form of ['8-K','6-K','10-Q','NT 10-K']){const e=evidence();e.latestAnnual.form=form;assert.equal(p.reportingStatus(e,'2026-10-03'),'unverified');}
    const e=evidence();e.latestAnnual.reportDate='2023-06-30';assert.equal(p.reportingStatus(e,'2026-10-03'),'no_recent_annual');e.latestAnnual.reportDate='2027-01-01';assert.equal(p.reportingStatus(e,'2026-10-03'),'unverified');
});
test('ready requires every core field with exact fact provenance, including reported zero',()=>{
    const d=financial(),e=evidence();assert.equal(p.classify(e,d,'2026-10-03').financialCoverage,'ready');
    for(const [st,f] of [['income','netIncome'],['income','totalRevenue'],['balance','totalAssets'],['balance','totalShareholderEquity'],['cash','operatingCashflow']]){const copy=structuredClone(d);copy[st].annualReports[0][f]=null;assert.equal(p.classify(e,copy,'2026-10-03').financialCoverage,'partial');}
    d.income.annualReports[0].netIncome=-5;d.sources.netIncome.rawValue=-5;assert.equal(p.classify(e,d,'2026-10-03').financialCoverage,'ready');
    d.sources.netIncome.linkage='filing_period';assert.equal(p.classify(e,d,'2026-10-03').financialCoverage,'partial');
});
test('old evidence preserves historical facts and issuer identity cannot be borrowed',()=>{
    const e=evidence(),d=financial();e.lastSuccessfulCheckAt='2026-01-01';assert.equal(p.classify(e,d,'2026-10-03').financialCoverage,'historical_only');d.cik='0000000456';assert.equal(p.classify(e,d,'2026-10-03').financialCoverage,'unavailable');
});
test('counts deduplicate stock classes and exclude secondary securities from issuer count',()=>{
    const securities=[{symbol:'A',securityType:'stock',cik:'0000000123',screenable:true},{symbol:'B',securityType:'stock',cik:'0000000123',screenable:true},{symbol:'U',securityType:'unit',cik:'0000000456'},{symbol:'NEW',securityType:'stock'}];
    const c=p.count(securities,{'0000000123':{annualReportingStatus:'recent_annual',financialCoverage:'ready'}});assert.equal(c.listedSecurities,4);assert.equal(c.identifiedIssuers,1);assert.equal(c.financialReadyIssuers,1);assert.equal(c.screenableListings,2);assert.equal(c.screenableIssuers,1);
});
module.exports={financial,evidence};
test('a run crossing UTC midnight keeps its filing cutoff separate from its actual retrieval date',()=>{
 const e=evidence();e.lastSuccessfulCheckAt=new Date().toISOString();assert.equal(p.reportingStatus(e,'2026-10-03'),'recent_annual');
 e.lastSuccessfulCheckAt=new Date(Date.now()+86400000).toISOString();assert.equal(p.reportingStatus(e,'2026-10-03'),'unverified');
 e.lastSuccessfulCheckAt=new Date().toISOString();e.latestAnnual.filingDate='2026-10-04';assert.equal(p.reportingStatus(e,'2026-10-03'),'unverified');
});
