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

// Gaps (2026-11-07): an empty cell inside a row's span is filled only with a figure as filed.
const three = (concept, period, a, b, c, total = a + b + c) => [seg(concept, 'x:AMember', period, a), seg(concept, 'x:BMember', period, b), seg(concept, 'x:CMember', period, c), tot(concept, period, total)];
const LEAD = { axis: AX, currency: 'USD', preferConcept: 'us-gaap:Revenues' };
const rowOf = (t, m) => t.rows.find((r) => r.members.includes(m));

test('a gap the column\'s own report files as a loss is filled as filed; a complete table carries no source marks', () => {
  // Cincinnati Financial's Investments: -$686M in 2022, between positive years.
  const k = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...three('us-gaap:Revenues', year(2025), 60, 30, 10), ...three('us-gaap:Revenues', year(2024), 60, 30, -5), ...three('us-gaap:Revenues', year(2023), 50, 30, 8)]);
  const t = H.buildHistory([k], LEAD);
  assert.deepEqual(rowOf(t, 'x:CMember').sales, [8, -5, 10]);
  assert.equal(rowOf(t, 'x:CMember').filedIn, undefined, 'its own report: no other source to name');
  assert.deepEqual(H.gaps(t), []);
  const whole = H.buildHistory([filing('k', '10-K', '2026-02-01', '2025-12-31', [...three('us-gaap:Revenues', year(2025), 60, 30, 10), ...three('us-gaap:Revenues', year(2024), 50, 30, 9)])], LEAD);
  assert.ok(whole.rows.every((r) => !('filedIn' in r)) && whole.quarterly.rows.every((r) => !('filedIn' in r)));
});

test('a positive figure the table dropped as a subtotal of other rows stays empty', () => {
  const k = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...three('us-gaap:Revenues', year(2025), 60, 30, 10), ...three('us-gaap:Revenues', year(2024), 60, 30, 90, 90), ...three('us-gaap:Revenues', year(2023), 50, 30, 8)]);
  const c = rowOf(H.buildHistory([k], LEAD), 'x:CMember');
  assert.equal(c.sales[1], null);
});

test('a positive figure that is exactly the column\'s shortfall to its filed total goes in, though it equals two rows shown', () => {
  // Skyworks' FY2011 10-K: Taiwan $93.8M is also Other Americas $38.8M + EMEA $55.0M, so the region table's
  // closest fit dropped it, and the regions shown fell exactly $93.8M short of the filed total.
  const GX = 'us-gaap:StatementGeographicalAxis', g = (m, p, v) => ['us-gaap:SalesRevenueNet', GX, m, p[0], p[1], v, m + p[1], 0, 'USD'];
  const sky = (p, tw) => { const cn = 914700000, kr = 148400000, oap = 91500000, us = 76700000, oam = 38800000, emea = 55000000;
    return [g('swks:OtherAmericasForeignLocationMember', p, oam), g('us-gaap:SegmentGeographicalGroupsOfCountriesGroupTwoMember', p, cn + kr + oap + tw), g('swks:ForeignMemberOtherAsiapacificMember', p, oap), g('country:CN', p, cn), g('country:KR', p, kr),
      g('swks:SegmentGeographicalGroupsOfCountriesGroupThreeMember', p, emea), g('country:TW', p, tw), g('us-gaap:SegmentGeographicalGroupsOfCountriesGroupOneMember', p, us + oam), g('country:US', p, us),
      ['us-gaap:SalesRevenueNet', '', '', p[0], p[1], cn + kr + oap + tw + us + oam + emea, 't' + p[1], 0, 'USD']]; };
  const k11 = filing('k11', '10-K', '2011-11-20', '2011-12-31', [...sky(year(2011), 93800000), ...sky(year(2010), 51353000)]);
  const k12 = filing('k12', '10-K', '2012-11-20', '2012-12-31', sky(year(2012), 311700000));
  const t = H.buildHistory([k11, k12], { axis: GX, currency: 'USD', preferConcept: 'us-gaap:SalesRevenueNet' });
  assert.deepEqual(rowOf(t, 'country:TW').sales, [51353000, 93800000, 311700000]);
  assert.equal(rowOf(t, 'country:TW').filedIn, undefined, 'its column\'s own report');
});

test('a segment the column\'s report leaves out is read from another report on the same breakdown, and named', () => {
  // The FY2025 10-K redraws FY2024 without C (its total still includes C); the FY2024 10-K files C on the same totals.
  const k25 = (b24) => filing('k25', '10-K', '2026-02-01', '2025-12-31', [...three('us-gaap:Revenues', year(2025), 60, 30, 10), seg('us-gaap:Revenues', 'x:AMember', year(2024), 55), seg('us-gaap:Revenues', 'x:BMember', year(2024), b24), tot('us-gaap:Revenues', year(2024), 95)]);
  const k24 = (c24) => filing('k24', '10-K', '2025-02-01', '2024-12-31', [...three('us-gaap:Revenues', year(2024), 55, 30, c24), ...three('us-gaap:Revenues', year(2023), 50, 30, 8)]);
  const t = H.buildHistory([k24(10), k25(30)], LEAD);
  assert.deepEqual(t.years.map((y) => y.accession), ['k24', 'k25', 'k25']);
  const c = rowOf(t, 'x:CMember');
  assert.deepEqual(c.sales, [8, 10, 10]);
  assert.deepEqual(c.filedIn.map((x) => x?.accession || null), [null, 'k24', null]);
  assert.equal(c.filedIn[1].form, '10-K');
  // The other report restated a sibling: another breakdown, not mixed in.
  assert.equal(rowOf(H.buildHistory([filing('k24', '10-K', '2025-02-01', '2024-12-31', [...three('us-gaap:Revenues', year(2024), 50, 35, 10), ...three('us-gaap:Revenues', year(2023), 50, 30, 8)]), k25(30)], LEAD), 'x:CMember').sales[1], null);
  // The figure would carry the column past its filed total.
  const over = filing('k24', '10-K', '2025-02-01', '2024-12-31', [...three('us-gaap:Revenues', year(2024), 55, 30, 50, 95), ...three('us-gaap:Revenues', year(2023), 50, 30, 8)]);
  assert.equal(rowOf(H.buildHistory([over, k25(30)], LEAD), 'x:CMember').sales[1], null);
  // Another measure never stands in.
  const other = filing('k24', '10-K', '2025-02-01', '2024-12-31', [...three('us-gaap:PremiumsEarnedNet', year(2024), 55, 30, 10), ...three('us-gaap:Revenues', year(2023), 50, 30, 8)]);
  assert.equal(rowOf(H.buildHistory([other, k25(30)], LEAD), 'x:CMember').sales[1], null);
});

test('a report read only to fill a gap fills it, and never takes a column over from the report collect() read', () => {
  // k26 (fillOnly) is newer and restates FY2025; as a column source it would replace k25's FY2025 figures.
  const k23 = filing('k23', '10-K', '2024-02-01', '2023-12-31', three('us-gaap:Revenues', year(2023), 50, 30, 8));
  const k24 = filing('k24', '10-K', '2025-02-01', '2024-12-31', [seg('us-gaap:Revenues', 'x:AMember', year(2024), 55), seg('us-gaap:Revenues', 'x:BMember', year(2024), 30), tot('us-gaap:Revenues', year(2024), 95)]);
  const k25 = filing('k25', '10-K', '2026-02-01', '2025-12-31', three('us-gaap:Revenues', year(2025), 60, 30, 10));
  const k26 = { ...filing('k26', '10-K', '2027-02-01', '2026-12-31', [...three('us-gaap:Revenues', year(2025), 70, 20, 10), ...three('us-gaap:Revenues', year(2024), 55, 30, 10)]), fillOnly: true };
  const t = H.buildHistory([k23, k24, k25, k26], LEAD);
  assert.deepEqual(t.years.map((y) => y.accession), ['k23', 'k24', 'k25']);
  assert.deepEqual(rowOf(t, 'x:AMember').sales, [50, 55, 60]);
  const c = rowOf(t, 'x:CMember');
  assert.deepEqual(c.sales, [8, 10, 10]);
  assert.equal(c.filedIn[1].accession, 'k26');
  // The same report read as an ordinary record is a column source, as before.
  assert.deepEqual(H.buildHistory([k23, k24, k25, { ...k26, fillOnly: undefined }], LEAD).years.map((y) => y.accession), ['k23', 'k26', 'k26']);
});

test('a fourth quarter whose nine-month report leaves a segment out takes the nine months from a report on the same breakdown', () => {
  const q = (y, m1, m2) => [`${y}-${m1}`, `${y}-${m2}`];
  const k = filing('k25', '10-K', '2026-02-01', '2025-12-31', three('us-gaap:Revenues', year(2025), 70, 30, 20));
  const q1 = filing('q1', '10-Q', '2025-05-01', '2025-03-31', three('us-gaap:Revenues', q(2025, '01-01', '03-31'), 16, 7, 5));
  const q2 = filing('q2', '10-Q', '2025-08-01', '2025-06-30', three('us-gaap:Revenues', q(2025, '04-01', '06-30'), 18, 7, 5));
  const nine = (c) => c == null ? [seg('us-gaap:Revenues', 'x:AMember', q(2025, '01-01', '09-30'), 52), seg('us-gaap:Revenues', 'x:BMember', q(2025, '01-01', '09-30'), 22), tot('us-gaap:Revenues', q(2025, '01-01', '09-30'), 89)] : three('us-gaap:Revenues', q(2025, '01-01', '09-30'), 52, 22, c);
  const q3 = filing('q3', '10-Q', '2025-11-01', '2025-09-30', [...three('us-gaap:Revenues', q(2025, '07-01', '09-30'), 18, 8, 5), ...nine(15)]);
  const q3a = filing('q3a', '10-Q', '2025-11-20', '2025-09-30', [...three('us-gaap:Revenues', q(2025, '07-01', '09-30'), 18, 8, 5), ...nine(null)]);
  const q1n = filing('q1n', '10-Q', '2026-05-01', '2026-03-31', three('us-gaap:Revenues', q(2026, '01-01', '03-31'), 17, 8, 6));
  const t = H.buildHistory([k, q1, q2, q3, q3a, q1n], { ...LEAD, quarterFrom: '2025-01-01' });
  const Q = t.quarterly, c = Q.rows.find((r) => r.members.includes('x:CMember'));
  assert.deepEqual(Q.years.map((y) => y.derived), [false, false, false, true, false]);
  assert.equal(Q.years[3].from.nineMonths, 'q3a', 'the column is still the newest report\'s');
  assert.deepEqual(c.sales, [5, 5, 5, 5, 6]);
  assert.deepEqual(c.filedIn[3], { accession: 'q3', form: '10-Q', sourceUrl: 'https://www.sec.gov/q3', publicationDate: '2025-11-01', part: 'nineMonths' });
  // Nine months that would leave the quarter past its total are not used.
  const t2 = H.buildHistory([k, q1, q2, filing('q3', '10-Q', '2025-11-01', '2025-09-30', [...three('us-gaap:Revenues', q(2025, '07-01', '09-30'), 18, 8, 5), ...nine(15).map((f) => f[2] === 'x:CMember' ? [...f.slice(0, 5), 1, ...f.slice(6)] : f)]), q3a, q1n], { ...LEAD, quarterFrom: '2025-01-01' });
  assert.equal(t2.quarterly.rows.find((r) => r.members.includes('x:CMember')).sales[3], null);
});

test('a segment its column\'s report tags under another revenue concept goes in only as the exact shortfall', () => {
  // Cheniere: LNG and Other tagged Revenues, Regasification only as contract revenue, in the same report.
  const PX = 'srt:ProductOrServiceAxis', R = 'us-gaap:Revenues', K = 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax';
  const f = (c, m, p, v) => [c, PX, m, p[0], p[1], v, c + m + p[1], 0, 'USD'];
  const lng = (p, l, g, o, gTag = R) => [f(R, 'x:LngMember', p, l), f(gTag, 'x:RegasMember', p, g), f(R, 'x:OtherMember', p, o), tot(R, p, l + g + o)];
  const build = (g) => H.buildHistory([filing('k', '10-K', '2026-02-01', '2025-12-31', [...lng(year(2025), 1500, 70, 20),
    ...lng(year(2024), 1373, 67, 20, K).map((x) => x[2] === 'x:RegasMember' ? [...x.slice(0, 5), g, ...x.slice(6)] : x), f(K, 'x:LngMember', year(2024), 1344), tot(K, year(2024), 1411), ...lng(year(2023), 1200, 60, 18)])],
    { axis: PX, currency: 'USD', preferConcept: R, sic: '4924' });
  const regas = (t) => t.rows.find((r) => r.members.includes('x:RegasMember'));
  assert.deepEqual(regas(build(67)).sales, [60, 67, 70]);
  assert.equal(regas(build(67)).filedIn, undefined, 'the column\'s own report');
  assert.equal(regas(build(60)).sales[1], null, 'not the shortfall: another table\'s figure');
});

test('another report in the other view fills a segment only when every segment the column shows agrees', () => {
  // Avery Dennison: the newest report files FY2024 as reported without RBIS; the older one in the operating view.
  const f = (m, p, v, x) => ['us-gaap:Revenues', AX, m, p[0], p[1], v, m + p[1] + x, x, 'USD'];
  const three = (p, a, b, c, x) => [f('x:AMember', p, a, x), f('x:BMember', p, b, x), f('x:CMember', p, c, x)];
  const build = (b24) => H.buildHistory([
    filing('k25', '10-K', '2026-02-01', '2025-12-31', [...three(year(2025), 60, 32, 12, 0), tot('us-gaap:Revenues', year(2025), 104), f('x:AMember', year(2024), 55, 0), f('x:BMember', year(2024), 30, 0), tot('us-gaap:Revenues', year(2024), 95)]),
    filing('k24', '10-K', '2025-02-01', '2024-12-31', [...three(year(2024), 55, b24, 10, 1), tot('us-gaap:Revenues', year(2024), 95), ...three(year(2023), 50, 28, 9, 1), tot('us-gaap:Revenues', year(2023), 87)])], LEAD);
  const c = rowOf(build(30), 'x:CMember');
  assert.deepEqual(c.sales, [9, 10, 12]); assert.equal(c.filedIn[1].accession, 'k24');
  assert.equal(rowOf(build(25), 'x:CMember').sales[1], null);
});

test('a fourth quarter takes its year from the report on the nine months\' breakdown when the newest annual report redrew the segments', () => {
  // AAR: the FY2026 10-K redraws FY2025 as two segments; the FY2025 10-K and every 10-Q file three.
  const R = 'us-gaap:Revenues', FY = (y) => [`${y - 1}-07-01`, `${y}-06-30`];
  const cols = (p, o) => [...Object.entries(o).map(([m, v]) => seg(R, 'x:' + m + 'Member', p, v)), tot(R, p, Object.values(o).reduce((a, b) => a + b, 0))];
  const t = H.buildHistory([
    filing('k25', '10-K', '2025-08-01', '2025-06-30', [...cols(FY(2025), { A: 100, B: 60, C: 40 }), ...cols(FY(2024), { A: 90, B: 55, C: 35 })]),
    filing('q1', '10-Q', '2024-11-01', '2024-09-30', cols(['2024-07-01', '2024-09-30'], { A: 25, B: 15, C: 10 })),
    filing('q2', '10-Q', '2025-02-01', '2024-12-31', cols(['2024-10-01', '2024-12-31'], { A: 25, B: 15, C: 10 })),
    filing('q3', '10-Q', '2025-05-01', '2025-03-31', [...cols(['2025-01-01', '2025-03-31'], { A: 25, B: 15, C: 10 }), ...cols(['2024-07-01', '2025-03-31'], { A: 75, B: 45, C: 30 })]),
    filing('q1n', '10-Q', '2025-11-01', '2025-09-30', cols(['2025-07-01', '2025-09-30'], { A: 26, B: 16, C: 11 })),
    filing('k26', '10-K', '2026-08-01', '2026-06-30', [...cols(FY(2026), { A: 110, D: 110 }), ...cols(FY(2025), { A: 100, D: 100 })])], { ...LEAD, quarterFrom: '2024-07-01' });
  assert.deepEqual(t.rows.map((r) => [r.name, r.sales]), [['A', [90, 100, 110]], ['D', [null, 100, 110]], ['B', [55, null, null]], ['C', [35, null, null]]], 'the annual view keeps the newest breakdown');
  const c = t.quarterly.rows.find((r) => r.name === 'C');
  assert.deepEqual(c.sales, [10, 10, 10, 10, 11]);
  assert.equal(c.filedIn[3].accession, 'k25'); assert.equal(c.filedIn[3].part, 'year');
  assert.equal(t.quarterly.rows.find((r) => r.name === 'A').filedIn, undefined, 'a segment the newest report still lists keeps its year');
});

test('a table built before the gap rules stays current only where it has no gap', () => {
  const years = [{ periodEnd: '2023-12-31' }, { periodEnd: '2024-12-31' }, { periodEnd: '2025-12-31' }];
  const table = (mid) => ({ years, rows: [{ name: 'A', sales: [1, 2, 3] }, { name: 'C', sales: [1, mid, 3] }], quarterly: { years: [], rows: [] } });
  assert.deepEqual(H.gaps(table(null)), [{ kind: 'annual', end: '2024-12-31', row: 'C' }]);
  H.COMPATIBLE.push('older'); // none is compatible today: every stored table was rebuilt as this version
  try {
    assert.equal(H.current({ version: 'older', table: table(2) }), true);
    assert.equal(H.current({ version: 'older', table: table(null) }), false);
  } finally { H.COMPATIBLE.pop(); }
  assert.equal(H.current({ version: H.VERSION, table: table(null) }), true, 'this version already read what could fill it');
  assert.equal(H.current({ version: 'old', table: table(2) }), false);
  const q = { years: [{ periodStart: '2025-09-30', periodEnd: '2025-12-31', derived: true }, { periodEnd: '2025-09-30' }, { periodEnd: '2026-03-31' }], rows: [{ name: 'C', sales: [5, null, 6] }] };
  q.years = [q.years[1], q.years[0], q.years[2]];
  assert.deepEqual(H.gaps({ years: [], rows: [], quarterly: { years: q.years, rows: [{ name: 'C', sales: [5, null, 6] }] } }), [{ kind: 'nine', end: '2025-09-30', yearEnd: '2025-12-31', row: 'C' }]);
});

test('outside a row\'s span a figure goes in only where the in-span table is empty, by the same rules', () => {
  // The FY2025 10-K files the sold segment C as zero; the table of positive rows dropped it after its last figure.
  const k24 = filing('k24', '10-K', '2025-02-01', '2024-12-31', [...three('us-gaap:Revenues', year(2024), 55, 30, 10), ...three('us-gaap:Revenues', year(2023), 50, 30, 8)]);
  const k25 = filing('k25', '10-K', '2026-02-01', '2025-12-31', three('us-gaap:Revenues', year(2025), 60, 30, 0));
  const t = H.buildHistory([k24, k25], LEAD);
  assert.deepEqual(rowOf(t, 'x:CMember').sales, [8, 10, 0], 'the zero as filed, in its own report');
  assert.deepEqual(rowOf(t, 'x:AMember').sales, [50, 55, 60]);
  assert.equal(rowOf(t, 'x:CMember').filedIn, undefined);
});

test('where the filings\' own totals build nothing, the table is checked against the statement\'s revenue as filed', () => {
  const RFC = 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', L = { ...LEAD, preferConcept: RFC };
  const rows = (period, a, b) => [seg(RFC, 'x:AMember', period, a), seg(RFC, 'x:BMember', period, b)];
  // Wendy's: segments under the ASC 606 concept, the total only as Revenues.
  const wendys = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...rows(year(2025), 60, 40), tot('us-gaap:Revenues', year(2025), 100), ...rows(year(2024), 50, 40), tot('us-gaap:Revenues', year(2024), 90)]);
  assert.deepEqual(H.buildHistory([wendys], L).rows.map((r) => r.sales), [[50, 60], [40, 40]]);
  // Meritage: no total beside the segments at all; the statement's own total line (lead.totals) for each period.
  const meritage = filing('k25', '10-K', '2026-02-01', '2025-12-31', [...rows(year(2025), 60, 40), ...rows(year(2024), 50, 40)]);
  assert.equal(H.buildHistory([meritage], L).rows.length, 0);
  const t = H.buildHistory([meritage], { ...L, totals: { '2025-01-01|2025-12-31|USD': 100, '2024-01-01|2024-12-31|USD': 95 } });
  assert.deepEqual(t.years.map((y) => y.totalRevenue), [95, 100]);
  // A filer that files its latest year twice, in its own currency and a convenience translation.
  const twice = (u) => (f) => [...f.slice(0, 8), u];
  const k = filing('f25', '20-F', '2026-04-01', '2025-12-31', [...twoSegments('us-gaap:Revenues', year(2025), 600, 400), ...twoSegments('us-gaap:Revenues', year(2024), 500, 400)].map(twice('CNY'))
    .concat(twoSegments('us-gaap:Revenues', year(2025), 84, 56).map(twice('USD'))));
  const cny = H.buildHistory([k], { ...LEAD, currency: 'CNY' });
  assert.deepEqual(cny.rows.map((r) => r.sales), [[500, 600], [400, 400]]);
  assert.deepEqual(H.buildHistory([k], LEAD).rows.map((r) => r.sales), [[84], [56]]);
  // A generic member is the named segment its filed label says (Lamar's "Billboard").
  const G = 'us-gaap:ReportableSegmentAggregationBeforeOtherOperatingSegmentMember', O = 'us-gaap:AllOtherSegmentsMember';
  const lamar = filing('k25', '10-K', '2026-02-01', '2025-12-31', [seg(RFC, G, year(2025), 90), seg(RFC, O, year(2025), 10), tot('us-gaap:Revenues', year(2025), 100)], { [G]: 'Billboard' });
  assert.deepEqual(H.buildHistory([lamar], L).rows.map((r) => [r.name, r.sales]), [['Billboard', [90]], ['All Other', [10]]]);
});

test('a table rebuilt with each unit apart is taken only where it adds to the strict one', () => {
  const col = (end, total) => ({ periodStart: end.slice(0, 4) + '-01-01', periodEnd: end, totalRevenue: total });
  const row = (m, sales) => ({ members: [m], sales, profit: sales.map(() => null), assets: sales.map(() => null) });
  const view = (years, rows) => ({ years, rows, quarterly: { years: [], rows: [] } });
  const strict = view([col('2024-12-31', 100)], [row('A', [60]), row('B', [40])]);
  assert.equal(H.keeps(strict, view([col('2024-12-31', 100), col('2025-12-31', 120)], [row('A', [60, 70]), row('B', [40, 50])])), true, 'a year added, every figure kept');
  assert.equal(H.keeps(strict, view([col('2024-12-31', 100)], [row('A', [61]), row('B', [39])])), false, 'a filed figure changed');
  assert.equal(H.keeps(strict, view([col('2025-12-31', 120)], [row('A', [70]), row('B', [50])])), false, 'a column lost');
  assert.equal(H.keeps(strict, view([col('2024-12-31', 100)], [row('A', [60])])), false, 'a row lost');
  assert.equal(H.keeps(strict, view([col('2024-12-31', 100), col('2025-12-31', 100)], [row('A', [60, 70]), row('B', [40, 50])])), false, 'a new column past its total');
});

test('a fourth quarter is not derived across footings: a recast nine months or a restated year gives way to a pair that fits', () => {
  const R = 'us-gaap:Revenues', p = (s, e) => [s, e];
  const cols = (per, o, total) => [...Object.entries(o).map(([m, v]) => seg(R, 'x:' + m + 'Member', per, v)), tot(R, per, total)];
  const quarters = (y) => [
    filing('q1-' + y, '10-Q', `${y}-05-01`, `${y}-03-31`, cols(p(`${y}-01-01`, `${y}-03-31`), { A: 25, B: 15 }, 50)),
    filing('q2-' + y, '10-Q', `${y}-08-01`, `${y}-06-30`, cols(p(`${y}-04-01`, `${y}-06-30`), { A: 25, B: 15 }, 50)),
    filing('q3-' + y, '10-Q', `${y}-11-01`, `${y}-09-30`, [...cols(p(`${y}-07-01`, `${y}-09-30`), { A: 25, B: 15 }, 50), ...cols(p(`${y}-01-01`, `${y}-09-30`), { A: 75, B: 45 }, 150)])];
  const q4 = (t) => { const j = t.quarterly.years.findIndex((y) => y.derived); return { from: t.quarterly.years[j].from, total: t.quarterly.years[j].totalRevenue, cells: t.quarterly.rows.map((r) => [r.name, r.sales[j]]) }; };
  // Targa: a later 10-Q files the nine months again on a redrawn footing; year less those gave Q4 segments of 80 and 10
  // against a total of 10. The nine months the year fits are used instead.
  const targa = H.buildHistory([
    filing('k25', '10-K', '2026-02-01', '2025-12-31', cols(year(2025), { A: 100, B: 60 }, 200)), ...quarters(2025),
    filing('q3-2026', '10-Q', '2026-11-01', '2026-09-30', [...cols(p('2026-07-01', '2026-09-30'), { A: 9, B: 30 }, 60), ...cols(p('2025-01-01', '2025-09-30'), { A: 20, B: 50 }, 190)])],
  { ...LEAD, quarterFrom: '2025-01-01' });
  assert.deepEqual(q4(targa), { from: { year: 'k25', nineMonths: 'q3-2025' }, total: 50, cells: [['A', 25], ['B', 15]] });
  // 3M: the newest 10-K restates the year without a spun-off segment (total 100 against nine months of 150). The year
  // from the report on the nine months' footing is used, and named.
  const mmm = H.buildHistory([
    filing('k24', '10-K', '2025-02-01', '2024-12-31', [...cols(year(2024), { A: 110 }, 110), ...cols(year(2025), { A: 100 }, 100)]),
    filing('k25', '10-K', '2026-02-01', '2025-12-31', cols(year(2025), { A: 100, B: 60 }, 200)), ...quarters(2025)].map((f) => f.accession === 'k24' ? { ...f, filed: '2026-03-01', reportDate: '2025-12-31' } : f),
  { ...LEAD, quarterFrom: '2025-01-01' });
  const m = q4(mmm);
  assert.equal(m.total, 50); assert.deepEqual(m.cells, [['A', 25], ['B', 15]]); assert.equal(m.from.nineMonths, 'q3-2025');
  // Harmonic: the restated year moves revenue between segments; its quarter adds to the total but leaves A at -35.
  const recut = (yearA) => H.buildHistory([
    filing('k25', '10-K', '2026-02-01', '2025-12-31', cols(year(2025), { A: 100, B: 60 }, 200)), ...quarters(2025),
    filing('k26', '10-K', '2027-02-01', '2026-12-31', [...cols(year(2026), { A: 50, B: 130 }, 220), ...cols(year(2025), { A: yearA, B: 160 - yearA }, 200)])],
  { ...LEAD, quarterFrom: '2025-01-01' });
  const h = q4(recut(40));
  assert.deepEqual([h.from.year, h.cells.sort()], ['k25', [['A', 25], ['B', 15]]]);
  assert.equal(q4(recut(95)).from.year, 'k26', 'a pair with no negative segment is left as it was');
});

test('one figure filed under two members in a year is counted once (AppLovin FY2021, 124% of revenue)', () => {
  const B = { years: [{ periodEnd: '2021-12-31', totalRevenue: 2793 }, { periodEnd: '2022-12-31', totalRevenue: 2817 }],
    rows: [{ name: 'Apps', sales: [2119, 1768], profit: [null, null], assets: [null, null] },
      { name: 'Software Platform', sales: [674, 1049], profit: [null, null], assets: [null, null] },
      { name: 'Software Platform Revenue', sales: [674, null], profit: [null, null], assets: [null, null] }] };
  H.dropRepeats(B);
  assert.deepEqual(B.rows.map((r) => r.name), ['Apps', 'Software Platform'], 'the repeat with fewer years goes');
  // Equal figures in a year that already adds up stay: two segments may report the same number.
  const same = { years: [{ periodEnd: '2025-12-31', totalRevenue: 1000 }], rows: [{ name: 'A', sales: [500], profit: [null], assets: [null] }, { name: 'B', sales: [500], profit: [null], assets: [null] }] };
  H.dropRepeats(same);
  assert.equal(same.rows.length, 2);
});
