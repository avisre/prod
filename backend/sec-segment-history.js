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
    const metric = seg.segmentMetric(taxonomy, concept), measure = seg.segmentMeasure(taxonomy, concept) || (!STANDARD.includes(taxonomy) && CUSTOM_REVENUE.test(concept));
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
  return out.concat(seg.sharedQualifier(qualified, plainSegment));
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
function columnCandidates(filing, axis, start, end) {
  const facts = byPeriod(filing).get(start + '|' + end) || [];
  const totals = new Map(); for (const f of facts) if (!f[1]) totals.set(f[0], f);
  const groups = new Map();
  const use = axisIn(facts, axis);
  for (const f of facts) if (f[1] === use) { const key = f[0] + '|' + (f[7] ? 'operating' : 'reported'); (groups.get(key) || groups.set(key, []).get(key)).push(f); }
  const byMember = (list) => { const m = new Map(); for (const f of list) { const old = m.get(f[2]); if (old && old[5] !== f[5]) return null; m.set(f[2], f); } return m; };
  const out = [];
  for (const [key, list] of groups) {
    const [name, view] = key.split('|'); if (isBankPair(name)) continue;
    const custom = CUSTOM_REVENUE.test(name.split(':')[1] || '') && !STANDARD.includes(name.split(':')[0]);
    const members = byMember(list), total = totals.get(name) || (custom ? totals.get('us-gaap:Revenues') || totals.get('us-gaap:RevenuesNetOfInterestExpense') : null); if (!members || !total) continue;
    out.push({ concept: name, axis: use, view, total: total[5], totalConcept: total[0], totalContext: total[6], unit: total[8], rows: [...members.values()].map((f) => ({ member: f[2], value: f[5], contexts: [f[6]] })) });
  }
  for (const view of ['reported', 'operating']) {
    const a = groups.get('us-gaap:' + BANK_PAIR[0] + '|' + view), b = groups.get('us-gaap:' + BANK_PAIR[1] + '|' + view);
    const ta = totals.get('us-gaap:' + BANK_PAIR[0]), tb = totals.get('us-gaap:' + BANK_PAIR[1]);
    const ma = a && byMember(a), mb = b && byMember(b); if (!ma || !mb || !ta || !tb) continue;
    out.push({ concept: BANK_PAIR.map((c) => 'us-gaap:' + c).join('+'), axis: use, view, total: ta[5] + tb[5], totalContext: ta[6] + '+' + tb[6], unit: ta[8],
      rows: [...new Set([...ma.keys(), ...mb.keys()])].map((m) => ({ member: m, value: (ma.get(m)?.[5] || 0) + (mb.get(m)?.[5] || 0), contexts: [ma.get(m)?.[6], mb.get(m)?.[6]].filter(Boolean) })) });
  }
  return out;
}
// Every candidate that makes a table (two rows or more), scored as extract() scores them: how far the
// rows fall from the filing's own total, a table that does not reconcile after one that does.
function scored(cands, currency, axis) {
  const out = [];
  for (const c of cands.filter((x) => x.unit === currency)) {
    const g = { axis, entries: c.rows.map((r) => ({ member: r.member, value: r.value, filedLabel: r.filedLabel })), totalRevenue: c.total, roundingTolerance: 0 };
    const v = seg.shown(g), sum = v.rows.reduce((n, r) => n + r.value, 0);
    const miss = (v.rows.length < 2 ? 2 : 0) + (v.usable ? 0 : 1) + Math.abs(c.total - sum) / Math.max(1, Math.abs(c.total)) + (c.view === 'reported' ? 0 : 0.0005);
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
function buildHistory(filings, { axis, currency, preferConcept, quarterFrom, sic }) {
  const nonFinancial = /^[0-57-9]\d{3}$/.test(String(sic || '')), cls = (c) => measureClass(c, nonFinancial);
  const byNewest = filings.slice().sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession));
  const labels = {}; for (const f of byNewest) for (const [m, l] of Object.entries(f.labels || {})) if (!labels[m]) labels[m] = l;
  // Every period the filings tag on the table's axis, with each filing's tables for it, newest filing first.
  const periodsOf = (kind) => {
    const periods = new Map();
    for (const f of byNewest) for (const x of f.facts) if (onAxis(x[1], axis) && kindOf(x[3], x[4]) === kind) periods.set(x[3] + '|' + x[4], null);
    return [...periods.keys()].map((k) => { const [start, end] = k.split('|'); return { start, end, offers: byNewest.map((f) => ({ f, cands: scored(columnCandidates(f, axis, start, end), currency, axis) })).filter((o) => o.cands.length) }; }).filter((p) => p.offers.length);
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
  const value = (col, row) => { const r = col.c.rows.find((x) => row.members.includes(x.member) && col.c.kept.has(x.member)); return r ? r : null; };
  const metricOf = (cells, col, row) => { const m = cells.get(col); if (!m) return null; for (const k of row.members) if (m.has(k) && col.c.kept.has(k)) return m.get(k); return null; };
  const colMeta = (col) => ({ periodStart: col.start, periodEnd: col.end, totalRevenue: col.c.total, measure: measureName(col.c.concept), concept: col.c.concept, form: col.filing.form, accession: col.filing.accession, sourceUrl: col.filing.url, instanceUrl: col.filing.instanceUrl, publicationDate: col.filing.filed });
  // The fourth quarter: the year as filed less its nine months to date as filed, when both are on the same
  // measure and the member is in both. Calculated, and marked so.
  const ytd = (fy) => {
    const ends = quarters.filter((q) => q.end > fy.start && q.end < fy.end).map((q) => q.end).sort();
    const q3end = ends[2]; if (!q3end) return null;
    for (const f of filings.slice().sort((a, b) => b.filed.localeCompare(a.filed))) { const c = columnCandidates(f, axis, fy.start, q3end).find((x) => x.concept === fy.c.concept && x.view === fy.c.view && x.unit === currency); if (c) return { c, filing: f, end: q3end }; }
    return null;
  };
  const derivedQ = [];
  for (const fy of annual) {
    if (quarterFrom && fy.end < quarterFrom) continue;
    if (quarters.some((q) => q.end === fy.end)) continue;
    const nine = ytd(fy); if (!nine) continue;
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
  table.quarterly = {
    years: qcols.map((x) => x.col ? { ...colMeta(x.col), derived: false } : { periodStart: x.derived.nine.end, periodEnd: x.derived.fy.end, totalRevenue: x.derived.fy.c.total - x.derived.nine.c.total, concept: x.derived.fy.c.concept, derived: true, from: { year: x.derived.fy.filing.accession, nineMonths: x.derived.nine.filing.accession }, sourceUrl: x.derived.fy.filing.url, publicationDate: x.derived.fy.filing.filed }),
    rows: rows.map((row) => ({ name: row.name, members: row.members,
      sales: qcols.map((x) => { if (x.col) return cellOut(value(x.col, row)); const a = value(x.derived.fy, row), b = x.derived.nine.c.rows.find((r) => row.members.includes(r.member)); return a && b ? a.value - b.value : null; }),
      profit: qcols.map((x) => { if (x.col) return metricOf(profitCells, x.col, row)?.[5] ?? null; const a = metricOf(profitCells, x.derived.fy, row), b = [...x.derived.nineProfit.values()].find((r) => row.members.includes(r[2])); return a && b ? a[5] - b[5] : null; }),
      assets: qcols.map(() => null) }))
  };
  // Rows with nothing in any column of a view are not shown in it.
  table.quarterly.rows = table.quarterly.rows.filter((r) => r.sales.some((v) => v !== null));
  table.rows = table.rows.filter((r) => r.sales.some((v) => v !== null));
  const latest = table.rows.length && annual.length - 1; table.rows.sort((a, b) => (b.sales[latest] ?? -Infinity) - (a.sales[latest] ?? -Infinity));
  return table;
}

// Which filings to read: newest first, a filing only when its own period is not yet reported by a newer
// one on the table's axis (each annual report repeats two or three years, each 10-Q the year-ago quarter).
// A foreign issuer's annual report is a 20-F or 40-F; its interim 6-Ks carry no tagged statements, so it
// has annual history only (IFRS filers tag from fiscal years ending on or after 2017-12-15).
async function collect(cik, filings, { axis, annualFrom = '2008-01-01', quarterFrom, have = [], onRead = () => {} }) {
  const records = have.slice(), done = new Set(records.map((r) => r.accession));
  const covered = (kind) => new Set(records.flatMap((r) => r.facts.filter((x) => onAxis(x[1], axis) && kindOf(x[3], x[4]) === kind).map((x) => x[4])));
  const near = (set, d) => [...set].some((e) => Math.abs(Date.parse(e) - Date.parse(d)) <= 10 * 86400000);
  for (const [forms, kind, from] of [[['10-K', '20-F', '40-F'], 'annual', annualFrom], [['10-Q'], 'quarter', quarterFrom || annualFrom]]) {
    const list = filings.filter((f) => forms.includes(f.form) && f.reportDate >= from).sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filingDate.localeCompare(a.filingDate));
    const seen = new Set(), windowMs = (kind === 'annual' ? 760 : 380) * 86400000;
    const read = async (f) => { const known = new Set(records.flatMap((r) => Object.keys(r.labels || {}))); const rec = await readFiling(cik, f, { wantLabels: (m) => !known.has(m) }); records.push(rec); done.add(rec.accession); onRead(rec); return rec; };
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
const VERSION = '20261106-history2';
const DIR = process.env.SEGMENT_HISTORY_DIR || path.join(__dirname, 'data', 'segment-history');
function load(cik) {
  try { const doc = JSON.parse(fs.readFileSync(path.join(DIR, p.cik(cik) + '.json'), 'utf8')); return doc.version === VERSION && doc.table?.rows?.length >= 2 && doc.table.years?.length ? doc : null; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

module.exports = { VERSION, DIR, load, measureClass, parseInstance, filingFacts, instanceName, readFiling, buildHistory, collect, columnCandidates, kindOf };
