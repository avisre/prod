'use strict';
// Segment history for the company page's "Product segments" view: every year and quarter the filings
// tag, not only the three years of the latest 10-K. Each column is read from the newest filing that
// reports it (a recast segment stays comparable with today's), from the filing's XBRL instance: the
// .xml instance before inline XBRL (2009-2019/21) and EDGAR's extracted _htm.xml after. Every figure is
// as filed with its context; a fourth quarter is the fiscal year less the nine months to date, marked.
const { Parser } = require('htmlparser2');
const axios = require('axios');
const p = require('./sec-coverage');
const seg = require('./sec-segment-observations');
const { HEADERS } = require('./sec-reporting');

// A business development company's 10-Q tags every holding: NewtekOne's Q3 2022 instance is 85.6 MB.
const MAX_BYTES = 160 * 1024 * 1024;
const BUSINESS = /(?:StatementBusinessSegmentsAxis|:SegmentsAxis)$/;
const TABLE_AXIS = /(?:StatementBusinessSegments|Segments|ProductOrService|ProductsAndServices|StatementGeographical|GeographicalAreas|GeographicDistribution)Axis$/;
const BANK_PAIR = ['InterestIncomeExpenseNet', 'NoninterestIncome'];
const NAMESPACES = [[/fasb\.org\/us-gaap\//, 'us-gaap'], [/fasb\.org\/srt\//, 'srt'], [/xbrl\.ifrs\.org\//, 'ifrs-full'], [/xbrl\.sec\.gov\/dei\//, 'dei']];
// Before 2012 some banks filed segment revenue under a concept of their own (JPMorgan's
// jpm:SegmentReportingInformationNetRevenue, FY2008-2010); it is read here only, checked against the filing's revenue.
const CUSTOM_REVENUE = /^SegmentReportingInformation(?:Net)?Revenues?$/;
const STANDARD = ['us-gaap', 'srt', 'ifrs-full', 'dei'];
// Before the 2018 taxonomy some companies filed all of their revenue as goods (or services) sales: AMD's net
// segments FY2009-2017 are SalesRevenueGoodsNet (its total is filed both as that and as SalesRevenueNet), so
// every year before the FY2018 recast went unread. Either is revenue only where its total for the period is
// the filing's revenue: equal to every other revenue total filed for it, or the only one. Otherwise (less than
// the total, or goods beside services with no total to match) it is a part of revenue and is dropped.
const LEGACY_SALES = ['us-gaap:SalesRevenueGoodsNet', 'us-gaap:SalesRevenueServicesNet'];
// The 2018 taxonomy moved two axes from us-gaap to srt; filings before it tag the same table under the old
// name (Apple's product lines FY2013-15). A filing is read on the table's own axis, and on the old name only
// when it has nothing on the new one, since filings of the changeover year can tag both.
const AXIS_ALIAS = { 'srt:ProductOrServiceAxis': 'us-gaap:ProductOrServiceAxis', 'srt:StatementGeographicalAxis': 'us-gaap:StatementGeographicalAxis' };
const onAxis = (name, axis) => name === axis || (!!AXIS_ALIAS[axis] && name === AXIS_ALIAS[axis]);
const axisIn = (facts, axis) => !AXIS_ALIAS[axis] || facts.some((f) => f[1] === axis) || !facts.some((f) => f[1] === AXIS_ALIAS[axis]) ? axis : AXIS_ALIAS[axis];
const days = (start, end) => (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
const kindOf = (start, end) => { if (!start) return 'instant'; const d = days(start, end); return d >= 340 && d <= 380 ? 'annual' : d >= 80 && d <= 100 ? 'quarter' : d >= 260 && d <= 290 ? 'ytd9' : null; };

// One XBRL instance into contexts, units and numeric facts. Prefixes are the filer's own choice, so a
// standard taxonomy is recognised by its namespace and written with its usual prefix.
function parseInstance(text) {
  const prefixes = new Map(), contexts = new Map(), units = new Map(), facts = [], stack = [];
  let context = null, unit = null, fact = null;
  const qname = (q) => { const s = String(q || '').trim(), i = s.indexOf(':'); if (i < 0) return s; const pre = s.slice(0, i); return (prefixes.get(pre) || pre) + s.slice(i); };
  const local = (n) => n.split(':').pop();
  const parser = new Parser({
    onopentag(name, attrs) {
      const tag = local(name); stack.push(tag);
      for (const [k, v] of Object.entries(attrs)) if (k.startsWith('xmlns:')) { const std = NAMESPACES.find(([re]) => re.test(v)); prefixes.set(k.slice(6), std ? std[1] : k.slice(6)); }
      if (tag === 'context') context = { id: attrs.id, dims: [], start: null, end: null, issuer: '' };
      else if (context && (tag === 'explicitMember')) context.dims.push({ axis: qname(attrs.dimension), member: '' });
      else if (context && tag === 'typedMember') context.dims.push({ axis: qname(attrs.dimension), member: '', typed: true });
      else if (tag === 'unit') unit = { id: attrs.id, measures: [], divide: false };
      else if (unit && tag === 'divide') unit.divide = true;
      else if (!context && !unit && attrs.contextRef && attrs.unitRef) fact = { name: qname(name), contextRef: attrs.contextRef, unitRef: attrs.unitRef, decimals: attrs.decimals ?? null, nil: attrs['xsi:nil'] === 'true', text: '' };
    },
    ontext(v) {
      const tag = stack[stack.length - 1];
      if (context) {
        if (tag === 'identifier') context.issuer += v;
        else if (tag === 'startDate') context.start = (context.start || '') + v;
        else if (tag === 'endDate' || tag === 'instant') context.end = (context.end || '') + v;
        else if (tag === 'explicitMember') context.dims[context.dims.length - 1].member += v;
      } else if (unit && tag === 'measure') unit.measures.push(v.trim().split(':').pop());
      else if (fact) fact.text += v;
    },
    onclosetag(name) {
      const tag = local(name);
      if (tag === 'context' && context) { context.dims.forEach((d) => { d.member = qname(d.member); }); context.start = context.start?.trim() || null; context.end = context.end?.trim() || null; contexts.set(context.id, context); context = null; }
      else if (tag === 'unit' && unit) { units.set(unit.id, unit); unit = null; }
      else if (fact && qname(name) === fact.name) { facts.push(fact); fact = null; }
      stack.pop();
    }
  }, { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true });
  parser.end(text);
  return { contexts, units, facts };
}

// The facts a segment table needs from one filing: revenue measures without dimensions (the filing's own
// totals) and on one segment axis; segment profit; segment assets at a period end. Compact rows:
// [concept, axis, member, start, end, value, contextRef, extraDims].
function filingFacts(text, cik) {
  const { contexts, units, facts } = parseInstance(text), out = [], qualified = [], plainSegment = new Set();
  for (const f of facts) {
    const c = contexts.get(f.contextRef), u = units.get(f.unitRef);
    if (!c || f.nil || !u || u.divide || !/^[A-Z]{3}$/.test(u.measures[0] || '') || p.cik(c.issuer.trim()) !== p.cik(cik) || !p.day(c.end)) continue;
    const text = f.text.trim(); if (!/^-?\d+(?:\.\d+)?$/.test(text)) continue;
    const value = Number(text), [taxonomy, concept] = f.name.split(':');
    if (!concept || c.dims.some((d) => d.typed)) continue;
    const kind = kindOf(c.start, c.end); if (!kind) continue;
    const metric = seg.segmentMetric(taxonomy, concept), measure = seg.segmentMeasure(taxonomy, concept) || (!STANDARD.includes(taxonomy) && CUSTOM_REVENUE.test(concept)) || LEGACY_SALES.includes(f.name);
    if (!metric && !measure) continue;
    if ((metric === 'assets') !== (kind === 'instant')) continue;
    // The consolidation axis moved from us-gaap to srt in 2018; its operating-segments member is the plain segment view.
    const dims = c.dims.filter((d) => !(/:ConsolidationItemsAxis$/.test(d.axis) && /:OperatingSegmentsMember$/.test(d.member)));
    if (!c.dims.length) { if (measure) out.push([f.name, '', '', c.start || '', c.end, value, f.contextRef, 0, u.measures[0]]); continue; }
    const group = [f.name, c.start, c.end, u.measures[0]].join('|'), split = c.start && seg.qualifiedSplit(taxonomy, concept, dims);
    if (split) { qualified.push({ group, qualifier: split.qualifier, item: [f.name, split.segment.axis, split.segment.member, c.start, c.end, value, f.contextRef, c.dims.length - 1, u.measures[0]] }); continue; }
    if (dims.length !== 1 || !TABLE_AXIS.test(dims[0].axis)) continue;
    if (c.start && BUSINESS.test(dims[0].axis)) plainSegment.add(group);
    if (metric && !BUSINESS.test(dims[0].axis)) continue;
    out.push([f.name, dims[0].axis, dims[0].member, c.start || '', c.end, value, f.contextRef, c.dims.length - 1, u.measures[0]]);
  }
  const all = out.concat(seg.sharedQualifier(qualified, plainSegment));
  const period = (x) => x[3] + '|' + x[4] + '|' + x[8], totals = new Map();
  for (const x of all) if (!x[1]) (totals.get(period(x)) || totals.set(period(x), []).get(period(x))).push(x);
  const whole = (x) => {
    const t = totals.get(period(x)) || [], own = t.find((y) => y[0] === x[0]); if (!own) return false;
    const others = t.filter((y) => y[0] !== x[0]), full = others.filter((y) => !LEGACY_SALES.includes(y[0]));
    return full.length ? full.every((y) => y[5] === own[5]) : !others.length;
  };
  return all.filter((x) => !LEGACY_SALES.includes(x[0]) || whole(x));
}

const transient = (e) => ['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EPIPE'].includes(e?.code) || e?.response?.status === 429 || e?.response?.status >= 500;
const get = async (url, type) => { for (let i = 0; ; i++) { try { return (await axios.get(url, { headers: HEADERS, timeout: 60000, maxContentLength: MAX_BYTES, responseType: type, transformResponse: type === 'text' ? (x) => x : undefined })).data; } catch (e) { if (!transient(e) || i === 2) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); } } };
// The filing's instance: EDGAR's extracted copy of an inline filing, else the one .xml that is not a
// linkbase, a summary or a rendered report.
function instanceName(items, primary) {
  const xml = (items || []).filter((i) => /^[A-Za-z0-9_.-]+\.xml$/.test(i.name || '') && !/_(?:cal|def|lab|pre)\.xml$|^FilingSummary|^MetaLinks|^R\d+\.xml$|^defnref|^Financial_Report/i.test(i.name));
  return (xml.find((i) => i.name === String(primary || '').replace(/\.htm$/, '_htm.xml')) || xml.find((i) => /_htm\.xml$/.test(i.name)) || xml.sort((a, b) => Number(b.size) - Number(a.size))[0])?.name || null;
}
async function readFiling(cik, filing, { wantLabels = () => false } = {}) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accessionNumber.replace(/-/g, '')}/`;
  const listing = await get(base + 'index.json', 'json'), items = listing?.directory?.item || [];
  const name = instanceName(items, filing.primaryDocument);
  const record = { accession: filing.accessionNumber, form: filing.form, filed: filing.filingDate, reportDate: filing.reportDate, url: base + filing.primaryDocument, instanceUrl: name ? base + name : null, facts: [], labels: {} };
  if (!name) return record;
  record.facts = filingFacts(String(await get(base + name, 'text')), cik);
  const members = [...new Set(record.facts.map((f) => f[2]).filter(Boolean))].filter(wantLabels);
  const lab = members.length && items.find((i) => /_lab\.xml$/.test(i.name || ''));
  if (lab) { try { const labels = require('./sec-original').parseLabels(String(await get(base + lab.name, 'text'))); for (const m of members) if (labels.get(m)) record.labels[m] = labels.get(m).slice(0, 120); } catch (e) { if (transient(e)) throw e; } }
  return record;
}

// ---- building the table from the filings read ----
const isBankPair = (name) => BANK_PAIR.some((c) => name === 'us-gaap:' + c);
// A column's candidate tables, as extract() builds them: one per revenue measure and view, the bank's
// net interest income plus noninterest income as its one composite; the total is the same filing's own.
// A filing's revenue facts by period, built once per filing (a history asks each filing for every period).
const periodIndex = new WeakMap();
const byPeriod = (filing) => {
  let m = periodIndex.get(filing); if (m) return m; m = new Map();
  for (const f of filing.facts) if (!seg.segmentMetric(...f[0].split(':'))) { const k = f[3] + '|' + f[4]; (m.get(k) || m.set(k, []).get(k)).push(f); }
  periodIndex.set(filing, m); return m;
};
// A revenue measure with no consolidated total of its own in the filing is checked against the income
// statement's revenue, as extract() checks the latest 10-K's table: Wendy's files its sales by product under
// RevenueFromContractWithCustomerExcludingAssessedTax and its total only as Revenues. The first revenue total
// filed for the period, in the order the statements choose one (sec-facts). Used only for an issuer whose
// history the filing's own totals build nothing for (buildHistory): elsewhere it let concepts with no total of
// their own compete with the table's measure and redrew 125 complete tables.
const STATEMENT_TOTALS = (() => { const m = require('./sec-facts').MAPS.income.totalRevenue; return Object.keys(m).filter((t) => Array.isArray(m[t])).flatMap((t) => m[t].map((c) => t + ':' + c)); })();
const statementTotal = (totals, name, unit) => {
  if (!/^(?:RevenueFromContract|SalesRevenue|Revenues?$)/.test(name.split(':')[1] || '')) return null;
  for (const c of STATEMENT_TOTALS) if (totals.has(c + '|' + unit)) return totals.get(c + '|' + unit);
  return null;
};
// statement: the income statement's own revenue (lead.totals, as filed) for issuers whose instances file no total
// beside the segments: the statement's total line is itself a dimensioned fact (Meritage's "Total closing revenue" is
// its Real estate member, Tanger's is filed on the legal-entity axis), which the filing's facts here do not keep.
// In that mode facts and totals are also grouped by unit: a foreign filer that files its latest year again as a
// convenience translation (U Power: CNY and USD) tags every member twice, which read as one group is a conflict and
// built nothing. Not elsewhere: grouped by unit everywhere, 108 complete tables were redrawn. Its tables are also
// scored with the members' filed labels, as extract() scores the latest 10-K's: Lamar files its billboard segment as
// the generic ReportableSegmentAggregationBeforeOtherOperatingSegmentMember, labelled "Billboard".
function columnCandidates(filing, axis, start, end, statement = false, statementTotals = null, units = false) {
  const facts = byPeriod(filing).get(start + '|' + end) || [];
  const u = (f) => statement || units ? f[8] : '';
  const totals = new Map(); for (const f of facts) if (!f[1]) totals.set(f[0] + '|' + u(f), f);
  const groups = new Map();
  const use = axisIn(facts, axis);
  for (const f of facts) if (f[1] === use) { const key = f[0] + '|' + (f[7] ? 'operating' : 'reported') + '|' + u(f); (groups.get(key) || groups.set(key, []).get(key)).push(f); }
  const byMember = (list) => { const m = new Map(); for (const f of list) { const old = m.get(f[2]); if (old && old[5] !== f[5]) return null; m.set(f[2], f); } return m; };
  const out = [];
  for (const [key, list] of groups) {
    const [name, view, unitKey] = key.split('|'); if (isBankPair(name)) continue;
    const custom = CUSTOM_REVENUE.test(name.split(':')[1] || '') && !STANDARD.includes(name.split(':')[0]);
    const members = byMember(list), filed = statement && statementTotals?.[start + '|' + end + '|' + unitKey], t = (c) => totals.get(c + '|' + unitKey);
    const total = t(name) || (custom ? t('us-gaap:Revenues') || t('us-gaap:RevenuesNetOfInterestExpense') : statement ? statementTotal(totals, name, unitKey) || (filed != null ? ['statement:totalRevenue', '', '', start, end, filed, 'statement', 0, unitKey] : null) : null); if (!members || !total) continue;
    out.push({ concept: name, axis: use, view, total: total[5], totalConcept: total[0], totalContext: total[6], unit: total[8], rows: [...members.values()].map((f) => ({ member: f[2], value: f[5], contexts: [f[6]] })) });
  }
  const unitKeys = new Set(facts.map(u));
  for (const view of ['reported', 'operating']) for (const unit of unitKeys) {
    const a = groups.get('us-gaap:' + BANK_PAIR[0] + '|' + view + '|' + unit), b = groups.get('us-gaap:' + BANK_PAIR[1] + '|' + view + '|' + unit);
    const ta = totals.get('us-gaap:' + BANK_PAIR[0] + '|' + unit), tb = totals.get('us-gaap:' + BANK_PAIR[1] + '|' + unit);
    const ma = a && byMember(a), mb = b && byMember(b); if (!ma || !mb || !ta || !tb) continue;
    out.push({ concept: BANK_PAIR.map((c) => 'us-gaap:' + c).join('+'), axis: use, view, total: ta[5] + tb[5], totalContext: ta[6] + '+' + tb[6], unit: ta[8],
      rows: [...new Set([...ma.keys(), ...mb.keys()])].map((m) => ({ member: m, value: (ma.get(m)?.[5] || 0) + (mb.get(m)?.[5] || 0), contexts: [ma.get(m)?.[6], mb.get(m)?.[6]].filter(Boolean) })) });
  }
  return out;
}
// Every candidate that makes a table (two rows or more), scored as extract() scores them: how far the
// rows fall from the filing's own total, a table that does not reconcile after one that does.
function scored(cands, currency, axis, single = false, labels = null) {
  const out = [];
  for (const c of cands.filter((x) => x.unit === currency)) {
    const g = { axis, entries: c.rows.map((r) => ({ member: r.member, value: r.value, filedLabel: r.filedLabel || labels?.[r.member] })), totalRevenue: c.total, roundingTolerance: 0 };
    const v = seg.shown(g), sum = v.rows.reduce((n, r) => n + r.value, 0);
    // A single-segment company's table has one row (its lead table says so); any other table needs two.
    const miss = (v.rows.length < (single ? 1 : 2) ? 2 : 0) + (v.usable ? 0 : 1) + Math.abs(c.total - sum) / Math.max(1, Math.abs(c.total)) + (c.view === 'reported' ? 0 : 0.0005);
    if (miss < 2) out.push({ ...c, miss, kept: new Set(v.rows.map((r) => r.member)) });
  }
  return out.sort((a, b) => a.miss - b.miss);
}
// Which measures may stand in for one another from year to year: the same quantity filed under a renamed
// concept (JPMorgan's own net-revenue concept, then Revenues, then RevenuesNetOfInterestExpense). Premiums
// never stand in for revenue, nor a bank's fee revenue (ASC 606) for its net revenue. Outside finance
// (SIC 6xxx) Revenues is the company's sales under its generic name: 3M recast FY2016-17 as Revenues and
// filed the years before as SalesRevenueNet, one measure throughout.
const measureClass = (concept, nonFinancial = false) => {
  const [t, n = ''] = concept.split(':');
  if (concept.includes('+')) return 'net';
  if (/TaxEquivalent/.test(n)) return 'fte';
  if (/Premium/.test(n) || n === 'InsuranceRevenue') return 'premiums';
  if (/^(?:RevenueFromContract|SalesRevenue)/.test(n) || n === 'Revenue') return 'sales';
  if (n === 'Revenues' && nonFinancial) return 'sales';
  if (n === 'Revenues' || n === 'RevenuesNetOfInterestExpense' || !STANDARD.includes(t)) return 'net';
  return concept;
};
// What the table's sales line is, in words: revenue, or the measure a bank or insurer files in its place.
const measureName = (concept) => concept.includes('+') ? seg.BANK_MEASURE : seg.measureOf(...concept.split(':')) || 'revenue';

// filings: records from readFiling, any order. lead: the latest 10-K's table (statementTable) and its axis.
function build(filings, { axis, currency, preferConcept, quarterFrom, sic, single = false, totals: statementTotals = null }, { statement = false, edges = false, units = false } = {}) {
  const nonFinancial = /^[0-57-9]\d{3}$/.test(String(sic || '')), cls = (c) => measureClass(c, nonFinancial);
  const byNewest = filings.slice().sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession));
  // A report read only to fill a gap (fillOnly: it repeats a period another report already gives) is a source for the
  // fills below and nothing else: a column stays read from the report collect() chose. Read as a column source, a
  // newer repeat took columns over and dropped or restated their segments (Masco Q1 2017 from the 2018 10-Q's recast,
  // Quantum FY2018 blank: 134 filed cells across 35 issuers on 11-07).
  const base = byNewest.filter((f) => !f.fillOnly);
  const labels = {}; for (const f of base.concat(byNewest.filter((f) => f.fillOnly))) for (const [m, l] of Object.entries(f.labels || {})) if (!labels[m]) labels[m] = l;
  // Every period the filings tag on the table's axis, with each filing's tables for it, newest filing first.
  const periodsOf = (kind) => {
    const periods = new Map();
    for (const f of base) for (const x of f.facts) if (onAxis(x[1], axis) && kindOf(x[3], x[4]) === kind) periods.set(x[3] + '|' + x[4], null);
    return [...periods.keys()].map((k) => { const [start, end] = k.split('|'); return { start, end, offers: base.map((f) => ({ f, cands: scored(columnCandidates(f, axis, start, end, statement, statementTotals, units), currency, axis, single, statement ? labels : null) })).filter((o) => o.cands.length) }; }).filter((p) => p.offers.length);
  };
  const annualP = periodsOf('annual'), quarterP = periodsOf('quarter').filter((q) => !quarterFrom || q.end >= quarterFrom);
  // One measure for the whole table, so the years compare: the concept most years are filed under (the
  // latest table's on a tie). A year without it takes a renamed concept of the same measure, or is left out.
  // Years are counted per measure class first, so a renamed concept adds to its measure: 3M filed segment sales as
  // SalesRevenueNet (FY2008-17), Revenues (FY2016-25) and the ASC 606 concept (FY2018-25). By concept, Revenues won
  // the tie and every year before FY2016 was refused as another measure; by class, sales has all eighteen.
  const count = new Map(), classYears = new Map();
  for (const p of annualP.length ? annualP : quarterP) {
    const concepts = new Set(p.offers.flatMap((o) => o.cands.map((x) => x.concept)));
    for (const c of concepts) count.set(c, (count.get(c) || 0) + 1);
    for (const k of new Set([...concepts].map(cls))) classYears.set(k, (classYears.get(k) || 0) + 1);
  }
  const preferClass = preferConcept && cls(preferConcept);
  const measure = [...classYears].sort((a, b) => b[1] - a[1] || (b[0] === preferClass) - (a[0] === preferClass) || a[0].localeCompare(b[0]))[0]?.[0];
  const series = [...count].filter(([c]) => cls(c) === measure).sort((a, b) => b[1] - a[1] || (b[0] === preferConcept) - (a[0] === preferConcept) || a[0].localeCompare(b[0]))[0]?.[0];
  const columns = (periods) => {
    const out = [];
    for (const p of periods) {
      const pick = (ok) => { for (const o of p.offers) { const c = o.cands.find(ok); if (c) return { start: p.start, end: p.end, filing: o.f, c }; } return null; };
      const col = pick((c) => c.concept === series) || pick((c) => cls(c.concept) === cls(series));
      if (col) out.push(col);
    }
    // One column per period end: a 52/53-week year can tag two starts for the same end.
    const ends = new Map(); for (const col of out) { const old = ends.get(col.end); if (!old || col.c.miss < old.c.miss) ends.set(col.end, col); }
    return [...ends.values()].sort((a, b) => a.end.localeCompare(b.end));
  };
  const annual = columns(annualP), quarters = columns(quarterP);
  // Segment profit: one concept for every column, the one covering the most cells, earlier tiers first.
  const metric = (cols, kind, instant) => {
    const concepts = kind === 'profit' ? seg.PROFIT_CONCEPTS : ['us-gaap:Assets', 'ifrs-full:Assets'];
    const cell = (col, concept) => {
      const xs = col.filing.facts.filter((x) => x[0] === concept && x[1] === col.c.axis && x[4] === col.end && (instant ? !x[3] : x[3] === col.start)).sort((a, b) => a[7] - b[7]);
      const m = new Map(), bad = new Set();
      for (const x of xs) { const old = m.get(x[2]); if (!old) m.set(x[2], x); else if (old[5] !== x[5] && old[7] === x[7]) bad.add(x[2]); }
      for (const b of bad) m.delete(b); return m;
    };
    let best = null;
    for (const concept of concepts) { const cells = cols.map((col) => cell(col, concept)), n = cells.reduce((k, m, i) => k + [...m.keys()].filter((x) => cols[i].c.kept.has(x)).length, 0); if (n && (!best || n > best.n)) best = { concept, n, cells }; }
    return best;
  };
  const profit = metric(annual.concat(quarters), 'profit', false), assets = metric(annual, 'assets', true);
  const profitCells = profit ? new Map(annual.concat(quarters).map((col, i) => [col, profit.cells[i]])) : new Map();
  const assetCells = assets ? new Map(annual.map((col, i) => [col, assets.cells[i]])) : new Map();
  // Rows: members of the newest column first, by its sales; then older members, newest first. A member
  // renamed between years under the same printed name is one row.
  // A footnote marker on a filed label ("Retail and Business Banking (1)") is not part of the name.
  const name = (m) => String(seg.displayName({ member: m, filedLabel: labels[m] })).replace(/\s*(?:\(\d\)|\d)$/, '');
  const rows = [], rowOf = new Map();
  for (const col of annual.slice().reverse().concat(quarters.slice().reverse())) {
    const order = col.c.rows.filter((r) => col.c.kept.has(r.member)).sort((a, b) => b.value - a.value);
    for (const r of order) { if (rowOf.has(r.member)) continue; const n = name(r.member); let row = rows.find((x) => x.name === n && !x.members.some((m) => col.c.kept.has(m))); if (!row) { row = { name: n, members: [] }; rows.push(row); } row.members.push(r.member); rowOf.set(r.member, row); }
  }
  // A cell read from a report other than its column's (below): column -> row -> { value, profit, assets, filing }.
  const fills = new Map(), restored = new Map(); // restored: column -> rows whose own-report figure the table had dropped
  const value = (col, row) => { const r = col.c.rows.find((x) => row.members.includes(x.member) && col.c.kept.has(x.member)); return r || fills.get(col)?.get(row) || null; };
  // The column's own report first; a cell read from another report takes that report's profit and assets.
  const metricOf = (cells, col, row) => { const f = fills.get(col)?.get(row), m = cells.get(col);
    if (m) for (const k of row.members) if (m.has(k) && (col.c.kept.has(k) || f?.filing === col.filing)) return m.get(k);
    return f ? (cells === profitCells ? f.profit : f.assets) : null; };
  // A figure one report files for a member and period, when it files exactly one.
  const filedOne = (filing, concept, axisName, member, start, end) => {
    const xs = filing.facts.filter((x) => x[0] === concept && x[1] === axisName && x[2] === member && x[4] === end && (start ? x[3] === start : !x[3]) && !x[7]);
    return xs.length && xs.every((x) => x[5] === xs[0][5]) ? xs[0] : null;
  };
  const near = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.0005);
  // Gaps (2026-11-07): an empty cell between a row's first and last figure. Two causes, both filled only with a
  // figure as filed, never estimated:
  //  1. The column's own report files the member, but the table left it out: a zero or a loss, which a table
  //     of positive rows drops (Cincinnati Financial's Investments, -$686M in 2022), or a positive figure the
  //     closest-fit pruning took for an overlap (Skyworks' Taiwan FY2011, $93.8M, without which the regions
  //     fall $93.8M short of the filed total). A zero or a loss goes in as filed; a positive figure when it is
  //     exactly the shortfall to the filed total, or within 0.5% of it and no subtotal or repeat of a figure shown.
  //  2. The column's report does not file the member (it redrew the table, or left the line out) and another
  //     report files that period on the same breakdown: the same revenue total, and every segment both reports
  //     file for the period equal. That figure goes in, marked with the report it is read from, when it does
  //     not carry the column past its total. A report that restated the other segments is a different
  //     breakdown and is not mixed into the column (Skyworks' FY2018 10-K redrew FY2017 without "United States").
  //     A report that files the period in the other view (operating segments, or as reported) counts only when
  //     every segment the column shows is in it with the same figure (Avery Dennison's RBIS, FY2016).
  // With edges, the same rules also run on the cells outside a row's span (before its first figure, after its last);
  // buildHistory takes from that build only cells the in-span build leaves empty.
  const shownValues = (col) => rows.map((row) => value(col, row)?.value).filter((x) => x !== undefined && x !== null);
  const sumOf = (col) => shownValues(col).reduce((n, x) => n + x, 0);
  const partOf = (col, v) => { const xs = shownValues(col).filter((x) => x > 0 && x < v);
    if (shownValues(col).includes(v)) return true;
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) { if (xs[i] + xs[j] === v) return true; for (let k = j + 1; k < xs.length; k++) if (xs[i] + xs[j] + xs[k] === v) return true; }
    return false; };
  // In the other view (operating segments, or as reported), every segment the column shows must be there and equal.
  const sameBasis = (cand, total, ref, otherView = false) => near(cand.total, total) && (() => { let agree = 0;
    for (const [m, v] of ref) { const o = cand.rows.find((x) => x.member === m); if (!o) { if (otherView) return false; continue; } if (!near(o.value, v)) return false; agree++; }
    return agree >= (otherView ? 2 : 1); })();
  const fillCell = (col, row) => {
    const own = col.c.rows.find((x) => row.members.includes(x.member));
    if (own) {
      // Exactly the shortfall to the filed total: it is that missing part, even where it happens to equal a sum of
      // rows shown (Skyworks' Taiwan FY2011, $93.8M, is also Other Americas plus EMEA), since a subtotal of rows
      // already shown would carry the column past its total. Near it, only when it is no subtotal or repeat.
      const hole = col.c.total - sumOf(col);
      const fits = own.value <= 0 || near(hole, own.value) || !partOf(col, own.value) && Math.abs(hole - own.value) <= Math.abs(col.c.total) * 0.005;
      if (fits) { col.c.kept.add(own.member); (restored.get(col) || restored.set(col, new Set()).get(col)).add(row); }
      return; // the column's own report files it: never replaced from another report
    }
    const put = (f, c, r) => {
      const pf = profit && filedOne(f, profit.concept, c.axis, r.member, col.start, col.end), af = assets && kindOf(col.start, col.end) === 'annual' && filedOne(f, assets.concept, c.axis, r.member, '', col.end);
      (fills.get(col) || fills.set(col, new Map()).get(col)).set(row, { value: r.value, contexts: r.contexts, profit: pf || null, assets: af || null, filing: f });
    };
    // The column's own report files the segment's member only under another tag of the same measure (Cheniere tags
    // its regasification line as contract revenue, the rest of the table as Revenues) or on another axis (Avery
    // Dennison tags its RBIS segment member on the product axis): in, when it is exactly the column's shortfall to
    // its filed total.
    const hole = col.c.total - sumOf(col);
    if (hole > 0) {
      const x = col.filing.facts.find((x) => row.members.includes(x[2]) && x[3] === col.start && x[4] === col.end && !x[7] && x[8] === currency && cls(x[0]) === cls(col.c.concept) && near(hole, x[5]));
      if (x) { put(col.filing, { axis: x[1] }, { member: x[2], value: x[5], contexts: [x[6]] }); return; }
    }
    const ref = new Map(col.c.rows.filter((x) => col.c.kept.has(x.member)).map((x) => [x.member, x.value]));
    for (const f of byNewest) {
      if (f === col.filing) continue;
      for (const c of columnCandidates(f, axis, col.start, col.end, statement, statementTotals, units)) {
        if (cls(c.concept) !== cls(col.c.concept) || c.unit !== currency) continue;
        const r = c.rows.find((x) => row.members.includes(x.member)); if (!r || !sameBasis(c, col.c.total, ref, c.view !== col.c.view)) continue;
        if (r.value > 0 && (partOf(col, r.value) || sumOf(col) + r.value > col.c.total * 1.005)) return;
        put(f, c, r); return;
      }
    }
  };
  const span = (has) => { const a = has.indexOf(true), b = has.lastIndexOf(true); return a < 0 ? [0, 0] : edges ? [0, has.length] : [a + 1, b]; };
  const spanGaps = (cols) => { for (const row of rows) { const has = cols.map((col) => !!value(col, row)), [lo, hi] = span(has);
    for (let i = lo; i < hi; i++) if (!has[i]) fillCell(cols[i], row); } };
  spanGaps(annual);
  const colMeta = (col) => ({ periodStart: col.start, periodEnd: col.end, totalRevenue: col.c.total, measure: measureName(col.c.concept), concept: col.c.concept, form: col.filing.form, accession: col.filing.accession, sourceUrl: col.filing.url, instanceUrl: col.filing.instanceUrl, publicationDate: col.filing.filed });
  // The fourth quarter: the year as filed less its nine months to date as filed, when both are on the same
  // measure and the member is in both. Calculated, and marked so.
  const ytd = (fy) => {
    const ends = quarters.filter((q) => q.end > fy.start && q.end < fy.end).map((q) => q.end).sort();
    const q3end = ends[2]; if (!q3end) return null;
    for (const f of filings.filter((f) => !f.fillOnly).sort((a, b) => b.filed.localeCompare(a.filed))) { const c = columnCandidates(f, axis, fy.start, q3end, statement, statementTotals, units).find((x) => x.concept === fy.c.concept && x.view === fy.c.view && x.unit === currency); if (c) return { c, filing: f, end: q3end }; }
    return null;
  };
  // The year and its nine months must be on one footing. A later report that redrew the segments files the year or the
  // nine months again on the new footing (Targa's 2026 10-Qs recast 2025's nine months: its FY2025 10-K's year less
  // them gave Logistics $14,170M and Gathering -$1,130M for Q4 2025). A pair is on one footing when the quarter's
  // segments stand to its total as the year's segments stand to the year's total. Otherwise the nine months from
  // another report that fits the year, else the year and nine months from reports that fit each other; failing both,
  // the pair as it was (q4Total then refuses a total it cannot be on).
  // Only the segments the table shows count (a filing's subtotals would excuse any excess).
  const footing = (yc, nc) => { const tq = yc.total - nc.total; if (!(tq > 0) || !(yc.total > 0)) return false;
    const ys = yc.rows.filter((r) => rowOf.has(r.member) && (!yc.kept || yc.kept.has(r.member))); let s = 0, n = 0;
    for (const r of nc.rows) { const y = ys.find((x) => x.member === r.member); if (y) { s += y.value - r.value; n++; } }
    // Every segment the year shows must be in the nine months too: a pair with nothing in common fits vacuously.
    return n > 0 && n === ys.length && s <= tq * Math.max(1.005, ys.reduce((n, r) => n + r.value, 0) / yc.total * 1.02); };
  const filedAs = (fy, start, end, list) => list.flatMap((f) => columnCandidates(f, axis, start, end, statement, statementTotals, units)
    .filter((x) => x.concept === fy.c.concept && x.view === fy.c.view && x.unit === currency).map((c) => ({ c, filing: f, end })));
  // A pair is redrawn only when it is plainly off footing (the quarter's segments above twice its total, or a total at
  // or below zero under positive segments); a pair that merely misses the tighter test is left as it was.
  // So is a pair that leaves a segment the year files as positive revenue negative for the quarter by more than 2% of
  // the quarter (Harmonic's Q4 2024: SaaS -$72.7M against a $31.6M quarter); such a pair is redrawn only onto one
  // that fits and has no such cell, and otherwise left as filed (an insurer's investment line can fall below zero).
  const broken = (yc, nc) => { const tq = yc.total - nc.total; let s = 0, neg = false;
    for (const r of nc.rows) { const y = yc.rows.find((x) => x.member === r.member && rowOf.has(x.member) && (!yc.kept || yc.kept.has(x.member))); if (!y) continue;
      const q = y.value - r.value; s += q; if (y.value > 0 && q < 0 && -q > 0.02 * Math.abs(tq || y.value)) neg = true; }
    return neg || (tq > 0 ? s > tq * 2 : s > 0); };
  const fits = (yc, nc) => footing(yc, nc) && !broken(yc, nc);
  const onFooting = (fy, nine) => {
    if (!broken(fy.c, nine.c)) return { fy, nine };
    const nines = filedAs(fy, fy.start, nine.end, byNewest.filter((f) => f !== nine.filing));
    const n = nines.find((x) => fits(fy.c, x.c)); if (n) return { fy, nine: n };
    for (const y of filedAs(fy, fy.start, fy.end, byNewest.filter((f) => f !== fy.filing && /^(10-K|20-F|40-F)/.test(f.form)))) {
      // The year's segments as any column takes them: its subtotals dropped (seg.shown), and only rows the table has.
      const sc = scored([y.c], currency, axis, single, statement ? labels : null)[0]; if (!sc) continue;
      const yc = { ...sc, kept: new Set([...sc.kept].filter((m) => rowOf.has(m))) };
      for (const x of [nine, ...nines]) if (fits(yc, x.c)) {
        const col = { c: yc, filing: y.filing, start: fy.start, end: fy.end, recast: true };
        if (profit) { const m = new Map(); for (const z of y.filing.facts) if (z[0] === profit.concept && z[1] === y.c.axis && z[3] === fy.start && z[4] === fy.end && !z[7] && !m.has(z[2])) m.set(z[2], z); profitCells.set(col, m); }
        return { fy: col, nine: x };
      }
    }
    return { fy, nine };
  };
  const derivedQ = [];
  for (const col of annual) {
    if (quarterFrom && col.end < quarterFrom) continue;
    if (quarters.some((q) => q.end === col.end)) continue;
    const first = ytd(col); if (!first) continue;
    const { fy, nine } = onFooting(col, first);
    const nineProfit = profit ? (() => { const m = new Map(); for (const x of nine.filing.facts) if (x[0] === profit.concept && x[1] === nine.c.axis && x[3] === fy.start && x[4] === nine.end && !m.has(x[2])) m.set(x[2], x); return m; })() : new Map();
    derivedQ.push({ fy, nine, nineProfit });
  }
  const cellOut = (r) => r ? r.value : null;
  const table = {
    axis: BUSINESS.test(axis) ? 'business' : /Product/.test(axis) ? 'product' : /Geogr/.test(axis) ? 'region' : 'other', axisConcept: axis, currency,
    measure: series ? measureName(series) : 'revenue',
    profitMeasure: profit ? seg.PROFIT_MEASURE(profit.concept) : null,
    profitConcept: profit?.concept || null, assetsConcept: assets?.concept || null,
    years: annual.map(colMeta),
    rows: rows.map((row) => ({ name: row.name, members: row.members, sales: annual.map((col) => cellOut(value(col, row))), profit: annual.map((col) => metricOf(profitCells, col, row)?.[5] ?? null), assets: annual.map((col) => metricOf(assetCells, col, row)?.[5] ?? null),
      contexts: annual.map((col) => value(col, row)?.contexts || null) }))
  };
  // Quarterly view: filed quarters plus derived fourth quarters, in date order.
  const qcols = quarters.map((col) => ({ col })).concat(derivedQ.map((d) => ({ derived: d }))).sort((a, b) => (a.col || a.derived.fy).end.localeCompare((b.col || b.derived.fy).end));
  // A fourth quarter whose nine-month report does not file the member: the nine months from another report
  // that files the same nine months on the same breakdown, recorded per row.
  const nineFills = new Map(); // derived entry -> row -> { value, profit, filing }
  const nineOf = (d, row) => {
    const own = d.nine.c.rows.find((r) => row.members.includes(r.member));
    return own || nineFills.get(d)?.get(row) || null;
  };
  // A fourth quarter whose year column (the newest annual report) no longer lists the segment, because that report
  // redrew the segments after the 10-Qs were filed (AAR's FY2026 10-K): the year from the report that files it on
  // the nine months' own breakdown, the same segments and the same revenue total. For this quarter only; the
  // annual view keeps the newest report's breakdown.
  const yearFills = new Map(); // derived entry -> row -> { value, profit, filing }
  const fyOf = (d, row) => value(d.fy, row) || yearFills.get(d)?.get(row) || null;
  const q4Fits = (d, row, q) => {
    const total = d.fy.c.total - d.nine.c.total;
    const shown = rows.filter((o) => o !== row).map((o) => { const a = fyOf(d, o), b = nineOf(d, o); return a && b ? a.value - b.value : null; }).filter((x) => x !== null);
    const parts = shown.filter((x) => x > 0 && x < q), sum = shown.reduce((n, x) => n + x, 0);
    const part = shown.includes(q) || parts.some((x, i) => parts.slice(i + 1).some((y, j) => x + y === q || parts.slice(i + j + 2).some((z) => x + y + z === q)));
    return !(q > 0 && (part || sum + q > total * 1.005));
  };
  const fillYear = (d, row) => {
    const nine = nineOf(d, row); if (!nine || d.nine.c.rows.every((x) => !row.members.includes(x.member))) return;
    const members = new Set(d.nine.c.rows.map((x) => x.member));
    for (const f of byNewest) {
      if (f === d.fy.filing) continue;
      for (const c of columnCandidates(f, axis, d.fy.start, d.fy.end, statement, statementTotals, units)) {
        if (cls(c.concept) !== cls(d.nine.c.concept) || c.view !== d.nine.c.view || c.unit !== currency || !near(c.total, d.fy.c.total)) continue;
        if (c.rows.length !== members.size || !c.rows.every((x) => members.has(x.member))) continue;
        const r = c.rows.find((x) => row.members.includes(x.member)); if (!r) continue;
        if (!q4Fits(d, row, r.value - nine.value)) return;
        const pf = profit && filedOne(f, profit.concept, c.axis, r.member, d.fy.start, d.fy.end);
        (yearFills.get(d) || yearFills.set(d, new Map()).get(d)).set(row, { value: r.value, profit: pf || null, filing: f });
        return;
      }
    }
  };
  const fillNine = (d, row) => {
    const ref = new Map(d.nine.c.rows.map((x) => [x.member, x.value]));
    for (const f of byNewest) {
      if (f === d.nine.filing) continue;
      for (const c of columnCandidates(f, axis, d.fy.start, d.nine.end, statement, statementTotals, units)) {
        if (c.concept !== d.nine.c.concept || c.view !== d.nine.c.view || c.unit !== currency) continue;
        const r = c.rows.find((x) => row.members.includes(x.member)); if (!r || !sameBasis(c, d.nine.c.total, ref)) continue;
        // The quarter it makes meets the same test as any other cell: no subtotal or repeat of a quarter shown, and
        // not past the quarter's total (Intel's Client Computing Group, Q4 2025, would have been counted twice).
        if (!q4Fits(d, row, fyOf(d, row).value - r.value)) return;
        const pf = profit && filedOne(f, profit.concept, c.axis, r.member, d.fy.start, d.nine.end);
        (nineFills.get(d) || nineFills.set(d, new Map()).get(d)).set(row, { value: r.value, profit: pf || null, filing: f });
        return;
      }
    }
  };
  const qHas = (x, row) => x.col ? !!value(x.col, row) : !!(fyOf(x.derived, row) && nineOf(x.derived, row));
  for (const row of rows) {
    const has = qcols.map((x) => qHas(x, row)), [lo, hi] = span(has);
    for (let i = lo; i < hi; i++) if (!has[i]) { const x = qcols[i]; if (x.col) { fillCell(x.col, row); continue; }
      if (!fyOf(x.derived, row)) fillYear(x.derived, row); else if (!nineOf(x.derived, row)) fillNine(x.derived, row); }
  }
  // Where a cell is read from a report other than its column's: that report, per row, only on rows that have one.
  const src = (f, extra) => ({ accession: f.accession, form: f.form, sourceUrl: f.url, publicationDate: f.filed, ...extra });
  const other = (col, row) => { const g = fills.get(col)?.get(row); return g && g.filing !== col.filing ? g : null; };
  const filedIn = (cols) => (row) => { const out = cols.map((col) => { const g = other(col, row); return g ? src(g.filing) : null; }); return out.some(Boolean) ? { filedIn: out } : {}; };
  table.rows = table.rows.map((r, i) => ({ ...r, ...filedIn(annual)(rows[i]) }));
  // A fourth quarter's total is the year's total less the nine months'. Where a later annual report restated the year
  // (3M's FY2022 without Health Care, 2024), that year less the nine months as first filed is on two footings: the
  // quarter's segments came to more than twice it ($6,034M against $11M), or it came to nothing or less while they did
  // not. No filed quarter in any table is that far from its segments: only two footings are (a few points over is
  // intersegment sales, and stays). Then the year from another annual report that files it at a total the segments
  // fit (the nine months' own footing), the closest; failing that, no total.
  const q4Total = (d, sum) => {
    const base = d.fy.c.total - d.nine.c.total, fits = (t) => t > 0 && sum <= t * 1.005;
    if (base > 0 ? sum <= base * 2 : sum <= 0) return { total: base };
    let best = null;
    for (const f of filings) {
      if (f === d.fy.filing || !/^(10-K|20-F|40-F)/.test(f.form)) continue;
      for (const c of columnCandidates(f, axis, d.fy.start, d.fy.end, statement, statementTotals, units)) {
        const t = c.total - d.nine.c.total;
        if (cls(c.concept) === cls(d.fy.c.concept) && c.unit === currency && c.total !== d.fy.c.total && fits(t) && (!best || t - sum < best.total - sum)) best = { total: t, yearTotal: f.accession };
      }
    }
    return best || { total: null };
  };
  const q4Sum = (x) => rows.reduce((n, row) => { const a = fyOf(x.derived, row), b = nineOf(x.derived, row); return n + (a && b ? a.value - b.value : 0); }, 0);
  table.quarterly = {
    years: qcols.map((x) => { if (x.col) return { ...colMeta(x.col), derived: false };
      const t = q4Total(x.derived, q4Sum(x));
      return { periodStart: x.derived.nine.end, periodEnd: x.derived.fy.end, totalRevenue: t.total, concept: x.derived.fy.c.concept, derived: true, from: { year: x.derived.fy.filing.accession, nineMonths: x.derived.nine.filing.accession, ...(t.yearTotal ? { yearTotal: t.yearTotal } : {}) }, sourceUrl: x.derived.fy.filing.url, publicationDate: x.derived.fy.filing.filed }; }),
    rows: rows.map((row) => {
      const out = { name: row.name, members: row.members,
        sales: qcols.map((x) => { if (x.col) return cellOut(value(x.col, row)); const a = fyOf(x.derived, row), b = nineOf(x.derived, row); return a && b ? a.value - b.value : null; }),
        // The nine months' profit is read on its own, as the sales are: a report may file one without the other.
        profit: qcols.map((x) => { if (x.col) return metricOf(profitCells, x.col, row)?.[5] ?? null; const yf = yearFills.get(x.derived)?.get(row), a = yf ? yf.profit : metricOf(profitCells, x.derived.fy, row), n = nineFills.get(x.derived)?.get(row);
          const b = [...x.derived.nineProfit.values()].find((r) => row.members.includes(r[2])) || n?.profit; return a && b ? a[5] - b[5] : null; }),
        assets: qcols.map(() => null) };
      const where = qcols.map((x) => { if (x.col) { const g = other(x.col, row); return g ? src(g.filing) : null; }
        const n = nineFills.get(x.derived)?.get(row), y = other(x.derived.fy, row) || yearFills.get(x.derived)?.get(row) || (x.derived.fy.recast && value(x.derived.fy, row) ? { filing: x.derived.fy.filing } : null);
        return n && y ? src(n.filing, { part: 'nineMonths', year: src(y.filing) }) : n ? src(n.filing, { part: 'nineMonths' }) : y ? src(y.filing, { part: 'year' }) : null; });
      return where.some(Boolean) ? { ...out, filedIn: where } : out;
    })
  };
  // A fourth quarter made from a filled year or nine months never leaves its quarter past the total: where it
  // would, the year and nine months are not on one footing and those quarters are left empty.
  qcols.forEach((x, i) => {
    if (!x.derived) return;
    const Q = table.quarterly, total = Q.years[i].totalRevenue, sum = Q.rows.reduce((n, r) => n + (r.sales[i] ?? 0), 0);
    if (!(total > 0 && sum > total * 1.005)) return;
    Q.rows.forEach((r, j) => {
      if (!(nineFills.get(x.derived)?.has(rows[j]) || yearFills.get(x.derived)?.has(rows[j]) || fills.get(x.derived.fy)?.has(rows[j]) || restored.get(x.derived.fy)?.has(rows[j]))) return;
      r.sales[i] = null; r.profit[i] = null; if (r.filedIn) { r.filedIn[i] = null; if (!r.filedIn.some(Boolean)) delete r.filedIn; }
    });
  });
  // Rows with nothing in any column of a view are not shown in it.
  table.quarterly.rows = table.quarterly.rows.filter((r) => r.sales.some((v) => v !== null));
  table.rows = table.rows.filter((r) => r.sales.some((v) => v !== null));
  const latest = table.rows.length && annual.length - 1; table.rows.sort((a, b) => (b.sales[latest] ?? -Infinity) - (a.sales[latest] ?? -Infinity));
  return table;
}

// The table: built on the filings' own totals, or, where those build nothing, on the statement's revenue (above).
// Grouped by unit (above) where that only adds to it: a foreign filer that files its latest year again in dollars had
// that year dropped as a conflict (93 tables on 11-07, most of them filers in CNY), but for six issuers the year read
// redrew earlier columns, so a table read by unit is taken only when every column, row and figure of the other is in
// it unchanged and no column passes its total.
// Then the cells outside each row's span, filled by the same rules (a segment's zero in the year it was sold, a year
// another report files on the same breakdown), taken only where the table is empty, so no figure it shows changes
// (2026-11-07). Two checks the in-span cells do not need, from the trial that let edges change the build itself
// (23 filed cells changed): a column that the new cells carry past its total takes none of them, and a fourth quarter
// below zero for a year at or above zero is the year and nine months on different footings, left out.
const key = (r) => r.members.join('|');
const overTotal = (V) => new Set(V.years.map((y, j) => y.totalRevenue > 0 && V.rows.reduce((n, r) => n + (r.sales[j] ?? 0), 0) > y.totalRevenue * 1.005 ? y.periodEnd + '|' + y.periodStart : null).filter(Boolean));
function keeps(a, b) {
  for (const [A, B] of [[a, b], [a.quarterly, b.quarterly]]) {
    const jb = new Map(B.years.map((y, j) => [y.periodEnd + '|' + y.periodStart, j])), rb = new Map(B.rows.map((r) => [key(r), r]));
    if (A.years.some((y) => !jb.has(y.periodEnd + '|' + y.periodStart))) return false;
    for (const r of A.rows) { const o = rb.get(key(r)); if (!o) return false;
      for (const [i, y] of A.years.entries()) { const j = jb.get(y.periodEnd + '|' + y.periodStart); for (const m of ['sales', 'profit', 'assets']) if (r[m][i] !== null && r[m][i] !== o[m][j]) return false; } }
    const was = overTotal(A); for (const e of overTotal(B)) if (!was.has(e)) return false;
  }
  return true;
}
function buildHistory(filings, lead) {
  let base = build(filings, lead), mode = {};
  if (!(base.rows.length && base.years.length)) { mode = { statement: true }; base = build(filings, lead, mode); }
  else { const byUnit = build(filings, lead, { units: true }); if (JSON.stringify(byUnit) !== JSON.stringify(base) && byUnit.rows.length && keeps(base, byUnit)) { mode = { units: true }; base = byUnit; } }
  if (!base.rows.length || !base.years.length) return base;
  const wide = build(filings, lead, { ...mode, edges: true });
  for (const [B, W, annual] of [[base, wide, true], [base.quarterly, wide.quarterly, false]]) {
    const wj = new Map(W.years.map((y, j) => [y.periodEnd + '|' + y.periodStart, j])), wr = new Map(W.rows.map((r) => [key(r), r]));
    B.years.forEach((y, i) => {
      const j = wj.get(y.periodEnd + '|' + y.periodStart); if (j === undefined) return;
      const adds = [];
      for (const r of B.rows) {
        const w = wr.get(key(r)); if (!w || r.sales[i] !== null || w.sales[j] === null) continue;
        if (y.derived && w.sales[j] < 0) { const fyRow = wide.rows.find((x) => key(x) === key(r)), k = wide.years.findIndex((x) => x.periodEnd === y.periodEnd), fy = fyRow && k >= 0 ? fyRow.sales[k] : null; if (fy === null || fy >= 0) continue; }
        adds.push([r, w]);
      }
      if (!adds.length) return;
      const sum = B.rows.reduce((n, r) => n + (r.sales[i] ?? 0), 0) + adds.reduce((n, [, w]) => n + w.sales[j], 0);
      if (y.totalRevenue > 0 && sum > y.totalRevenue * 1.005) return;
      for (const [r, w] of adds) {
        r.sales[i] = w.sales[j];
        for (const m of ['profit', 'assets']) if (r[m][i] === null && w[m][j] !== null) r[m][i] = w[m][j];
        if (annual && r.contexts && w.contexts) r.contexts[i] = w.contexts[j];
        if (w.filedIn?.[j]) { r.filedIn = r.filedIn || B.years.map(() => null); r.filedIn[i] = w.filedIn[j]; }
      }
    });
  }
  for (const B of [base, base.quarterly]) if (B?.rows?.length) dropRepeats(B);
  return base;
}

// One figure filed under two members in the same year counts twice: AppLovin's 2023 10-K tags its 2021
// software revenue as "Software Platform" and again as "Software Platform Revenue", and the year added up
// to 124% of revenue. When a year adds up to more than revenue and removing one of two equal figures makes
// it add up exactly, the repeat (the row with fewer years, else the later one) is removed for that year.
function dropRepeats(B) {
  B.years.forEach((y, i) => {
    if (!(y.totalRevenue > 0)) return;
    const sum = B.rows.reduce((n, r) => n + (r.sales[i] ?? 0), 0);
    if (sum <= y.totalRevenue * 1.005) return;
    const filled = (r) => r.sales.filter((v) => v !== null).length;
    for (let a = 0; a < B.rows.length; a++) for (let b = a + 1; b < B.rows.length; b++) {
      const v = B.rows[a].sales[i];
      if (v === null || v <= 0 || B.rows[b].sales[i] !== v || Math.abs(sum - v - y.totalRevenue) > y.totalRevenue * 0.005) continue;
      const drop = filled(B.rows[b]) <= filled(B.rows[a]) ? B.rows[b] : B.rows[a];
      for (const m of ['sales', 'profit', 'assets', 'contexts', 'filedIn']) if (drop[m]) drop[m][i] = null;
      return;
    }
  });
  B.rows = B.rows.filter((r) => r.sales.some((v) => v !== null));
}

// Which filings to read: newest first, a filing only when its own period is not yet reported by a newer
// one on the table's axis (each annual report repeats two or three years, each 10-Q the year-ago quarter).
// A foreign issuer's annual report is a 20-F or 40-F; its interim 6-Ks carry no tagged statements, so it
// has annual history only (IFRS filers tag from fiscal years ending on or after 2017-12-15).
async function collect(cik, filings, { axis, annualFrom = '2008-01-01', quarterFrom, have = [], onRead = () => {} }) {
  // A fillOnly record (read by the refresh to fill a gap) does not count as reading its period; when collect() wants
  // that report it becomes an ordinary record instead of being read again.
  const records = have.slice(), done = new Set(records.filter((r) => !r.fillOnly).map((r) => r.accession));
  const covered = (kind) => new Set(records.filter((r) => !r.fillOnly).flatMap((r) => r.facts.filter((x) => onAxis(x[1], axis) && kindOf(x[3], x[4]) === kind).map((x) => x[4])));
  const near = (set, d) => [...set].some((e) => Math.abs(Date.parse(e) - Date.parse(d)) <= 10 * 86400000);
  for (const [forms, kind, from] of [[['10-K', '20-F', '40-F'], 'annual', annualFrom], [['10-Q'], 'quarter', quarterFrom || annualFrom]]) {
    const list = filings.filter((f) => forms.includes(f.form) && f.reportDate >= from).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filingDate.localeCompare(a.filingDate));
    const seen = new Set(), windowMs = (kind === 'annual' ? 760 : 380) * 86400000;
    const read = async (f) => { const kept = records.find((r) => r.fillOnly && r.accession === f.accessionNumber); if (kept) { delete kept.fillOnly; done.add(kept.accession); return kept; }
      const known = new Set(records.flatMap((r) => Object.keys(r.labels || {}))); const rec = await readFiling(cik, f, { wantLabels: (m) => !known.has(m) }); records.push(rec); done.add(rec.accession); onRead(rec); return rec; };
    for (const f of list) {
      if (seen.has(f.reportDate)) continue; seen.add(f.reportDate);
      if (near(covered(kind), f.reportDate)) continue;
      // The newest filing that repeats this period comes first (a recast stays comparable), then the period's own.
      const tries = list.filter((g) => g.reportDate > f.reportDate && Date.parse(g.reportDate) - Date.parse(f.reportDate) <= windowMs && !done.has(g.accessionNumber)).sort((a, b) => b.reportDate.localeCompare(a.reportDate));
      let last = null;
      for (const g of tries.concat(done.has(f.accessionNumber) ? [] : [f])) { last = await read(g); if (near(covered(kind), f.reportDate)) break; }
      // A filing with no instance (before XBRL) ends the history for its form.
      if (last && !last.instanceUrl && last.accession === f.accessionNumber) break;
    }
  }
  return records;
}

// ---- stored tables ----
// One file per issuer, outside the public static root: the history is for paying customers only and is
// served through the API. VERSION changes when the builder's rules do, and a file of another version is
// rebuilt rather than read.
const path = require('path'), fs = require('fs');
const VERSION = '20261107-history6';
// Every stored table was rebuilt as history6 from its filing cache on 11-07 (fourth quarters derived on one footing,
// after history5's cells outside a row's span and statement-total issuers), so no older version is served as it is.
const COMPATIBLE = [];
const DIR = process.env.SEGMENT_HISTORY_DIR || path.join(__dirname, 'data', 'segment-history');
function load(cik) {
  try { const doc = JSON.parse(fs.readFileSync(path.join(DIR, p.cik(cik) + '.json'), 'utf8')); return (doc.version === VERSION || COMPATIBLE.includes(doc.version)) && doc.table?.rows?.length >= 1 && doc.table.years?.length ? doc : null; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// The empty cells inside each row's span, by the period whose reports could file them: a year, a quarter, or a
// fourth quarter's nine months to date (its year is a year of the annual view).
function gaps(table) {
  const out = [], v = (s) => s == null ? null : (s.value ?? s);
  for (const [kind, years, rows] of [['annual', table.years, table.rows], ['quarter', table.quarterly?.years || [], table.quarterly?.rows || []]]) for (const r of rows) {
    const has = r.sales.map((x) => v(x) !== null), a = has.indexOf(true), b = has.lastIndexOf(true);
    for (let i = a + 1; i < b; i++) if (!has[i]) { const y = years[i]; out.push(y.derived ? { kind: 'nine', end: y.periodStart, yearEnd: y.periodEnd, row: r.name } : { kind, end: y.periodEnd, row: r.name }); }
  }
  return out;
}
// Current: built by this version, or by a compatible one with no gap to fill.
const current = (doc) => doc?.version === VERSION || COMPATIBLE.includes(doc?.version) && !!doc.table && !gaps(doc.table).length;

module.exports = { VERSION, COMPATIBLE, DIR, load, gaps, current, measureClass, parseInstance, filingFacts, instanceName, readFiling, buildHistory, dropRepeats, keeps, collect, columnCandidates, kindOf };
