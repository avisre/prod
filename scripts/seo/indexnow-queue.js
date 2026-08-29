#!/usr/bin/env node
/* Durable, non-blocking change queue for IndexNow. This module only manages
 * local queue state; scripts/indexnow-ping.js --queue remains the sender and is
 * the only thing that talks to the network. Enqueuing is therefore always safe:
 * it writes a local JSON file and nothing else. */
const fs = require('fs');
const path = require('path');
const { ROOT, writeText } = require('./lib');

const HOST = 'www.stockportfolio.pro';
const DEFAULT_FILE = path.join(ROOT, 'seo-data/indexnow-queue.json');

function load(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value) ? value : []; }
  catch (_) { return []; }
}
function save(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
}
function ticker(url) { const m = String(url || '').match(/\/stocks\/([^/]+)/i); return m ? m[1].toUpperCase() : ''; }

/* Normalise to an absolute on-host URL, or null if it does not belong in the
 * queue. Query strings and fragments are rejected: they are never canonical. */
function canonicalise(url) {
  try {
    const parsed = new URL(url, `https://${HOST}`);
    if (parsed.hostname !== HOST || parsed.search || parsed.hash) return null;
    return parsed.toString();
  } catch (_) { return null; }
}

/* Add URLs to the queue. Returns a summary; never throws on a bad URL. A URL
 * already queued is left alone; one already submitted is re-queued only when
 * the data_version actually changed, so a re-run does not resubmit unchanged
 * pages. */
function enqueue(urls, options = {}) {
  const file = options.file || DEFAULT_FILE;
  const queue = load(file);
  const now = new Date().toISOString();
  const reason = options.reason || 'financial-data-change';
  const dataVersion = options.dataVersion || now.slice(0, 10);
  let added = 0; let requeued = 0; let skipped = 0;
  for (const url of urls || []) {
    const canonical = canonicalise(url);
    if (!canonical) { skipped += 1; continue; }
    const existing = queue.find((r) => r.url === canonical && ['queued', 'submitted'].includes(r.status));
    if (existing) {
      if (existing.data_version !== dataVersion && existing.status === 'submitted') {
        existing.status = 'queued';
        existing.submitted_at = null;
        existing.data_version = dataVersion;
        existing.changed_at = now;
        existing.next_attempt_at = now;
        requeued += 1;
      } else skipped += 1;
      continue;
    }
    queue.push({
      url: canonical, ticker: ticker(canonical), reason, data_version: dataVersion,
      changed_at: now, submitted_at: null, status: 'queued', attempt_count: 0,
      next_attempt_at: now, last_error: null
    });
    added += 1;
  }
  save(file, queue);
  return { file, added, requeued, skipped, queued: queue.filter((r) => r.status === 'queued').length, total: queue.length };
}

function ready(options = {}) {
  const file = options.file || DEFAULT_FILE;
  const now = Date.now();
  const limit = Number(options.limit || 10000);
  return load(file)
    .filter((r) => r.status === 'queued' && (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= now))
    .slice(0, limit);
}

function markSubmitted(urls, options = {}) {
  const file = options.file || DEFAULT_FILE;
  const status = options.status === 'error' ? 'error' : 'submitted';
  const now = new Date().toISOString();
  const set = new Set(urls || []);
  const rows = load(file).map((row) => {
    if (!set.has(row.url)) return row;
    const attempts = (row.attempt_count || 0) + 1;
    return {
      ...row,
      status,
      submitted_at: status === 'submitted' ? now : row.submitted_at,
      attempt_count: attempts,
      next_attempt_at: status === 'error'
        ? new Date(Date.now() + Math.min(6 * 60 * 60 * 1000, 30 * 1000 * (2 ** Math.min(attempts, 8)))).toISOString()
        : null,
      last_error: status === 'error' ? (options.error || 'sender failure') : null
    };
  });
  save(file, rows);
  return { file, updated: set.size, status };
}

function status(options = {}) {
  const file = options.file || DEFAULT_FILE;
  const queue = load(file);
  const counts = queue.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const recent = queue.filter((r) => r.changed_at && Date.parse(r.changed_at) >= Date.now() - 24 * 60 * 60 * 1000);
  writeText(path.join(ROOT, 'docs/seo/indexnow-diagnostics.md'), [
    '# IndexNow queue diagnostics', '',
    `Generated: **${new Date().toISOString()}**`,
    `- Queue file: \`${file}\``,
    `- Counts: ${Object.entries(counts).map(([k, v]) => `\`${k}\` ${v}`).join(', ') || 'empty'}`,
    `- Changed in last 24h: **${recent.length}**`, '',
    'The existing IndexNow sender remains unchanged and must be invoked by the approved data-refresh/deployment workflow. This queue is non-blocking: a failed submission records an error and exponential backoff; page publishing must continue.', ''
  ].join('\n'));
  return { file, counts, changed24h: recent.length };
}

module.exports = { enqueue, ready, markSubmitted, status, canonicalise, DEFAULT_FILE };

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
  const file = path.resolve(args.file || DEFAULT_FILE);
  const command = args._ || process.argv[2] || 'status';
  const positional = process.argv.slice(3).filter((v) => !v.startsWith('--'));
  if (command === 'enqueue') {
    console.log(JSON.stringify(enqueue(positional, { file, reason: args.reason, dataVersion: args.data_version || args.dataVersion }), null, 2));
  } else if (command === 'ready') {
    console.log(JSON.stringify(ready({ file, limit: args.limit }), null, 2));
  } else if (command === 'mark-submitted') {
    console.log(JSON.stringify(markSubmitted(positional, { file, status: args.status, error: args.error }), null, 2));
  } else {
    console.log(JSON.stringify(status({ file }), null, 2));
  }
}
