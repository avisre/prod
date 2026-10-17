#!/usr/bin/env node
'use strict';

// The deploy checks. They run on a developer machine before a push to main,
// not on GitHub, and only the ones the change can affect.
//
// Until 2026-10-10 GitHub ran all of them on every push (deploy-render.yml,
// "validate"): about 23 minutes each time, whatever had changed. The owner
// moved them here. GitHub now only tells Render to deploy, so this script is
// the gate; the pre-push hook (.githooks/pre-push) starts it, on the PC over
// SSH when it is reachable (scripts/predeploy-remote.sh) and on this machine
// otherwise.
//
//   node scripts/predeploy.js                 choose from what changed vs origin/main
//   node scripts/predeploy.js --range A..B    choose from that commit range (the hook passes this)
//   node scripts/predeploy.js --list          say what would run and why; run nothing
//   node scripts/predeploy.js --all           every test and every check
//
// Tests: scripts/lib/test-map.js picks the test files that depend on the
// changed files; an unmapped source change runs them all. Each of the four
// stock-data checks has its own trigger below. When in doubt, a check runs.

const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testMap = require('./lib/test-map');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : null; };

const DATA = /^frontend\/data\//;
const CHECKS = [
    { name: 'Dataset validation', cmd: ['scripts/validate-stock-coverage.js', '--bootstrap'],
        when: [DATA, /^backend\/(sec-[^/]+|financial-[^/]+|public-stock-index|screen-stock-index|stock-[^/]+|listing-[^/]+|quote-store|fundamentals-[^/]+)\.js$/, /^scripts\/(validate-stock-coverage|build-[a-z-]*index[a-z-]*|refresh-[^/]+)\.js$/] },
    { name: 'Revenue breakdown contract', cmd: ['scripts/audit-segment-display.js'],
        when: [/^frontend\/data\/fundamentals\//, /^backend\/(revenue-breakdown|[a-z-]*segment[a-z-]*|sec-revenue[^/]*)\.js$/, /^scripts\/audit-segment-display\.js$/] },
    { name: 'Every stock page and the sitemap', cmd: ['scripts/verify-public-stock-pages.js'],
        when: [DATA, /^backend\/(seo-[^/]+|comparison-pages|public-stock-index|verified-seo|sec-coverage|company-[^/]+|revenue-breakdown)\.js$/, /^scripts\/verify-public-stock-pages\.js$/] },
    { name: 'Server memory limit', alone: true, node: ['--max-old-space-size=256'], cmd: ['scripts/check-stock-coverage-performance.js'],
        when: [DATA, /^backend\/(public-stock-index|screen-stock-index|sec-coverage|financial-coverage)\.js$/, /^scripts\/check-stock-coverage-performance\.js$/] }
];
// A cache-stamp bump rewrites one string in every page and in the
// server-rendered page modules. A file whose ONLY change is the stamp cannot
// change what any page says, so it does not count as changed.
const STAMP = /\d{8}-[a-z0-9]+/g;

function git(...a) { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }

function onlyStampChanged(file, range) {
    let diff;
    try { diff = git('diff', '-U0', range, '--', file); } catch (_) { return false; }
    const lines = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    const minus = lines.filter((l) => l[0] === '-').map((l) => l.slice(1).replace(STAMP, '<stamp>'));
    const plus = lines.filter((l) => l[0] === '+').map((l) => l.slice(1).replace(STAMP, '<stamp>'));
    return lines.length > 0 && minus.length === plus.length && minus.every((l, i) => l === plus[i]);
}

function changedFiles(range) {
    const names = new Set();
    const add = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => names.add(f));
    add(git('diff', '--name-only', range));
    if (!value('--range')) { add(git('diff', '--name-only', 'HEAD')); add(git('ls-files', '--others', '--exclude-standard')); }
    return [...names].filter((f) => !/(^|\/)node_modules(\/|$)/.test(f));
}

function plan() {
    const range = value('--range') || 'origin/main...HEAD';
    if (flag('--all')) return { tests: { all: true, files: null, reasons: ['--all was given'] }, checks: CHECKS.map((c) => ({ ...c, why: '--all was given' })), changed: null };
    let changed;
    try { changed = changedFiles(range).filter((f) => !onlyStampChanged(f, range)); }
    catch (err) { return { tests: { all: true, files: null, reasons: [`the change could not be read (${String(err.message).split('\n')[0]}), so nothing is skipped`] }, checks: CHECKS.map((c) => ({ ...c, why: 'the change could not be read' })), changed: null }; }
    const tests = testMap.select(ROOT, changed);
    const checks = CHECKS.map((c) => { const hit = changed.find((f) => c.when.some((re) => re.test(f))); return hit ? { ...c, why: `${hit} changed` } : null; }).filter(Boolean);
    return { tests, checks, changed };
}

function knownFailures() {
    try { return new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'predeploy-known-failures.json'), 'utf8')).tests); } catch (_) { return new Set(); }
}

function runTests(files) {
    // Tests run in an isolated copy (scripts/test-stock-coverage.js) because
    // some of them rewrite data files.
    const names = files ? files.map((f) => path.posix.basename(f).replace(/\.test\.js$/, '')) : null;
    const a = ['scripts/test-stock-coverage.js', names ? `--files=${names.join(',')}` : '--all'];
    const r = spawnSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PREDEPLOY_CONCURRENCY: String(Math.max(2, os.cpus().length)) } });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const count = (k) => Number((out.match(new RegExp(`^[#ℹ] ${k} (\\d+)`, 'm')) || [])[1] || 0);
    const failed = [...new Set([...out.matchAll(/^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$/gm)].map((m) => m[1].trim()).filter((n) => n !== 'failing tests:'))];
    const known = knownFailures();
    const fresh = failed.filter((n) => !known.has(n));
    const ran = count('tests');
    // A run that reports nothing did not run: never read that as a pass.
    const broken = ran === 0 || (r.status !== 0 && failed.length === 0);
    return { ok: !broken && fresh.length === 0, ran, passed: count('pass'), fresh, known: failed.filter((n) => known.has(n)), broken, tail: out.trim().split('\n').slice(-12).join('\n') };
}

async function main() {
    const p = plan();
    const nTests = p.tests.all ? 'all test files' : `${p.tests.files.length} test file${p.tests.files.length === 1 ? '' : 's'}`;
    console.log(`predeploy on ${os.hostname()}: ${nTests}, ${p.checks.length} of ${CHECKS.length} data checks${p.changed ? ` (${p.changed.length} changed file${p.changed.length === 1 ? '' : 's'})` : ''}`);
    if (flag('--list')) {
        if (p.tests.all) console.log(`  tests: ALL — ${p.tests.reasons[0]}`);
        else for (const r of p.tests.reasons) console.log(`  test  ${r}`);
        for (const c of CHECKS) { const on = p.checks.find((x) => x.name === c.name); console.log(`  ${on ? 'run ' : 'skip'}  ${c.name}${on ? ` — ${on.why}` : ''}`); }
        return;
    }
    const started = Date.now();
    if (p.tests.all || p.tests.files.length) {
        const t = Date.now();
        process.stdout.write(`  Tests (${nTests}) … `);
        const r = runTests(p.tests.all ? null : p.tests.files);
        const secs = Math.round((Date.now() - t) / 1000);
        if (!r.ok) {
            console.log(`FAILED after ${secs}s`);
            if (r.broken) console.log(`      the test run itself did not complete:\n${r.tail.split('\n').map((l) => `      ${l.slice(0, 200)}`).join('\n')}`);
            for (const n of r.fresh) console.log(`      failing: ${n}`);
            console.log('predeploy: STOPPED — not pushed. Fix the failing test, then push again.');
            process.exit(1);
        }
        console.log(`passed in ${secs}s (${r.passed} of ${r.ran} cases${r.known.length ? `; ${r.known.length} already failing on main, listed in scripts/predeploy-known-failures.json` : ''})`);
    } else console.log('  Tests: none needed for this change');
    // The checks are independent, so they run at once; the memory and timing check runs alone after
    // them, since other work on the machine would distort what it measures.
    const run = (c) => new Promise((resolve) => {
        const t = Date.now(), child = spawn(process.execPath, [...(c.node || []), ...c.cmd], { cwd: ROOT });
        let out = '';
        child.stdout.on('data', (d) => { out = (out + d).slice(-64 * 1024); });
        child.stderr.on('data', (d) => { out = (out + d).slice(-64 * 1024); });
        child.on('close', (status) => resolve({ c, status, out, secs: Math.round((Date.now() - t) / 1000) }));
    });
    const report = (results) => {
        for (const r of results) {
            if (r.status !== 0) {
                console.log(`  ${r.c.name} … FAILED after ${r.secs}s`);
                console.log(r.out.trim().split('\n').slice(-15).map((l) => `      ${l.slice(0, 200)}`).join('\n'));
                console.log(`predeploy: STOPPED — not pushed. Re-run this one check with: node ${[...(r.c.node || []), ...r.c.cmd].join(' ')}`);
                process.exit(1);
            }
            console.log(`  ${r.c.name} … passed in ${r.secs}s`);
        }
    };
    const alone = p.checks.filter((c) => c.alone), together = p.checks.filter((c) => !c.alone);
    if (together.length) console.log(`  running ${together.map((c) => c.name).join(', ')} at once …`);
    report(await Promise.all(together.map(run)));
    for (const c of alone) report([await run(c)]);
    console.log(`predeploy: passed in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
