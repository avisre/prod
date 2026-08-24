// Shared "translate to plain English" helpers — take an already-generated,
// grounded analyst-mode piece of research text (or a JSON array of research
// items) and rewrite it for a non-specialist, preserving every fact, number,
// and schema field exactly. Used by dossier.js and filing-monitor.js to
// produce the "Normal mode" companion to their analyst-mode output.

const aiClient = require('./ai-client');

const PLAIN_SUMMARY_SYSTEM = [
    'Rewrite the following equity-research paragraph in plain English for a smart reader with no finance background.',
    'Keep every fact and number exactly as given — do not add, drop, or estimate anything new.',
    'If a financial term or acronym appears (e.g. margin, YoY, FCF, multiple, basis points), briefly explain it in plain words the first time it appears.',
    'Keep it roughly the same length. No buy/sell language, no advice, no exclamation marks.'
].join('\n');

const PLAIN_JSON_SYSTEM = [
    'You will receive a JSON object {"items": [...]} from an equity-research dossier. Reply with ONLY a JSON object of the same shape, no prose, no fences.',
    'Translate every text field into plain English for a smart reader with no finance background; copy any non-text field (e.g. a "severity" enum) through unchanged. Keep the exact same array length and the exact same keys on each item.',
    'Preserve every fact and number exactly — do not add, drop, or estimate anything new. If a term or acronym needs explaining, explain it briefly inline rather than leaving it bare.',
    'No buy/sell language, no advice.'
].join('\n');

function parseObj(msg, guard) {
    try {
        const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
        const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        return guard(p) ? p : null;
    } catch (_) { return null; }
}

async function plainSummary(analystText) {
    if (!analystText) return null;
    try {
        const text = String(await aiClient.chat([
            { role: 'system', content: PLAIN_SUMMARY_SYSTEM },
            { role: 'user', content: analystText }
        ], { temperature: 0.3, maxTokens: 420, purpose: 'summary', timeoutMs: 40000 }) || '').trim();
        return text || null;
    } catch (_) { return null; }
}

async function plainJsonArray(items) {
    if (!items || !items.length) return items || [];
    try {
        const call = (extra) => aiClient.chatRaw([
            { role: 'system', content: PLAIN_JSON_SYSTEM },
            { role: 'user', content: `Input JSON: {"items": ${JSON.stringify(items)}}${extra}\n\nReply with the translated JSON object.` }
        ], { purpose: 'summary', temperature: 0.3, maxTokens: 1400, timeoutMs: 45000 });
        const guard = (x) => Array.isArray(x.items) && x.items.length === items.length;
        let p = parseObj(await call(''), guard);
        if (!p) p = parseObj(await call('\nREPLY WITH ONLY THE JSON OBJECT. Keep the same array length.'), guard);
        return p ? p.items : items;
    } catch (_) { return items; }
}

async function plainBullBear(bull, bear) {
    const b1 = bull || [], b2 = bear || [];
    if (!b1.length && !b2.length) return { bull: b1, bear: b2 };
    try {
        const call = (extra) => aiClient.chatRaw([
            { role: 'system', content: PLAIN_JSON_SYSTEM.replace('{"items": [...]}', '{"bull": [...], "bear": [...]}') },
            { role: 'user', content: `Input JSON: ${JSON.stringify({ bull: b1, bear: b2 })}${extra}\n\nReply with the translated JSON object using the same keys "bull" and "bear".` }
        ], { purpose: 'summary', temperature: 0.3, maxTokens: 1400, timeoutMs: 45000 });
        const guard = (x) => Array.isArray(x.bull) && Array.isArray(x.bear) && x.bull.length === b1.length && x.bear.length === b2.length;
        let p = parseObj(await call(''), guard);
        if (!p) p = parseObj(await call('\nREPLY WITH ONLY THE JSON OBJECT. Keep the same array lengths.'), guard);
        return p ? { bull: p.bull, bear: p.bear } : { bull: b1, bear: b2 };
    } catch (_) { return { bull: b1, bear: b2 }; }
}

module.exports = { plainSummary, plainJsonArray, plainBullBear };
