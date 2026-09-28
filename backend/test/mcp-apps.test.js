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
        onLog: (event) => state.logs.push(event)
    };
    const app = express();
    app.post('/mcp/apps', express.json(), async (req, res) => {
        await mcpApps.handleMcpAppsRequest(req, res, ctx, deps);
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const client = new Client({ name: 'openai-scan', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp/apps`)));
    t.after(() => client.close());
    return { client, state };
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
        assert.equal(tl.annotations.openWorldHint, true, `${tl.name} reads public SEC/market data`);
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
    assert.equal(apple.exchange, 'NasdaqGS');
    assert.equal(payload.companies[0].value, undefined, 'no financial values leak into a company search');
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
    assert.equal(latest.period_end, '2025-09-30');
    assert.match(latest.source.url, /^https:\/\/www\.sec\.gov\/Archives\//);
    assert.equal(latest.source.accession_number, '0000320193-25-000079');
    assert.equal(latest.source.form, '10-K');
    assert.ok(['filing_period', 'xbrl_fact'].includes(latest.source.linkage));
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
    assert.equal(filed.length, 3, 'three of the four periods have a discrete filed fact');
    for (const o of filed) {
        assert.equal(o.source.type, 'sec_xbrl_fact');
        assert.match(o.source.accession_number, /^\d{10}-\d{2}-\d{6}$/);
        assert.match(o.source.url, /^https:\/\/www\.sec\.gov\/Archives\//);
    }
    const missing = payload.observations.find((o) => o.value === null);
    assert.ok(missing && missing.note, 'a period with no filed value says why, and is never estimated');
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
        limiter: { check: async () => ({ ok: false, message: 'Dev plan is $19.99/month: https://x/signup' }), spend: async () => {} }
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
        limiter: { check: async () => ({ ok: false, message: 'Dev plan is $19.99/month: https://x/signup' }), spend: async () => {} }
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
    assert.deepEqual(Object.keys(payload).sort(), ['company', 'metrics', 'order', 'period_type']);
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
