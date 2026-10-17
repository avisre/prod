'use strict';
// Ask and the AI Paper Portfolio experiment are separate pages with separate
// chats (owner, 2026-10-11). The experiment used to be a toggle inside Ask and
// shared its chat list and context.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'frontend-v2', 'ask.html'), 'utf8');
const between = (src, from, to) => { const i = src.indexOf(from); assert.ok(i > -1, `missing: ${from}`); const j = src.indexOf(to, i + from.length); return src.slice(i, j > -1 ? j : i + 4000); };

test('the experiment has its own page address, kept out of search engines', () => {
    const route = between(app, "app.get('/ai-portfolio', (req, res, next) => {", '\n});');
    assert.match(route, /aiPortfolioPage\(\)/);
    assert.match(route, /X-Robots-Tag', 'noindex, nofollow'/);
    assert.match(route, /Cache-Control', 'no-store'/);
});

test('the page marker lands on the real body tag, not on text that mentions it', () => {
    // ask.html says "<body>" inside a CSS comment before the tag itself; a plain
    // first-match replace marked the comment and left the page unmarked.
    assert.ok(page.indexOf('<body>') < page.search(/^<body>$/m), 'the template still has an earlier "<body>" mention');
    const marked = page.replace(/^<body>$/m, '<body data-surface="paper">');
    assert.equal((marked.match(/^<body data-surface="paper">$/mg) || []).length, 1);
    assert.match(app, /\.replace\(\/\^<body>\$\/m, '<body data-surface="paper">'\)/);
});

test('old experiment links on Ask are sent to the new page', () => {
    const route = between(app, "app.get(['/ask', '/ask.html'], (req, res, next) => {", '\n});');
    assert.match(route, /req\.query\.aiPaper === '1'/);
    assert.match(route, /res\.redirect\(302, `\/ai-portfolio\$\{q\}`\)/);
    assert.match(page, /SURFACE === 'ask' && params0\.get\('aiPaper'\) === '1'/);
});

test('a chat belongs to one page: saved, continued, listed, opened and pruned by surface', () => {
    assert.match(app, /surface: \{ type: String, enum: \['ask', 'paper'\], default: 'ask' \}/);
    // chats saved before the split carry no value and must stay with Ask
    assert.match(app, /askSurface\(surface\) === 'paper' \? \{ surface: 'paper' \} : \{ surface: \{ \$ne: 'paper' \} \}/);
    const save = between(app, 'async function saveThreadExchange(', '\n}\n');
    assert.match(save, /\{ _id: threadId, userId, \.\.\.surfaceMatch\(surface\) \}/);
    assert.match(save, /surface: askSurface\(surface\),/);
    assert.match(save, /AskThread\.find\(\{ userId: doc\.userId, \.\.\.surfaceMatch\(surface\) \}/);
    const list = between(app, "app.get('/api/ask/threads', authMiddleware", '\n});');
    assert.match(list, /const matchStage = \{ userId: uid, \.\.\.own \}/);
    assert.match(list, /\{ \$text: \{ \$search: q \}, userId: uid, \.\.\.own \}/);
    const one = between(app, "app.get('/api/ask/threads/:id', authMiddleware", '\n});');
    assert.match(one, /userId: req\.userId, \.\.\.surfaceMatch\(req\.query && req\.query\.surface\)/);
});

test('the chat route never carries one page\'s conversation into the other', () => {
    assert.match(app, /const chatSurface = aiPaperCtx \? 'paper' : 'ask';/);
    assert.match(app, /AskThread\.exists\(\{ _id: threadIdRaw, userId, \.\.\.surfaceMatch\(chatSurface\) \}\)/);
    // no fallback to Ask's rolling history, and nothing written into it
    assert.match(app, /chatSurface === 'paper' \? \[\] : await aiChat\.recentHistory\(userId\)/);
    assert.equal((app.match(/result\.source === 'ai' && !temporary && chatSurface !== 'paper'\) aiChat\.saveExchange\(/g) || []).length, 2);
    assert.doesNotMatch(app, /if \(result\.source === 'ai'\) aiChat\.saveExchange\(/);
    assert.equal((app.match(/saveThreadExchange\(userId, threadIdRaw, question, result\.answer, mode, result\.toolsUsed, chatSurface, edit \? edit\.index : null, regenerate\)/g) || []).length, 2);
});

test('the Ask page never shows or runs the experiment', () => {
    assert.doesNotMatch(page, /\$\('ask-mode-paper'\)\.hidden = false/);
    assert.match(page, /if \(SURFACE !== 'paper'\) return; \/\/ Ask never runs the experiment/);
    // the probe that arms the experiment runs only on its own page
    // every other call sits in experiment-only code (its build feed and card)
    const start = page.search(/^      if \(SURFACE === 'paper'\) \{$/m);
    assert.ok(start > -1 && /if \(token\(\)\) probePaper\(\);/.test(page.slice(start, start + 1200)));
    assert.doesNotMatch(page, /^      if \(token\(\)\) probePaper\(\);$/m);
    assert.match(page, /if \(SURFACE === 'paper'\) \{[\s\S]{0,900}if \(token\(\)\) probePaper\(\); else window\.location\.replace\('\/ask'\);/);
});

test('the experiment page sends nothing as an Ask question and uses only its own chats', () => {
    assert.match(page, /if \(SURFACE === 'paper' && !paperMode\) return;/);
    assert.match(page, /const SURFACE_QS = SURFACE === 'paper' \? 'surface=paper' : '';/);
    assert.match(page, /\$\{API\}\/ask\/threads\/\$\{id\}\$\{SURFACE_QS \? `\?\$\{SURFACE_QS\}` : ''\}/);
    assert.doesNotMatch(page, /replaceState\(null, '', [`']\/ask/);
    assert.match(page, /if \(r\.status === 401 \|\| r\.status === 403\) \{ window\.location\.replace\('\/ask'\); return; \}/);
});
