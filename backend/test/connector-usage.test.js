'use strict';

// Connector usage on the profile page (owner decision 2026-10-08): each call
// records what it was about, refused calls are recorded at all, and the month
// folds into sessions with a pace forecast and a CSV.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const usage = require('../connector-usage');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const at = (hhmmss) => new Date(`2026-10-08T${hhmmss}Z`);
const call = (time, tool, refId, cost = 2, client = 'Claude') => ({ at: at(time), reason: `mcp:${tool}`, refId, delta: -cost, client });

test('the subject is the ticker, or the ticker and the first words of the question, never the whole prompt', () => {
    assert.equal(usage.subjectFor({ ticker: 'aapl' }), 'AAPL');
    assert.equal(usage.subjectFor({ query: 'Berkshire' }), 'Berkshire');
    assert.equal(usage.subjectFor({ accession_number: '0000320193-25-000079' }), '0000320193-25-000079');
    assert.equal(
        usage.subjectFor({ ticker: 'MSFT', question: 'How did cloud revenue growth change over the last three fiscal years and why?' }),
        'MSFT: How did cloud revenue growth change over the…'
    );
    // Control characters and newlines cannot reach the log, and the length is bounded.
    assert.equal(usage.subjectFor({ ticker: 'A\nB', question: 'x\ty\u0000z' }), 'A B: x y z');
    assert.ok(usage.subjectFor({ question: 'w'.repeat(500) }).length <= 80);
    for (const empty of [undefined, null, {}, { ticker: '   ' }, 'AAPL', ['AAPL']]) assert.equal(usage.subjectFor(empty), null);
    // The ChatGPT app endpoint names things differently: a company, a list, a metric.
    assert.equal(usage.subjectFor({ company: 'Apple Inc.' }), 'Apple Inc.');
    assert.equal(usage.subjectFor({ company: 'nvda', metric: 'revenue' }), 'NVDA: revenue');
    assert.equal(usage.subjectFor({ companies: ['aapl', 'msft'], metrics: ['revenue', 'net_income'] }), 'AAPL, MSFT: revenue, net_income');
    assert.equal(usage.subjectFor({ companies: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), 'A, B, C, D, E…');
    assert.equal(usage.subjectFor({ company: { ticker: 'AAPL' } }), null, 'an object is not a name');
});

test('a burst folds into one session, and a gap starts another', () => {
    const rows = [
        call('12:56:10', 'search_filings', 'NVDA'),
        call('12:57:02', 'ask_filings', 'NVDA: What drove data centre growth?', 42),
        call('12:57:40', 'get_company_fundamentals', 'NVDA'),
        call('12:58:01', 'get_company_fundamentals', 'AMD'),
        call('12:58:04', 'get_company_fundamentals', 'AMD'),
        // 40 minutes later: a different sitting.
        call('13:38:00', 'get_company_fundamentals', 'INTC')
    ];
    const refusals = [{ at: at('12:58:10'), tool: 'get_company_fundamentals', subject: 'TSM', code: 'QUOTA_EXCEEDED', client: 'Claude' }];
    const [latest, first] = usage.sessions(rows, refusals);

    assert.equal(latest.calls, 1);
    assert.deepEqual(latest.subjects, ['INTC']);

    assert.equal(first.start, '2026-10-08T12:56:10.000Z');
    assert.equal(first.end, '2026-10-08T12:58:10.000Z', 'a refusal extends the session it happened in');
    assert.equal(first.calls, 5);
    assert.equal(first.credits, 50);
    assert.equal(first.refused, 1);
    assert.deepEqual(first.refusedBy, [{ code: 'QUOTA_EXCEEDED', label: 'Out of credits', count: 1 }]);
    assert.deepEqual(first.tools[0], { tool: 'get_company_fundamentals', count: 3 });
    assert.deepEqual(first.subjects, ['NVDA', 'NVDA: What drove data centre growth?', 'AMD', 'TSM'], 'each subject once, in the order asked');
    assert.equal(first.client, 'Claude');
    // Call by call, in order, with the refusal where it happened.
    assert.equal(first.items.length, 6);
    assert.deepEqual(first.items[1], { at: '2026-10-08T12:57:02.000Z', tool: 'ask_filings', subject: 'NVDA: What drove data centre growth?', credits: 42, refused: null });
    assert.deepEqual(first.items[5], { at: '2026-10-08T12:58:10.000Z', tool: 'get_company_fundamentals', subject: 'TSM', credits: 0, refused: 'Out of credits' });
    // A runaway session is capped in the response; the count of what was left out is kept.
    const long = Array.from({ length: 230 }, (_, i) => call(`12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, 'get_company_fundamentals', 'T' + i));
    const [capped] = usage.sessions(long, []);
    assert.equal(capped.calls, 230);
    assert.equal(capped.items.length, 200);
    assert.equal(capped.itemsDropped, 30);
});

test('only connector and API spend is a call: web spend, grants and comps are not', () => {
    const rows = [
        { at: at('10:00:00'), reason: 'ask', refId: null, delta: -2 },
        { at: at('10:00:05'), reason: 'dossier', refId: 'AAPL:deep', delta: -41 },
        { at: at('10:00:10'), reason: 'comp', refId: 'x', delta: 500 },
        { at: at('10:00:15'), reason: 'topup', refId: 'cs_1', delta: 150 },
        { at: at('10:00:20'), reason: 'api:fundamentals', refId: 'KO', delta: -2 },
        { at: at('10:00:25'), reason: 'mcp-apps:get_company_fundamentals', refId: null, delta: -2 }
    ];
    const [s] = usage.sessions(rows, []);
    assert.equal(s.calls, 2);
    assert.equal(s.credits, 4);
    assert.equal(s.client, null);
});

test('the pace forecast appears only for a session that is running and close to empty', () => {
    // Todd's run on 2026-10-08: 104 credits between 12:56 and 13:24.
    const hot = [{ start: '2026-10-08T12:56:00.000Z', end: '2026-10-08T13:24:00.000Z', calls: 32, credits: 104 }];
    const now = at('13:25:00');
    assert.deepEqual(usage.pace(hot, 496, now), { creditsPerMinute: 3.7, minutesLeft: 133 });
    assert.deepEqual(usage.pace(hot, 0, now), { creditsPerMinute: 3.7, minutesLeft: 0 });
    assert.equal(usage.pace(hot, 5000, now), null, 'hours of headroom is not worth a warning');
    assert.equal(usage.pace(hot, 496, at('13:40:00')), null, 'the session ended; nothing is running');
    assert.equal(usage.pace([{ ...hot[0], calls: 2 }], 496, now), null, 'two calls are not a pace');
    assert.equal(usage.pace([], 496, now), null);
    // A burst inside one minute is rated over a full minute, not over seconds.
    const burst = [{ start: '2026-10-08T13:24:50.000Z', end: '2026-10-08T13:24:58.000Z', calls: 4, credits: 8 }];
    assert.deepEqual(usage.pace(burst, 40, now), { creditsPerMinute: 8, minutesLeft: 5 });
});

test('a refusal is recorded with its reason, and a retry loop cannot fill the collection', async () => {
    usage._resetForTest();
    const inserted = [];
    const col = { insertOne: async (doc) => { inserted.push(doc); } };
    const now = at('13:25:00');
    assert.equal(await usage.recordRefusal(col, { userId: 'u1', tool: 'get_company_fundamentals', subject: 'TSM', code: 'QUOTA_EXCEEDED', client: 'Claude' }, now), true);
    assert.deepEqual(inserted[0], { userId: 'u1', month: '2026-10', at: now, tool: 'get_company_fundamentals', subject: 'TSM', code: 'QUOTA_EXCEEDED', client: 'Claude' });
    // Not a refusal the customer can act on: an unknown tool or a bad ticker is not logged here.
    assert.equal(await usage.recordRefusal(col, { userId: 'u1', tool: 'x', code: 'UNKNOWN_TOOL' }, now), false);
    assert.equal(await usage.recordRefusal(col, { tool: 'x', code: 'QUOTA_EXCEEDED' }, now), false, 'no account, no row');
    for (let i = 0; i < 200; i += 1) await usage.recordRefusal(col, { userId: 'u1', tool: 't', code: 'QUOTA_EXCEEDED' }, now);
    assert.equal(inserted.length, usage.REFUSALS_PER_USER_PER_HOUR);
    // The cap is per account and lifts with the hour.
    assert.equal(await usage.recordRefusal(col, { userId: 'u2', tool: 't', code: 'ENTITLEMENT_REQUIRED' }, now), true);
    assert.equal(await usage.recordRefusal(col, { userId: 'u1', tool: 't', code: 'QUOTA_EXCEEDED' }, at('14:25:01')), true);
    // A database failure is swallowed: the refusal itself must still reach the caller.
    assert.equal(await usage.recordRefusal({ insertOne: async () => { throw new Error('down'); } }, { userId: 'u3', tool: 't', code: 'QUOTA_EXCEEDED' }, now), false);
});

test('the CSV lists calls and refusals in order and cannot run a formula', () => {
    const csv = usage.toCsv(
        [call('12:56:10', 'ask_filings', '=HYPERLINK("http://x","y"), with a comma', 42), call('12:57:00', 'get_company_fundamentals', 'AAPL')],
        [{ at: at('12:58:00'), tool: 'get_company_fundamentals', subject: 'TSM', code: 'QUOTA_EXCEEDED', client: 'Claude' }]
    );
    const lines = csv.trimEnd().split('\r\n');
    assert.equal(lines[0], 'time_utc,via,client,tool,subject,result,credits');
    assert.equal(lines[1], '2026-10-08T12:56:10.000Z,connector,Claude,ask_filings,"\'=HYPERLINK(""http://x"",""y""), with a comma",ok,42');
    assert.equal(lines[2], '2026-10-08T12:57:00.000Z,connector,Claude,get_company_fundamentals,AAPL,ok,2');
    assert.equal(lines[3], '2026-10-08T12:58:00.000Z,connector,Claude,get_company_fundamentals,TSM,refused: Out of credits,0');
});

test('the connector passes the subject to the ledger and keeps it out of the application log', () => {
    const endpoint = read('mcp-endpoint.js');
    assert.match(endpoint, /const subject = ctx\.anonymous \? null : connectorUsage\.subjectFor\(args\);/);
    assert.match(endpoint, /deps\.limiter\.spend\(ctx\.userId, def\.aiCost \? 'mcp_ask' : 'mcp_lookup', `mcp:\$\{def\.name\}`, subject, ctx\.client \|\| null\);/);
    // The subject rides beside the event; the event object is what gets printed.
    assert.match(endpoint, /caller: ctx\.logId \|\| null\s*\}, \{ subject \}\);/);
    assert.match(endpoint, /try \{ deps\.onLog\(event, detail\); \}/);

    const app = read('app.js');
    assert.match(app, /onLog: \(evt, detail\) => \{ logMcp\(evt\); nudgeOnRefusal\(req, evt\); recordConnectorRefusal\(req, evt, detail, client\); \}/);
    assert.match(app, /function logMcp\(event\) \{\s*try \{ console\.log\('\[mcp\]', JSON\.stringify\(event\)\); \}/, 'logMcp prints the event only');
    assert.match(app, /col\('connector_refusals'\)\.createIndex\(\{ userId: 1, month: 1, at: 1 \}/);
    // Both endpoints read only the signed-in account's own rows.
    for (const route of ["app.get('/api/credits/connector', authMiddleware,", "app.get('/api/credits/connector.csv', authMiddleware,"]) {
        assert.ok(app.includes(route), `${route} is registered behind authMiddleware`);
    }
    assert.match(app, /find\(\{ userId: String\(userId\), month, reason: \/\^\(mcp\|mcp-apps\|api\):\/ \}\)/);
    assert.match(app, /collection\('connector_refusals'\)\.find\(\{ userId: String\(userId\), month \}\)/);

    assert.match(read('credits.js'), /\.\.\.\(client \? \{ client: String\(client\)\.slice\(0, 60\) \} : \{\}\)/);

    // The ChatGPT app endpoint does the same, or its calls show up with no detail.
    const apps = read('mcp-apps.js');
    assert.match(apps, /const subject = ctx\.anonymous \? null : connectorUsage\.subjectFor\(args\);/);
    // costKey is mcp_ask for a tool that runs the model (aiCost), else mcp_lookup.
    assert.match(apps, /const costKey = def\.aiCost \? 'mcp_ask' : 'mcp_lookup';/);
    assert.match(apps, /deps\.limiter\.spend\(ctx\.userId, costKey, `mcp-apps:\$\{name\}`, subject, ctx\.client \|\| null\);/);
    assert.match(apps, /caller: ctx\.logId \|\| null \}, \{ subject \}\);/);
    assert.match(app, /onLog: \(evt, detail\) => \{ console\.log\('\[mcp-apps\]', JSON\.stringify\(evt\)\); nudgeOnRefusal\(req, evt\); recordConnectorRefusal\(req, evt, detail, client\); \}/);
});

test('the profile page carries the panel, the refill button and the script', () => {
    const page = read('..', 'frontend-v2', 'profile.html');
    assert.match(page, /<div id="connector-usage" hidden>/);
    assert.match(page, /<a rel="nofollow" class="btn btn-primary btn-sm" href="\/recharge\.html">Add credits<\/a>/);
    assert.match(page, /id="cu-csv"/);
    assert.match(page, /<script src="assets\/connector-usage\.js\?v=[\w-]+"><\/script>/);
    const script = read('..', 'frontend-v2', 'assets', 'connector-usage.js');
    assert.match(script, /At this pace, your credits last about/);
    // Subjects are text an assistant typed: escaped before they reach the page.
    assert.match(script, /<span class="cu-chip">\$\{esc\(x\)\}<\/span>/);
});
