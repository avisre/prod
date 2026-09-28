'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const botBlocker = require('../bot-blocker');

const FRONTEND_V2 = path.join(__dirname, '..', '..', 'frontend-v2');
const PING_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'indexnow-ping.js');

// IndexNow key files are 32 lowercase hex characters at the site root.
const KEY_FILE_RE = /^([0-9a-f]{32})\.txt$/;

function hostedKeys() {
    return fs.readdirSync(FRONTEND_V2)
        .filter((f) => KEY_FILE_RE.test(f))
        .map((f) => ({ file: f, key: f.match(KEY_FILE_RE)[1] }));
}

test('the key indexnow-ping.js submits with is actually hosted', () => {
    const src = fs.readFileSync(PING_SCRIPT, 'utf8');
    const match = src.match(/const\s+KEY\s*=\s*'([0-9a-f]{32})'/);
    assert.ok(match, 'indexnow-ping.js must declare a 32-hex KEY constant');
    const key = match[1];

    const hosted = hostedKeys().map((k) => k.key);
    assert.ok(hosted.includes(key),
        `indexnow-ping.js submits as ${key} but no ${key}.txt is hosted in frontend-v2/, ` +
        `so IndexNow cannot verify the submissions. Hosted: ${hosted.join(', ') || '(none)'}`);
});

test('every hosted IndexNow key file is served to a non-browser client', () => {
    // The regression this guards: the key path was absent from
    // EXEMPT_PATH_PATTERNS, so /<key>.txt returned 403 to any UA that did not
    // send a full browser header set. IndexNow fetches the key file
    // asynchronously AFTER accepting the POST, and indexnow-ping.js treats HTTP
    // 200/202 on the POST as success -- so the whole pipeline reported success
    // while verification silently failed.
    const keys = hostedKeys();
    assert.ok(keys.length > 0, 'at least one IndexNow key file must be hosted in frontend-v2/');

    for (const { file, key } of keys) {
        assert.equal(botBlocker.isExemptPath(`/${file}`), true,
            `/${file} must be exempt from the bot blocker: IndexNow fetches it without browser headers`);
        assert.equal(botBlocker.isStaticAssetPath(`/${file}`), true,
            `/${file} should also be recognised as a static asset`);
        assert.ok(key, 'key must parse');
    }
});

test('the key file body is exactly the key, with no surrounding whitespace', () => {
    // A trailing newline makes the body 33 bytes for a 32-char key. Verifiers
    // that compare exactly would reject it, and a rejected key file fails the
    // same silent way. Cheap to guarantee here.
    for (const { file, key } of hostedKeys()) {
        const body = fs.readFileSync(path.join(FRONTEND_V2, file), 'utf8');
        assert.equal(body, key,
            `${file} must contain exactly its key and nothing else ` +
            `(got ${JSON.stringify(body)})`);
    }
});

test('the exemption is narrow: it does not open arbitrary .txt paths', () => {
    // The pattern is anchored to 32 hex chars, so a generic .txt URL stays
    // subject to the normal rules -- the exemption must not become a bypass.
    for (const p of ['/notes.txt', '/secret.txt', '/e449a1013681cad5f57dfb04d321918f.txt.bak',
                     '/sub/e449a1013681cad5f57dfb04d321918f.txt', '/robots.txt.bak']) {
        assert.equal(botBlocker.isExemptPath(p), false,
            `${p} must NOT be exempt -- only a root-level 32-hex .txt key file is`);
    }
});
