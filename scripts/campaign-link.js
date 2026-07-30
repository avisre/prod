#!/usr/bin/env node
'use strict';

const shareCopy = require('../backend/share-copy');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function buildCampaignLink({ source, contentId, clickId, pathname }) {
    const safeSource = shareCopy.normalizeAppSumoSource(source);
    const safeContentId = shareCopy.normalizeAcquisitionContentId(contentId);
    const safeClickId = shareCopy.normalizeAcquisitionClickId(clickId);
    const safePath = String(pathname || '');
    if (!safeSource || !['x', 'linkedin', 'reddit', 'creator', 'newsletter', 'email'].includes(safeSource)) {
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
    return url.toString();
}

if (require.main === module) {
    try {
        console.log(buildCampaignLink({
            source: arg('source'),
            contentId: arg('content-id'),
            clickId: arg('click-id'),
            pathname: arg('path')
        }));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { buildCampaignLink };
