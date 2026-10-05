'use strict';

// OpenAI Apps / plugin MCP surface — POST /mcp/apps.
//
// This is a second, deliberately small tool contract over the same data layer
// as the shipping /mcp endpoint. /mcp keeps its published sp_* tools for the
// npm bridge and the Claude connector; /mcp/apps is the surface submitted to
// OpenAI's plugin directory, designed around the questions a ChatGPT user
// actually asks (see notes/2026-09-29-openai-plugin-architecture.md).
//
// Contract notes, all driven by the current OpenAI plugin documentation:
//   - Every tool is read-only: readOnlyHint true, destructiveHint false. The
//     server never writes user data, sends messages or executes transactions.
//   - openWorldHint is decided per tool from what the handler actually reaches,
//     as OpenAI's current definition requires ("accesses the public internet or
//     open-ended external entities") — never copied across the set. Six tools
//     query SEC EDGAR / the SEC XBRL API over the public internet, so they are
//     true. search_companies resolves against the deployed company catalog
//     only — a bounded, server-controlled dataset, never the network — so it is
//     false. test/mcp-apps.test.js pins the values and proves the behaviour.
//   - Structured results are returned as `structuredContent` and, for
//     compatibility, the same object JSON-encoded in `content`.
//   - Responses carry no timestamps, session/trace/request ids, debug payloads
//     or auth material. Financial observations are addressed by fiscal period
//     and filing accession instead.
//   - Entitlement and allowance failures explain the limit without naming a
//     plan, quoting a price or linking to a checkout or upgrade page.
//
// Built as a factory: app.js builds one Server per request because the
// transport is stateless, and closes it over the already-resolved caller so a
// tool handler never re-derives identity or entitlement.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fin = require('./mcp-financials');

const SERVER_NAME = 'stockportfolio';
const SERVER_VERSION = '1.0.0';

// Server instructions are reviewed with the tools. The first 512 characters are
// what clients read most closely, so the operational sequence is first.
const SERVER_INSTRUCTIONS = [
    'StockPortfolio.pro provides structured financial data and SEC filing evidence for US-listed public companies.',
    'If a company name is ambiguous, call search_companies first and use the exact ticker it returns.',
    'Financial values carry their reporting period and source URL; cite that source. Supplemental provider figures are separately attributed and must not be described as SEC-verified.',
    'A missing value is returned as null and is never estimated. Reported arithmetic is labelled as such.',
    'Do not treat any output as investment advice, and do not execute transactions.',
    'Tools are read-only and never modify an account.'
].join(' ');

const SOURCE_SCHEMA = {
    type: ['object', 'null'],
    description: 'The filing or explicitly attributed supplemental source behind a value. linkage "xbrl_fact" means the value was read from an SEC XBRL fact with that accession; linkage "derived_from_facts" identifies a calculation with explicit fact inputs. A period-matched filing is contextual metadata and does not prove a value source.',
    properties: {
        type: { type: ['string', 'null'] },
        form: { type: ['string', 'null'] },
        filing_date: { type: ['string', 'null'] },
        report_date: { type: ['string', 'null'] },
        accession_number: { type: ['string', 'null'] },
        url: { type: ['string', 'null'] },
        linkage: { type: ['string', 'null'] }
    },
    additionalProperties: true
};

const OBSERVATION_SCHEMA = {
    type: 'object',
    description: 'One metric value for one fiscal period.',
    properties: {
        metric: { type: 'string' },
        label: { type: 'string' },
        period_type: { type: 'string', enum: ['annual', 'quarterly'] },
        period_end: { type: 'string', description: 'Fiscal period end date (YYYY-MM-DD).' },
        value: { type: ['number', 'null'] },
        units: { type: 'string', description: 'Reported currency code or currency per share, shares or percent; retain the supplied native currency.' },
        currency: { type: ['string', 'null'] },
        derived_from: { type: ['array', 'null'], items: { type: 'string' } },
        source: SOURCE_SCHEMA,
        note: { type: 'string' },
        ticker: { type: 'string', description: 'Company the value belongs to. Set on comparison responses, where several companies share one series.' }
    },
    additionalProperties: true
};

const METRIC_SERIES_SCHEMA = {
    type: 'object',
    properties: {
        metric: { type: 'string' },
        label: { type: 'string' },
        units: { type: 'string' },
        observations: { type: 'array', items: OBSERVATION_SCHEMA }
    },
    additionalProperties: true
};

const COMPANY_SCHEMA = {
    type: 'object',
    properties: {
        ticker: { type: 'string' },
        name: { type: ['string', 'null'] },
        cik: { type: ['string', 'null'] },
        exchange: { type: ['string', 'null'] },
        currency: { type: ['string', 'null'] }
    },
    additionalProperties: true
};

const FILING_SCHEMA = {
    type: 'object',
    properties: {
        form: { type: 'string' },
        filing_date: { type: 'string' },
        report_date: { type: ['string', 'null'] },
        accession_number: { type: 'string' },
        description: { type: ['string', 'null'] },
        source_url: { type: 'string' }
    },
    additionalProperties: true
};

const TOOL_DEFS = [
    {
        name: 'search_companies',
        title: 'Search companies',
        description: 'Resolve a company name or ticker to the US-listed company it refers to. Use this first when a company is named ambiguously, when only a company name is known, or before another tool when the ticker is uncertain. Returns ticker, company name, SEC CIK, sector and index membership. Returns no financial data.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Company name or ticker, for example "Apple", "AAPL" or "Berkshire".' },
                limit: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'Maximum number of matches to return.' }
            },
            required: ['query'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                match_count: { type: 'integer' },
                companies: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            ticker: { type: 'string' },
                            name: { type: ['string', 'null'] },
                            cik: { type: ['string', 'null'] },
                            sector: { type: ['string', 'null'] },
                            index: { type: ['string', 'null'] },
                            exchange: { type: ['string', 'null'] }
                        },
                        additionalProperties: true
                    }
                }
            },
            additionalProperties: true
        },
        // The one closed-world tool on this surface: searchCompanies() reads the
        // deployed catalog JSON files and nothing else, so openWorldHint is
        // false here while every SEC-backed tool declares true.
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        requiredScope: 'financials:read',
        handler: async (args) => {
            const query = String(args.query || '').trim();
            if (!query) throw fin.mcpError('COMPANY_REQUIRED', 'Provide a company name or ticker to search for.');
            const companies = fin.searchCompanies(query, args.limit);
            return { query, match_count: companies.length, companies };
        }
    },
    {
        name: 'get_company_financials',
        title: 'Get company financials',
        description: 'Retrieve standardized historical financial metrics for one publicly traded US company, with the SEC filing that reports each fiscal period. Use for questions about a company\u2019s revenue, profit, margins, earnings per share, share count, cash flow, debt, cash or stock-based compensation over time. Supports annual and quarterly periods. Values are returned as filed; a metric with no reported value is null and is never estimated. Not investment advice.',
        inputSchema: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'Ticker (preferred) or company name.' },
                metrics: {
                    type: 'array',
                    description: 'Metric ids to return. Defaults to revenue, net_income and diluted_eps.',
                    items: { type: 'string' }
                },
                period_type: { type: 'string', enum: ['annual', 'quarterly'], default: 'annual', description: 'Fiscal period type.' },
                periods: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Number of most recent periods to return.' },
                start_period: { type: 'string', description: 'Optional earliest fiscal period end (YYYY-MM-DD).' },
                end_period: { type: 'string', description: 'Optional latest fiscal period end (YYYY-MM-DD).' }
            },
            required: ['company'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                company: COMPANY_SCHEMA,
                period_type: { type: 'string' },
                order: { type: 'string' },
                metrics: { type: 'array', items: METRIC_SERIES_SCHEMA }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        requiredScope: 'financials:read',
        handler: (args) => fin.companyFinancials({
            company: args.company,
            metrics: args.metrics,
            periodType: args.period_type,
            periods: args.periods,
            startPeriod: args.start_period,
            endPeriod: args.end_period
        })
    },
    {
        name: 'get_metric_history',
        title: 'Get one metric history',
        description: 'Return one financial metric as a chronological series for a single company, for example diluted weighted-average shares for the last eight quarters or annual revenue for the last five fiscal years. Every observation carries its fiscal period and the SEC filing source where one exists. Use get_company_financials instead when several metrics are needed at once.',
        inputSchema: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'Ticker (preferred) or company name.' },
                metric: { type: 'string', description: 'Metric id, for example diluted_shares, revenue or operating_margin.' },
                period_type: { type: 'string', enum: ['annual', 'quarterly'], default: 'annual' },
                periods: { type: 'integer', minimum: 1, maximum: 20, default: 8, description: 'Number of most recent periods to return.' }
            },
            required: ['company', 'metric'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                company: COMPANY_SCHEMA,
                metric: { type: 'string' },
                label: { type: 'string' },
                units: { type: 'string' },
                period_type: { type: 'string' },
                order: { type: 'string' },
                observations: { type: 'array', items: OBSERVATION_SCHEMA }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        requiredScope: 'financials:read',
        handler: (args) => fin.metricHistory({
            company: args.company,
            metric: args.metric,
            periodType: args.period_type,
            periods: args.periods
        })
    },
    {
        name: 'search_filings',
        title: 'Search SEC filings',
        description: 'Find SEC filings for one company by form type and date range. Returns each filing\u2019s form, filing date, reporting period, accession number, the SEC document description and a direct SEC source URL. Use this to locate a 10-K, 10-Q, 8-K, 20-F, proxy or other filing; use get_filing_content to read text from one of the results. This searches filing metadata, not the text inside filings.',
        inputSchema: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'Ticker (preferred) or company name.' },
                forms: { type: 'array', items: { type: 'string' }, description: 'Optional form types to include, for example ["10-K"] or ["10-Q","8-K"].' },
                start_date: { type: 'string', description: 'Optional earliest filing date (YYYY-MM-DD).' },
                end_date: { type: 'string', description: 'Optional latest filing date (YYYY-MM-DD).' },
                query: { type: 'string', description: 'Optional text matched against the form type, the SEC document description and the reporting date.' },
                limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
            },
            required: ['company'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                company: { type: 'object', properties: { ticker: { type: 'string' }, name: { type: ['string', 'null'] }, cik: { type: ['string', 'null'] } }, additionalProperties: true },
                match_count: { type: 'integer' },
                filings: { type: 'array', items: FILING_SCHEMA }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        requiredScope: 'filings:read',
        handler: (args) => fin.searchFilings({
            company: args.company,
            forms: args.forms,
            startDate: args.start_date,
            endDate: args.end_date,
            query: args.query,
            limit: args.limit
        })
    },
    {
        name: 'get_filing_content',
        title: 'Read SEC filing excerpts',
        description: 'Retrieve relevant excerpts from one SEC filing instead of the whole document. Request a section by name (for example "Risk Factors", "MD&A" or "Legal Proceedings") or search the filing\u2019s narrative for a term (for example "AWS", "gross margin" or "share repurchases"). Returns short excerpts with the section they came from and the filing URL. Defaults to the company\u2019s latest 10-K; pass a form or an accession number from search_filings to choose another filing. Use this for what management said in a filing, and get_company_financials for numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'Ticker (preferred) or company name.' },
                accession_number: { type: 'string', description: 'Optional SEC accession number from search_filings, for example 0000320193-25-000079.' },
                form: { type: 'string', description: 'Optional form type when no accession number is given, for example 10-K, 10-Q, 20-F or 8-K. Defaults to the latest 10-K.' },
                section: { type: 'string', description: 'Optional section name, for example "Risk Factors", "MD&A", "Business" or "Legal Proceedings".' },
                query: { type: 'string', description: 'Optional term to find inside the filing. Excerpts around each match are returned.' },
                max_excerpts: { type: 'integer', minimum: 1, maximum: 8, default: 3 },
                max_chars: { type: 'integer', minimum: 500, maximum: 12000, default: 4000, description: 'Maximum characters per excerpt or section.' }
            },
            required: ['company'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                company: { type: 'object', properties: { ticker: { type: 'string' }, name: { type: ['string', 'null'] }, cik: { type: ['string', 'null'] } }, additionalProperties: true },
                filing: {
                    type: 'object',
                    properties: {
                        form: { type: 'string' },
                        filing_date: { type: ['string', 'null'] },
                        accession_number: { type: ['string', 'null'] },
                        source_url: { type: ['string', 'null'] }
                    },
                    additionalProperties: true
                },
                section: { type: ['object', 'null'], properties: { key: { type: 'string' }, label: { type: 'string' } }, additionalProperties: true },
                query: { type: 'string' },
                search_scope: { type: 'string' },
                match_count: { type: 'integer' },
                excerpts: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            text: { type: 'string' },
                            char_offset: { type: 'integer' },
                            section: { type: ['string', 'null'] },
                            section_label: { type: ['string', 'null'] }
                        },
                        additionalProperties: true
                    }
                },
                text: { type: 'string' },
                truncated: { type: 'boolean' },
                available_sections: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' } }, additionalProperties: true } },
                note: { type: 'string' }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        requiredScope: 'filings:read',
        handler: (args) => fin.getFilingContent({
            company: args.company,
            accessionNumber: args.accession_number,
            form: args.form,
            section: args.section,
            query: args.query,
            maxExcerpts: args.max_excerpts,
            maxChars: args.max_chars
        })
    },
    {
        name: 'compare_company_metrics',
        title: 'Compare company metrics',
        description: 'Compare two to five publicly traded US companies on the same standardized metrics, using each company\u2019s filed periods. Use for questions that put companies side by side, such as operating margins or revenue growth across peers. Returns one series per metric with a value per company and fiscal period, the units, and the SEC filing source for each value. Companies with different fiscal period ends are flagged and their periods are never blended.',
        inputSchema: {
            type: 'object',
            properties: {
                companies: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' }, description: 'Two to five tickers or company names.' },
                metrics: { type: 'array', items: { type: 'string' }, description: 'Metric ids to compare. Defaults to revenue, net_income and diluted_eps.' },
                period_type: { type: 'string', enum: ['annual', 'quarterly'], default: 'annual' },
                periods: { type: 'integer', minimum: 1, maximum: 5, default: 1, description: 'Number of most recent periods per company.' }
            },
            required: ['companies'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                period_type: { type: 'string' },
                order: { type: 'string' },
                companies: { type: 'array', items: COMPANY_SCHEMA },
                metrics: { type: 'array', items: METRIC_SERIES_SCHEMA },
                notes: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        requiredScope: 'research:read',
        handler: (args) => fin.compareCompanyMetrics({
            companies: args.companies,
            metrics: args.metrics,
            periodType: args.period_type,
            periods: args.periods
        })
    },
    {
        name: 'get_financial_change_drivers',
        title: 'Explain a financial change',
        description: 'Return the reported arithmetic behind a change in a company\u2019s results between two fiscal periods: revenue, cost of revenue, gross profit, operating expenses, operating income, other non-operating income, income tax, net income, and the split of an earnings-per-share change into a net-income effect and a share-count effect. Every input is a reported line item with its SEC filing source, and each bridge step\u2019s components sum to that step\u2019s change. This is reported arithmetic, not a causal explanation or investment advice.',
        inputSchema: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'Ticker (preferred) or company name.' },
                period_type: { type: 'string', enum: ['annual', 'quarterly'], default: 'quarterly' },
                period_end: { type: 'string', description: 'Optional fiscal period end to analyse (YYYY-MM-DD). Defaults to the latest period.' },
                compare_to_period_end: { type: 'string', description: 'Optional period to compare against (YYYY-MM-DD). Defaults to the same fiscal period one year earlier.' }
            },
            required: ['company'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                company: { type: 'object', properties: { ticker: { type: 'string' }, name: { type: ['string', 'null'] }, cik: { type: ['string', 'null'] }, currency: { type: ['string', 'null'] } }, additionalProperties: true },
                period_type: { type: 'string' },
                current_period: { type: 'object', additionalProperties: true },
                prior_period: { type: 'object', additionalProperties: true },
                observed: { type: 'object', additionalProperties: true },
                bridge: { type: 'object', additionalProperties: true },
                eps_decomposition: { type: ['object', 'null'], additionalProperties: true },
                share_sources: { type: 'object', additionalProperties: true },
                interpretation: { type: 'string' },
                notes: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        requiredScope: 'research:read',
        handler: (args) => fin.changeDrivers({
            company: args.company,
            periodType: args.period_type,
            periodEnd: args.period_end,
            compareToPeriodEnd: args.compare_to_period_end
        })
    }
];

const TOOL_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

// Some schema dialects (the OpenAPI subset some model providers map tool
// schemas onto) cannot express `type: ["string","null"]`. Rewrite every
// nullable type as an anyOf branch so the same schema validates everywhere.
// Applied on the wire only; the source schemas stay readable.
function portableSchema(node) {
    if (Array.isArray(node)) return node.map(portableSchema);
    if (!node || typeof node !== 'object') return node;
    let nullableBase = null;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === 'type' && Array.isArray(value) && value.includes('null')) {
            const other = value.filter((t) => t !== 'null');
            if (other.length === 1) nullableBase = other[0];
            continue;
        }
        out[key] = portableSchema(value);
    }
    if (nullableBase) return { anyOf: [{ ...out, type: nullableBase }, { type: 'null' }] };
    return out;
}

function wireTool(def) {
    return {
        name: def.name,
        title: def.title,
        description: def.description,
        inputSchema: portableSchema(def.inputSchema),
        outputSchema: portableSchema(def.outputSchema),
        // Both fields, for the same reason as mcp-endpoint.js: the directory's
        // connector checker reads ToolAnnotations.title, not Tool.title.
        annotations: { title: def.title, ...def.annotations }
    };
}

// Commerce-neutral copy. The plugin guidelines forbid showing plans, prices,
// checkout or upgrade links, so these messages explain the limit and stop.
const MSG_ENTITLEMENT = 'This capability is not included in the connected StockPortfolio.pro account.';
const MSG_ALLOWANCE = 'The connected StockPortfolio.pro account\u2019s allowance for this capability is exhausted.';
const MSG_TRIAL = 'The unauthenticated trial allowance for this endpoint is exhausted. Connect a StockPortfolio.pro account to continue.';

// Error codes a caller can act on. Anything else is logged and returned as a
// single generic upstream error — raw exceptions never reach the model.
const KNOWN_CODES = new Set([
    'COMPANY_REQUIRED', 'COMPANY_NOT_FOUND', 'AMBIGUOUS_COMPANY', 'UNSUPPORTED_METRIC',
    'INVALID_PERIOD', 'FILING_NOT_FOUND', 'UNSUPPORTED_SECTION', 'TOO_MANY_COMPANIES',
    'TOO_FEW_COMPANIES', 'ENTITLEMENT_REQUIRED', 'INSUFFICIENT_SCOPE', 'QUOTA_EXCEEDED',
    'RATE_LIMITED', 'UPSTREAM_DATA_ERROR'
]);

function textResult(payload) {
    return {
        structuredContent: payload,
        content: [{ type: 'text', text: JSON.stringify(payload) }]
    };
}

function errorResult(code, message, details) {
    const payload = { code, error: message };
    if (details) Object.assign(payload, details);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function buildMcpAppsServer(ctx, deps) {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOL_DEFS.map(wireTool)
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: rawArgs = {} } = req.params || {};
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
        const def = TOOL_BY_NAME.get(name);
        const started = Date.now();

        const log = (ok, code) => {
            if (typeof deps.onLog !== 'function') return;
            try {
                deps.onLog({ tool: name, ok, code: code || null, ms: Date.now() - started, caller: ctx.logId || null });
            } catch (_) { /* telemetry must never fail a call */ }
        };

        if (!def) {
            log(false, 'UNKNOWN_TOOL');
            return errorResult('UNKNOWN_TOOL', `Unknown tool: ${name}`);
        }
        // Declared input schemas forbid unknown properties, so a tool cannot be
        // used as a smuggling channel for extra conversation content.
        try {
            const scope = def.requiredScope;
            if (scope && Array.isArray(ctx.scopes) && !ctx.scopes.includes(scope) && !ctx.scopes.includes('mcp')) {
                log(false, 'INSUFFICIENT_SCOPE');
                return errorResult('INSUFFICIENT_SCOPE', `This connection was not granted the ${scope} scope. Reconnect and approve the requested scopes.`);
            }
            if (!ctx.anonymous && typeof deps.entitled === 'function' && !deps.entitled()) {
                log(false, 'ENTITLEMENT_REQUIRED');
                return errorResult('ENTITLEMENT_REQUIRED', MSG_ENTITLEMENT);
            }
            const gate = await deps.limiter.check(ctx.userId, 'mcp_lookup', deps.effectiveAskLimit(), ctx.subscription && ctx.subscription.planId, ctx.user);
            if (!gate.ok) {
                const message = ctx.anonymous ? MSG_TRIAL : MSG_ALLOWANCE;
                log(false, 'QUOTA_EXCEEDED');
                return errorResult('QUOTA_EXCEEDED', message);
            }
            const result = await def.handler(args);
            await deps.limiter.spend(ctx.userId, 'mcp_lookup', `mcp-apps:${name}`, null);
            log(true, null);
            return textResult(result);
        } catch (err) {
            const code = err && KNOWN_CODES.has(err.code) ? err.code : 'UPSTREAM_DATA_ERROR';
            const message = err && KNOWN_CODES.has(err.code)
                ? err.message
                : 'The request could not be completed right now. Try again shortly.';
            if (code === 'UPSTREAM_DATA_ERROR') {
                try { console.error('[mcp-apps] tool failed:', name, err && err.message); } catch (_) { /* ignore */ }
            }
            log(false, code);
            return errorResult(code, message, err && err.details);
        }
    });

    return server;
}

// One-shot handler for the stateless POST /mcp/apps route: a fresh Server and
// Transport per request, torn down when the response finishes.
async function handleMcpAppsRequest(req, res, ctx, deps) {
    const server = buildMcpAppsServer(ctx, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
}

module.exports = {
    SERVER_NAME,
    SERVER_VERSION,
    SERVER_INSTRUCTIONS,
    TOOL_DEFS,
    buildMcpAppsServer,
    handleMcpAppsRequest,
    portableSchema,
    MSG_ENTITLEMENT,
    MSG_ALLOWANCE,
    MSG_TRIAL
};
