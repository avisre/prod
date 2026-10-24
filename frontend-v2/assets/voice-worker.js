// Voice input for Ask: speech to text with an open-source model (Whisper),
// run in the visitor's own browser. The recording never leaves the device and
// there is no per-use cost; the price is a one-time model download, which the
// browser then keeps.
//
// Why here and not on our server (measured 2026-10-10): the same model needs
// 1.1 to 3.7 GB of memory per clip in our server process, and our AI provider
// accepts no audio at all. In the browser the base model got company names,
// tickers, "10-K" and "P/E" right on the spoken test questions.
//
// A module worker, so recognition never blocks the page. The library and its
// WebAssembly runtime load from the two pinned CDN paths the page's
// Content-Security-Policy allows (backend/app.js) — bump all three together.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

const MODEL = 'Xenova/whisper-base';
let recognizer = null;

self.onmessage = async (event) => {
    const { id, audio, language } = event.data || {};
    try {
        if (!recognizer) {
            const seen = new Map();
            recognizer = await pipeline('automatic-speech-recognition', MODEL, {
                dtype: 'q8',
                device: 'wasm',
                progress_callback: (p) => {
                    if (!p || p.status !== 'progress' || !p.file || !p.total) return;
                    seen.set(p.file, [p.loaded || 0, p.total]);
                    let loaded = 0; let total = 0;
                    for (const [l, t] of seen.values()) { loaded += l; total += t; }
                    self.postMessage({ id, progress: total ? Math.min(99, Math.round((loaded / total) * 100)) : 0 });
                }
            });
        }
        // The library does not detect the spoken language: given none, it
        // decodes as English, which garbles other languages (a Polish clip:
        // "z późnego paleolitu" came back "zpuśnego paleolitu", "BP" as "B4").
        // The page sends the browser's language instead; one the
        // model does not know is rejected before any decoding, so retry with
        // the library default.
        const options = { task: 'transcribe', chunk_length_s: 30 };
        let out;
        try { out = await recognizer(audio, language ? { ...options, language } : options); }
        catch (err) {
            if (!language || !/Language ".*" is not supported/.test(String(err && err.message))) throw err;
            out = await recognizer(audio, options);
        }
        self.postMessage({ id, text: String((out && out.text) || '').replace(/\s+/g, ' ').trim() });
    } catch (err) {
        recognizer = null;
        self.postMessage({ id, error: true });
    }
};
