#!/usr/bin/env node
'use strict';
// Administrator-only, one-time plaintext code export. Run outside production
// web requests, with a pepper set in the shell/secret manager. The database
// receives hashes only; the CSV is chmod 600 and written outside the repo.
const fs = require('fs'); const path = require('path'); const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '../backend/prod.env') });
const dealMirror = require('../backend/dealmirror');
function arg(name) { const p = process.argv.find((x) => x.startsWith(`--${name}=`)); return p && p.slice(name.length + 3); }
async function main() {
  const batchNumber = Number(arg('batch')); const actor = arg('actor') || 'admin'; const approved = arg('approved') === 'true';
  let approval = null; if (arg('approval-json')) { try { approval = JSON.parse(arg('approval-json')); } catch (_) { throw new Error('--approval-json must be valid JSON'); } }
  const outDir = path.resolve(arg('out-dir') || process.env.DEALMIRROR_EXPORT_DIR || '/var/tmp/stockportfolio-dealmirror');
  if (!dealMirror.validConfig()) throw new Error('Invalid DealMirror configuration; initial cap must be 50 and absolute cap must be 100.');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  if (!process.env.DEALMIRROR_CODE_PEPPER) throw new Error('DEALMIRROR_CODE_PEPPER is required.');
  if (outDir.startsWith(path.resolve(__dirname, '..') + path.sep)) throw new Error('Export directory must be outside the repository.');
  await mongoose.connect(process.env.MONGODB_URI); const { batch, plaintext } = await dealMirror.generateBatch({ batchNumber, actor, approved, approval });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  for (const tier of Object.keys(dealMirror.TIERS)) {
    const target = path.join(outDir, `dealmirror-batch-${batch.batchNumber}-${tier}.csv`); const rows = plaintext.filter((x) => x.tier === tier);
    fs.writeFileSync(target, `tier,code\n${rows.map((r) => `${r.tier},${r.code}`).join('\n')}\n`, { mode: 0o600, flag: 'wx' }); fs.chmodSync(target, 0o600);
  }
  batch.status = 'exported'; batch.exportedAt = new Date(); await batch.save(); await dealMirror.audit('codes_exported', actor, { batchId: batch._id, batchNumber: batch.batchNumber, issuedCount: batch.issuedCount });
  process.stdout.write(JSON.stringify({ ok: true, batch: batch.batchNumber, issued: batch.issuedCount, outDir, files: Object.keys(dealMirror.TIERS).map((tier) => `dealmirror-batch-${batch.batchNumber}-${tier}.csv`) }) + '\n');
}
main().catch((error) => { process.stderr.write(`DealMirror generation failed: ${error.message}\n`); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
