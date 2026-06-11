// Shared, provider-agnostic LLM client (OpenAI-compatible chat completions).
// Works with OpenRouter, Moonshot/Kimi, Ollama Cloud, etc. via env config.
// Used by ai-briefing.js, ai-features.js and ai-chat.js.
//
// Right model for the job — each purpose can run a different model:
//   summary  — one-shot prose over precomputed facts (fast/cheap, no thinking)
//   chat     — the Ask chatbot's agentic tool loop (best reasoning + tools)
//   briefing — weekly portfolio briefing prose (default/legacy slot)

// Read env lazily (at call time) so it works regardless of whether dotenv has
// loaded yet at require-time, and regardless of env source (Render vs .env).
function cfg(purpose) {
    const fallback = process.env.AI_BRIEFING_MODEL || 'deepseek-v4-flash';
    const byPurpose = {
        summary: process.env.AI_MODEL_SUMMARY || 'deepseek-v4-flash',
        chat: process.env.AI_MODEL_CHAT || 'glm-5.1',
        briefing: process.env.AI_MODEL_BRIEFING || fallback
    };
    return {
        key: process.env.AI_BRIEFING_API_KEY || '',
        baseUrl: (process.env.AI_BRIEFING_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
        model: byPurpose[purpose] || fallback
    };
}
function isConfigured() { return !!(process.env.AI_BRIEFING_API_KEY || ''); }

// Low-level call: returns the raw assistant message object ({content,
// tool_calls, ...}). Used directly by the Ask chatbot's tool loop, which
// needs tool_calls and does its own identity screening on the final answer.
async function chatRaw(messages, { temperature = 0.4, maxTokens = 3000, purpose = 'briefing', tools = null, toolChoice = null } = {}) {
    const { key, baseUrl, model } = cfg(purpose);
    if (!key) throw new Error('AI not configured');
    const body = {
        model,
        messages,
        temperature,
        // Reasoning models (e.g. Kimi K2.6, GLM 5.1) emit chain-of-thought
        // into a separate `reasoning` field and the clean answer into
        // `content` — but both count against max_tokens, so we give a
        // generous floor to ensure the final answer isn't truncated.
        max_tokens: Math.max(maxTokens, 3000)
    };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`AI provider ${resp.status}: ${t.slice(0, 160)}`);
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message || {};
    msg._usage = data?.usage || null;
    return msg;
}

// Streaming variant of chatRaw: same request but stream:true, parses the SSE
// chunks and assembles the full assistant message ({content, tool_calls,
// _usage}) exactly like chatRaw returns. onDelta(textFragment) fires for each
// content token as it arrives — tool_call deltas are assembled silently.
async function chatRawStream(messages, { temperature = 0.4, maxTokens = 3000, purpose = 'briefing', tools = null, toolChoice = null } = {}, onDelta) {
    const { key, baseUrl, model } = cfg(purpose);
    if (!key) throw new Error('AI not configured');
    const body = {
        model,
        messages,
        temperature,
        max_tokens: Math.max(maxTokens, 3000),
        stream: true,
        stream_options: { include_usage: true }
    };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`AI provider ${resp.status}: ${t.slice(0, 160)}`);
    }
    const msg = { role: 'assistant', content: '', _usage: null };
    const tcByIndex = new Map(); // OpenAI streams tool calls as indexed fragments
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue; // ignore SSE comments/keep-alives
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let chunk;
            try { chunk = JSON.parse(payload); } catch (_) { continue; }
            if (chunk.usage) msg._usage = chunk.usage;
            const delta = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || null;
            if (!delta) continue;
            if (typeof delta.content === 'string' && delta.content) {
                msg.content += delta.content;
                if (onDelta) { try { onDelta(delta.content); } catch (_) { /* listener errors must not kill the stream */ } }
            }
            if (Array.isArray(delta.tool_calls)) {
                for (const d of delta.tool_calls) {
                    const i = Number.isInteger(d.index) ? d.index : 0;
                    if (!tcByIndex.has(i)) tcByIndex.set(i, { id: '', type: 'function', function: { name: '', arguments: '' } });
                    const tc = tcByIndex.get(i);
                    if (d.id) tc.id = d.id;
                    if (d.function && d.function.name) tc.function.name += d.function.name;
                    if (d.function && d.function.arguments) tc.function.arguments += d.function.arguments;
                }
            }
        }
    }
    if (tcByIndex.size) {
        msg.tool_calls = [...tcByIndex.keys()].sort((a, b) => a - b).map((i) => tcByIndex.get(i));
        msg.tool_calls.forEach((tc, i) => { if (!tc.id) tc.id = `call_${i}`; });
    }
    return msg;
}

// Throws if not configured or the call fails — callers decide how to fall back.
async function chat(messages, { temperature = 0.4, maxTokens = 320, purpose = 'briefing' } = {}) {
    const msg = await chatRaw(messages, { temperature, maxTokens, purpose });
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

module.exports = { chat, chatRaw, chatRawStream, isConfigured, leaksIdentity };
Object.defineProperty(module.exports, 'AI_CONFIGURED', { get: isConfigured });
