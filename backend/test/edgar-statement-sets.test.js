'use strict';
const test=require('node:test'),assert=require('node:assert');
const {monthEnd,buildFiling}=require('../../scripts/build-edgar-statement-sets');
const {assignStatements}=require('../../scripts/lib/edgar-statements');

test('dates are the nearest month end, as in SEC\'s data sets',()=>{
 assert.strictEqual(monthEnd('2026-09-27'),'20260930');
 assert.strictEqual(monthEnd('2026-10-03'),'20260930');
 assert.strictEqual(monthEnd('2026-10-20'),'20261031');
 assert.strictEqual(monthEnd('2024-02-29'),'20240229');
});

test('statements by role title, the first of each kind (SEC\'s 2026_10_notes classification)',()=>{
 const got=assignStatements([
  '0000001 - Document - Cover',
  '9952151 - Statement - Condensed Consolidated Balance Sheets',
  '9952152 - Statement - Condensed Consolidated Balance Sheets (Parenthetical)',
  '9952153 - Statement - Consolidated Statements of Comprehensive Income',
  '9952154 - Statement - Consolidated Statements of Changes in Stockholders\' Equity',
  '9952155 - Statement - Consolidated Statements of Cash Flows',
  '9952156 - Statement - Balance Sheets - Subsidiary Co',
  '9952157 - Disclosure - Debt',
 ]).map(x=>x.stmt+x.inpth);
 // A statement of comprehensive income is the income statement where there is no other; a co-registrant's second
 // balance sheet is unclassified.
 assert.deepStrictEqual(got,['0','BS0','BS1','IS0','EQ0','CF0','UN0','0']);
 assert.deepStrictEqual(assignStatements(['1 - Statement - Statements of Operations','2 - Statement - Statements of Comprehensive Income']).map(x=>x.stmt),['IS','CI']);
});

const ADSH='0000000001-26-000001';
const xsd=`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xbrli="http://www.xbrl.org/2003/instance">
 <xs:annotation><xs:appinfo>
  <link:roleType roleURI="http://co/role/BS" id="BS"><link:definition>9952151 - Statement - Consolidated Balance Sheets</link:definition><link:usedOn>link:presentationLink</link:usedOn></link:roleType>
  <link:roleType roleURI="http://co/role/IS" id="IS"><link:definition>9952153 - Statement - Consolidated Statements of Operations</link:definition><link:usedOn>link:presentationLink</link:usedOn></link:roleType>
 </xs:appinfo></xs:annotation>
 <xs:element id="co_TermLoan" name="TermLoan" xbrli:balance="credit" xbrli:periodType="instant"/>
</xs:schema>`;
const G='https://xbrl.fasb.org/us-gaap/2026/elts/us-gaap-2026.xsd#us-gaap_';
const pre=`<link:linkbase xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink">
 <link:presentationLink xlink:role="http://co/role/BS">
  <link:loc xlink:label="a" xlink:href="${G}StatementOfFinancialPositionAbstract"/>
  <link:loc xlink:label="b" xlink:href="${G}Assets"/>
  <link:loc xlink:label="c" xlink:href="co-20260927.xsd#co_TermLoan"/>
  <link:loc xlink:label="d" xlink:href="${G}DeferredRevenueNoncurrent"/>
  <link:loc xlink:label="e" xlink:href="${G}StockholdersEquity"/>
  <link:presentationArc xlink:from="a" xlink:to="c" order="2" preferredLabel="http://www.xbrl.org/2003/role/terseLabel"/>
  <link:presentationArc xlink:from="a" xlink:to="b" order="1" preferredLabel="http://www.xbrl.org/2003/role/totalLabel"/>
  <link:presentationArc xlink:from="a" xlink:to="d" order="3"/>
  <link:presentationArc xlink:from="a" xlink:to="e" order="4"/>
 </link:presentationLink>
 <link:presentationLink xlink:role="http://co/role/IS">
  <link:loc xlink:label="x" xlink:href="${G}IncomeStatementAbstract"/>
  <link:loc xlink:label="y" xlink:href="${G}EarningsPerShareDiluted"/>
  <link:presentationArc xlink:from="x" xlink:to="y" order="1"/>
 </link:presentationLink>
</link:linkbase>`;
const lab=`<link:linkbase xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"><link:labelLink>
 <link:loc xlink:label="lb" xlink:href="${G}Assets"/><link:label xlink:label="Lb" xlink:role="http://www.xbrl.org/2003/role/totalLabel" xml:lang="en-US">Total non&#8209;current assets</link:label><link:labelArc xlink:from="lb" xlink:to="Lb"/>
 <link:loc xlink:label="lc" xlink:href="co-20260927.xsd#co_TermLoan"/><link:label xlink:label="Lc" xlink:role="http://www.xbrl.org/2003/role/terseLabel" xml:lang="en-US">Term loan – net</link:label><link:labelArc xlink:from="lc" xlink:to="Lc"/>
 <link:loc xlink:label="le" xlink:href="${G}StockholdersEquity"/><link:label xlink:label="Le" xlink:role="http://www.xbrl.org/2003/role/label" xml:lang="en-US">Total shareholders’ equity</link:label><link:labelArc xlink:from="le" xlink:to="Le"/>
</link:labelLink></link:linkbase>`;
const ctx=(id,period,dims='')=>`<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier>${dims?`<xbrli:segment>${dims}</xbrli:segment>`:''}</xbrli:entity><xbrli:period>${period}</xbrli:period></xbrli:context>`;
const htm=`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:co="http://co.example/20260927" xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance"><body>
<ix:header><ix:resources>
 ${ctx('d','<xbrli:startDate>2026-06-29</xbrli:startDate><xbrli:endDate>2026-09-27</xbrli:endDate>')}
 ${ctx('i','<xbrli:instant>2026-09-27</xbrli:instant>')}
 ${ctx('p','<xbrli:instant>2025-12-28</xbrli:instant>')}
 ${ctx('dA','<xbrli:startDate>2026-06-29</xbrli:startDate><xbrli:endDate>2026-09-27</xbrli:endDate>','<xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClassAMember</xbrldi:explicitMember>')}
 ${ctx('iL','<xbrli:instant>2026-09-27</xbrli:instant>','<xbrldi:explicitMember dimension="dei:LegalEntityAxis">co:SubsidiaryCoMember</xbrldi:explicitMember>')}
 <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
 <xbrli:unit id="eps"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>
</ix:resources></ix:header>
<ix:nonNumeric name="dei:DocumentPeriodEndDate" contextRef="d">September 27, 2026</ix:nonNumeric>
<ix:nonFraction name="us-gaap:Assets" contextRef="i" unitRef="usd" decimals="-6" scale="6" format="ixt:num-dot-decimal">1,234</ix:nonFraction>
<ix:nonFraction name="us-gaap:Assets" contextRef="i" unitRef="usd" decimals="-8" scale="9" format="ixt:num-dot-decimal">1.2</ix:nonFraction>
<ix:nonFraction name="us-gaap:Assets" contextRef="p" unitRef="usd" decimals="-6" scale="6" format="ixt:num-dot-decimal">1&#160;100</ix:nonFraction>
<ix:nonFraction name="us-gaap:Assets" contextRef="iL" unitRef="usd" decimals="-6" scale="6" format="ixt:num-dot-decimal">400</ix:nonFraction>
<ix:nonFraction name="co:TermLoan" contextRef="i" unitRef="usd" decimals="-6" scale="6" format="ixt:num-dot-decimal">250</ix:nonFraction>
<ix:nonFraction name="us-gaap:StockholdersEquity" contextRef="i" unitRef="usd" xs:nil="true"/>
<ix:nonFraction name="us-gaap:EarningsPerShareDiluted" contextRef="d" unitRef="eps" decimals="2" format="ixt:num-dot-decimal">1.47</ix:nonFraction>
<ix:nonFraction name="us-gaap:EarningsPerShareDiluted" contextRef="dA" unitRef="eps" decimals="2" format="ixt:num-dot-decimal" sign="-">0.10</ix:nonFraction>
</body></html>`;

test('a filing\'s statements written as SEC\'s notes data set rows',()=>{
 const files=new Map([['co-20260927.htm',htm],['co-20260927.xsd',xsd],['co-20260927_pre.xml',pre],['co-20260927_lab.xml',lab]]);
 const set=buildFiling(files,{accession:ADSH,cik:'0000000001',form:'10-Q',filed:'2026-10-30'},'3571');
 assert.deepStrictEqual(set.sub,[ADSH,1,'3571','10-Q','20260930','20261030']);
 // In presentation order, preferred labels in ASCII; a line with no fact in the filing is not a row.
 assert.deepStrictEqual(set.pre.map(r=>[r[3],r[5],r[6],r[7]]),[
  ['BS','Assets','us-gaap/2026','Total non-current assets'],
  ['BS','TermLoan',ADSH,'Term loan  net'],
  ['BS','StockholdersEquity','us-gaap/2026','Total shareholders equity'],
  ['IS','EarningsPerShareDiluted','us-gaap/2026',''],
 ]);
 assert.ok(set.pre[0][2]<set.pre[1][2]);
 assert.deepStrictEqual(set.tags.get('TermLoan|'+ADSH),{tag:'TermLoan',version:ADSH,custom:1,crdr:'C',tlabel:'Term loan  net'});
 const num=set.num.map(r=>r.slice(1).join('|')).sort();
 assert.deepStrictEqual(num,[
  // The statement's figure and the discussion's rounded one both stay; the earlier balance reads 1 100.
  'Assets|us-gaap/2026|20251231|0|USD||1100000000|',
  'Assets|us-gaap/2026|20260930|0|USD|LegalEntity=SubsidiaryCo;|400000000|SubsidiaryCo',
  'Assets|us-gaap/2026|20260930|0|USD||1200000000|',
  'Assets|us-gaap/2026|20260930|0|USD||1234000000|',
  'EarningsPerShareDiluted|us-gaap/2026|20260930|1|USD|ClassOfStock=CommonClassA;|-0.1|',
  'EarningsPerShareDiluted|us-gaap/2026|20260930|1|USD||1.47|',
  'StockholdersEquity|us-gaap/2026|20260930|0|USD|||',
  `TermLoan|${ADSH}|20260930|0|USD||250000000|`,
 ]);
});
