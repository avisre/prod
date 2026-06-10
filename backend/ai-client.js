// Shared, provider-agnostic LLM client (OpenAI-compatible chat completions).
// Works with OpenRouter, Moonshot/Kimi, Ollama Cloud, etc. via env config.
// Used by ai-briefing.js and ai-features.js.

const AI_API_KEY = process.env.AI_BRIEFING_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BRIEFING_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_BRIEFING_MODEL || 'moonshotai/kimi-k2.6';

const AI_CONFIGURED = !!AI_API_KEY;

// Throws if not configured or the call fails — callers decide how to fall back.
async function chat(messages, { temperature = 0.4, maxTokens = 320 } = {}) {
    if (!AI_API_KEY) throw new Error('AI not configured');
    const resp = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({ model: AI_MODEL, messages, temperature, max_tokens: maxTokens })
    });
    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`AI provider ${resp.status}: ${t.slice(0, 160)}`);
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('AI provider returned no content');
    return text;
}

module.exports = { chat, AI_CONFIGURED, AI_MODEL };
