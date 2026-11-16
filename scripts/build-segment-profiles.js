#!/usr/bin/env node
'use strict';
// What each company sells, read from its latest annual report (10-K, 20-F or 40-F): its reportable
// segments by the filing's own names, the products, services and brands in each, who pays it and for
// what, and the segment changes of the last three years. One file per issuer:
//
//   backend/data/segment-profiles/<cik>.json
//
// Revenue figures are never taken from here. They come from the filing's tagged tables
// (sec-segment-observations.js); this file supplies the words around them. Every name and every
// product must appear in the filing text, and every sentence carries a verbatim quote from it that is
// checked before the record is written, so a model reply cannot add a product the filing never names.
//
// Reads with the site's own extraction model (ai-client.js, 'summary' purpose). Never touches a
// database: the provider key comes from scripts/lib/dev-env.js loadAiEnvOnly().
//
//   node scripts/build-segment-profiles.js                 every issuer without a current profile
//   node scripts/build-segment-profiles.js --cik 1751008   one issuer (repeatable)
//   node scripts/build-segment-profiles.js --limit 20 --jobs 6 --rebuild
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const ROOT = path.join(__dirname, '..'), BACKEND = path.join(ROOT, 'backend');
let ai = null;
const { SEC_HEADERS } = require(path.join(BACKEND, 'sec-source'));
const { segmentWindows, anchorWindows } = require(path.join(BACKEND, 'segments'));
const profiles = require(path.join(BACKEND, 'segment-profiles'));

const FIN = path.join(ROOT, 'frontend/data/sec-financials');
const CACHE = path.join(process.env.HOME, '.cache/stockportfolio/annual-text');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ONLY = args.reduce((a, v, i) => (args[i - 1] === '--cik' ? a.concat(String(v).padStart(10, '0')) : a), []);
const LIMIT = Number(opt('--limit', 0)), JOBS = Number(opt('--jobs', 6)), REBUILD = args.includes('--rebuild');
// Two-stage reading, for a reader that is not a model call from here: --dump writes the exact prompt
// each filing would be read with, --from-replies reads the answers back through the same checks.
const DUMP = opt('--dump', ''), FROM_REPLIES = opt('--from-replies', '');

const decode = html => String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&#8217;|&rsquo;|&#8216;|&lsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\s+/g, ' ');

let lastSec = 0;
async function sec(url) {
    for (let i = 0; i < 4; i++) {
        const wait = lastSec + 150 - Date.now(); lastSec = Math.max(Date.now(), lastSec + 150);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try {
            const r = await fetch(url, { headers: SEC_HEADERS });
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return Buffer.from(await r.arrayBuffer());
        } catch (e) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
    }
    return null;
}

function latestAnnual(data) {
    const annual = Object.values(data.sources || {}).filter(s => /^(?:10-K|20-F|40-F)(?:\/A)?$/.test(s.form) && s.accessionNumber && s.periodEnd && !/\/A$/.test(s.form));
    annual.sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)) || String(b.filingDate).localeCompare(String(a.filingDate)));
    return annual[0] || null;
}

// The filing's own primary document, from sec-reporting.json (the SEC submissions index). The largest
// .htm in a filing directory is not it: Crane NXT's 10-K carries a larger exhibit (cxt-ex101_20251231.htm),
// and NACCO's, Pool's and McEwen's do too, so the reader was given an exhibit's text instead of the report.
let REPORTING = null;
function primaryDocument(cik, src) {
    try {
        REPORTING = REPORTING || JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/data/sec-reporting.json'), 'utf8')).issuers || {};
        const e = REPORTING[cik] || REPORTING[String(Number(cik))];
        const annual = e && e.latestAnnual;
        return annual && annual.accessionNumber === src.accessionNumber && annual.primaryDocument ? annual.primaryDocument : null;
    } catch (_) { return null; }
}
// A filing directory's documents: the named primary document, else the largest that is not an exhibit,
// else the largest. Never an XBRL viewer page (R7.htm).
function pickDocument(items, preferred) {
    const pages = (items || []).filter(x => /\.htm$/i.test(x.name || '') && !/^R\d+\.htm$/i.test(x.name));
    if (preferred && pages.some(x => x.name === preferred)) return pages.find(x => x.name === preferred);
    const exhibit = x => /(?:^|[-_.])ex(?:hibit)?[-_.]?\d/i.test(x.name) || /xex\d/i.test(x.name);
    return pages.filter(x => !exhibit(x)).sort((a, b) => Number(b.size) - Number(a.size))[0]
        || pages.sort((a, b) => Number(b.size) - Number(a.size))[0] || null;
}

// A filing's business description is sometimes in an exhibit, not in the primary document: a 40-F's
// primary page is a cover (Agnico Eagle: 65,757 characters after tags are stripped), and some banks
// file a thin 10-K whose report is exhibit 13 (J.W. Mays: 50,623). Measured against the builder's own
// cache, every real 10-K/20-F page is at least 131,000 characters (median 423,000), so a primary
// document under 100,000 is a wrapper and its exhibit 13/99 is read instead.
const THIN = 100000;
const EXHIBIT_NO = name => { const m = String(name || '').match(/xex\s*([0-9]+)|(?:^|[-_.])ex(?:hibit)?[-_.]?([0-9]+)/i); return m ? (m[1] || m[2]) : null; };
// Only exhibit 13 and 99 (99.1 included) may stand in for the report. A 10.1 contract or 31 certificate
// never does.
const businessExhibit = x => { const n = EXHIBIT_NO(x.name); return !!n && (n.startsWith('13') || n.startsWith('99')); };
const widestExhibit = items => (items || []).filter(x => /\.htm$/i.test(x.name || '') && businessExhibit(x))
    .sort((a, b) => Number(b.size) - Number(a.size))[0] || null;

async function filingIndex(cik, src) {
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${src.accessionNumber.replace(/-/g, '')}`;
    const index = await sec(base + '/index.json');
    if (!index) return null;
    try { return { base, items: JSON.parse(index.toString('utf8')).directory.item }; } catch (_) { return null; }
}
async function pageText(base, doc, file, expected) {
    // A cached copy is reused only when it is the document asked for (older entries carry no name).
    if (fs.existsSync(file)) {
        const t = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
        if (!expected || String(t.url || '').split('/').pop() === expected) return t;
    }
    const html = await sec(base + '/' + doc.name);
    if (!html) return null;
    const t = { url: base + '/' + doc.name, text: decode(html.toString('utf8')) };
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(t)));
    return t;
}
async function filingText(cik, src) {
    const wanted = primaryDocument(cik, src);
    const file = path.join(CACHE, src.accessionNumber + '.txt.gz');
    if (fs.existsSync(file)) {
        const t = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
        if ((!wanted || String(t.url || '').split('/').pop() === wanted) && t.text.length >= THIN) return t;
    }
    const idx = await filingIndex(cik, src);
    if (!idx) return null;
    const doc = pickDocument(idx.items, wanted);
    if (!doc) return null;
    const t = await pageText(idx.base, doc, file, wanted);
    if (t && t.text.length < THIN) {
        const wide = widestExhibit(idx.items);
        if (wide && wide.name !== doc.name) {
            const e = await pageText(idx.base, wide, path.join(CACHE, src.accessionNumber + '.exhibit.txt.gz'), wide.name);
            if (e && e.text.length > t.text.length) return { ...e, exhibit: wide.name };
        }
    }
    return t;
}
// The exhibit 13/99 of the same filing, for a report that reads to no segments from a wrapper.
async function exhibitText(cik, src) {
    const idx = await filingIndex(cik, src);
    if (!idx) return null;
    const wide = widestExhibit(idx.items);
    if (!wide) return null;
    return pageText(idx.base, wide, path.join(CACHE, src.accessionNumber + '.exhibit.txt.gz'), wide.name);
}

// The business section (what it sells) and the segment note (how it is organised). The table of
// contents also says "Item 1. Business", so the first match followed by real prose is used.
function windows(text) {
    const starts = [...text.matchAll(/\bitem\s*(?:1|4)\s*[.:\-–—]?\s*(?:business\b|information on the company)/gi)].map(m => m.index);
    const start = starts.find(i => !/\bitem\s*1A\b|\bitem\s*2\b|\bitem\s*5\b/i.test(text.slice(i + 30, i + 900))) ?? starts[0] ?? 0;
    const business = text.slice(start, start + 13000);
    const seg = segmentWindows(text).slice(0, 17000);
    const other = business.length < 3000 ? anchorWindows(text, [/we (?:sell|offer|provide|generate)/gi, /our products/gi], { maxChars: 8000 }) : '';
    return `[BUSINESS SECTION]\n${business}\n${other}\n[SEGMENT DISCLOSURES]\n${seg}`;
}

const SYSTEM = [
    'You read an SEC annual report (Form 10-K, 20-F or 40-F) and describe how the company is organised and what it sells. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"segments":[{"name":str,"products":[str],"description":str,"evidence":str}],"productRevenueBrokenOut":bool,"revenueModel":{"text":str,"evidence":str}|null,"changes":[{"text":str,"evidence":str}]}',
    'segments: the company\'s REPORTABLE segments, named exactly as the filing names them. A company with one reportable segment gets one entry, under the name the filing gives that segment (for example "Advertising"); if the filing gives it no name, use the business it is in, in one to three words taken from the text. Product lines, brands, end markets and geographic disclosures are NOT segments unless the filing calls them reportable segments. Leave out corporate, eliminations and reconciling items. Include an "All other" or "Other" entry only when the filing reports it beside the segments; name it as the filing does. WHEN THE FILING SAYS THE COMPANY HAS ONE OPERATING OR REPORTABLE SEGMENT, REPLY WITH EXACTLY ONE SEGMENT: never split it into its product lines, brands, markets or regions, even when the filing lists them.',
    'products: the products, services, brands or platforms the filing says belong to that segment, written as the filing writes them, at most 8. An empty list when the text names none.',
    'description: one plain sentence, at most 25 words, on what the segment does and for whom.',
    'evidence: one sentence copied WORD FOR WORD from the supplied text that names the segment or its products. It is checked against the text; a paraphrase is discarded.',
    'productRevenueBrokenOut: true only if the filing reports revenue figures for individual products, product lines, brands or services; false if it does not.',
    'revenueModel: one plain sentence, at most 30 words, on who pays the company and for what, with a word-for-word evidence sentence. null if the text does not say.',
    'changes: segment changes in the last three fiscal years: a business sold or discontinued, segments combined, split or renamed. At most 3, each one sentence that includes the year, with a word-for-word evidence sentence. An empty list if none.',
    'Write no figures in description, revenueModel or changes other than years. Use only the supplied text, never outside knowledge.'
].join('\n');

const norm = s => String(s || '').toLowerCase().replace(/[‘’‛`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-')
    .replace(/[®™©*†‡]/g, '').replace(/\s+/g, ' ').trim();
function grounded(hay) {
    const H = norm(hay);
    // A quote passes when it appears in the text, allowing the model to drop a trailing period or a
    // bullet. Anything shorter than 25 characters cannot carry a claim and does not pass.
    const quote = q => { const n = norm(q).replace(/^[•●▪\-\s]+/, '').replace(/[.;:\s]+$/, ''); return n.length >= 25 && H.includes(n); };
    const term = t => { const n = norm(t).replace(/[.;:,\s]+$/, ''); return n.length >= 2 && H.includes(n); };
    return { quote, term };
}
const NUMBER = s => /\d/.test(String(s).replace(/\b(?:19|20)\d\d\b/g, '').replace(/\b(?:fiscal|fy)\s*\d{2,4}\b/gi, ''));
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// A sentence over its limit ends at a word, never mid-word ("usage-bas").
const sentence = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); if (t.length <= n) return t;
    const cut = t.slice(0, n), stop = cut.lastIndexOf('. '); return stop > n * 0.6 ? cut.slice(0, stop + 1) : cut.replace(/[\s,;:-]+\S*$/, '') + '…'; };

function validate(parsed, hay) {
    const g = grounded(hay), dropped = [];
    const segments = [];
    for (const s of (Array.isArray(parsed.segments) ? parsed.segments : []).slice(0, 12)) {
        // The filing's name, without an abbreviation the model added ("Consumer & Community Banking (CCB)").
        const name = [clip(s.name, 80), clip(s.name, 80).replace(/\s*\([^)]*\)\s*$/, '')].find(n => n && g.term(n));
        if (!name) { if (s.name) dropped.push('segment name not in text: ' + clip(s.name, 80)); continue; }
        const products = [...new Set((Array.isArray(s.products) ? s.products : []).map(p => clip(p, 80)).filter(Boolean))]
            .filter(p => { const ok = g.term(p) && norm(p) !== norm(name); if (!ok) dropped.push(`product not in text (${name}): ${p}`); return ok; }).slice(0, 8);
        const evidence = g.quote(s.evidence) ? clip(s.evidence, 500) : null;
        if (!evidence && s.evidence) dropped.push('segment evidence not verbatim: ' + name);
        const description = evidence && s.description && !NUMBER(s.description) ? sentence(s.description, 220) : null;
        segments.push({ name, products, description, evidence });
    }
    const rm = parsed.revenueModel && g.quote(parsed.revenueModel.evidence) && parsed.revenueModel.text && !NUMBER(parsed.revenueModel.text)
        ? { text: sentence(parsed.revenueModel.text, 300), evidence: clip(parsed.revenueModel.evidence, 500) } : null;
    if (parsed.revenueModel && !rm) dropped.push('revenue model not grounded');
    const changes = (Array.isArray(parsed.changes) ? parsed.changes : []).slice(0, 3)
        .filter(c => { const ok = c && c.text && g.quote(c.evidence) && !NUMBER(c.text); if (!ok) dropped.push('change not grounded: ' + clip(c && c.text, 80)); return ok; })
        .map(c => ({ text: sentence(c.text, 260), evidence: clip(c.evidence, 500) }));
    return { segments, productRevenueBrokenOut: typeof parsed.productRevenueBrokenOut === 'boolean' ? parsed.productRevenueBrokenOut : null, revenueModel: rm, changes, dropped };
}

// --claude: read with Claude through the local `claude` CLI (the owner's login) instead of the site's
// provider. No tools, settings, hooks, MCP servers or saved session; run from an empty folder so no
// project context rides along. Same prompt, same check against the filing.
// --model=haiku reads every filing without extended thinking; --escalate=opus, thinking, reads again
// only the ones the first read got wrong or could not settle (see hard()).
const CLAUDE = args.includes('--claude');
const flag = (k, d) => (args.find(a => a.startsWith(k + '=')) || k + '=' + d).slice(k.length + 1);
const CLAUDE_MODEL = flag('--model', 'haiku'), ESCALATE = flag('--escalate', ''), EFFORT = flag('--effort', '');
let claudeCwd = null;
const usage = {};
function askClaude(prompt, model) {
    claudeCwd = claudeCwd || fs.mkdtempSync(path.join(require('os').tmpdir(), 'segment-claude-'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_CODE_|^CLAUDECODE$/.test(k)));
    return new Promise((resolve, reject) => {
        const child = require('child_process').execFile('claude', ['-p', '--model', model, ...(model === CLAUDE_MODEL && EFFORT ? ['--effort', EFFORT] : []), '--output-format', 'json', '--tools', '',
            '--system-prompt', SYSTEM, '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'],
        { cwd: claudeCwd, env: model === CLAUDE_MODEL && ESCALATE ? { ...env, MAX_THINKING_TOKENS: '0' } : env, timeout: 300000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
            let out; try { out = JSON.parse(stdout); } catch (_) { return reject(new Error('claude: ' + (err ? err.message : 'unreadable output').slice(0, 180))); }
            if (out.is_error) return reject(new Error('claude: ' + String(out.result || out.subtype).slice(0, 180)));
            const u = usage[model] = usage[model] || { calls: 0, costUsd: 0, inTokens: 0, outTokens: 0 };
            u.calls++; u.costUsd += out.total_cost_usd || 0;
            u.inTokens += (out.usage?.input_tokens || 0) + (out.usage?.cache_read_input_tokens || 0) + (out.usage?.cache_creation_input_tokens || 0);
            u.outTokens += out.usage?.output_tokens || 0;
            resolve({ content: out.result });
        });
        child.stdin.end(prompt);
    });
}

// A filing that says the company has one operating or reportable segment: a read that answers with the
// product or market table behind it has mistaken what the company sells for how it is organised.
const ONE_SEGMENT = /(?:\bwe\b|\bthe company\b|\bthe group\b|\bthe registrant\b)[^.]{0,90}\b(?:one|a single|single)\b[^.]{0,40}\b(?:operating|reportable|business)\b[^.]{0,20}\bsegment\b|\blone\s+segment\b/i;
const COUNT_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// "three operating segments", "five reportable segments": the count a filing states for itself.
function statedSegments(text) {
    const found = new Set();
    for (const m of String(text || '').matchAll(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b[^.]{0,30}\b(?:operating|reportable|business)\b[^.]{0,10}\bsegments\b/gi))
        found.add(COUNT_WORD[m[1].toLowerCase()] ?? Number(m[1]));
    return found;
}
// A reply that split a company which files one segment - unless the filing itself states that many
// segments elsewhere (WiMi says "a single operating segment" in one note and "three operating segments"
// in another; the three are the segments).
function oneSegmentMismatch(v, text) {
    if (!v || v.segments.length < 2 || !ONE_SEGMENT.test(String(text || ''))) return false;
    return !statedSegments(text).has(v.segments.length);
}
// What the cheap read cannot be trusted to settle: no segment survived the check, a segment it named
// is not in the filing, none of its segments is any segment row the filing tags, or the filing says one
// segment and the reply split it.
function hard(v, data, text) {
    if (!v || !v.segments.length) return 'no segments';
    if (oneSegmentMismatch(v, text)) return 'filing says one segment';
    if (v.dropped.some(d => d.startsWith('segment name not in text'))) return 'segment not in filing';
    if (v.dropped.includes('revenue model not grounded')) return 'revenue model not quoted';
    const latest = (data.income?.annualReports || []).slice().sort((a, b) => String(b.fiscalDateEnding).localeCompare(String(a.fiscalDateEnding)))[0];
    const c = require(path.join(BACKEND, 'revenue-breakdown')).fromGroups(data.segmentObservations || [], data.issuerName,
        { read: data.industryExtraction?.status === 'success', revenue: latest ? Number(latest.totalRevenue) : null });
    const rows = (c.kind === 'operating segments' && c.rows) || [];
    if (rows.length > 1 && !rows.some(r => v.segments.some(s => profiles.sameSegment(s.name, r.name)))) return 'no filed row matches';
    return null;
}

function parse(msg) {
    try { const raw = String(msg.content || '').replace(/```json|```/g, '').trim(); return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch (_) { return null; }
}

// The filing fields every record carries, and the two sentences about the company the reader is given.
const filingFields = (src, doc) => ({ form: src.form, accessionNumber: src.accessionNumber, periodEnd: src.periodEnd, filingDate: src.filingDate || null,
    url: doc?.url || null, ...(doc?.exhibit ? { exhibit: doc.exhibit } : {}) });
const userText = (data, src, body, extra = '') => `Company: ${data.issuerName}. ${src.form} for the period ended ${src.periodEnd}.${extra}\n\n${body}`;
// Exactly the two messages the reader gets: the rules, a blank line, then the company and its windows.
const promptFor = (data, src, text) => `${SYSTEM}\n\n${userText(data, src, windows(text))}`;

// The step both reading modes share: the company's figures, its latest annual report and that report's text.
async function load(cik) {
    const data = JSON.parse(fs.readFileSync(path.join(FIN, cik + '.json'), 'utf8'));
    const src = latestAnnual(data);
    const head = { version: profiles.VERSION, cik, issuerName: data.issuerName || null, builtAt: new Date().toISOString() };
    const doc = src ? await filingText(cik, src) : null;
    return { data, src, head, doc };
}

async function one(cik) {
    const { data, src, head, doc: cached } = await load(cik);
    if (!src) return { ...head, status: 'no-annual-report' };
    let doc = cached;
    const filingOf = () => filingFields(src, doc);
    if (!doc || doc.text.length < 2000) return { ...head, filing: filingOf(), status: 'filing-unreadable' };
    // Checked against the whole document read, not only the excerpt, so a name the model read in the
    // excerpt and the filing repeats elsewhere is not lost to where the window was cut.
    const reader = text => {
        const body = windows(text);
        const user = extra => userText(data, src, body, extra);
        const ask = (extra, model) => CLAUDE ? askClaude(user(extra), model) : ai.chatRaw([{ role: 'system', content: SYSTEM }, { role: 'user', content: user(extra) }],
            { purpose: 'summary', temperature: 0, maxTokens: 5000, timeoutMs: 180000 });
        return async model => {
            let parsed = parse(await ask('', model));
            if (!parsed) parsed = parse(await ask(' REPLY WITH ONLY THE JSON OBJECT; your entire reply must parse as JSON.', model));
            return parsed ? validate(parsed, text) : null;
        };
    };
    let v = await reader(doc.text)(CLAUDE_MODEL), escalated = null;
    const why = CLAUDE && ESCALATE ? hard(v, data, doc.text) : null;
    if (why) {
        // The stronger read replaces the first one only when it has segments of its own.
        const w = await reader(doc.text)(ESCALATE);
        escalated = why;
        if (w && w.segments.length) v = w;
    }
    // A cover page or a wrapper 10-K reads to no segments; the report's own exhibit 13/99 is tried once.
    if (v && !v.segments.length && !doc.exhibit) {
        const ex = await exhibitText(cik, src);
        if (ex && ex.text.length > 2000) {
            const w = await reader(ex.text)(CLAUDE_MODEL);
            if (w && w.segments.length) { v = w; doc = { ...ex, exhibit: String(ex.url).split('/').pop() }; }
        }
    }
    if (!v) return { ...head, filing: filingOf(), status: 'model-unparseable', ...(escalated ? { escalated } : {}) };
    // Still split after the stronger read: the card keeps its figures only rather than showing a
    // product table as the segments. The read is kept in the record for review, not shown.
    if (oneSegmentMismatch(v, doc.text)) return { ...head, filing: filingOf(), status: 'one-segment-mismatch', ...v, ...(escalated ? { escalated } : {}) };
    return { ...head, filing: filingOf(), status: v.segments.length ? 'ok' : 'no-segments', ...v, ...(escalated ? { escalated } : {}) };
}

// --dump: the prompt each filing would be read with, and its filing fields, written out for a reader
// outside this script. No model is called, and no record is written for a filing that can be read.
async function dump(cik, dir) {
    const { data, src, head, doc } = await load(cik);
    if (!src) return { ...head, status: 'no-annual-report' };
    if (!doc || doc.text.length < 2000) return { ...head, filing: filingFields(src, doc), status: 'filing-unreadable' };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, cik + '.prompt.txt'), promptFor(data, src, doc.text) + '\n');
    fs.writeFileSync(path.join(dir, cik + '.meta.json'), JSON.stringify(filingFields(src, doc), null, 1) + '\n');
    return null;
}

// A validated reply against one filing's text becomes the record one() would write. An exhibit reply
// names the document the words were read from.
function recordFromReply(head, src, doc, parsed) {
    const v = validate(parsed, doc.text);
    const filing = filingFields(src, doc);
    if (oneSegmentMismatch(v, doc.text)) return { ...head, filing, status: 'one-segment-mismatch', ...v, reader: 'agent' };
    return { ...head, filing, status: v.segments.length ? 'ok' : 'no-segments', ...v, reader: 'agent' };
}

// --from-replies: the same checks one() applies, on a reply written to DIR/<cik>.reply.json. A reply
// with no segments from a wrapper filing is retried once against its exhibit 13/99: that prompt is
// written out as DIR/<cik>.exhibit.prompt.txt, and DIR/<cik>.exhibit.reply.json is read when present.
async function fromReply(cik, dir) {
    const { data, src, head, doc } = await load(cik);
    if (!src) return { ...head, status: 'no-annual-report' };
    const filing = filingFields(src, doc);
    if (!doc || doc.text.length < 2000) return { ...head, filing, status: 'filing-unreadable' };
    const read = name => { const f = path.join(dir, cik + name); return fs.existsSync(f) ? parse({ content: fs.readFileSync(f, 'utf8') }) : null; };
    let parsed = read('.reply.json');
    if (!parsed) return { ...head, filing, status: 'model-unparseable', reader: 'agent' };
    let rec = recordFromReply(head, src, doc, parsed);
    // A wrapper 10-K reads to no segments; its exhibit 13/99 is offered once, exactly as one() does.
    if (rec.status === 'no-segments' && !doc.exhibit) {
        const ex = await exhibitText(cik, src).catch(() => null);
        if (ex && ex.text.length > 2000) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, cik + '.exhibit.prompt.txt'), promptFor(data, src, ex.text) + '\n');
            const again = read('.exhibit.reply.json');
            if (again) {
                const exDoc = { ...ex, exhibit: String(ex.url).split('/').pop() };
                const exRec = recordFromReply(head, src, exDoc, again);
                if (exRec.segments.length) rec = exRec;
            }
        }
    }
    return rec;
}

function targets() {
    const all = ONLY.length ? ONLY : fs.readdirSync(FIN).filter(f => /^\d{10}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
    // A profile is read again when its company files a newer annual report than the one it was read from.
    const stale = cik => { const rec = profiles.read(cik); if (!profiles.current(rec)) return true;
        try { const src = latestAnnual(JSON.parse(fs.readFileSync(path.join(FIN, cik + '.json'), 'utf8'))); return !!src && src.accessionNumber !== rec.filing?.accessionNumber; } catch (_) { return false; } };
    const todo = all.filter(cik => REBUILD || ONLY.length || stale(cik));
    return LIMIT ? todo.slice(0, LIMIT) : todo;
}

module.exports = { validate, windows, latestAnnual, pickDocument, businessExhibit, widestExhibit, ONE_SEGMENT, oneSegmentMismatch, statedSegments, THIN, SYSTEM,
    promptFor, recordFromReply, filingFields };
if (require.main === module) (async () => {
    // Two-stage modes never load a provider and never touch a model.
    if (DUMP || FROM_REPLIES) {
        const dir = path.resolve(DUMP || FROM_REPLIES), mode = DUMP ? 'dump' : 'from-replies';
        if (!ONLY.length) { console.error('--' + mode + ' needs at least one --cik'); process.exit(1); }
        fs.mkdirSync(dir, { recursive: true });
        const run = cik => (DUMP ? dump(cik, dir) : fromReply(cik, dir)).then(rec => {
            if (rec) profiles.write(cik, rec);
            console.log(cik, rec ? rec.status : 'prompt written', JSON.stringify(rec ? (rec.dropped || []) : []));
            return rec ? rec.status : 'prompt';
        }).catch(e => { console.log(cik, 'error', clip(e.message, 200)); return 'error'; });
        const queue = ONLY.slice(), tally = {};
        await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
            for (let cik = queue.shift(); cik; cik = queue.shift()) { const s = await run(cik); tally[s] = (tally[s] || 0) + 1; }
        }));
        console.log(mode, JSON.stringify(tally));
        process.exit(0);
    }
    if (!CLAUDE) {
        require('./lib/dev-env').loadAiEnvOnly(BACKEND);
        ai = require(path.join(BACKEND, 'ai-client'));
        if (!ai.isConfigured()) { console.error('AI provider key not found in backend/.env'); process.exit(1); }
    }
    const todo = targets(), started = Date.now(), tally = {};
    console.log(`${todo.length} issuers to read, ${JOBS} at a time`);
    let done = 0;
    let halt = null;
    async function worker() {
        for (let cik = todo.shift(); cik && !halt; cik = todo.shift()) {
            let rec;
            try { rec = await one(cik); } catch (e) { rec = { version: profiles.VERSION, cik, builtAt: new Date().toISOString(), status: 'error', error: clip(e.message, 200) }; }
            // Errors are not written: a provider outage must not stamp a company as read. A usage limit
            // stops the run instead of failing every company after it; a rerun resumes where it stopped.
            if (rec.status !== 'error') profiles.write(cik, rec);
            else if (/limit|rate|429|overloaded|credit/i.test(rec.error)) halt = rec.error;
            tally[rec.status] = (tally[rec.status] || 0) + 1;
            if (rec.escalated) tally.escalated = (tally.escalated || 0) + 1;
            if (++done % 25 === 0 || ONLY.length) console.log(`${done} done (${Math.round((Date.now() - started) / 1000)}s)`, JSON.stringify(tally), JSON.stringify(usage),
                ONLY.length ? JSON.stringify(rec).slice(0, 3000) : '');
        }
    }
    await Promise.all(Array.from({ length: JOBS }, worker));
    console.log(halt ? 'STOPPED: ' + halt : 'finished', JSON.stringify(tally), JSON.stringify(usage), Math.round((Date.now() - started) / 1000) + 's');
})();
