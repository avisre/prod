'use strict';

// Which test files can a change affect?
//
// Until 2026-10-10 every push ran every check. A connector change does not
// need the stock-page tests and the reverse, so the gate (scripts/predeploy.js)
// asks this module which of the test files in backend/test depend on the files
// that changed, and runs only those.
//
// A test depends on:
//   - every file it reaches through require(), followed through the repo;
//   - every repo file it NAMES in a string (most tests read sources or pages
//     with readFileSync, or run a script), matched by path suffix or basename;
//   - for a test that lists a directory (readdirSync), everything under the
//     directories it names;
//   - the company data, when anything it requires reads frontend/data.
//
// It may only ever err toward running MORE: a name that matches two files
// counts for both, and a changed source file that no test maps to selects the
// whole suite. No install and no network, so it runs anywhere Node does.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_DIR = 'backend/test';
// A change to any of these can change how every test runs.
const RUN_EVERYTHING = [/^package(-lock)?\.json$/, /^backend\/package(-lock)?\.json$/, /^scripts\/predeploy\.js$/, /^scripts\/lib\/test-map\.js$/, /^scripts\/test-stock-coverage\.js$/, /^scripts\/local-qa\//];
// Source a test could be covering. An unmapped change here is not assumed safe.
const SOURCE = /^(backend|frontend-v2|scripts|lib|jobs)\//;
// Never source: a change here that no test names needs no test.
const NOT_SOURCE = /\.(md|txt|png|jpe?g|svg|mp4|webp|ico|pdf)$|^backend\/test\/|^docs\/|^notes\/|^mockups\/|^seo-data\//;
const DATA = /^frontend\/data\//;

const posix = (p) => p.split(path.sep).join('/');

function repoFiles(root) {
    // Tracked files plus new untracked ones; the bulk per-company data is left
    // out (thousands of files no test names one by one).
    const keep = (f) => f && !/^frontend\/data\/[^/]+\//.test(f) && !/(^|\/)node_modules(\/|$)/.test(f);
    try {
        const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        return out.split('\n').map((l) => l.trim()).filter(keep);
    } catch (_) {
        // Not a git checkout (the isolated copy the tests run in): walk it.
        const found = [];
        const walk = (dir) => {
            for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
                const rel = dir ? `${dir}/${ent.name}` : ent.name;
                if (ent.name === '.git' || ent.name === 'node_modules' || ent.isSymbolicLink()) continue;
                if (ent.isDirectory()) { if (!/^frontend\/data\/[^/]+$/.test(rel) && !/^(seo-data|docs|mockups)$/.test(rel)) walk(rel); } else if (keep(rel)) found.push(rel);
            }
        };
        walk('');
        return found;
    }
}

function build(root) {
    const files = repoFiles(root);
    const fileSet = new Set(files);
    const byBase = new Map();
    for (const f of files) { const b = path.posix.basename(f); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f); }
    const dirs = new Set();
    for (const f of files) { let d = path.posix.dirname(f); while (d && d !== '.') { dirs.add(d); d = path.posix.dirname(d); } }
    const dirsByBase = new Map();
    for (const d of dirs) { const b = path.posix.basename(d); if (!dirsByBase.has(b)) dirsByBase.set(b, []); dirsByBase.get(b).push(d); }

    const srcCache = new Map();
    const read = (rel) => { if (!srcCache.has(rel)) { let s = ''; try { s = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { /* unreadable: no deps */ } srcCache.set(rel, s); } return srcCache.get(rel); };

    const reqCache = new Map();
    function requires(rel) {
        if (reqCache.has(rel)) return reqCache.get(rel);
        const out = new Set();
        reqCache.set(rel, out);
        for (const m of read(rel).matchAll(/require\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g)) {
            const base = posix(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
            const hit = [base, `${base}.js`, `${base}.json`, `${base}.cjs`, `${base}/index.js`].find((c) => fileSet.has(c));
            if (!hit) continue;
            out.add(hit);
            if (/\.(c?js)$/.test(hit)) for (const d of requires(hit)) out.add(d);
        }
        return out;
    }

    // Repo files a source text names in a string literal.
    function named(src) {
        const out = new Set();
        const scanned = new Set();
        for (const m of src.matchAll(/['"`]([^'"`\n]{1,160})['"`]/g)) {
            const lit = m[1].replace(/\\/g, '/').replace(/^(\.{1,2}\/)+/, '').replace(/^\//, '').replace(/[?#].*$/, '');
            if (!lit || /[\s${}*<>|]/.test(lit)) continue;
            const base = path.posix.basename(lit);
            if (/\.[a-z0-9]{1,5}$/i.test(base)) {
                const cands = byBase.get(base) || [];
                for (const c of cands) if (!lit.includes('/') || c === lit || c.endsWith(`/${lit}`)) out.add(c);
            }
            for (const d of dirsByBase.get(base) || []) if (!lit.includes('/') || d === lit || d.endsWith(`/${lit}`)) scanned.add(d);
        }
        return { out, scanned };
    }

    const readsData = (rel) => /frontend[\\/]+data|DATA_DIR|['"`]data['"`]/.test(read(rel));

    const tests = new Map();
    for (const t of files.filter((f) => f.startsWith(`${TEST_DIR}/`) && f.endsWith('.test.js'))) {
        const src = read(t);
        const deps = new Set(requires(t));
        const { out, scanned } = named(src);
        // A file a test names is usually READ as text (its own requires are
        // irrelevant then). A script it names may be RUN, so a script's
        // requires are followed.
        for (const f of out) { deps.add(f); if (/^scripts\/.*\.(c?js)$/.test(f)) for (const d of requires(f)) deps.add(d); }
        deps.delete(t);
        tests.set(t, {
            deps,
            scans: /readdirSync/.test(src) ? [...scanned] : [],
            data: readsData(t) || [...requires(t)].some((d) => /\.(c?js)$/.test(d) && readsData(d))
        });
    }
    return { tests, fileSet };
}

/**
 * The test files to run for a set of changed files.
 * Returns { all, files, reasons } — `all` true means run the whole suite.
 */
function select(root, changed, map = build(root)) {
    const list = [...new Set(changed.map(posix))];
    const every = [...map.tests.keys()].sort();
    const forced = list.find((f) => RUN_EVERYTHING.some((re) => re.test(f)));
    if (forced) return { all: true, files: every, reasons: [`${forced} affects how every test runs`] };

    const picked = new Map(); // test -> why
    const unmapped = [];
    for (const f of list) {
        let hit = false;
        if (map.tests.has(f)) { picked.set(f, 'the test itself changed'); hit = true; }
        for (const [t, info] of map.tests) {
            const why = info.deps.has(f) ? `depends on ${f}`
                : info.scans.some((d) => f.startsWith(`${d}/`)) ? `scans the folder holding ${f}`
                    : (DATA.test(f) && info.data) ? 'reads the company data' : null;
            if (why) { hit = true; if (!picked.has(t)) picked.set(t, why); }
        }
        if (!hit && SOURCE.test(f) && !NOT_SOURCE.test(f) && map.fileSet.has(f)) unmapped.push(f);
    }
    if (unmapped.length) {
        return { all: true, files: every, reasons: [`no test maps to ${unmapped.slice(0, 3).join(', ')}${unmapped.length > 3 ? ` and ${unmapped.length - 3} more` : ''}, so nothing is skipped`] };
    }
    const files = [...picked.keys()].sort();
    return { all: false, files, reasons: files.map((t) => `${path.posix.basename(t)}: ${picked.get(t)}`) };
}

module.exports = { build, select, TEST_DIR };
