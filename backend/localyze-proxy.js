// ============================================================================
// LOCALYZE PROXY — ISOLATED ADD-ON  (★ safe to remove, see below ★)
// ----------------------------------------------------------------------------
// Hosts the model backend for the **Localyze.ai Android app** on this already-
// deployed Render service. It is a thin, OpenAI-compatible passthrough that
// REUSES the same Ollama Cloud credentials the rest of the backend already has
// (AI_BRIEFING_BASE_URL + AI_BRIEFING_API_KEY). It does NOT import, touch, or
// depend on any existing app logic, models, auth, schemas, or routes.
//
// ┌─ TO REMOVE COMPLETELY (zero side-effects on the rest of the app) ─────────┐
// │ 1. delete this file:  backend/localyze-proxy.js                           │
// │ 2. delete the ONE line in app.js marked  // [LOCALYZE-PROXY]              │
// │ Nothing else references it. The stock app is unaffected either way.       │
// └───────────────────────────────────────────────────────────────────────────┘
//
// Endpoints (namespaced under /api/localyze so they cannot collide):
//   GET  /api/localyze/health
//   POST /api/localyze/v1/chat/completions   (OpenAI-compatible; SSE or JSON)
//
// Abuse-resistance: forces the model (LOCALYZE_MODEL, default gpt-oss:120b-cloud)
// so the shared key can't be used for arbitrary/expensive models; caps
// max_tokens; per-IP rate limit; OPTIONAL shared-secret gate
// (LOCALYZE_PROXY_SECRET — when unset the route is open but logs a warning).
// ============================================================================
const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const UPSTREAM = (process.env.AI_BRIEFING_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '');
const KEY = process.env.AI_BRIEFING_API_KEY || '';
const MODEL = process.env.LOCALYZE_MODEL || 'gpt-oss:120b-cloud';
const SECRET = process.env.LOCALYZE_PROXY_SECRET || '';
const MAX_TOKENS = Number(process.env.LOCALYZE_MAX_TOKENS || 4096);

if (!SECRET) {
    // eslint-disable-next-line no-console
    console.warn('[LOCALYZE-PROXY] LOCALYZE_PROXY_SECRET is unset — /api/localyze is OPEN. ' +
        'Set it on Render and ship it in the app to gate access.');
}

const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

// Optional shared-secret gate. When SECRET is configured, require a matching
// X-Localyze-Key header; otherwise allow (already warned at startup).
function gate(req, res, next) {
    if (SECRET) {
        const given = req.get('X-Localyze-Key') || '';
        if (given !== SECRET) return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

router.get('/api/localyze/health', (req, res) => {
    res.json({
        ok: true,
        service: 'localyze-proxy',
        model: MODEL,
        upstreamConfigured: !!KEY,
        gated: !!SECRET
    });
});

router.post('/api/localyze/v1/chat/completions',
    express.json({ limit: '1mb' }),
    limiter,
    gate,
    async (req, res) => {
        if (!KEY) return res.status(503).json({ error: 'cloud model not configured' });
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const stream = body.stream === true;

        // Force the model + cap tokens so the shared key can't be abused.
        const upstreamBody = {
            ...body,
            model: MODEL,
            max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS)
        };

        const ctrl = new AbortController();
        req.on('close', () => ctrl.abort());

        let upstream;
        try {
            upstream = await fetch(`${UPSTREAM}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
                body: JSON.stringify(upstreamBody),
                signal: ctrl.signal
            });
        } catch (e) {
            return res.status(502).json({ error: 'upstream unreachable', detail: String(e && e.message || e) });
        }

        if (!upstream.ok) {
            const t = await upstream.text().catch(() => '');
            return res.status(upstream.status).json({ error: 'upstream error', detail: t.slice(0, 300) });
        }

        // Non-streaming: hand the JSON straight back.
        if (!stream) {
            const data = await upstream.text();
            res.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
            return res.send(data);
        }

        // Streaming: pipe the upstream SSE through unchanged (the Localyze app
        // already parses OpenAI-format `data:` chunks).
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(decoder.decode(value, { stream: true }));
            }
        } catch (_) {
            // client disconnect or upstream abort — nothing to do
        } finally {
            res.end();
        }
    });

module.exports = { router };
