'use strict';

// AI Paper Portfolio — structural gating tests. These guarantees must hold for
// every future edit, not just today's code, so they are asserted against the
// source: the beta is invisible to everyone else, no trade path exists, the
// decision log is append-only, positions are written by exactly two sanctioned
// code paths (the construction commit + explicit owner steering), the chat
// tool surface cannot trade, and credits meter rather than gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const paper = require('../ai-paper-portfolio');

const root = path.join(__dirname, '..', '..');
const appSource = fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'backend', 'ai-chat.js'), 'utf8');
const modSource = fs.readFileSync(path.join(root, 'backend', 'ai-paper-portfolio.js'), 'utf8');
const creditsSource = fs.readFileSync(path.join(root, 'backend', 'credits.js'), 'utf8');

// ---- Route gating ----

test('exactly four ai-paper routes exist, each behind auth + betaGate', () => {
    const routes = appSource.match(/app\.(?:get|post|put|patch|delete)\('\/api\/ai-paper-portfolio[^']*'/g) || [];
    assert.deepEqual(routes.sort(), [
        "app.get('/api/ai-paper-portfolio'",
        "app.get('/api/ai-paper-portfolio/detail'",
        "app.post('/api/ai-paper-portfolio/create'",
        "app.post('/api/ai-paper-portfolio/stop'"
    ].sort(), 'probe + create + detail + stop, nothing else');
    for (const open of [
        "app.get('/api/ai-paper-portfolio',",
        "app.post('/api/ai-paper-portfolio/create',",
        "app.get('/api/ai-paper-portfolio/detail',",
        "app.post('/api/ai-paper-portfolio/stop',"
    ]) {
        const i = appSource.indexOf(open);
        assert.ok(i >= 0, `${open} exists`);
        assert.match(appSource.slice(i, i + 300), /authMiddleware, aiPaper\.betaGate/, `${open} carries both middlewares`);
    }
});

test('no trade endpoint or trade verb exists anywhere', () => {
    assert.equal(/\/api\/ai-paper-portfolio\/[a-z-]*(trade|buy|sell|order|reweigh|edit|position)/i.test(appSource), false);
    // The create route is a build, not an order: it forwards create()'s SSE
    // events and never writes positions itself.
    const ci = appSource.indexOf("app.post('/api/ai-paper-portfolio/create'");
    assert.ok(ci >= 0, 'create route exists');
    const createRoute = appSource.slice(ci, ci + 1400);
    assert.match(createRoute, /aiPaper\.create\(/);
    assert.equal(/\$set/.test(createRoute), false, 'the route layer never writes documents');
    // The stop route pauses, it never writes positions either.
    const si = appSource.indexOf("app.post('/api/ai-paper-portfolio/stop'");
    assert.match(appSource.slice(si, si + 400), /aiPaper\.stopBuild\(/, 'stop routes to the pause machinery');
    assert.equal(/\$set/.test(appSource.slice(si, si + 500)), false, 'the stop route never writes documents');
});

test('betaGate: 403 unless the env is armed AND the account is on the list', () => {
    const savedP = process.env.AI_PAPER_PORTFOLIO;
    const savedE = process.env.AI_PORTFOLIO_BETA_EMAILS;
    try {
        const res403 = () => {
            const out = { status: 0, body: null };
            return {
                status: (c) => { out.status = c; return { json: (b) => { out.body = b; } }; },
                out
            };
        };
        // env unset => fully off, even for the beta email
        delete process.env.AI_PAPER_PORTFOLIO;
        delete process.env.AI_PORTFOLIO_BETA_EMAILS;
        let r = res403(); let nexted = false;
        paper.betaGate({ user: { email: 'rin@example.com' } }, r, () => { nexted = true; });
        assert.equal(r.out.status, 403);
        assert.equal(r.out.body.code, 'BETA_NOT_ENABLED');
        assert.equal(nexted, false);

        // armed env, wrong account => 403
        process.env.AI_PAPER_PORTFOLIO = '1';
        process.env.AI_PORTFOLIO_BETA_EMAILS = 'rin@example.com';
        r = res403();
        paper.betaGate({ user: { email: 'someone-else@example.com' } }, r, () => { nexted = true; });
        assert.equal(r.out.status, 403);

        // armed env, beta account => through
        r = res403(); nexted = false;
        paper.betaGate({ user: { email: 'rin@example.com' } }, r, () => { nexted = true; });
        assert.equal(nexted, true);
        assert.equal(r.out.status, 0, 'no status written on success');
    } finally {
        if (savedP === undefined) delete process.env.AI_PAPER_PORTFOLIO; else process.env.AI_PAPER_PORTFOLIO = savedP;
        if (savedE === undefined) delete process.env.AI_PORTFOLIO_BETA_EMAILS; else process.env.AI_PORTFOLIO_BETA_EMAILS = savedE;
    }
});

// ---- Data invariants ----

test('the decision log is append-only: created, never updated or deleted', () => {
    assert.ok(/async function appendDecision/.test(modSource), 'a single append helper');
    assert.match(modSource, /return AIPaperDecision\(\)\.create\(/, 'the helper only ever creates');
    // no update/delete/findOneAndUpdate ever touches the decisions model, and
    // no raw collection access bypasses the model
    assert.equal(/AIPaperDecision\(\)\.(updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|bulkWrite|replaceOne)/.test(modSource), false);
    assert.equal(/collection\('ai_paper_decisions'\)/.test(modSource), false);
});

test('positions are written by exactly two code paths: the commit and owner steering', () => {
    const commit = modSource.match(/Portfolio\.updateOne\(\{ _id: doc\._id \}, \{\s*\$set: \{[\s\S]*?positions: sanitized\.positions/);
    assert.ok(commit, 'the commit writes positions');
    assert.match(modSource.slice(commit.index, commit.index + 600), /status: 'committed'/);
    assert.equal(commit.length, 1, 'exactly one commit site');
    // The only other writer is applySteering (explicit owner commands from
    // chat): its rebalance + override live inside that one function.
    const steerStart = modSource.indexOf('async function applySteering');
    assert.ok(steerStart >= 0, 'applySteering exists');
    const steerEnd = modSource.indexOf('\nasync function', steerStart + 10);
    const steer = modSource.slice(steerStart, steerEnd);
    const steerWrites = (steer.match(/Portfolio\.updateOne\(\{ _id: doc\._id \}, \{ \$set: \{ positions/g) || []).length;
    assert.equal(steerWrites, 2, 'steering writes positions in exactly two spots (allocate + override)');
    // Steering is guarded in code: only committed/tracking docs, never a build.
    assert.match(steer, /status === 'building' \|\| doc\.status === 'paused'/, 'steering refuses while building/paused');
    assert.match(steer, /status !== 'committed' && doc\.status !== 'tracking'/, 'steering refuses everything but committed/tracking');
    // No other Portfolio.updateOne in the module touches positions.
    const other = modSource.replace(steer, '').match(/Portfolio\.updateOne\(\{ _id: [^}]+\}, \{[\s\S]{0,400}?\}\)/g) || [];
    const otherPos = other.filter((w) => /\bpositions\b/.test(w));
    assert.equal(otherPos.length, 1, 'outside steering, only the construction commit writes positions');
    assert.match(otherPos[0], /positions: sanitized\.positions/);
    const appSets = appSource.match(/\$set[^)]{0,300}\)/g) || [];
    assert.equal(appSets.filter((w) => /positions\s*:/.test(w)).length, 0, 'app.js never $sets positions');
});

test('a paused build keeps its setup and its feed; a fresh run clears it', () => {
    // paused is a first-class status, not a failure
    assert.match(modSource, /status: \{ \$in: \['building', 'paused', 'committed', 'tracking', 'failed'\] \}/, 'findFor serves paused docs');
    // a paused doc is NOT a live run: the retry deletes it (below) and starts fresh
    assert.match(modSource, /status: \{ \$in: \['building', 'committed', 'tracking'\] \}/, 'create() refuses live runs only');
    // the setup intent rides on the doc
    assert.match(modSource, /setup: \{ guruId: hasGuru \? guru\.id : '', constraints: cleanedConstraints \}/, 'create() persists the setup intent');
    assert.match(modSource, /steeringRules: \{ type: \[String\], default: \[\] \}/, 'standing owner rules live on the doc');
    // the capped on-doc feed survives disconnects
    assert.match(modSource, /buildLog: \{ type: \[String\], default: \[\] \}/, 'the feed is stored on the doc');
    assert.match(modSource, /\$slice: -BUILD_LOG_CAP/, 'the feed is capped');
    assert.match(modSource, /const BUILD_LOG_CAP = 120/, 'the cap is 120 lines');
    // pausing is a controlled transition, never a failure record
    const pause = modSource.slice(modSource.indexOf('async function pauseBuild'), modSource.indexOf('// Live run registry'));
    assert.match(pause, /status: 'paused'/);
    assert.equal(/\$set: \{ status: 'failed'/.test(pause), false, 'pause never records a failure');
});

test('the reset path only ever deletes the portfolio doc', () => {
    const reset = modSource.slice(modSource.indexOf('async function resetRun'), modSource.indexOf('// Owner steering'));
    assert.match(reset, /AIPaperPortfolio\(\)\.deleteOne\(\{ _id: doc\._id \}\)/);
    assert.equal(/AIPaperDecision|AIPaperSnapshot/.test(reset), false, 'decisions and snapshots are never deleted');
    // failed AND paused builds self-clear so a retry is never 409-trapped
    assert.match(modSource, /Portfolio\.deleteMany\(\{ user: userId, status: \{ \$in: \['failed', 'paused'\] \} \}\)/);
});

// ---- Chat tool surface ----

test('the ai-paper chat tools are exactly status/setup/steer/reset — nothing that could trade', () => {
    const names = modSource.match(/name: 'ai_portfolio_[a-z_]+'/g) || [];
    assert.deepEqual(names.sort(), [
        "name: 'ai_portfolio_reset'",
        "name: 'ai_portfolio_setup'",
        "name: 'ai_portfolio_status'",
        "name: 'ai_portfolio_steer'"
    ].sort());
    assert.equal(/ai_portfolio_(trade|buy|sell|reweigh|edit|weight)/.test(modSource + chatSource + appSource), false, 'no trade-shaped tool name exists');
    // steer carries an explicit-owner-command contract in its description —
    // the model may only relay an instruction the owner just gave.
    assert.match(modSource, /Apply an EXPLICIT instruction the owner just gave/, 'the steer tool documents its own limits');
});

test('the tools ride the per-request ctx only — never the global TOOLS registry', () => {
    const toolsBlock = chatSource.slice(chatSource.indexOf('const TOOLS = ['), chatSource.indexOf('const MAX_ITERS'));
    assert.equal(/ai_portfolio/.test(toolsBlock), false, 'no ai-paper tool in the global registry');
    assert.match(chatSource, /TOOLS\.concat\(ctx\.aiPaperTools\)/, 'beta tools are concatenated per request');
    assert.match(chatSource, /startsWith\('ai_portfolio_'\)/, 'runTool reaches them only through the ctx handler');
    assert.match(chatSource, /typeof ctx\.aiPaperRunTool === 'function'/, '…and only when the handler was injected');
    assert.match(chatSource, /if \(ctx && ctx\.aiPaperContext\)/, 'experiment context is injected the same per-request way');
});

test('aiPaperMode is honored only behind the server-side beta gate', () => {
    assert.match(appSource, /req\.body && req\.body\.aiPaperMode\) === true && aiPaper\.isBetaUser\(req\.user\)/, 'flag + isBetaUser gate');
    // the gate result feeds BOTH ask() call sites (stream + plain)
    assert.equal((appSource.match(/holdings, userId, memoryConsent, attachments/g) || []).length, 2);
    assert.match(appSource, /aiPaperCtx \? \{ \.\.\.aiPaperCtx, aiPaperProgress:/, 'SSE branch carries progress');
    assert.match(appSource, /\.\.\.\(aiPaperCtx \|\| \{\}\)/, 'plain branch carries the ctx');
});

test('the chat tool handler can only read, kick a build, steer, or reset', () => {
    const hi = appSource.indexOf('async function runAiPaperChatTool');
    assert.ok(hi >= 0, 'handler exists');
    // the slice stops at the first route registration after the handler, so
    // only the handler body is inspected
    const handler = appSource.slice(hi, appSource.indexOf('// Probe + state:', hi));
    const refs = [...handler.matchAll(/aiPaper\.(\w+)/g)].map((m) => m[1]);
    assert.ok(refs.length >= 3, 'handler found and calls the module');
    assert.deepEqual([...new Set(refs)].sort(), ['applySteering', 'create', 'resetRun', 'resolveGuru', 'statusFor'], 'no other module surface is reachable from chat');
});

// ---- Daily loop + credits ----

test('the sweep starts at boot inside the DISABLE_BACKGROUND_JOBS guard', () => {
    const guard = appSource.indexOf('if (String(process.env.DISABLE_BACKGROUND_JOBS');
    const start = appSource.indexOf('aiPaper.start();');
    assert.ok(guard >= 0 && start > guard, 'start() is inside the guard block');
    assert.equal(appSource.slice(0, guard).includes('aiPaper.start()'), false, 'never started outside the guard');
    // the module also self-gates: env off or jobs disabled => no timers at all
    assert.match(modSource, /if \(!betaEnabled\(\)\) return;/);
    assert.match(modSource, /DISABLE_BACKGROUND_JOBS \|\| ''\) === '1'\) return;/);
});

test('credits meter the feature, never gate it', () => {
    assert.match(creditsSource, /ai_paper_build: 10/);
    assert.match(creditsSource, /ai_paper_daily: 4/);
    assert.match(modSource, /credits\.spend\(userId, 'ai_paper_build'/);
    assert.match(modSource, /credits\.spend\(fresh\.user, 'ai_paper_daily'/);
    assert.equal(/credits\.check/.test(modSource.slice(modSource.indexOf('async function create'))), false, 'create never blocks on credits');
    assert.match(modSource, /add that gate before any wider rollout/, 'the missing check gate is documented for rollout');
});