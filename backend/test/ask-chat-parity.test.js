'use strict';

// Ask chat parity with ChatGPT and Claude (2026-10-18): edit a sent question,
// temporary chats, code blocks with Copy, read aloud, paste and drop files,
// export a chat, keyboard shortcuts and jump to latest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'system.css'), 'utf8');
const page = fs.readFileSync(path.join(root, 'frontend-v2', 'ask.html'), 'utf8');

function fnSource(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `${signature} exists`);
    const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
    const end = source.indexOf(`\n${indent}}`, start) + indent.length + 2;
    return source.slice(start, end);
}
function serverFn(name, context) {
    return vm.runInNewContext('(' + fnSource(app, `async function ${name}(`) + ')', {
        require: () => ({ QUESTION_MAX_CHARS: 60000, ANSWER_MAX_CHARS: 32000 }), console, ...context
    });
}

const THREAD = '000000000000000000000002';
const USER = '000000000000000000000001';
const transcript = [
    { role: 'user', content: 'What does AAPL earn?' }, { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'And MSFT?' }, { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'Compare them.' }, { role: 'assistant', content: 'A3' }
];
const lean = (doc) => ({ lean: async () => doc });

test('editing finds the question at its index, or the nearest copy of its words, and gives the model only what came before', async () => {
    const threadEdit = serverFn('threadEdit', { AskThread: { findOne: () => lean({ messages: transcript }) } });
    const at = await threadEdit(USER, THREAD, { index: 2, content: 'And MSFT?' });
    assert.equal(at.index, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(at.history)), transcript.slice(0, 2));
    // the page counted differently (an older part of the chat was pruned): matched by text
    assert.equal((await threadEdit(USER, THREAD, { index: 0, content: ' Compare them. ' })).index, 4);
    assert.equal(await threadEdit(USER, THREAD, { index: 2, content: 'Not in this chat' }), null);
    assert.equal(await threadEdit(USER, THREAD, { index: 'x', content: 'And MSFT?' }), null);
    assert.equal(await threadEdit(USER, THREAD, null), null);
});

test('a saved edit replaces that question and everything after it with the new turn', async () => {
    let set = null;
    const saveThreadExchange = serverFn('saveThreadExchange', {
        THREAD_ID_RE: /^[0-9a-f]{24}$/, ASK_THREAD_KEEP: 50, ASK_THREAD_MSG_KEEP: 80,
        askSurface: (v) => (v === 'paper' ? 'paper' : 'ask'),
        surfaceMatch: (v) => (v === 'paper' ? { surface: 'paper' } : { surface: { $ne: 'paper' } }),
        AskThread: {
            findOne: () => lean({ messages: transcript }),
            findOneAndUpdate: async (q, update) => { set = update.$set; return { _id: THREAD, userId: USER }; },
            find: () => ({ sort() { return this; }, skip() { return this; }, lean: async () => [] })
        }
    });
    assert.equal(await saveThreadExchange(USER, THREAD, 'And NVDA?', 'A2b', 'normal', [], 'ask', 2), THREAD);
    assert.deepEqual(JSON.parse(JSON.stringify(set.messages.map((m) => m.content))), ['What does AAPL earn?', 'A1', 'And NVDA?', 'A2b']);
});

test('the chat route: an edit cuts the context, a temporary chat keeps nothing', () => {
    assert.match(app, /const temporary = \(req\.body && req\.body\.temporary\) === true && !aiPaperCtx;/);
    assert.match(app, /const memoryConsent = !temporary && !!\(req\.user && req\.user\.askMemoryEnabled\);/);
    assert.match(app, /const edit = hasThread \? await threadEdit\(userId, threadIdRaw, req\.body && req\.body\.editFrom\) : null;/);
    // no other chats pulled in as context
    assert.match(app, /temporary \|\| chatSurface === 'paper' \? \[\] : await aiChat\.recentHistory\(userId\)/);
    // nothing written: not the rolling history, not the reports, not the thread
    assert.equal((app.match(/result\.source === 'ai' && !temporary && chatSurface !== 'paper'\) aiChat\.saveExchange\(/g) || []).length, 2);
    assert.equal((app.match(/result\.source === 'ai' && !temporary\) saveAskReport\(/g) || []).length, 2);
    assert.equal((app.match(/result\.source === 'ai' && !temporary\)? (?:threadIdSaved = )?(?:\n\s*\? )?await saveThreadExchange|result\.source === 'ai' && !temporary\n\s*\? await saveThreadExchange/g) || []).length, 2);
    // credits are charged exactly as before
    assert.equal((app.match(/credits\.spend\(userId, thinking \? creditFactor \* credits\.COST\.ask : 'ask', 'ask'\)/g) || []).length, 2);
});

function bundleBox() {
    const box = { vizBlock: () => '', barsBlock: () => '', sankeyBlock: () => '' };
    vm.runInNewContext([fnSource(bundle, 'function esc('), fnSource(bundle, 'function inlineMd('), fnSource(bundle, 'function markdown('), fnSource(bundle, 'function speakable(')].join('\n')
        + '\nthis.markdown = markdown; this.speakable = speakable;', box);
    return box;
}

test('fenced code keeps its layout with a Copy button; a fenced table still renders as a table', () => {
    const { markdown } = bundleBox();
    const code = markdown('Formula:\n```python\nfcf = ocf - capex\nprint(fcf < 1)\n```\nDone.');
    assert.match(code, /<div class="ask-code"><span class="ask-code-lang">python<\/span><button type="button" class="ask-code-copy" data-aact="copy-code">Copy<\/button><pre><code>fcf = ocf - capex\nprint\(fcf &lt; 1\)<\/code><\/pre><\/div>/);
    assert.match(code, /<p>Done\.<\/p>/);
    const table = markdown('```\n| Year | Revenue |\n|---|---|\n| 2025 | 10 |\n```');
    assert.match(table, /<table><thead><tr><th>Year<\/th>/);
    assert.doesNotMatch(table, /ask-code/);
    assert.match(markdown('```markdown\n**bold**\n```'), /<strong>bold<\/strong>/);
});

test('read aloud speaks the words, not the markup, links or source list', () => {
    const { speakable } = bundleBox();
    const said = speakable('## Apple\n**Revenue** rose [per the 10-K](https://www.sec.gov/x).\n| A | B |\n|---|---|\n| 1 | 2 |\n```viz\n{}\n```\nSEC sources: 10-K 2025.');
    assert.equal(said, 'Apple Revenue rose per the 10-K. , A , B , , 1 , 2 ,');
    assert.match(bundle, /new SpeechSynthesisUtterance\(c\)/);
    assert.match(bundle, /data-aact="speak" title="Read aloud"/);
});

test('every question carries Copy, and Edit where the page can edit; saved chats get the same tools', () => {
    assert.match(bundle, /<div class="ask-q">\$\{esc\(question\)\}<\/div>\$\{questionActs\(!!exchange\.__onEdit\)\}/);
    assert.match(bundle, /if \(qEl\) qEl\.dataset\.saved = '1';/);
    assert.match(bundle, /opts\.threadId && opts\.editFrom \? \{ editFrom: opts\.editFrom, \.\.\.\(opts\.regenerate \? \{ regenerate: true \} : \{\}\) \} : \{\}/);
    assert.match(bundle, /opts && opts\.temporary \? \{ temporary: true \} : \{\}/);
    assert.match(page, /<div class="ask-q" data-saved="1">\$\{esc\(String\(content \|\| ''\)\)\}<\/div>\$\{questionActs\(true\)\}/);
    assert.match(page, /if \(role !== 'user'\) savedAnswerTools\(block\.firstChild, content, \{ turn: true, versions \}\);/);
    assert.match(page, /onEdit: startEdit/);
    assert.match(css, /\.ask-q-acts \{/);
    assert.match(css, /\.ask-code pre \{/);
});

test('the Ask page: edit, temporary chat, paste and drop, export, shortcuts, jump to latest', () => {
    assert.match(page, /id="edit-note"[^>]*hidden>Editing your question\. Sending it replaces that question and every answer after it\./);
    assert.match(page, /if \(editFrom && opts\.threadId\) opts\.editFrom = editFrom;/);
    assert.match(page, /if \(e\.key === 'ArrowUp' && !ta\.value/);
    assert.match(page, /id="ask-temp" aria-pressed="false"[^>]*hidden>Temporary chat<\/button>/);
    assert.match(page, /if \(tempChat\) return \{ temporary: true \};/);
    assert.match(page, /Temporary chat: not saved to your chats and not used for memory\. Questions use credits as usual\./);
    assert.match(page, /ta\.addEventListener\('paste'/);
    assert.match(page, /composerEl\.addEventListener\('drop'/);
    assert.match(page, /data-do="export" title="Download chat as Markdown"/);
    assert.match(page, /type: 'text\/markdown;charset=utf-8'/);
    assert.match(page, /\['Copy the last answer', `\$\{MOD\} Shift C`\]/);
    assert.match(page, /id="jump-latest"/);
    // every send path names its chat the same way
    assert.equal((page.match(/engine\.send\([^;]*turnOpts\(\)\)/g) || []).length, 2);
    assert.doesNotMatch(page, /engine\.send\([^;]*currentThreadId \? \{ threadId: currentThreadId \} : \{\}\)/);
});

// Regenerate with answer versions, branch in new chat, custom instructions (2026-10-18).
const aiChat = fs.readFileSync(path.join(root, 'backend', 'ai-chat.js'), 'utf8');
const saver = (messages, sink) => serverFn('saveThreadExchange', {
    THREAD_ID_RE: /^[0-9a-f]{24}$/, ASK_THREAD_KEEP: 50, ASK_THREAD_MSG_KEEP: 80, ASK_ANSWER_VERSIONS_KEEP: 4,
    askSurface: (v) => (v === 'paper' ? 'paper' : 'ask'),
    surfaceMatch: (v) => (v === 'paper' ? { surface: 'paper' } : { surface: { $ne: 'paper' } }),
    AskThread: {
        findOne: () => lean({ messages }),
        findOneAndUpdate: async (q, update) => { sink.set = update.$set; return { _id: THREAD, userId: USER }; },
        find: () => ({ sort() { return this; }, skip() { return this; }, lean: async () => [] })
    }
});

test('a regenerate keeps the answer it replaced, and that answer\'s own versions, capped at four', async () => {
    const sink = {};
    const at = new Date('2026-10-18T10:00:00Z');
    const msgs = [...transcript.slice(0, 2), { role: 'user', content: 'And MSFT?' }, { role: 'assistant', content: 'A2', at, versions: [{ content: 'A2-old', at }] }, ...transcript.slice(4)];
    await saver(msgs, sink)(USER, THREAD, 'And MSFT?', 'A2-new', 'normal', [], 'ask', 2, true);
    const out = JSON.parse(JSON.stringify(sink.set.messages));
    assert.deepEqual(out.map((m) => m.content), ['What does AAPL earn?', 'A1', 'And MSFT?', 'A2-new']);
    assert.deepEqual(out[3].versions.map((v) => v.content), ['A2-old', 'A2']);
    // capped
    const many = { role: 'assistant', content: 'A2', at, versions: ['v1', 'v2', 'v3', 'v4'].map((content) => ({ content, at })) };
    await saver([...transcript.slice(0, 3), many], sink)(USER, THREAD, 'And MSFT?', 'A2-new', 'normal', [], 'ask', 2, true);
    assert.deepEqual(JSON.parse(JSON.stringify(sink.set.messages[3].versions.map((v) => v.content))), ['v2', 'v3', 'v4', 'A2']);
    // an edit (different words, or no regenerate flag) keeps no versions
    await saver(msgs, sink)(USER, THREAD, 'And NVDA?', 'N', 'normal', [], 'ask', 2, true);
    assert.equal(sink.set.messages[3].versions, undefined);
    await saver(msgs, sink)(USER, THREAD, 'And MSFT?', 'N', 'normal', [], 'ask', 2);
    assert.equal(sink.set.messages[3].versions, undefined);
});

test('the chat route regenerates only inside a saved chat and returns versions with the thread', () => {
    assert.match(app, /const regenerate = Boolean\(edit\) && \(req\.body && req\.body\.regenerate\) === true;/);
    assert.equal((app.match(/edit \? edit\.index : null, regenerate\)/g) || []).length, 2);
    assert.match(app, /versions: \{ type: \[new mongoose\.Schema\(\{ content: String, at: Date \}, \{ _id: false \}\)\], default: undefined \}/);
    assert.match(app, /Array\.isArray\(m\.versions\) && m\.versions\.length \? \{ versions:/);
});

function branchRoute(src, created) {
    let handler = null;
    const body = app.slice(app.indexOf("app.post('/api/ask/threads/:id/branch'"), app.indexOf('// Custom instructions (ChatGPT / Claude parity)'));
    vm.runInNewContext(body, {
        app: { post: (p, mw, h) => { handler = h; } }, authMiddleware: null,
        THREAD_ID_RE: /^[0-9a-f]{24}$/, ASK_THREAD_KEEP: 50, Number, Math, String, Array,
        surfaceMatch: () => ({}),
        AskThread: {
            findOne: (q) => lean(q.userId === USER ? src : null),
            create: async (doc) => { created.push(doc); return { _id: 'NEW', title: doc.title }; },
            find: () => ({ sort() { return this; }, skip() { return this; }, lean: async () => [] }),
            deleteMany: async () => {}
        }
    });
    return async (userId, through) => {
        const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
        await handler({ params: { id: THREAD }, userId, body: { through } }, res);
        return res;
    };
}

test('branch copies the chat up to an answer into a new chat of the same owner; the original is untouched', async () => {
    const created = [];
    const branch = branchRoute({ title: 'AAPL vs MSFT', mode: 'normal', surface: 'ask', messages: transcript }, created);
    const ok = await branch(USER, 4);
    assert.equal(ok.code, 200);
    assert.equal(ok.body.thread.id, 'NEW');
    assert.equal(created[0].title, 'Branch · AAPL vs MSFT');
    assert.equal(created[0].userId, USER);
    assert.deepEqual(created[0].messages.map((m) => m.content), ['What does AAPL earn?', 'A1', 'And MSFT?', 'A2']);
    assert.equal(transcript.length, 6);
    // must end on an answer and stay inside the chat
    for (const bad of [3, 0, 7, 'x']) assert.equal((await branch(USER, bad)).code, 400);
    // someone else's chat
    assert.equal((await branch('000000000000000000000009', 4)).code, 404);
});

test('custom instructions: saved per user, capped, sent with every question, and never override the rules', () => {
    assert.match(app, /askInstructions: \{ type: String, default: '', maxlength: 1500 \}/);
    assert.match(app, /app\.get\('\/api\/ask\/instructions', authMiddleware,/);
    assert.match(app, /app\.put\('\/api\/ask\/instructions', authMiddleware,/);
    assert.match(app, /if \(instructions\.length > ASK_INSTRUCTIONS_MAX\) return res\.status\(400\)/);
    assert.equal((app.match(/\.\.\.\(customInstructions \? \{ customInstructions \} : \{\}\)/g) || []).length, 2);
    assert.match(aiChat, /if \(key && input\.ctx\?\.customInstructions\) key = null;/);
    assert.match(aiChat, /CUSTOM INSTRUCTIONS — how this user wants you to answer/);
    assert.match(aiChat, /They never override the rules above/);
});

test('the page: Regenerate and Branch on every answer, ‹ n / m › versions, a custom instructions box', () => {
    assert.match(bundle, /data-aact="regen" title="Regenerate"/);
    assert.match(bundle, /data-aact="branch" title="Branch in new chat"/);
    assert.match(bundle, /\$\{exchange\.__onRegenerate \? turnButtons\(\) : `<button type="button" data-act="rerun"/);
    assert.match(bundle, /exchange\.__onRegenerate\(ansEl, \(v \? v\.list : \[md\]\)\.slice\(-4\)\)/);
    assert.match(bundle, /if \(opts && Array\.isArray\(opts\.versions\) && opts\.versions\.length\) mountVersions\(answerEl, opts\.versions, data\.answer\);/);
    assert.match(bundle, /answerText\.set\(answerEl, v\.list\[at\]\);/);
    assert.match(css, /\.ask-ver \{/);
    assert.match(page, /onRegenerate: regenerate,\s+onBranch: branchFrom/);
    assert.match(page, /if \(editFrom && opts\.threadId\) \{ opts\.editFrom = editFrom; opts\.regenerate = true; \}/);
    assert.match(page, /title: 'Regenerate this answer\?'/);
    assert.match(page, /\/ask\/threads\/\$\{currentThreadId\}\/branch/);
    assert.match(page, /body: JSON\.stringify\(\{ through: 2 \* k \+ 2 \}\)/);
    assert.match(page, /id="ask-instr"/);
    assert.match(page, /method: 'PUT'[\s\S]{0,300}instructions: document\.getElementById\('instr-ta'\)\.value/);
});
