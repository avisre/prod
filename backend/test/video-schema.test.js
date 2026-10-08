'use strict';

// Google's Video rich result was FAILING on /tour — not because the page or the
// video was wrong, but because one of the two VideoObject blocks on it had no
// `uploadDate`. Measured with the URL Inspection API on 2026-09-24:
//
//   richResultsResult.verdict = "FAIL"
//   detectedItems: Videos -> "I asked an AI 3 hard finance questions…"
//     issue: Missing field "uploadDate" (severity ERROR)
//
// The other block on the same page was complete, which is exactly why this is
// worth a test rather than a one-line fix: nothing about the page looks broken,
// and the validator only complains about the block that is missing the field.
// Google requires name, thumbnailUrl, uploadDate, and contentUrl or embedUrl on
// a VideoObject; a missing uploadDate fails the item outright.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend-v2');

/** Every JSON-LD object of @type VideoObject in one HTML file. */
function videoObjects(html) {
    const found = [];
    const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const [, body] of blocks) {
        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (err) {
            assert.fail(`unparseable JSON-LD block: ${err.message}`);
        }
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
            const node = queue.shift();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
            const type = node['@type'];
            const types = Array.isArray(type) ? type : [type];
            if (types.includes('VideoObject')) found.push(node);
        }
    }
    return found;
}

const pages = fs.readdirSync(FRONTEND).filter((f) => f.endsWith('.html'));

test('at least one page declares a VideoObject (the scan is not silently empty)', () => {
    const total = pages.reduce((n, f) => n + videoObjects(fs.readFileSync(path.join(FRONTEND, f), 'utf8')).length, 0);
    assert.ok(total > 0, 'the VideoObject scan found nothing — /tour and /monitor-demo both declare one');
});

test('every VideoObject carries the fields Google requires', () => {
    const problems = [];
    for (const file of pages) {
        const html = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
        for (const obj of videoObjects(html)) {
            const label = `${file}: "${String(obj.name || '(unnamed)').slice(0, 60)}"`;
            for (const field of ['name', 'thumbnailUrl', 'uploadDate']) {
                if (!obj[field]) problems.push(`${label} is missing ${field}`);
            }
            if (!obj.contentUrl && !obj.embedUrl) {
                problems.push(`${label} has neither contentUrl nor embedUrl`);
            }
            // A present-but-unparseable date is worse than a missing one: it
            // looks fixed and still fails validation.
            if (obj.uploadDate && Number.isNaN(Date.parse(obj.uploadDate))) {
                problems.push(`${label} has an unparseable uploadDate: ${obj.uploadDate}`);
            }
        }
    }
    assert.deepEqual(problems, [], `VideoObject problems:\n  ${problems.join('\n  ')}`);
});

test('the YouTube video on /features carries the upload date read from YouTube itself', () => {
    // The date is not a guess: it is the `uploadDate` in YouTube's own page
    // metadata for -3V_IaCOQUo, read 2026-09-24. Pinned so a future edit cannot
    // quietly swap it for a placeholder.
    const html = fs.readFileSync(path.join(FRONTEND, 'features.html'), 'utf8');
    const youtube = videoObjects(html).find((o) => String(o.contentUrl || '').includes('-3V_IaCOQUo'));
    assert.ok(youtube, 'the YouTube VideoObject is still on /features (the page was /tour until 2026-10-08)');
    assert.equal(youtube.uploadDate, '2026-06-13T14:31:13-07:00');
});

test('the video sitemap markup carries the fields a video sitemap requires', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'seo-pages.js'), 'utf8');
    const start = source.indexOf('function videoMarkup');
    assert.ok(start > -1, 'videoMarkup exists');
    const body = source.slice(start, source.indexOf('\n}', start));
    const entries = [...body.matchAll(/<video:video>([\s\S]*?)<\/video:video>/g)].map((m) => m[1]);
    assert.ok(entries.length >= 3, `expected at least 3 video sitemap entries, found ${entries.length}`);
    for (const entry of entries) {
        assert.match(entry, /<video:thumbnail_loc>/, 'thumbnail_loc is required');
        assert.match(entry, /<video:title>/, 'title is required');
        assert.match(entry, /<video:description>/, 'description is required');
        assert.ok(/<video:content_loc>|<video:player_loc/.test(entry),
            'content_loc or player_loc is required');
        if (/<video:duration>/.test(entry)) {
            const seconds = Number((entry.match(/<video:duration>(\d+)</) || [])[1]);
            assert.ok(seconds >= 1 && seconds <= 28800, `duration ${seconds}s is outside Google's 1–28800 range`);
        }
    }
});
