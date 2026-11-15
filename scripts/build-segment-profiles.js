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

async function filingText(cik, src) {
    const file = path.join(CACHE, src.accessionNumber + '.txt.gz');
    const wanted = primaryDocument(cik, src);
    if (fs.existsSync(file)) {
        const t = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
        // A cached copy is reused only when it is the document this filing names (older entries carry no name).
        if (!wanted || String(t.url || '').split('/').pop() === wanted) return t;
    }
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${src.accessionNumber.replace(/-/g, '')}`;
    const index = await sec(base + '/index.json');
    if (!index) return null;
    let doc = null;
    try { doc = pickDocument(JSON.parse(index.toString('utf8')).directory.item, wanted); } catch (_) { }
    if (!doc) return null;
    const html = await sec(base + '/' + doc.name);
    if (!html) return null;
    const t = { url: base + '/' + doc.name, text: decode(html.toString('utf8')) };
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(t)));
    return t;
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
    'segments: the company\'s REPORTABLE segments, named exactly as the filing names them. A company with one reportable segment gets one entry, under the name the filing gives that segment (for example "Advertising"); if the filing gives it no name, use the business it is in, in one to three words taken from the text. Product lines, brands, end markets and geographic disclosures are NOT segments unless the filing calls them reportable segments. Leave out corporate, eliminations and reconciling items. Include an "All other" or "Other" entry only when the filing reports it beside the segments; name it as the filing does.',
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

// What the cheap read cannot be trusted to settle: no segment survived the check, a segment it named
// is not in the filing, or none of its segments is any segment row the filing tags.
function hard(v, data) {
    if (!v || !v.segments.length) return 'no segments';
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

async function one(cik) {
    const data = JSON.parse(fs.readFileSync(path.join(FIN, cik + '.json'), 'utf8'));
    const src = latestAnnual(data);
    const head = { version: profiles.VERSION, cik, issuerName: data.issuerName || null, builtAt: new Date().toISOString() };
    if (!src) return { ...head, status: 'no-annual-report' };
    const doc = await filingText(cik, src);
    const filing = { form: src.form, accessionNumber: src.accessionNumber, periodEnd: src.periodEnd, filingDate: src.filingDate || null, url: doc?.url || null };
    if (!doc || doc.text.length < 2000) return { ...head, filing, status: 'filing-unreadable' };
    const text = windows(doc.text);
    const user = extra => `Company: ${data.issuerName}. ${src.form} for the period ended ${src.periodEnd}.${extra}\n\n${text}`;
    const ask = (extra, model) => CLAUDE ? askClaude(user(extra), model) : ai.chatRaw([{ role: 'system', content: SYSTEM }, { role: 'user', content: user(extra) }],
        { purpose: 'summary', temperature: 0, maxTokens: 5000, timeoutMs: 180000 });
    // Checked against the whole filing, not only the excerpt, so a name the model read in the excerpt
    // and the filing repeats elsewhere is not lost to where the window was cut.
    const read = async model => {
        let parsed = parse(await ask('', model));
        if (!parsed) parsed = parse(await ask(' REPLY WITH ONLY THE JSON OBJECT; your entire reply must parse as JSON.', model));
        return parsed ? validate(parsed, doc.text) : null;
    };
    let v = await read(CLAUDE_MODEL), escalated = null;
    const why = CLAUDE && ESCALATE ? hard(v, data) : null;
    if (why) {
        // The stronger read replaces the first one only when it has segments of its own.
        const w = await read(ESCALATE);
        escalated = why;
        if (w && w.segments.length) v = w;
    }
    if (!v) return { ...head, filing, status: 'model-unparseable', ...(escalated ? { escalated } : {}) };
    return { ...head, filing, status: v.segments.length ? 'ok' : 'no-segments', ...v, ...(escalated ? { escalated } : {}) };
}

function targets() {
    const all = ONLY.length ? ONLY : fs.readdirSync(FIN).filter(f => /^\d{10}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
    // A profile is read again when its company files a newer annual report than the one it was read from.
    const stale = cik => { const rec = profiles.read(cik); if (!profiles.current(rec)) return true;
        try { const src = latestAnnual(JSON.parse(fs.readFileSync(path.join(FIN, cik + '.json'), 'utf8'))); return !!src && src.accessionNumber !== rec.filing?.accessionNumber; } catch (_) { return false; } };
    const todo = all.filter(cik => REBUILD || ONLY.length || stale(cik));
    return LIMIT ? todo.slice(0, LIMIT) : todo;
}

module.exports = { validate, windows, latestAnnual, pickDocument, SYSTEM };
if (require.main === module) (async () => {
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
