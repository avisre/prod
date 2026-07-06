// AppSumo redemption stats — rerunnable health/monitoring pass.
// Usage: node appsumo_stats.js   (reads backend/prod.env for MONGODB_URI)
const path = require('path');
const BACKEND = '/home/hardoker77/Downloads/new/prod-main/backend';
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const cols = (await db.listCollections().toArray()).map((c) => c.name);
  const lic = cols.find((c) => /appsumo/i.test(c));
  console.log('collections matching appsumo:', cols.filter((c) => /appsumo/i.test(c)).join(', ') || 'none');

  if (lic) {
    const L = db.collection(lic);
    const total = await L.countDocuments();
    const redeemed = await L.countDocuments({ redeemedAt: { $ne: null } });
    console.log(`licenses: ${total} total, ${redeemed} redeemed`);
    const recent = await L.find().sort({ _id: -1 }).limit(5).toArray();
    recent.forEach((r) => console.log('  lic:', JSON.stringify({ key: (r.licenseKey || r.license_key || '').slice(0, 10) + '…', tier: r.tier, status: r.status, redeemedAt: r.redeemedAt, created: r.createdAt })));
  }

  const users = db.collection('users');
  const sumoUsers = await users.countDocuments({ appsumoLicenseKey: { $ne: null } });
  console.log('users with appsumoLicenseKey:', sumoUsers);
  if (sumoUsers) {
    const rs = await users.find({ appsumoLicenseKey: { $ne: null } }).project({ email: 1, appsumoTier: 1, appsumoAiCap: 1, appsumoRedeemedAt: 1 }).sort({ appsumoRedeemedAt: -1 }).limit(5).toArray();
    rs.forEach((u) => console.log('  user:', u.email, 'tier', u.appsumoTier, 'cap', u.appsumoAiCap, 'at', u.appsumoRedeemedAt));
  }
  await mongoose.disconnect();
  console.log('OK');
})().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
