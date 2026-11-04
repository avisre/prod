#!/usr/bin/env node
/**
 * build-employee-counts.js
 *
 * Headcount per issuer per fiscal year, read out of the annual report itself,
 * plus revenue and profit per employee.
 *
 * Why it is read from the filing text: the employee count is NOT in XBRL. The
 * `dei` facts in a companyfacts file are only EntityCommonStockSharesOutstanding
 * and EntityPublicFloat; companyconcept/dei/EntityNumberOfEmployees returns
 * NoSuchKey (checked 2026-11-02 for AAPL, MSFT, KO, WMT). The number is narrative
 * prose, mandated since the August-2020 Reg S-K modernization:
 *
 *   17 CFR 229.101(c)(2)(ii) — "a description of the registrant's human capital
 *   resources, including the number of persons employed by the registrant" —
 *   qualified by "to the extent material to an understanding of the registrant's
 *   business taken as a whole".
 *
 * Foreign private issuers put it under Form 20-F Item 6.D ("Employees"); Form
 * 40-F (Canadian MJDS) has no human-capital item at all. EDGAR carries 10-Ks
 * back to 1994, and headcount sentences predate the 2020 rule by decades, so
 * older years are recoverable — with falling coverage for the earliest ones.
 *
 * This is a deterministic reader, not a model: every value kept has the filing
 * sentence it came from, and a sentence that cannot be resolved to a number and
 * a year is dropped rather than guessed.
 *
 *   node scripts/build-employee-counts.js --symbols=AAPL,MSFT,KO
 *   node scripts/build-employee-counts.js --limit=50 --years=19
 *   node scripts/build-employee-counts.js              # whole covered universe
 *
 *   --years=N       fiscal years of depth per issuer (default 19)
 *   --latest-only   just the newest annual report per issuer
 *   --refresh       ignore the per-CIK fetch cache and re-read EDGAR
 *   --jobs=N        issuers in parallel (default 4; EDGAR pacing is global)
 *   --out=FILE      write somewhere other than frontend/data/employee-counts.json
 *   --dry-run       fetch nothing, report the plan
 *
 * Raw extractions are cached per CIK under scripts/.cache/employee-filings/
 * (git-ignored), so an interrupted run resumes instead of refetching.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { decodeEntities } = require('../backend/html-text');

const DATA = path.resolve(__dirname, '..', 'frontend', 'data');
const CACHE = path.join(__dirname, '.cache', 'employee-filings');
// KEEP_TEXT=1 also stores each annual report's plain text (gzipped) so the reader
// can be iterated on without refetching from EDGAR. Local only, git-ignored.
const TEXT_CACHE = path.join(__dirname, '.cache', 'employee-text');
const KEEP_TEXT = String(process.env.KEEP_TEXT || '') === '1';
const DEFAULT_OUT = path.join(DATA, 'employee-counts.json');

const USER_AGENT = 'stockportfolio.pro contact@stockportfolio.pro';
// Requests are paced globally, not per worker: the work is network-bound (a report
// takes seconds to land) and the CPU sits at ~8%, so more jobs do not make it
// faster. SEC publishes a 10 requests/second ceiling; 8/s drew 2,519 HTTP 429s
// across a 70k-filing run on 2026-11-02, so 5/s is the safe default and the rate
// is tunable with --rate for a short run.
const RATE_PER_SEC = (() => {
    const hit = process.argv.find((a) => a.startsWith('--rate'));
    const v = hit ? Number(hit.includes('=') ? hit.split('=')[1] : process.argv[process.argv.indexOf(hit) + 1]) : 5;
    return Math.max(1, Math.min(9, v || 5));
})();
const MAX_DOC_BYTES = 60e6;
const MAX_QUOTE = 220;

const arg = (name, dflt) => {
    const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return dflt;
    const eq = hit.indexOf('=');
    return eq === -1 ? true : hit.slice(eq + 1);
};
const YEARS = Math.max(1, Number(arg('years', 19)));
const LATEST_ONLY = arg('latest-only', false) === true;
const REFRESH = arg('refresh', false) === true;
// 8 in flight cannot saturate the 5/s pace (each report takes seconds to land),
// so the ceiling is high and the pacer, not the worker count, sets the rate.
const JOBS = Math.max(1, Math.min(48, Number(arg('jobs', 4))));
const OUT = path.resolve(String(arg('out', DEFAULT_OUT)));
const DRY_RUN = arg('dry-run', false) === true;
// --merge keeps the issuers a partial run is not touching. Without it a repair
// run over 200 symbols rewrites the whole file with just those 200.
const MERGE = arg('merge', false) === true;
// --rebuild re-assembles the output from the per-issuer cache without touching
// EDGAR: the file is then always the current parse, never a mix of passes.
const REBUILD = arg('rebuild', false) === true;

// ---------------------------------------------------------------- fetching ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let slot = 0; // paces every request at RATE_PER_SEC across all jobs
async function pace() {
    const now = Date.now();
    const earliest = slot + 1000 / RATE_PER_SEC;
    slot = Math.max(now, earliest);
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
}

function fetchOnce(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate', Accept: '*/*' },
            timeout: 45000
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(fetchOnce(new URL(res.headers.location, url).href));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); }
            const enc = String(res.headers['content-encoding'] || '');
            const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
            const chunks = [];
            let size = 0;
            stream.on('data', (d) => {
                size += d.length;
                if (size > MAX_DOC_BYTES) { req.destroy(); return reject(new Error('document too large')); }
                chunks.push(d);
            });
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            stream.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}

async function fetchText(url, tries = 6) {
    for (let attempt = 1; ; attempt += 1) {
        await pace();
        try {
            return await fetchOnce(url);
        } catch (e) {
            const retryable = !e.status || e.status === 403 || e.status === 429 || e.status >= 500;
            if (attempt >= tries || !retryable) throw e;
            // a 429 is EDGAR asking for room, not a broken request: wait seconds, not ms
            await sleep(e.status === 429 ? 2000 * attempt : 600 * attempt * attempt);
        }
    }
}

// --------------------------------------------------------------- text prep ---
function htmlToText(html) {
    let t = String(html)
        .replace(/<(script|style|ix:header)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/?(?:span|b|i|u|em|strong|font|a|sup|sub|small|big|nobr|ix:[a-z:-]+|xbrli?:[a-z:-]+|ix)\b[^>]*>/gi, '')
        .replace(/<[^>]+>/g, ' ');
    t = decodeEntities(t).replace(/\s+/g, ' ').trim();
    // Inline-XBRL context names leak into the text as "us-gaap:EmployeeStockOption
    // Member 2024-12-012025-11-300000920760". That run of noise sits inside
    // sentences, inflates the number count (so real sentences were rejected as
    // "table") and breaks sentence boundaries around the headcount. It carries no
    // information for us, so it is removed before any rule sees the document.
    return t.replace(/\b[A-Za-z][\w-]*:[A-Za-z][\w-]*Member\b/g, ' ')
        .replace(/\b\d{18,}\b/g, ' ')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ----------------------------------------------------------------- parsing ---
const UNIT_MULT = { thousand: 1e3, k: 1e3, million: 1e6, mm: 1e6, billion: 1e9 };
const EMP_WORD = '(?:employees|employee|associates|people|persons|individuals|staff|personnel|colleagues|team members|partners|workforce|headcount|workers)';
const QUALIFIER = '(?:full[- ]time equivalent|full[- ]time and part[- ]time|part[- ]time and full[- ]time|full[- ]time|full[- ]and[- ]part[- ]time|part[- ]time|permanent|regular|active|salaried|hourly|seasonal|temporary|total|global|worldwide|approximately|about|over|more than|nearly|roughly|some|its|our)?';

// "approximately 32,000 full-time equivalent employees"
// "69.6 thousand employees" / "1,576,000 employees" / "150,900 associates"
const RE_AFTER = new RegExp(`\\b([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(thousand|million|billion|mm)\\s*([^.;]{0,45}?)\\s*${EMP_WORD}\\b`, 'gi');
const RE_AFTER_PLAIN = new RegExp(`\\b([0-9][0-9,]{2,}(?:\\.[0-9]+)?)\\s+((?:${QUALIFIER},?\\s+|and\\s+){0,5})${EMP_WORD}\\b`, 'gi');
// A company can be tiny: "the companies that comprise Eightco had 9 employees".
// The general pattern requires 3+ digits so that "our top 3 employees" cannot be
// read as a total, so this one is anchored on the stating verb and allows 1-2.
// Small counts, and counts whose staff noun sits behind a few descriptive words:
//   "the Company's workforce was composed of 39 full-time employees"  (Curbline)
//   "we had approximately 534 full-time sales and marketing personnel" (Meritage)
// The number is 1-4 digits and up to four lowercase words may sit between it and
// the staff noun. The verb anchor and the guards in push() keep "our top 3 people"
// out, and a wrong small count for a large company is caught by the ratio veto.
const RE_TINY = new RegExp(
    '(?:had|have|has|employ|employs|employed|employing|comprises?|comprised|numbered|totals?|includes?|included|consists?|consisted|composed of|comprised of|made up of)'
    + '\\s+(?:approximately\\s+|about\\s+|a total of\\s+|only\\s+|just\\s+|around\\s+|nearly\\s+)?'
    + '([0-9][0-9,]{0,4})'
    + '\\s+(?:[a-z][a-z-]{0,14},?\\s+){0,8}?'
    + EMP_WORD + '\\b', 'gi');
// "The number of regular employees was 69.6 thousand, 71.1 thousand, and 73.5 thousand"
const RE_BEFORE = new RegExp(`(?:number of|total of)\\s+(?:${QUALIFIER}\\s+){0,4}${EMP_WORD}\\b[^.;]{0,40}?(?:was|were|is|are|totaled|totalled|numbered|of)\\s+([0-9][^.;]{0,90})`, 'gi');

// Disqualifying for the whole sentence.
const BAD = /non-?employee|holder(?:s)? of record|shareholders?\b|customer|distributor|franchisee|patient|physician|subcontract|involuntary|attrition|turnover|share-based|stock option|stock plan|employee stock|award agreement|401\s?\(k\)|bonus plan|per share|warrant|shall not exceed|cannot exceed|may not exceed|authorized (?:shares|capital)|number of (?:shares|options|warrants|holders|record holders)/i;
// Applies to the count's OWN qualifier only ("2,800 … temporary employees and
// contractors" is a separate group), never to the sentence — Apple's real
// sentence names the 46,600 FTE and the 2,800 temps in the same breath.
const PARTIAL_QUALIFIER = /contractor|leased|as needed|union|severance|retiree|former/i;
// The span between a number and the people word is adjectives (full-time,
// permanent, approximately) or it is not a headcount at all. "2,000,000 shares
// may be issued to employees" and "$0.8 million of staff cost" both read as a
// company of two million (or 800,000) people until this runs; 22 issuers in the
// first full pass ended up over 1.6 million staff because of it.
const NOT_A_COUNT_SPAN = /shares?\b|stock\b|options?\b|awards?\b|units?\b|grants?\b|warrants?\b|ADSs?\b|\$|percent|%/i;
// A count of people reads "2,000 full-time employees"; "2.4 million FROM
// employees", "2.3 million people affected BY MS", "2.2 million ADSs purchased
// BY ..." all put a relation between the number and the noun. The relation is
// the tell — the noun alone is not enough.
const RELATION_SPAN = /\b(?:from|by|of|to|for)\b/i;
const SOFT_BAD = /full[- ]time equivalent|\bFTE\b|temporary|seasonal|part[- ]time|as needed/i;

// Disqualifying for THIS number: a segment's, a country's or a subsidiary's
// headcount is not the company's. Apple's "the Retail segment had approximately
// 26,500 full-time equivalent employees" and Coca-Cola's "8,900 employees
// located in the United States" both read as the company total until these ran.
// Two kinds of qualifier, and only one of them can be excused by a "worldwide".
const SUBSET_PLACE = /located in|in the (?:United States|U\.S\.)|in our operations|internationally|abroad|in the U\.K\.|in the UK|in London|in Europe|in Asia|at (?:our|its|the) [a-z ]{0,20}(?:stores?|clubs?|branches|restaurants?|facilit)/i;
// An activity is never the company total, however the sentence is dressed up:
// IBM's "over 200,000 employees globally participated in the survey" was kept
// because "globally" excused every subset test.
const SUBSET_ACTIVITY = /reaching|trained|participat|surveyed|covered by|engaged with|enrolled|impacted|dedicated to|working (?:in|on|at)|serving\b|were (?:transferred|hired|added|laid off|terminated|dismissed)|intend to hire|plan to hire|expect to hire|anticipate hiring|to (?:recruit|hire|train|skill)\b|into the [a-z ]{0,30}workforce|employees?\s+(?:transferred|moved|reassigned)|related to|headcount included/i;
// "20,000 persons who purchased an iPod" is a class of litigants, not staff
const NON_STAFF = /^[\d,.]+\s+(?:persons?|people|individuals|users?|subscribers?|customers?|shoppers?|visitors?|attendees?|investors?)\s+(?:who|that)\b/i;
// a segment's or a subsidiary's headcount is not the company's, and the word
// comes BEFORE the number: "the Retail segment had approximately 7,900 employees"
const PART_OF_COMPANY_BEFORE = /(?:segment|division|business unit|affiliate|joint venture)\b[^.]{0,35}$/i;
const TOTAL_CUE = /worldwide|globally|in total|total number|on a consolidated basis|around the world|following geograph|by geograph|in the following/i;

const YEARS_RE = /\b(19[89][0-9]|20[0-4][0-9])\b/g;

// Some filers never state headcount in prose — they put it in a table row:
// JPMorgan's 10-K read "Headcount(i) 251,196 258,753 259,940 239,515 221,200".
// The reader below is only consulted when the prose pass finds nothing, takes the
// largest row in the document (a segment's headcount is smaller than the total by
// construction), and labels what it read so the value is never mistaken for prose.
const TABLE_ROW = /\b(headcount|number of (?:full[- ]time |part[- ]time )?(?:employees|associates|people|persons|individuals|staff)|total (?:number of )?(?:employees|associates|staff|headcount)|employees|associates|workforce)\b\s*(?:\([^)]{0,32}\)\s*){0,2}[:\-–]?\s*((?:\d[\d,]*(?:\.\d+)?\s*(?:thousand|million)?\s*[,;]?\s*){1,8})/gi;

// Counts in the order they are written. A bare four-digit 1990-2099 is a year,
// not a headcount — XOM's "58 thousand, 61 thousand, and 62 thousand at years
// ended 2025, 2024, and 2023" was read as five numbers until this rule existed.
function numbersIn(fragment) {
    const out = [];
    const re = /(\$?)([0-9][0-9,]*(?:\.[0-9]+)?)\s*(thousand|million|billion|mm)?/gi;
    let m;
    while ((m = re.exec(fragment))) {
        if (m[1]) continue; // a dollar amount is never a headcount
        const n = Number(m[2].replace(/,/g, ''));
        if (!Number.isFinite(n)) continue;
        const value = Math.round(n * (m[3] ? UNIT_MULT[m[3].toLowerCase()] : 1));
        if (!m[3] && value >= 1900 && value <= 2099) continue;
        if (value >= 5 && value <= 5e6) out.push(value);
    }
    return out;
}

const ABBR = /(?:U\.S|U\.K|Inc|Ltd|Co|Corp|No|Nos|Mr|Mrs|Ms|Dr|Jr|Sr|approx|St|vs|e\.g|i\.e)\.$/i;

/** Sentence bounds that do not split on "U.S. " — Walmart's "1.4 million
 * associates in the U.S. and 0.8 million associates internationally" became the
 * quote "and 0.8 million associates internationally" and reported 800,000
 * people for FY2018. */
function sentenceAround(text, start, end) {
    let from;
    for (let p = text.lastIndexOf('. ', start); ; p = text.lastIndexOf('. ', p - 1)) {
        if (p === -1) { from = Math.max(0, start - 320); break; }
        if (!ABBR.test(text.slice(Math.max(0, p - 8), p + 1))) { from = p + 2; break; }
    }
    let to = text.indexOf('. ', end);
    to = to === -1 ? Math.min(text.length, end + 320) : to + 1;
    if (to - from > 760) { from = Math.max(from, start - 280); to = Math.min(to, end + 280); }
    return { from, quote: text.slice(from, to).trim() };
}

/**
 * "As of December 31, 2025 and 2024, our Company had approximately 65,900 and
 * 69,700 employees, respectively" / "58 thousand, 61 thousand and 62 thousand
 * at years ended 2025, 2024 and 2023": the numbers and the years are two lists
 * written in the same order, so pair them by position. Only when the years are
 * unambiguous and there is a number for each one — otherwise there is no signal
 * to align on and the single-value path takes over.
 */
function alignSeries(quote, fiscalYear) {
    const years = [];
    for (const m of quote.matchAll(/\b(19[89][0-9]|20[0-4][0-9])\b/g)) {
        const y = Number(m[1]);
        if (Math.abs(y - fiscalYear) <= 6 && !years.includes(y)) years.push(y);
    }
    if (years.length < 2) return null;
    const counts = numbersIn(quote).filter((v) => v >= 100);
    if (counts.length < years.length) return null;
    return years.map((year, i) => ({ year, value: counts[i] }));
}

/**
 * Best headcount reading in one annual report.
 * Returns { value, basis, years:[..], quote } or null.
 */
const TRACE = !!process.env.EMP_TRACE;
const trace = [];
function tableHeadcount(text, fiscalYear) {
    let best = null;
    for (const m of text.matchAll(TABLE_ROW)) {
        // m[1] is the label, m[2] the row of counts
        const nums = String(m[2] || '');
        // "issuance of common stock to employees 110,802 111 371,345" is a sentence
        // that happens to end in a staff word, not a headcount table row. A label
        // that follows a preposition is a continuation of prose.
        if (/\b(?:to|of|for|by|from|with|among|between|in|and|or)\s+$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
        // a row of money, shares or percentages is not a headcount
        if (/\$|%|€|£|¥/.test(text.slice(m.index, m.index + 6))) continue;
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 18);
        if (/^\s*(?:shares?|options?|awards?|units?|warrants?|per share)/i.test(after)) continue;
        const values = numbersIn(nums);
        if (!values.length) continue;
        // Only the row's FIRST column is used: it is the report's own fiscal year in
        // practically every table, while later columns are comparatives whose dating
        // cannot be confirmed from the text (JPMorgan's FY2009 filing listed five
        // years under one row and reading them positionally shifted the series).
        // Every filing contributes its own year, so the depth is unchanged.
        const top = values[0];
        if (!(top >= 20) || top > 2.4e6) continue;
        const years = [{ year: fiscalYear, value: top }];
        const quote = text.slice(m.index, Math.min(text.length, m.index + 120)).replace(/\s+/g, ' ').trim();
        if (!best || top > best.value) best = { value: top, years, quote, basis: 'headcount', src: 'table' };
    }

    // A split table with a Total column: "Full-time Part-time Total … 5,982 44,677
    // 50,659". The label is in the header row, so a label-anchored reader finds
    // nothing, and the total is the last column rather than the first. The reading
    // is accepted only when the arithmetic closes exactly (full-time + part-time =
    // total), which makes it self-verifying rather than positional:
    //   Addus HomeCare 5,982 + 44,677 = 50,659   Saul Centers 156 + 12 = 168
    for (const m of text.matchAll(/(\d[\d,]{0,9})\s+(\d[\d,]{0,9})\s+(\d[\d,]{1,9})(?![\d,])/g)) {
        const a = Number(m[1].replace(/,/g, ''));
        const b = Number(m[2].replace(/,/g, ''));
        const c = Number(m[3].replace(/,/g, ''));
        if (!(c >= 2) || c > 2.4e6) continue;
        if (a + b !== c || a < 1 || b < 1) continue;
        const near = text.slice(Math.max(0, m.index - 320), m.index + m[0].length);
        if (!/full[- ]?time/i.test(near) || !/part[- ]?time/i.test(near)) continue;
        if (/\$|€|£|¥|%/.test(near)) continue;
        const quote = text.slice(Math.max(0, m.index - 90), Math.min(text.length, m.index + m[0].length + 30)).replace(/\s+/g, ' ').trim();
        const cand = { value: c, years: [{ year: fiscalYear, value: c }], quote, basis: 'headcount', src: 'table' };
        if (!best || c > best.value) best = cand;
    }
    return best;
}

// Some registrants have no staff at all: externally managed mortgage REITs and
// BDCs ("we have no employees; our adviser provides the personnel"). The honest
// value is 0 — but saying 0 for a company that employs thousands is worse than
// saying nothing, so the statement must be a first-person negation AND the
// document must contain no plausible staff count anywhere.
const NO_STAFF_STMT = /\b(?:we|the\s+(?:company|registrant|partnership|trust|fund)|it)\b[^.]{0,80}?\b(?:has|have|had|will\s+have)\s+no\s+(?:full[- ]time\s+|part[- ]time\s+|direct\s+|own\s+)?(?:employees|personnel|staff)\b|\b(?:does|do)\s+not\s+(?:have|employ)\s+(?:any\s+)?(?:employees|personnel|staff)\b|\b(?:we|the\s+(?:company|registrant|partnership|trust))\b[^.]{0,60}\bexternally\s+managed\b/i;

const STRONG_ZERO = /\bno\s+direct\s+(?:full[- ]time\s+)?employees\b|\bexternally\s+managed\b|\b(?:does|do)\s+not\s+(?:have|employ)\s+(?:any\s+)?(?:employees|personnel|staff)\b/i;
// "we have no employees in Canada" is a place subset, not a zero
const ZERO_PLACE_AFTER = /\b(?:employees|personnel|staff)\s+(?:in|within|outside|located|based|at)\b/i;

function noEmployeesStatement(text, fiscalYear) {
    if (!NO_STAFF_STMT.test(text)) return null;
    const sm = text.match(NO_STAFF_STMT);
    const { quote: zeroQuote } = sentenceAround(text, sm.index, sm.index + sm[0].length);
    if (ZERO_PLACE_AFTER.test(zeroQuote)) return null;
    // Enterprise Products says "like many publicly-traded partnerships, we have no
    // direct employees" — its general partner employs everyone. That is a real 0
    // and it must beat the stray "100" the table reader picks up from the same
    // document. The generic phrasing still needs the document-wide guard below.
    const strong = STRONG_ZERO.test(zeroQuote) ||
        /\b(?:workforce|human\s+capital|our\s+people|personnel)\b/i.test(text.slice(Math.max(0, sm.index - 600), sm.index));
    // The guard: if the same document states a count we would accept, the "no
    // employees" line is about something narrower (a subsidiary, a plan, a
    // period). Lennar states "we have no employees" in a benefits note while
    // employing 12,532 people, and this test is what keeps it out.
    const probe = (re) => {
        for (const m of text.matchAll(re)) {
            const raw = (m[1] || m[2] || '').replace(/,/g, '');
            const value = Number(raw);
            if (!(value >= 20) || value > 2.4e6) continue;
            if (value >= 1900 && value <= 2099) continue;
            const { quote } = sentenceAround(text, m.index, m.index + m[0].length);
            if (BAD.test(quote)) continue;
            if (NOT_A_COUNT_SPAN.test(m[0])) continue;
            return value;
        }
        return null;
    };
    const other = probe(RE_AFTER) || probe(RE_AFTER_PLAIN) || probe(RE_BEFORE);
    if (other && !strong) return null;
    return { value: 0, basis: 'none', src: 'prose', strong, years: [{ year: fiscalYear, value: 0 }], quote: zeroQuote.slice(0, MAX_QUOTE) };
}

// A few filings state the workforce only as components, never as a total:
//   "approximately 70 full-time equivalent employees at its headquarters office
//    and 86 full-time employees and 12 part-time employees at its properties"
// Saul Centers files 168 people that way. Summing is arithmetic on stated numbers,
// not an estimate, but it is a DERIVED value — so the components are kept beside
// it and the record is labelled `from: "sum of stated components"` rather than
// presented as a figure the company itself stated.
function sumStatedComponents(text, fiscalYear) {
    for (const m of text.matchAll(/[^.]{0,240}(?:full[- ]?time|part[- ]?time)[^.]{0,240}\./gi)) {
        const sent = m[0];
        if (/%|\$|€|£|¥/.test(sent)) continue;
        if (/\btotal\b/i.test(sent)) continue; // a stated total is a reading, not a sum
        const parts = [];
        for (const e of sent.matchAll(/(\d[\d,]{0,8})\s*(?:full[- ]?time(?:\s+equivalent)?|part[- ]?time|permanent|regular)\s+(?:employees|associates|persons|staff|people)/gi)) {
            const v = Number(e[1].replace(/,/g, ''));
            if (v >= 1 && v <= 5e5) parts.push(v);
        }
        if (parts.length < 2) continue;
        const total = parts.reduce((a, b) => a + b, 0);
        if (!(total >= 2) || total > 2.4e6) continue;
        const quote = sent.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE);
        return { value: total, basis: 'headcount', src: 'prose', from: 'sum of stated components', components: parts, years: [{ year: fiscalYear, value: total }], quote };
    }
    return null;
}

// Small filers write the number out in words: "we had four full-time employees",
// "We employed sixty three employees as of December 31, 2025". Digits-only reading
// calls those companies blank, which is wrong — the number is there, spelled.
const NUM_WORDS = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
    eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19,
    twenty:20, thirty:30, forty:40, fourty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
function wordsToNumber(s) {
    const toks = String(s).toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
    if (!toks.length) return null;
    let cur = 0; let seen = false;
    for (const t of toks) {
        if (t === 'and' || t === 'a') continue;
        if (t === 'hundred') { cur = (cur || 1) * 100; seen = true; continue; }
        if (Object.prototype.hasOwnProperty.call(NUM_WORDS, t)) { cur += NUM_WORDS[t]; seen = true; continue; }
        return null;
    }
    return seen ? cur : null;
}
const W_UNIT = '(?:one|two|three|four|five|six|seven|eight|nine)';
const W_TENS = '(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)';
const W_SMALL = `(?:${W_TENS}(?:[-\\s]${W_UNIT})?)`;
const W_HUND = `(?:(?:${W_UNIT}|a)\\s+hundred(?:\\s+(?:and\\s+)?${W_SMALL})?)`;
const W_ANY = `(?:${W_HUND}|${W_SMALL}|${W_UNIT})`;
const RE_WORDNUM = new RegExp(`(?:had|have|has|employ|employs|employed|comprises?|comprised|numbered|totals?)\\s+(${W_ANY})\\s+(?:full[- ]time\\s+|part[- ]time\\s+|total\\s+|regular\\s+|full[- ]time equivalent\\s+)?${EMP_WORD}\\b`, 'gi');

const quote_of = (x) => String(x).slice(0, 120);
function headcountFromFiling(text, fiscalYear) {
    const cands = [];
    if (TRACE) trace.length = 0;
    const drop = (why, quote, hit) => { if (TRACE) trace.push({ why, hit: hit ? String(hit).slice(0, 60) : undefined, quote: String(quote).slice(0, 150) }); };
    const push = (index, endOfMatch, value, basis, { nounBefore = false, unit = '' } = {}) => {
        // "$0.8 million … additional employees" is staff cost, not headcount
        // a currency amount is never a headcount — and not every filing writes "$":
        // "an increase of JPY17.2 million in outsourced staff cost" read as 2,000,000 staff
        if (/(?:US)?[$€£¥₩₹]\s*$|\b(?:JPY|EUR|GBP|CHF|CAD|AUD|RMB|CNY|KRW|INR|SEK|NOK|DKK|BRL|MXN)\s*$/i.test(text.slice(Math.max(0, index - 5), index))) return drop('money', value);
        // a bare 1900-2099 is a year; nobody employs more than ~2.4 million people
        // (Walmart is the ceiling), so a "9.7 billion" reading is energy demand
        // A floor of 20 rejected real companies: Eightco Holdings files "the
        // companies that comprise Eightco had 9 employees". The floor exists to
        // stop tiny numbers being read as totals, and that job is now done by the
        // place/subset guards and by the revenue-per-employee veto (a 9-person
        // headcount against a $2bn revenue is $222m each and is rejected there).
        if (!(value >= 2) || (value >= 1900 && value <= 2099)) return drop('implausible', value);
        if (value > 2.4e6) return drop('implausible-too-large', value);
        // A seven-figure staff needs the sentence to say so — but only when the
        // figure was WRITTEN with a unit ("2.1 million associates worldwide").
        // Amazon writes "1,576,000 full-time and part-time employees" and was
        // blanked by this test until it was scoped to the unit form.
        if (unit && value >= 1e6 && !/million|worldwide|globally|around the world|associates/i.test(text.slice(index - 40, Math.min(text.length, endOfMatch + 60)))) return drop('million-without-people-cue', value);
        // A function group is not the company: Meritage files "534 full-time sales
        // and marketing personnel" and "878 full-time construction and warranty
        // employees" and never states a total. Where the headcount noun is
        // "personnel" and a department is named in front of it, the number is a
        // slice of the workforce and is refused.
        const sliceSpan = text.slice(index, endOfMatch);
        if (/\bpersonnel\b/i.test(sliceSpan) && /\b(?:sales|marketing|engineering|construction|warranty|manufacturing|production|clinical|research|administrative|corporate|support|technical|field|store|plant|hourly|distribution|logistics|finance|accounting|legal)\b/i.test(sliceSpan)) return drop('function-group', quote_of(sliceSpan));
        const { from, quote } = sentenceAround(text, index, endOfMatch);
        if (BAD.test(quote)) return drop('bad-sentence', quote);
        // "people" and "persons" are ambiguous where "employees" is not: biotech
        // filings are full of "2.1 million people with T1D" and "2 million people
        // die of AKI". The ambiguous nouns need a staff cue somewhere near.
        const ambiguous = /\b(?:people|persons|individuals)\b/i.test(text.slice(Math.max(0, index), endOfMatch + 1));
        if (ambiguous && !/employ|staff|workforce|headcount|personnel|associates|team members|colleagues|workers|human capital/i.test(quote)) return drop('people-not-staff', quote);
        // end at the noun: reading past it caught the NEXT sentence's "Additional
        // information …" and blanked Amazon's 1,576,000 employees.
        // "In addition, we have over 3,000 employees" is a subset stated after the
        // total (GE Vernova files 75,000 in the same paragraph and the 3,000 scored
        // higher because it says "we have"); the additive word precedes the number.
        if (/\b(?:in addition|additionally|including|of which|plus)\b[^.]{0,30}$/i.test(text.slice(Math.max(0, index - 55), index))) return drop('additive-group', quote);
        const partialSpan = text.slice(index, endOfMatch);
        if (PARTIAL_QUALIFIER.test(partialSpan)) return drop('partial-group', quote, partialSpan.match(PARTIAL_QUALIFIER)[0]);
        // planned headcount is not headcount: the intent word precedes the number
        if (/\b(?:intends?|plans?|plans|expects?|anticipates?|will|would)\s+(?:to\s+)?(?:hire|add|employ|expand)\b[^.]{0,40}$/i.test(text.slice(Math.max(0, index - 70), index))) return drop('planned-headcount', quote);
        const countSpan = text.slice(index, endOfMatch);
        if (NOT_A_COUNT_SPAN.test(countSpan)) return drop('not-a-count', quote, countSpan.match(NOT_A_COUNT_SPAN)[0]);
        // only the span between the number and the noun: reading past the noun
        // caught "52,000 … workers, the majority of which" as a relation
        if (!nounBefore && RELATION_SPAN.test(text.slice(index, endOfMatch))) return drop('relation-not-adjective', quote);
        // "2.3 million people worldwide affected by MS" / "2.2 million ADSs
        // purchased by ...": the noun is real, the participle that follows it is
        // what makes it an object of an action rather than staff. Read only a
        // short tail — "52,000 workers, the majority of which" must survive.
        if (/\s(?:worldwide|globally)?\s?(?:affected|purchased|sold|reached|impacted|served|covered|engaged|enrolled|surveyed|trained|transferred)\b/.test(text.slice(endOfMatch, Math.min(text.length, endOfMatch + 22)))) return drop('participle-not-staff', quote);
        if (!new RegExp(EMP_WORD, 'i').test(quote)) return drop('no-people-word', quote);
        // a fragment that begins mid-clause is a split, not a sentence
        // A fragment from a bad split starts with a LOWERCASE conjunction ("and 0.8
        // million associates internationally"); a real sentence starts with a capital.
        // The test used to be case-insensitive and threw away BlackRock's
        // "Of the Company's approximately 24,900 employees …".
        if (/^(?:and|or|with|of|which|as well as|including|while|but|for|to|by|that|who)\b/.test(quote)) return drop('mid-clause', quote);
        // a flattened table row is a run of cells, not prose about people — but a
        // real sentence compares two years and names the U.S. share, so the test is
        // "many numbers and no verb", not "many numbers".
        const numberTokens = (quote.match(/\b[0-9][0-9,.]*\b/g) || []).length;
        // A segment breakdown is still a sentence: Lennar writes "we employed
        // 12,532 individuals of whom 10,182 were involved in the Homebuilding
        // operations, 2,132 …" — many numbers, one verb, and it was thrown away
        // as a table. A table has many numbers and no verb.
        const hasVerb = /\b(?:had|has|have|employ|employs|employed|is|are|was|were|includes|totals|numbered)\b/i.test(quote);
        if (numberTokens > 8 && !hasVerb) return drop('table', quote);
        if (numberTokens >= 5 && !/\b(?:had|has|have|employ|employs|employed|is|are|was|were|includes|totals|numbered)\b/i.test(quote)) return drop('table-no-verb', quote);
        // the qualifier that makes a count a subset follows the word: "8,900
        // employees located in the United States", "2.1 million associates
        // worldwide" — so read forward only, and only a little
        const tight = text.slice(index, Math.min(text.length, endOfMatch + 40));
        // "2.1 million associates worldwide, with 1.6 million in the U.S.": the
        // worldwide count exempts itself, the partial one never does
        // A qualifier attaches to the count only up to the next comma; after it the
        // sentence is remarking on those people, not narrowing the count:
        //   "419 full-time employees, all of whom work in the U.S."  -> the total
        //   "8,900 employees located in the United States"            -> a subset
        //   "1,677 people, of which 378 are covered by collective bargaining" -> total
        const tailRaw = text.slice(endOfMatch, Math.min(text.length, endOfMatch + 60));
        const commaAt = tailRaw.indexOf(',');
        const tail = commaAt === -1 ? tailRaw.slice(0, 40) : tailRaw.slice(0, commaAt);
        const totalCue = TOTAL_CUE.test(tail) || TOTAL_CUE.test(tight);
        if (SUBSET_ACTIVITY.test(tail)) return drop('activity:' + (tail.match(SUBSET_ACTIVITY) || [''])[0], quote);
        // "5,500 employees located in thirteen countries" describes the WHOLE
        // workforce; only a named place ("located in the United States") narrows it.
        const placeIsSpread = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|multiple|several|many|numerous|various)\b[^,.]{0,24}\b(?:countries|states|markets|regions|locations|offices|sites|provinces|cities)\b/i.test(tail);
        if (!totalCue && SUBSET_PLACE.test(tail) && !placeIsSpread) return drop('place:' + (tail.match(SUBSET_PLACE) || [''])[0], quote);
        if (/collective bargaining|labor agreement|union(?:ized)?\b/i.test(tail)) return drop('union-clause', quote);
        if (NON_STAFF.test(text.slice(index, index + 80))) return drop('not-staff', quote);
        if (PART_OF_COMPANY_BEFORE.test(text.slice(Math.max(0, index - 70), index))) return drop('part-of-company', quote);
        cands.push({ value, basis, quote, from, tight, at: index });
    };

    for (const m of text.matchAll(RE_AFTER)) {
        const qualifiers = String(m[3] || '');
        if (BAD.test(qualifiers)) continue;
        const value = Math.round(Number(m[1].replace(/,/g, '')) * UNIT_MULT[m[2].toLowerCase()]);
        const basis = /full[- ]time equivalent|FTE/i.test(qualifiers) ? 'fte' : 'headcount';
        push(m.index, m.index + m[0].length, value, basis, { unit: String(m[2] || '').toLowerCase() });
    }
    for (const m of text.matchAll(RE_AFTER_PLAIN)) {
        const qualifiers = String(m[2] || '');
        if (BAD.test(qualifiers) && !/^approximately\s+$/i.test(qualifiers)) continue;
        const basis = /full[- ]time equivalent|FTE/i.test(qualifiers) ? 'fte' : 'headcount';
        push(m.index, m.index + m[0].length, Math.round(Number(m[1].replace(/,/g, ''))), basis);
    }
    for (const m of text.matchAll(RE_WORDNUM)) {
        const value = wordsToNumber(m[1]);
        if (value === null || !(value >= 2) || value > 2.4e6) continue;
        // index at the NUMBER, not at the verb: a span that begins with "composed of"
        // reads as "N of employees" and is thrown out by the relation guard.
        const at = m.index + m[0].indexOf(m[1]);
        push(at, m.index + m[0].length, value, /full[- ]time equivalent/i.test(m[0]) ? 'fte' : 'headcount');
    }
    for (const m of text.matchAll(RE_TINY)) {
        const value = Number(m[1].replace(/,/g, ''));
        if (!(value >= 2)) continue;
        const basis = /full[- ]time equivalent/i.test(m[0]) ? 'fte' : 'headcount';
        const at = m.index + m[0].indexOf(m[1]);
        push(at, m.index + m[0].length, value, basis);
    }
    for (const m of text.matchAll(RE_BEFORE)) {
        const nums = numbersIn(m[1]);
        if (!nums.length) continue;
        const basis = /full[- ]time equivalent|FTE/i.test(m[0]) ? 'fte' : 'headcount';
        push(m.index, m.index + m[0].length, nums[0], basis, { nounBefore: true });
    }
    const table = tableHeadcount(text, fiscalYear);
    if (!cands.length) return table || noEmployeesStatement(text, fiscalYear) || sumStatedComponents(text, fiscalYear);
    // An unambiguous "we have no direct employees / we are externally managed"
    // beats a stray reading from elsewhere in the same document: Enterprise
    // Products has no employees at all, and the table reader was finding 100.
    const zeroStmt = noEmployeesStatement(text, fiscalYear);
    if (zeroStmt && zeroStmt.strong) return zeroStmt;

    // One sentence yields several numbers (the total, a comparative, the U.S.
    // share, the year-over-year change). Keep one candidate per sentence — the
    // largest, because a total is the biggest count a headcount sentence names.
    const byQuote = new Map();
    for (const c of cands) {
        const prev = byQuote.get(c.quote);
        if (!prev || c.value > prev.value) byQuote.set(c.quote, c);
    }

    const scored = [...byQuote.values()].map((c) => {
        let score = 0;
        const before = text.slice(Math.max(0, c.from - 700), c.from);
        if (/human capital/i.test(before)) score += 4;
        if (/^as of|^at (?:the end of )?(?:december|january|february|march|april|may|june|july|august|september|october|november)|\bas of (?:december|january|february|march|april|may|june|july|august|september|october|november)/i.test(c.quote)) score += 3;
        if (/\b(?:we|the company|the firm|the corporation|the registrant)\b[^.]{0,40}\b(?:had|have|has|employ|employs|employed)\b/i.test(c.quote)) score += 2;
        if (TOTAL_CUE.test(c.tight)) score += 5;
        if (SOFT_BAD.test(c.quote)) score -= 2;
        if (c.basis === 'fte') score -= 1;
        score += 1.5 * (1 - c.at / Math.max(1, text.length)); // Item 1 comes before notes
        return { ...c, score };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Which fiscal years this reading covers: a numbers/years alignment when the
    // sentence carries one, else the date it names, else the report's own year.
    const aligned = alignSeries(best.quote, fiscalYear);
    const years = aligned || (() => {
        const dates = [...best.quote.matchAll(YEARS_RE)].map((m) => Number(m[1]));
        const plausible = dates.filter((y) => Math.abs(y - fiscalYear) <= 2);
        return [{ year: plausible.length ? plausible[0] : fiscalYear, value: best.value }];
    })();
    const own = years.find((y) => y.year === fiscalYear);
    const out = { value: own ? own.value : best.value, basis: best.basis, src: 'prose', years, quote: best.quote.slice(0, MAX_QUOTE) };
    // the filing's own table row, kept even when prose won, so a year prose missed
    // can still be filled from it later in assemble()
    if (table && table.years) out.table = { years: table.years, quote: table.quote };
    out.trace = { cands: scored.map((c) => ({ score: Math.round(c.score * 100) / 100, value: c.value, at: c.at, quote: c.quote.slice(0, 160) })), dropped: TRACE ? trace.slice(0, 40) : [] };
    return out;
}

// ------------------------------------------------------------- EDGAR walks ---
const ANNUAL = /^(10-K|20-F|40-F)$/;
const ANNUAL_AMEND = /^(10-K\/A|20-F\/A|40-F\/A)$/;

async function annualFilings(cik) {
    const sub = JSON.parse(await fetchText(`https://data.sec.gov/submissions/CIK${cik}.json`, 5));
    const rows = [];
    const take = (f) => {
        for (let i = 0; i < f.form.length; i += 1) {
            const form = f.form[i];
            if (ANNUAL.test(form)) rows.push({ form, accession: f.accessionNumber[i], doc: f.primaryDocument[i], date: f.filingDate[i], reportDate: f.reportDate[i] || '' });
            else if (ANNUAL_AMEND.test(form)) rows.push({ form: form.replace('/A', ''), accession: f.accessionNumber[i], doc: f.primaryDocument[i], date: f.filingDate[i], reportDate: f.reportDate[i] || '', amend: true });
        }
    };
    take(sub.filings.recent);
    for (const extra of (sub.filings.files || [])) {
        take(JSON.parse(await fetchText(`https://data.sec.gov/submissions/${extra.name}`, 5)));
    }
    // one report per fiscal year: an original beats an amendment filed later
    const byYear = new Map();
    for (const r of rows.sort((a, b) => a.date.localeCompare(b.date))) {
        const fy = Number(String(r.reportDate || r.date).slice(0, 4));
        // An original beats an amendment. A 10-K/A amends two items and is a few
        // hundred KB with no human-capital section at all; this test used to do the
        // opposite of what it says, so Newmark's whole history was read out of
        // its "ea…-10ka1" filings and every year came back blank.
        const prev = byYear.get(fy);
        if (!prev || (prev.amend && !r.amend)) byYear.set(fy, r);
    }
    return [...byYear.entries()].map(([fy, r]) => ({ ...r, fy })).sort((a, b) => b.fy - a.fy);
}

function archUrl(cik, accession, doc) {
    return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g, '')}/${doc}`;
}
function docUrl(r) { return archUrl(r.cik, r.accession, r.doc); }

/**
 * Some filers split the annual report across several HTML documents — IBM's
 * FY2025 10-K is ibm-20251231.htm (the Part I wrapper) plus ibm-20251231_d2.htm
 * (4.5 MB, the body). The submissions feed names only the first, so the reader
 * saw a cover page with no headcount and recorded nothing. When the primary
 * document yields no reading, the filing's other HTML documents are tried,
 * largest first.
 */
async function siblingDocs(cik, accession, primary) {
    try {
        const index = JSON.parse(await fetchText(`${archUrl(cik, accession, 'index.json')}`, 3));
        return ((index.directory || {}).item || [])
            .filter((it) => /\.html?$/i.test(it.name) && it.name !== primary)
            .sort((a, b) => Number(b.size || 0) - Number(a.size || 0))
            .slice(0, 3)
            .map((it) => it.name);
    } catch (_) { return []; }
}

// Bumped whenever a rule changes: a cached filing that produced NO reading is
// re-read, because it may have failed under the old rules. Readings are kept —
// they were correct when they were taken and re-fetching 12,000 documents to
// re-derive them would cost hours for no gain.
const READER_VERSION = '2026-11-03n';

async function readIssuer(issuer) {
    const cik = String(issuer.cik).padStart(10, '0');
    const cacheFile = path.join(CACHE, `${cik}.json`);
    let cache = null;
    if (!REFRESH) {
        try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* first visit */ }
    }
    if (!cache) cache = { cik, filings: {} };

    const filings = await annualFilings(cik);
    const target = LATEST_ONLY ? filings.slice(0, 1) : filings.slice(0, YEARS);
    for (const r of target) {
        const seen = cache.filings[r.accession];
        // a blank recorded by an older reader is not a verdict, it is a question
        const staleBlank = cache.readerVersion !== READER_VERSION && seen && !seen.error && !seen.years;
        if (seen && seen.fy === r.fy && !seen.error && !staleBlank) continue; // already read
        let text;
        const textFile = KEEP_TEXT ? path.join(TEXT_CACHE, `${cik}.${r.accession}.txt.gz`) : null;
        try {
            if (textFile && fs.existsSync(textFile)) text = zlib.gunzipSync(fs.readFileSync(textFile)).toString('utf8');
            else {
                text = htmlToText(await fetchText(docUrl({ ...r, cik }), 4));
                if (textFile) { fs.mkdirSync(TEXT_CACHE, { recursive: true }); fs.writeFileSync(textFile, zlib.gzipSync(Buffer.from(text))); }
            }
        } catch (e) {
            cache.filings[r.accession] = { fy: r.fy, form: r.form, date: r.date, error: String(e.message || e).slice(0, 80) };
            continue;
        }
        // Where the narrative lives depends on the form:
        //   10-K  -> the primary document (a body split into _d1.._dN is tried after)
        //   40-F  -> an EX-99 exhibit; the primary is a wrapper with almost no prose
        //   20-F  -> primary, then exhibits
        // Royal Bank of Canada is the case that forced this: its wrapper's first table
        // gave a 26,374 segment figure, while the exhibit states 96,628 FTE.
        const annualExhibitFirst = r.form === '40-F';
        let hit = null;
        let docUsed = r.doc;
        const tryDoc = async (name) => {
            const t = name === r.doc ? text : htmlToText(await fetchText(archUrl(cik, r.accession, name), 3));
            const h = headcountFromFiling(t, r.fy);
            return h && h.years ? h : null;
        };
        if (annualExhibitFirst) {
            for (const name of (await siblingDocs(cik, r.accession, r.doc)).slice(0, 2)) {
                try { const h = await tryDoc(name); if (h) { hit = h; docUsed = name; break; } } catch (_) { /* next */ }
            }
        }
        if (!hit) hit = headcountFromFiling(text, r.fy);
        if (!hit || !hit.years) {
            for (const name of await siblingDocs(cik, r.accession, r.doc)) {
                if (name === docUsed) continue;
                try { const h = await tryDoc(name); if (h) { hit = h; docUsed = name; break; } } catch (_) { /* next */ }
            }
        }
        if (docUsed !== r.doc) r.doc = docUsed;
        // The top candidates are kept beside the winner so a later re-rank, or a
        // human check against the filing, does not need the document again.
        cache.filings[r.accession] = {
            fy: r.fy, form: r.form, date: r.date,
            ...(hit ? { basis: hit.basis, src: hit.src || 'prose', years: hit.years, quote: hit.quote } : {}),
            ...(hit && hit.table ? { table: hit.table } : {}),
            ...(hit && hit.trace && hit.trace.cands ? { alt: hit.trace.cands.slice(0, 3).map((c) => [c.value, c.quote]) } : {})
        };
        if (hit) log(`${issuer.symbol} FY${r.fy} → ${hit.value.toLocaleString('en-US')} (${hit.basis})`);
    }
    cache.fetchedAt = new Date().toISOString();
    cache.readerVersion = READER_VERSION;
    if (!DRY_RUN) {
        fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(cache));
        fs.renameSync(cacheFile + '.tmp', cacheFile);
    }
    return cache;
}

// --------------------------------------------------------------- assembly ---
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function financialHistory(cik) {
    const d = readJson(path.join(DATA, 'sec-financials', `${String(cik).padStart(10, '0')}.json`));
    const rows = (d && d.income && d.income.annualReports) || [];
    const out = new Map();
    for (const r of rows) {
        const year = Number(Number(String(r.fiscalDateEnding || '').slice(0, 4)) || 0);
        if (!year) continue;
        const rev = r.totalRevenue === null || r.totalRevenue === undefined ? null : Number(r.totalRevenue);
        const ni = r.netIncome === null || r.netIncome === undefined ? null : Number(r.netIncome);
        if (rev === null && ni === null) continue;
        out.set(year, { revenue: rev, netIncome: ni, fiscalDateEnding: r.fiscalDateEnding, currency: r.reportedCurrency || null });
    }
    return out;
}

function assemble(symbol, cik, cache, finance) {
    const counts = {};
    for (const rec of Object.values(cache.filings)) {
        if (!rec || !rec.years) continue;
        for (const { year, value } of rec.years) {
            const prev = counts[year];
            const ownFiling = year === rec.fy;
            // a figure read from the report for that same year wins over a
            // comparative quoted by a later report; among equals, the newest wins
            if (prev && !(ownFiling && !prev.own)) continue;
            counts[year] = { value, basis: rec.basis || 'headcount', own: ownFiling, src: rec.src || 'prose', asOf: rec.date, filing: String(rec.date) };
        }
    }
    let years = Object.keys(counts).map(Number).sort((a, b) => b - a);
    if (!years.length) return { cik, counts: {} };

    // Ratio veto: revenue per employee outside $5k-$20M means the number is not
    // the company total (BP's 8,100 "employees" against $200bn of revenue is
    // $25m each; no listed company is that productive). It uses the same filed
    // revenue the dataset reports, so the test is local and reproducible.
    const rejected = [];
    for (const key of Object.keys(counts)) {
        const fin = finance.get(Number(key));
        // only in USD: a JPY or EUR revenue against a headcount is not comparable
        if (!fin || !fin.revenue || fin.revenue <= 0 || (fin.currency && fin.currency !== 'USD')) continue;
        if (!counts[key].value) continue; // 0 employees: nothing to divide, nothing to veto
        const per = fin.revenue / counts[key].value;
        // The veto is an order-of-magnitude test, not a plausibility test. It only
        // exists to catch a reading that is 1000x off — a segment count taken as the
        // total, or a "1.6 million associates in the U.S." quoted for a company with
        // $300m of revenue. Narrower bands deleted real companies in both
        // directions: Pulse Biosciences ($350k revenue, 116 staff = $3k each),
        // Galaxy Digital ($60bn gross revenue, 700 staff = $86m each), DJT, and
        // American Healthcare REIT. Anything inside $1k-$200m per head is kept and
        // the number itself is left to speak or be flagged, not silently dropped.
        if (per < 1e3 || per > 2e8) {
            rejected.push({ year: Number(key), value: counts[key].value, reason: 'revenue-per-employee ' + Math.round(per) });
            delete counts[key];
        }
    }
    years = Object.keys(counts).map(Number).sort((a, b) => b - a);
    if (!years.length) return { cik, counts: {}, ...(rejected.length ? { rejected } : {}) };

    // Fill the years prose never covered from the filing's own table row. This runs
    // AFTER the ratio veto, so a table figure is the last resort for a year with no
    // usable prose reading — it never displaces one.
    for (const rec of Object.values(cache.filings)) {
        if (!rec || !rec.table || !rec.table.years) continue;
        for (const { year, value } of rec.table.years) {
            if (counts[year]) continue;
            if (!(value >= 20) || value > 2.4e6) continue;
            const fin = finance.get(year);
            if (fin && fin.revenue > 0 && (!fin.currency || fin.currency === 'USD')) {
                const per = fin.revenue / value;
                if (per < 2e4 || per > 1e7) continue;
            }
            counts[year] = { value, basis: 'headcount', own: year === rec.fy, src: 'table' };
        }
    }
    years = Object.keys(counts).map(Number).sort((a, b) => b - a);

    // Outliers, anchored on the MEDIAN and tested both ways. Anchoring on the
    // largest value was catastrophic in the other direction: one junk 2,400,000
    // reading (a share-plan row in a 2009 filing) set a 2% floor of 48,000 and
    // deleted Old Second Bancorp's real 800-1,100 staff in every later year.
    // Now a reading 20x from the median either way is recorded as an outlier;
    // growth like Apple's 22k -> 166k or Nvidia's 3,255 -> 42,000 stays inside.
    const outliers = [];
    if (years.length >= 3) {
        const vals = years.map((y) => counts[y].value).slice().sort((a, b) => a - b);
        const median = vals[Math.floor(vals.length / 2)];
        years = years.filter((y) => {
            const v = counts[y].value;
            if (v === 0) return true; // a genuine zero is not an outlier
            if (v >= median * 0.02 && v <= median * 20) return true;
            outliers.push({ year: y, value: v });
            return false;
        });
    }
    if (!years.length) return { cik, counts: {} };
    const latestYear = years[0];
    const latest = counts[latestYear];
    const out = { cik, counts: {} };
    for (const y of years) out.counts[y] = { value: counts[y].value, basis: counts[y].basis, source: counts[y].own ? 'own' : 'comparative', ...(counts[y].src === 'table' ? { from: 'table row' } : {}) };

    const ratioYear = finance.get(latestYear) ? latestYear : latestYear - 1;
    const fin = finance.get(ratioYear) || null;
    if (fin) {
        out.ratio = { year: ratioYear, employees: latest.value, revenue: fin.revenue, netIncome: fin.netIncome, currency: fin.currency || 'USD' };
        // a per-employee figure only means something in the currency the revenue is
        // filed in, and is only comparable across issuers in dollars
        if (fin.currency && fin.currency !== 'USD') out.ratio.note = 'revenue filed in ' + fin.currency + '; per-employee figures are in that currency';
        if (fin.revenue !== null && latest.value) out.ratio.revenuePerEmployee = Math.round(fin.revenue / latest.value);
        if (fin.netIncome !== null && latest.value) out.ratio.netIncomePerEmployee = Math.round(fin.netIncome / latest.value);
        if (!latest.value) out.ratio.note = 'no employees: managed externally';
    }
    out.latest = { year: latestYear, value: latest.value, basis: latest.basis };
    if (outliers.length) out.outliers = outliers;
    if (rejected.length) out.rejected = rejected;
    return out;
}

// -------------------------------------------------------------------- main ---
let quiet = false;
function log(s) { if (!quiet) process.stderr.write(s + '\n'); }

async function main() {
    const index = readJson(path.join(DATA, 'screen-index.json'));
    const rows = (index && index.rows) || [];
    if (!rows.length) throw new Error('frontend/data/screen-index.json has no rows');
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

    let list = rows;
    const explicit = arg('symbols', null);
    if (typeof explicit === 'string' && explicit) {
        list = explicit.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => bySymbol.get(s) || { symbol: s });
    }
    const limit = Number(arg('limit', 0)) || 0;
    if (limit) list = list.slice(0, limit);

    const plan = list.map((r) => ({ symbol: r.symbol, cik: r.cik ? String(r.cik).padStart(10, '0') : null }));
    console.log(`[employee-counts] issuers=${plan.length} depth=${LATEST_ONLY ? 1 : YEARS}y jobs=${JOBS}${DRY_RUN ? ' DRY RUN' : ''}`);
    if (DRY_RUN) {
        console.log(`[employee-counts] would write ${path.relative(process.cwd(), OUT)}; cache ${path.relative(process.cwd(), CACHE)}`);
        return;
    }

    if (REBUILD) {
        const rowsAll = (readJson(path.join(DATA, 'screen-index.json')) || {}).rows || [];
        const out = {};
        for (const r of rowsAll) {
            const cik = r.cik ? String(r.cik).padStart(10, '0') : null;
            if (!cik) continue;
            const cache = readJson(path.join(CACHE, `${cik}.json`));
            // A missing cache is not a verdict: without this guard a wiped cache
            // silently emptied the whole dataset on --rebuild, which is how 4,964
            // readings almost disappeared at 18:55 on 2026-11-04.
            const prior = (readJson(OUT) || {}).symbols || {};
            if (!cache) { if (prior[r.symbol]) out[r.symbol] = prior[r.symbol]; continue; }
            out[r.symbol] = assemble(r.symbol, cik, cache, financialHistory(cik));
        }
        const payload = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            source: 'SEC EDGAR annual reports — Reg S-K Item 101(c)(2) human capital / Form 20-F Item 6.D; ratios use frontend/data/sec-financials',
            depthYears: YEARS,
            count: Object.values(out).filter((x) => x && x.latest).length,
            partial: false,
            symbols: out
        };
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT + '.tmp', JSON.stringify(payload));
        fs.renameSync(OUT + '.tmp', OUT);
        console.log(`[employee-counts] rebuilt from cache: issuers=${Object.keys(out).length} with-counts=${payload.count} → ${path.relative(process.cwd(), OUT)}`);
        return;
    }

    const started = Date.now();
    let symbols = {};
    if (MERGE) {
        const prior = readJson(OUT);
        if (prior && prior.symbols) symbols = prior.symbols;
    }
    const flush = () => {
        const payload = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            source: 'SEC EDGAR annual reports — Reg S-K Item 101(c)(2) human capital / Form 20-F Item 6.D; ratios use frontend/data/sec-financials',
            depthYears: LATEST_ONLY ? 1 : YEARS,
            count: Object.values(symbols).filter((x) => x && x.latest).length,
            partial: true,
            symbols
        };
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT + '.tmp', JSON.stringify(payload));
        fs.renameSync(OUT + '.tmp', OUT);
    };
    let done = 0;
    let nextIdx = 0;
    let missingCik = 0;
    await Promise.all(Array.from({ length: JOBS }, async () => {
        while (nextIdx < plan.length) {
            const item = plan[nextIdx++];
            if (!item.cik) { missingCik += 1; continue; }
            try {
                const cache = await readIssuer(item);
                const finance = financialHistory(item.cik);
                symbols[item.symbol] = assemble(item.symbol, item.cik, cache, finance);
            } catch (e) {
                symbols[item.symbol] = { cik: item.cik, error: String(e.message || e).slice(0, 120) };
                log(`${item.symbol} FAILED ${e.message}`);
            }
            done += 1;
            if (done % 25 === 0) {
                const secs = (Date.now() - started) / 1000;
                const eta = ((plan.length - done) * (secs / done)) / 60;
                log(`[employee-counts] ${done}/${plan.length} in ${secs.toFixed(0)}s (${(secs / done).toFixed(2)}s/issuer, eta ${eta.toFixed(0)}m)`);
            }
            if (done % 200 === 0) flush();
        }
    }));

    flush();
    const withCounts = Object.values(symbols).filter((s) => s.latest);
    const payload = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        source: 'SEC EDGAR annual reports — Reg S-K Item 101(c)(2) human capital / Form 20-F Item 6.D; ratios use frontend/data/sec-financials',
        depthYears: LATEST_ONLY ? 1 : YEARS,
        count: withCounts.length,
        partial: false,
        symbols
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT + '.tmp', JSON.stringify(payload));
    fs.renameSync(OUT + '.tmp', OUT);

    const ratios = withCounts.filter((s) => s.ratio && s.ratio.revenuePerEmployee);
    const secs = (Date.now() - started) / 1000;
    console.log(`[employee-counts] issuers=${plan.length} with-counts=${withCounts.length} with-revenue-per-employee=${ratios.length} no-cik=${missingCik} in ${secs.toFixed(0)}s → ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) main().catch((e) => { console.error('[employee-counts] failed:', e.message); process.exit(1); });
module.exports = { headcountFromFiling, noEmployeesStatement, assemble, financialHistory, sentenceAround, alignSeries, numbersIn, htmlToText, lastTrace: () => trace, tableHeadcount, rules: () => ({ PARTIAL_QUALIFIER, NOT_A_COUNT_SPAN, RELATION_SPAN, SUBSET_PLACE, SUBSET_ACTIVITY }) };
