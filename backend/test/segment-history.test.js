'use strict';
// Segment history for the company page's "Product segments" view (sec-segment-history.js): every year
// and quarter the filings tag, each column from the newest filing that reports it, one measure across
// the years, a fourth quarter calculated from the year and its nine months and marked so.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const H = require('../sec-segment-history');

const AX = 'us-gaap:StatementBusinessSegmentsAxis';
const year = (y) => [`${y}-01-01`, `${y}-12-31`];
// Compact rows as filingFacts writes them: [concept, axis, member, start, end, value, context, extraDims, unit]
const seg = (concept, member, [start, end], value) => [concept, AX, member, start, end, value, concept + member + end, 0, 'USD'];
const tot = (concept, [start, end], value) => [concept, '', '', start, end, value, concept + end, 0, 'USD'];
const filing = (accession, form, filed, reportDate, facts, labels = {}) => ({ accession, form, filed, reportDate, url: 'https://www.sec.gov/' + accession, instanceUrl: 'https://www.sec.gov/' + accession + '.xml', facts, labels });
const twoSegments = (concept, period, a, b) => [seg(concept, 'x:AMember', period, a), seg(concept, 'x:BMember', period, b), tot(concept, period, a + b)];

test('an instance is read by namespace, whatever prefix the filer chose, and the consolidation view is stripped', () => {
  const ctx = (id, dims) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000012345</xbrli:identifier>${dims ? `<xbrli:segment>${dims}</xbrli:segment>` : ''}</xbrli:entity><xbrli:period><xbrli:startDate>2010-01-01</xbrli:startDate><xbrli:endDate>2010-12-31</xbrli:endDate></xbrli:period></xbrli:context>`;
  const xml = `<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:gaap="http://fasb.org/us-gaap/2009-01-31" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:abc="http://abc.example/2010">
  ${ctx('c0', '')}${ctx('c1', '<xbrldi:explicitMember dimension="gaap:StatementBusinessSegmentsAxis">abc:RetailMember</xbrldi:explicitMember><xbrldi:explicitMember dimension="gaap:ConsolidationItemsAxis">gaap:OperatingSegmentsMember</xbrldi:explicitMember>')}
  ${ctx('c2', '<xbrldi:explicitMember dimension="gaap:StatementBusinessSegmentsAxis">abc:CardMember</xbrldi:explicitMember>')}
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  <gaap:Revenues contextRef="c0" unitRef="usd" decimals="-6">1000000000</gaap:Revenues>
  <gaap:Revenues contextRef="c1" unitRef="usd" decimals="-6">700000000</gaap:Revenues>
  <abc:SegmentReportingInformationNetRevenue contextRef="c2" unitRef="usd" decimals="-6">300000000</abc:SegmentReportingInformationNetRevenue>
  <gaap:Revenues contextRef="c2" unitRef="usd" xsi:nil="true"/>
  </xbrli:xbrl>`;
  const rows = H.filingFacts(xml, '12345');
  assert.deepEqual(rows.find((r) => !r[1]), ['us-gaap:Revenues', '', '', '2010-01-01', '2010-12-31', 1000000000, 'c0', 0, 'USD']);
  assert.deepEqual(rows.find((r) => r[2] === 'abc:RetailMember'), ['us-gaap:Revenues', AX, 'abc:RetailMember', '2010-01-01', '2010-12-31', 700000000, 'c1', 1, 'USD']);
  assert.equal(rows.find((r) => r[2] === 'abc:CardMember')[0], 'abc:SegmentReportingInformationNetRevenue', 'a bank\'s own net-revenue concept is kept');
  assert.equal(rows.length, 3, 'a nil fact is not a figure');
  assert.deepEqual(H.filingFacts(xml, '99999'), [], 'another issuer\'s facts are never read');
});

// AMD's 10-K for FY2014 files every segment as SalesRevenueGoodsNet (the pre-2018 concept), and its total
// both as that and as SalesRevenueNet.
test('goods sales before the 2018 taxonomy are revenue only where their total is the filing\'s revenue', () => {
  const ctx = (id, member) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000002488</xbrli:identifier>${member ? `<xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">${member}</xbrldi:explicitMember></xbrli:segment>` : ''}</xbrli:entity><xbrli:period><xbrli:startDate>2013-12-29</xbrli:startDate><xbrli:endDate>2014-12-27</xbrli:endDate></xbrli:period></xbrli:context>`;
  const xml = (extra) => `<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2014-01-31" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:amd="http://www.amd.com/20141227">
  ${ctx('t', '')}${ctx('cg', 'amd:ComputingandGraphicsMember')}${ctx('ee', 'amd:EnterpriseEmbeddedandSemiCustomMember')}
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  <us-gaap:SalesRevenueGoodsNet contextRef="t" unitRef="usd" decimals="-6">5506000000</us-gaap:SalesRevenueGoodsNet>
  <us-gaap:SalesRevenueGoodsNet contextRef="cg" unitRef="usd" decimals="-6">3132000000</us-gaap:SalesRevenueGoodsNet>
  <us-gaap:SalesRevenueGoodsNet contextRef="ee" unitRef="usd" decimals="-6">2374000000</us-gaap:SalesRevenueGoodsNet>${extra}
  </xbrli:xbrl>`;
  const alone = H.filingFacts(xml(''), '2488');
  assert.equal(alone.length, 3, 'the sole total and both segments are read');
  const cands = H.columnCandidates({ facts: alone }, 'us-gaap:StatementBusinessSegmentsAxis', '2013-12-29', '2014-12-27');
  assert.equal(cands[0].total, 5506000000); assert.equal(cands[0].rows.length, 2);
  assert.equal(H.measureClass('us-gaap:SalesRevenueGoodsNet'), H.measureClass('us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax'), 'one measure across the 2018 recast');
  const net = (v) => `<us-gaap:SalesRevenueNet contextRef="t" unitRef="usd" decimals="-6">${v}</us-gaap:SalesRevenueNet>`;
  assert.equal(H.filingFacts(xml(net(5506000000)), '2488').length, 4, 'equal to the filed revenue total (AMD): read');
  const beside = H.filingFacts(xml(net(6000000000)), '2488');
  assert.deepEqual(beside.map((r) => r[0]), ['us-gaap:SalesRevenueNet'], 'less than the revenue total, goods sales are a part of it');
  const both = H.filingFacts(xml('<us-gaap:SalesRevenueServicesNet contextRef="t" unitRef="usd" decimals="-6">494000000</us-gaap:SalesRevenueServicesNet>'), '2488');
  assert.deepEqual(both, [], 'goods beside services: neither is the whole');
});

// Progressive FY2025: every segment's net premiums earned also carries ProductOrServiceAxis "Underwriting operations".
test('a premium table whose rows all share one product member is read on the segment axis; a product split is not', () => {
  const dim = (a, m) => `<xbrldi:explicitMember dimension="${a}">${m}</xbrldi:explicitMember>`;
  const ctx = (id, member, product) => `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000012345</xbrli:identifier><xbrli:segment>${dim('srt:ConsolidationItemsAxis', 'us-gaap:OperatingSegmentsMember')}${dim('srt:ProductOrServiceAxis', product)}${dim('us-gaap:StatementBusinessSegmentsAxis', member)}</xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>`;
  const xml = `<?xml version="1.0"?><xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2025" xmlns:srt="http://fasb.org/srt/2025" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:x="http://x.example/2025">
  ${ctx('p', 'x:PersonalMember', 'x:UnderwritingMember')}${ctx('k', 'x:CommercialMember', 'x:UnderwritingMember')}${ctx('r', 'x:PersonalMember', 'x:RetailMember')}${ctx('w', 'x:CommercialMember', 'x:WholesaleMember')}
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  <us-gaap:PremiumsEarnedNet contextRef="p" unitRef="usd" decimals="-6">70000000</us-gaap:PremiumsEarnedNet>
  <us-gaap:PremiumsEarnedNet contextRef="k" unitRef="usd" decimals="-6">20000000</us-gaap:PremiumsEarnedNet>
  <us-gaap:Revenues contextRef="r" unitRef="usd" decimals="-6">60000000</us-gaap:Revenues>
  <us-gaap:Revenues contextRef="w" unitRef="usd" decimals="-6">30000000</us-gaap:Revenues>
  </xbrli:xbrl>`;
  assert.deepEqual(H.filingFacts(xml, '12345'), [
    ['us-gaap:PremiumsEarnedNet', AX, 'x:PersonalMember', '2025-01-01', '2025-12-31', 70000000, 'p', 2, 'USD'],
    ['us-gaap:PremiumsEarnedNet', AX, 'x:CommercialMember', '2025-01-01', '2025-12-31', 20000000, 'k', 2, 'USD']]);
});

test('each year comes from the newest filing that reports it, under one measure, with a renamed concept standing in', () => {
  const k2025 = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...twoSegments('us-gaap:Revenues', year(2025), 70, 30), ...twoSegments('us-gaap:Revenues', year(2024), 60, 25), ...twoSegments('us-gaap:Revenues', year(2023), 50, 20),
    seg('us-gaap:OperatingIncomeLoss', 'x:AMember', year(2025), 21), seg('us-gaap:OperatingIncomeLoss', 'x:BMember', year(2025), 6),
    ['us-gaap:Assets', AX, 'x:AMember', '', '2025-12-31', 500, 'a1', 0, 'USD'], ['us-gaap:Assets', AX, 'x:BMember', '', '2025-12-31', 100, 'a2', 0, 'USD']], { 'x:AMember': 'Alpha Banking (1)' });
  // The older report files 2023 before a recast, and 2021 under the bank's own concept.
  const k2023 = filing('k23', '10-K', '2024-02-01', '2023-12-31', [...twoSegments('us-gaap:Revenues', year(2023), 49, 21), ...twoSegments('us-gaap:Revenues', year(2022), 40, 20),
    seg('x:SegmentReportingInformationNetRevenue', 'x:AMember', year(2021), 30), seg('x:SegmentReportingInformationNetRevenue', 'x:BMember', year(2021), 15), tot('us-gaap:Revenues', year(2021), 45)]);
  const t = H.buildHistory([k2023, k2025], { axis: AX, currency: 'USD', preferConcept: 'us-gaap:Revenues', quarterFrom: '2025-01-01' });
  assert.deepEqual(t.years.map((y) => y.periodEnd.slice(0, 4)), ['2021', '2022', '2023', '2024', '2025']);
  assert.deepEqual(t.years.map((y) => y.accession), ['k23', 'k23', 'k25', 'k25', 'k25'], 'the recast 2023 is the newer report\'s');
  assert.equal(t.years[0].concept, 'x:SegmentReportingInformationNetRevenue');
  const a = t.rows.find((r) => r.name === 'Alpha Banking');
  assert.ok(a, 'a footnote marker on the filed label is not part of the name');
  assert.deepEqual(a.sales, [30, 40, 50, 60, 70]);
  assert.deepEqual(a.profit, [null, null, null, null, 21]);
  assert.deepEqual(a.assets, [null, null, null, null, 500]);
  assert.equal(t.profitMeasure, 'operating profit');
  assert.equal(t.measure, 'revenue');
});

test('premiums never stand in for revenue: a year filed only under another measure is left out', () => {
  const k25 = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...twoSegments('us-gaap:PremiumsEarnedNet', year(2025), 9, 4), ...twoSegments('us-gaap:PremiumsEarnedNet', year(2024), 8, 4), ...twoSegments('us-gaap:Revenues', year(2023), 12, 6)]);
  const t = H.buildHistory([k25], { axis: AX, currency: 'USD', preferConcept: 'us-gaap:PremiumsEarnedNet' });
  assert.deepEqual(t.years.map((y) => y.periodEnd.slice(0, 4)), ['2024', '2025']);
  assert.equal(t.measure, 'net premiums earned');
  assert.equal(H.measureClass('us-gaap:InterestIncomeExpenseNet+us-gaap:NoninterestIncome'), H.measureClass('us-gaap:RevenuesNetOfInterestExpense'));
  assert.notEqual(H.measureClass('us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax'), H.measureClass('us-gaap:Revenues'), 'a bank\'s fee revenue is not its net revenue');
});

test('outside finance Revenues is sales under its generic name, and a pre-2018 filing is read on the old axis name', () => {
  // 3M: SalesRevenueNet to FY2017, Revenues in the recasts, the ASC 606 concept from FY2018 — one measure.
  const k10 = filing('k10', '10-K', '2011-02-01', '2010-12-31', twoSegments('us-gaap:SalesRevenueNet', year(2010), 7, 3));
  const k25 = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...twoSegments('us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', year(2025), 9, 4), ...twoSegments('us-gaap:Revenues', year(2024), 8, 4), ...twoSegments('us-gaap:Revenues', year(2023), 8, 3)]);
  const lead = { axis: AX, currency: 'USD', preferConcept: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax' };
  assert.deepEqual(H.buildHistory([k10, k25], { ...lead, sic: '3841' }).years.map((y) => y.periodEnd.slice(0, 4)), ['2010', '2023', '2024', '2025']);
  // A bank keeps the rule: its fee revenue never stands in for net revenue, so the measures stay apart.
  assert.notDeepEqual(H.buildHistory([k10, k25], { ...lead, sic: '6022' }).years.map((y) => y.periodEnd.slice(0, 4)), ['2010', '2023', '2024', '2025']);
  // Apple's product lines: us-gaap:ProductOrServiceAxis to FY2015, srt: from FY2016.
  const P = 'srt:ProductOrServiceAxis', old = (f) => f[1] ? [f[0], 'us-gaap:ProductOrServiceAxis', ...f.slice(2)] : f, now = (f) => f[1] ? [f[0], P, ...f.slice(2)] : f;
  const k15 = filing('k15', '10-K', '2015-10-28', '2015-09-26', twoSegments('us-gaap:SalesRevenueNet', year(2015), 6, 2).map(old));
  // The changeover year tags both names; the table's own axis is read and the duplicate is not added to it.
  const k16 = filing('k16', '10-K', '2016-10-26', '2016-09-24', [...twoSegments('us-gaap:SalesRevenueNet', year(2016), 5, 2).map(now), ...twoSegments('us-gaap:SalesRevenueNet', year(2016), 5, 2).map(old).filter((f) => f[1])]);
  const t = H.buildHistory([k15, k16], { axis: P, currency: 'USD', preferConcept: 'us-gaap:SalesRevenueNet', sic: '3571' });
  assert.deepEqual(t.years.map((y) => y.periodEnd.slice(0, 4)), ['2015', '2016']);
  assert.deepEqual(t.rows.map((r) => r.sales), [[6, 5], [2, 2]]);
});

test('the fourth quarter is the year less its nine months as filed, and is marked calculated', () => {
  const q = (y, m1, m2) => [`${y}-${m1}`, `${y}-${m2}`];
  const k = filing('k25', '10-K', '2026-02-01', '2025-12-31', twoSegments('us-gaap:Revenues', year(2025), 70, 30));
  const q1 = filing('q1', '10-Q', '2025-05-01', '2025-03-31', twoSegments('us-gaap:Revenues', q(2025, '01-01', '03-31'), 16, 7));
  const q2 = filing('q2', '10-Q', '2025-08-01', '2025-06-30', twoSegments('us-gaap:Revenues', q(2025, '04-01', '06-30'), 18, 7));
  const q3 = filing('q3', '10-Q', '2025-11-01', '2025-09-30', [...twoSegments('us-gaap:Revenues', q(2025, '07-01', '09-30'), 18, 8), ...twoSegments('us-gaap:Revenues', q(2025, '01-01', '09-30'), 52, 22)]);
  const t = H.buildHistory([k, q1, q2, q3], { axis: AX, currency: 'USD', preferConcept: 'us-gaap:Revenues', quarterFrom: '2025-01-01' });
  const Q = t.quarterly;
  assert.deepEqual(Q.years.map((y) => [y.periodEnd, y.derived]), [['2025-03-31', false], ['2025-06-30', false], ['2025-09-30', false], ['2025-12-31', true]]);
  assert.deepEqual(Q.years[3].from, { year: 'k25', nineMonths: 'q3' });
  assert.equal(Q.years[3].totalRevenue, 26);
  assert.deepEqual(Q.rows.map((r) => r.sales), [[16, 18, 18, 18], [7, 7, 8, 8]]);
});

test('a single-segment company gets a one-row history; any other table still needs two rows', () => {
  const one = (period, v) => [seg('us-gaap:Revenues', 'rost:ReportableSegmentMember', period, v), tot('us-gaap:Revenues', period, v)];
  const k = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...one(year(2025), 90), ...one(year(2024), 80)], { 'rost:ReportableSegmentMember': 'Reportable Segment' });
  const lead = { axis: AX, currency: 'USD', preferConcept: 'us-gaap:Revenues', quarterFrom: '2025-01-01' };
  const t = H.buildHistory([k], { ...lead, single: true });
  assert.deepEqual(t.years.map((y) => y.periodEnd.slice(0, 4)), ['2024', '2025']);
  assert.deepEqual(t.rows.map((r) => [r.name, r.sales]), [['Single reportable segment', [80, 90]]]);
  assert.equal(H.buildHistory([k], lead).rows.length, 0, 'without the lead saying so, one row is not a table');
});

test('a stored history is read only at the builder\'s version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-hist-'));
  const prev = process.env.SEGMENT_HISTORY_DIR; process.env.SEGMENT_HISTORY_DIR = dir;
  delete require.cache[require.resolve('../sec-segment-history')];
  try {
    const S = require('../sec-segment-history');
    const table = { years: [{ periodEnd: '2025-12-31' }], rows: [{ name: 'A' }, { name: 'B' }] };
    fs.writeFileSync(path.join(dir, '0000012345.json'), JSON.stringify({ version: S.VERSION, table }));
    assert.deepEqual(S.load('12345').table, table);
    fs.writeFileSync(path.join(dir, '0000012345.json'), JSON.stringify({ version: 'old', table }));
    assert.equal(S.load('12345'), null);
    assert.equal(S.load('777'), null);
  } finally {
    if (prev === undefined) delete process.env.SEGMENT_HISTORY_DIR; else process.env.SEGMENT_HISTORY_DIR = prev;
    delete require.cache[require.resolve('../sec-segment-history')];
  }
});

// Asserted against the source, as test/api-access-gating.test.js does: the gate is easy to drop from a route.
const APP = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
test('the segment endpoint answers paid plans only, before it reads anything', () => {
  const route = APP.slice(APP.indexOf("app.get('/api/demo/alpha/segments/:symbol'"));
  assert.ok(route.length < APP.length, 'route exists');
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body.split('\n')[1], /if \(!subscriptionIsPaid\(req\.subscription\)\) return res\.status\(402\)/);
  assert.ok(APP.indexOf("app.use('/api/demo', authMiddleware") < APP.indexOf("app.get('/api/demo/alpha/segments/:symbol'"), 'signed-in check runs first');
  assert.match(fs.readFileSync(path.join(__dirname, '../company-evidence.js'), 'utf8'), /data\.segmentSummary=/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../company-evidence.js'), 'utf8'), /data\.segmentTable=/, 'the shared fundamentals payload carries no segment table');
});

test('the data directory is not served, however the path is spelled, except the two symbol lists', () => {
  const src = APP.slice(APP.indexOf('function staticDataPath'), APP.indexOf('\n}\n', APP.indexOf('function staticDataPath')) + 2);
  const staticDataPath = new Function('path', src + 'return staticDataPath;')(path);
  const set = new Function(APP.match(/const PUBLIC_DATA_FILES = new Set\([^)]*\);/)[0] + 'return PUBLIC_DATA_FILES;')();
  const blocked = (raw) => { const r = staticDataPath(raw); return (r === '/data' || r.startsWith('/data/')) && !set.has(r); };
  for (const p of ['/data/sec-financials/0000019617.json', '/%64ata/sec-financials/x.json', '//data/quotes.json', '/assets/../data/screen-index.json', '/data/fundamentals/AAPL.json', '/data/%E0%A4%A.json', '/data'])
    assert.equal(blocked(p), true, p);
  for (const p of ['/data/us-companies.json', '/data/sp1500-companies.json', '/assets/app.js', '/database.html'])
    assert.equal(blocked(p), false, p);
});
