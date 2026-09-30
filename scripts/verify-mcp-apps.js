#!/usr/bin/env node
'use strict';

// End-to-end verification of the production OpenAI Apps MCP endpoint.
//
// Run this AFTER a deploy, from outside the network, before touching the OpenAI
// submission portal. It checks the discovery documents, the MCP handshake, the
// tool contract (annotations, both schemas, names), a real call of every tool,
// the typed error paths, and that no internal metadata leaks into a response.
//
// Usage:
//   node scripts/verify-mcp-apps.js
//   node scripts/verify-mcp-apps.js --url https://www.stockportfolio.pro/mcp/apps
//   SP_API_KEY=sp_live_... node scripts/verify-mcp-apps.js      # spends credits
//   node scripts/verify-mcp-apps.js --key-file ~/.config/stockportfolio/api-key
//   node scripts/verify-mcp-apps.js --review-cases               # +5 tool calls
//
// With no credential it runs on the keyless trial allowance (counts against the
// per-visitor free lookups). The script never writes a credential anywhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const SDK = path.join(__dirname, '..', 'backend', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs');
const { Client } = require(path.join(SDK, 'client', 'index.js'));
const { StreamableHTTPClientTransport } = require(path.join(SDK, 'client', 'streamableHttp.js'));

const TOOL_NAMES = [
    'search_companies', 'get_company_financials', 'get_metric_history', 'search_filings',
    'get_filing_content', 'compare_company_metrics', 'get_financial_change_drivers'
].sort();

// openWorldHint is asserted per tool, not as a set. Six tools reach SEC EDGAR or
// the SEC XBRL API over the public internet (true); search_companies resolves
// against the deployed company catalog only (false).
const OPEN_WORLD = {
    search_companies: false,
    get_company_financials: true,
    get_metric_history: true,
    search_filings: true,
    get_filing_content: true,
    compare_company_metrics: true,
    get_financial_change_drivers: true
};

function parseArgs(argv) {
    const args = {
        url: 'https://www.stockportfolio.pro/mcp/apps',
        keyFile: path.join(os.homedir(), '.config', 'stockportfolio', 'api-key')
    };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--url') args.url = argv[++i];
        else if (argv[i] === '--key-file') args.keyFile = argv[++i];
        else if (argv[i] === '--review-cases') args.reviewCases = true;
        else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    return args;
}

function readKey(args) {
    if (process.env.SP_API_KEY) return process.env.SP_API_KEY.trim();
    if (process.env.STOCKPORTFOLIO_API_KEY) return process.env.STOCKPORTFOLIO_API_KEY.trim();
    try {
        if (fs.existsSync(args.keyFile)) return fs.readFileSync(args.keyFile, 'utf8').trim();
    } catch (_) { /* no key file */ }
    return '';
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log('Usage: node scripts/verify-mcp-apps.js [--url <mcp-url>] [--key-file <path>] [--review-cases]');
        return 0;
    }
    const base = new URL(args.url);
    const origin = base.origin;
    const key = readKey(args);
    const results = [];
    const check = (name, ok, detail) => {
        results.push({ name, ok: Boolean(ok), detail: detail || '' });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    };

    // --- discovery ----------------------------------------------------------
    const prm = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/apps`).then((r) => r.json()).catch(() => null);
    check('protected-resource metadata advertises the /mcp/apps resource',
        prm && prm.resource === `${origin}/mcp/apps` && Array.isArray(prm.authorization_servers) && prm.scopes_supported.includes('financials:read'),
        prm ? JSON.stringify(prm) : 'unreachable');

    const as = await fetch(`${origin}/.well-known/oauth-authorization-server`).then((r) => r.json()).catch(() => null);
    check('authorization-server metadata supports the code flow, S256 and DCR',
        as && as.code_challenge_methods_supported.includes('S256') && as.registration_endpoint && as.token_endpoint_auth_methods_supported.includes('none')
        && as.scopes_supported.includes('filings:read'),
        as ? `issuer=${as.issuer}` : 'unreachable');

    const challenge = await fetch(`${origin}/.well-known/openai-apps-challenge`);
    const challengeBody = await challenge.text().catch(() => '');
    check('domain challenge endpoint is present or cleanly absent',
        challenge.status === 200 || challenge.status === 404,
        challenge.status === 200 ? 'token configured (not printed)' : 'HTTP 404 — set OPENAI_APPS_CHALLENGE at submission time');
    if (challenge.status === 200) {
        check('domain challenge response is plain text and contains only the token',
            /^text\/plain/.test(challenge.headers.get('content-type') || '') && !/[{}]/.test(challengeBody),
            challenge.headers.get('content-type') || '');
    }

    // --- MCP handshake and tool contract ------------------------------------
    const headers = key ? { Authorization: `Bearer ${key}` } : {};
    const client = new Client({ name: 'verify-mcp-apps', version: '1.0.0' });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(args.url), { requestInit: { headers } }));
    } catch (error) {
        check('MCP endpoint accepts a Streamable HTTP session', false, String(error && error.message || error));
        console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed — the MCP endpoint did not answer, so the tool checks did not run.`);
        return 1;
    }
    console.log(`credential: ${key ? 'API/OAuth key supplied' : 'none (keyless trial allowance)'}`);
    check('MCP endpoint accepts a Streamable HTTP session', true, args.url);

    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    check('tools/list returns exactly the 7 advertised tools', JSON.stringify(names) === JSON.stringify(TOOL_NAMES), names.join(', '));
    let contractOk = true;
    for (const tool of list.tools) {
        const ok = tool.title && tool.description && tool.inputSchema && tool.outputSchema
            && tool.annotations && tool.annotations.readOnlyHint === true
            && tool.annotations.destructiveHint === false
            && tool.annotations.openWorldHint === OPEN_WORLD[tool.name]
            && tool.inputSchema.additionalProperties === false;
        if (!ok) { contractOk = false; console.log(`      ${tool.name}: ${JSON.stringify(tool.annotations)}`); }
    }
    check('every tool carries title, description, both schemas and full annotations', contractOk);

    const call = async (name, argsObj) => {
        const result = await client.callTool({ name, arguments: argsObj });
        const raw = result.content && result.content[0] && result.content[0].text || '';
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* leave null */ }
        return { result, raw, parsed };
    };

    const search = await call('search_companies', { query: 'Apple', limit: 3 });
    check('search_companies resolves Apple to AAPL with CIK',
        search.parsed && search.parsed.companies.some((c) => c.ticker === 'AAPL' && c.cik));

    const financials = await call('get_company_financials', { company: 'AAPL', metrics: ['revenue', 'diluted_eps'], period_type: 'annual', periods: 2 });
    const revenue = financials.parsed && financials.parsed.metrics.find((m) => m.metric === 'revenue');
    check('get_company_financials returns filed values with an SEC source per period',
        revenue && revenue.observations.length === 2 && revenue.observations.every((o) => /^https:\/\/www\.sec\.gov\/Archives\//.test(o.source && o.source.url || '')
            && /^\d{10}-\d{2}-\d{6}$/.test(o.source.accession_number || '')),
        revenue ? `${revenue.observations[0].period_end} = ${revenue.observations[0].value} ${revenue.units}` : 'no revenue series');

    const shares = await call('get_metric_history', { company: 'AAPL', metric: 'diluted_shares', period_type: 'quarterly', periods: 4 });
    check('get_metric_history returns chronological SEC XBRL share counts',
        shares.parsed && shares.parsed.order === 'oldest_first' && shares.parsed.observations.length === 4
        && shares.parsed.observations.some((o) => o.value !== null && o.source && o.source.type === 'sec_xbrl_fact'));

    const filings = await call('search_filings', { company: 'MSFT', forms: ['10-Q'], limit: 3 });
    check('search_filings returns accession numbers and SEC URLs',
        filings.parsed && filings.parsed.filings.length > 0
        && filings.parsed.filings.every((f) => /^\d{10}-\d{2}-\d{6}$/.test(f.accession_number) && /^https:\/\/www\.sec\.gov\//.test(f.source_url)));

    const content = await call('get_filing_content', { company: 'AMZN', form: '10-K', query: 'AWS', max_excerpts: 2, max_chars: 800 });
    check('get_filing_content returns labelled excerpts, never the whole filing',
        content.parsed && content.parsed.excerpts.length > 0 && content.parsed.excerpts.every((e) => e.text.length <= 800)
        && !content.parsed.text && content.parsed.search_scope === 'extracted_sections');

    const compare = await call('compare_company_metrics', { companies: ['MSFT', 'AAPL', 'AMZN'], metrics: ['operating_margin'], period_type: 'annual', periods: 1 });
    check('compare_company_metrics returns one normalized series across companies',
        compare.parsed && compare.parsed.companies.length === 3
        && compare.parsed.metrics[0].units === 'percent'
        && compare.parsed.metrics[0].observations.length === 3);

    const drivers = await call('get_financial_change_drivers', { company: 'MSFT', period_type: 'annual' });
    const bridge = drivers.parsed && drivers.parsed.bridge;
    check('get_financial_change_drivers returns a bridge whose steps close',
        bridge && Object.values(bridge).every((s) => s.check === null || Math.abs(s.check) < 1)
        && drivers.parsed.interpretation === 'observed_change_vs_arithmetic_contribution');

    const badMetric = await call('get_metric_history', { company: 'AAPL', metric: 'definitely_not_a_metric' });
    check('an unsupported metric is a typed UNSUPPORTED_METRIC error',
        badMetric.parsed && badMetric.parsed.code === 'UNSUPPORTED_METRIC' && Array.isArray(badMetric.parsed.supported_metrics));

    const badCompany = await call('get_company_financials', { company: 'ZZQQZZQQ' });
    check('an unknown company is a typed COMPANY_NOT_FOUND error',
        badCompany.parsed && badCompany.parsed.code === 'COMPANY_NOT_FOUND');

    const tooMany = await call('compare_company_metrics', { companies: ['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA'], metrics: ['revenue'] });
    check('more than five companies is refused with TOO_MANY_COMPANIES',
        tooMany.parsed && tooMany.parsed.code === 'TOO_MANY_COMPANIES');

    // --- the five review test cases -----------------------------------------
    // plugin.json's expected_behavior for each positive case IS the contract a
    // reviewer checks against what they see. Those expectations were written
    // from live responses, but the filing pipeline keeps moving, so they can go
    // stale between the day they were captured and the day of review — and a
    // stale expectation reads to the reviewer as a broken tool.
    //
    // Rather than keep a second copy of the figures here (which would drift
    // from the ZIP), each expectation is read out of plugin.json and every
    // date, accession number and value in it is required to appear in the live
    // response. Decimals are deliberately skipped: the prose rounds some of
    // them ("4.28" for 4.275553), so asserting on them would fail on wording
    // rather than on drift. The arguments mirror the prompt the reviewer types.
    if (args.reviewCases) {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openai-plugin', 'plugin.json'), 'utf8'));
        const cases = manifest.extensions['com.openai'].review.test_cases.positive;
        const caseArgs = {
            get_company_financials: { company: 'AAPL', metrics: ['revenue'], period_type: 'annual', periods: 5 },
            search_filings: { company: 'MSFT', forms: ['10-Q'], limit: 1 },
            get_filing_content: { company: 'AMZN', form: '10-K', query: 'AWS', max_excerpts: 3 },
            compare_company_metrics: { companies: ['AMZN', 'MSFT', 'GOOGL'], metrics: ['operating_margin'] },
            get_financial_change_drivers: { company: 'MSFT', period_type: 'annual' }
        };
        for (const testCase of cases) {
            const tool = testCase.tools_triggered;
            const run = await call(tool, caseArgs[tool] || {});
            const haystack = String(run.raw || '').replace(/,/g, '');
            // Dates, accession numbers, and only figures written with thousands
            // separators. That last form is what keeps this honest: a looser
            // "digits and commas" match also swallows years out of "FY2025",
            // fragments out of an accession number, and — worst — a value at
            // the end of a sentence gets truncated to fit a lookahead, so
            // "365,817,000,000." was being checked as the 11-digit
            // "36581700000", which is a substring of the real figure and would
            // have passed no matter what the tool returned.
            const wanted = [...new Set([
                // The boundaries matter: without them the date pattern also
                // matches "3125-26-19" inside the accession number
                // 0001193125-26-191507.
                ...(testCase.expected_behavior.match(/(?<![\d-])\d{4}-\d{2}-\d{2}(?![\d-])/g) || []),
                ...(testCase.expected_behavior.match(/\d{10}-\d{2}-\d{6}/g) || []),
                ...(testCase.expected_behavior.match(/\d{1,3}(?:,\d{3})+/g) || []).map((n) => n.replace(/,/g, ''))
            ])];
            const missing = wanted.filter((token) => !haystack.includes(token));
            // A pass is only worth anything if the comparison can fail. Every
            // token is checked against a copy of itself with its last digit
            // changed; if that still "matches", the figure is being satisfied
            // by something incidental and the case above proves nothing.
            const discriminating = wanted.every((token) => !haystack.includes(token.slice(0, -1) + ((+token.slice(-1) + 1) % 10)));
            check(`review case ${cases.indexOf(testCase) + 1} (${tool}) still returns every figure its expectation records`,
                wanted.length > 0 && missing.length === 0 && discriminating,
                missing.length ? `not found: ${missing.join(', ')}`
                    : (!discriminating ? 'a changed figure still matched — the comparison is not discriminating' : `${wanted.length} figures present`));
        }
    }

    const combined = [search, financials, shares, filings, content, compare, drivers].map((r) => r.raw).join('\n');
    check('no timestamps, internal ids, tokens or debug fields in successful responses',
        !/generatedAt|"timestamp"|traceId|requestId|sessionId|apiKey|Bearer |stack|ECONNREFUSED/i.test(combined));

    await client.close().catch(() => {});

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log('Failed checks:');
        for (const f of failed) console.log(`  - ${f.name}`);
        return 1;
    }
    return 0;
}

module.exports = { main, TOOL_NAMES };

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((error) => {
        console.error('Verification failed:', error && error.message);
        process.exit(1);
    });
}
