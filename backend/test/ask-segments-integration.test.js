'use strict';
// Real local Mongo persistence; HTTP and extraction fixtures remain deterministic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const fs = require('node:fs');
process.env.SEC_COVERAGE_READ_ONLY = '1';
process.env.SEC_COVERAGE_DISABLE_ON_DEMAND = '1';
require('../ai-chat');
const axios = require('axios'), client = require('../ai-client'), legacy = require('../segments');
const proof = require('../ask-segment-evidence');
const { assertLocalMongo } = require('../../scripts/lib/dev-env');

test('real Mongo persists issuer segment evidence and survives a fresh module load', { timeout: 60000 }, async () => {
    const systemBinary = fs.existsSync('/opt/homebrew/bin/mongod') ? '/opt/homebrew/bin/mongod' : undefined;
    const server = await MongoMemoryServer.create({ binary: { ...(systemBinary ? { systemBinary } : {}) }, instance: { ip: '127.0.0.1' } });
    const uri = server.getUri('ask_segment_release_test');
    assertLocalMongo(uri, 'Ask segment integration test');
    const originals = { get: axios.get, chat: client.chatRaw, latest: legacy.latestTenK };
    const cik = require('../stock-universe').lookup('GOOG').cik;
    const accession = `${cik}-26-000001`;
    const filing = { form: '10-K', date: '2026-02-15', accession, url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/report.htm` };
    const source = { type: 'sec_xbrl_fact', linkage: 'xbrl_fact', cik, taxonomy: 'us-gaap', concept: 'Revenues', rawValue: 100e6,
        unit: 'USD', periodStart: '2025-01-01', periodEnd: '2025-12-31', form: '10-K', filingDate: filing.date, accessionNumber: accession, filingUrl: filing.url };
    const income = { statement: 'income', basis: 'annual', observations: [{ periodEnd: source.periodEnd, currency: 'USD',
        fields: { totalRevenue: { value: source.rawValue, unit: 'USD', sourceIds: ['revenue'] } } }], provenance: { sources: { revenue: source } } };
    const parsed = { periodEnd: source.periodEnd, basisExcerpt: 'Segment revenue (USD in millions)', periodExcerpt: 'Year ended 2025-12-31', segments: [
        { name: 'Cloud', reportedValue: 65, scale: 1e6, currency: 'USD', value: 65e6, sourceExcerpt: 'Cloud revenue 65' },
        { name: 'Devices', reportedValue: 35, scale: 1e6, currency: 'USD', value: 35e6, sourceExcerpt: 'Devices revenue 35' }
    ] };
    const text = [parsed.basisExcerpt, parsed.periodExcerpt, ...parsed.segments.map(s => s.sourceExcerpt), 'Additional operating segment disclosures. '.repeat(20)].join(' ');
    let modelCalls = 0, fetches = 0;
    try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
        const cacheId = `askseg:v2:${cik}:${proof.accession(accession)}`;
        const invalid = { ...proof.normalizeResult(parsed, 'GOOG', cik, filing, { text, anchor: proof.exactAnnualRevenue(filing, income, cik) }), schemaVersion: 1 };
        await mongoose.connection.collection('ask_segments_v2').insertOne({ _id: cacheId, payload: invalid });
        legacy.latestTenK = async () => filing;
        axios.get = async () => { fetches++; return { data: text }; };
        client.chatRaw = async () => { modelCalls++; return { content: JSON.stringify(parsed) }; };
        delete require.cache[require.resolve('../ask-segments')];
        const first = await require('../ask-segments').extractAskSegments('GOOG', income);
        assert.equal(first.verificationStatus, 'source_verified');
        const doc = await mongoose.connection.collection('ask_segments_v2').findOne({ _id: cacheId });
        assert.equal(doc.payload.schemaVersion, 2);
        assert.equal(proof.validCachedPayload(doc.payload, cik, filing, proof.exactAnnualRevenue(filing, income, cik)), true);
        delete require.cache[require.resolve('../ask-segments')];
        const second = await require('../ask-segments').extractAskSegments('GOOGL', income);
        assert.equal(second.cached, true); assert.equal(second.symbol, 'GOOGL');
        assert.equal(second.segments[0].value, first.segments[0].value);
        assert.equal(modelCalls, 1); assert.equal(fetches, 1);
        assert.equal(await mongoose.connection.collection('ask_segments_v2').countDocuments({}), 1);
    } finally {
        axios.get = originals.get; client.chatRaw = originals.chat; legacy.latestTenK = originals.latest;
        await mongoose.disconnect(); await server.stop();
    }
});
