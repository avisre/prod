'use strict';

// public-api.md is the one pricing surface with no test, and it drifted:
// until 2026-09-22 it still advertised mcp_ask 2 / api_ask 4 credits, months
// after credits.js repriced them to 4 / 8. The AppSumo listing did NOT drift
// over the same period, because credit-meter-truth.test.js reads it. The
// difference was the test, not the discipline — so this closes the asymmetry.
//
// It asserts the published table against credits.COST, not against literals:
// a future reprice updates one place and this test tells you the doc is stale.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const credits = require('../credits');

const DOC = fs.readFileSync(path.join(__dirname, '..', 'public-api.md'), 'utf8');

// "| label | N credit(s) | M credit(s) |" -> [N, M]
function pricingRow(label) {
    const line = DOC.split('\n').find((l) => l.includes(label) && l.trim().startsWith('|'));
    assert.ok(line, `public-api.md has no pricing row containing "${label}"`);
    const nums = line.split('|').slice(2).map((cell) => {
        const m = cell.match(/(\d+)\s*credits?/i);
        return m ? Number(m[1]) : null;
    }).filter((n) => n !== null);
    assert.equal(nums.length, 2, `expected an MCP and a REST figure in: ${line.trim()}`);
    return nums;
}

test('the published lookup price matches credits.COST', () => {
    const [mcp, rest] = pricingRow('Deterministic lookup');
    assert.equal(mcp, credits.COST.mcp_lookup, 'public-api.md MCP lookup price is stale');
    assert.equal(rest, credits.COST.api_lookup, 'public-api.md REST lookup price is stale');
});

test('the published ask price matches credits.COST', () => {
    const [mcp, rest] = pricingRow('AI-backed ask');
    assert.equal(mcp, credits.COST.mcp_ask, 'public-api.md MCP ask price is stale');
    assert.equal(rest, credits.COST.api_ask, 'public-api.md REST ask price is stale');
});

test('lookups keep the 2x tier split; the AI ask is identical on both surfaces', () => {
    // The "REST ask = 2x MCP ask" rule was retired 2026-09-22 — both metered
    // surfaces run the identical call and now share one anchor. The LOOKUP
    // split survives, so assert the half that is still true and pin the half
    // that changed, rather than deleting the coverage.
    assert.equal(credits.COST.api_lookup, 2 * credits.COST.mcp_lookup);
    assert.equal(credits.COST.api_ask, credits.COST.mcp_ask);
});

test('the anchor prose cites tokens PER ACTION, not per model call', () => {
    // Both older figures were per-COMPLETION. One ask is an agentic loop of
    // 5.6 calls, so the honest basis is 58,239 tokens per action. Quoting
    // either 10,779 (all-purpose blend) or 13,820 (single chat completion)
    // understates it by 4-5x, which is what mispriced the anchor twice.
    assert.match(DOC, /58,239 tokens/, 'public-api.md should cite the measured per-ACTION token count');
    assert.doesNotMatch(DOC, /~10,779 tokens/, 'the blended per-call average is not a valid ask basis');
    assert.doesNotMatch(DOC, /13,820 tokens/, 'the single-completion average is not a valid ask basis');
});

test('the REST endpoint table matches credits.COST too', () => {
    // This table drifted independently of the pricing table above and was
    // wrong on every row until 2026-09-22, because nothing read it.
    const row = (needle) => {
        const line = DOC.split('\n').find((l) => l.includes(needle) && l.trim().startsWith('|'));
        assert.ok(line, `no endpoint row for ${needle}`);
        const cost = line.split('|')[2].trim();
        return Number(cost);
    };
    for (const ep of ['/api/v1/financials/', '/api/v1/filing/', '/api/v1/compare', '/api/v1/screen', '/api/v1/fund/']) {
        assert.equal(row(ep), credits.COST.api_lookup, `${ep} cost is stale`);
    }
    assert.equal(row('/api/v1/ask'), credits.COST.api_ask, '/api/v1/ask cost is stale');
});

test('the credit price quoted is the real one', () => {
    // $14.99 / 150 = $0.09993, not the rounded $0.10 the doc used to imply.
    assert.match(DOC, /\$0\.09993|\$14\.99 ?\/ ?150/, 'public-api.md should quote the actual credit price');
});
