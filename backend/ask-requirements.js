'use strict';

// Ask answers the question that was asked.
//
// The only check an answer used to face was whether each figure in it had a
// source. A fully sourced answer to a different question passed: asked for one
// stock with over 35% growth across the last four quarters, low share-based
// pay and buybacks, Ask named a company growing 8%, said it "cleared every
// bar", and was released.
//
// Here the harness writes down what the reader asked for before any research,
// and reads the proposed answer against that list before it is released:
//   - a condition on a company's figures is tested in code, against the filed
//     figures of the company the answer puts forward;
//   - everything else (a judgement, a requested shape, each part of a question
//     on any subject) is read by a short second pass.
// An answer that misses a part is not released. The model is told which part
// and sent back to keep working.

const uq = require('./ask-universe-query');

const MIN_QUESTION_CHARS = 40;   // shorter than this is one plain ask; nothing to list
const MAX_ASKS = 12;
const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };
const THINK = /<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi;

function readJson(text) {
    const s = String(text || '').replace(THINK, '');
    const from = s.indexOf('{'), to = s.lastIndexOf('}');
    if (from === -1 || to <= from) return null;
    try { return JSON.parse(s.slice(from, to + 1)); } catch (_) { return null; }
}

function applies(question, policy) {
    return !!policy && ['focused', 'fund'].includes(policy.kind) && String(question || '').trim().length >= MIN_QUESTION_CHARS;
}

const EXTRACT_PROMPT = 'List what the user\'s message asks for, so the answer can be checked against it before it is sent. Return ONLY JSON, no prose:\n'
    + '{"asks":[{"text":"<the user\'s own words for this part>","kind":"number|judgement|deliverable","formula":"<only for number>","op":"> | >= | < | <=","value":<number>}]}\n'
    + 'kind "number": a condition on a company\'s reported figures that can be tested from its financial statements or price. Write the formula that measures it in the language below. When the user named a bar ("more than 35%"), give op and value in the formula\'s units (growth_pct and pct return percent, so 35% is 35). When the user named no bar ("low", "high", "strong"), give the formula and leave op and value out.\n'
    + 'kind "judgement": a condition that needs judgement and evidence rather than one figure (a defensible moat, not a commodity business, fairly valued, good management).\n'
    + 'kind "deliverable": something the answer must contain or the shape it must take (pick one, a top-10 list, a table, a comparison of A and B, an explanation of why, each separate question the message asks).\n'
    + 'Use the user\'s meaning exactly: growth of a business is revenue growth unless they said earnings or profit; "the last four quarters" is the four most recent quarters together against the four before. Do not add anything the user did not ask for, and do not drop anything they did. A message on any subject is listed the same way; one with no company conditions has only deliverables.\n'
    + 'Formula language. ' + uq.HELP;

function clean(raw) {
    const out = [];
    for (const item of Array.isArray(raw?.asks) ? raw.asks : []) {
        const text = String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) continue;
        const kind = ['number', 'judgement', 'deliverable'].includes(item.kind) ? item.kind : 'deliverable';
        const ask = { id: out.length + 1, text, kind };
        if (kind === 'number' && typeof item.formula === 'string') {
            try {
                uq.parse(item.formula);
                ask.formula = item.formula.trim();
                if (OPS[item.op] && Number.isFinite(Number(item.value)) && item.value !== null && item.value !== '') { ask.op = item.op; ask.value = Number(item.value); }
            } catch (_) { /* an unusable formula leaves the part to the reading pass */ }
        }
        out.push(ask);
        if (out.length === MAX_ASKS) break;
    }
    return out.length ? out : null;
}

async function extract(question, chat) {
    const reply = await chat([
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: String(question) }
    ], { purpose: 'chat', temperature: 0, maxTokens: 1200, toolChoice: 'none' });
    return clean(readJson(reply?.content));
}

const testable = ask => ask.kind === 'number' && ask.formula && ask.op;

function brief(asks) {
    const lines = asks.map(a => `${a.id}. [${a.kind}] "${a.text}"` + (a.formula ? ` — measured as ${a.formula}${a.op ? ` ${a.op} ${a.value}` : ''}` : ''));
    const numeric = asks.filter(testable);
    return 'WHAT THE USER ASKED FOR. The answer is read against this list before it is released, and it is sent back to you if any part is missing or wrong:\n'
        + lines.join('\n')
        + (numeric.length ? '\nThe measured parts are tested in code against the filed figures of whichever company you put forward. Find companies that pass ALL of them together with ONE query_universe call (each formula as a column, every bar in the where condition), then research the judgement parts for the strongest candidates before choosing.' : '')
        + (asks.some(a => a.formula) ? '\nFor the company you put forward, state its OWN figure for each measured part, read from its own row. A table of many companies makes it easy to quote the neighbouring row: check the ticker on the line before you copy a number.' : '')
    + '\nAnswer every part. A part that truly cannot be answered from any tool is named in one line near the top with the reason, and every other part is still answered in full.';
}

const CHECK_PROMPT = 'You check whether an answer does what the user asked. You are given the user\'s message, a numbered list of what it asked for, and the proposed answer. Return ONLY JSON, no prose:\n'
    + '{"picks":["TICKER"],"admitsNoFullMatch":false,"results":[{"id":1,"ok":true,"why":"<under 20 words>"}]}\n'
    + 'picks: the tickers the answer puts forward as its own answer or recommendation. Not companies it only mentions, compares against, or rejects. Empty when it puts none forward.\n'
    + 'admitsNoFullMatch: true only when the answer states plainly, near its start, that no company meets every condition the user set.\n'
    + 'results: one entry for every listed item. ok is true when the answer deals with that item in substance: a judgement is actually made and supported for the company put forward; a deliverable is present in the shape requested (asked for one, gives one); a question is actually answered. ok is false when the item is ignored, swapped for something else, only promised, or pushed back to the user. Do not check arithmetic or whether figures are right; that is done separately.';

const fmt = v => (typeof v !== 'number' ? String(v) : Math.abs(v) >= 1000 ? String(Math.round(v)) : String(Number(v.toFixed(1))));

// universe: { screenRows, facts } as ask-universe-query takes them.
async function judge({ question, asks, answer, chat, universe }) {
    const text = String(answer || '');
    let verdict = null;
    try {
        const reply = await chat([
            { role: 'system', content: CHECK_PROMPT },
            { role: 'user', content: `USER'S MESSAGE:\n${question}\n\nWHAT IT ASKED FOR:\n${asks.map(a => `${a.id}. ${a.text}`).join('\n')}\n\nPROPOSED ANSWER:\n${text.slice(0, 14000)}` }
        ], { purpose: 'chat', temperature: 0, maxTokens: 1200, toolChoice: 'none' });
        verdict = readJson(reply?.content);
    } catch (_) { verdict = null; }

    const known = new Set((universe?.screenRows || []).map(r => r.symbol));
    const mentioned = sym => new RegExp('(?<![A-Za-z0-9.])' + sym.replace(/[.]/g, '\\.') + '(?![A-Za-z0-9])').test(text);
    let picks = (Array.isArray(verdict?.picks) ? verdict.picks : []).map(s => String(s).toUpperCase().trim()).filter(s => known.has(s) && mentioned(s));
    // The reading pass failed: fall back to the first tickers the answer opens with.
    if (!verdict) picks = [...text.slice(0, 800).matchAll(/\(([A-Z]{1,5}(?:[.-][A-Z])?)\)/g)].map(m => m[1]).filter(s => known.has(s));
    picks = [...new Set(picks)].slice(0, 5);

    const issues = [];
    const numeric = asks.filter(testable);
    // A figure quoted for the company put forward must be that company's own.
    // The first live run named the right company and then gave it another
    // row's growth and share-based pay from the same table.
    const measured = asks.filter(a => a.kind === 'number' && a.formula);
    if (measured.length && picks.length && universe?.facts) {
        for (const sym of picks.slice(0, 3)) {
            const values = uq.valuesFor(sym, measured.map(a => a.formula), universe) || [];
            measured.forEach((a, i) => {
                const v = values[i];
                if (typeof v !== 'number') return;
                const forms = [v.toFixed(1), v.toFixed(2), String(Math.round(v)), Math.round(v).toLocaleString('en-US')];
                if (!forms.some(n => new RegExp('(?<![\\d.,])' + n.replace(/[.]/g, '\\.') + '(?![\\d])').test(text)))
                    issues.push({ key: `v${a.id}:${sym}`, soft: true, text: `Give ${sym}'s own figure for "${a.text}": ${a.formula} is ${v.toFixed(1)} for ${sym}. Quote that figure, and never another company's row.` });
            });
        }
    }
    if (numeric.length && picks.length && universe?.facts) {
        const failing = [];
        for (const sym of picks) {
            const values = uq.valuesFor(sym, numeric.map(a => a.formula), universe) || numeric.map(() => null);
            numeric.forEach((a, i) => {
                const v = values[i];
                if (typeof v !== 'number') failing.push({ key: `n${a.id}:${sym}:blank`, text: `${sym} cannot be shown to meet "${a.text}": it has not filed a figure this needs (${a.formula}).` });
                else if (!OPS[a.op](v, a.value)) failing.push({ key: `n${a.id}:${sym}:fail`, text: `${sym} does not meet "${a.text}": ${a.formula} is ${fmt(v)}, and the user asked for ${a.op} ${a.value}.` });
            });
        }
        if (failing.length) {
            // What does pass? Run the user's own conditions over every company.
            const all = uq.query({
                columns: numeric.map(a => ({ name: 'c' + a.id, formula: a.formula })),
                where: numeric.map(a => `c${a.id} ${a.op} ${a.value}`).join(' and '),
                limit: 12
            }, universe);
            const legend = numeric.map(a => `c${a.id} = ${a.text}`).join('; ');
            if (!all.error && all.matched > 0) {
                issues.push(...failing, { key: 'passers', text: `${all.matched} compan${all.matched === 1 ? 'y passes' : 'ies pass'} every measured condition (${legend}). Choose from these, researching the remaining parts for the strongest candidates:\n${all.table}` });
            } else if (!all.error && !verdict?.admitsNoFullMatch) {
                issues.push(...failing, { key: 'none-pass', text: `No company passes every measured condition (${legend}). Say exactly that in the first lines, then give the closest and the part each one misses:\n${all.closest ? all.closest.table : '(no near matches)'}` });
            }
            // Nothing passes and the answer says so: that is the true answer.
        }
    }
    const byId = new Map(asks.map(a => [a.id, a]));
    for (const r of Array.isArray(verdict?.results) ? verdict.results : []) {
        const ask = byId.get(Number(r?.id));
        if (!ask || r.ok !== false || testable(ask)) continue;
        issues.push({ key: `a${ask.id}`, text: `Not done: "${ask.text}"${r.why ? ' — ' + String(r.why).replace(/\s+/g, ' ').slice(0, 160) : ''}.` });
    }
    return { ok: issues.length === 0, issues, picks, signature: issues.map(i => i.key).sort().join('|') };
}

function directive(issues) {
    return 'ANSWER NOT RELEASED: it does not yet do what the user asked. Keep working. Use the tools to put right each point below, then write the complete answer again from the start (the user has not seen the draft).\n'
        + issues.map(i => '- ' + i.text).join('\n');
}

// What the reader is told when the run had to stop before the list was met.
function unfinished(issues, reason) {
    const points = issues.filter(i => !i.soft && !['passers', 'none-pass'].includes(i.key)).map(i => '- ' + i.text);
    if (!points.length) return '';
    return `\n\n**Not finished.** ${reason}\n${points.join('\n')}`;
}

module.exports = { MIN_QUESTION_CHARS, applies, extract, clean, brief, judge, directive, unfinished, testable };
