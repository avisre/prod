#!/usr/bin/env node
/* Durable, non-blocking change queue for IndexNow. This command only manages
 * local queue state; the existing scripts/indexnow-ping.js remains the sender.
 * Integrating the sender is a separate rollout decision. */
const fs = require('fs');
const path = require('path');
const { ROOT, writeText } = require('./lib');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const file = path.resolve(args.file || path.join(ROOT, 'seo-data/indexnow-queue.json'));
function load() { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(value) ? value : []; } catch (_) { return []; } }
function save(rows) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`); }
function ticker(url) { const m = String(url || '').match(/\/stocks\/([^/]+)/i); return m ? m[1].toUpperCase() : ''; }
const command = args._ || process.argv[2] || 'status';
let queue = load();
if (command === 'enqueue') {
  const urls = process.argv.slice(3).filter((v) => !v.startsWith('--'));
  const now = new Date().toISOString(); const reason = args.reason || 'financial-data-change'; const dataVersion = args.data_version || args.dataVersion || now.slice(0, 10);
  for (const url of urls) {
    try { const parsed = new URL(url, 'https://www.stockportfolio.pro'); if (parsed.hostname !== 'www.stockportfolio.pro' || parsed.search || parsed.hash) continue; const canonical = parsed.toString(); const existing = queue.find((r) => r.url === canonical && ['queued', 'submitted'].includes(r.status)); if (existing) { if (existing.data_version !== dataVersion && existing.status === 'submitted') { existing.status = 'queued'; existing.submitted_at = null; existing.data_version = dataVersion; existing.changed_at = now; } continue; } queue.push({ url: canonical, ticker: ticker(canonical), reason, data_version: dataVersion, changed_at: now, submitted_at: null, status: 'queued', attempt_count: 0, next_attempt_at: now, last_error: null }); } catch (_) { /* invalid URL ignored */ }
  }
  save(queue); console.log(JSON.stringify({ file, queued: queue.filter((r) => r.status === 'queued').length, total: queue.length }, null, 2));
} else if (command === 'ready') {
  const now = Date.now(); const limit = Number(args.limit || 10000); const ready = queue.filter((r) => r.status === 'queued' && (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= now)).slice(0, limit); console.log(JSON.stringify(ready, null, 2));
} else if (command === 'mark-submitted') {
  const status = args.status === 'error' ? 'error' : 'submitted'; const urls = process.argv.slice(3).filter((v) => !v.startsWith('--')); const now = new Date().toISOString();
  queue = queue.map((row) => { if (!urls.includes(row.url)) return row; const attempts = (row.attempt_count || 0) + 1; return { ...row, status, submitted_at: status === 'submitted' ? now : row.submitted_at, attempt_count: attempts, next_attempt_at: status === 'error' ? new Date(Date.now() + Math.min(6 * 60 * 60 * 1000, 30 * 1000 * (2 ** Math.min(attempts, 8)))).toISOString() : null, last_error: status === 'error' ? (args.error || 'sender failure') : null }; }); save(queue); console.log(JSON.stringify({ file, updated: urls.length, status }, null, 2));
} else {
  const counts = queue.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}); const recent = queue.filter((r) => r.changed_at && Date.parse(r.changed_at) >= Date.now() - 24 * 60 * 60 * 1000); writeText(path.join(ROOT, 'docs/seo/indexnow-diagnostics.md'), ['# IndexNow queue diagnostics', '', `Generated: **${new Date().toISOString()}**`, `- Queue file: \`${file}\``, `- Counts: ${Object.entries(counts).map(([k, v]) => `\`${k}\` ${v}`).join(', ') || 'empty'}`, `- Changed in last 24h: **${recent.length}**`, '', 'The existing IndexNow sender remains unchanged and must be invoked by the approved data-refresh/deployment workflow. This queue is non-blocking: a failed submission records an error and exponential backoff; page publishing must continue.', ''].join('\n')); console.log(JSON.stringify({ file, counts, changed24h: recent.length }, null, 2));
}
