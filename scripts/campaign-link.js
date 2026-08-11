#!/usr/bin/env node
'use strict';

const shareCopy = require('../backend/share-copy');

function arg(name, fallback = '') {
    const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function campaignMedium(source) {
    return ['x', 'linkedin', 'reddit', 'hackernews'].includes(source) ? 'social' : source === 'email' ? 'email' : source === 'creator' ? 'referral' : 'content';
}

function buildCampaignId({ source, date, kind = 'post', sequence = '01' } = {}) {
    const safeDate = String(date || '').replace(/[^0-9-]/g, '').replace(/-/g, '').slice(0, 8);
    const safeKind = String(kind || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
    const safeSequence = String(sequence || '01').replace(/[^0-9]/g, '').padStart(2, '0').slice(-2);
    const safeSource = shareCopy.normalizeAppSumoSource(source);
    if (!safeSource || !/^\d{8}$/.test(safeDate) || !safeKind) throw new Error('source, date=YYYY-MM-DD and kind are required');
    return `${safeSource}-${safeDate}-${safeKind}-${safeSequence}`;
}

function buildCampaignLink({ source, contentId, clickId, pathname, campaign, term }) {
    const safeSource = shareCopy.normalizeAppSumoSource(source);
    const safeContentId = shareCopy.normalizeAcquisitionContentId(contentId);
    const safeClickId = shareCopy.normalizeAcquisitionClickId(clickId);
    const safePath = String(pathname || '');
    if (!safeSource || !['x', 'linkedin', 'reddit', 'hackernews', 'creator', 'newsletter', 'email'].includes(safeSource)) {
        throw new Error('source must be an approved campaign channel');
    }
    if (!safeContentId) throw new Error('content-id is not allowlisted');
    if (!safeClickId) throw new Error('click-id must be 8-32 URL-safe characters');
    if (!/^\/(?:tools\/[a-z0-9-]+|research\/[a-z0-9-]+|appsumo)$/.test(safePath)) {
        throw new Error('path must be an approved tool, research page, or /appsumo');
    }
    const url = new URL(safePath, 'https://www.stockportfolio.pro');
    url.searchParams.set('source', safeSource);
    url.searchParams.set('content_id', safeContentId);
    url.searchParams.set('click_id', safeClickId);
    url.searchParams.set('utm_source', safeSource);
    url.searchParams.set('utm_medium', campaignMedium(safeSource));
    url.searchParams.set('utm_campaign', String(campaign || safeContentId).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120));
    url.searchParams.set('utm_content', safeContentId);
    if (term && /^[A-Za-z0-9._-]{1,80}$/.test(String(term))) url.searchParams.set('utm_term', String(term));
    return url.toString();
}

if (require.main === module) {
    try {
        const source = arg('source');
        const campaign = arg('campaign', '');
        const campaignId = campaign || (arg('date') ? buildCampaignId({ source, date: arg('date'), kind: arg('kind', 'post'), sequence: arg('sequence', '01') }) : '');
        console.log(buildCampaignLink({
            source,
            contentId: arg('content-id'),
            clickId: arg('click-id'),
            pathname: arg('path'),
            campaign: campaignId,
            term: arg('term')
        }));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { buildCampaignLink, buildCampaignId, campaignMedium };
