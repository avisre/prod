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
    const explicitBase = String(process.env.AI_BRIEFING_BASE_URL || '').replace(/\/+$/, '');
    const ollamaKey = process.env.OLLAMA_API_KEY || '';
    const useOllama = /ollama\.com/i.test(explicitBase) || (!explicitBase && !!ollamaKey);
    // Direct Ollama Cloud requests use the library model name without the
    // `:cloud` suffix; that suffix is for a local Ollama daemon forwarding a
    // request to the cloud. OpenRouter uses its namespaced slug.
    const fallback = useOllama ? 'glm-5.1' : 'z-ai/glm-5.1';
    const byPurpose = {
        summary: process.env.AI_MODEL_SUMMARY || fallback,
        chat: process.env.AI_MODEL_CHAT || fallback,
        briefing: process.env.AI_MODEL_BRIEFING || fallback
    };
    return {
        key: useOllama
            ? (ollamaKey || process.env.AI_BRIEFING_API_KEY || '')
            : (process.env.AI_BRIEFING_API_KEY || process.env.OPENROUTER_API_KEY || ''),
        baseUrl: explicitBase || (useOllama ? 'https://ollama.com/v1' : 'https://openrouter.ai/api/v1'),
        model: byPurpose[purpose] || fallback
    };
}
function isConfigured() {
    return !!(process.env.OLLAMA_API_KEY || process.env.AI_BRIEFING_API_KEY || process.env.OPENROUTER_API_KEY || '');
}
const AI_MAX_OUTPUT_TOKENS = Math.max(256, Math.min(Number(process.env.AI_MAX_OUTPUT_TOKENS) || 2048, 8192));

// Low-level call: returns the raw assistant message object ({content,
// tool_calls, ...}). Used directly by the Ask chatbot's tool loop, which
// needs tool_calls and does its own identity screening on the final answer.
async function chatRaw(messages, { temperature = 0.4, maxTokens = 3000, purpose = 'briefing', tools = null, toolChoice = null, timeoutMs = 120000 } = {}) {
    const { key, baseUrl, model } = cfg(purpose);
    if (!key) throw new Error('AI not configured');
    const body = {
        model,
        messages,
        temperature,
        max_tokens: Math.min(Math.max(Number(maxTokens) || 256, 256), AI_MAX_OUTPUT_TOKENS)
    };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    // Hard timeout: Node's fetch has none, so a provider that accepts the
    // connection but never responds would hang this call forever. The Filing
    // Monitor chains two of these — an unbounded call is what left users on a
    // dead spinner for 7+ minutes. Keep the signal armed through the body read
    // (not just the headers), and word the error so callers' /timeout/ retry
    // and fallback paths catch it.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`
            },
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            throw new Error(`AI provider ${resp.status}: ${t.slice(0, 160)}`);
        }
        const data = await resp.json();
        const msg = data?.choices?.[0]?.message || {};
        msg._usage = data?.usage || null;
        return msg;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`AI provider timeout after ${Math.round(timeoutMs / 1000)}s`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Streaming variant of chatRaw: same request but stream:true, parses the SSE
// chunks and assembles the full assistant message ({content, tool_calls,
// _usage}) exactly like chatRaw returns. onDelta(textFragment) fires for each
// content token as it arrives — tool_call deltas are assembled silently.
async function chatRawStream(messages, { temperature = 0.4, maxTokens = 3000, purpose = 'briefing', tools = null, toolChoice = null, idleTimeoutMs = 90000 } = {}, onDelta) {
    const { key, baseUrl, model } = cfg(purpose);
    if (!key) throw new Error('AI not configured');
    const body = {
        model,
        messages,
        temperature,
        max_tokens: Math.min(Math.max(Number(maxTokens) || 256, 256), AI_MAX_OUTPUT_TOKENS),
        stream: true,
        stream_options: { include_usage: true }
    };
    if (Array.isArray(tools) && tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    // Idle timeout (not total): a long answer that keeps streaming is fine, but
    // a stream that goes silent mid-flight must not hang forever. Reset on every
    // chunk; abort only after a true stall. The error says "timeout" so the
    // chat loop's /timeout/ transient-retry catches it.
    const ctrl = new AbortController();
    let idleTimer;
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ctrl.abort(), idleTimeoutMs); };
    resetIdle();
    try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`
            },
            body: JSON.stringify(body),
            signal: ctrl.signal
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
            resetIdle();
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
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`AI provider stream timeout (idle ${Math.round(idleTimeoutMs / 1000)}s)`);
        throw err;
    } finally {
        clearTimeout(idleTimer);
    }
}

// Throws if not configured or the call fails — callers decide how to fall back.
async function chat(messages, { temperature = 0.4, maxTokens = 320, purpose = 'briefing', timeoutMs } = {}) {
    const msg = await chatRaw(messages, { temperature, maxTokens, purpose, timeoutMs });
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

// Self-revelatory phrasing — blocked regardless of subject. Bare AI company
// and model names are NOT here: they are legitimate finance subjects (OpenAI
// partnerships, a DeepSeek-driven selloff…) and live in the contextual list.
const IDENTITY_PATTERNS = [
    /openrouter/i, /gpt-?oss/i, /nemotron/i, /\bcogito\b/i, /\bk2\.\d/i,
    /\b(i\s+am|i'?m)\s+(an?\s+)?(large\s+)?language\s+model/i,
    /\bi am an? (ai|a\.i\.|artificial)/i, /\bi'?m an? (ai|a\.i\.|artificial)/i,
    /\bas an? (ai|a\.i\.|language model),?\s+i\b/i,
    /\bas an? (ai|a\.i\.)\s+(assistant|model|chatbot|agent)\b/i, /\bi was trained\b/i,
    /\bmy training data\b/i, /powered by (a|an|the)?\s*\w+\s*(model|llm)/i,
    /\bunderlying model\b/i, /\bsystem prompt\b/i
];
// Provider/model names only leak identity in self-referential phrasing
// ("I'm …", "I run on …", "… powers this assistant") — never as news subjects.
const NAME = '(deepseek|kimi|moonshot|qwen|chatgpt|openai|anthropic|claude|llama|minimax|ollama|glm|gemini|grok|mistral)';
const IDENTITY_SELF_PATTERNS = [
    new RegExp("\\b(i\\s+am|i'?m)\\s+(an?\\s+|the\\s+)?" + NAME + '\\b', 'i'),
    new RegExp("\\b(i\\s+am|i'?m|this\\s+(assistant|chatbot)\\s+is)\\b[^.!?\\n]{0,30}\\b(powered|built|made|created|developed|trained)\\s+by\\s+[^.!?\\n]{0,20}" + NAME, 'i'),
    new RegExp("\\bi\\s+(use|run|run\\s+on)\\s+(an?\\s+|the\\s+)?" + NAME + '\\b', 'i'),
    new RegExp('\\bmy\\s+(model|provider|maker|creator|architecture|training|underlying)\\b[^.!?\\n]{0,40}\\b' + NAME, 'i'),
    new RegExp('\\b' + NAME + "\\b[^.!?\\n]{0,40}\\b(powers|runs|is\\s+behind)\\s+(me|this\\s+assistant)\\b", 'i')
];
function leaksIdentity(text) {
    return IDENTITY_PATTERNS.some((re) => re.test(text))
        || IDENTITY_SELF_PATTERNS.some((re) => re.test(text));
}

module.exports = { chat, chatRaw, chatRawStream, isConfigured, leaksIdentity };
Object.defineProperty(module.exports, 'AI_CONFIGURED', { get: isConfigured });
