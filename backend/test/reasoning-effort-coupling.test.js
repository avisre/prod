// The reasoning effort a model needs is a property of THAT MODEL, and getting
// it wrong fails silently. This test exists because the pairing used to live in
// two independent env vars, which made the documented rollout unsafe.
//
// Measured on Ollama Cloud, 2026-09-21, on the filing-diff prompt:
//   glm-5.1 + 'none'  -> clean JSON               (retired 2026-09-25;
//                        cfg() now migrates that config to the glm-5.3 fallback)
//   glm-5.3 + 'none'  -> reasons in the VISIBLE channel, overruns max_tokens,
//                        finish_reason 'length', NO JSON AT ALL (0/10 filings)
//   glm-5.3 + default -> reasons in the hidden channel, overruns it, content ''
//   glm-5.3 + 'low'   -> clean JSON in 925 completion tokens
//
// The 5.3+'none' cell is the dangerous one: ~20 extractors fall back to their
// templates and nothing raises an error, so it would be found by a user, not by
// a log. Setting AI_MODEL_SUMMARY on its own must therefore never produce it.
const test = require('node:test');
const assert = require('node:assert');

const ai = require('../ai-client');

// Capture the request body ai-client actually sends, rather than inspecting an
// internal helper: what matters is the bytes on the wire.
async function sentBody(env, opts) {
    const saved = {};
    for (const k of ['AI_MODEL_SUMMARY', 'AI_MODEL_CHAT', 'AI_MODEL_BRIEFING', 'AI_SUMMARY_REASONING_EFFORT', 'AI_CHAT_REASONING_EFFORT', 'OLLAMA_API_KEY', 'AI_BRIEFING_BASE_URL']) {
        saved[k] = process.env[k];
        if (k in env) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
        else delete process.env[k];
    }
    process.env.OLLAMA_API_KEY = 'test-key';
    const realFetch = global.fetch;
    let captured = null;
    global.fetch = async (_url, init) => {
        captured = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }), text: async () => '' };
    };
    try {
        await ai.chatRaw([{ role: 'user', content: 'hi' }], opts);
    } finally {
        global.fetch = realFetch;
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return captured;
}

test('a retired glm-5.1 config migrates and carries the new model\'s effort', async () => {
    // Production no longer sends glm-5.1 at all: the direct-service model was
    // retired on 2026-09-25, so cfg() rewrites that one retired value to the
    // fallback, and the effort follows the RESOLVED model. An old config can
    // therefore never resurrect the dangerous 5.3+'none' pair by accident.
    const summary = await sentBody({ AI_MODEL_SUMMARY: 'glm-5.1' }, { purpose: 'summary' });
    assert.equal(summary.model, 'glm-5.3');
    assert.equal(summary.reasoning_effort, 'low', 'migration must not drag along 5.1\'s none');

    const chat = await sentBody({ AI_MODEL_CHAT: 'glm-5.1' }, { purpose: 'chat' });
    assert.equal(chat.model, 'glm-5.3');
    assert.equal(chat.reasoning_effort, 'low');
});

test('flipping the model alone carries its own effort — the silent-failure case', async () => {
    // AI_SUMMARY_REASONING_EFFORT deliberately NOT set: this is the single env
    // PUT the rollout plan describes, and it must not produce 5.3 + 'none'.
    for (const model of ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']) {
        const body = await sentBody({ AI_MODEL_SUMMARY: model }, { purpose: 'summary' });
        assert.equal(body.model, model);
        assert.equal(body.reasoning_effort, 'low', `${model} summary resolved to ${body.reasoning_effort}, which emits no JSON`);
        assert.notEqual(body.reasoning_effort, 'none');
    }
});

test('the same protection covers chat, where the failure is an empty answer', async () => {
    const body = await sentBody({ AI_MODEL_CHAT: 'glm-5.3' }, { purpose: 'chat' });
    assert.equal(body.reasoning_effort, 'low', 'glm-5.3 chat must not run at provider default');
});

test('an explicitly set env var still wins, so a rejecting provider is a config flip', async () => {
    const body = await sentBody({ AI_MODEL_SUMMARY: 'glm-5.3', AI_SUMMARY_REASONING_EFFORT: 'medium' }, { purpose: 'summary' });
    assert.equal(body.reasoning_effort, 'medium');

    // Empty string omits the field entirely — prod.env.example documents this.
    const omitted = await sentBody({ AI_MODEL_SUMMARY: 'glm-5.3', AI_SUMMARY_REASONING_EFFORT: '' }, { purpose: 'summary' });
    assert.equal(omitted.reasoning_effort, undefined);
});

test('the harness override still beats everything, for A/B runs', async () => {
    const body = await sentBody({ AI_MODEL_SUMMARY: 'glm-5.1' }, { purpose: 'summary', reasoningEffort: 'low' });
    assert.equal(body.reasoning_effort, 'low');
});

test('a per-call model override is what decides, not the configured default', async () => {
    // dossier/monitor paths pass an explicit model; the effort must follow it.
    const body = await sentBody({ AI_MODEL_SUMMARY: 'glm-5.1' }, { purpose: 'summary', model: 'glm-5.3' });
    assert.equal(body.model, 'glm-5.3');
    assert.equal(body.reasoning_effort, 'low');
});
