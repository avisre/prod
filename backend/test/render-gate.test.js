'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createGate } = require('../render-gate');

test('no more than max renders run at once; waiters go in arrival order', async () => {
    const gate = createGate({ max: 2, queueMax: 10, waitMs: 5000 });
    const a = await gate.acquire(), b = await gate.acquire();
    assert.equal(gate.busy(), true);
    const order = [];
    const c = gate.acquire().then((r) => { order.push('c'); return r; });
    const d = gate.acquire().then((r) => { order.push('d'); return r; });
    assert.deepEqual(gate.stats(), { active: 2, waiting: 2, queued: 2, shed: 0, timedOut: 0 });
    a();
    const rc = await c;
    assert.deepEqual(order, ['c']);
    assert.equal(gate.stats().active, 2, 'the slot passed straight to the waiter');
    // A newcomer arriving now must queue behind d, not take a slot.
    const e = gate.acquire();
    b();
    const rd = await d;
    assert.deepEqual(order, ['c', 'd']);
    rc(); const re = await e; rd(); re();
    assert.deepEqual(gate.stats(), { active: 0, waiting: 0, queued: 3, shed: 0, timedOut: 0 });
});

test('a full queue refuses at once, and a wait that runs out gives up its place', async () => {
    const gate = createGate({ max: 1, queueMax: 1, waitMs: 30 });
    const a = await gate.acquire();
    const waiting = gate.acquire();
    assert.equal(await gate.acquire(), null, 'queue full: refused without waiting');
    assert.equal(await waiting, null, 'gave up after waitMs');
    assert.deepEqual(gate.stats(), { active: 1, waiting: 0, queued: 1, shed: 1, timedOut: 1 });
    a();
    assert.equal(gate.stats().active, 0, 'a timed-out waiter does not swallow the released slot');
    const again = await gate.acquire();
    assert.equal(typeof again, 'function');
    again();
});

test('releasing twice frees one slot only', async () => {
    const gate = createGate({ max: 1 });
    const a = await gate.acquire();
    a(); a();
    assert.equal(gate.stats().active, 0);
    const b = await gate.acquire();
    assert.equal(gate.busy(), true);
    b();
});

test('/stocks/:ticker renders only inside the gate and always releases it', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const route = app.slice(app.indexOf("app.get('/stocks/:ticker'"), app.indexOf("app.get('/vs/:competitor'"));
    assert.match(app, /createGate\(\{ max: 2, queueMax: 40, waitMs: 20000 \}\)/);
    const acquire = route.indexOf('await stockRenderGate.acquire()');
    assert.ok(acquire > route.indexOf("set('X-Page-Cache', 'hit')"), 'a cached page never waits for a slot');
    assert.ok(route.indexOf("set('X-Page-Cache', 'stale')") < acquire, 'a stale copy is served instead of waiting');
    for (const work of ['quoteStore.getQuote(', 'getCompanyEvidence(', 'seoPages.renderStockPage(']) {
        assert.ok(route.indexOf(work) > acquire, `${work} runs inside the gate`);
    }
    assert.match(route, /if \(!release\) return sendStockPageBusy\(res\);/);
    assert.match(route, /\} finally \{\s*release\(\);\s*\}\s*\}\);\s*$/);
    assert.match(app, /'Retry-After': '5'/);
});
