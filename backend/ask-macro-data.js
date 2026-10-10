'use strict';

// get_economic_data: dated US government economic series for Ask.
//
// Source order: the FRED API (FRED_API_KEY), then FRED's keyless CSV download,
// then the BLS API (BLS_API_KEY) for the series BLS itself publishes. Every
// series is kept in memory and in Mongo and re-read at most every few hours,
// so the number of upstream requests follows the number of distinct series,
// never the number of people asking. When every source refuses, the last kept
// value is returned with its own date.
//
// Measured 2026-10-10: keyed FRED answered observations, search, series
// details and 30 back-to-back calls; the keyless CSV answered all ten series
// tried; BLS allows 500 queries a day with a key and 25 without, which is why
// BLS is a backup and is never called without one.
//
// Only series published by US government bodies are listed. Privately owned
// series that FRED redistributes (consumer sentiment, mortgage surveys, index
// providers) need their owner's permission and are refused in search.

const mongoose = require('mongoose');

const TTL_MS = 3 * 60 * 60 * 1000, COLLECTION = 'ask_macro_cache', MAX_SERIES_PER_CALL = 6;
const NOTICE = 'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.';
// kind: percent (the value is a percentage), usd (scale gives raw dollars),
// level (a count or an index; yoy says whether its yearly change is the headline).
const CATALOG = {
    unemployment_rate: { id: 'UNRATE', title: 'Unemployment rate', agency: 'Bureau of Labor Statistics', kind: 'percent', freq: 'M', bls: 'LNS14000000' },
    nonfarm_payrolls: { id: 'PAYEMS', title: 'Total nonfarm payroll employment', agency: 'Bureau of Labor Statistics', kind: 'level', unit: 'thousands of jobs', freq: 'M', bls: 'CES0000000001' },
    labor_force_participation: { id: 'CIVPART', title: 'Labor force participation rate', agency: 'Bureau of Labor Statistics', kind: 'percent', freq: 'M' },
    average_hourly_earnings: { id: 'CES0500000003', title: 'Average hourly earnings, private employees', agency: 'Bureau of Labor Statistics', kind: 'usd', scale: 1, unit: 'USD per hour', freq: 'M', yoy: true },
    job_openings: { id: 'JTSJOL', title: 'Job openings (JOLTS)', agency: 'Bureau of Labor Statistics', kind: 'level', unit: 'thousands of openings', freq: 'M' },
    jobless_claims: { id: 'ICSA', title: 'Initial jobless claims', agency: 'Department of Labor', kind: 'level', unit: 'claims', freq: 'W' },
    continuing_claims: { id: 'CCSA', title: 'Continuing jobless claims', agency: 'Department of Labor', kind: 'level', unit: 'claims', freq: 'W' },
    cpi_inflation: { id: 'CPIAUCSL', title: 'Consumer Price Index, all items', agency: 'Bureau of Labor Statistics', kind: 'level', unit: 'index 1982-84=100', freq: 'M', yoy: true, bls: 'CUSR0000SA0' },
    core_cpi_inflation: { id: 'CPILFESL', title: 'Consumer Price Index excluding food and energy', agency: 'Bureau of Labor Statistics', kind: 'level', unit: 'index 1982-84=100', freq: 'M', yoy: true },
    pce_inflation: { id: 'PCEPI', title: 'PCE price index', agency: 'Bureau of Economic Analysis', kind: 'level', unit: 'index 2017=100', freq: 'M', yoy: true },
    core_pce_inflation: { id: 'PCEPILFE', title: 'PCE price index excluding food and energy', agency: 'Bureau of Economic Analysis', kind: 'level', unit: 'index 2017=100', freq: 'M', yoy: true },
    producer_prices: { id: 'PPIFIS', title: 'Producer Price Index, final demand', agency: 'Bureau of Labor Statistics', kind: 'level', unit: 'index Nov 2009=100', freq: 'M', yoy: true },
    fed_funds_rate: { id: 'FEDFUNDS', title: 'Effective federal funds rate (monthly average)', agency: 'Federal Reserve Board', kind: 'percent', freq: 'M' },
    fed_target_upper: { id: 'DFEDTARU', title: 'Federal funds target range, upper limit', agency: 'Federal Reserve Board', kind: 'percent', freq: 'D' },
    fed_target_lower: { id: 'DFEDTARL', title: 'Federal funds target range, lower limit', agency: 'Federal Reserve Board', kind: 'percent', freq: 'D' },
    gdp: { id: 'GDP', title: 'Gross domestic product, current dollars, annual rate', agency: 'Bureau of Economic Analysis', kind: 'usd', scale: 1e9, unit: 'USD', freq: 'Q' },
    real_gdp_growth: { id: 'A191RL1Q225SBEA', title: 'Real GDP growth, quarter on quarter, annualised', agency: 'Bureau of Economic Analysis', kind: 'percent', freq: 'Q' },
    real_gdp: { id: 'GDPC1', title: 'Real gross domestic product, chained 2017 dollars, annual rate', agency: 'Bureau of Economic Analysis', kind: 'usd', scale: 1e9, unit: 'chained 2017 USD', freq: 'Q', yoy: true },
    treasury_3m: { id: 'DGS3MO', title: '3-month Treasury yield', agency: 'Federal Reserve Board (H.15)', kind: 'percent', freq: 'D' },
    treasury_2y: { id: 'DGS2', title: '2-year Treasury yield', agency: 'Federal Reserve Board (H.15)', kind: 'percent', freq: 'D' },
    treasury_10y: { id: 'DGS10', title: '10-year Treasury yield', agency: 'Federal Reserve Board (H.15)', kind: 'percent', freq: 'D' },
    treasury_30y: { id: 'DGS30', title: '30-year Treasury yield', agency: 'Federal Reserve Board (H.15)', kind: 'percent', freq: 'D' },
    yield_curve_10y_2y: { id: 'T10Y2Y', title: '10-year minus 2-year Treasury yield', agency: 'Federal Reserve Bank of St. Louis from Board data', kind: 'percent', unit: 'percentage points', freq: 'D' },
    retail_sales: { id: 'RSAFS', title: 'Retail and food services sales', agency: 'Census Bureau', kind: 'usd', scale: 1e6, unit: 'USD per month', freq: 'M', yoy: true },
    housing_starts: { id: 'HOUST', title: 'Housing starts, annual rate', agency: 'Census Bureau', kind: 'level', unit: 'thousands of units', freq: 'M' },
    industrial_production: { id: 'INDPRO', title: 'Industrial production index', agency: 'Federal Reserve Board', kind: 'level', unit: 'index 2017=100', freq: 'M', yoy: true },
    m2_money_supply: { id: 'M2SL', title: 'M2 money stock', agency: 'Federal Reserve Board', kind: 'usd', scale: 1e9, unit: 'USD', freq: 'M', yoy: true },
    federal_debt: { id: 'GFDEBTN', title: 'Federal debt: total public debt', agency: 'Treasury Department', kind: 'usd', scale: 1e6, unit: 'USD', freq: 'Q', yoy: true },
    personal_saving_rate: { id: 'PSAVERT', title: 'Personal saving rate', agency: 'Bureau of Economic Analysis', kind: 'percent', freq: 'M' },
    trade_balance: { id: 'BOPGSTB', title: 'Trade balance in goods and services', agency: 'Census Bureau and Bureau of Economic Analysis', kind: 'usd', scale: 1e6, unit: 'USD per month', freq: 'M' }
};
const PUBLIC_SOURCES = /U\.S\. Bureau|Bureau of Labor Statistics|Bureau of Economic Analysis|Census Bureau|Board of Governors|Federal Reserve Bank|U\.S\. Department|Department of the Treasury|Employment and Training Administration|Federal Housing Finance Agency|Energy Information Administration|Congressional Budget Office|Office of Management and Budget/i;

const memory = new Map();
const keyFile = name => {
    try { return require('node:fs').readFileSync(require('node:path').join(require('node:os').homedir(), '.config', 'stockportfolio', name), 'utf8').trim(); }
    catch (_) { return ''; }
};
const fredKey = () => process.env.FRED_API_KEY || (process.env.NODE_ENV === 'production' ? '' : keyFile('fred-api-key'));
const blsKey = () => process.env.BLS_API_KEY || (process.env.NODE_ENV === 'production' ? '' : keyFile('bls-api-key'));
async function http(url, options = {}) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
}
let deps = { http, now: () => Date.now() };

const startDate = (months = 16) => new Date(deps.now() - months * 31 * 86400000).toISOString().slice(0, 10);
const clean = rows => rows.map(r => ({ date: String(r.date), value: Number(r.value) })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value))
    .sort((a, b) => a.date.localeCompare(b.date));
async function fromFredApi(id) {
    const key = fredKey();
    if (!key) throw new Error('no key');
    const json = await (await deps.http(`https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&observation_start=${startDate()}&file_type=json&api_key=${key}`)).json();
    return clean(json.observations || []);
}
async function fromFredCsv(id) {
    const text = await (await deps.http(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${startDate()}`)).text();
    return clean(text.split(/\r?\n/).slice(1).map(line => { const [date, value] = line.split(','); return { date, value }; }));
}
async function fromBls(blsId) {
    const key = blsKey();
    if (!key || !blsId) throw new Error('no key');
    const year = new Date(deps.now()).getUTCFullYear();
    const json = await (await deps.http('https://api.bls.gov/publicAPI/v2/timeseries/data/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesid: [blsId], startyear: String(year - 1), endyear: String(year), registrationkey: key }) })).json();
    if (json.status !== 'REQUEST_SUCCEEDED') throw new Error('BLS refused');
    return clean((json.Results?.series?.[0]?.data || []).filter(d => /^M(0[1-9]|1[0-2])$/.test(d.period)).map(d => ({ date: `${d.year}-${d.period.slice(1)}-01`, value: d.value })));
}
async function readStore(id) {
    if (mongoose.connection.readyState !== 1) return null;
    try { return await mongoose.connection.collection(COLLECTION).findOne({ _id: id }, { maxTimeMS: 1500 }); } catch (_) { return null; }
}
async function writeStore(id, entry) {
    if (mongoose.connection.readyState !== 1) return;
    try { await mongoose.connection.collection(COLLECTION).updateOne({ _id: id }, { $set: { rows: entry.rows, via: entry.via, at: new Date(entry.at) } }, { upsert: true, maxTimeMS: 1500 }); } catch (_) { /* best effort */ }
}
const inflight = new Map();
async function observations(id, blsId) {
    let kept = memory.get(id);
    if (!kept) {
        const doc = await readStore(id);
        if (doc?.rows?.length) { kept = { rows: doc.rows, via: doc.via, at: new Date(doc.at).getTime() }; memory.set(id, kept); }
    }
    if (kept && deps.now() - kept.at < TTL_MS) return { ...kept, stale: false };
    if (inflight.has(id)) return inflight.get(id);
    const load = (async () => {
        for (const [via, read] of [['FRED API', () => fromFredApi(id)], ['FRED download', () => fromFredCsv(id)], ['BLS API', () => fromBls(blsId)]]) {
            try {
                const rows = await read();
                if (!rows.length) continue;
                const entry = { rows, via, at: deps.now() };
                memory.set(id, entry); await writeStore(id, entry);
                return { ...entry, stale: false };
            } catch (_) { /* next source */ }
        }
        return kept ? { ...kept, stale: true } : null;
    })().finally(() => inflight.delete(id));
    inflight.set(id, load);
    return load;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel(date, freq) {
    const [y, m, d] = date.split('-').map(Number);
    if (freq === 'Q') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
    if (freq === 'M') return `${MONTHS[m - 1]} ${y}`;
    return `${d} ${MONTHS[m - 1]} ${y}`;
}
const round = (value, digits = 2) => Number(value.toFixed(digits));
function yearAgoRow(rows, latest, freq) {
    const target = `${Number(latest.date.slice(0, 4)) - 1}${latest.date.slice(4)}`;
    if (freq === 'M' || freq === 'Q') return rows.find(r => r.date === target) || null;
    return rows.filter(r => r.date <= target).pop() || null;
}
function describe(key, spec, got) {
    const rows = got.rows, latest = rows[rows.length - 1], previous = rows[rows.length - 2] || null, yearAgo = yearAgoRow(rows, latest, spec.freq);
    const money = [], percentages = [];
    const out = { indicator: key, seriesId: spec.id, title: spec.title, publishedBy: spec.agency,
        units: spec.kind === 'percent' ? (spec.unit || 'percent') : spec.kind === 'usd' ? `${spec.unit}; raw values are in ${spec.scale === 1 ? 'dollars' : spec.scale === 1e6 ? 'millions of dollars' : 'billions of dollars'}` : spec.unit,
        latest: { period: periodLabel(latest.date, spec.freq), date: latest.date, value: latest.value },
        previous: previous ? { period: periodLabel(previous.date, spec.freq), date: previous.date, value: previous.value, change: round(latest.value - previous.value, 3) } : null,
        yearAgo: yearAgo ? { period: periodLabel(yearAgo.date, spec.freq), date: yearAgo.date, value: yearAgo.value } : null,
        history: rows.slice(-13).map(r => ({ period: periodLabel(r.date, spec.freq), value: r.value })),
        source: `${spec.agency}, retrieved through FRED (Federal Reserve Bank of St. Louis)${got.via === 'BLS API' ? ' and the BLS API' : ''}`,
        sourceUrl: 'https://fred.stlouisfed.org/series/' + spec.id,
        retrievedAt: new Date(got.at).toISOString(),
        ...(got.stale ? { stalenessWarning: 'The source could not be reached just now. These are the last values kept; state the period and say a newer release may exist.' } : {}) };
    if (spec.kind === 'percent') {
        percentages.push(...rows.slice(-13).map(r => r.value));
        if (previous) { out.previous.changePoints = round(latest.value - previous.value, 2); percentages.push(out.previous.changePoints, Math.abs(out.previous.changePoints)); }
        if (yearAgo) { out.yearAgo.changePoints = round(latest.value - yearAgo.value, 2); percentages.push(out.yearAgo.changePoints, Math.abs(out.yearAgo.changePoints)); }
    } else {
        if (previous && previous.value) { out.previous.changePct = round((latest.value / previous.value - 1) * 100, 1); percentages.push(out.previous.changePct, Math.abs(out.previous.changePct)); }
        if (yearAgo && yearAgo.value) {
            out.yearAgo.changePct = round((latest.value / yearAgo.value - 1) * 100, 1); percentages.push(out.yearAgo.changePct, Math.abs(out.yearAgo.changePct));
            if (spec.yoy) out.headline = `${out.yearAgo.changePct}% higher than a year earlier`.replace(/^-(\S+) higher/, '$1 lower');
        }
        if (spec.kind === 'usd') for (const r of [latest, previous, yearAgo]) if (r) money.push(r.value * spec.scale);
        if (spec.kind === 'usd' && previous) money.push((latest.value - previous.value) * spec.scale, Math.abs(latest.value - previous.value) * spec.scale);
    }
    return { out, money, percentages };
}

async function searchSeries(text) {
    const key = fredKey();
    if (!key) return { error: 'That indicator is not in the built-in list and series search is not configured. Use search_web restricted to .gov sources.' };
    try {
        const found = await (await deps.http(`https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(text)}&limit=5&order_by=popularity&sort_order=desc&file_type=json&api_key=${key}`)).json();
        const kept = [];
        for (const s of found.seriess || []) {
            if (kept.length === 3) break;
            if (/copyright/i.test(s.notes || '')) continue;
            const release = await (await deps.http(`https://api.stlouisfed.org/fred/series/release?series_id=${encodeURIComponent(s.id)}&file_type=json&api_key=${key}`)).json().catch(() => null);
            const sources = release?.releases?.[0]?.id ? await (await deps.http(`https://api.stlouisfed.org/fred/release/sources?release_id=${release.releases[0].id}&file_type=json&api_key=${key}`)).json().catch(() => null) : null;
            const names = (sources?.sources || []).map(x => x.name);
            if (!names.length || !names.every(n => PUBLIC_SOURCES.test(n))) continue;
            kept.push({ id: s.id, title: s.title, agency: names.join('; '), freq: /^(D|W|M|Q)/.test(s.frequency_short || '') ? s.frequency_short[0] : 'M',
                kind: /^percent/i.test(s.units || '') ? 'percent' : 'level', unit: s.units });
        }
        return { matches: kept };
    } catch (_) { return { error: 'Series search is unavailable right now.' }; }
}

async function getEconomicData(args = {}) {
    const wanted = [...new Set([].concat(args.indicators || [], args.indicator || []).map(v => String(v || '').trim().toLowerCase()).filter(Boolean))].slice(0, MAX_SERIES_PER_CALL);
    const specs = [];
    for (const key of wanted) {
        if (CATALOG[key]) specs.push([key, CATALOG[key]]);
        else specs.push([key, null]);
    }
    if (args.search) {
        const found = await searchSeries(String(args.search).slice(0, 80));
        if (found.error && !specs.length) return { ...found, availableIndicators: Object.keys(CATALOG) };
        for (const m of (found.matches || []).slice(0, 2)) specs.push([m.id.toLowerCase(), m]);
        if (!specs.length) return { error: `No US government series matched "${args.search}". Use search_web for a .gov source instead.`, availableIndicators: Object.keys(CATALOG) };
    }
    if (!specs.length) return { error: 'Name an indicator or give a search phrase.', availableIndicators: Object.keys(CATALOG) };
    const series = [], money = [], percentages = [], unavailable = [];
    await Promise.all(specs.map(async ([key, spec]) => {
        if (!spec) { unavailable.push({ indicator: key, reason: 'Not a built-in indicator. Retry with search set to a plain description.' }); return; }
        const got = await observations(spec.id, spec.bls);
        if (!got || !got.rows.length) { unavailable.push({ indicator: key, reason: 'The source did not return this series just now.' }); return; }
        const d = describe(key, spec, got);
        series.push(d.out); money.push(...d.money); percentages.push(...d.percentages);
    }));
    if (!series.length) return { error: 'The economic data sources did not respond. Say the figure is unavailable right now; never state one from memory.', unavailable, availableIndicators: Object.keys(CATALOG) };
    series.sort((a, b) => wanted.indexOf(a.indicator) - wanted.indexOf(b.indicator));
    return { series, unavailable, notice: NOTICE,
        note: 'State each figure with its period and the agency that publishes it. These are official releases and may be revised. Do not compute further figures yourself; the changes above are already calculated.',
        claimable: { money: [...new Set(money.filter(Number.isFinite))].map(value => ({ value, unit: 'USD' })), percentages: [...new Set(percentages.filter(Number.isFinite))] } };
}

module.exports = { getEconomicData, CATALOG, NOTICE, TTL_MS, periodLabel,
    __setDeps: next => { deps = { ...deps, ...next }; }, __resetDeps: () => { deps = { http, now: () => Date.now() }; memory.clear(); inflight.clear(); } };
