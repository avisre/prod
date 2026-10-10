'use strict';

// Voice input for Ask (owner request 2026-10-10): a short recording goes to a
// hosted speech model and comes back as text. Off without a key, never stored,
// and no failure may name the provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stt = require('../speech-to-text');

const ENV = { STT_API_KEY: 'test-key' };
const audio = Buffer.alloc(4000, 7);
const ok = (text) => async () => ({ ok: true, status: 200, json: async () => ({ text }) });

test('it is off without a key, and the defaults are the cheapest tested model', () => {
    assert.equal(stt.enabled({}), false);
    assert.equal(stt.enabled({ STT_API_KEY: '  ' }), false);
    assert.equal(stt.enabled(ENV), true);
    assert.deepEqual(stt.config(ENV), { key: 'test-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe' });
    assert.equal(stt.config({ STT_API_KEY: 'k', STT_BASE_URL: 'https://x.example/v1///', STT_MODEL: 'other' }).baseUrl, 'https://x.example/v1');
});

test('a recording is sent once, with the finance hint, and the text comes back tidied', async () => {
    const calls = [];
    const text = await stt.transcribe(audio, 'audio/webm;codecs=opus', {
        env: ENV,
        fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ text: '  Compare gross margin for\nNVDA and AMD.  ' }) }; }
    });
    assert.equal(text, 'Compare gross margin for NVDA and AMD.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
    const form = calls[0].init.body;
    assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
    assert.match(form.get('prompt'), /10-K/);
    assert.equal(form.get('file').type, 'audio/webm');
    assert.equal(form.get('file').name, 'question.webm');
    assert.equal(form.get('file').size, audio.length);
});

test('bad input is refused before anything is sent', async () => {
    let sent = 0;
    const fetchImpl = async () => { sent += 1; return { ok: true, json: async () => ({ text: 'x' }) }; };
    await assert.rejects(() => stt.transcribe(audio, 'audio/webm', { env: {}, fetchImpl }), { code: 'DISABLED' });
    for (const type of ['text/plain', 'application/json', '', undefined, 'video/mp4']) {
        await assert.rejects(() => stt.transcribe(audio, type, { env: ENV, fetchImpl }), { code: 'BAD_AUDIO' });
    }
    await assert.rejects(() => stt.transcribe(Buffer.alloc(50), 'audio/webm', { env: ENV, fetchImpl }), { code: 'BAD_AUDIO' });
    await assert.rejects(() => stt.transcribe('not a buffer', 'audio/webm', { env: ENV, fetchImpl }), { code: 'BAD_AUDIO' });
    await assert.rejects(() => stt.transcribe(Buffer.alloc(stt.MAX_BYTES + 1), 'audio/webm', { env: ENV, fetchImpl }), { code: 'TOO_LARGE' });
    assert.equal(sent, 0);
});

test('silence and provider failures become plain messages that name nobody', async () => {
    await assert.rejects(() => stt.transcribe(audio, 'audio/mp4', { env: ENV, fetchImpl: ok('   ') }), { code: 'NO_SPEECH' });
    const failures = [
        async () => { throw new Error('getaddrinfo ENOTFOUND api.openai.com'); },
        async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided: sk-abc. You can find your key at platform.openai.com' } }) }),
        async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })
    ];
    for (const fetchImpl of failures) {
        const err = await stt.transcribe(audio, 'audio/webm', { env: ENV, fetchImpl }).catch((e) => e);
        assert.equal(err.code, 'UNAVAILABLE');
        assert.doesNotMatch(err.message, /openai|sk-|api key|gpt|whisper|ENOTFOUND/i);
    }
    // A very long transcript is capped rather than passed through whole.
    assert.equal((await stt.transcribe(audio, 'audio/wav', { env: ENV, fetchImpl: ok('w '.repeat(5000)) })).length <= 2000, true);
});

test('the route is signed-in only, rate-limited, size-capped, and the page never auto-sends', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(app, /app\.post\('\/api\/ai\/transcribe', authMiddleware, transcribeRateLimit,\s*express\.raw\(\{ type: \['audio\/\*', 'application\/octet-stream'\], limit: speechToText\.MAX_BYTES \}\)/);
    assert.ok(app.includes("app.get('/api/ai/transcribe/status'"));
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'ask.html'), 'utf8');
    const voice = page.slice(page.indexOf('(function voiceInput()'), page.indexOf('})();', page.indexOf('(function voiceInput()')));
    assert.ok(voice.length > 500, 'voice input block not found');
    assert.doesNotMatch(voice, /submit\(\)|requestSubmit/, 'a transcript must never be sent without the user pressing send');
    assert.match(page, /id="mic-btn"[^>]*hidden/, 'the microphone starts hidden until the server says voice is on');
});

test('voice is parked: with nothing switched on, the button stays hidden and the security policy is untouched', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(app, /const VOICE_LOCAL_MODEL = String\(process\.env\.VOICE_LOCAL_MODEL \|\| ''\)\.toLowerCase\(\) === 'true';/);
    assert.match(app, /const VOICE_LOCAL_SCRIPT_SRC = VOICE_LOCAL_MODEL \? \[[\s\S]{0,400}\] : \[\];/, 'the extra script sources exist only when the local model is on');
    assert.match(app, /\.\.\.\(VOICE_LOCAL_MODEL \? \{ workerSrc: /);
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'ask.html'), 'utf8');
    assert.match(page, /canLocal = !!\(d && d\.local\) && browserCan;/);
    assert.match(page, /const reveal = \(\) => \{ if \(useServer \|\| canLocal\) mic\.hidden = false; \};/);
    // A feature that is off is not described to customers as if it were on.
    const privacy = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'privacy.html'), 'utf8');
    assert.doesNotMatch(privacy, /voice input/i);
});

test('the in-browser speech model loads only from the versions the security policy allows', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const worker = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'voice-worker.js'), 'utf8');
    const lib = worker.match(/from '(https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^/]+\/)dist\/transformers\.min\.js'/);
    assert.ok(lib, 'the worker imports the pinned library build');
    assert.ok(app.includes(`'${lib[1]}'`), 'script-src allows exactly the library version the worker imports');
    assert.match(app, /'https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/']+\/'/, 'and one pinned runtime version');
    assert.ok(app.includes(`"'wasm-unsafe-eval'"`) && !/'unsafe-eval'/.test(app.replace(/wasm-unsafe-eval/g, '')), 'WebAssembly is allowed; eval is not');
    assert.match(app, /workerSrc: \["'self'", 'blob:'\]/);
    assert.match(app, /res\.json\(\{ enabled: speechToText\.enabled\(\), local: VOICE_LOCAL_MODEL, maxSeconds/);
    // The recording stays on the device: the worker posts text back and calls nothing of ours.
    assert.doesNotMatch(worker, /fetch\(|XMLHttpRequest|\/api\//);
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'ask.html'), 'utf8');
    assert.match(page, /useServer \? await viaServer\(blob, type\) : await viaBrowser\(await samples\(blob\)\)/);
});
