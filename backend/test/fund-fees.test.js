'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fundFees = require('../fund-fees');

// A prospectus covers every fund in the trust, so the fee table has to be read
// from the contexts carrying THIS share class. Two classes, deliberately
// different figures, plus a restated prior year for the same class.
const PROSPECTUS = `<xbrl>
  <xbrli:context id="Pid_S000006027_Cid_C000100045">
    <xbrli:entity><xbrli:segment>C000100045</xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:endDate>2026-04-30</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="Pid_S000006027_Cid_C000100045_2019">
    <xbrli:entity><xbrli:segment>C000100045</xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:endDate>2019-04-30</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="Pid_S000006027_Cid_C000999999">
    <xbrli:entity><xbrli:segment>C000999999</xbrli:segment></xbrli:entity>
    <xbrli:period><xbrli:endDate>2026-04-30</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <oef:ManagementFeesOverAssets contextRef="Pid_S000006027_Cid_C000100045">0.00015</oef:ManagementFeesOverAssets>
  <oef:ExpensesOverAssets contextRef="Pid_S000006027_Cid_C000100045">0.00015</oef:ExpensesOverAssets>
  <oef:ExpensesOverAssets contextRef="Pid_S000006027_Cid_C000100045_2019">0.00035</oef:ExpensesOverAssets>
  <oef:ExpensesOverAssets contextRef="Pid_S000006027_Cid_C000999999">0.00810</oef:ExpensesOverAssets>
</xbrl>`;

test('the fee table is read from the requested share class, not a sibling fund', () => {
    const fees = fundFees.parseFeeTable(PROSPECTUS, 'C000100045', 'S000006027');
    // FXAIX's real filed figure: 0.00015 = 0.015%, against Yahoo's 0.69%.
    assert.equal(fees.grossExpenseRatio, 0.00015);
    assert.equal(fees.managementFee, 0.00015);
    // The other class in the same prospectus must not leak in.
    assert.notEqual(fees.grossExpenseRatio, 0.0081);
});

test('a restated prior year never displaces the current period', () => {
    const fees = fundFees.parseFeeTable(PROSPECTUS, 'C000100045', 'S000006027');
    assert.equal(fees.grossExpenseRatio, 0.00015);
});

test('an unknown class yields nothing rather than someone else\'s fees', () => {
    assert.equal(fundFees.parseFeeTable(PROSPECTUS, 'C000000000', 'S000000000'), null);
});

test('net of waivers is what an investor pays, when the fund has waivers', () => {
    assert.equal(fundFees.effectiveRatio({ grossExpenseRatio: 0.0074, netExpenseRatio: 0.0071 }), 0.0071);
    assert.equal(fundFees.effectiveRatio({ grossExpenseRatio: 0.0074, netExpenseRatio: null }), 0.0074);
    assert.equal(fundFees.effectiveRatio(null), null);
});

test('an impossible ratio is refused, not published', () => {
    // Ratios are decimal fractions. 1.53 would be a 153%-of-assets fee — the
    // shape of a unit error, and the shape of the bug that pulled the ETF grade.
    assert.equal(fundFees.feeValue('1.53'), null);
    assert.equal(fundFees.feeValue('-0.01'), null);
    assert.equal(fundFees.feeValue('abc'), null);
    assert.equal(fundFees.feeValue('0'), 0);        // FZROX really is free
    assert.equal(fundFees.feeValue('0.00015'), 0.00015);
});

// ---------------------------------------------------------------------------
// Wiring guards
// ---------------------------------------------------------------------------
const profileSource = fs.readFileSync(path.join(__dirname, '..', 'asset-profile.js'), 'utf8');

test('the profile prefers the filed figure and never shows an unverified mutual-fund fee', () => {
    // Yahoo is accurate for ETFs and wrong for roughly half the mutual funds
    // measured, so a mutual fund with no filed table shows nothing at all.
    assert.ok(profileSource.includes("assetType === 'etf' && yahooExpenseRatio !== null"));
    assert.ok(profileSource.includes('const feeLookup = (fundDetails && isFundAsset(assetType))'));
    assert.ok(profileSource.includes('expenseRatioSource: expenseRatio.source'));
});

test('the filed lookup is time-boxed so a cold fund page cannot stall on EDGAR', () => {
    assert.ok(profileSource.includes('const FEE_TIMEOUT_MS = 2500;'));
    assert.ok(profileSource.includes('withTimeout(fundFees.fetchFundFees(key), FEE_TIMEOUT_MS)'));
});

test('a profile built on a timed-out lookup expires in a minute, not half an hour', () => {
    // Otherwise the fallback figure outlives the background fetch that corrects
    // it. A fund that simply has no filed table (SPY, GLD) is not a timeout and
    // keeps the normal TTL, so those do not re-hit Yahoo every minute.
    assert.ok(profileSource.includes('const FEE_RETRY_TTL_MS = 60 * 1000;'));
    assert.ok(profileSource.includes('ttl: feeLookup.timedOut ? FEE_RETRY_TTL_MS : TTL_MS'));
    assert.ok(profileSource.includes('(hit.ttl || TTL_MS)'));
});

test('the page states where the expense ratio came from', () => {
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(appSource.includes("app.get('/api/assets/:symbol/fees'"));
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    assert.ok(page.includes('fund-expense-note'));
    assert.ok(page.includes('As filed'));
    assert.ok(page.includes('No filed figure available'));
});

test('a sub-basis-point fee keeps its precision on both sides of the wire', () => {
    // FXAIX files 0.015%. The default 2-decimal formatting rendered it as
    // "0.01%" on the page and 0.02 in the AI facts — a 33% overstatement of the
    // number people choose index funds on, with every cheap fund collapsing
    // toward the same value.
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    assert.ok(page.includes('function feePct(value)'));
    assert.ok(page.includes("['Expense ratio', feePct(p.expenseRatio), 'fund-expense']"));
    const facts = fs.readFileSync(path.join(__dirname, '..', 'ai-features.js'), 'utf8');
    assert.ok(facts.includes('expenseRatioPct: pct(profile.expenseRatio, 4)'));
});
