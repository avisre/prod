// Admin refund tool for direct LTD purchases (#9, channel 'direct-ltd').
//
// Checks the purchase date against the DIRECT_LTD_REFUND_DAYS window before
// allowing anything, issues the Stripe refund, and revokes the ltdChannel
// grant so the user drops back out of Pro. Does NOT touch AppSumo-channel
// purchases — those go through AppSumo's own 60-day refund process, not this
// script, and this script refuses to act on them.
//
// Usage: node scripts/refund-direct-ltd.js --user <userId> [--force] [--dry-run]
//   --force    refund even if the DIRECT_LTD_REFUND_DAYS window has closed
//   --dry-run  print what would happen; make no Stripe call or DB write
const path = require('path');
const BACKEND = path.join(__dirname, '../backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });

const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));
const Stripe = require(path.join(BACKEND, 'node_modules/stripe'));
const directLtd = require(path.join(BACKEND, 'direct-ltd'));

function parseArgs(argv) {
  const out = { force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') out.userId = argv[++i];
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

(async () => {
  const { userId, force, dryRun } = parseArgs(process.argv.slice(2));
  if (!userId) {
    console.error('Usage: node scripts/refund-direct-ltd.js --user <userId> [--force] [--dry-run]');
    process.exit(1);
  }
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const licenses = db.collection('appsumolicenses');

  const user = await users.findOne({ _id: new mongoose.Types.ObjectId(userId) });
  if (!user) throw new Error(`No user found for id ${userId}`);

  if (user.ltdChannel !== directLtd.CHANNEL) {
    throw new Error(
      `User ${userId} has ltdChannel="${user.ltdChannel || 'none'}", not "${directLtd.CHANNEL}". ` +
      `This script only refunds direct purchases; AppSumo-channel purchases go through AppSumo's own refund process.`
    );
  }
  if (!user.directLtdStripeSessionId) {
    throw new Error(`User ${userId} has no directLtdStripeSessionId — cannot locate the Stripe payment to refund.`);
  }

  const purchaseDate = user.appsumoRedeemedAt;
  if (!purchaseDate) throw new Error(`User ${userId} has no appsumoRedeemedAt (purchase date) recorded.`);

  const days = directLtd.refundDays();
  const ageDays = (Date.now() - new Date(purchaseDate).getTime()) / 86400000;
  const withinWindow = ageDays <= days;
  console.log(`Purchase date: ${new Date(purchaseDate).toISOString()} (${ageDays.toFixed(1)} days ago). Refund window: ${days} days. Within window: ${withinWindow}.`);

  if (!withinWindow && !force) {
    throw new Error(`Refund window closed (${ageDays.toFixed(1)} > ${days} days). Re-run with --force to override.`);
  }

  const session = await stripe.checkout.sessions.retrieve(user.directLtdStripeSessionId);
  if (!session.payment_intent) throw new Error(`Stripe session ${user.directLtdStripeSessionId} has no payment_intent; nothing to refund.`);

  console.log(`Will refund payment_intent ${session.payment_intent} ($${user.directLtdPaidUsd ?? '?'}) and revoke the lifetime grant for ${user.email}.`);
  if (dryRun) {
    console.log('--dry-run: no Stripe call made, no DB write made.');
    await mongoose.disconnect();
    return;
  }

  const refund = await stripe.refunds.create({
    payment_intent: session.payment_intent,
    reason: 'requested_by_customer',
    metadata: { userId: String(user._id), type: 'direct_ltd_refund' }
  });
  console.log(`Stripe refund created: ${refund.id} (status ${refund.status}).`);

  await licenses.updateMany(
    { userId: user._id, 'raw.channel': directLtd.CHANNEL },
    { $set: { status: 'refunded', lastEvent: 'direct_refund', lastEventAt: new Date() } }
  );
  await users.updateOne(
    { _id: user._id },
    {
      $set: {
        'subscription.status': 'cancelled',
        'subscription.trialEndsAt': null,
        appsumoAiCap: null
      }
    }
  );
  console.log(`Grant revoked for ${user.email}. Done.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error('refund-direct-ltd failed:', e && e.message ? e.message : e);
  process.exit(1);
});
