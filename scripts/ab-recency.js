'use strict';
/**
 * Does the model name the RIGHT period when asked for the latest results?
 *
 * This is the check that caught glm-5.3 answering "Berkshire's latest quarterly
 * results" with Q1 2026 while the true latest was Q2 — correct figures, wrong
 * quarter, stated with full confidence. Volume-of-tool-calls metrics all
 * favoured 5.3 and none of them saw it, so the assertion has to be about the
 * PERIOD in the answer, not about how the answer was produced.
 *
 * Cross-sector on purpose: fiscal calendars, filing cadence and segment shape
 * differ enough that one ticker proves nothing. SpaceX is in the list as the
 * negative control — it is private, files no 10-K, and a correct system must
 * decline rather than invent.
 *
 *   node scripts/ab-recency.js --models glm-5.1,glm-5.3
 *   node scripts/ab-recency.js --models glm-5.3 --reps 2
 */
const path = require('path');
const { loadAiEnvOnly } = require('./lib/dev-env');
loadAiEnvOnly(path.join(__dirname, '..', 'backend'));
const aiChat = require('../backend/ai-chat');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MODELS = arg('--models', 'glm-5.1,glm-5.3').split(',').map((s) => s.trim());
const REPS = Number(arg('--reps', '1'));

const CASES = [
    { name: 'Berkshire Hathaway', sector: 'conglomerate/insurance', q: "Summarise Berkshire Hathaway's latest quarterly results." },
    { name: 'Exxon Mobil', sector: 'energy', q: "Summarise Exxon Mobil's latest quarterly results." },
    { name: 'Meta', sector: 'technology', q: "Summarise Meta Platforms' latest quarterly results." },
    { name: 'Morgan Stanley', sector: 'banking', q: "Summarise Morgan Stanley's latest quarterly results." },
    { name: 'SpaceX', sector: 'PRIVATE — negative control', q: "Summarise SpaceX's latest quarterly results.", mustDecline: true }
];

// A period the answer claims to be reporting, e.g. "Q2 2026", "quarter ended
// 30 June 2026", "Q2 FY2026".
function periodsIn(text) {
    const out = new Set();
    for (const m of text.matchAll(/\bQ([1-4])\s*(?:FY)?\s*'?(\d{2,4})/gi)) {
        let y = m[2]; if (y.length === 2) y = '20' + y;
        out.add(`Q${m[1]} ${y}`);
    }
    for (const m of text.matchAll(/ended?\s+(\d{1,2}\s+\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4})/gi)) out.add(m[1]);
    return [...out];
}
// A decline is only correct if the model ALSO refrains from inventing figures.
// The first version of this checked for decline language alone and scored a
// run where glm-5.1 opened "SpaceX (ticker: SPCX) went public in June 2026 and
// reported its first-ever quarterly results" as CORRECT, because the paragraph
// hedged further down. Fabricating an IPO is the exact failure the control
// exists to catch, so the absence of invented numbers is the real assertion.
// "isn't a publicly listed company" has words between the negation and the
// adjective, which an `isn't listed` alternative misses — it scored a correct
// 5.3 decline as "unclear". Allow a couple of words in between.
const DECLINE = /(is\s*n[o']?t|not)\s+(\w+\s+){0,2}(public|publicly|listed)|private(ly)?[- ]?(held|compan)|does ?n[o']?t file|doesn'?t file|files no|no SEC|don'?t cover|is ?n[o']?t covered|not covered|not in my coverage/i;
// For a company that files nothing, ANY figure is invented. That is a much
// sounder test than hunting for phrases: the first version looked for "went
// public"/"IPO"/a ticker pattern, which both missed real fabrications ("first
// public quarterly report ... revenue surging 92%") and would have
// false-flagged a GOOD answer for naming Rocket Lab (RKLB) as a listed
// alternative. A correct decline quotes no dollars, no quarters, no percents.
const FABRICATED = /\$\s?\d|\bQ[1-4]\s*(?:FY)?\s*['\u2019]?\d{2,4}\b|\d+(?:\.\d+)?\s*%/;
function declineVerdict(ans) {
    const declined = DECLINE.test(ans);
    const fabricated = FABRICATED.test(ans);
    if (declined && !fabricated) return { ok: true, label: 'DECLINED (correct)' };
    if (fabricated) return { ok: false, label: '*** FABRICATED FIGURES ***' };
    return { ok: false, label: '*** ANSWERED (WRONG) ***' };
}

(async () => {
    console.log(`Recency A/B — does the answer name the right period? models=${MODELS.join(', ')} reps=${REPS}\n`);
    const score = new Map(MODELS.map((m) => [m, { ok: 0, n: 0 }]));
    for (const c of CASES) {
        console.log(`\n=== ${c.name}  [${c.sector}]`);
        for (let rep = 0; rep < REPS; rep++) {
            for (const model of (rep % 2 ? [...MODELS].reverse() : MODELS)) {
                process.env.AI_MODEL_CHAT = model;
                const t0 = Date.now();
                let r;
                try { r = await aiChat.ask({ question: c.q, history: [], ctx: {}, mode: 'normal' }); }
                catch (e) { console.log(`  ${model.padEnd(14)} ERROR ${e.message}`); continue; }
                const ans = r.answer || '';
                const tools = [...new Set((r.toolsUsed || []).map((t) => t.tool))];
                const s = score.get(model); s.n++;
                if (c.mustDecline) {
                    const v = declineVerdict(ans);
                    if (v.ok) s.ok++;
                    console.log(`  ${model.padEnd(14)} ${v.label}  ${Math.round((Date.now() - t0) / 1000)}s`);
                    console.log(`                 ${ans.slice(0, 150).replace(/\s+/g, ' ')}`);
                } else {
                    const periods = periodsIn(ans);
                    const checked = tools.includes('search_filings') || tools.includes('fetch_page') || tools.includes('get_filing_diff');
                    if (periods.length) s.ok++;
                    console.log(`  ${model.padEnd(14)} periods=${periods.join(' / ') || 'NONE STATED'}  recency-checked=${checked ? 'y' : 'n'}  ${Math.round((Date.now() - t0) / 1000)}s`);
                    console.log(`                 tools: ${tools.join(', ')}`);
                }
            }
        }
    }
    console.log('\n=== stated-a-period / declined-correctly ===');
    for (const [m, s] of score) if (s.n) console.log(`  ${m.padEnd(14)} ${s.ok}/${s.n}`);
    console.log('\nThe period itself still needs an eyeball against the real filing —');
    console.log('this only proves the model committed to one and whether it verified.');
    process.exit(0);
})();
