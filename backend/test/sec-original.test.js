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

// Clorox's FY2026 10-K: the primary document is a cover page that declares the
// periods and units; the statements sit in a second document that only refers to them.
test('a second document reads its figures against the periods declared in the first',()=>{
 const {parseOriginal}=require('../sec-original');
 const filing={form:'10-K',filingDate:'2026-08-07',accessionNumber:'0000000123-26-000001',documentUrl:'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/a.htm'};
 const header='<ix:header><ix:resources><xbrli:context id="c1"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000123</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-07-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit></ix:resources></ix:header>';
 const body='<ix:nonFraction name="us-gaap:Revenues" contextRef="c1" unitRef="usd" scale="6" decimals="-6" format="ixt:num-dot-decimal">6,720</ix:nonFraction>';
 assert.deepEqual(parseOriginal('<html>'+body+'</html>',filing,'123').facts,{});
 const shared={contexts:new Map(),units:new Map()};
 assert.deepEqual(parseOriginal('<html>'+header+'</html>',filing,'123',shared).facts,{});
 const second=parseOriginal('<html>'+body+'</html>',{...filing,documentUrl:filing.documentUrl.replace('a.htm','a_d2.htm')},'123',shared);
 assert.equal(second.facts['us-gaap'].Revenues.units.USD[0].val,6720000000);
 assert.match(second.facts['us-gaap'].Revenues.units.USD[0]._original.documentUrl,/a_d2\.htm$/);
});

// Tanger's FY2025 10-K covers Tanger Inc. and its operating partnership and tags both sets of
// statements with a legal-entity member; SEC's facts feed drops them all, so the page was blank.
test('a combined filing reads the registrant\'s own legal-entity member and never the co-registrant\'s',()=>{
 const filing={accessionNumber:ACC,form:'10-K',filingDate:'2026-02-01',documentUrl:'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/a.htm'};
 const ctx=(id,member)=>`<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000123</xbrli:identifier>${member?`<xbrli:segment><xbrldi:explicitMember dimension="dei:LegalEntityAxis">${member}</xbrldi:explicitMember></xbrli:segment>`:''}</xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>`;
 const head=ctx('c0')+ctx('own','x:ParentMember')+ctx('op','x:PartnershipMember')+'<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>';
 const cover=b=>`<ix:nonNumeric name="dei:EntityCentralIndexKey" contextRef="c0">0000000123</ix:nonNumeric>`+(b?`<ix:nonNumeric name="dei:EntityCentralIndexKey" contextRef="op">0000000456</ix:nonNumeric>`:'');
 const rev=(c,v)=>`<ix:nonFraction name="us-gaap:Revenues" contextRef="${c}" unitRef="usd" decimals="0">${v}</ix:nonFraction>`;
 const vals=t=>(parseOriginal('<html>'+t+'</html>',filing,CIK).facts['us-gaap']?.Revenues?.units.USD || []).map(f=>f.val);
 assert.deepEqual(vals(head+cover(true)+rev('own',10)+rev('op',11)),[10]);
 // the plain context carries statements of its own: the members stay segment detail
 assert.deepEqual(vals(head+cover(true)+rev('c0',9)+rev('own',10)+rev('op',11)),[9]);
 // with no co-registrant bound to another CIK, nothing says which member is the registrant
 assert.deepEqual(vals(head+cover(false)+rev('own',10)+rev('op',11)),[]);
});

// Proficient Auto Logistics' FY2025 10-K shows predecessor and successor columns and tags the whole
// income and cash-flow statements with a SuccessorMember; its plain context holds only note figures
// (depreciation of $88K beside $39.3M on the statement), which the page showed as the statements.
test('a successor column is the registrant\'s statements for a year the plain context has no revenue or cash flow for',()=>{
 const filing={accessionNumber:ACC,form:'10-K',filingDate:'2026-02-01',documentUrl:'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/a.htm'};
 const ctx=(id,member,start='2025-01-01')=>`<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000123</xbrli:identifier>${member?`<xbrli:segment><xbrldi:explicitMember dimension="us-gaap:FreshStartAdjustmentsTypeOfFreshStartAdjustmentAxis">${member}</xbrldi:explicitMember></xbrli:segment>`:''}</xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>`;
 const head=ctx('c0')+ctx('s','x:SuccessorMember')+ctx('p','x:PredecessorMember','2025-06-01')+'<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>';
 const fact=(name,c,v)=>`<ix:nonFraction name="us-gaap:${name}" contextRef="${c}" unitRef="usd" decimals="0">${v}</ix:nonFraction>`;
 const vals=(t,name)=>(parseOriginal('<html>'+t+'</html>',filing,CIK).facts['us-gaap']?.[name]?.units.USD || []).map(f=>f.val);
 const body=fact('Revenues','s',430)+fact('DepreciationAndAmortization','s',39)+fact('DepreciationAndAmortization','c0',1)+fact('IncomeTaxExpenseBenefit','c0',7)+fact('Revenues','p',41);
 assert.deepEqual(vals(head+body,'Revenues'),[430]);
 // the statement's figure replaces the note's, and a figure only the notes carry stays
 assert.deepEqual(vals(head+body,'DepreciationAndAmortization'),[39]);
 assert.deepEqual(vals(head+body,'IncomeTaxExpenseBenefit'),[7]);
 // with revenue on the plain context, the successor column stays detail
 assert.deepEqual(vals(head+body+fact('Revenues','c0',400),'Revenues'),[400]);
 // without a predecessor column, a member named Successor is not a predecessor/successor presentation
 assert.deepEqual(vals(head.replace(ctx('p','x:PredecessorMember','2025-06-01'),'')+body.replace(fact('Revenues','p',41),''),'Revenues'),[]);
});

// Cadrenal's FY2025 10-K tags its net loss twice on the year's context: -13,237,362 on the
// statement and -13,200,000 ("$13.2 million", decimals -5) in the discussion. A rounded copy of
// the same figure is the same fact, as in SEC's facts feed; a copy that does not round to it stays.
test('a rounded duplicate of a filed figure is the same fact, and a figure that does not round to it still conflicts',()=>{
 const filing={accessionNumber:ACC,form:'10-K',filingDate:'2026-02-01',documentUrl:'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/a.htm'};
 const head='<xbrli:context id="c0"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000123</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>';
 const ni=(v,d,scale='')=>`<ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="c0" unitRef="usd" decimals="${d}"${scale?` scale="${scale}"`:''} sign="-">${v}</ix:nonFraction>`;
 const vals=t=>parseOriginal('<html>'+head+t+'</html>',filing,CIK).facts['us-gaap'].NetIncomeLoss.units.USD.map(f=>f.val);
 assert.deepEqual(vals(ni('13,237,362',0)+ni('13.2',-5,6)+ni('13,237,362',0)),[-13237362,-13237362]);
 assert.deepEqual(vals(ni('13,237,362',0)+ni('13.3',-5,6)),[-13237362,-13300000]);
});
