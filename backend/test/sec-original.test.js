'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseOriginal,mergeFacts}=require('../sec-original'),{extract}=require('../sec-facts'),p=require('../sec-coverage');
const {fixture,CIK,ACC}=require('./fixtures/sec-fixture');
test('inline facts retain context, signed scale, unit and original document provenance',()=>{
 const filing={documentUrl:'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/report.htm',accessionNumber:ACC,form:'10-K',filingDate:'2026-02-01'};
 const text='<html><xbrli:context id="a"><xbrli:entity><xbrli:identifier scheme="https://www.sec.gov/CIK">123</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><ix:nonFraction name="us-gaap:Revenues" contextRef="a" unitRef="usd" scale="6" sign="-" format="ixt:num-dot-decimal" decimals="-6"><span>1,234</span></ix:nonFraction></html>';
 const original=parseOriginal(text,filing,CIK);assert.equal(original.facts['us-gaap'].Revenues.units.USD[0].val,-1234000000);
 const {doc,evidence}=fixture();const data=extract(mergeFacts(doc,original),evidence,{asOf:'2026-10-04'});assert.equal(data.income.annualReports[0].totalRevenue,-1234000000);const source=data.sources[data.income.annualReports[0]._sources.totalRevenue[0]];assert.equal(source.originalDocument.documentUrl,filing.documentUrl);assert.equal(source.verificationMethod,'original_inline_xbrl');assert.deepEqual(p.validateFinancial(data,CIK),[]);
 assert.equal(Object.keys(parseOriginal(text,filing,'0000000456').facts).length,0);
});
test('real TSM 20-F restores native-currency current financial history using original facts',()=>{
 const fixture=require('./fixtures/sec-original/TSM.json'),original=require('./fixtures/sec-original/TSM-inline.json').original;
 const data=extract(mergeFacts(fixture.facts,original),{...fixture.evidence,reportingCurrency:original.reportingCurrency},{asOf:'2026-10-04'});
 assert.equal(original.reportingCurrency,'TWD');assert.ok(data.income.annualReports.some(r=>r.fiscalDateEnding==='2025-12-31'));assert.equal(data.income.annualReports[0].reportedCurrency,'TWD');assert.deepEqual(p.validateFinancial(data,fixture.evidence.cik),[]);
});
test('unknown inline transformation, nil values and segment contexts do not become entity facts',()=>{
 const filing={accessionNumber:ACC,form:'10-K',filingDate:'2026-02-01'};
 const text='<context id="a"><entity><identifier>123</identifier><segment><explicitMember dimension="x:CountryAxis">x:USMember</explicitMember></segment></entity><period><startDate>2025-01-01</startDate><endDate>2025-12-31</endDate></period></context><unit id="usd"><measure>iso4217:USD</measure></unit><ix:nonFraction name="us-gaap:Revenues" contextRef="a" unitRef="usd">12</ix:nonFraction>';
 assert.deepEqual(parseOriginal(text,filing,CIK).facts,{});
});
