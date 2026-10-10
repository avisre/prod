'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The failure this guards, which has now shipped twice. .claude/HANDOFF.md is the
// repo's durable working memory, but its size cap lived only as prose in CLAUDE.md
// -- nothing read the file. No test, no script, no workflow. So the only thing
// holding the cap was a session hand-compressing it, which is lossy, and which was
// skipped often enough that the file reached 2,391 lines. Compression also destroys
// exactly the detail the file exists to hold, so each squeeze bought one session and
// cost content. A rule nobody can check is not a rule; it is a hope.
//
// 2026-09-28: the cap went 160 -> 500 and the convention changed to snapshot-then-
// rewrite, with .claude/handoff-archive/<date>.md holding the displaced detail
// verbatim. This test is the enforcement half, so the cap cannot be crossed
// silently again.
//
// Deliberately dependency-free -- node builtins only, no mongoose, no network, no
// database -- so the pre-push gate (scripts/predeploy.js) can run it anywhere. A
// check that can fail for environmental reasons teaches people to ignore red Xs.

const ROOT = path.join(__dirname, '..', '..');
const HANDOFF = path.join(ROOT, '.claude', 'HANDOFF.md');
const ARCHIVE_DIR = path.join(ROOT, '.claude', 'handoff-archive');
const MAX_LINES = 500;

const text = fs.readFileSync(HANDOFF, 'utf8');
// Count the way `wc -l` does, so this test's number and dev-doctor's agree.
const lineCount = text.trimEnd().split('\n').length;

test('HANDOFF stays inside its 500-line cap', () => {
    assert.ok(lineCount <= MAX_LINES,
        `.claude/HANDOFF.md is ${lineCount} lines, past the ${MAX_LINES}-line cap. Snapshot it ` +
        'to .claude/handoff-archive/<date>.md and rewrite the live file fresh, keeping only `' +
        'current state and open actions. Do NOT compress it to fit -- that is the move that ' +
        'destroyed detail both previous times this file outgrew its cap.');
});

test('the cap is stated identically in both places a session reads it', () => {
    // CLAUDE.md is loaded into context every turn; HANDOFF.md is read at session
    // start. When the two disagree about the number, the smaller one silently wins
    // and the file drifts back over the larger -- which is how 160 became advisory
    // rather than binding.
    const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    const stated = new RegExp(`under ${MAX_LINES} lines`);
    assert.match(claude, stated, `CLAUDE.md must state the same ${MAX_LINES}-line cap this test enforces`);
    assert.match(text, stated, `HANDOFF.md's own header must state the same ${MAX_LINES}-line cap`);
});

test('a snapshot exists to receive the detail a rewrite displaces', () => {
    // The snapshot is the entire reason rewriting fresh is safe. Without somewhere
    // to put superseded state, "rewrite fresh" is just the old lossy compression
    // again, and the next session has no way to recover what it dropped.
    assert.ok(fs.existsSync(ARCHIVE_DIR), '.claude/handoff-archive/ must exist');
    const snapshots = fs.readdirSync(ARCHIVE_DIR).filter((name) => name.endsWith('.md'));
    assert.ok(snapshots.length > 0, '.claude/handoff-archive/ must hold at least one snapshot');
    for (const name of snapshots) {
        assert.match(name, /^\d{4}-\d{2}-\d{2}\.md$/,
            `snapshot ${name} must be named <date>.md so the archive stays sorted and self-describing`);
    }
    assert.ok(text.includes('handoff-archive'),
        'HANDOFF.md must point at the archive, or the next session cannot find where the detail went');
});
