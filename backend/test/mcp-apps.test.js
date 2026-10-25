'use strict';

// mcp-apps.js — the OpenAI Apps tool surface (POST /mcp/apps) end to end: a
// real MCP SDK Client over a real Streamable HTTP connection to a real Express
// route, exactly as the OpenAI tool scan sees it.
//
// The SEC is stubbed with small fixtures so the suite is deterministic and runs
// offline; the normalized fundamentals files are the real ones in
// frontend/data/fundamentals/, so the value path is exercised for real.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const axios = require('axios');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const mcpApps = require('../mcp-apps');
const fin = require('../mcp-financials');

const ALL_SCOPES = ['financials:read', 'filings:read', 'research:read'];

// openWorldHint is decided per tool from what the handler actually reaches
// (OpenAI: "accesses the public internet or open-ended external entities"),
// never copied across the set. Six tools query SEC EDGAR / the SEC XBRL API;
// search_companies reads the deployed catalog only — the behavioural test
// below proves it makes no outbound request.
const OPEN_WORLD = {
    search_companies: false,
    get_company_financials: true,
    get_metric_history: true,
    search_filings: true,
    get_filing_content: true,
    compare_company_metrics: true,
    get_financial_change_drivers: true
};

// --- SEC fixtures -----------------------------------------------------------
// Report dates deliberately match the real fiscal periods in the fundamentals
// files (AAPL FY ends 2025-09-27 etc.), so the filing-period link is exercised
// against the same data production serves.
const SUBMISSIONS = {
    '0000320193': {
        filings: {
            recent: {
                accessionNumber: ['0000320193-25-000079', '0000320193-26-000020', '0000320193-24-000123', '0000320193-23-000106'],
                form: ['10-K', '10-Q', '10-K', '10-K'],
                filingDate: ['2025-10-31', '2026-07-31', '2024-11-01', '2023-11-03'],
                reportDate: ['2025-09-27', '2026-06-27', '2024-09-28', '2023-09-30'],
                primaryDocument: ['aapl-20250927.htm', 'aapl-20260627.htm', 'aapl-20240928.htm', 'aapl-20230930.htm'],
                primaryDocDescription: ['10-K', '10-Q', '10-K', '10-K']
            }
        }
    },
    '0000789019': {
        filings: {
            recent: {
                accessionNumber: ['0001193125-26-191507', '0001193125-26-027207'],
                form: ['10-Q', '10-Q'],
                filingDate: ['2026-04-29', '2026-01-28'],
                reportDate: ['2026-03-31', '2025-12-31'],
                primaryDocument: ['msft-20260331.htm', 'msft-20251231.htm'],
                primaryDocDescription: ['10-Q', '10-Q']
            }
        }
    }
};

const SHARE_FACTS = {
    units: {
        shares: [
            { start: '2025-12-28', end: '2026-03-28', val: 14725873000, accn: '0000320193-26-000013', form: '10-Q', filed: '2026-05-01', fy: 2026, fp: 'Q2' },
            { start: '2026-03-29', end: '2026-06-27', val: 14714676000, accn: '0000320193-26-000020', form: '10-Q', filed: '2026-07-31', fy: 2026, fp: 'Q3' },
            { start: '2025-09-28', end: '2025-12-27', val: 14810356000, accn: '0000320193-26-000006', form: '10-Q', filed: '2026-01-30', fy: 2026, fp: 'Q1' },
            { start: '2024-09-29', end: '2025-09-27', val: 15004697000, accn: '0000320193-25-000079', form: '10-K', filed: '2025-10-31', fy: 2025, fp: 'FY' }
        ]
    }
};

const FILLING_HTML = `<html><head><style>.x{}</style></head><body>
<p>Table of contents: Item 1. Business &nbsp; Item 1A. Risk Factors &nbsp; Item 7. Management's Discussion and Analysis</p>
<h2>Item 1. Business</h2><p>${'The Company designs, manufactures and markets products worldwide. '.repeat(8)}</p>
<h2>Item 1A. Risk Factors</h2><p>${'Macroeconomic conditions could materially adversely affect the Company. '.repeat(8)}</p>
<h2>Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations</h2><p>${'AWS growth reflected increased customer usage and commitments. '.repeat(8)}</p>
</body></html>`;

// Installs the SEC stub for one test and clears the module's SEC memo so a
// previous test's cache cannot serve this one.
function stubSec(t) {
    fin._clearMemo();
    t.mock.method(axios, 'get', async (url) => {
        const u = String(url);
        const submissions = /submissions\/CIK(\d{10})\.json/.exec(u);
        if (submissions) {
            const payload = SUBMISSIONS[submissions[1]];
            if (!payload) throw new Error(`no fixture for CIK ${submissions[1]}`);
            return { data: payload };
        }
        if (u.includes('/companyconcept/')) return { data: SHARE_FACTS };
        if (u.includes('sec.gov/Archives/')) return { data: FILLING_HTML };
        throw new Error(`unexpected SEC request in test: ${u}`);
    });
}

function okLimiter() {
    return { check: async () => ({ ok: true }), spend: async () => {} };
}

// Boots the real request handler with a caller under test and returns a live
// MCP client plus the logged events.
async function withClient(t, overrides = {}) {
    stubSec(t);
    const state = { logs: [] };
    const ctx = {
        userId: 'u1',
        user: { _id: 'u1' },
        tier: 'dev',
        subscription: { planId: 'dev' },
        anonymous: false,
        scopes: ALL_SCOPES.slice(),
        logId: 'test',
        ...(overrides.ctx || {})
    };
    const deps = {
        limiter: overrides.limiter || okLimiter(),
        effectiveAskLimit: () => 200,
        entitled: () => (overrides.entitled === undefined ? true : overrides.entitled),
        ...(overrides.resourceMetadataUrl ? { resourceMetadataUrl: overrides.resourceMetadataUrl } : {}),
        ...(overrides.accountNotice ? { accountNotice: overrides.accountNotice } : {}),
        ...(overrides.breadth ? { breadth: overrides.breadth } : {}),
        onLog: (event) => state.logs.push(event)
    };
    const app = express();
    app.post('/mcp/apps', express.json(), async (req, res) => {
        await mcpApps.handleMcpAppsRequest(req, res, ctx, deps);
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/mcp/apps`;
    const client = new Client({ name: 'openai-scan', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    t.after(() => client.close());
    return { client, state, url };
}

function parse(result) {
    return JSON.parse(result.content[0].text);
}

test('tools/list advertises the OpenAI-ready contract: names, titles, both schemas, full annotations', async (t) => {
    const { client } = await withClient(t);
    const { tools } = await client.listTools();
    assert.deepEqual(
        tools.map((tl) => tl.name).sort(),
        ['compare_company_metrics', 'get_company_financials', 'get_filing_content', 'get_financial_change_drivers', 'get_metric_history', 'search_companies', 'search_filings'].sort()
    );
    for (const tl of tools) {
        assert.ok(tl.title, `${tl.name} needs a human-readable title`);
        assert.ok(tl.description.length > 80, `${tl.name} needs a real description`);
        assert.equal(tl.inputSchema.type, 'object', `${tl.name} needs an input schema`);
        assert.equal(tl.outputSchema.type, 'object', `${tl.name} needs an output schema`);
        assert.equal(tl.annotations.readOnlyHint, true, `${tl.name} only reads`);
        assert.equal(tl.annotations.destructiveHint, false, `${tl.name} cannot destroy anything`);
        assert.ok(tl.name in OPEN_WORLD, `${tl.name} needs a declared openWorldHint value — decide it from what the handler reaches`);
        assert.equal(tl.annotations.openWorldHint, OPEN_WORLD[tl.name], `${tl.name} declares openWorldHint ${OPEN_WORLD[tl.name]}`);
        assert.equal(tl.inputSchema.additionalProperties, false, `${tl.name} must not accept undeclared inputs`);
    }
    assert.match(mcpApps.SERVER_INSTRUCTIONS, /search_companies/);
    assert.match(mcpApps.SERVER_INSTRUCTIONS, /never estimated/);
});

test('search_companies returns ticker, name, CIK and exchange without any financial data', async (t) => {
    const { client } = await withClient(t);
    const result = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple', limit: 3 } });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent;
    assert.ok(payload.match_count >= 1);
    const apple = payload.companies.find((c) => c.ticker === 'AAPL');
    assert.ok(apple, 'Apple must resolve to AAPL');
    assert.equal(apple.name, 'Apple Inc.');
    assert.equal(apple.cik, '0000320193');
    assert.equal(apple.exchange, 'Nasdaq');
    assert.equal(payload.companies[0].value, undefined, 'no financial values leak into a company search');
});

// The openWorldHint: false claim for search_companies is only worth anything if
// it is true of the code: with the SEC stub watching every axios.get, the tool
// must answer without making one. If a future edit adds an EDGAR fallback to
// the catalog path, this goes red and the annotation must be revisited with it.
test('search_companies is closed-world: it answers without any outbound request', async (t) => {
    const { client } = await withClient(t);
    const before = axios.get.mock.callCount();
    const result = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple', limit: 3 } });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent.companies.some((c) => c.ticker === 'AAPL'), 'Apple must resolve to AAPL');
    assert.equal(axios.get.mock.callCount(), before,
        'search_companies must not reach the network — that is why it declares openWorldHint: false');
    // Positive control: filing search reaches SEC; stored financial observations stay offline.
    // the assertion above could pass on a dead stub.
    await client.callTool({ name: 'search_filings', arguments: { company: 'AAPL', limit: 1 } });
    assert.ok(axios.get.mock.callCount() > before,
        'search_filings reaches SEC over the network');
});

test('get_company_financials returns filed values with the filing that reports each period', async (t) => {
    const { client } = await withClient(t);
    const result = await client.callTool({
        name: 'get_company_financials',
        arguments: { company: 'AAPL', metrics: ['revenue', 'diluted_eps'], period_type: 'annual', periods: 3 }
    });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent;
    assert.equal(payload.company.ticker, 'AAPL');
    const revenue = payload.metrics.find((m) => m.metric === 'revenue');
    assert.equal(revenue.units, 'USD');
    assert.equal(revenue.observations.length, 3);
    const latest = revenue.observations[0];
    // The real FY2025 figure from frontend/data/fundamentals/AAPL.json.
    assert.equal(latest.value, 416161000000);
    assert.equal(latest.period_end, '2025-09-27');
    assert.match(latest.source.url, /^https:\/\/www\.sec\.gov\/Archives\//);
    assert.equal(latest.source.accession_number, '0000320193-25-000079');
    assert.equal(latest.source.form, '10-K');
    assert.equal(latest.source.linkage,'xbrl_fact');assert.equal(latest.source.rawValue,latest.value);
});

test('get_metric_history returns a single metric oldest-first, including SEC-derived share counts', async (t) => {
    const { client } = await withClient(t);
    const result = await client.callTool({
        name: 'get_metric_history',
        arguments: { company: 'AAPL', metric: 'diluted_shares', period_type: 'quarterly', periods: 4 }
    });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent;
    assert.equal(payload.metric, 'diluted_shares');
    assert.equal(payload.units, 'shares');
    assert.equal(payload.order, 'oldest_first');
    assert.equal(payload.observations.length, 4);
    const dates = payload.observations.map((o) => o.period_end);
    assert.deepEqual(dates, [...dates].sort(), 'chronological order');
    const filed = payload.observations.filter((o) => o.value !== null);
    assert.equal(filed.length, 3, 'three directly reported quarters have verified shares; annual shares cannot supply the missing Q4');
    assert.equal(payload.observations.filter(o=>o.value===null).length, 1);
    for (const o of filed) {
        assert.equal(o.source.type, 'sec_xbrl_fact');
        assert.match(o.source.accession_number, /^\d{10}-\d{2}-\d{6}$/);
        assert.match(o.source.url, /^https:\/\/www\.sec\.gov\/Archives\//);
    }
    assert.ok(filed.every(o=>o.source?.periodEnd===o.period_end));
    assert.ok(!filed.some(o=>o.period_end==='2025-09-27'),'the annual weighted average is never substituted for Q4; its absent quarterly value remains null');
});

test('comparison accepts 2-5 companies and refuses more', async (t) => {
    const { client } = await withClient(t);
    const good = await client.callTool({
        name: 'compare_company_metrics',
        arguments: { companies: ['MSFT', 'AAPL'], metrics: ['operating_margin'], period_type: 'annual', periods: 1 }
    });
    assert.equal(good.isError, undefined);
    assert.equal(good.structuredContent.companies.length, 2);
    assert.equal(good.structuredContent.metrics[0].units, 'percent');
    assert.equal(good.structuredContent.metrics[0].observations.length, 2);
    assert.ok(good.structuredContent.notes.some((n) => /fiscal period-end/.test(n)), 'different period ends are flagged');

    // One series holds every company's values, so each value has to name its
    // company; and the flag is about the widest gap in the set, so a company
    // that is neither first nor last in the list still has to raise it.
    const mixed = await client.callTool({
        name: 'compare_company_metrics',
        arguments: { companies: ['AMZN', 'MSFT', 'GOOGL'], metrics: ['operating_margin'], period_type: 'annual', periods: 1 }
    });
    assert.equal(mixed.isError, undefined);
    assert.deepEqual(
        mixed.structuredContent.metrics[0].observations.map((o) => o.ticker).sort(),
        ['AMZN', 'GOOGL', 'MSFT'],
        'every value names the company it belongs to'
    );
    assert.ok(mixed.structuredContent.notes.some((n) => /fiscal period-end/.test(n)),
        'a misaligned company is flagged even when it is neither first nor last');

    const tooMany = await client.callTool({
        name: 'compare_company_metrics',
        arguments: { companies: ['MSFT', 'AAPL', 'AMZN', 'GOOGL', 'META', 'NVDA'], metrics: ['revenue'] }
    });
    assert.equal(tooMany.isError, true);
    const err = parse(tooMany);
    assert.equal(err.code, 'TOO_MANY_COMPANIES');
    assert.equal(err.maximum, 5);
});

test('search_filings returns metadata and an absolute SEC URL; invalid date is a typed error', async (t) => {
    const { client } = await withClient(t);
    const result = await client.callTool({
        name: 'search_filings',
        arguments: { company: 'MSFT', forms: ['10-Q'], limit: 2 }
    });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent;
    assert.equal(payload.filings.length, 2);
    for (const filing of payload.filings) {
        assert.match(filing.source_url, /^https:\/\/www\.sec\.gov\//);
        assert.match(filing.accession_number, /^\d{10}-\d{2}-\d{6}$/);
        assert.ok(filing.filing_date);
    }
    const bad = await client.callTool({
        name: 'search_filings',
        arguments: { company: 'MSFT', start_date: 'not-a-date' }
    });
    assert.equal(bad.isError, true);
    assert.equal(parse(bad).code, 'INVALID_PERIOD');
});

test('get_filing_content returns a section only, never the document, and validates the section name', async (t) => {
    const { client } = await withClient(t);
    const result = await client.callTool({
        name: 'get_filing_content',
        arguments: { company: 'AAPL', form: '10-K', section: 'Risk Factors', max_chars: 800 }
    });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent;
    assert.equal(payload.section.key, '1A');
    assert.ok(payload.text.length <= 800);
    assert.match(payload.text, /Macroeconomic conditions/);
    assert.match(payload.filing.source_url, /^https:\/\/www\.sec\.gov\//);
    assert.ok(payload.available_sections.length >= 3);
    assert.ok(!/Item 7\./.test(payload.text), 'a section request does not return the rest of the filing');

    const search = await client.callTool({
        name: 'get_filing_content',
        arguments: { company: 'AAPL', form: '10-K', query: 'AWS', max_excerpts: 2, max_chars: 300 }
    });
    assert.equal(search.isError, undefined);
    assert.equal(search.structuredContent.search_scope, 'extracted_sections');
    assert.equal(search.structuredContent.excerpts[0].section, '7', 'the excerpt is labelled with the section it came from');

    const badSection = await client.callTool({
        name: 'get_filing_content',
        arguments: { company: 'AAPL', form: '10-K', section: 'Executive Compensation' }
    });
    assert.equal(badSection.isError, true);
    const err = parse(badSection);
    assert.equal(err.code, 'UNSUPPORTED_SECTION');
    assert.ok(Array.isArray(err.available_sections) && err.available_sections.length >= 3);
});

test('get_financial_change_drivers returns an arithmetic bridge that closes', async (t) => {
    const { client } = await withClient(t);
    const result = await client.callTool({
        name: 'get_financial_change_drivers',
        arguments: { company: 'MSFT', period_type: 'annual' }
    });
    assert.equal(result.isError, undefined);
    const payload = result.structuredContent;
    assert.ok(payload.observed.revenue.change !== null);
    assert.equal(typeof payload.bridge.net_income.change, 'number');
    for (const step of Object.values(payload.bridge)) {
        if (step.check === null || step.check === undefined) continue;
        assert.ok(Math.abs(step.check) < 1, `bridge step must close, residual ${step.check}`);
    }
    assert.equal(payload.interpretation, 'observed_change_vs_arithmetic_contribution');
    assert.ok(payload.notes.some((n) => /not a causal claim/.test(n)));
});

test('unknown company, unknown metric and malformed arguments produce typed, actionable errors', async (t) => {
    const { client } = await withClient(t);
    const noSuch = await client.callTool({ name: 'get_company_financials', arguments: { company: 'ZZZZZZQQ' } });
    assert.equal(noSuch.isError, true);
    assert.equal(parse(noSuch).code, 'COMPANY_NOT_FOUND');

    const badMetric = await client.callTool({ name: 'get_metric_history', arguments: { company: 'AAPL', metric: 'ebitda_margin_thing' } });
    assert.equal(badMetric.isError, true);
    const metricErr = parse(badMetric);
    assert.equal(metricErr.code, 'UNSUPPORTED_METRIC');
    assert.ok(Array.isArray(metricErr.supported_metrics) && metricErr.supported_metrics.includes('revenue'));

    const missing = await client.callTool({ name: 'search_companies', arguments: {} });
    assert.equal(missing.isError, true);
    assert.equal(parse(missing).code, 'COMPANY_REQUIRED');

    const badFiling = await client.callTool({ name: 'get_filing_content', arguments: { company: 'AAPL', accession_number: 'nope' } });
    assert.equal(badFiling.isError, true);
    assert.equal(parse(badFiling).code, 'FILING_NOT_FOUND');
});

test('an unentitled connection gets a commerce-neutral entitlement error and is never charged', async (t) => {
    let spent = 0;
    const { client } = await withClient(t, {
        entitled: false,
        limiter: { check: async () => ({ ok: true }), spend: async () => { spent += 1; } }
    });
    const result = await client.callTool({ name: 'get_company_financials', arguments: { company: 'AAPL' } });
    assert.equal(result.isError, true);
    const payload = parse(result);
    assert.equal(payload.code, 'ENTITLEMENT_REQUIRED');
    assert.equal(payload.error, mcpApps.MSG_ENTITLEMENT);
    // OpenAI plugin guidelines: no plan names, prices, checkout or upgrade links.
    assert.doesNotMatch(payload.error, /\$|\/upgrade|\/recharge|plan|subscribe/i);
    assert.equal(spent, 0, 'a refused call spends nothing');
});

test('an exhausted allowance gets the neutral message, not the legacy upsell', async (t) => {
    const { client } = await withClient(t, {
        limiter: { check: async () => ({ ok: false, message: 'Dev plan is $200/month: https://x/signup' }), spend: async () => {} }
    });
    const result = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(result.isError, true);
    const payload = parse(result);
    assert.equal(payload.code, 'QUOTA_EXCEEDED');
    assert.equal(payload.error, mcpApps.MSG_ALLOWANCE);
    assert.doesNotMatch(payload.error, /\$|\/upgrade|\/recharge|plan|subscribe/i);
});

test('a keyless trial caller gets its own neutral message, never a plan promotion', async (t) => {
    const { client } = await withClient(t, {
        ctx: { anonymous: true, user: null, subscription: null, tier: 'free' },
        limiter: { check: async () => ({ ok: false, message: 'Dev plan is $200/month: https://x/signup' }), spend: async () => {} }
    });
    const result = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(result.isError, true);
    const payload = parse(result);
    assert.equal(payload.error, mcpApps.MSG_TRIAL);
    assert.doesNotMatch(payload.error, /\$|\/upgrade|\/recharge|plan|subscribe/i);
});

test('an OAuth token without the required scope is refused, and its valid scope is allowed', async (t) => {
    const { client } = await withClient(t, { ctx: { scopes: ['financials:read'] } });
    const refused = await client.callTool({ name: 'search_filings', arguments: { company: 'AAPL' } });
    assert.equal(refused.isError, true);
    assert.equal(parse(refused).code, 'INSUFFICIENT_SCOPE');
    const allowed = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(allowed.isError, undefined);
});

test('responses carry no timestamps, identifiers, tokens or debug fields', async (t) => {
    const { client } = await withClient(t);
    const result = await client.callTool({ name: 'get_company_financials', arguments: { company: 'MSFT', periods: 1 } });
    const raw = result.content[0].text;
    assert.doesNotMatch(raw, /generatedAt|timestamp|traceId|requestId|sessionId|stack|apiKey|token/i);
    const payload = JSON.parse(raw);
    assert.deepEqual(Object.keys(payload).sort(), ['company','coverage','freshness','metrics','order','period_type','supplementalObservations']);
    const keys = Object.keys(payload.metrics[0].observations[0]).sort();
    for (const key of keys) {
        assert.ok(['currency', 'derived_from', 'label', 'metric', 'note', 'period_end', 'period_type', 'source', 'units', 'value'].includes(key), `unexpected observation field ${key}`);
    }
});

test('a data-layer exception is reported as a generic upstream error and logged without leaking', async (t) => {
    const original = fin.companyFinancials;
    t.after(() => { fin.companyFinancials = original; });
    fin.companyFinancials = async () => { throw new Error('ECONNREFUSED 10.0.0.5:27017 mongo'); };
    const { client, state } = await withClient(t);
    const result = await client.callTool({ name: 'get_company_financials', arguments: { company: 'AAPL' } });
    assert.equal(result.isError, true);
    const payload = parse(result);
    assert.equal(payload.code, 'UPSTREAM_DATA_ERROR');
    assert.equal(payload.error, 'The request could not be completed right now. Try again shortly.');
    assert.doesNotMatch(JSON.stringify(payload), /ECONNREFUSED|mongo|10\.0\.0\.5/);
    assert.ok(state.logs.some((l) => l.tool === 'get_company_financials' && l.ok === false), 'the failure is instrumented');
});

test('the allowance is checked before any data work, so a refused call costs nothing', async (t) => {
    let called = 0;
    const original = fin.searchCompanies;
    t.after(() => { fin.searchCompanies = original; });
    fin.searchCompanies = (...args) => { called += 1; return original(...args); };
    const { client } = await withClient(t, {
        limiter: { check: async () => ({ ok: false }), spend: async () => { called += 100; } }
    });
    const result = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(result.isError, true);
    assert.equal(called, 0, 'the handler never ran and nothing was spent');
});

test('wrong-typed arguments are rejected as typed errors, never a crash', async (t) => {
    const { client } = await withClient(t);
    const oneCompany = await client.callTool({ name: 'compare_company_metrics', arguments: { companies: 'AAPL' } });
    assert.equal(oneCompany.isError, true);
    assert.equal(parse(oneCompany).code, 'TOO_FEW_COMPANIES');

    const badPeriods = await client.callTool({
        name: 'compare_company_metrics',
        arguments: { companies: ['AAPL', 'MSFT'], periods: 99 }
    });
    assert.equal(badPeriods.isError, true);
    assert.equal(parse(badPeriods).code, 'INVALID_PERIOD');

    const nullArgs = await client.callTool({ name: 'get_company_financials', arguments: {} });
    assert.equal(nullArgs.isError, true);
    assert.equal(parse(nullArgs).code, 'COMPANY_REQUIRED');

    // Still alive and serving after all of the above.
    const ok = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(ok.isError, undefined);
});

test('an account notice on the ChatGPT app is commerce-neutral and rides in the result', async (t) => {
    const connectorNotices = require('../connector-notices');
    const gate = { ok: true, used: 78, allowance: 100, cost: 2, remaining: 22, resetsAt: '2026-11-01T00:00:00.000Z' };
    const { client } = await withClient(t, {
        limiter: { check: async () => gate, spend: async () => {} },
        accountNotice: (g) => ({ account_notice: connectorNotices.lowBalanceText(g, { neutral: true, lookupCost: 2 }) })
    });
    const result = await client.callTool({ name: 'get_company_financials', arguments: { company: 'AAPL' } });
    assert.ok(!result.isError, result.content[0].text);
    const payload = parse(result);
    assert.match(payload.account_notice, /about 10 more lookups remain/);
    assert.equal(result.structuredContent.account_notice, payload.account_notice, 'clients that read only structured content see it too');
    // OpenAI plugin guidelines: no plan names, prices, checkout or upgrade links.
    assert.doesNotMatch(payload.account_notice, /\$|https?:|\/upgrade|\/recharge|plan|subscribe|credit/i);
    assert.ok(payload.company, 'the financial payload is intact');
});

test('the company cap refuses an over-broad account without charging it', async (t) => {
    let spent = 0;
    const { client, state } = await withClient(t, {
        limiter: { check: async () => ({ ok: true }), spend: async () => { spent += 1; } },
        breadth: { check: async () => ({ ok: false, window: 'month', limit: 250, resetsAt: null, message: 'This account has looked up 250 different companies in the last 30 days, the most allowed.' }), record: async () => {} }
    });
    const result = await client.callTool({ name: 'get_company_financials', arguments: { company: 'AAPL' } });
    assert.equal(result.isError, true);
    assert.equal(parse(result).code, 'COMPANY_LIMIT');
    assert.equal(spent, 0);
    assert.ok(state.logs.some((e) => e.code === 'COMPANY_LIMIT'), 'the refusal is logged for the usage page');
});

// ---------------------------------------------------------------------------
// OpenAI Apps auth contract: per-tool securitySchemes on tools/list, and the
// _meta['mcp/www_authenticate'] challenge that makes the client surface its
// account-linking UI on an anonymous quota refusal.
// ---------------------------------------------------------------------------

test('tools/list declares a per-tool security scheme naming the scope that unlocks it', async (t) => {
    const { url } = await withClient(t);
    // Raw fetch, not the SDK client: the client's Zod parse strips fields the
    // 2025-11-25 SDK does not know, so the wire is the only place the new
    // field can be asserted. What ChatGPT's scanner reads is the wire.
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(res.status, 200);
    // The transport answers SSE; one data: line holds the whole result.
    const dataLine = (await res.text()).split('\n').find((l) => l.startsWith('data: '));
    const { result } = JSON.parse(dataLine.slice(6));
    const byName = new Map(result.tools.map((tl) => [tl.name, tl]));
    for (const [name, scope] of [
        ['search_companies', 'financials:read'],
        ['get_company_financials', 'financials:read'],
        ['get_metric_history', 'financials:read'],
        ['search_filings', 'filings:read'],
        ['get_filing_content', 'filings:read'],
        ['compare_company_metrics', 'research:read'],
        ['get_financial_change_drivers', 'research:read']
    ]) {
        assert.deepEqual(
            byName.get(name).securitySchemes,
            [{ type: 'noauth' }, { type: 'oauth2', scopes: [scope] }],
            `${name} declares the keyless trial and the one scope that unlocks it`
        );
    }
});

test('an anonymous quota refusal carries the sign-in challenge; a keyed one does not', async (t) => {
    const metadataUrl = 'https://www.stockportfolio.pro/.well-known/oauth-protected-resource/mcp/apps';
    const refused = { check: async () => ({ ok: false }), spend: async () => {} };
    const anon = await withClient(t, {
        ctx: { anonymous: true, user: null, subscription: null, tier: 'free' },
        limiter: refused,
        resourceMetadataUrl: metadataUrl
    });
    const result = await anon.client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(result.isError, true);
    assert.equal(parse(result).code, 'QUOTA_EXCEEDED');
    const challenges = result._meta && result._meta['mcp/www_authenticate'];
    assert.ok(Array.isArray(challenges) && challenges.length === 1, 'the refusal carries exactly one challenge');
    assert.match(challenges[0], new RegExp(`resource_metadata="${metadataUrl.replace(/\//g, '\\/')}"`));
    assert.match(challenges[0], /error="insufficient_scope"/);
    // Commerce-neutral, per the plugin guidelines: no plan, price or link.
    assert.match(challenges[0], /Connect a StockPortfolio\.pro account to continue\./);
    assert.doesNotMatch(challenges[0], /\$|upgrade|subscribe|plan=/);

    // A connected account's refusal means something else (its own allowance),
    // so it must not trigger the client's sign-in flow.
    const keyed = await withClient(t, { limiter: refused, resourceMetadataUrl: metadataUrl });
    const keyedResult = await keyed.client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(keyedResult.isError, true);
    assert.equal(keyedResult._meta, undefined, 'a keyed refusal carries no challenge');
});
