'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDirectory, buildUniverse, securityType } = require('../../scripts/lib/us-listings');
const { withIdentity, hasStatements, usable } = require('../stock-universe');
const nasdaq = 'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\nNEW|New Issuer - Ordinary Shares|S|N|N|100|N|N\nADR|Foreign Issuer - American Depositary Shares|G|N|N|100|N|N\nETF|Index ETF|G|N|N|100|Y|N\nTEST|Test stock|Q|Y|N|100|N|N\nFile Creation Time: 1003202610:00|||||||';
const other = 'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\nBRK.B|Berkshire Class B Common Stock|N|BRK.B|N|100|N|BRK.B\nSMALL|Small Company Common Stock|A|SMALL|N|100|N|SMALL\nARCA|Arca Company Common Stock|P|ARCA|N|100|N|ARCA\nBAC$E|Bank depositary Sh Perp Pfd Ser E|N|BACpE|N|100|N|BAC-E\nFile Creation Time: 1003202610:00|||||||';
const sec = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1067983, 'BERKSHIRE', 'BRK-B', 'NYSE']] };
test('exchange universe includes new issuers without CIK, ADRs, American and Arca listings', () => {
    const out = buildUniverse(nasdaq, other, sec, [{ symbol: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Financials' }], [{ symbol: 'OLD', name: 'Delisted' }]);
    assert.equal(out.count, 5);
    assert.deepEqual(new Set(out.companies.map((c) => c.symbol)), new Set(['NEW', 'ADR', 'BRK.B', 'SMALL', 'ARCA']));
    const brk = out.companies.find((c) => c.symbol === 'BRK.B');
    assert.equal(brk.cik, '0001067983');
    assert.equal(brk.name, 'Berkshire Hathaway');
    assert.equal(out.companies.find((c) => c.symbol === 'NEW').cik, undefined);
    assert.deepEqual(out.excluded, { etf: 1, test: 1, preferred: 1 });
});
test('incomplete or malformed directory input is rejected instead of shrinking coverage', () => {
    assert.throws(() => parseDirectory(nasdaq.replace(/File Creation Time:.*/, ''), 'nasdaq'), /Incomplete/);
    assert.throws(() => parseDirectory('<html>Denied</html>', 'nasdaq'), /missing/);
    assert.throws(() => parseDirectory(nasdaq.replace('NEW|New Issuer', 'NEW|extra|New Issuer'), 'nasdaq'), /Malformed/);
});
test('universe release validation requires an explicit outcome and provenance for every source row',()=>{
 const out=buildUniverse(nasdaq,other,sec),validate=require('../../scripts/lib/us-listings').validateManifest;
 out.manifest.sources.push({directory:'sec_issuer_identity',url:'https://www.sec.gov/files/company_tickers_exchange.json',retrievedAt:new Date().toISOString(),sha256:'a'.repeat(64)});
 assert.deepEqual(validate(out.manifest,out.companies),[]);
 const broken=structuredClone(out.manifest);broken.outcomes[0].decision='exclude';assert.ok(validate(broken,out.companies).some(e=>e.includes('classification outcome')));
 broken.outcomes.pop();assert.ok(validate(broken,out.companies).some(e=>e.includes('incomplete')));
});
test('punctuated warrants cannot inherit the CIK or fund classification of a different ticker',()=>{
 const extra=other.replace('File Creation Time:','NE.A|Noble Corporation plc Tranche 2 Warrants|N|NE.A|N|100|N|NE.A\nNEA|Nuveen Fund Common Shares of Beneficial Interest|N|NEA|N|100|N|NEA\nFile Creation Time:');
 const identities={fields:sec.fields,data:[...sec.data,[1195737,'Nuveen','NEA','NYSE']]};
 const out=buildUniverse(nasdaq,extra,identities,[],[{symbol:'NEA',name:'Nuveen'}],{NEA:{confirmedFund:true}});
 assert.equal(out.companies.find(c=>c.symbol==='NEA').cik,'0001195737');assert.equal(out.companies.find(c=>c.symbol==='NEA').securityType,'closed_end_fund');assert.equal(out.companies.some(c=>c.symbol==='NE.A'),false);assert.equal(out.manifest.outcomes.find(c=>c.symbol==='NE.A').classification,'warrant');
});
test('non-stock instruments are classified without excluding ordinary REIT or ADR shares', () => {
    for (const [name, expected] of [['Acme - Warrants', 'warrant'], ['Acme - Rights', 'right'], ['Acme - Units', 'unit'], ['Acme 6% Notes due 2030', 'debt'], ['Acme Preferred Stock', 'preferred'], ['Real Estate Trust Common Stock', 'stock'], ['Foreign American Depositary Shares', 'stock']]) {
        assert.equal(securityType({ symbol: 'XYZ', name }), expected);
    }
});
test('singular units, contingent rights and partnership equity have distinct types', () => {
    for (const [name, expected] of [['Acquisition Corp - Unit','unit'], ['Acquisition Corp - Right','right'], ['Gen Digital - Contingent Value Rights','right'], ['Amplitech - Series B Right','right'], ['Energy Transfer Common Units representing limited partner interests','stock']]) assert.equal(securityType({symbol:'X',name}),expected);
    const input = nasdaq.replace('NEW|New Issuer - Ordinary Shares','NEW|New Issuer - Unit');
    assert.equal(buildUniverse(input,other,sec,[],[]).companies.some(c=>c.symbol==='NEW'),false);
    assert.equal(buildUniverse(input,other,sec,[],[{symbol:'NEW'}]).companies.find(c=>c.symbol==='NEW').securityType,'unit');
});
test('listing identity repairs a usable SEC payload without inventing financial fields or freshness', () => {
    const original = { overview: {}, income: { annualReports: [{ fiscalDateEnding: '2025-12-31', totalRevenue: '0' }] } };
    const result = withIdentity(original, { symbol: 'XYZ', name: 'Example', cik: 123, exchange: 'NYSE' });
    assert.ok(usable(result));
    assert.deepEqual(original.overview, {});
    assert.equal(result.overview.Symbol, 'XYZ');
    assert.equal(result.overview.PERatio, undefined);
    assert.equal(result.fetchedAt, undefined);
    assert.equal(result.income, original.income);
    assert.throws(() => withIdentity({ overview: { Symbol: 'OTHER' } }, { symbol: 'XYZ' }), /does not match/);
});
test('placeholder files and period labels alone do not count as covered fundamentals', () => {
    assert.equal(usable({}), false);
    assert.equal(hasStatements({ income: { annualReports: [{ fiscalDateEnding: '2025-12-31', totalRevenue: '', fy: 2025 }] } }), false);
    assert.equal(usable({ overview: { Symbol: 'XYZ', Name: 'Example' }, income: { annualReports: [] } }), false);
});
