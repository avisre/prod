#!/usr/bin/env node
'use strict';

// Builds the Microsoft 365 Copilot app package for the StockPortfolio connector:
// a declarative agent whose one action is our remote MCP server.
//
//   node scripts/build-copilot-package.js            # writes the three JSON files
//   node scripts/build-copilot-package.js --check    # exit 1 if they are stale
//
// The tool list is copied from the server's own definitions (backend/mcp-apps.js)
// so the package cannot describe a tool the endpoint does not serve; run this
// again whenever a tool there changes. It points at /mcp/apps, the surface whose
// copy already carries no prices, plans or links, which is also what the
// Microsoft 365 store validation asks of an agent.
//
// What this cannot do: the plugin's `auth.reference_id` is an auth-config id
// that only exists inside a Microsoft 365 tenant. Microsoft 365 Agents Toolkit
// creates it (authentication type "OAuth (with dynamic registration)") and
// writes it into the env file the placeholder below reads. See README.md beside
// the package.

const fs = require('node:fs');
const path = require('node:path');
const mcpApps = require('../backend/mcp-apps');

const OUT = path.join(__dirname, '..', 'integrations', 'microsoft-365-copilot', 'appPackage');
const SITE = 'https://www.stockportfolio.pro';
const MCP_URL = `${SITE}/mcp/apps`;

// Store validation: no URLs, emojis or instructions to the user in any
// description. A sentence that only names a URL is dropped rather than rewritten.
const plain = (text) => String(text || '')
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/https?:\/\/|www\./i.test(s))
    .join(' ')
    .trim();

const tools = mcpApps.TOOL_DEFS.map((def) => ({
    name: def.name,
    description: plain(def.description),
    inputSchema: def.inputSchema
}));

const plugin = {
    $schema: 'https://developer.microsoft.com/json-schemas/copilot/plugin/v2.4/schema.json',
    schema_version: 'v2.4',
    name_for_human: 'StockPortfolio',
    namespace: 'stockportfolio',
    description_for_human: 'Financial statements and SEC filing evidence for US-listed companies, each figure with its source.',
    description_for_model: 'Structured financial data and SEC filing evidence for US-listed public companies. Use it for reported financial statements, metric history, comparisons between companies, and the text of SEC filings. Every value carries its reporting period and the filing it came from. A value that was not reported is null and must not be estimated.',
    contact_email: 'support@stockportfolio.pro',
    legal_info_url: `${SITE}/terms.html`,
    privacy_policy_url: `${SITE}/privacy.html`,
    functions: tools.map((t) => ({
        name: t.name,
        description: t.description,
        capabilities: { security_info: { data_handling: ['GetPublicData'] } }
    })),
    runtimes: [{
        type: 'RemoteMCPServer',
        auth: { type: 'OAuthPluginVault', reference_id: '${{STOCKPORTFOLIO_MCP_AUTH_ID}}' },
        run_for_functions: tools.map((t) => t.name),
        spec: { url: MCP_URL, mcp_tool_description: { tools } }
    }],
    capabilities: {
        conversation_starters: [
            { title: 'Revenue trend', text: 'Show Microsoft revenue and operating income for the last five fiscal years' },
            { title: 'Compare companies', text: 'Compare gross margin for Apple, Microsoft and Alphabet' },
            { title: 'Filing evidence', text: 'What does the latest Nvidia annual report say about customer concentration' }
        ]
    }
};

const agent = {
    $schema: 'https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.6/schema.json',
    version: 'v1.6',
    name: 'StockPortfolio',
    description: 'Answers questions about US-listed companies from their SEC filings, with the reporting period and source filing for every figure.',
    instructions: [
        'You help with questions about US-listed public companies using the StockPortfolio tools.',
        'If a company name is ambiguous, search for it first and use the exact ticker returned.',
        'State the fiscal period for every figure and cite the SEC source that accompanies it.',
        'A value that was not reported is null. Say that it is not available. Never estimate it or fill it from memory.',
        'Supplemental provider figures are separately attributed and must not be described as SEC-verified.',
        'If a result contains an account_notice, tell the user what it says.',
        'Do not give investment advice or recommendations to buy or sell.'
    ].join('\n'),
    conversation_starters: plugin.capabilities.conversation_starters,
    actions: [{ id: 'stockportfolioMcp', file: 'ai-plugin.json' }]
};

const manifest = {
    $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.22/MicrosoftTeams.schema.json',
    manifestVersion: '1.22',
    version: '1.0.0',
    id: '6f0c2a54-3d0b-4c7e-9a41-2b8f5d1e7c90',
    developer: {
        name: 'StockPortfolio.pro',
        websiteUrl: SITE,
        privacyUrl: `${SITE}/privacy.html`,
        termsOfUseUrl: `${SITE}/terms.html`
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    name: { short: 'StockPortfolio', full: 'StockPortfolio SEC filing data' },
    description: {
        short: 'Company financials and SEC filing evidence, every figure with its source.',
        full: 'StockPortfolio answers questions about US-listed public companies from what they filed with the SEC. Ask for financial statements, a metric over time, a comparison between companies, or what a filing says on a topic. Every figure comes with its fiscal period and the filing that reports it, and a figure a company did not report is shown as not available. A StockPortfolio.pro account is required. This agent does not give investment advice.'
    },
    accentColor: '#1C1B18',
    copilotAgents: { declarativeAgents: [{ id: 'stockportfolioAgent', file: 'declarativeAgent.json' }] },
    validDomains: ['www.stockportfolio.pro']
};

const files = { 'ai-plugin.json': plugin, 'declarativeAgent.json': agent, 'manifest.json': manifest };
const render = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(([name, obj]) => {
        try { return fs.readFileSync(path.join(OUT, name), 'utf8') !== render(obj); } catch (_) { return true; }
    }).map(([name]) => name);
    if (stale.length) { console.error(`stale: ${stale.join(', ')} — run node scripts/build-copilot-package.js`); process.exit(1); }
    console.log('copilot package is current');
} else {
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), render(obj));
    console.log(`wrote ${Object.keys(files).join(', ')} (${tools.length} tools) to ${path.relative(process.cwd(), OUT)}`);
}
