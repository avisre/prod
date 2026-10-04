'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.SEC_COVERAGE_READ_ONLY = '1';
process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
require('../ai-chat'); // initialize the established watchdog dependency cycle
const extractor = require('../ask-segments');
const proof = require('../ask-segment-evidence');
const quality = require('../ask-answer-quality');
const universe = require('../stock-universe');
const axios = require('axios'), client = require('../ai-client'), legacy = require('../segments');
const mongoose = require('mongoose'), watchdog = require('../watchdog');
const originals = { get: axios.get, chat: client.chatRaw, latest: legacy.latestTenK, filings: watchdog.fetchRecentFilings, collection: mongoose.connection.collection };
afterEach(() => { axios.get = originals.get; client.chatRaw = originals.chat; legacy.latestTenK = originals.latest;
    watchdog.fetchRecentFilings = originals.filings; mongoose.connection.collection = originals.collection; });
let sequence = 0;
function fixture(symbol = 'AAPL', currency = 'USD', form = '10-K', periodEnd = '2025-12-31') {
    const cik = universe.lookup(symbol).cik;
    const accession = `${cik}-26-${String(++sequence).padStart(6, '0')}`;
    const filing = { form, date: '2026-02-15', accession, url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/report.htm` };
    const source = { type: 'sec_xbrl_fact', linkage: 'xbrl_fact', cik, form, filingDate: filing.date, accessionNumber: accession,
        rawValue: 100e6, unit: currency, periodStart: periodEnd.endsWith('03-31') ? '2024-04-01' : '2025-01-01', periodEnd };
    const income = { statement: 'income', basis: 'annual', observations: [{ periodEnd, currency, fields: { totalRevenue: { value: 100e6, unit: currency, sourceIds: ['revenue'] } } }], provenance: { sources: { revenue: source } } };
    const parsed = { periodEnd, basisExcerpt: `Segment revenue (${currency} in millions)`, periodExcerpt: `Year ended ${periodEnd}`, segments: [
        { name: 'Cloud', reportedValue: 65, scale: 1e6, currency, value: 65e6, sourceExcerpt: 'Cloud revenue 65' },
        { name: 'Devices', reportedValue: 35, scale: 1e6, currency, value: 35e6, sourceExcerpt: 'Devices revenue 35' }
    ] };
    const text = `${parsed.basisExcerpt} ${parsed.periodExcerpt} ${parsed.segments.map(s => s.sourceExcerpt).join(' ')} ` + 'Additional operating segment disclosures. '.repeat(20);
    const anchor = proof.exactAnnualRevenue(filing, income, cik);
    return { symbol, cik, filing, income, parsed, text, context: { text, anchor } };
}
function stub(f) {
    legacy.latestTenK = async () => f.filing;
    axios.get = async () => ({ data: `<html><body>${f.text}</body></html>` });
    client.chatRaw = async () => ({ content: JSON.stringify(f.parsed) });
}

test('a self-authored model quote or incorrect table scale cannot authorize a segment chart', () => {
    const f = fixture();
    assert.equal(proof.normalizeResult(f.parsed, f.symbol, f.cik, f.filing, f.context)?.verificationStatus, 'source_verified');
    const invented = structuredClone(f.parsed);
    invented.segments[0].sourceExcerpt = 'Cloud revenue 65 according to a nonexistent table';
    assert.equal(proof.normalizeResult(invented, f.symbol, f.cik, f.filing, f.context), null);
    const wrongScale = structuredClone(f.parsed);
    wrongScale.segments.forEach(s => { s.scale = 1000; s.value = s.reportedValue * 1000; });
    assert.equal(proof.normalizeResult(wrongScale, f.symbol, f.cik, f.filing, f.context), null);
    const payload = proof.normalizeResult(f.parsed, f.symbol, f.cik, f.filing, f.context);
    payload.schemaVersion = 1;
    assert.equal(quality.segmentEvidence(payload, f.income).status, 'unverified');
});

test('reconciliation requires raw XBRL value, annual duration, issuer, exact filing and native currency', () => {
    const f = fixture('BABA', 'CNY', '20-F', '2025-03-31');
    const payload = proof.normalizeResult(f.parsed, f.symbol, f.cik, f.filing, f.context);
    assert.equal(quality.segmentEvidence(payload, f.income).status, 'eligible');
    for (const [field, value] of [['rawValue', 99e6], ['periodStart', '2025-01-01'], ['cik', '0000000001'], ['unit', 'USD'], ['filingDate', '2026-02-14']]) {
        const altered = structuredClone(f.income); altered.provenance.sources.revenue[field] = value;
        assert.equal(quality.segmentEvidence(payload, altered).status, 'unverified', field);
    }
    const legacyPayload = { ...payload, schemaVersion: 1, sankeyEvidence: { status: 'eligible', currency: 'CNY' } };
    assert.equal(quality.verifiedSegmentEvidence([{ tool: 'get_segments', result: legacyPayload }]).status, 'unverified');
});

test('annual comparative facts use the filing report period and cannot replace missing current revenue', () => {
    const f = fixture();
    const income = structuredClone(f.income);
    const previous = structuredClone(income.observations[0]);
    previous.periodEnd = '2024-12-31'; previous.fields.totalRevenue = { value: 80e6, unit: 'USD', sourceIds: ['prior'] };
    income.observations.push(previous);
    income.provenance.sources.prior = { ...income.provenance.sources.revenue, rawValue: 80e6, periodStart: '2024-01-01', periodEnd: '2024-12-31' };
    income.coverage = { latestAnnual: { accessionNumber: f.filing.accession, reportDate: '2025-12-31' } };
    assert.equal(proof.exactAnnualRevenue(f.filing, income, f.cik).value, 100e6);
    const payload = proof.normalizeResult(f.parsed, f.symbol, f.cik, f.filing, { text: f.text, anchor: proof.exactAnnualRevenue(f.filing, income, f.cik) });
    assert.equal(quality.segmentEvidence(payload, income).status, 'eligible');
    income.observations.shift();
    assert.equal(proof.exactAnnualRevenue(f.filing, income, f.cik), null);
    assert.equal(quality.verifiedSegmentEvidence([{ tool: 'get_segments', result: { error: 'Exact annual period revenue is unavailable.' } }]).reason, 'Exact annual period revenue is unavailable.');
});

test('real extractor path uses literal SEC text and skips a disconnected database cache', async () => {
    const f = fixture(); stub(f);
    const result = await extractor.extractAskSegments(f.symbol, f.income);
    assert.equal(result.schemaVersion, 2); assert.equal(result.segments[0].value, 65e6);
    assert.equal(quality.segmentEvidence(result, f.income).status, 'eligible');
    assert.ok(result.evidence.documentDigest);
});

test('segment research uses the verified latest report period rather than a later filing for an obsolete year', async () => {
    const f = fixture('MSFT'); stub(f);
    f.income.coverage = { annualReportingStatus: 'recent_annual', latestAnnual: { form: f.filing.form, filingDate: f.filing.date,
        reportDate: f.parsed.periodEnd, accessionNumber: f.filing.accession, primaryDocument: 'report.htm', filingUrl: f.filing.url } };
    legacy.latestTenK = async () => { throw Error('The verified annual report is already selected by report period.'); };
    const result = await extractor.extractAskSegments(f.symbol, f.income);
    assert.equal(result.verificationStatus, 'source_verified');
    assert.equal(result.periodEnd, f.parsed.periodEnd);
    assert.equal(result.filing.url, f.filing.url);
});

test('Mongo cache reads reject the old proof contract and persist v2 evidence under an issuer key', async () => {
    const f = fixture('BABA', 'CNY', '20-F', '2025-03-31'); stub(f);
    const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });
    let writes = 0, modelCalls = 0;
    mongoose.connection.collection = name => {
        assert.equal(name, 'ask_segments_v2');
        return {
            findOne: async (query, options) => {
                assert.match(query._id, new RegExp(`^askseg:v2:${f.cik}:`)); assert.equal(options.maxTimeMS, 1500);
                return { payload: { ...proof.normalizeResult(f.parsed, f.symbol, f.cik, f.filing, f.context), schemaVersion: 1 } };
            },
            updateOne: async (query, update, options) => {
                writes++; assert.equal(options.upsert, true); assert.equal(options.maxTimeMS, 1500);
                assert.equal(update.$set.payload.schemaVersion, 2);
                assert.equal(proof.validCachedPayload(update.$set.payload, f.cik, f.filing, f.context.anchor), true);
            }
        };
    };
    client.chatRaw = async () => { modelCalls++; return { content: JSON.stringify(f.parsed) }; };
    try {
        const result = await extractor.extractAskSegments(f.symbol, f.income);
        assert.equal(result.schemaVersion, 2); assert.equal(modelCalls, 1); assert.equal(writes, 1);
    } finally {
        if (descriptor) Object.defineProperty(mongoose.connection, 'readyState', descriptor);
        else delete mongoose.connection.readyState;
    }
});

test('simultaneous share classes share one extraction and retain the requested ticker', async () => {
    const f = fixture('GOOG'); stub(f);
    assert.equal(universe.lookup('GOOGL').cik, f.cik);
    let calls = 0, release;
    axios.get = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { data: f.text }; };
    const first = extractor.extractAskSegments('GOOG', f.income), second = extractor.extractAskSegments('GOOGL', f.income);
    await new Promise(resolve => setImmediate(resolve)); release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1); assert.equal(results[0].symbol, 'GOOG'); assert.equal(results[1].symbol, 'GOOGL');
});

test('segment research bounds active issuers and preserves structured busy responses', async () => {
    const fixtures = [fixture('AAPL'), fixture('META'), fixture('MSFT')];
    legacy.latestTenK = async symbol => fixtures.find(f => f.symbol === symbol).filing;
    const releases = [];
    axios.get = async url => { await new Promise(resolve => releases.push(resolve)); return { data: fixtures.find(f => f.filing.url === url).text }; };
    client.chatRaw = async () => ({ content: JSON.stringify(fixtures[0].parsed) });
    const active = fixtures.slice(0, 2).map(f => extractor.extractAskSegments(f.symbol, f.income));
    await new Promise(resolve => setImmediate(resolve));
    const busy = await extractor.extractAskSegments(fixtures[2].symbol, fixtures[2].income);
    assert.equal(busy.retryable, true); assert.equal(busy.code, 'VERIFIED_FINANCIALS_UNAVAILABLE');
    releases.forEach(resolve => resolve()); await Promise.all(active);
});

test('SEC text failures have a cooldown and unavailable revenue does not call the model', async () => {
    const f = fixture('CAT'); stub(f);
    let calls = 0; axios.get = async () => { calls++; throw new Error('timeout'); };
    const first = await extractor.extractAskSegments(f.symbol, f.income);
    const second = await extractor.extractAskSegments(f.symbol, f.income);
    assert.equal(first.code, 'VERIFIED_FINANCIALS_UNAVAILABLE'); assert.equal(second.code, first.code); assert.equal(calls, 1);
    const missing = fixture('PGR'); stub(missing);
    client.chatRaw = async () => { throw new Error('model must not be called'); };
    const result = await extractor.extractAskSegments(missing.symbol, { error: 'No verified annual facts.' });
    assert.equal(result.code, 'VERIFIED_FINANCIALS_UNAVAILABLE');
});

test('legacy company-page segment consumers retain revenueUsd in both cached and fresh responses', async () => {
    const f = fixture();
    const segments = [{ name: 'Cloud', revenueUsd: 260e9, revenuePct: 65, description: 'Cloud services' }, { name: 'Devices', revenueUsd: 140e9, revenuePct: 35, description: 'Devices' }];
    watchdog.fetchRecentFilings = async () => [f.filing];
    let hit = { payload: { symbol: 'AAPL', segments } };
    mongoose.connection.collection = name => {
        assert.equal(name, 'company_segments');
        return { findOne: async () => hit, updateOne: async () => ({ acknowledged: true }) };
    };
    axios.get = async () => ({ data: f.text });
    client.chatRaw = async () => ({ content: JSON.stringify({ fiscalYear: '2025', basis: 'USD', segments }) });
    const cached = await legacy.extractSegments('AAPL'); hit = null;
    const fresh = await legacy.extractSegments('AAPL');
    for (const result of [cached, fresh]) {
        assert.equal(result.segments[0].revenueUsd, 260e9);
        assert.equal(result.segments[0].value, undefined);
        assert.equal(result.filing.accessionNumber, f.filing.accession);
    }
});
