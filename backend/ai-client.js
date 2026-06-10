// Shared, provider-agnostic LLM client (OpenAI-compatible chat completions).
// Works with OpenRouter, Moonshot/Kimi, Ollama Cloud, etc. via env config.
// Used by ai-briefing.js and ai-features.js.

// Read env lazily (at call time) so it works regardless of whether dotenv has
// loaded yet at require-time, and regardless of env source (Render vs .env).
function cfg() {
    return {
        key: process.env.AI_BRIEFING_API_KEY || '',
        baseUrl: (process.env.AI_BRIEFING_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
        model: process.env.AI_BRIEFING_MODEL || 'moonshotai/kimi-k2.6'
    };
}
function isConfigured() { return !!(process.env.AI_BRIEFING_API_KEY || ''); }

// Throws if not configured or the call fails — callers decide how to fall back.
async function chat(messages, { temperature = 0.4, maxTokens = 320 } = {}) {
    const { key, baseUrl, model } = cfg();
    if (!key) throw new Error('AI not configured');
    const AI_MODEL = model;
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        },
        // Reasoning models (e.g. Kimi K2.6) emit chain-of-thought into a
        // separate `reasoning` field and the clean answer into `content` — but
        // both count against max_tokens, so we give a generous floor to ensure
        // the final answer isn't truncated. Non-reasoning models stop early and
        // aren't affected by the higher cap.
        body: JSON.stringify({ model: AI_MODEL, messages, temperature, max_tokens: Math.max(maxTokens, 3000) })
    });
    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`AI provider ${resp.status}: ${t.slice(0, 160)}`);
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message || {};
    // Use the clean answer (content). Deliberately ignore `reasoning` so the
    // model's internal thinking never leaks to the user.
    const text = msg.content && msg.content.trim();
    if (!text) throw new Error('AI provider returned no content');
    // Backstop: never let the underlying model/provider be revealed (trade
    // secret). If the output names a model/provider or self-identifies as an
    // AI system, treat it as a leak so the caller returns a safe message.
    if (leaksIdentity(text)) {
        const err = new Error('AI_IDENTITY_BLOCKED');
        err.code = 'AI_IDENTITY_BLOCKED';
        throw err;
    }
    return text;
}

// Hard identifiers that should never appear in a finance answer; their
// presence means the model is talking about itself / its provider.
const IDENTITY_PATTERNS = [
    /deepseek/i, /\bkimi\b/i, /moonshot/i, /\bollama\b/i, /openrouter/i,
    /\bqwen\b/i, /gpt-?oss/i, /chatgpt/i, /\bopenai\b/i, /anthropic/i,
    /\bclaude\b/i, /\bllama\b/i, /minimax/i, /nemotron/i, /\bcogito\b/i,
    /\bk2\.\d/i, /large language model/i, /\blanguage model\b/i,
    /\bi am an? (ai|a\.i\.|artificial)/i, /\bi'?m an? (ai|a\.i\.|artificial)/i,
    /\bas an? (ai|a\.i\.|language model)/i, /trained by/i, /\bi was trained\b/i,
    /\bmy training data\b/i, /powered by (a|an|the)?\s*\w+\s*(model|llm)/i,
    /\bunderlying model\b/i, /\bsystem prompt\b/i
];
function leaksIdentity(text) {
    return IDENTITY_PATTERNS.some((re) => re.test(text));
}

module.exports = { chat, isConfigured, leaksIdentity };
Object.defineProperty(module.exports, 'AI_CONFIGURED', { get: isConfigured });
