'use strict';

// Pins the headline-vs-filing money formatter.
//
// Why this file exists: three copies of the same formatter (verify.html, the
// ledger in app.js, and the public verify pages in seo-pages.js) all chose their
// decimal from `abs` — the whole dollar amount — instead of from the scaled
// value. `abs >= 100` is true for every real financial figure, so the decimal
// branch was dead code and every number printed as a whole unit at its scale:
// a $15.5 billion filing rendered as "$16 billion", and $1.5 billion as
// "$2 billion". On a page whose entire claim is that the FILED number is the
// reliable one, that is the wrong number in the accusation — and it could print
// the same string on both sides of a mismatch the verdict called wrong.
//
// The three copies must also agree with each other: the public SEO page and the
// in-app ledger show the same comparison, and a user moving between them should
// not see two different figures for one filing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '../../frontend-v2');
const sources = {
    'verify.html': fs.readFileSync(path.join(FRONTEND, 'verify.html'), 'utf8'),
    'app.js': fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'),
    'seo-pages.js': fs.readFileSync(path.join(__dirname, '..', 'seo-pages.js'), 'utf8')
};

// Lifted verbatim out of verify.html and evaluated, so this asserts real
// behaviour rather than the shape of the source text.
function loadMoney(source, name) {
    const start = source.indexOf('const one = (v) =>');
    assert.ok(start !== -1, `${name}: could not find the scaled-value formatter`);
    const body = source.slice(start, source.indexOf('\n', start));
    const expr = body.trim().replace(/^const one = /, '').replace(/;\s*$/, '');
    // eslint-disable-next-line no-new-func -- reading our own already-loaded source, not user input
    const one = new Function('v', `return (${expr})(v);`);
    const abs = (n) => Math.abs(n);
    return (n) => {
        if (n == null) return '—';
        const a = abs(n);
        if (a >= 1e12) return '$' + one(n / 1e12) + ' trillion';
        if (a >= 1e9) return '$' + one(n / 1e9) + ' billion';
        if (a >= 1e6) return '$' + one(n / 1e6) + ' million';
        if (a >= 1e3) return '$' + one(n / 1e3) + ' thousand';
        return '$' + one(n);
    };
}

test('a sub-100 figure keeps its decimal at every scale', () => {
    // These are the cases the old formatter got wrong. Each one is the filed
    // figure on a page that judges someone else's headline against it.
    const money = loadMoney(sources['verify.html'], 'verify.html');
    assert.equal(money(15.5e9), '$15.5 billion', 'a $15.5B filing must not print as $16 billion');
    assert.equal(money(1.5e9), '$1.5 billion', 'a $1.5B filing must not print as $2 billion');
    assert.equal(money(15.5e6), '$15.5 million');
    assert.equal(money(1.5e6), '$1.5 million');
    assert.equal(money(1.5e3), '$1.5 thousand');
    assert.equal(money(1.5), '$1.5');
});

test('whole figures stay whole and the scale word is right', () => {
    const money = loadMoney(sources['verify.html'], 'verify.html');
    assert.equal(money(155e9), '$155 billion');
    assert.equal(money(383.3e9), '$383.3 billion');
    assert.equal(money(1.842e12), '$1.8 trillion');
    assert.equal(money(2e12), '$2 trillion');
    assert.equal(money(0), '$0');
    assert.equal(money(null), '—');
});

test('the two sides of a mismatch can no longer render as the same string', () => {
    // The concrete failure mode: a headline quoting $16B against a filed
    // $15.5B. Under the old formatter both printed "$16 billion" while the
    // verdict read FLAGGED — the page contradicting itself in the one place
    // it must not.
    const money = loadMoney(sources['verify.html'], 'verify.html');
    assert.notEqual(money(16e9), money(15.5e9));
});

test('all three copies pick the decimal from the scaled value, not the raw amount', () => {
    // seo-pages.js carries the formatter inside a template literal, where the
    // regex is written \\.0$ — so it cannot be evaluated as source and is
    // pinned structurally instead, on the exact expression that was wrong.
    const fixed = 'const one = (v) => { const x = v.toFixed(Math.abs(v) >= 1000 ? 0 : 1);';
    for (const [name, src] of Object.entries(sources)) {
        const line = name === 'seo-pages.js' ? fixed.replace('\\', '\\\\') : fixed;
        assert.ok(src.includes(line), `${name} still chooses its decimal from the raw amount`);
        assert.doesNotMatch(src, /v\.toFixed\(abs >= 100 \? 0 : 1\)/,
            `${name} still carries the dead-code condition`);
    }
});

test('the in-app ledger and the public pages agree on the same figure', () => {
    const app = loadMoney(sources['app.js'], 'app.js');
    const verify = loadMoney(sources['verify.html'], 'verify.html');
    for (const v of [15.5e9, 1.5e9, 155e9, 383.3e9, 1.842e12, 15.5e6, 1.5e3, 1.5]) {
        assert.equal(app(v), verify(v), `the ledger and verify.html disagree at ${v}`);
    }
});
