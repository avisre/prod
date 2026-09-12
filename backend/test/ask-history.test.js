'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

const appSource = fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'dashboard.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(root, 'frontend-v2', 'dashboard.html'), 'utf8');

test('successful Ask exchanges are saved as full-text reports in their own collection', () => {
    assert.match(appSource, /collection: 'ask_reports'/);
    // full answer stored — ai_chat_log truncates at 8000 chars, this store must not
    const schema = appSource.match(/const AskReportSchema = new mongoose\.Schema\(\{[\s\S]*?\}\);/);
    assert.ok(schema, 'AskReportSchema is declared');
    assert.doesNotMatch(schema[0], /maxlength/);
    assert.match(appSource, /function saveAskReport\(userId, question, answer, mode, toolsUsed\)/);
    // engine hands over [{tool,args,ok}] objects; the [String] schema needs names
    assert.match(appSource, /toolsUsed\.map\(\(t\) => \(typeof t === 'string' \? t : t && t\.tool\)\)\.filter\(Boolean\)/,
        'saveAskReport normalizes tool objects to names (Cast to [string] regression)');
    // best-effort: a save failure must never take down the Ask response path
    assert.match(appSource, /\[ask\] report save failed:/);
});

test('both /api/ai/chat success branches persist the report', () => {
    const hooks = appSource.match(/if \(result\.source === 'ai'\) saveAskReport\(userId, question, result\.answer, mode, result\.toolsUsed\);/g) || [];
    assert.equal(hooks.length, 2, 'streaming and non-streaming branches both save');
});

test('ask-history routes are owner-scoped and never touch credits', () => {
    assert.match(appSource, /app\.get\('\/api\/ask-history\/recent', authMiddleware/);
    assert.match(appSource, /app\.get\('\/api\/ask-history\/:id', authMiddleware/);
    // the single-report lookup must be constrained to the requesting user's own rows
    assert.match(appSource, /AskReport\.findOne\(\{ _id: req\.params\.id, userId: req\.userId \}\)/);
    assert.match(appSource, /Report not found\./);
    const routes = appSource.match(/app\.get\('\/api\/ask-history[^]+?(?=app\.get|app\.post)/g) || [];
    const historyBlock = routes.join('');
    assert.doesNotMatch(historyBlock, /credits\.spend/, 'reopening a saved answer must be free');
});

test('dashboard does not duplicate Ask history — saved answers live in /ask only', () => {
    // Owner decision 2026-08-30: the "Recent answers" section is gone from
    // the portfolio page; /ask's sidebar is the single home for saved chats.
    // The API routes stay (tested above: reopening is always free).
    assert.doesNotMatch(dashboardHtml, /recent-answers-section|recent-answers-list|Saved Ask reports/);
    assert.doesNotMatch(dashboardSource, /ask-history\/recent|openAnswerViewer|answer-viewer/);
    assert.match(dashboardHtml, /assets\/dashboard\.js\?v=20260912-planfix1/);
});