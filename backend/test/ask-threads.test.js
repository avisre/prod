'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

const appSource = fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'backend', 'ai-chat.js'), 'utf8');
const bundleSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
const askHtml = fs.readFileSync(path.join(root, 'frontend-v2', 'ask.html'), 'utf8');

// ---- Threads (Ask only) ----

test('threads get their own collection with per-user and per-thread caps', () => {
    assert.match(appSource, /collection: 'ask_threads'/);
    const schema = appSource.match(/const AskThreadSchema = new mongoose\.Schema\(\{[\s\S]*?\}\);/);
    assert.ok(schema, 'AskThreadSchema is declared');
    assert.match(schema[0], /userId: \{ type: mongoose\.Schema\.Types\.ObjectId, ref: 'User', required: true \}/);
    assert.match(appSource, /ASK_THREAD_KEEP = 100/);
    assert.match(appSource, /ASK_THREAD_MSG_KEEP = 80/);
    assert.match(appSource, /AskThreadSchema\.index\(\{ userId: 1, updatedAt: -1 \}\)/);
});

test('the chat route uses server-side thread history when a threadId is present', () => {
    assert.match(appSource, /const hasThread = typeof threadIdRaw === 'string' && THREAD_ID_RE\.test\(threadIdRaw\)/);
    assert.match(appSource, /const history = hasThread\s*\? await aiChat\.threadHistory\(userId, threadIdRaw\)/);
    // ai-chat: owner-checked, flattened to {role, content}, empty on a bad/foreign id
    assert.match(chatSource, /async function threadHistory\(userId, threadId, n = 16\)/);
    assert.match(chatSource, /findOne\(\{ _id: tid, userId: uid \}, \{ projection: \{ messages: \{ \$slice: -n \} \} \}\)/);
});

test('both /api/ai/chat success branches save the thread and return its id', () => {
    const hooks = appSource.match(/await saveThreadExchange\(userId, threadIdRaw, question, result\.answer, mode, result\.toolsUsed\)/g) || [];
    assert.equal(hooks.length, 2, 'streaming and non-streaming branches both save');
    // the streaming 'done' payload and the JSON response both carry threadId
    assert.match(appSource, /threadId: threadIdSaved/);
    assert.equal((appSource.match(/threadId: threadIdSaved/g) || []).length, 2);
    // best-effort: a thread save failure must never take down the response
    assert.match(appSource, /\[ask\] thread save failed:/);
});

test('thread routes are owner-scoped and never touch credits', () => {
    assert.match(appSource, /app\.get\('\/api\/ask\/threads', authMiddleware/);
    assert.match(appSource, /app\.get\('\/api\/ask\/threads\/:id', authMiddleware/);
    assert.match(appSource, /app\.patch\('\/api\/ask\/threads\/:id', authMiddleware/);
    assert.match(appSource, /app\.delete\('\/api\/ask\/threads\/:id', authMiddleware/);
    assert.match(appSource, /AskThread\.findOne\(\{ _id: req\.params\.id, userId: req\.userId \}\)/);
    assert.match(appSource, /AskThread\.deleteOne\(\{ _id: req\.params\.id, userId: req\.userId \}\)/);
    assert.match(appSource, /Thread not found\./);
    const routes = appSource.match(/app\.(get|patch|delete)\('\/api\/ask\/threads[^]+?(?=\/\/ Ask memory|app\.(get|post|patch|delete))|app\.(get|patch|delete)\('\/api\/ask\/threads[\s\S]*?(?=\/\/ Ask memory)/g) || [];
    const threadBlock = routes.join('');
    assert.ok(threadBlock.includes("'/api/ask/threads"), 'thread routes located');
    assert.doesNotMatch(threadBlock, /credits\.spend/, 'reading or managing a thread must be free');
});

test('ask page renders a chat sidebar and sends threadId with asks', () => {
    assert.match(askHtml, /id="new-chat"/);
    assert.match(askHtml, /id="chat-list"/);
    assert.match(askHtml, /id="side-open"/);
    assert.match(askHtml, /\/ask\/threads\//);
    assert.match(askHtml, /async function openThread\(id\)/);
    assert.match(askHtml, /renderSavedMessage\(m\.role, m\.content\)/);
    // the engine call is the one place threadId enters the request body
    assert.match(askHtml, /engine\.send\(q, token\(\) && currentThreadId \? \{ threadId: currentThreadId \} : \{\}\)/);
    // a saved transcript uses the same esc/markdown path as a live answer
    assert.match(askHtml, /\$\{esc\(t\.title \|\| 'New chat'\)\}/);
});

test('the shared engine merges an optional threadId into the chat POST', () => {
    assert.match(bundleSource, /async function send\(question, opts = \{\}\)/);
    assert.match(bundleSource, /\.\.\.\(opts && opts\.threadId \? \{ threadId: opts\.threadId \} : \{\}\)/);
    assert.match(bundleSource, /remember: \(a\) => `Remembered/);
});

// ---- Memory (consent-gated) ----

test('memories get their own collection with a 500-char cap and 50-per-user prune', () => {
    assert.match(appSource, /collection: 'ask_memories'/);
    assert.match(appSource, /ASK_MEMORY_MAX = 500/);
    assert.match(appSource, /ASK_MEMORY_KEEP = 50/);
    assert.match(appSource, /async function pruneMemories\(userId\)/);
    // ai-chat's remember tool writes through the same cap
    assert.match(chatSource, /const fact = String\(\(args && args\.fact\) \|\| ''\)\.trim\(\)\.slice\(0, 500\)/);
});

test('memory consent is an explicit per-user flag that defaults to OFF', () => {
    const flag = appSource.match(/askMemoryEnabled: \{[^}]*\}/);
    assert.ok(flag, 'User schema carries askMemoryEnabled');
    assert.match(flag[0], /default: false/);
    // the assistant only reads/writes on consent
    assert.match(chatSource, /if \(ctx && ctx\.memoryConsent && ctx\.userId\)/);
    assert.match(chatSource, /if \(!ctx \|\| !ctx\.memoryConsent\) return \{ error: 'Memory is off for this user\.[^']*' \}/);
    // the chat route derives consent from the user row
    assert.match(appSource, /const memoryConsent = !!\(req\.user && req\.user\.askMemoryEnabled\)/);
});

test('consented memory reaches the prompt as system context, and only then', () => {
    assert.match(chatSource, /async function loadMemories\(userId\)/);
    assert.match(chatSource, /THINGS THE USER ASKED YOU TO REMEMBER/);
    assert.match(chatSource, /role: 'system',\s*\n\s*content: `THINGS THE USER ASKED YOU TO REMEMBER/);
    // bounded context: at most 20 memories / ~2k chars
    assert.match(chatSource, /\.limit\(20\)\.toArray\(\)/);
    assert.match(chatSource, /total \+ c\.length > 2000/);
});

test('memory routes are owner-scoped, free, and honour the 500-char cap', () => {
    assert.match(appSource, /app\.get\('\/api\/ask\/memory', authMiddleware/);
    assert.match(appSource, /app\.put\('\/api\/ask\/memory\/consent', authMiddleware/);
    assert.match(appSource, /app\.post\('\/api\/ask\/memory', authMiddleware/);
    assert.match(appSource, /app\.delete\('\/api\/ask\/memory\/:id', authMiddleware/);
    assert.match(appSource, /app\.delete\('\/api\/ask\/memory', authMiddleware/);
    assert.match(appSource, /AskMemory\.deleteOne\(\{ _id: req\.params\.id, userId: req\.userId \}\)/);
    assert.match(appSource, /AskMemory\.deleteMany\(\{ userId: req\.userId \}\)/);
    assert.match(appSource, /String\(\(req\.body && req\.body\.content\) \|\| ''\)\.trim\(\)\.slice\(0, ASK_MEMORY_MAX\)/);
    const memoryRoutes = appSource.match(/app\.get\('\/api\/ask\/memory', authMiddleware[\s\S]*?app\.delete\('\/api\/ask\/memory', authMiddleware[\s\S]*?\n    \}\);/);
    assert.ok(memoryRoutes, 'memory route block located');
    assert.doesNotMatch(memoryRoutes[0], /credits\.spend/, 'memory must never touch credits');
});

test('memory is surfaced in the sidebar with toggle, list, delete and clear-all', () => {
    assert.match(askHtml, /id="mem-toggle"/);
    assert.match(askHtml, /id="mem-panel"/);
    assert.match(askHtml, /id="mem-clear"/);
    assert.match(askHtml, /\/ask\/memory\/consent/);
    assert.match(askHtml, /async function loadMemory\(\)/);
    assert.match(askHtml, /method: 'DELETE', headers: \{ Authorization: `Bearer \$\{token\(\)\}` \} \}/);
});

// ---- Stamps ----

test('asset stamps were bumped together (the ritual that bites twice)', () => {
    assert.match(askHtml, /assets\/app\.js\?v=20260829-askthreads1/);
    assert.match(askHtml, /assets\/system\.css\?v=20260829-askthreads1/);
    [askHtml, bundleSource].forEach((src) => assert.doesNotMatch(src, /20260829-profilemenu1/));
});