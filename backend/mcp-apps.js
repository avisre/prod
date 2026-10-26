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

const connectorUsage = require('./connector-usage');
const connectorNotices = require('./connector-notices');
const companyBreadth = require('./company-breadth');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const fin = require('./mcp-financials');
const aiChat = require('./ai-chat');
const recentFilings = require('./mcp-recent-filings');

const SERVER_NAME = 'stockportfolio';
const SERVER_VERSION = '1.0.0';

// Server instructions are reviewed with the tools. The first 512 characters are
// what clients read most closely, so the operational sequence is first.
const SERVER_INSTRUCTIONS = [
    'StockPortfolio.pro provides structured financial data and SEC filing evidence for US-listed public companies.',
    'If a company name is ambiguous, call search_companies first and use the exact ticker it returns.',
    'get_recent_filings lists each covered company\u2019s most recent report and earnings release, screen_companies screens the covered universe, get_filing_changes compares a company\u2019s two most recent filings of the same form, and get_red_flags returns warning signs computed from filed statements.',
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

// Shared with the website screener so the two never drift (this list once
// lacked netIncomeCagr5Pct).
const { SCREEN_SORT_KEYS } = aiChat;

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
    },
    {
        name: 'get_recent_filings',
        title: 'Recent filings',
        description: 'List what is newly filed across covered companies: each company\u2019s MOST RECENT annual (10-K/20-F/40-F), quarterly (10-Q) and earnings-release filing from a date window — not every filing. Each row carries the form, filing date, period end and filing URL, and whether that period appears in the company\u2019s financial statements. Filter by kind and ticker.',
        inputSchema: {
            type: 'object',
            properties: {
                since: { type: 'string', description: 'Earliest filing date (YYYY-MM-DD). Defaults to 7 days ago and never reaches further back than 92 days.' },
                kinds: { type: 'array', items: { type: 'string', enum: ['quarterly', 'annual', 'earnings_release'] }, description: 'Kinds to include. Defaults to all three.' },
                tickers: { type: 'array', items: { type: 'string' }, description: 'Optional tickers, restricting the result to those companies.' },
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 25, description: 'Maximum rows to return.' }
            },
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                since: { type: 'string' },
                kinds: { type: 'array', items: { type: 'string' } },
                match_count: { type: 'integer' },
                filings: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            ticker: { type: 'string' },
                            name: { type: ['string', 'null'] },
                            kind: { type: 'string' },
                            form: { type: 'string' },
                            filing_date: { type: 'string' },
                            period_end: { type: ['string', 'null'] },
                            filing_url: { type: ['string', 'null'] },
                            in_statements: { type: ['boolean', 'null'] }
                        },
                        additionalProperties: true
                    }
                },
                notes: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        requiredScope: 'filings:read',
        // One row set spanning every covered company: the anti-scraping cap on
        // different companies per account must not fire for it.
        breadth: false,
        handler: (args, deps, ctx) => {
            const run = deps && typeof deps.recentFilings === 'function' ? deps.recentFilings : recentFilings.recentFilings;
            const result = run(args || {});
            // The keyless tier sees a short list, and is told so in the result.
            const cap = 10;
            if (ctx && ctx.anonymous && Array.isArray(result.filings) && result.filings.length > cap) {
                result.filings = result.filings.slice(0, cap);
                result.match_count = result.filings.length;
                result.notes = [...(result.notes || []), `At most ${cap} rows are returned without a signed-in StockPortfolio.pro account.`];
            }
            return result;
        }
    },
    {
        name: 'screen_companies',
        title: 'Screen companies',
        description: 'Screen the covered universe of US-listed companies with filed fundamentals: growth, margins, returns, valuation, index membership, price trend, or a named ticker list, with every threshold optional and freely combined. Returns the rows that pass and the size of the screenable universe; companies without usable statements are not included. Needs a connected StockPortfolio.pro account.',
        inputSchema: {
            type: 'object',
            properties: {
                similar_to: { type: 'string', description: 'Ticker of the company to model the screen on — e.g. "APP" for "companies like AppLovin".' },
                sector: { type: 'string', description: 'Sector substring filter, e.g. TECHNOLOGY, ENERGY' },
                min_revenue_cagr_5y_pct: { type: 'number' },
                max_revenue_cagr_5y_pct: { type: 'number' },
                min_net_margin_pct: { type: 'number' },
                min_roe_pct: { type: 'number' },
                max_roe_pct: { type: 'number', description: 'Ceiling that excludes negative/negligible-equity ROE distortions' },
                min_dividend_yield_pct: { type: 'number' },
                max_pe: { type: 'number' },
                max_peg: { type: 'number' },
                min_price_to_book: { type: 'number' },
                max_price_to_book: { type: 'number' },
                min_market_cap_billions: { type: 'number' },
                max_market_cap_billions: { type: 'number' },
                min_profitable_years_of_last_10: { type: 'integer' },
                min_latest_qtr_earnings_growth_yoy_pct: { type: 'number', description: 'Latest quarter net income growth vs same quarter a year ago, in %' },
                symbols: { type: 'array', items: { type: 'string' }, description: 'Restrict to these tickers (up to 25).' },
                index: { type: 'string', description: 'Index membership from stored, dated member lists: "sp500", "sp100", "nasdaq100", or several joined with "or".' },
                min_price: { type: 'number', description: 'Minimum share price in USD' },
                max_price: { type: 'number', description: 'Maximum share price in USD' },
                min_net_income_cagr_5y_pct: { type: 'number', description: '5-year compound growth in net income, in %' },
                min_price_vs_10_month_avg_pct: { type: 'number', description: 'Price relative to its 10-month average, in %. 0 means "trading above its 10-month average".' },
                min_rsi14: { type: 'number' },
                max_rsi14: { type: 'number' },
                sma200_position: { type: 'string', enum: ['above', 'below'] },
                golden_cross_within_days: { type: 'number' },
                min_volume_ratio_20: { type: 'number' },
                require_positive_fcf: { type: 'boolean' },
                exclude_secondary_listings: { type: 'boolean' },
                sort_by: { type: 'string', enum: SCREEN_SORT_KEYS },
                limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Maximum rows to return.' }
            },
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                universe: { type: 'integer' },
                matched: { type: 'integer' },
                rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
                not_in_universe: { type: ['array', 'null'], items: { type: 'string' } }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        requiredScope: 'research:read',
        // Account-only (requiresAccount): the screener is a whole-universe
        // pull, and a multi-company result must not count as breadth either.
        requiresAccount: true,
        breadth: false,
        handler: async (args, deps) => {
            const a = args && typeof args === 'object' ? args : {};
            const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
            // screenArgsFromClient drops symbols (a website screen never names
            // tickers), so the named list is passed through here. established_first
            // ranks unproven growers below established ones, as ask_filings does.
            const symbols = Array.isArray(a.symbols) ? a.symbols.filter((x) => typeof x === 'string').slice(0, 25) : [];
            const criteria = { ...aiChat.screenArgsFromClient(a), ...(symbols.length ? { symbols } : {}), established_first: true, limit, maxLimit: 50 };
            if (SCREEN_SORT_KEYS.includes(a.sort_by)) criteria.sort_by = a.sort_by;
            const run = deps && typeof deps.screenUniverse === 'function' ? deps.screenUniverse : aiChat.screenRows;
            const result = await run(criteria);
            if (!result || result.error) throw fin.mcpError('SCREEN_FAILED', String((result && result.error) || 'The screen could not be run.'));
            return {
                universe: result.universe,
                matched: result.matched,
                rows: result.rows,
                ...(result.similarTo ? { similar_to: result.similarTo } : {}),
                ...(result.technicalsAsOf ? { technicals_as_of: result.technicalsAsOf } : {}),
                ...(Array.isArray(result.notInUniverse) && result.notInUniverse.length ? { not_in_universe: result.notInUniverse } : {})
            };
        }
    },
    {
        name: 'get_filing_changes',
        title: 'Filing changes',
        description: 'What changed between a company\u2019s newest 10-K/10-Q/20-F/40-F and its previous filing of the same form: guidance and outlook language, risk factors, demand and margin commentary, quoted from both documents and checked against them. The first comparison for a filing pair can take 30\u201360 seconds; later calls are served from the cache. Needs a connected StockPortfolio.pro account.',
        inputSchema: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'Ticker (preferred) or company name.' }
            },
            required: ['company'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string' },
                headline: { type: 'string' },
                tone: { type: ['string', 'null'] },
                changes: { type: 'array', items: { type: 'object', additionalProperties: true } },
                latest: { type: 'object', properties: { form: { type: 'string' }, date: { type: 'string' }, url: { type: 'string' } }, additionalProperties: true },
                prev: { type: 'object', properties: { form: { type: 'string' }, date: { type: 'string' }, url: { type: 'string' } }, additionalProperties: true },
                note: { type: ['string', 'null'] }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        requiredScope: 'filings:read',
        // Account-only, and priced like the research answer it runs: the
        // comparison is a model call over two filing excerpts (aiCost selects
        // the mcp_ask cost key in the CallTool flow below).
        requiresAccount: true,
        aiCost: true,
        handler: async (args, deps) => {
            // A name resolves the way every other company tool here does; an
            // ambiguous one is refused with candidates rather than guessed.
            const { ticker: symbol } = await fin.resolveCompany(args && args.company);
            const run = deps && typeof deps.filingDiff === 'function' ? deps.filingDiff : ((s) => require('./filing-diff').computeFilingDiff(s));
            const result = await run(symbol);
            if (!result || result.error) {
                throw fin.mcpError('FILING_NOT_FOUND', String((result && result.error) || 'No comparable filing pair was found for that company.'));
            }
            return result;
        }
    },
    {
        name: 'get_red_flags',
        title: 'Red flags',
        description: 'Conservative warning signs computed from a company\u2019s filed statements — receivables or inventory outrunning sales, earnings ahead of cash, dilution, heavy debt, shrinking margins — each with the filed figures behind it. A missing figure never raises a flag, and nothing here is a judgement or advice.',
        inputSchema: {
            type: 'object',
            properties: {
                company: { type: 'string', description: 'Ticker (preferred) or company name.' }
            },
            required: ['company'],
            additionalProperties: false
        },
        outputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string' },
                flags: { type: 'array', items: { type: 'object', additionalProperties: true } },
                flagCount: { type: 'integer' },
                asOf: { type: ['string', 'null'] },
                source: { type: ['string', 'null'] }
            },
            additionalProperties: true
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        requiredScope: 'research:read',
        handler: async (args, deps) => {
            const { ticker: symbol } = await fin.resolveCompany(args && args.company);
            const run = deps && typeof deps.redFlags === 'function' ? deps.redFlags : aiChat.redFlagsFor;
            const flags = run(symbol);
            if (!flags) throw fin.mcpError('COMPANY_NOT_FOUND', `No filed statements were found for ${symbol}.`);
            return flags;
        }
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
        // Per-tool auth declaration (OpenAI Apps auth docs): the keyless tier
        // can run a keyless-eligible tool, and the OAuth grant names the single
        // scope that unlocks it — the same scope INSUFFICIENT_SCOPE refuses on
        // below. An account-only tool (requiresAccount) has no keyless tier to
        // advertise, so only the OAuth grant is declared.
        securitySchemes: def.requiresAccount
            ? [{ type: 'oauth2', scopes: [def.requiredScope] }]
            : [{ type: 'noauth' }, { type: 'oauth2', scopes: [def.requiredScope] }],
        // Both fields, for the same reason as mcp-endpoint.js: the directory's
        // connector checker reads ToolAnnotations.title, not Tool.title.
        annotations: { title: def.title, ...def.annotations }
    };
}

// Commerce-neutral copy. The plugin guidelines forbid showing plans, prices,
// checkout or upgrade links, so these messages explain the limit and stop.
const MSG_ENTITLEMENT = 'This capability is not included in the connected StockPortfolio.pro account.';
const MSG_ALLOWANCE = 'The connected StockPortfolio.pro account\u2019s allowance for this capability is exhausted.';
// The signed-in free account's evaluation access (mcp-trial.js) is described
// the same way the keyless tier is: by capability, never by plan or price.
const MSG_EVAL_ENDED = 'This account\u2019s evaluation access has ended.';
const MSG_EVAL_DAY = 'Today\u2019s shared evaluation allowance for AI answers is used up. Try again after 00:00 UTC.';
// The keyless refusal. Reworded 2026-10-25: the old copy said "trial", a word
// the plugin guidelines keep out of this surface's text.
const MSG_TRIAL = 'The free allowance for unauthenticated connections is exhausted. Connect a StockPortfolio.pro account to continue.';
const MSG_ACCOUNT_REQUIRED = 'Connect your account to use it.';

// Error codes a caller can act on. Anything else is logged and returned as a
// single generic upstream error — raw exceptions never reach the model.
const KNOWN_CODES = new Set([
    'COMPANY_REQUIRED', 'COMPANY_NOT_FOUND', 'AMBIGUOUS_COMPANY', 'UNSUPPORTED_METRIC',
    'INVALID_PERIOD', 'FILING_NOT_FOUND', 'UNSUPPORTED_SECTION', 'TOO_MANY_COMPANIES',
    'TOO_FEW_COMPANIES', 'ENTITLEMENT_REQUIRED', 'INSUFFICIENT_SCOPE', 'QUOTA_EXCEEDED',
    'TRIAL_ENDED', 'RATE_LIMITED', 'UPSTREAM_DATA_ERROR', 'AUTHENTICATION_REQUIRED', 'SCREEN_FAILED',
    'ASSET_FEATURE_UNAVAILABLE'
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

// The neutral one-sentence status a trial (evaluation-access) caller reads on
// a successful call. "Evaluation access" wording only — the plugin guidelines
// keep plan, price and commerce words out of this surface's results.
function evaluationNotice(gate) {
    if (!gate || !gate.ok) return null;
    const ends = gate.endsAt ? new Date(gate.endsAt) : null;
    const endsCopy = ends && !Number.isNaN(ends.getTime())
        ? `; ends ${ends.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
        : '';
    return `Evaluation access: ${gate.lookupsLeft} lookups and ${gate.asksLeft} AI answers left${endsCopy}.`;
}

// The account-linking handshake the AI clients implement (OpenAI Apps auth
// docs, "Authenticate users"): a tool error result carrying
// _meta['mcp/www_authenticate'] with a Bearer challenge is what makes the
// client surface its sign-in UI instead of showing the model a dead end.
// Only the anonymous quota refusal carries it — a connected account's
// refusals mean something else and stay unchanged. No resourceMetadataUrl in
// deps means no challenge, exactly as before.
function withWwwAuthenticate(result, deps, description) {
    if (!deps || !deps.resourceMetadataUrl) return result;
    const challenge = `Bearer resource_metadata="${deps.resourceMetadataUrl}", error="insufficient_scope", error_description="${description}"`;
    return { ...result, _meta: { ...(result._meta || {}), 'mcp/www_authenticate': [challenge] } };
}

function buildMcpAppsServer(ctx, deps) {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => listAppsToolsResult(ctx, deps));

    server.setRequestHandler(CallToolRequestSchema, async (req) => callAppsToolResult(ctx, deps, req.params));

    return server;
}

// The tools/list answer, extracted so the modern (2026-07-28) path in
// mcp-modern.js serves the identical list without the SDK's handshake.
async function listAppsToolsResult(ctx, deps) {
    return { tools: TOOL_DEFS.map(wireTool) };
}

// The tools/call answer, extracted for the same reason as listAppsToolsResult.
// `params` is the JSON-RPC params object ({name, arguments}) on both paths.
async function callAppsToolResult(ctx, deps, params) {
    const { name, arguments: rawArgs = {} } = params || {};
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const def = TOOL_BY_NAME.get(name);
    const started = Date.now();
    // What the call was about, for the account's own usage log (see
    // connector-usage.js). It rides beside the event, never inside it: the
    // event is printed to the application log.
    const subject = ctx.anonymous ? null : connectorUsage.subjectFor(args);

    const log = (ok, code, result) => {
        if (typeof deps.onLog === 'function') {
            try {
                deps.onLog({ event: 'tools/call', tool: name, ok, code: code || null, platform: ctx.platform || null, ms: Date.now() - started, caller: ctx.logId || null }, { subject });
            } catch (_) { /* telemetry must never fail a call */ }
        }
        // The mcp_calls usage log (mcp-usage-log.js): one structured row per
        // call, keyless included, refusals included — a refusal is a demand
        // signal too. Same guard as onLog.
        if (typeof deps.usage === 'function') {
            try { deps.usage({ tool: String(name || ''), args, result: result || null, code: code || null, ms: Date.now() - started }); } catch (_) { /* ignore */ }
        }
    };

    if (!def) {
        log(false, 'UNKNOWN_TOOL', errorResult('UNKNOWN_TOOL', `Unknown tool: ${name}`));
        return errorResult('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }
    // Declared input schemas forbid unknown properties, so a tool cannot be
    // used as a smuggling channel for extra conversation content.
    try {
        // An account-only tool (requiresAccount) refuses a keyless caller
        // BEFORE the limiter reserves anything, so the refusal costs no unit
        // of the free allowance. The challenge makes the AI client offer its
        // sign-in UI instead of a dead end.
        if (def.requiresAccount && ctx.anonymous) {
            const result = withWwwAuthenticate(errorResult('AUTHENTICATION_REQUIRED',
                `${def.title} needs a signed-in StockPortfolio.pro account. ${MSG_ACCOUNT_REQUIRED}`, {
                    authenticate: true, tool: def.name
                }), deps, 'Connect a StockPortfolio.pro account to continue.');
            log(false, 'AUTHENTICATION_REQUIRED', result);
            return result;
        }
        const scope = def.requiredScope;
        if (scope && Array.isArray(ctx.scopes) && !ctx.scopes.includes(scope) && !ctx.scopes.includes('mcp')) {
            const result = errorResult('INSUFFICIENT_SCOPE', `This connection was not granted the ${scope} scope. Reconnect and approve the requested scopes.`);
            log(false, 'INSUFFICIENT_SCOPE', result);
            return result;
        }
        if (!ctx.anonymous && typeof deps.entitled === 'function' && !deps.entitled()) {
            const result = errorResult('ENTITLEMENT_REQUIRED', MSG_ENTITLEMENT);
            log(false, 'ENTITLEMENT_REQUIRED', result);
            return result;
        }
        // aiCost mirrors mcp-endpoint.js: a tool whose handler runs the model
        // (the filing comparison) is checked, spent and released against
        // mcp_ask, not mcp_lookup.
        const costKey = def.aiCost ? 'mcp_ask' : 'mcp_lookup';
        const gate = await deps.limiter.check(ctx.userId, costKey, deps.effectiveAskLimit(), ctx.subscription && ctx.subscription.planId, ctx.user);
        if (!gate.ok) {
            // A signed-in free account on its evaluation access gets a code it
            // can act on, in this surface's commerce-neutral copy: the trial
            // limiter's own message names a plan and a price, so it is never
            // used here (plugin guidelines; test/mcp-apps.test.js COMMERCE).
            if (ctx.trial) {
                const code = gate.reason === 'trial_ended' ? 'TRIAL_ENDED' : 'QUOTA_EXCEEDED';
                const message = gate.reason === 'trial_ended'
                    ? MSG_EVAL_ENDED
                    : (gate.reason === 'global_ask_day' ? MSG_EVAL_DAY : MSG_ALLOWANCE);
                const result = errorResult(code, message);
                log(false, code, result);
                return result;
            }
            const message = ctx.anonymous ? MSG_TRIAL : MSG_ALLOWANCE;
            const result = errorResult('QUOTA_EXCEEDED', message);
            log(false, 'QUOTA_EXCEEDED', result);
            return ctx.anonymous
                ? withWwwAuthenticate(result, deps, 'Connect a StockPortfolio.pro account to continue.')
                : result;
        }
        // check() RESERVED a unit of the caller's allowance (mcp-anon.js).
        // Any path below that returns without spending must hand the
        // reservation back, or a refused call silently burns the free
        // allowance. credits.js has no release(), hence the typeof guard.
        let spent = false;
        try {
            // Anti-scraping cap on different companies per account (company-breadth.js).
            const companies = deps.breadth && !ctx.anonymous && def.breadth !== false ? companyBreadth.companiesIn(args) : [];
            if (companies.length) {
                const breadth = await deps.breadth.check(companies);
                if (!breadth.ok) {
                    const result = errorResult('COMPANY_LIMIT', breadth.message, { window: breadth.window, limit: breadth.limit, resets_at: breadth.resetsAt });
                    log(false, 'COMPANY_LIMIT', result);
                    return result;
                }
            }
            // The notice's ledger read is awaited BEFORE the charge, or this
            // call's own row would hide credits that just arrived (see mcp-endpoint.js).
            const pendingNotice = connectorNotices.begin(deps, gate);
            const result = await def.handler(args, deps, ctx);
            const notice = await pendingNotice;
            // Confirms the reservation check() made.
            await deps.limiter.spend(ctx.userId, costKey, `mcp-apps:${name}`, subject, ctx.client || null);
            spent = true;
            if (companies.length) await deps.breadth.record(companies);
            // A trial caller reads its remaining evaluation access in the
            // result, in the same neutral copy — what remains and when it
            // ends, with no commerce words.
            if (ctx.trial && gate.ok) {
                result.trial = {
                    lookups_left: gate.lookupsLeft,
                    asks_left: gate.asksLeft,
                    ends_at: gate.endsAt,
                    days_left: gate.daysLeft
                };
                result.notice = evaluationNotice(gate);
            }
            const final = textResult(connectorNotices.attach(result, notice));
            log(true, null, final);
            return final;
        } finally {
            if (!spent && typeof deps.limiter.release === 'function') {
                // The reservation goes back on any refusal or a handler
                // throw that reached this block without spending.
                try { await deps.limiter.release(ctx.userId, costKey); } catch (_) { /* never mask the answer */ }
            }
        }
    } catch (err) {
            const code = err && KNOWN_CODES.has(err.code) ? err.code : 'UPSTREAM_DATA_ERROR';
            const message = err && KNOWN_CODES.has(err.code)
                ? err.message
                : 'The request could not be completed right now. Try again shortly.';
            if (code === 'UPSTREAM_DATA_ERROR') {
                try { console.error('[mcp-apps] tool failed:', name, err && err.message); } catch (_) { /* ignore */ }
            }
            log(false, code, errorResult(code, message, err && err.details));
            return errorResult(code, message, err && err.details);
    }
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
    listAppsToolsResult,
    callAppsToolResult,
    portableSchema,
    MSG_ENTITLEMENT,
    MSG_ALLOWANCE,
    MSG_TRIAL,
    MSG_EVAL_ENDED,
    MSG_EVAL_DAY
};
