// The dossier's revenue-flow chart draws filed money to scale, so a wrong band
// is a wrong number rendered authoritatively. These tests run the REAL shipped
// renderer out of frontend-v2/assets/dossier.js rather than a copy of it: the
// bundle is an IIFE over window.V2, so the function is lifted out by source
// markers and evaluated against stubs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { repairIncome } = require('../income-statement');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'dossier.js'), 'utf8');

function loadSankey() {
    const start = SRC.indexOf('const SEG_RAMP');
    const end = SRC.indexOf('  function miniBars(');
    assert.ok(start > 0 && end > start, 'sankey source markers moved — update this test');
    const body = SRC.slice(start, end);
    const ctx = {
        C: { ink: '#1c1b18', accent: '#1a4fd6', pos: '#1b7a4b', neg: '#b4422f', grey: '#8a877e', faint: '#e7e4dd' },
        esc: (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        bn: (v) => {
            if (v == null) return '—';
            const sign = v < 0 ? '−' : '';
            const a = Math.abs(v);
            return sign + (a >= 1e12 ? '$' + (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? '$' + (a / 1e9).toFixed(1) + 'B' : '$' + (a / 1e6).toFixed(0) + 'M');
        }
    };
    vm.createContext(ctx);
    vm.runInContext(body + '\n;globalThis.__sankey = sankey;', ctx);
    return ctx.__sankey;
}
const sankey = loadSankey();

const ZTS = repairIncome({
    fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD',
    totalRevenue: '9467000000', costOfRevenue: '2666000000', grossProfit: '6801000000',
    researchAndDevelopment: '', sellingGeneralAndAdministrative: '2378000000',
    operatingExpenses: '0', operatingIncome: '', incomeBeforeTax: '3360000000',
    interestExpense: '222000000', incomeTaxExpense: '687000000', netIncome: '2673000000'
});

const ZTS_SEGS = {
    items: [
        { name: 'Parasiticides', revenueUsd: 2680000000 },
        { name: 'Vaccines', revenueUsd: 2000000000 },
        { name: 'Dermatology', revenueUsd: 1530000000 },
        { name: 'Anti-infectives', revenueUsd: 940000000 },
        { name: 'Other pharmaceutical', revenueUsd: 645000000 }
    ]
};

test('the flow renders and every band is reachable by hover', () => {
    const svg = sankey(ZTS, ZTS_SEGS);
    assert.ok(svg.startsWith('<svg'), 'expected an svg');
    assert.ok(!/NaN|Infinity|undefined/.test(svg), 'no non-finite geometry may reach the DOM');
    // Each drawn shape carries its own <title>: that is the hover layer.
    const shapes = (svg.match(/<(rect|path)\b/g) || []).length;
    const titles = (svg.match(/<title>/g) || []).length;
    assert.ok(titles >= shapes - 1, `every band needs a title (${titles} titles for ${shapes} shapes)`);
});

test('colour is never the only channel — every band is directly labelled', () => {
    // The kept/spent pair sits at deltaE 6.1 under deuteranopia, which is only
    // legal with a second channel. If these labels ever disappear, the chart
    // stops being readable for red-green colourblind users.
    const svg = sankey(ZTS, ZTS_SEGS);
    for (const label of ['Revenue', 'Gross profit', 'Cost of sales', 'Pre-tax income', 'Net income', 'Tax']) {
        assert.ok(svg.includes(label), `missing direct label: ${label}`);
    }
});

test('ZTS: no operating-income band, because the filing does not support one', () => {
    // R&D is absent and operatingExpenses is a literal "0", so the honest chain
    // is revenue -> gross profit -> pre-tax -> net, with one combined cost band.
    const svg = sankey(ZTS, ZTS_SEGS);
    assert.ok(!svg.includes('Operating income'), 'must not invent an operating income');
    assert.ok(svg.includes('Operating &amp; other costs'), 'expected the exact combined cost band');
});

test('band heights are proportional to the filed figures', () => {
    const svg = sankey(ZTS, null);
    // Revenue is the full plot height (300); gross profit is 6801/9467 of it.
    const heights = [...svg.matchAll(/<rect[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    const revH = Math.max(...heights);
    assert.ok(Math.abs(revH - 300) < 0.6, `revenue band should span the plot, got ${revH}`);
    const expectedGp = (6801 / 9467) * 300;
    assert.ok(heights.some((x) => Math.abs(x - expectedGp) < 0.6), `expected a gross-profit band near ${expectedGp.toFixed(1)}`);
});

test('a bank draws a shorter flow rather than a broken one', () => {
    const jpm = repairIncome({
        fiscalDateEnding: '2025-12-31', totalRevenue: '182447000000',
        incomeBeforeTax: '72595000000', incomeTaxExpense: '15547000000', netIncome: '57048000000'
    });
    const svg = sankey(jpm, null);
    assert.ok(svg.startsWith('<svg'));
    assert.ok(!svg.includes('Gross profit'), 'JPM files no gross profit');
    assert.ok(svg.includes('Costs &amp; expenses'), 'the revenue-to-pretax gap still has an exact label');
    assert.ok(svg.includes('Net income'));
});

test('unallocated revenue is shown, not silently rescaled away', () => {
    // Segments covering only part of revenue must not be stretched to fill it.
    const svg = sankey(ZTS, { items: [{ name: 'Parasiticides', revenueUsd: 2680000000 }] });
    assert.ok(svg.includes('Unallocated'), 'the uncovered remainder needs its own band');
});

test('segments that do not reconcile are dropped rather than drawn wrong', () => {
    // Units left unrepaired would overflow revenue; drawing them would produce
    // bands wider than the whole.
    const svg = sankey(ZTS, { items: [{ name: 'Bogus', revenueUsd: 9467000000000 }] });
    assert.ok(!svg.includes('Bogus'), 'a segment larger than revenue must not be drawn');
});

test('a loss year does not draw a negative band', () => {
    const loss = repairIncome({
        fiscalDateEnding: '2025-12-31', totalRevenue: '1000000000',
        costOfRevenue: '700000000', grossProfit: '300000000',
        incomeBeforeTax: '-50000000', netIncome: '-40000000'
    });
    const svg = sankey(loss, null);
    assert.ok(!/height="-/.test(svg), 'no negative geometry');
    assert.ok(!svg.includes('Net income'), 'a negative net income is not a share of revenue');
});

test('the last cost band is only called tax when it IS tax', () => {
    // XOM files zero-strings for COGS, opex, pre-tax and tax alike, so the only
    // gap available runs straight from revenue to net income — $303bn of it.
    // Labelling that "tax" would misstate the entire cost base.
    const xom = repairIncome({
        fiscalDateEnding: '2025-12-31', totalRevenue: '332238000000',
        costOfRevenue: '0', grossProfit: '0', operatingExpenses: '0',
        incomeBeforeTax: '0', incomeTaxExpense: '0', netIncome: '28844000000'
    });
    const svg = sankey(xom, null);
    assert.ok(svg.includes('All costs &amp; tax'), 'a revenue-to-net gap is the whole cost base');
    assert.ok(!/>Tax</.test(svg), 'must not present the full cost base as tax');

    // Where the chain does reach pre-tax income, the same band IS tax.
    assert.ok(sankey(ZTS, null).includes('Tax'));
});

test('no revenue means no chart at all', () => {
    assert.equal(sankey(null, null), '');
    assert.equal(sankey({ revenue: 0 }, null), '');
    assert.equal(sankey({ revenue: null }, null), '');
});
