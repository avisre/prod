'use strict';

// Structural checks for the arrival card — the moment a holding is saved, which
// the emotional-design plan calls the activation beat.
//
// Same convention as test/profile-consolidation.test.js: app.js is a monolith
// that isn't worth booting a real server for, so these assert against source.
// The rule under test is the plan's honesty non-negotiable — "a celebration
// built on an invented count is worse than no celebration" — which for this
// card means every row must trace to a number the server actually sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const FRONTEND = path.join(__dirname, '../../frontend-v2');
const dashboardSource = fs.readFileSync(path.join(FRONTEND, 'assets/dashboard.js'), 'utf8');
const frontendAppSource = fs.readFileSync(path.join(FRONTEND, 'assets/app.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(FRONTEND, 'dashboard.html'), 'utf8');

const arrivalFn = appSource.slice(
    appSource.indexOf('async function arrivalPayload'),
    appSource.indexOf('app.post(\'/api/portfolio\'')
);

test('the arrival payload is ADDITIVE to the save response, so a cached bundle keeps working', () => {
    // res.json(newStock) became Object.assign(newStock.toObject(), {arrival}).
    // Every field the old response carried has to survive: a browser still on
    // yesterday's dashboard.js reads saved._id and feeds it to holdingToRow().
    assert.match(appSource, /Object\.assign\(newStock\.toObject\(\), arrival \? \{ arrival \} : \{\}\)/,
        'the saved holding must be returned with `arrival` merged in, not replaced by it');
});

test('a failure to build the arrival payload degrades to the old response, never to an error', () => {
    // The holding IS saved by the time the payload is computed. Throwing here
    // would tell the user their save failed when it did not — the exact lie the
    // Phase 0 error copy exists to prevent.
    assert.match(appSource, /const arrival = await arrivalPayload\(req, newStock\)\.catch\(/,
        'arrivalPayload must be caught so a computation failure cannot fail a successful save');
    assert.match(appSource, /return null;\s*\}\);/);
});

test('no row is printed for a number the server did not send', () => {
    // Each block is guarded by the presence of its own field, and nothing is
    // defaulted into existence. This is the whole honesty rule, in one test.
    assert.match(arrivalFn, /if \(days >= 90\) out\.held = \{ since: since\.toISOString\(\), days \};/,
        'held-for is only sent when the purchase date is a real gap, not for a holding added today');
    assert.match(arrivalFn, /if \(hc && Array\.isArray\(hc\.checks\) && hc\.checks\.length\) \{/,
        'risk checks are sent only when the fundamentals actually resolved');
    assert.match(arrivalFn, /if \(!\[\'etf\', \'mutual_fund\', \'crypto\', \'other\'\]\.includes\(at\)\) \{/,
        'the filing-monitor row must exclude funds — the watchdog skips them (watchdog.js scan())');
    assert.doesNotMatch(arrivalFn, /\?\?\s*\d|\|\|\s*4\b|\|\|\s*1\b/,
        'no fallback count may be invented when a real one is missing');
});

test('the monitor row names no form, because the watch set differs by filer type', () => {
    // watchdog.js watches 10-K/10-Q/8-K/20-F/40-F/6-K. Naming a 10-Q for a
    // 20-F filer would be wrong, and the server cannot know which form this
    // symbol files next without a lookup it does not do here.
    assert.match(arrivalFn, /out\.monitor = \{ label: 'every new filing, as it lands' \};/);
    assert.doesNotMatch(arrivalFn, /form: '10-Q'/);
});

test('arrive() draws a row only for a field the caller sent', () => {
    const fn = frontendAppSource.slice(
        frontendAppSource.indexOf('function arrive(a)'),
        frontendAppSource.indexOf('mountCampaign();', frontendAppSource.indexOf('function arrive(a)'))
    );
    assert.match(fn, /if \(a\.monitor && a\.monitor\.label\)/);
    assert.match(fn, /if \(a\.checks && a\.checks\.total\)/);
    assert.doesNotMatch(fn, /checks\s*\|\|\s*\{/, 'a missing checks block must stay missing');
});

test('settle() writes the true value before it animates anything', () => {
    // The animation must never be the only thing that put the number on screen:
    // a killed tab, a thrown error, a stale bundle and reduce-motion all have to
    // leave the honest figure behind.
    const fn = frontendAppSource.slice(
        frontendAppSource.indexOf('function settle(el, to, opts)'),
        frontendAppSource.indexOf('function heldLabel')
    );
    const writeIdx = fn.indexOf('el.textContent = fmt(target);');
    const animIdx = fn.indexOf('requestAnimationFrame(frame)');
    assert.ok(writeIdx !== -1 && animIdx !== -1);
    assert.ok(writeIdx < animIdx, 'the final value must be written before the first animation frame');
    assert.match(fn, /if \(o\.ms === 0 \|\| motionOff\(\)\) return;/,
        'reduce-motion must return with the final value already rendered');
    assert.match(fn, /else el\.textContent = fmt\(target\);/,
        'the last frame must land exactly on the value, not on an eased approximation');
});

test('the motion vocabulary degrades under prefers-reduced-motion', () => {
    assert.match(frontendAppSource, /function motionOff\(\)[\s\S]{0,160}matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
    // The two pre-existing effects that shipped without a guard, fixed with it.
    const systemCss = fs.readFileSync(path.join(FRONTEND, 'assets/system.css'), 'utf8');
    for (const sel of ['.skeleton', '.ai-progress div']) {
        assert.match(systemCss, new RegExp(`@media \\(prefers-reduced-motion: reduce\\) \\{\\s*${sel.replace('.', '\\.')} \\{ animation: none;`),
            `${sel} animates with no reduce-motion guard`);
    }
    assert.match(dashboardHtml, /@media \(prefers-reduced-motion: reduce\) \{ \.arrive-total::before \{ animation: none; \} \}/);
});

test('the arrival card waits for the user instead of timing out', () => {
    // A card that leaves before it is read acknowledges nothing, which is the
    // whole failure the plan is fixing. The success path returns into
    // showArrival() before any setTimeout is reached.
    const fn = dashboardSource.slice(
        dashboardSource.indexOf('function finishPortfolioAction'),
        dashboardSource.indexOf('function showArrival')
    );
    assert.match(fn, /if \(arrival && !error\) return showArrival\(arrival\);/);
    assert.match(dashboardSource, /portfolio-action-done'\)\.onclick/);
    assert.doesNotMatch(dashboardSource.slice(dashboardSource.indexOf('function showArrival')),
        /setTimeout/, 'showArrival must not dismiss itself on a timer');
});

test('the arrival card is never shown for a failed or partial save', () => {
    // The multi-ticker path reports "3 of 5 added" as an error, and the error
    // paths pass no arrival at all — so a partial success cannot claim the
    // portfolio went live.
    const partial = dashboardSource.slice(
        dashboardSource.indexOf("const failed = results.length - addedSymbols.length;"),
        dashboardSource.indexOf('// ---- 🧪 AI Paper Portfolio')
    );
    assert.doesNotMatch(partial, /arrival/,
        'the multi-ticker summary must not pass an arrival payload');
    assert.match(dashboardSource, /arrival: \(saved && saved\.arrival\) \|\| null/,
        'the single-add path must forward the server payload as-is, with no client-side synthesis');
});

test('the new primitives are exported on window.V2 and consumed, not redefined', () => {
    assert.match(frontendAppSource, /upgradeStrip, settle, arrive, heldLabel, motionOff \};/);
    assert.match(dashboardSource, /const \{[^}]*settle, arrive, heldLabel[^}]*\} = window\.V2;/);
    for (const fn of ['settle', 'arrive', 'heldLabel']) {
        assert.doesNotMatch(dashboardSource, new RegExp(`function ${fn}\\(`),
            `${fn} must live in app.js only — two copies of the same formatter will drift`);
    }
    // fy was dropped by an earlier revision of this change and had to be
    // restored; pin it so the next edit to the export list cannot lose it again.
    assert.match(frontendAppSource, /num, money, fixed, fy, pct, esc,/);
});

test('the arrival card and its motion carry the fresh cache stamp', () => {
    // Same immutable-cache trap as every other asset edit: the fix is worthless
    // while browsers run the old bundle for up to a year.
    assert.match(dashboardHtml, /assets\/dashboard\.js\?v=20261010-range1/);
    assert.match(dashboardHtml, /assets\/app\.js\?v=20261010-screens1/);
    assert.match(dashboardHtml, /assets\/system\.css\?v=20261010-screens1/);
});
