'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const extra = require('../seo-extra');
const shareCopy = require('../share-copy');

const root = path.join(__dirname, '..', '..');
const dataDir = path.join(root, 'seo-data');

test('SEO reports and eligibility manifest are generated from observed exports', () => {
    for (const name of [
        'gsc-position-analysis.md', 'high-ranking-low-ctr-review.md',
        'comparison-quality-analysis.md', 'revenue-quality-analysis.md',
        'activation-family-selection.md', 'seo-activation-pilot.md',
        'ranking-change-baseline.csv', 'activation-eligibility.json'
    ]) assert.ok(fs.existsSync(path.join(dataDir, name)), `${name} exists`);
    const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'activation-eligibility.json'), 'utf8'));
    assert.equal(manifest.featureFlag, 'SEO_ACTIVATION_PILOT');
    assert.ok(['COMPARISON', 'REVENUE_HISTORY'].includes(manifest.selectedSecondFamily));
    assert.ok(Array.isArray(manifest.eligiblePages));
    const opportunities = fs.readFileSync(path.join(dataDir, 'seo-opportunities.csv'), 'utf8');
    assert.match(opportunities, /evidence_type/);
    assert.match(opportunities, /HYPOTHESIZED/);
    assert.match(opportunities, /DO_NOT_BUILD/);
    assert.match(fs.readFileSync(path.join(dataDir, 'seo-activation-pilot.md'), 'utf8'), /SEO_ACTIVATION_PILOT=false/);
});

test('pilot is dark by default and ignores a URL source parameter', () => {
    const original = process.env.SEO_ACTIVATION_PILOT;
    delete process.env.SEO_ACTIVATION_PILOT;
    assert.equal(extra.pilotEnabled(), false);
    const html = extra.renderMetricPage('GOOGL', 'net-income', { req: { headers: { referer: 'https://www.google.com/search?q=net+income' } } });
    assert.doesNotMatch(html, /data-seo-action/);
    if (original === undefined) delete process.env.SEO_ACTIVATION_PILOT;
    else process.env.SEO_ACTIVATION_PILOT = original;
});

test('organic gating accepts a previously verified search acquisition cookie', () => {
    const original = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'seo-test-secret';
    const cookie = shareCopy.createAcquisitionCookieValue('google', {
        secret: process.env.JWT_SECRET, clickId: 'seo-click-1234', contentId: 'seo-eps-next-action'
    });
    assert.equal(extra.organicRequest({ headers: { cookie: `sp_as_acq=${cookie}` } }), true);
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
});

test('eligible organic pages receive one structured answer-first action', () => {
    const original = process.env.SEO_ACTIVATION_PILOT;
    process.env.SEO_ACTIVATION_PILOT = 'true';
    const organic = { headers: { referer: 'https://www.google.com/search?q=alphabet+net+income' } };
    const html = extra.renderMetricPage('GOOGL', 'net-income', { req: organic });
    assert.match(html, /data-seo-action="next-research"/);
    assert.match(html, /data-content-id="seo-eps-next-action"/);
    assert.match(html, /href="\/ask\?symbol=GOOGL&amp;metric=net-income&amp;content_id=seo-eps-next-action"/);
    assert.match(html, /<h1[\s\S]*?<\/h1>[\s\S]*?Latest filed value[\s\S]*?SEC EDGAR[\s\S]*?Next research step/);
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.stockportfolio\.pro\/stocks\/GOOGL\/net-income"/);
    assert.doesNotMatch(html, /Explain these earnings changes[^<]{0,200}prompt/i);
    const direct = extra.renderMetricPage('GOOGL', 'net-income', { req: { headers: {} } });
    assert.doesNotMatch(direct, /data-seo-action/);
    if (original === undefined) delete process.env.SEO_ACTIVATION_PILOT;
    else process.env.SEO_ACTIVATION_PILOT = original;
});

test('SEO content IDs are allowlisted and event metadata stays page-context only', () => {
    assert.equal(shareCopy.normalizeAcquisitionContentId('seo-eps-next-action'), 'seo-eps-next-action');
    assert.equal(shareCopy.normalizeAcquisitionContentId('seo-revenue-next-action'), 'seo-revenue-next-action');
    assert.equal(shareCopy.normalizeAcquisitionContentId('seo-next-action-prompt'), null);
    const app = fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
    assert.match(app, /seo_next_action_click/);
    assert.match(app, /SEO_CONTENT_IDS/);
    assert.match(app, /google', 'bing', 'duckduckgo/);
    assert.match(client, /trackSeoEvent/);
    assert.match(client, new RegExp('/api/track/seo_event'));
    assert.doesNotMatch(client, /question:.*trackSeoEvent|answer:.*trackSeoEvent/);
});
