'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { paidSignupConversion } = require('../checkout-conversions');
const { pixelConfig, pixelHeadSnippet } = require('../pixels');

const session = { id: 'cs_live_example123', mode: 'subscription', livemode: true,
    payment_status: 'paid', amount_total: 7999, currency: 'usd', metadata: { pendingSignupId: 'pending1' } };
const receipt = paidSignupConversion(session, { accountCreated: true, userId: 'new-user' });

test('verified Stripe amount and opaque stable IDs; existing accounts have no signup event', () => {
    assert.equal(receipt.value, 79.99); assert.equal(receipt.currency, 'USD');
    assert.match(receipt.transactionId, /^checkout_[a-f0-9]{32}$/);
    assert.match(receipt.signupId, /^signup_[a-f0-9]{32}$/);
    assert.deepEqual(receipt, paidSignupConversion(session, { accountCreated: true, userId: 'new-user' }));
    assert.ok(!JSON.stringify(receipt).includes(session.id));
    assert.ok(!JSON.stringify(receipt).includes('new-user'));
    assert.equal(paidSignupConversion(session).signupId, null);
});
test('unpaid, test, free, malformed and non-subscription checkouts cannot count', () => {
    for (const patch of [{ payment_status: 'unpaid' }, { livemode: false }, { id: 'cs_test_example' },
        { mode: 'payment' }, { amount_total: 0 }, { amount_total: -1 }, { amount_total: NaN },
        { amount_total: 2.5 }, { currency: '' }, { metadata: {} }]) {
        assert.equal(paidSignupConversion({ ...session, ...patch }), null);
    }
    assert.equal(paidSignupConversion(session, { internal: true }), null);
});

const appSource = fs.readFileSync(path.join(__dirname, '../../frontend-v2/assets/app.js'), 'utf8');
const trackerSource = appSource.split('// ---------- verified checkout conversions ----------')[1]
    .split('// ---------- first-party page-view ping')[0];
function storage() {
    const map = new Map();
    return { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v) };
}
function browser({ consent = 'granted', host = 'www.stockportfolio.pro', saved, config, callback = true } = {}) {
    const events = []; const local = storage(); local.setItem('sp_analytics_consent_v1', consent);
    let loads = 0;
    const context = { window: {}, sessionStorage: saved || storage(), localStorage: local,
        location: { hostname: host }, Date, Promise,
        setTimeout: (fn, ms) => setTimeout(fn, ms === 1000 ? 50 : 10), clearTimeout,
        loadPixels: () => { loads++; return config || Promise.resolve({ googleAdsId: 'AW-test', subscribeLabel: 'paid', signupLabel: 'signup' }); }
    };
    context.window.gtag = (type, name, params) => { events.push({ type, name, params }); if (callback) params.event_callback(); };
    vm.createContext(context); vm.runInContext(trackerSource, context);
    return { context, events, loads: () => loads, track: context.window.spTrackPaidSignup,
        flush: () => vm.runInContext('flushPaidSignupConversions()', context) };
}

test('one paid checkout emits purchase and zero-value signup once, even after reload', async () => {
    const b = browser(); await b.track(receipt);
    assert.equal(b.events.length, 2);
    const paid = b.events.find(e => e.params.send_to === 'AW-test/paid').params;
    assert.equal(paid.value, 79.99); assert.equal(paid.currency, 'USD');
    assert.equal(paid.transaction_id, receipt.transactionId);
    assert.equal(b.events.find(e => e.params.send_to === 'AW-test/signup').params.value, 0);
    await b.track(receipt); assert.equal(b.events.length, 2);
    const next = browser({ saved: b.context.sessionStorage }); await next.track(receipt);
    assert.equal(next.events.length, 0);
});
test('consent denial and non-production hosts never load tags; unknown consent resumes after redirect/opt-in', async () => {
    for (const opts of [{ consent: 'denied' }, { host: 'localhost' }, { host: 'evilstockportfolio.pro' }]) {
        const b = browser(opts); await b.track(receipt); assert.equal(b.events.length, 0); assert.equal(b.loads(), 0);
    }
    const first = browser({ consent: '' }); await first.track(receipt); assert.equal(first.events.length, 0);
    const next = browser({ saved: first.context.sessionStorage }); await next.flush(); assert.equal(next.events.length, 2);
});
test('delayed config is awaited; malformed receipts and success URL parameters do not count', async () => {
    let ready; const b = browser({ config: new Promise(resolve => { ready = resolve; }) });
    await b.track(null); await b.track({ session: 'success', value: 79.99 }); assert.equal(b.loads(), 0);
    const wait = b.track(receipt); assert.equal(b.events.length, 0);
    ready({ googleAdsId: 'AW-test', subscribeLabel: 'paid', signupLabel: 'signup' });
    await wait; assert.equal(b.events.length, 2);
});
test('blocked tag permits sign-in and retries with identical transaction IDs', async () => {
    const b = browser({ callback: false }); await b.track(receipt); assert.equal(b.events.length, 2);
    const next = browser({ saved: b.context.sessionStorage }); await next.flush();
    assert.deepEqual(next.events.map(e => e.params.transaction_id), b.events.map(e => e.params.transaction_id));
});
test('existing accounts emit no signup, and expired receipts are dropped', async () => {
    const b = browser(); await b.track({ ...receipt, signupId: null }); assert.equal(b.events.length, 1);
    const saved = storage(); saved.setItem('sp_paid_conversions_v1', JSON.stringify({ pending: [{ ...receipt, expiresAt: 0 }], sent: [] }));
    const next = browser({ saved }); await next.flush(); assert.equal(next.events.length, 0);
});
test('checkout return paths await the verified receipt and login fallback cannot emit a purchase', () => {
    const register = fs.readFileSync(path.join(__dirname, '../../frontend-v2/register.html'), 'utf8');
    const social = fs.readFileSync(path.join(__dirname, '../../frontend-v2/assets/social.js'), 'utf8');
    for (const s of [register, social]) assert.match(s, /await window\.spTrackPaidSignup\(data\.conversion\)/);
    assert.doesNotMatch(register, /spTrack\('subscribe'/);
});
test('real claim handler gates receipts on Stripe payment and a successful account claim', async () => {
    const server = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const route = server.split("app.post('/api/checkout/claim', checkoutClaimLimiter, async (req, res) => {")[1].split('\n});')[0];
    for (const state of ['paid', 'unpaid', 'claimed', 'missing-user', 'test']) {
        let result; const pending = { claimedAt: state === 'claimed' ? new Date() : null };
        const user = state === 'missing-user' ? null : { _id: 'new-user', subscription: {} };
        const context = { req: { body: { sessionId: session.id } },
            res: { status(code) { this.code = code; return this; }, json(data) { result = { code: this.code, data }; } },
            stripe: { checkout: { sessions: { retrieve: async () => ({ ...session, payment_status: state === 'unpaid' ? 'unpaid' : 'paid', livemode: state !== 'test' }) } } },
            PendingSignup: { findById: () => ({ catch: async () => pending, select: () => ({ lean: () => Promise.resolve({ createdAccount: true }) }) }), updateOne: () => Promise.resolve() },
            materializePendingSignup: async () => user, createUserToken: () => 'test-token', normalizeSubscription: x => x,
            paidSignupConversion, isDatabaseUnavailableError: () => false, console, Date };
        await vm.runInNewContext('(async () => {' + route + '})()', context);
        if (state === 'paid') { assert.equal(result.code, 200); assert.deepEqual(result.data.conversion, receipt); }
        else if (state === 'test') { assert.equal(result.code, 200); assert.equal(result.data.conversion, null); }
        else { assert.notEqual(result.code, 200); assert.equal(result.data.conversion, undefined); }
    }
});
test('SSR tag requires explicit consent and exact production hostname; env can disable Ads', () => {
    const key = 'GOOGLE_ADS_ID'; const previous = process.env[key]; delete process.env[key];
    try {
        assert.match(pixelConfig().googleAdsId, /^AW-\d+$/);
        const snippet = pixelHeadSnippet().replace(/^<script>/, '').replace(/<\/script>$/, '');
        for (const consent of ['', 'denied']) {
            const context = { localStorage: { getItem: () => consent }, location: { hostname: 'www.stockportfolio.pro' } };
            vm.runInNewContext(snippet, context); assert.equal(context.window, undefined);
        }
        process.env[key] = ''; assert.equal(pixelConfig().googleAdsId, ''); assert.equal(pixelHeadSnippet(), '');
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});
