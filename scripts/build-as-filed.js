#!/usr/bin/env node
'use strict';
// Builds frontend/data/sec-as-filed/<cik>.json: each covered company's income
// statement, balance sheet and cash-flow statement as filed in its annual reports
// (10-K, 20-F, 40-F), every line with its own label, from SEC's Financial Statement
// Data Sets. See backend/as-filed.js for how the years are stitched together.
//
//   node scripts/build-as-filed.js [--dir ~/.cache/stockportfolio/fsds] [--jobs N]
//
// --dir holds the quarterly zips (2026q3.zip, ...) as SEC publishes them
// (https://www.sec.gov/data-research/sec-markets-data/financial-statement-data-sets).
// One child process reads each zip, streamed. Only issuers we cover (a file in
// frontend/data/sec-financials) are kept.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), readline = require('node:readline'), { spawn } = require('node:child_process');
const backend = path.join(__dirname, '../backend'), req = (m) => require(path.join(backend, 'node_modules', m));
const asFiled = require('../backend/as-filed'), p = require('../backend/sec-coverage');
const FORM = /^(10-K|10-KT|20-F|40-F)(\/A)?$/;
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const day = (s) => /^\d{8}$/.test(s || '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;

function openZip(file) { const yauzl = req('yauzl'); return new Promise((res, rej) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, zf) => { if (e) return rej(e); const entries = new Map(); zf.on('entry', (en) => { entries.set(en.fileName, en); zf.readEntry(); }); zf.on('end', () => res({ zf, entries })); zf.on('error', rej); zf.readEntry(); })); }
async function table(zip, name, fn) {
    const entry = zip.entries.get(name); if (!entry) throw new Error(`${name} missing`);
    const stream = await new Promise((res, rej) => zip.zf.openReadStream(entry, (e, rs) => e ? rej(e) : res(rs)));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity }); let head = null;
    for await (const text of rl) { const c = text.split('\t'); if (!head) { head = Object.fromEntries(c.map((h, i) => [h, i])); continue; } fn(c, head); }
}

// One record per annual report: its statement lines (the report of each statement
// with the most lines, parentheticals excluded) and their undimensioned values.
async function child(file, out, covered) {
    const zip = await openZip(file), subs = new Map();
    await table(zip, 'sub.txt', (c, h) => { const cik = p.cik(c[h.cik]); if (covered.has(cik) && FORM.test(c[h.form])) subs.set(c[h.adsh], { cik, a: c[h.adsh], m: c[h.form], d: day(c[h.filed]), p: day(c[h.period]), name: c[h.name] }); });
    const reports = new Map();
    await table(zip, 'pre.txt', (c, h) => {
        const adsh = c[h.adsh], stmt = c[h.stmt];
        if (!subs.has(adsh) || !asFiled.STATEMENTS[stmt] || c[h.inpth] !== '0') return;
        const key = adsh + '|' + stmt + '|' + c[h.report];
        if (!reports.has(key)) reports.set(key, []);
        reports.get(key).push([Number(c[h.line]), c[h.tag], c[h.version] === adsh ? 1 : 0, c[h.plabel], c[h.negating] === '1' ? 1 : 0]);
    });
    const st = new Map();
    for (const [key, lines] of reports) {
        const [adsh, stmt] = key.split('|');
        if (!st.has(adsh)) st.set(adsh, {});
        const s = st.get(adsh);
        if (!s[stmt] || lines.length > s[stmt].length) s[stmt] = lines;
    }
    const wanted = new Set();
    for (const [adsh, s] of st) for (const [stmt, lines] of Object.entries(s)) { s[stmt] = lines.sort((x, y) => x[0] - y[0]).map((l) => l.slice(1)); for (const l of s[stmt]) wanted.add(adsh + '|' + l[0]); }
    const nums = new Map();
    await table(zip, 'num.txt', (c, h) => {
        const adsh = c[h.adsh], tag = c[h.tag];
        if (!wanted.has(adsh + '|' + tag) || c[h.value] === '') return;
        // A combined report (a REIT and its operating partnership) or one tagged to a single legal
        // entity (Deutsche Bank's ConsolidatedBankEntity) files its statement figures under the
        // legal-entity dimension only; such a value is kept with its entity, any other dimension is not.
        const segments = h.segments !== undefined ? c[h.segments] : (c[h.coreg] ? `LegalEntity=${c[h.coreg]};` : '');
        const entity = segments ? (/^LegalEntity=([^;=]+);?$/.exec(segments) || [])[1] : '';
        if (entity === undefined || (c[h.coreg] && c[h.coreg] !== entity)) return;
        const qtrs = Number(c[h.qtrs]), value = Number(c[h.value]), end = day(c[h.ddate]);
        if ((qtrs !== 0 && qtrs !== 4) || !Number.isFinite(value) || !end || end > subs.get(adsh).d) return;
        if (!nums.has(adsh)) nums.set(adsh, {});
        const n = nums.get(adsh);
        (n[tag] ||= []).push(entity ? [end, qtrs, c[h.uom], value, entity] : [end, qtrs, c[h.uom], value]);
    });
    const w = fs.createWriteStream(out); let count = 0;
    for (const [adsh, s] of st) {
        const sub = subs.get(adsh);
        if (!sub.p || !nums.has(adsh)) continue;
        const n = nums.get(adsh), e = mainEntity(s, n, sub.name);
        // only the main entity's values are kept, and only for lines with no plain value at that date
        for (const [tag, rows] of Object.entries(n)) {
            const plain = new Set(rows.filter((x) => !x[4]).map((x) => x[0] + '|' + x[1]));
            n[tag] = rows.filter((x) => !x[4] || (x[4] === e && !plain.has(x[0] + '|' + x[1]))).map((x) => x.slice(0, 4));
        }
        w.write(JSON.stringify([sub.cik, { a: adsh, m: sub.m, d: sub.d, p: sub.p, st: s, n }]) + '\n'); count++;
    }
    await new Promise((r) => w.end(r)); zip.zf.close();
    return count;
}

// The legal entity whose figures stand in for the statement: the one carrying values for the most
// statement lines that have no plain value, ties going to the entity named like the registrant.
function mainEntity(st, n, name) {
    const cover = new Map(), want = asFiled.norm(name);
    for (const lines of Object.values(st)) for (const [tag] of lines) {
        const rows = n[tag] || [];
        if (rows.some((x) => !x[4])) continue;
        for (const e of new Set(rows.map((x) => x[4]).filter(Boolean))) cover.set(e, (cover.get(e) || 0) + 1);
    }
    const like = (e) => { const k = asFiled.norm(e).replace(/member$/, ''); return k && (want.includes(k) || k.includes(want)) ? 1 : 0; };
    return [...cover].sort((a, b) => b[1] - a[1] || like(b[0]) - like(a[0]) || a[0].length - b[0].length)[0]?.[0] || null;
}

async function main() {
    const covered = new Set(fs.readdirSync(path.join(p.DATA_DIR, 'sec-financials')).map((f) => f.replace(/\.json$/, '')).filter((f) => /^\d{10}$/.test(f)));
    if (process.argv[2] === '--child') { const n = await child(process.argv[3], process.argv[4], covered); console.log(path.basename(process.argv[3]), n, 'annual reports'); return; }
    const dir = arg('--dir', path.join(os.homedir(), '.cache/stockportfolio/fsds')), jobs = Number(arg('--jobs', Math.max(1, os.cpus().length - 2)));
    const zips = fs.readdirSync(dir).filter((f) => /^\d{4}q[1-4]\.zip$/.test(f)).sort();
    if (!zips.length) throw new Error(`no quarterly zips in ${dir}`);
    const tmp = arg('--keep', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'as-filed-'));
    fs.mkdirSync(tmp, { recursive: true });
    const queue = zips.filter((z) => !fs.existsSync(path.join(tmp, z + '.ndjson'))); let failed = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { for (let z; (z = queue.shift());) {
        const part = path.join(tmp, z + '.ndjson.part');
        const code = await new Promise((res) => { const c = spawn(process.execPath, ['--max-old-space-size=4096', __filename, '--child', path.join(dir, z), part], { stdio: ['ignore', 'inherit', 'inherit'] }); c.on('exit', res); });
        if (code !== 0) { failed++; console.error(z, 'failed with', code); } else fs.renameSync(part, path.join(tmp, z + '.ndjson'));
    } }));
    if (failed) throw new Error(`${failed} quarter(s) failed; nothing written`);
    const by = new Map();
    for (const z of zips) {
        const rl = readline.createInterface({ input: fs.createReadStream(path.join(tmp, z + '.ndjson')), crlfDelay: Infinity });
        for await (const text of rl) { if (!text) continue; const [cik, rec] = JSON.parse(text); if (!by.has(cik)) by.set(cik, []); by.get(cik).push(rec); }
    }
    const outDir = asFiled.DIR(); fs.mkdirSync(outDir, { recursive: true });
    const builtFrom = zips.map((z) => z.replace(/\.zip$/, '')); let written = 0;
    for (const [cik, filings] of by) {
        const doc = asFiled.assemble(filings);
        if (!doc) continue;
        p.atomicWrite(path.join(outDir, cik + '.json'), { schemaVersion: 1, cik, builtFrom, ...doc });
        written++;
    }
    for (const f of fs.readdirSync(outDir)) if (/^\d{10}\.json$/.test(f) && !by.has(f.slice(0, 10))) fs.unlinkSync(path.join(outDir, f));
    if (!arg('--keep', null)) fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`${written} issuers from ${zips.length} quarters -> ${path.relative(process.cwd(), outDir)}`);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
