'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

const appSource = fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'backend', 'ai-chat.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'backend', 'ai-client.js'), 'utf8');
const pmSource = fs.readFileSync(path.join(root, 'backend', 'personal-memory.js'), 'utf8');
const bundleSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'system.css'), 'utf8');
const askHtml = fs.readFileSync(path.join(root, 'frontend-v2', 'ask.html'), 'utf8');
const profileHtml = fs.readFileSync(path.join(root, 'frontend-v2', 'profile.html'), 'utf8');
const profileSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'profile.js'), 'utf8');

// ---- Threads (Ask only) ----

test('threads get their own collection with caps and a pinned field', () => {
    const schema = appSource.match(/const AskThreadSchema = new mongoose\.Schema\(\{[\s\S]*?\}\);/);
    assert.ok(schema, 'AskThreadSchema is declared');
    assert.match(schema[0], /userId: \{ type: mongoose\.Schema\.Types\.ObjectId, ref: 'User', required: true \}/);
    assert.match(schema[0], /pinned: \{ type: Boolean, default: false \}/);
    assert.match(appSource, /ASK_THREAD_KEEP = 50/, 'chat limit is 50 per user');
    assert.match(appSource, /ASK_THREAD_MSG_KEEP = 80/);
    assert.match(appSource, /AskThreadSchema\.index\(\{ userId: 1, updatedAt: -1 \}\)/);
    // sidebar 🔍 searches titles AND chat text
    assert.match(appSource, /\{ title: 'text', 'messages\.content': 'text' \}/);
});

test('the chat route uses server-side thread history when a threadId is present', () => {
    assert.match(appSource, /const hasThread = typeof threadIdRaw === 'string' && THREAD_ID_RE\.test\(threadIdRaw\)/);
    assert.match(appSource, /const history = hasThread\s*\? await aiChat\.threadHistory\(userId, threadIdRaw\)/);
    assert.match(chatSource, /async function threadHistory\(userId, threadId, n = 16\)/);
    assert.match(chatSource, /findOne\(\{ _id: tid, userId: uid \}, \{ projection: \{ messages: \{ \$slice: -n \} \} \}\)/);
});

test('both /api/ai/chat success branches save the thread and return its id', () => {
    const hooks = appSource.match(/await saveThreadExchange\(userId, threadIdRaw, question, result\.answer, mode, result\.toolsUsed\)/g) || [];
    assert.equal(hooks.length, 2, 'streaming and non-streaming branches both save');
    assert.match(appSource, /threadId: threadIdSaved/);
    assert.equal((appSource.match(/threadId: threadIdSaved/g) || []).length, 2);
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
    const threadBlock = appSource.slice(
        appSource.indexOf("app.get('/api/ask/threads'"),
        appSource.indexOf("app.get('/api/ask/memory'")
    );
    assert.ok(threadBlock.includes("'/api/ask/threads"), 'thread routes located');
    assert.doesNotMatch(threadBlock, /credits\.spend/, 'reading or managing a thread must be free');
});

test('thread search honours ?q= and pinned sorts first', () => {
    assert.match(appSource, /const q = String\(\(req\.query && req\.query\.q\) \|\| ''\)/);
    assert.match(appSource, /\$text: \{ \$search: q \}/);
    assert.match(appSource, /'messages\.content': new RegExp/);
    assert.match(appSource, /\$sort: \{ pinned: -1, updatedAt: -1 \}/);
});

test('PATCH accepts a pinned toggle alongside rename', () => {
    assert.match(appSource, /Object\.prototype\.hasOwnProperty\.call\(body, 'pinned'\)/);
    assert.match(appSource, /patch\.pinned = !!body\.pinned/);
});

// ---- Attachments (Ask) ----

test('attachments ride the chat body only — validated, capped, never stored', () => {
    const fn = appSource.slice(appSource.indexOf('function normalizeAskAttachments'), appSource.indexOf('function normalizeAskAttachments') + 1600);
    assert.ok(fn.startsWith('function normalizeAskAttachments'), 'normalizer located');
    assert.match(appSource, /ASK_ATTACHMENT_MAX_COUNT = 3/);
    assert.match(appSource, /ASK_ATTACHMENT_MAX_BYTES = 10 \* 1024 \* 1024/);
    assert.match(appSource, /ASK_ATTACHMENT_TEXT_CAP = 8000/);
    // the route only — the global parser stays small
    assert.match(appSource, /const askChatParser = express\.json\(\{ limit: '16mb' \}\)/);
    assert.match(appSource, /req\.path === ASK_CHAT_PATH/);
    // both ask() call sites pass attachments through ctx
    assert.equal((appSource.match(/ctx: \{ holdings, userId, memoryConsent, attachments \}/g) || []).length, 2);
});

test('the AI gets attachment tools: view_image (vision relay) and read_document', () => {
    assert.match(chatSource, /name: 'view_image'/);
    assert.match(chatSource, /name: 'read_document'/);
    // relay: transcription text enters the conversation — chat brain never sees pixels
    assert.match(chatSource, /aiClient\.chatVision\(/);
    assert.match(chatSource, /async function toolViewImage\(args, ctx\)/);
    assert.match(chatSource, /async function toolReadDocument\(args, ctx\)/);
    assert.match(chatSource, /case 'view_image': return toolViewImage/);
    assert.match(chatSource, /case 'read_document': return toolReadDocument/);
    // honest degradation — no silent guessing when the relay fails
    assert.match(chatSource, /This image could not be read yet/);
});

test('the vision purpose exists in the shared client with a measured default', () => {
    assert.match(clientSource, /AI_MODEL_VISION/);
    assert.match(clientSource, /vision: process\.env\.AI_MODEL_VISION \|\| \(useOllama \? 'gemma4:31b' : fallback\)/);
    assert.match(clientSource, /async function chatVision\(messages/);
    assert.match(clientSource, /\{ chat, chatRaw, chatRawStream, chatVision, isConfigured, leaksIdentity \}/);
});

test('document extracts are injected as context; images are named for the relay', () => {
    assert.match(chatSource, /USER ATTACHMENTS \(this message\)/);
    assert.match(chatSource, /call view_image/);
    // scanned-PDF honesty: "no text found" never becomes a guess
    assert.match(chatSource, /may be scanned pages/);
});

test('ask.html lets users attach pics and docs with per-chip 🧠', () => {
    assert.match(askHtml, /id="att-input"/);
    assert.match(askHtml, /accept="image\/png,image\/jpeg,image\/webp,\.pdf,\.csv,\.txt,\.md,\.json"/);
    assert.match(askHtml, /att-chips/);
    assert.match(askHtml, /🧠/);
    assert.match(askHtml, /imageToDataUri/);
    assert.match(askHtml, /pdfExtract/);
    assert.match(askHtml, /opts\.attachments = attachments\.map/);
});

// ---- Personal memory (ChatGPT-style, default ON) ----

test('personal memory is one embedded doc per user, shared by routes and the tool', () => {
    assert.match(appSource, /const pm = require\('\.\/personal-memory'\)/);
    assert.match(chatSource, /const pm = require\('\.\/personal-memory'\)/);
    assert.match(pmSource, /const COLLECTION = 'personal_memory'/);
    assert.match(pmSource, /const PM_KEEP = 50/);
    assert.match(pmSource, /const PM_MAX = 500/);
    // dedupe so tool writes and imports can never drift apart
    assert.match(pmSource, /async function addFact\(userId, fact, opts = \{\}\)/);
    assert.match(pmSource, /function normFact/);
});

test('the remember tool refuses only when the user switched memory off', () => {
    assert.match(chatSource, /if \(!ctx \|\| ctx\.memoryConsent === false\) return \{ error: 'Memory is off for this user\.[^']*' \}/);
    assert.doesNotMatch(chatSource, /Memory is off for this user\. Answer as usual and do not mention memory again\.' \};\s*\}[\s\S]{0,400}ask_memories/);
    // the card the user sees needs "saved" back from the tool
    assert.match(chatSource, /const out = await pm\.addFact\(ctx\.userId, fact, \{ existingFacts \}\)/);
    assert.match(chatSource, /\{ ok: true, saved: out\.saved \|\| fact/);
});

test('memory defaults ON, and a one-shot boot migration flips legacy opt-outs', () => {
    const flag = appSource.match(/askMemoryEnabled: \{[^}]*\}/);
    assert.ok(flag, 'User schema carries askMemoryEnabled');
    assert.match(flag[0], /default: true/);
    assert.match(appSource, /pm\.bootMigrate\(\)/);
    assert.match(pmSource, /askMemoryEnabled: false \}, \{ \$set: \{ askMemoryEnabled: true \} \}/);
    // marker-guarded so a later user opt-out survives restarts
    assert.match(pmSource, /BOOT_MARKER/);
    assert.match(pmSource, /if \(marker\) return/);
    // legacy ask_memories rows are carried over and the collection dropped
    assert.match(pmSource, /collection\('ask_memories'\)/);
    assert.match(pmSource, /ask_memories'\)\.drop/);
});

test('saved memories reach the prompt as system context', () => {
    assert.match(chatSource, /async function loadMemories\(userId\)/);
    assert.match(chatSource, /MEMORY — durable facts this user told you across past conversations/);
    assert.match(chatSource, /total \+ c\.length > 2000/);
    assert.match(chatSource, /await pm\.readFacts\(uid, 50\)/);
});

test('memory routes are owner-scoped and free, import included', () => {
    [
        /app\.get\('\/api\/ask\/memory', authMiddleware/,
        /app\.put\('\/api\/ask\/memory\/consent', authMiddleware/,
        /app\.post\('\/api\/ask\/memory', authMiddleware/,
        /app\.post\('\/api\/ask\/memory\/import', authMiddleware/,
        /app\.post\('\/api\/ask\/memory\/extract', authMiddleware/,
        /app\.delete\('\/api\/ask\/memory\/:id', authMiddleware/,
        /app\.delete\('\/api\/ask\/memory', authMiddleware/
    ].forEach((re) => assert.match(appSource, re, `route present: ${re}`));
    const memoryBlock = appSource.slice(
        appSource.indexOf("app.get('/api/ask/memory'"),
        appSource.indexOf('// ---- Thesis Tracker')
    );
    assert.ok(memoryBlock.length > 0, 'memory route block located');
    assert.doesNotMatch(memoryBlock, /credits\.spend/, 'memory must never touch credits');
});

test('memory lives in Profile → Settings, not the Ask sidebar', () => {
    assert.match(profileHtml, /id="settings-card"/);
    assert.match(profileHtml, /id="mem-toggle"/);
    assert.match(profileHtml, /📥 Import from another assistant/);
    assert.match(profileHtml, /id="import-file"/);
    assert.match(profileSource, /\/ask\/memory\/consent/);
    assert.match(profileSource, /\/ask\/memory\/extract/);
    assert.match(profileSource, /\/ask\/memory\/import/);
    // the sidebar has NO memory section
    assert.doesNotMatch(askHtml, /id="mem-toggle"/);
    assert.doesNotMatch(askHtml, /loadMemory/);
});

test('the chat shows ChatGPT-style "Added to memory" cards with instant delete', () => {
    assert.match(bundleSource, /🧠 Added to memory/);
    assert.match(bundleSource, /ask-memcard/);
    assert.match(bundleSource, /\/ask\/memory\/\$\{encodeURIComponent\(t\.args\.fact\)\}/);
});

// ---- Sidebar (search / pin / resize / collapse) ----

test('the sidebar searches, pins, resizes and collapses', () => {
    assert.match(askHtml, /id="chat-search"/);
    assert.match(askHtml, /data-act="menu"/);
    assert.match(askHtml, /function threadMenu\(id, anchor\)/);
    assert.doesNotMatch(askHtml, /data-act="pin"/);
    assert.match(askHtml, /async function pinThread\(id\)/);
    assert.match(askHtml, /pinned: !t\.pinned/);
    assert.match(askHtml, /id="side-grip"/);
    assert.match(askHtml, /sp_ask_side_w_v1/);
    assert.match(askHtml, /sp_ask_side_collapsed_v1/);
    assert.match(askHtml, /📌 Pinned/);
});

test('the chat rail groups by day, so same-titled chats are tellable apart', () => {
    assert.match(askHtml, /function dayBucket\(ts\)/);
    for (const bucket of ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older']) {
        assert.match(askHtml, new RegExp(`'${bucket}'`));
    }
    // the timestamp must survive hover — it used to be display:none'd for the glyphs
    assert.doesNotMatch(askHtml, /\.chat-item:hover \.when/);
});

test('sending enters the soft focus state, not full zen', () => {
    // focus keeps the nav AND the composer; only zen takes everything
    assert.match(askHtml, /function setFocus\(on\)/);
    assert.match(askHtml, /body\.focus \.side, body\.focus \.side-grip,/);
    assert.doesNotMatch(askHtml, /body\.focus header\.nav/);
    assert.doesNotMatch(askHtml, /body\.focus \.composer-dock/);
    // zen is deliberate and remembered
    assert.match(askHtml, /sp_ask_zen_v1/);
    assert.match(askHtml, /function prefersZen\(\)/);
});

test('one loading indicator, alive from send to last token', () => {
    // the feature carried TWO idioms for the same operation: a spinning ring
    // during the tool phase and a legacy blinking accent bar while writing,
    // plus a pulsing step dot and a shimmer running alongside the ring
    assert.doesNotMatch(cssSource, /\.ask-cursor::after/);
    assert.doesNotMatch(cssSource, /@keyframes askBlink/);
    assert.doesNotMatch(cssSource, /@keyframes askPulse/);
    assert.doesNotMatch(bundleSource, /ask-cursor/);
    assert.doesNotMatch(bundleSource, /class="skeleton"/);
    // the ring is the survivor, and it keeps running while the answer writes
    assert.match(cssSource, /\.ask-ring \{[^}]*animation: spin/);
    assert.match(bundleSource, /const enterWriting = \(\) => \{/);
    assert.match(cssSource, /\.ask-progress\.is-writing \.ask-note, \.ask-progress\.is-writing \.ask-steps \{ display: none; \}/);
    // Nielsen #3: Stop must outlive the first token AND a long scroll
    assert.match(cssSource, /\.ask-progress\.is-writing \{[\s\S]{0,120}position: sticky/);
    // Nielsen #1: aria-live belongs on the status line, not the re-rendering card
    assert.match(bundleSource, /<span class="ask-working" role="status" aria-live="polite">/);
});

test('the composer is one compact box that does not change on send', () => {
    // border and background on the wrapper, not the textarea: a white field
    // nested in a paper dock was two rectangles 2% apart in tone
    assert.match(askHtml, /\.composer textarea \{[^}]*background: none; border: 0;/);
    // no phantom gutter reserved for absolutely-positioned buttons
    assert.doesNotMatch(askHtml, /\.composer textarea \{ padding-left: 64px; \}/);
    assert.doesNotMatch(askHtml, /\.composer \.paperclip \{\s*position: absolute/);
    // the plinth spans the canvas, so no shadow is needed to fake the lift
    assert.doesNotMatch(askHtml, /box-shadow: 0 -14px 32px/);
    // one row at rest, six at most, and the placeholder must not set the height
    assert.match(askHtml, /const TA_MIN = 35, TA_MAX = 158;/);
    assert.match(askHtml, /if \(!ta\.value\) \{ ta\.style\.height = `\$\{TA_MIN\}px`; return; \}/);
});

// ---- Audit fixes (2026-08-29): zen signed-out, consent over zen,
// ---- over-cap import drop, stacked attachment errors ----

test('the zen chip survives side-off, so signed-out mobile users can leave zen', () => {
    assert.match(askHtml, /body\.side-off\.in-conversation \.side-tools \{ display: flex !important; \}/);
    assert.match(askHtml, /body\.side-off \.side-tools > :not\(\.zen-chip\) \{ display: none !important; \}/);
    // hideSide must NOT hide the row wholesale — CSS decides, not JS
    assert.match(askHtml, /function hideSide\(\) \{\s*[^}]*\$\('side'\)\.hidden = true;\s*\$\('side-grip'\)\.hidden = true;\s*\}/);
    assert.doesNotMatch(askHtml, /hideSide[\s\S]{0,200}\$\('side-tools'\)\.hidden = true/);
});

test('the cookie-consent card yields to zen', () => {
    assert.match(askHtml, /body\.zen \.consent/);
});

test('over-cap imports tell the user what was dropped, before and after', () => {
    // server computes the eviction count (the cap keeps the newest 50)
    assert.match(pmSource, /const dropped = Math\.max\(0, existing\.length \+ fresh\.length - PM_KEEP\)/);
    assert.match(appSource, /dropped: out\.dropped \|\| 0/);
    // profile warns in the preview (before anything lands) and names it after
    assert.match(profileSource, /would drop your \$\{over\} oldest/);
    assert.match(profileSource, /oldest \$\{data\.dropped === 1 \? 'fact was' : 'facts were'\} dropped to fit/);
    // the audit trap: profile.js is shipped by copy, and an asset never
    // carries the stamp string — pin its actual content, not just the stamp
    assert.match(profileSource, /const MEM_CAP = 50/);
});

test('multiple rejected attachments each get their error line', () => {
    assert.match(askHtml, /const errs = \[\]; \/\/ every rejected file gets its line, not last-wins/);
    assert.match(askHtml, /setErr\(errs\.join\(' '\)\)/);
});

// ---- Stamps ----

test('asset stamps were bumped together (the ritual that bites twice)', () => {
    assert.match(askHtml, /assets\/app\.js\?v=20260905-relist1/);
    assert.match(askHtml, /assets\/system\.css\?v=20260905-relist1/);
    assert.match(profileHtml, /assets\/profile\.js\?v=20260901-cmp1/);
    [askHtml, bundleSource].forEach((src) => assert.doesNotMatch(src, /20260829-askthreads1/));
});
// ---- chrome collapsed from three buttons to two (2026-08-30) ----

test('one control owns the chat rail, not two buttons drawn the same', () => {
    // #side-collapse (hide) and #side-open (show) were inverse jobs behind the
    // same ☰ glyph, and which one you got depended on the chrome state
    assert.doesNotMatch(askHtml, /id="side-collapse"/);
    assert.doesNotMatch(askHtml, /id="side-open"/);
    assert.match(askHtml, /id="rail-toggle"/);
    assert.match(askHtml, /function railOpen\(\)/);
    assert.match(askHtml, /function paintRailToggle\(\)/);
    // one glyph for two states is only unambiguous if it reports the state
    assert.match(askHtml, /aria-expanded/);
});

test('chat CRUD is an anchored icon popover, not a stack of dialogs', () => {
    // rename cost two centred modals; it now happens in the row
    assert.match(askHtml, /function startRename\(id\)/);
    assert.match(askHtml, /input\.className = 'chat-rename'/);
    assert.doesNotMatch(askHtml, /function renameThread\(id\)/);
    assert.doesNotMatch(askHtml, /id="rename-input"/);
    // icons carry the actions, so the accessible names are all that name them
    for (const label of ['Rename chat', 'Delete chat']) {
        assert.match(askHtml, new RegExp(`aria-label="${label}"`));
    }
    assert.match(askHtml, /data-do="rename"/);
    assert.match(askHtml, /data-do="delete"/);
    // the popover must escape .side's overflow-y:auto clip
    assert.match(askHtml, /\.chat-menu \{[\s\S]{0,80}position: fixed/);
    // Esc in the rename field must not also rearrange the page
    assert.match(askHtml, /e\.preventDefault\(\); e\.stopPropagation\(\); cancel\(\);/);
    // delete stays behind one confirm
    assert.match(askHtml, /function deleteThread\(id\)/);
    assert.match(askHtml, /title: 'Delete this chat\?'/);
});
