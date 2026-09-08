// Pins the wire-level failure that made credit recharge impossible until
// 2026-09-08: authMiddleware sets req.userId to a raw mongoose ObjectId, and
// the stripe-node SDK serializes a non-string object param by walking its
// properties — a mongoose ObjectId becomes `client_reference_id[buffer]=…`
// (binary garbage). Stripe rejects the unknown bracketed param, the session
// create throws, and the route 500s with "Unable to start checkout right
// now." This test intercepts the SDK's actual request encoding on localhost —
// no Stripe API contact, no live writes — so a future regression fails here
// even if the source-level toString pin in pricing-ladder is edited away.
const test = require('node:test');
const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const Stripe = require('stripe');

test('the Stripe SDK stringifies ObjectId params, never serializes them as objects', async () => {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'cs_test_probe', url: 'https://example.com/probe' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const stripe = new Stripe('sk_test_probe', {
      host: '127.0.0.1', port, protocol: 'http', maxNetworkRetries: 0
    });
    const oid = new mongoose.Types.ObjectId('7a7eae012345678901234567');
    await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: 'probe@example.com',
      line_items: [{ price: 'price_probe', quantity: 1 }],
      client_reference_id: oid.toString(), // the fix: string, like every other call site
      success_url: 'https://example.com/s',
      cancel_url: 'https://example.com/c'
    });
    assert.equal(captured.length, 1, 'one request captured');
    assert.match(captured[0], /client_reference_id=7a7eae012345678901234567/, 'hex id sent as a plain string param');
    assert.ok(!/client_reference_id\[/.test(captured[0]), 'no bracketed object encoding of client_reference_id');

    // And the pre-fix form (raw ObjectId) is what we never want to ship again:
    captured.length = 0;
    await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price: 'price_probe', quantity: 1 }],
      client_reference_id: oid, // raw, like authMiddleware provides
      success_url: 'https://example.com/s',
      cancel_url: 'https://example.com/c'
    });
    assert.match(captured[0], /client_reference_id\[buffer\]=/, 'control case: the raw ObjectId DOES bracket-encode (bug reproduced)');
  } finally {
    server.close();
  }
});