'use strict';

// Spoken questions for Ask: a short recording in, text out.
//
// Which model, and why it is not one we already had (measured 2026-10-10):
//   - Our AI provider hosts 18 models; none reports an audio capability, and a
//     real clip sent to the image-reading model was rejected ("expected image
//     mime type, got audio/wave").
//   - Open-source Whisper run in this process needs 1.1 GB (tiny) to 3.7 GB
//     (small) of memory for one clip, far beyond this server, and all three
//     sizes misheard finance terms on the test clips (P/E, 10-K, AVGO, NextEra).
//   - The audio-capable Gemma sizes are documented for local use only.
// So transcription goes to a hosted speech model over the OpenAI-compatible
// /audio/transcriptions interface, which several providers implement:
//   STT_API_KEY   required; without it the feature is off and the button hidden
//   STT_BASE_URL  default https://api.openai.com/v1
//   STT_MODEL     default gpt-4o-mini-transcribe
//
// The audio is passed through and never stored or logged. The provider is
// never named to users: every failure becomes one generic message.

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SECONDS = 60;
const MAX_TEXT = 2000;
// Recognition is biased toward the vocabulary Ask is actually asked about.
const HINT = 'A question about US-listed companies and their SEC filings. Tickers such as NVDA, AAPL, MSFT, GOOGL, AVGO, AMD. Terms such as 10-K, 10-Q, 8-K, EBITDA, P/E, free cash flow, gross margin, EPS.';
const EXT_BY_TYPE = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a' };

function config(env = process.env) {
    return {
        key: String(env.STT_API_KEY || '').trim(),
        baseUrl: String(env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        model: String(env.STT_MODEL || 'gpt-4o-mini-transcribe').trim()
    };
}

function enabled(env = process.env) { return !!config(env).key; }

// "audio/webm;codecs=opus" -> "audio/webm"; anything that is not a known audio type -> null.
function baseType(mimeType) {
    const t = String(mimeType || '').split(';')[0].trim().toLowerCase();
    return EXT_BY_TYPE[t] ? t : null;
}

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

/**
 * Transcribes one recording. Throws an Error with a `code` the route maps to a
 * status: DISABLED, BAD_AUDIO, TOO_LARGE, NO_SPEECH, UNAVAILABLE.
 */
async function transcribe(buffer, mimeType, { env = process.env, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    const cfg = config(env);
    if (!cfg.key) throw fail('DISABLED', 'Voice input is not available.');
    const type = baseType(mimeType);
    if (!type || !Buffer.isBuffer(buffer) || buffer.length < 200) throw fail('BAD_AUDIO', 'That recording could not be read. Try again.');
    if (buffer.length > MAX_BYTES) throw fail('TOO_LARGE', `Recordings are limited to ${MAX_SECONDS} seconds.`);

    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), `question.${EXT_BY_TYPE[type]}`);
    form.append('model', cfg.model);
    form.append('prompt', HINT);
    form.append('response_format', 'json');

    let res;
    try {
        res = await fetchImpl(`${cfg.baseUrl}/audio/transcriptions`, {
            method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form, signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (_) { throw fail('UNAVAILABLE', 'Voice input is not working right now. Type your question instead.'); }
    if (!res.ok) {
        // Status only: a provider's error body can name the provider or echo the key's owner.
        try { console.error('[speech-to-text] upstream status', res.status); } catch (_) { /* ignore */ }
        throw fail('UNAVAILABLE', 'Voice input is not working right now. Type your question instead.');
    }
    let text = '';
    try { text = String((await res.json()).text || ''); } catch (_) { throw fail('UNAVAILABLE', 'Voice input is not working right now. Type your question instead.'); }
    text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) throw fail('NO_SPEECH', 'No speech was heard. Try again a little closer to the microphone.');
    return text;
}

module.exports = { MAX_BYTES, MAX_SECONDS, HINT, config, enabled, baseType, transcribe };
