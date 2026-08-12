'use strict';

// Controlled DealMirror LTD pilot. This module intentionally owns codes only;
// it never stores plaintext codes in MongoDB and is disabled unless explicitly
// enabled at redemption time by DEALMIRROR_CAMPAIGN_ENABLED=true.
const crypto = require('crypto');
const mongoose = require('mongoose');

const TIERS = Object.freeze({ starter: { tier: 1, askCap: 30 }, investor: { tier: 2, askCap: 100 }, pro: { tier: 3, askCap: 300 } });
const INITIAL_ALLOCATION = Object.freeze({ starter: 20, investor: 20, pro: 10 });
const ABSOLUTE_CAP = 100; // Deliberately not configurable.
const BATCH_STATUSES = ['draft', 'generated', 'exported', 'active', 'exhausted', 'closed'];
const LICENCE_STATUSES = ['available', 'redeemed', 'refunded', 'revoked', 'expired'];

function enabled(env = process.env) { return String(env.DEALMIRROR_CAMPAIGN_ENABLED || '').toLowerCase() === 'true'; }
function secondBatchApproved(env = process.env) { return String(env.DEALMIRROR_SECOND_BATCH_APPROVED || '').toLowerCase() === 'true'; }
function redemptionDays(env = process.env) {
  const n = Number.parseInt(env.DEALMIRROR_REDEMPTION_DAYS, 10);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 60;
}
function config(env = process.env) {
  const initialCap = Number.parseInt(env.DEALMIRROR_INITIAL_CAP, 10);
  const configuredAbsolute = Number.parseInt(env.DEALMIRROR_ABSOLUTE_CAP, 10);
  return {
    enabled: enabled(env), initialCap: Number.isInteger(initialCap) ? initialCap : 50,
    absoluteCap: ABSOLUTE_CAP, redemptionDays: redemptionDays(env),
    secondBatchApproved: secondBatchApproved(env), pepperPresent: Boolean(String(env.DEALMIRROR_CODE_PEPPER || '')),
    salesEndAt: parseDate(env.DEALMIRROR_CAMPAIGN_SALES_END_AT)
  };
}
function validConfig(env = process.env) {
  const c = config(env);
  return c.initialCap === 50 && Number.parseInt(env.DEALMIRROR_ABSOLUTE_CAP || '100', 10) === ABSOLUTE_CAP && c.redemptionDays >= 1;
}
function parseDate(value) { const d = new Date(String(value || '')); return Number.isFinite(d.getTime()) ? d : null; }
function normalizeCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function codeHash(code, pepper = process.env.DEALMIRROR_CODE_PEPPER) {
  if (!pepper || String(pepper).length < 24) throw new Error('DEALMIRROR_CODE_PEPPER must be configured with at least 24 characters');
  return crypto.createHmac('sha256', String(pepper)).update(normalizeCode(code)).digest('hex');
}
function emailHash(email, pepper = process.env.DEALMIRROR_CODE_PEPPER) { return crypto.createHmac('sha256', String(pepper || '')).update(String(email || '').trim().toLowerCase()).digest('hex'); }
function maskedSuffix(code) { const v = normalizeCode(code); return v.slice(-6); }
function secureCode(batchNumber) { return `SPP-DM${batchNumber}-${crypto.randomBytes(16).toString('base64url').toUpperCase()}`; }
function sameAllocation(a, b = INITIAL_ALLOCATION) { return ['starter', 'investor', 'pro'].every((k) => Number(a && a[k]) === b[k]); }

const BatchSchema = new mongoose.Schema({
  batchNumber: { type: Number, required: true, unique: true, min: 1, max: 2 },
  status: { type: String, enum: BATCH_STATUSES, default: 'draft', index: true },
  tierAllocation: { type: Map, of: Number, required: true }, issuedCount: { type: Number, required: true, min: 0 },
  salesStartAt: { type: Date, default: null }, salesEndAt: { type: Date, default: null }, redemptionCutoff: { type: Date, default: null },
  generatedBy: { type: String, default: null }, explicitApprovalAt: { type: Date, default: null }, exportedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false, collection: 'dealmirror_batches' });
const LicenceSchema = new mongoose.Schema({
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'DealMirrorBatch', required: true, index: true },
  tier: { type: String, enum: Object.keys(TIERS), required: true, index: true }, codeHash: { type: String, required: true, unique: true, index: true },
  maskedCodeSuffix: { type: String, required: true, maxlength: 6 }, status: { type: String, enum: LICENCE_STATUSES, default: 'available', index: true },
  orderId: { type: String, default: null, sparse: true, unique: true }, purchasedAt: { type: Date, default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, emailHash: { type: String, default: null },
  issuedAt: { type: Date, default: () => new Date() }, redeemedAt: { type: Date, default: null }, redemptionCutoff: { type: Date, required: true, index: true },
  refundedAt: { type: Date, default: null }, revokedAt: { type: Date, default: null }, revocationReason: { type: String, default: null, maxlength: 500 }
}, { timestamps: true, versionKey: false, collection: 'dealmirror_licences' });
LicenceSchema.index({ userId: 1, status: 1 });
// A user may never hold two active DealMirror licences. Partial uniqueness
// leaves the many unredeemed/null-user rows valid and permanently prevents
// stacking even if two redemption requests arrive concurrently.
LicenceSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'redeemed', userId: { $type: 'objectId' } } });
LicenceSchema.index({ batchId: 1, status: 1 });
const ImportSchema = new mongoose.Schema({ sourceFilenameHash: { type: String, required: true, index: true }, importKey: { type: String, required: true, unique: true }, importedAt: { type: Date, default: () => new Date() }, columnMapping: { type: Object, default: {} }, dryRun: Boolean, results: { type: Object, default: {} }, administrator: String, auditRef: String }, { timestamps: true, versionKey: false, collection: 'dealmirror_imports' });
const AuditSchema = new mongoose.Schema({ action: { type: String, required: true, index: true }, actor: { type: String, required: true }, batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'DealMirrorBatch', default: null, index: true }, licenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DealMirrorLicence', default: null, index: true }, details: { type: Object, default: {} } }, { timestamps: true, versionKey: false, collection: 'dealmirror_audit_events' });
function model(name, schema) { return mongoose.models[name] || mongoose.model(name, schema); }
function models() { return { DealMirrorBatch: model('DealMirrorBatch', BatchSchema), DealMirrorLicence: model('DealMirrorLicence', LicenceSchema), DealMirrorImport: model('DealMirrorImport', ImportSchema), DealMirrorAuditEvent: model('DealMirrorAuditEvent', AuditSchema) }; }
async function audit(action, actor, details = {}) { const { DealMirrorAuditEvent } = models(); const { batchId, licenceId, ...safe } = details; return DealMirrorAuditEvent.create({ action, actor: String(actor || 'admin').slice(0, 160), batchId: batchId || null, licenceId: licenceId || null, details: safe }); }

const SECOND_BATCH_GATES = Object.freeze(['inventoryExhausted', 'refundWindowMatured', 'refundRateBelow10', 'activationRateAbove70', 'noUnresolvedEntitlementBugs', 'costsSustainable', 'supportAcceptable', 'netProceedsPositive', 'administratorApproved']);
function validSecondBatchApproval(approval) { return SECOND_BATCH_GATES.every((key) => approval && approval[key] === true); }
async function generateBatch({ batchNumber, actor, approved = false, approval = null, env = process.env, now = new Date() } = {}) {
  const c = config(env); if (!validConfig(env)) throw new Error('Invalid DealMirror configuration');
  if (![1, 2].includes(Number(batchNumber))) throw new Error('Only batches 1 and 2 are allowed');
  if (batchNumber === 2 && (!c.secondBatchApproved || !approved || !validSecondBatchApproval(approval))) throw new Error('Batch 2 needs every recorded decision gate and DEALMIRROR_SECOND_BATCH_APPROVED=true');
  const { DealMirrorBatch, DealMirrorLicence } = models();
  if (await DealMirrorBatch.exists({ batchNumber })) throw new Error(`Batch ${batchNumber} already exists`);
  const issued = await DealMirrorLicence.countDocuments({}); if (issued + 50 > ABSOLUTE_CAP) throw new Error('Absolute DealMirror issued-code cap would be exceeded');
  const cutoff = c.salesEndAt ? new Date(c.salesEndAt.getTime() + c.redemptionDays * 86400000) : null;
  if (!cutoff) throw new Error('DEALMIRROR_CAMPAIGN_SALES_END_AT is required before code generation');
  const batch = await DealMirrorBatch.create({ batchNumber, status: 'generated', tierAllocation: INITIAL_ALLOCATION, issuedCount: 50, salesStartAt: now, salesEndAt: c.salesEndAt, redemptionCutoff: cutoff, generatedBy: String(actor || 'admin'), explicitApprovalAt: batchNumber === 2 ? now : null });
  const plaintext = []; const docs = [];
  for (const [tier, count] of Object.entries(INITIAL_ALLOCATION)) for (let i = 0; i < count; i++) { const code = secureCode(batchNumber); plaintext.push({ tier, code }); docs.push({ batchId: batch._id, tier, codeHash: codeHash(code, env.DEALMIRROR_CODE_PEPPER), maskedCodeSuffix: maskedSuffix(code), redemptionCutoff: cutoff, issuedAt: now }); }
  await DealMirrorLicence.insertMany(docs, { ordered: true }); await audit('batch_generated', actor, { batchId: batch._id, batchNumber, issuedCount: 50, tiers: INITIAL_ALLOCATION });
  return { batch, plaintext }; // plaintext is caller-only; never persist or log it.
}
async function expireAvailable({ now = new Date(), actor = 'scheduler' } = {}) { const { DealMirrorLicence } = models(); const r = await DealMirrorLicence.updateMany({ status: 'available', redemptionCutoff: { $lt: now } }, { $set: { status: 'expired' } }); if (r.modifiedCount) await audit('licences_expired', actor, { count: r.modifiedCount }); return r.modifiedCount; }
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i], next = text[i + 1]; if (ch === '"' && quoted && next === '"') { cell += '"'; i++; } else if (ch === '"') quoted = !quoted; else if (ch === ',' && !quoted) { row.push(cell); cell = ''; } else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && next === '\n') i++; row.push(cell); if (row.some((v) => v !== '')) rows.push(row); row = []; cell = ''; } else cell += ch; }
  row.push(cell); if (row.some((v) => v !== '')) rows.push(row); if (!rows.length) return { headers: [], rows: [] }; const headers = rows.shift().map((h) => h.trim()); return { headers, rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] || '').trim()]))) };
}
async function reconcileCsv({ csv, mapping = {}, dryRun = true, actor = 'admin' } = {}) {
  const text = String(csv || ''); if (!text || Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('CSV is required and must be at most 2MB');
  const { headers, rows } = parseCsv(text); const codeColumn = String(mapping.code || 'code'), orderColumn = String(mapping.orderId || 'order_id'), statusColumn = String(mapping.status || 'status');
  if (!headers.includes(statusColumn) || (!headers.includes(codeColumn) && !headers.includes(orderColumn))) throw new Error('Mapping must include status and either a code or order ID column');
  const sourceFilenameHash = crypto.createHash('sha256').update(text).digest('hex'); const importKey = crypto.createHash('sha256').update(`${sourceFilenameHash}:${JSON.stringify({ codeColumn, orderColumn, statusColumn })}`).digest('hex');
  const { DealMirrorLicence, DealMirrorImport } = models(); if (await DealMirrorImport.exists({ importKey })) return { alreadyImported: true, accepted: 0, rejected: 0, duplicated: rows.length, unmatched: 0 };
  const report = { accepted: 0, rejected: 0, duplicated: 0, unmatched: 0, rows: rows.length };
  const matches = []; const refundedLicenceIds = [];
  for (const row of rows) { const status = String(row[statusColumn] || '').trim().toLowerCase(); if (!['refunded', 'chargeback', 'revoked', 'active', 'paid'].includes(status)) { report.rejected++; continue; }
    let licence = null; if (row[codeColumn]) { try { licence = await DealMirrorLicence.findOne({ codeHash: codeHash(row[codeColumn]) }); } catch (_) { report.rejected++; continue; } } else if (row[orderColumn]) licence = await DealMirrorLicence.findOne({ orderId: String(row[orderColumn]) });
    if (!licence) { report.unmatched++; continue; } if (['refunded', 'chargeback'].includes(status) && ['refunded', 'revoked'].includes(licence.status)) { report.duplicated++; continue; } matches.push({ licence, status, orderId: row[orderColumn] || null }); report.accepted++;
  }
  if (!dryRun) { for (const m of matches) { const isRefund = m.status === 'refunded' || m.status === 'chargeback'; const update = isRefund ? { status: 'refunded', refundedAt: new Date(), revocationReason: m.status } : (m.orderId ? { orderId: m.orderId } : {}); if (Object.keys(update).length) await DealMirrorLicence.updateOne({ _id: m.licence._id }, { $set: update }); if (isRefund) refundedLicenceIds.push(String(m.licence._id)); } await DealMirrorImport.create({ sourceFilenameHash, importKey, columnMapping: { code: codeColumn, orderId: orderColumn, status: statusColumn }, dryRun: false, results: report, administrator: actor }); await audit('csv_imported', actor, { accepted: report.accepted, rejected: report.rejected, duplicated: report.duplicated, unmatched: report.unmatched }); }
  return { ...report, dryRun: Boolean(dryRun), columns: headers, refundedLicenceIds };
}
function genericFailure() { return { ok: false, status: 400, message: 'This code cannot be redeemed. Please check the code and contact support if you need help.' }; }
async function redeem({ code, user, hasAppSumo = false, hasStripe = false, grant, actor = 'user', env = process.env, now = new Date() } = {}) {
  if (!enabled(env) || !validConfig(env) || !user) return genericFailure();
  let hash; try { hash = codeHash(code, env.DEALMIRROR_CODE_PEPPER); } catch (_) { return genericFailure(); }
  const { DealMirrorBatch, DealMirrorLicence } = models();
  if (hasAppSumo || hasStripe || user.dealMirrorRedeemedAt) return { ok: false, status: 409, message: 'This account is not eligible for DealMirror redemption. Please contact support for help.' };
  const active = await DealMirrorLicence.findOne({ userId: user._id, status: 'redeemed' }).lean(); if (active) return { ok: false, status: 409, message: 'This account already has a DealMirror licence.' };
  const licence = await DealMirrorLicence.findOneAndUpdate({ codeHash: hash, status: 'available', redemptionCutoff: { $gte: now } }, { $set: { status: 'redeemed', userId: user._id, emailHash: emailHash(user.email, env.DEALMIRROR_CODE_PEPPER), redeemedAt: now } }, { new: true });
  if (!licence) return genericFailure();
  const batch = await DealMirrorBatch.findById(licence.batchId).lean();
  if (!batch || !['generated', 'exported', 'active', 'exhausted'].includes(batch.status)) { await DealMirrorLicence.updateOne({ _id: licence._id, status: 'redeemed' }, { $set: { status: 'available', userId: null, emailHash: null, redeemedAt: null } }); return genericFailure(); }
  try { await grant(licence); await audit('redeemed', actor, { batchId: licence.batchId, licenceId: licence._id, tier: licence.tier, maskedCodeSuffix: licence.maskedCodeSuffix }); return { ok: true, tier: licence.tier }; }
  catch (error) { await DealMirrorLicence.updateOne({ _id: licence._id, status: 'redeemed', userId: user._id }, { $set: { status: 'available', userId: null, emailHash: null, redeemedAt: null } }); throw error; }
}
module.exports = { TIERS, INITIAL_ALLOCATION, ABSOLUTE_CAP, BATCH_STATUSES, LICENCE_STATUSES, SECOND_BATCH_GATES, config, validConfig, validSecondBatchApproval, normalizeCode, codeHash, maskedSuffix, sameAllocation, models, audit, generateBatch, expireAvailable, parseCsv, reconcileCsv, redeem };
