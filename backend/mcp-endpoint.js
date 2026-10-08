'use strict';

// Hosted MCP endpoint — mounted at POST /mcp in app.js.
//
// Transport is the MCP SDK's Streamable HTTP in stateless mode: no session id,
// no server-initiated SSE, one request in and one response out. Every tool call
// here is a single request/response, so a fresh Server + Transport is built per
// request and torn down when the response finishes.
//
// ---- The rule this file exists to enforce -------------------------------
// The MCP connection and the MCP *authorization decision* are separate things,
// and conflating them is what kept this endpoint off directory listings.
//
// Protocol operations (initialize, notifications/initialized, tools/list, ping)
// are never billed and never refused — a client must be able to complete the
// handshake and read the tool schema before anyone can decide whether it may
// call anything. Only a tools/call for a protected tool consults entitlement,
// the network/region walls or the credit wallet, and when it refuses it returns
// a normal JSON-RPC result carrying isError:true, never an HTTP status. A
// refusal that arrives as HTTP 402 at the transport layer is indistinguishable
// from a broken server to every MCP client, and cannot be explained to the user
// by the model — which is exactly how Glama's probe came to mark this server
// Unhealthy.
//
// ---- Tool surface ------------------------------------------------------
// Six tools, no overlaps, each one answering a question the others cannot:
//   search_companies          resolve a name/ticker to a company (a lookup)
//   get_company_fundamentals  the financial statements, per filed period
//   search_filings            locate filings by form and date
//   get_filing                read one filing's metadata and sections
//   ask_filings               the SEC-grounded research answer (metered AI)
//   sp_health                 liveness probe (free)
//
// The financial engine is mcp-financials.js, shared with /mcp/apps. Nothing
// here reaches a data source directly, so there is exactly one implementation
// of every number the product publishes.
//
// Built as a factory rather than a module-level singleton: app.js builds a
// Server per request, closed over that request's already-resolved identity, so
// a tool handler never re-derives who is calling.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fin = require('./mcp-financials');
const aiChat = require('./ai-chat');
const { quotaError } = require('./api-response');
const connectorUsage = require('./connector-usage');
const mcpAnon = require('./mcp-anon');

const SERVER_NAME = 'stockportfolio-mcp';
const SERVER_VERSION = '1.0.0';
const ANON_MCP_CONFIG = mcpAnon.config();

// Does the geo/hosting wall gate a KEYLESS tool call?
//
// Default: no. The wall exists to stop a person using a VPN to read the free
// website, and it classifies an address as rented. Every AI client — ChatGPT,
// Claude, Codex, a directory's health probe — runs on rented infrastructure, so
// applying it here refuses precisely the traffic this endpoint exists to serve,
// while a scraper with a residential proxy routes around it. What actually
// bounds this surface is mcp-anon.js: a per-identity allowance in a rolling
// window plus a hard global daily ceiling, which a rented address does not
// reset. Set MCP_KEYLESS_WALL=true to restore the refusal; the decision is then
// reported as a NETWORK_PAID_ONLY / REGION_PAID_ONLY tool error, never an HTTP
// status.
const KEYLESS_WALL_APPLIES = process.env.MCP_KEYLESS_WALL === 'true';

// First 512 characters are what a client reads most closely, so the order of
// operations comes first and the honesty rules come second.
const SERVER_INSTRUCTIONS = [
    'StockPortfolio.pro returns SEC filing data for US-listed public companies.',
    'If a company name is ambiguous, call search_companies first and use the exact ticker it returns.',
    'get_company_fundamentals returns financial statements by fiscal period, each value carrying the SEC filing that reports it.',
    'A value that was not reported is null and is never estimated; never fill a null with your own number.',
    'Cite the SEC source URL that accompanies a figure when you state it.',
    'sp_health is free. Every other tool, search_companies included, spends from the caller\u2019s allowance.',
    'Do not treat any output as investment advice.'
].join(' ');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SOURCE_SCHEMA = {
    type: ['object', 'null'],
    description: 'The SEC filing behind a value. linkage "xbrl_fact" means the value was read from an SEC XBRL fact with that accession; "filing_period" means it comes from the normalized cache and this is the filing reporting that fiscal period.',
    properties: {
        form: { type: ['string', 'null'], description: 'Filing type, e.g. 10-K or 10-Q.' },
        filing_date: { type: ['string', 'null'] },
        report_date: { type: ['string', 'null'] },
        accession_number: { type: ['string', 'null'] },
        url: { type: ['string', 'null'], description: 'SEC source URL. Cite this.' },
        linkage: { type: ['string', 'null'] }
    },
    additionalProperties: true
};

const OBSERVATION_SCHEMA = {
    type: 'object',
    description: 'One metric for one fiscal period.',
    properties: {
        metric: { type: 'string' },
        label: { type: 'string' },
        period_type: { type: 'string', enum: ['annual', 'quarterly'] },
        period_end: { type: 'string', description: 'Fiscal period end (YYYY-MM-DD).' },
        value: { type: ['number', 'null'], description: 'Null when the company did not report it. Never estimated.' },
        units: { type: 'string', description: 'USD, USD_per_share, shares or percent.' },
        currency: { type: ['string', 'null'] },
        derived_from: { type: ['array', 'null'], items: { type: 'string' } },
        source: SOURCE_SCHEMA
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
        form: { type: 'string', description: 'Filing type.' },
        filing_date: { type: ['string', 'null'] },
        report_date: { type: ['string', 'null'], description: 'Fiscal period the filing covers.' },
        accession_number: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        filing_url: { type: ['string', 'null'], description: 'SEC source URL.' }
    },
    additionalProperties: true
};

// The default metric set for get_company_fundamentals: exactly the income
// statement, cash flow and balance sheet lines a reader asks for first. Each id
// is a key of mcp-financials' METRICS/DERIVED catalogs — passing an id the
// engine does not know is an error, not a silently dropped column, so the
// caller learns their request was wrong instead of reading a shorter answer.
const DEFAULT_FUNDAMENTAL_METRICS = [
    'revenue',
    'gross_profit',
    'operating_income',
    'net_income',
    'diluted_eps',
    'free_cash_flow',
    'cash_and_equivalents',
    'total_debt',
    'shares_outstanding'
];

const ALL_METRIC_IDS = new Set([...Object.keys(fin.METRICS), ...Object.keys(fin.DERIVED)]);

const TOOL_DEFS = [
    {
        name: 'search_companies',
        title: 'Search companies',
        description: 'Resolve a company name or ticker to the US-listed company it refers to, returning ticker, company name and SEC CIK. Use this first when a company is named ambiguously, when only a name is known, or before another tool when the ticker is uncertain. Reads a bundled company catalog and returns no financial data and no filing content. Costs one data lookup.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Company name or ticker, e.g. "Apple", "AAPL" or "Berkshire".' },
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
                            exchange: { type: ['string', 'null'] },
                            fiscal_year_end: { type: ['string', 'null'] },
                            has_financial_data: { type: 'boolean' }
                        },
                        additionalProperties: true
                    }
                }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        // Metered as a lookup since 2026-10-08 (owner decision): the catalog is
        // part of the product, and /mcp/apps already charged for it. sp_health
        // is the one tool left for a probe that must not spend anything.
        handler: async (args) => {
            const query = String(args.query || '').trim();
            if (!query) throw fin.mcpError('COMPANY_REQUIRED', 'Provide a company name or ticker to search for.');
            const companies = fin.searchCompanies(query, args.limit);
            return { query, match_count: companies.length, companies };
        }
    },
    {
        name: 'get_company_fundamentals',
        title: 'Get company fundamentals',
        description: 'Return one US-listed company’s financial statements by fiscal period: revenue, gross profit, operating income, net income, diluted EPS, free cash flow, cash, debt and shares outstanding. Every figure carries its fiscal period and the SEC filing that reports it (form, filing date, accession number and source URL). Defaults to the five most recent annual periods. A figure the company did not report is null and is never estimated or annualised. Use get_filing or ask_filings when the question is about what a filing says rather than about reported numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'US ticker, e.g. NVDA or AAPL.' },
                period_type: { type: 'string', enum: ['annual', 'quarterly'], default: 'annual', description: 'Fiscal period type.' },
                year: { type: 'integer', minimum: 1990, maximum: 2100, description: 'Optional fiscal year to restrict the result to, e.g. 2024. Use this instead of periods when a specific year was asked for.' },
                periods: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Number of most recent periods to return. Ignored when year is given.' },
                metrics: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional metric ids to return instead of the default set, e.g. ["revenue","net_income"]. An id outside the catalog is an error.'
                }
            },
            required: ['ticker'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                company: COMPANY_SCHEMA,
                period_type: { type: 'string' },
                order: { type: 'string' },
                metrics: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            metric: { type: 'string' },
                            label: { type: 'string' },
                            units: { type: 'string' },
                            observations: { type: 'array', items: OBSERVATION_SCHEMA }
                        },
                        additionalProperties: true
                    }
                }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        handler: (args) => {
            const metrics = normalizeMetrics(args.metrics);
            const year = Number(args.year);
            const range = Number.isFinite(year) && year >= 1990 && year <= 2100
                ? { startPeriod: `${year}-01-01`, endPeriod: `${year}-12-31` }
                : {};
            return fin.companyFinancials({
                company: args.ticker,
                metrics,
                periodType: args.period_type,
                periods: range.startPeriod ? undefined : args.periods,
                ...range
            });
        }
    },
    {
        name: 'search_filings',
        title: 'Search SEC filings',
        description: 'Find SEC filings for one company by filing type and date range. Returns each filing’s form, filing date, fiscal period, accession number, SEC document description and a direct filing URL. Use this to locate a 10-K, 10-Q, 8-K, 20-F or proxy, or to answer "when did they last file X". This searches filing metadata, not the text inside filings — use get_filing for the text.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'US ticker, e.g. AAPL.' },
                filing_type: { type: ['string', 'array'], items: { type: 'string' }, description: 'Optional filing type or types, e.g. "10-K" or ["10-Q","8-K"].' },
                start_date: { type: 'string', description: 'Optional earliest filing date (YYYY-MM-DD).' },
                end_date: { type: 'string', description: 'Optional latest filing date (YYYY-MM-DD).' },
                limit: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'Maximum number of filings to return.' }
            },
            required: ['ticker'],
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
        handler: (args) => {
            const forms = normalizeForms(args.filing_type);
            return fin.searchFilings({
                company: args.ticker,
                forms,
                startDate: args.start_date,
                endDate: args.end_date,
                limit: args.limit
            });
        }
    },
    {
        name: 'get_filing',
        title: 'Get SEC filing content',
        description: 'Read one SEC filing — its metadata plus short excerpts of its text. Identify it by accession number (preferred, as returned by search_filings), or by ticker with an optional filing type, which defaults to the company’s latest 10-K. Request a named section such as "Risk Factors", "MD&A" or "Legal Proceedings", or search the filing for a term. Returns excerpts with their section and the filing URL, not the whole document. Use get_company_fundamentals for reported numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                accession_number: { type: 'string', description: 'SEC accession number, e.g. 0000320193-25-000079. Enough on its own — the company is derived from it.' },
                ticker: { type: 'string', description: 'US ticker. Required when accession_number is not given, optional otherwise.' },
                filing_type: { type: 'string', description: 'Optional filing type when no accession number is given, e.g. 10-K, 10-Q or 8-K. Defaults to the latest 10-K.' },
                section: { type: 'string', description: 'Optional section name, e.g. "Risk Factors", "MD&A", "Business", "Legal Proceedings".' },
                query: { type: 'string', description: 'Optional term to find inside the filing; excerpts around each match are returned.' },
                max_excerpts: { type: 'integer', minimum: 1, maximum: 8, default: 3 },
                max_chars: { type: 'integer', minimum: 500, maximum: 12000, default: 4000, description: 'Maximum characters per excerpt or section.' }
            },
            additionalProperties: false,
            anyOf: [{ required: ['accession_number'] }, { required: ['ticker'] }]
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
                        filing_url: { type: ['string', 'null'] }
                    },
                    additionalProperties: true
                },
                section: { type: ['object', 'null'], properties: { key: { type: 'string' }, label: { type: 'string' } }, additionalProperties: true },
                match_count: { type: 'integer' },
                excerpts: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            text: { type: 'string' },
                            section: { type: ['string', 'null'] },
                            section_label: { type: ['string', 'null'] }
                        },
                        additionalProperties: true
                    }
                },
                available_sections: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' } }, additionalProperties: true } }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        handler: async (args) => {
            const company = await companyForFiling(args);
            const result = await fin.getFilingContent({
                company,
                accessionNumber: args.accession_number,
                form: args.filing_type,
                section: args.section,
                query: args.query,
                maxExcerpts: args.max_excerpts,
                maxChars: args.max_chars
            });
            // The engine names this field source_url on /mcp/apps; both surfaces
            // describe the same thing, so publish one spelling per surface and
            // keep the source URL present under the documented name.
            if (result && result.filing && result.filing.source_url !== undefined) {
                result.filing.filing_url = result.filing.source_url;
                delete result.filing.source_url;
            }
            return result;
        }
    },
    {
        name: 'ask_filings',
        title: 'Ask about a company’s filings',
        description: 'Ask a question about one US-listed company and get an answer researched from its SEC filings, plus the tools and figures it used. Use this when the question needs reasoning over filing content — what management said about margins, why a segment declined, what the risk factors are — rather than a single reported number, for which get_company_fundamentals is faster and exact. The answer states what it could not source rather than estimating, and the supporting pulls are returned so the figures can be checked. Metered: consumes the account’s allowance. Not investment advice.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'US ticker the question is about, e.g. NVDA.' },
                question: { type: 'string', description: 'The question, in natural language.' }
            },
            required: ['ticker', 'question'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string' },
                question: { type: 'string' },
                answer: { type: 'string' },
                supporting_pulls: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'The data the answer was researched from, so its figures can be checked against the cited filings.' },
                citations: { type: 'array', items: { type: 'string' } },
                source: { type: 'string' },
                usage: { type: ['object', 'null'] },
                notice: { type: ['string', 'null'] }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        aiCost: true,
        handler: async (args) => {
            const ticker = String(args.ticker || '').trim().toUpperCase();
            const question = String(args.question || '').trim();
            if (!ticker) throw fin.mcpError('COMPANY_REQUIRED', 'Provide the ticker the question is about.');
            if (!question) throw fin.mcpError('QUESTION_REQUIRED', 'Provide a question to research.');
            // Resolve the ticker through the same catalog every other tool uses,
            // so a typo fails here with a candidate list instead of becoming an
            // unanswerable question downstream.
            const company = await fin.resolveCompany(ticker);
            const focused = `About ${company.name} (${company.ticker}${company.cik ? `, SEC CIK ${company.cik}` : ''}): ${question}`;
            const result = await aiChat.ask({ question: focused, history: [], ctx: { holdings: [] } });
            if (result && result.error) throw fin.mcpError('UPSTREAM_DATA_ERROR', String(result.error));
            return {
                ticker: company.ticker,
                question,
                answer: String(result.answer || '').trim() || 'No answer was produced for that question.',
                supporting_pulls: Array.isArray(result.toolsUsed) ? result.toolsUsed : [],
                citations: citationsFrom(result.toolsUsed),
                source: result.source || 'ai'
            };
        }
    },
    {
        name: 'sp_health',
        title: 'Health check',
        description: 'Liveness probe: reports the server version and the number of tools. Safe to call before any other tool and useful for verifying a connection. Free: needs no account and consumes no allowance.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
            type: 'object',
            properties: {
                status: { type: 'string' },
                version: { type: 'string' },
                tool_count: { type: 'integer' }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        free: true,
        handler: async () => ({
            status: 'ok',
            version: SERVER_VERSION,
            tool_count: TOOL_DEFS.length
        })
    }
];

const TOOL_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Input normalisation — every rejection here is a plain, actionable error
// ---------------------------------------------------------------------------

function normalizeMetrics(input) {
    if (input === undefined || input === null) return DEFAULT_FUNDAMENTAL_METRICS.slice();
    const list = Array.isArray(input) ? input : [input];
    const ids = [];
    for (const raw of list) {
        const id = String(raw || '').trim();
        if (!id) continue;
        // Reject an unknown id instead of dropping it: a caller who asked for
        // EBITDA and silently received eight other lines would report the
        // absence of EBITDA as "the company doesn't report it".
        if (!ALL_METRIC_IDS.has(id)) {
            throw fin.mcpError('UNSUPPORTED_METRIC', `"${id}" is not a metric this service publishes.`, {
                available_metrics: [...ALL_METRIC_IDS].sort()
            });
        }
        ids.push(id);
    }
    return ids.length ? ids : DEFAULT_FUNDAMENTAL_METRICS.slice();
}

function normalizeForms(input) {
    if (input === undefined || input === null) return undefined;
    const list = (Array.isArray(input) ? input : [input])
        .map((f) => String(f || '').trim().toUpperCase())
        .filter(Boolean);
    return list.length ? list : undefined;
}

// An accession number is <10-digit CIK>-<2-digit year>-<6-digit sequence>, so it
// carries the filer's CIK. Deriving the company from it is what lets get_filing
// take an accession number on its own; when the CIK is not a company this
// catalog knows, say so and name the alternative rather than failing obscurely.
async function companyForFiling(args) {
    const accession = String(args.accession_number || '').trim();
    if (accession) {
        const match = /^(\d{10})-\d{2}-\d{6}$/.exec(accession);
        if (!match) {
            throw fin.mcpError('FILING_NOT_FOUND', `"${accession}" is not a valid SEC accession number. Expected the form 0000320193-25-000079.`, {
                hint: 'Call search_filings to get an accession number for a company.'
            });
        }
        if (args.ticker) return args.ticker;
        try {
            return match[1];
        } catch (_) { /* fall through to the explicit error below */ }
    }
    if (args.ticker) return args.ticker;
    throw fin.mcpError('COMPANY_REQUIRED', 'Provide an accession_number, or a ticker to identify the company.', {
        hint: 'Call search_filings first to get an accession number.'
    });
}

// The AI answer's backing pulls are the only citation material available: each
// carries the SEC filing it read. Surface any source URL they contain so the
// caller can cite the filing rather than the answer.
function citationsFrom(toolsUsed) {
    const urls = new Set();
    const walk = (node, depth) => {
        if (!node || depth > 4) return;
        if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
        if (typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            if (typeof value === 'string' && /^https?:\/\//.test(value) && /sec\.gov/i.test(value)) urls.add(value);
            else if (value && typeof value === 'object') walk(value, depth + 1);
        }
    };
    walk(toolsUsed, 0);
    return [...urls].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
    'COMPANY_REQUIRED', 'COMPANY_NOT_FOUND', 'AMBIGUOUS_COMPANY', 'UNSUPPORTED_METRIC',
    'QUESTION_REQUIRED', 'FILING_NOT_FOUND', 'UNSUPPORTED_SECTION', 'TOO_MANY_COMPANIES',
    'TOO_FEW_COMPANIES', 'INVALID_PERIOD', 'AUTHENTICATION_REQUIRED', 'ENTITLEMENT_REQUIRED',
    'QUOTA_EXCEEDED', 'RATE_LIMITED', 'UNKNOWN_TOOL', 'UPSTREAM_DATA_ERROR'
]);

function textResult(payload) {
    return {
        structuredContent: payload,
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
    };
}

function errorResult(code, message, details, extra) {
    const payload = { code, error: message };
    if (details) Object.assign(payload, details);
    if (extra) Object.assign(payload, extra);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

// These explain what is missing and stop. /mcp/apps, the surface submitted
// under the OpenAI plugin guidelines (no plan, price or checkout in the app),
// keeps its own commerce-neutral copy in mcp-apps.js and reads none of these.
// MSG_NO_ENTITLEMENT below is the exception on this surface: it names the plan.
const MSG_NO_CREDENTIALS = 'This tool needs a StockPortfolio.pro account. Reconnect this server with authentication, then call it again. sp_health works without an account.';
const MSG_NETWORK = 'This connection cannot use the free allowance from a data-centre or VPN network. Authenticate the connection to continue.';
const MSG_REGION = 'The free allowance is not available from this region. Authenticate the connection to continue.';
// The caller is signed in, so the fix is a plan change on the account they
// already have (/upgrade.html), not a new signup. Entitlement is read on every
// call, so the same connection works as soon as the plan changes. Price and
// rates mirror mcp-anon.js's upgradeInstructions(); this is the bare message a
// paying Monthly customer met on every call before the 2026-10-08 access fix,
// with nothing to say what to do about it.
const UPGRADE_URL = 'https://www.stockportfolio.pro/upgrade.html?utm_source=connector&utm_campaign=no_access';
const MSG_NO_ENTITLEMENT = 'The plan on the connected StockPortfolio.pro account does not include this connector. '
    + `To use it, open ${UPGRADE_URL} and choose the Monthly plan ($79.99/month, cancel anytime). `
    + 'It includes this connector with 100 credits a month (a data lookup costs 2 credits, an AI answer 42). '
    + 'This connection picks the new plan up on the next call; there is nothing to reconnect.';

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// `detail` travels beside the event, not inside it: the event is printed to the
// application log, and what a customer asked about does not belong there.
function logEvent(deps, event, detail) {
    if (typeof deps.onLog !== 'function') return;
    // Telemetry must never be able to fail a tool call.
    try { deps.onLog(event, detail); } catch (_) { /* ignore */ }
}

function buildMcpServer(ctx, deps) {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
    );

    // Discovery. No identity, entitlement or allowance is consulted here, and
    // this handler cannot fail for an authentication reason — a client has to be
    // able to read the schema before it can be told it is not allowed to use it.
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = TOOL_DEFS.map((def) => ({
            name: def.name,
            title: def.title,
            description: toolDescription(def),
            inputSchema: def.inputSchema,
            outputSchema: def.outputSchema,
            // `title` belongs in BOTH places. Tool.title and
            // ToolAnnotations.title are separate fields in the spec, and the
            // directory's connector checker reads the annotation one: with only
            // the top-level field set, all six tools came back "Missing title
            // annotation. Add annotations.title" on the submission form
            // (2026-10-01). Spread after so an explicit annotations.title, if one
            // is ever added, still wins.
            annotations: { title: def.title, ...def.annotations }
        }));
        logEvent(deps, { event: 'tools/list', toolCount: tools.length, caller: ctx.logId || null });
        return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: rawArgs } = (req && req.params) || {};
        const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
        const started = Date.now();
        // What the call was about, for the account's own usage log. Only for a
        // signed-in caller: a keyless one has no account to show it to.
        const subject = ctx.anonymous ? null : connectorUsage.subjectFor(args);
        const finish = (result, code) => {
            logEvent(deps, {
                event: 'tools/call',
                tool: String(name || ''),
                ok: !(result && result.isError),
                code: code || null,
                anonymous: Boolean(ctx.anonymous),
                // Recorded even when it does not refuse, so the wall's real
                // traffic share on this surface stays measurable while the
                // policy above is off.
                wall: ctx.anonymous ? (deps.wallReason || null) : null,
                ms: Date.now() - started,
                caller: ctx.logId || null
            }, { subject });
            return result;
        };

        const def = TOOL_BY_NAME.get(name);

        try {
            if (!def) {
                return finish(errorResult('UNKNOWN_TOOL', `Unknown tool: ${name}`, {
                    available_tools: TOOL_DEFS.map((t) => t.name)
                }), 'UNKNOWN_TOOL');
            }

            // The liveness probe is reachable by any caller. It touches no
            // upstream service, costs nothing and holds no data, so gating it
            // would break discovery testing for no benefit.
            if (def.free) {
                return finish(textResult(await def.handler(args)));
            }

            // ---- Everything below is a protected operation ----
            // The order is deliberate: who is calling, then whether this
            // network may use the free tier, then whether the allowance is
            // spent. Each refusal is a tool result the model can read out.
            const gate = await deps.limiter.check(
                ctx.userId,
                def.aiCost ? 'mcp_ask' : 'mcp_lookup',
                deps.effectiveAskLimit(ctx),
                ctx.subscription && ctx.subscription.planId,
                ctx.user
            );

            if (ctx.anonymous && deps.wallReason && KEYLESS_WALL_APPLIES) {
                const code = deps.wallReason === 'network' ? 'NETWORK_PAID_ONLY' : 'REGION_PAID_ONLY';
                const message = deps.wallReason === 'network' ? MSG_NETWORK : MSG_REGION;
                return finish(errorResult(code, message, { authenticate: true, tool: def.name }), code);
            }

            // A connected account whose plan does not include API/MCP access is
            // told so as a tool result. This used to be an HTTP 402 raised by
            // mcpAccessGate before the transport was reached, which a caller
            // could only read as a broken server.
            if (!ctx.anonymous && typeof deps.entitled === 'function' && !deps.entitled()) {
                return finish(errorResult('ENTITLEMENT_REQUIRED', MSG_NO_ENTITLEMENT, { tool: def.name, upgradeUrl: UPGRADE_URL }), 'ENTITLEMENT_REQUIRED');
            }

            if (!gate.ok) {
                // A keyed caller with a wallet gets the same shortfall body the
                // REST API returns. An anonymous caller never had a wallet, so
                // the limiter's own copy is the one that makes sense to them.
                if (ctx.anonymous) {
                    // Keyless access switched off entirely is an authentication
                    // problem; an exhausted free allowance is a quota problem.
                    // The limiter reports both as ok:false, so the distinction
                    // comes from whether keyless access exists at all — an
                    // earlier version guessed it from the refusal prose, which
                    // read "That was all 3 free questions…" as an auth failure.
                    const code = mcpAnon.enabled() ? 'QUOTA_EXCEEDED' : 'AUTHENTICATION_REQUIRED';
                    return finish(errorResult(code, String(gate.message || MSG_NO_CREDENTIALS), {
                        authenticate: code === 'AUTHENTICATION_REQUIRED',
                        tool: def.name
                    }), code);
                }
                // The published keyed-caller body is unchanged — quotaError's
                // own fields stay at the top level, so a client written against
                // the REST 402 reads the same shape here.
                const q = quotaError(gate);
                return finish(errorResult('QUOTA_EXCEEDED', q.error, q), 'QUOTA_EXCEEDED');
            }

            const result = await def.handler(args);
            // Charged after the work succeeded, so a failed lookup never spends
            // the caller's allowance.
            await deps.limiter.spend(ctx.userId, def.aiCost ? 'mcp_ask' : 'mcp_lookup', `mcp:${def.name}`, subject, ctx.client || null);

            if (def.aiCost && ctx.anonymous) {
                // A free AI answer reports what is left, so the caller learns
                // the limit exists before it is reached rather than from a
                // refusal.
                result.usage = {
                    used: gate.used + 1,
                    allowance: gate.allowance,
                    remaining: Math.max(0, gate.allowance - gate.used - 1),
                    window_days: gate.windowDays || 30,
                    resets_at: gate.resetsAt || null
                };
                result.notice = mcpAnon.askUsageNotice(gate.used + 1, gate.allowance, gate.windowDays || 30);
            }
            return finish(textResult(result));
        } catch (err) {
            const known = err && KNOWN_CODES.has(err.code);
            const code = known ? err.code : 'UPSTREAM_DATA_ERROR';
            const message = known ? err.message : 'The request could not be completed right now. Try again shortly.';
            if (!known) {
                try { console.error('[mcp] tool failed:', String(name || ''), err && err.message); } catch (_) { /* ignore */ }
            }
            return finish(errorResult(code, message, err && err.details), code);
        }
    });

    return server;
}

// Tool descriptions carry runtime facts (the live free-allowance size) so a
// model reads the real number rather than one baked in at build time.
function toolDescription(def) {
    if (def.name !== 'ask_filings') return def.description;
    const limit = ANON_MCP_CONFIG.askLimit;
    const windowDays = ANON_MCP_CONFIG.windowDays;
    return `${def.description} Without an account this tool allows ${limit} questions per caller in each rolling ${windowDays}-day window; a successful answer reports the remaining count.`;
}

// One-shot handler for the stateless POST /mcp route: a fresh Server and
// Transport per request, both torn down when the response finishes. No state
// survives a request, so repeated health checks cannot accumulate sessions.
async function handleMcpRequest(req, res, ctx, deps) {
    const server = buildMcpServer(ctx, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const teardown = () => {
        if (closed) return;
        closed = true;
        // close() rejects with "Not connected" when connect() never ran, which
        // is not an error worth surfacing.
        transport.close().catch(() => {});
        server.close().catch(() => {});
    };
    res.on('close', teardown);
    res.on('finish', teardown);
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } finally {
        // A handler that answers without ending the response (or a client that
        // vanished mid-flight) must not leave the Server and Transport alive.
        if (res.writableEnded || res.destroyed) teardown();
    }
}

module.exports = {
    SERVER_NAME,
    SERVER_VERSION,
    SERVER_INSTRUCTIONS,
    TOOL_DEFS,
    DEFAULT_FUNDAMENTAL_METRICS,
    buildMcpServer,
    handleMcpRequest
};
