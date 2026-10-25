'use strict';
// Primary financial statements for issuers whose SEC filings carry no XBRL.
//
// Some listed issuers file their statements as HTML only (royalty trusts on
// 10-K, ICICI Bank's 20-F, new foreign listings whose only financial document is
// a prospectus or a 6-K), so SEC companyfacts has nothing and the stock page shows
// no statements. This reads the statement tables out of the filing HTML with
// fixed rules: no model, nothing estimated, nothing derived except the scale
// multiplication and a period start computed from a printed end date and a
// printed duration.
//
// A statement is kept only when
//   - its title sits directly above the table and the registrant's name is near it,
//   - every kept column has a printed date (and, for flows, a printed or
//     form-implied duration of a quarter or a year),
//   - the scale and currency are stated (a bare "$" counts only for a US filer),
//   - total assets equal total liabilities and equity where those lines are
//     printed, and the other printed identities that can be checked hold
//     (current + non-current, gross profit, cash-flow sections, trust income).
// A failed check rejects the whole statement, and the reason is logged.
// Every value keeps a receipt: the row label and the cell text as printed.
//
// Output goes to the committed store frontend/data/supplemental-financials/<CIK>.json
// as sourceType 'issuer_release' (the store refuses 'sec_filing'), merged with
// whatever the file already holds.
//
//   node scripts/extract-html-statements.js --discover            # list the issuers that qualify
//   node scripts/extract-html-statements.js PBT IBN SKHY --write  # extract and write those
//   node scripts/extract-html-statements.js --all --write         # every qualifying issuer
// Options: --cache DIR (downloaded filings; untrusted data, keep it separate),
// --log FILE (JSON run log), --jobs N (parser threads, default cores-1).
// SEC requests go through backend/sec-throttle (8 per second, one process).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const BACKEND = path.join(__dirname, '..', 'backend');
const { Parser } = require(require.resolve('htmlparser2', { paths: [BACKEND] }));

const EXTRACTION_VERSION = '20261017-html1';
const SOURCE_NAME = 'SEC EDGAR filing (HTML statements, no XBRL)';
const UA = 'StockPortfolio research support@stockportfolio.pro';
// Pass-through certificates carry no operating statements; FDIC filers are handled
// by scripts/fetch-fdic-financials.js.
const SKIP_SYMBOLS = new Set('OZK HIFS TOWN NBN SSBI RCBC FRBA ASBH WCCB JBK KTN PYT GJH GJO GJP GJR GJS GJT'.split(' '));

// ───────────────────────── text and numbers ─────────────────────────

function clean(s) {
    return String(s || '').replace(/[    ]/g, ' ').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

const CURRENCY_TOKEN = /^(?:US\$|U\.S\.\$|C\$|CDN\$|A\$|HK\$|NT\$|S\$|R\$|\$|₩|W|Rs\.?|₹|€|£|¥|RMB|KRW|INR|USD|EUR|GBP|JPY|CNY|CAD|AUD)(?=[\s\d(\-−.—–]|$)\s*/i;
const DASH = /^[—–‒―−\-‑]+$/;

// One printed amount. kind: number | zero (a dash) | blank | nil (".." / n/a) | invalid.
function parseAmount(raw) {
    let s = clean(raw);
    for (let i = 0; i < 3; i++) { const t = s.replace(CURRENCY_TOKEN, ''); if (t === s) break; s = t.trim(); }
    s = s.replace(/\s+/g, '');
    if (!s) return { kind: 'blank', value: null };
    if (DASH.test(s) || /^nil$/i.test(s)) return { kind: 'zero', value: 0 };
    if (/^(\.\.|n\/?a|nm|—\)|\*)$/i.test(s)) return { kind: 'nil', value: null };
    let neg = false;
    if (s.startsWith('(')) { neg = true; s = s.slice(1); if (s.endsWith(')')) s = s.slice(0, -1); }
    else if (s.endsWith(')')) return { kind: 'invalid', value: null };
    if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1); }
    for (let i = 0; i < 2; i++) { const t = s.replace(CURRENCY_TOKEN, ''); if (t === s) break; s = t.trim(); }
    if (DASH.test(s)) return { kind: 'zero', value: 0 };
    if (!/^(?:(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)(?:\.\d+)?|\.\d+)$/.test(s)) return { kind: 'invalid', value: null };
    const value = Number(s.replace(/,/g, ''));
    if (!Number.isFinite(value)) return { kind: 'invalid', value: null };
    return { kind: 'number', value: neg ? -value : value, decimals: (s.split('.')[1] || '').length };
}

// Scale words stated for a table. Returns {scale, phrase} or {ambiguous:[...]} or null.
function parseScale(text) {
    const t = clean(text);
    const words = { thousand: 1e3, thousands: 1e3, million: 1e6, millions: 1e6, billion: 1e9, billions: 1e9, lakh: 1e5, lakhs: 1e5, crore: 1e7, crores: 1e7 };
    const found = new Map();
    const re = /(?:\bin\b|\bexpressed in\b|\bamounts in\b|\(|\bof\b)[^()]{0,45}?\b(thousands?|millions?|billions?|lakhs?|crores?)\b/gi;
    let m;
    while ((m = re.exec(t))) {
        const before = t.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
        if (/except\s*$/.test(before)) continue;
        found.set(words[m[1].toLowerCase()], m[0]);
    }
    // a header cell that opens with the bare word: "Thousands, except per-share amounts"
    const lead = /^\(?\s*(?:us\$|\$|₩|rs\.?)?\s*(thousands|millions|billions|lakhs|crores)\b/i.exec(t);
    if (lead) found.set(words[lead[1].toLowerCase()], lead[0]);
    const k = /(?:\(|\b)(?:\$|₩|rs\.?|us\$)?\s*(?:'000|000s|000's|000'?s omitted)\b/i.exec(t)
        || /(?:^|[\s(])(?:US\$|HK\$|S\$|C\$|A\$|\$|€|£|¥|₩|RMB|Rs\.?|[A-Z]{3})\s?['’]?000(?![\d,.])/.exec(t);
    if (k) found.set(1e3, k[0]);
    if (!found.size) return null;
    if (found.size > 1) return { ambiguous: [...found.values()] };
    const [[scale, phrase]] = [...found.entries()];
    return { scale, phrase: clean(phrase) };
}

const CURRENCIES = [
    ['KRW', /\bkorean won\b|\bwon\b(?=[\s,).]|$)|₩|\bKRW\b/i],
    ['INR', /\b(?:indian )?rupees?\b|\bRs\.|₹|\bINR\b/i],
    ['USD', /\bU\.?\s?S\.? dollars?\b|\bUS\$|\bUSD\b|\bunited states dollars?\b/i],
    ['CAD', /\bcanadian dollars?\b|\bC\$|\bCDN\$|\bCAD\b/i],
    ['EUR', /\beuros?\b|€|\bEUR\b/i],
    ['GBP', /\bpounds? sterling\b|£|\bGBP\b/i],
    ['CNY', /\brenminbi\b|\bRMB\b|\bCNY\b/i],
    ['HKD', /\bhong kong dollars?\b|\bHK\$|\bHKD\b/i],
    ['JPY', /\bjapanese yen\b|\bJPY\b/i],
    ['AUD', /\baustralian dollars?\b|\bA\$|\bAUD\b/i],
    ['CHF', /\bswiss francs?\b|\bCHF\b/i],
    ['ILS', /\bnew israeli shekels?\b|\bNIS\b|\bILS\b/i],
    ['SGD', /\bsingapore dollars?\b|\bS\$|\bSGD\b/i],
    ['TWD', /\bnew taiwan dollars?\b|\bNT\$|\bTWD\b/i],
    ['BRL', /\bbrazilian reais\b|\bR\$|\bBRL\b/i],
    ['MYR', /\bringgit\b|\bMYR\b/i],
    ['SEK', /\bswedish kron(?:a|or)\b|\bSEK\b/i],
    ['DKK', /\bdanish kron(?:e|er)\b|\bDKK\b/i],
    ['NOK', /\bnorwegian kron(?:e|er)\b|\bNOK\b/i],
];
// Currencies named in a stretch of header or title text.
function currenciesIn(text) {
    const t = clean(text), out = new Set();
    for (const [code, re] of CURRENCIES) if (re.test(t)) out.add(code);
    return out;
}
// Currency symbols standing alone in a value cell.
function symbolCurrency(cellText) {
    const s = clean(cellText);
    if (/^(?:US\$|U\.S\.\$)$/i.test(s)) return 'USD';
    if (s === '$') return '$';
    if (/^(?:₩|W)$/.test(s)) return 'KRW';
    if (/^(?:Rs\.?|₹)$/.test(s)) return 'INR';
    if (s === '€') return 'EUR';
    if (s === '£') return 'GBP';
    if (/^(?:RMB)$/.test(s)) return 'CNY';
    if (/^(?:C\$|CDN\$)$/.test(s)) return 'CAD';
    if (/^HK\$$/.test(s)) return 'HKD';
    if (/^A\$$/.test(s)) return 'AUD';
    return null;
}

const DOLLAR_CURRENCIES = new Set(['USD', 'CAD', 'AUD', 'HKD', 'SGD', 'TWD', 'NZD']);
// The currency the filing says its statements are presented in, when it names exactly one.
function presentationCurrency(text) {
    const t = clean(text), found = new Map();
    const re = /(?:(?:presentation|reporting) currency(?: of the (?:group|company|trust|partnership))? (?:is|was|are) (?:the )?|(?:financial statements|amounts|figures) (?:are |have been )?(?:presented|expressed|stated|reported|prepared) in (?:thousands of |millions of |billions of )?)([A-Za-z.$ ]{2,40})/gi;
    let m, n = 0;
    while ((m = re.exec(t)) && n < 200) {
        n++;
        re.lastIndex = m.index + m[0].length - m[1].length; // a phrase can start inside the previous capture
        const near = t.slice(Math.max(0, m.index - 200), m.index + m[0].length + 60);
        if (/convenience/i.test(near)) continue;
        const c = currenciesIn(m[1]);
        if (c.size === 1) { const k = [...c][0]; found.set(k, (found.get(k) || 0) + 1); }
    }
    return found.size === 1 ? [...found.keys()][0] : null;
}

// ───────────────────────── dates and periods ─────────────────────────

const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function validDay(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }
function fullDates(text) {
    const t = clean(text), out = [];
    let m;
    const a = new RegExp(MONTH_RE + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*((?:19|20)\\d{2})\\b', 'gi');
    while ((m = a.exec(t))) { const mo = MONTH[m[1].slice(0, 3).toLowerCase()], d = +m[2], y = +m[3]; if (validDay(y, mo, d)) out.push({ y, m: mo, d, at: m.index }); }
    const b = new RegExp('\\b(\\d{1,2})\\s+' + MONTH_RE + ',?\\s+((?:19|20)\\d{2})\\b', 'gi');
    while ((m = b.exec(t))) { const mo = MONTH[m[2].slice(0, 3).toLowerCase()], d = +m[1], y = +m[3]; if (validDay(y, mo, d)) out.push({ y, m: mo, d, at: m.index }); }
    const c = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g;
    while ((m = c.exec(t))) { const y = +m[1], mo = +m[2], d = +m[3]; if (validDay(y, mo, d)) out.push({ y, m: mo, d, at: m.index }); }
    return out.sort((x, y) => x.at - y.at);
}
// "December 31," with no year next to it.
function monthDays(text) {
    const t = clean(text), out = [];
    let m;
    const a = new RegExp(MONTH_RE + '\\s+(\\d{1,2})\\b(?:st|nd|rd|th)?', 'gi');
    while ((m = a.exec(t))) out.push({ m: MONTH[m[1].slice(0, 3).toLowerCase()], d: +m[2] });
    const b = new RegExp('\\b(\\d{1,2})\\s+' + MONTH_RE + '(?![a-z])', 'gi');
    while ((m = b.exec(t))) out.push({ m: MONTH[m[2].slice(0, 3).toLowerCase()], d: +m[1] });
    return out;
}
const uniq = (list, f) => [...new Map(list.map(x => [f(x), x])).values()];
function yearsIn(text) { return [...new Set((clean(text).match(/\b(?:19|20)\d{2}\b/g) || []).map(Number))]; }

// Months covered by a column, from its own and parent header text.
function durationOf(text) {
    const t = clean(text).toLowerCase();
    const hits = new Set();
    if (/\b(?:three|3)[- ]months?\b|\bquarters? ended\b|\bthirteen[- ]weeks?\b|\b13[- ]weeks?\b|\bthree[- ]month\b/.test(t)) hits.add(3);
    if (/\b(?:six|6)[- ]months?\b|\btwenty[- ]six[- ]weeks?\b|\b26[- ]weeks?\b|\bsix[- ]month\b|\bhalf[- ]year\b/.test(t)) hits.add(6);
    if (/\b(?:nine|9)[- ]months?\b|\b39[- ]weeks?\b|\bnine[- ]month\b/.test(t)) hits.add(9);
    if (/\byears? ended\b|\byears? ending\b|\btwelve[- ]months?\b|\b12[- ]months?\b|\bfiscal years?\b|\b5[23][- ]weeks?\b|\bfor the years?\b|\byear ended\b|\bannual\b/.test(t)) hits.add(12);
    return hits;
}
function weeksOf(text) { const m = /\b(52|53)[- ]weeks?\b/i.exec(clean(text)); return m ? +m[1] : null; }
function addDays(isoDay, n) { const t = new Date(isoDay + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function isMonthEnd(isoDay) { return addDays(isoDay, 1).slice(8) === '01'; }
function startForMonths(end, months) {
    const [y, m] = end.split('-').map(Number);
    let sm = m - months + 1, sy = y;
    while (sm < 1) { sm += 12; sy--; }
    return iso(sy, sm, 1);
}

// ───────────────────────── HTML tables ─────────────────────────

function decodeHtml(buffer) {
    if (typeof buffer === 'string') return buffer;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch (_) { return new TextDecoder('windows-1252').decode(buffer); }
}

// Every table with its rows on a column grid (colspan honoured), the text
// between it and the previous table, and the running document text.
function parseTables(html) {
    const tables = [];
    const stack = [];
    let table = null, row = null, cell = null, hidden = 0, sup = 0, supText = '';
    const parts = [];
    let length = 0, lastTableEnd = 0;
    const push = (s) => { if (!s) return; parts.push(s); length += s.length; };
    const BLOCK = new Set(['p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table']);
    const parser = new Parser({
        onopentag(name, attrs) {
            if (name === 'script' || name === 'style' || name === 'head') { hidden++; return; }
            if (BLOCK.has(name)) { if (cell) cell.text += ' '; else push(' '); }
            if (name === 'sup') { sup++; supText = ''; return; }
            if (name === 'table') {
                stack.push({ table, row, cell });
                table = { index: tables.length, start: length, gapStart: lastTableEnd, rows: [] };
                tables.push(table); row = null; cell = null;
            } else if (name === 'tr' && table) row = [];
            else if ((name === 'td' || name === 'th') && row) {
                const span = Math.max(1, Math.min(60, parseInt(attrs.colspan, 10) || 1));
                cell = { text: '', span };
            }
        },
        ontext(text) {
            if (hidden) return;
            if (sup) { supText += text; return; }
            if (cell) cell.text += text;
            push(text);
        },
        onclosetag(name) {
            if (name === 'script' || name === 'style' || name === 'head') { hidden = Math.max(0, hidden - 1); return; }
            if (name === 'sup') {
                sup = Math.max(0, sup - 1);
                const s = clean(supText);
                // Footnote markers are dropped; anything else in a superscript is kept.
                if (s && !/^(?:\(?[0-9]{1,2}\)?|\(?[a-z]\)?|\(?[ivx]{1,4}\)?|\*{1,3}|[†‡§¶]+)(?:[,\s]+(?:\(?[0-9]{1,2}\)?|\(?[a-z]\)?))*$/i.test(s)) { if (cell) cell.text += s; push(s); }
                supText = '';
                return;
            }
            if ((name === 'td' || name === 'th') && cell && row) { row.push({ text: clean(cell.text), span: cell.span }); cell = null; }
            else if (name === 'tr' && row && table) {
                let c = 0;
                const cells = row.map(x => { const out = { text: x.text, c0: c, c1: c + x.span - 1 }; c += x.span; return out; });
                if (cells.some(x => x.text)) table.rows.push(cells);
                row = null;
            } else if (name === 'table' && table) {
                table.end = length;
                const prev = stack.pop() || {};
                if (!prev.table) lastTableEnd = length;
                table = prev.table; row = prev.row; cell = prev.cell;
            }
            if (BLOCK.has(name)) { if (cell) cell.text += ' '; else push(' '); }
        },
    }, { decodeEntities: true });
    parser.write(html); parser.end();
    const text = parts.join('');
    return { tables: tables.filter(t => t.rows.length), text };
}

// ───────────────────────── statement titles ─────────────────────────

const TITLES = [
    ['exclude', /\bstatements? of changes in (?:trust corpus|equity|net assets|stockholders|shareholders|members|partners|owners|capital)[a-z' ]*|\bstatements? of (?:stockholders|shareholders|members|partners)['’]? (?:equity|deficit)|\bchanges in (?:stockholders|shareholders)['’]? equity/gi],
    ['balance', /\bbalance sheets?\b|\bstatements? of (?:consolidated )?(?:financial position|financial condition|condition)\b|\bstatements? of assets,? liabilities,? and (?:trust corpus|net assets|trust equity|equity)\b|\bstatements? of assets and liabilities\b/gi],
    ['income', /\bstatements? of (?:consolidated )?(?:operations|income|earnings|loss|net loss|comprehensive (?:income|loss)|profit (?:or|and) loss|distributable income|operations and comprehensive (?:income|loss)|income and comprehensive income|loss and comprehensive loss|comprehensive income \(loss\)|comprehensive loss \(income\))\b|\bincome statements?\b|\bprofit and loss account\b/gi],
    ['cash', /\bstatements? of (?:consolidated )?cash flows?\b|\bcash flows? statements?\b/gi],
];
// Titles that name a statement but are not one: summaries, MD&A extracts, pro forma.
const NOT_STATEMENT = /\b(?:summary|summarized|selected|pro forma|combining|consolidating|guarantor|parent company only|condensed financial information of (?:the )?registrant|schedule i\b|quarterly (?:financial )?(?:data|results)|segment|reconciliation|data\b|information\b|supplemental|non-gaap|illustrative)/i;

// The statement title nearest above the table (in the gap text or the table's own header rows).
function statementTitle(gap, headerText) {
    const near = clean(gap).slice(-700);
    const sources = [[near, true], [clean(headerText), false]];
    for (const [text, isGap] of sources) {
        let best = null;
        for (const [type, re] of TITLES) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text))) if (!best || m.index >= best.at) best = { type, at: m.index, title: m[0] };
        }
        if (!best) continue;
        if (best.type === 'exclude') return { excluded: best.title };
        const after = text.slice(best.at, best.at + best.title.length + 40);
        const before = text.slice(Math.max(0, best.at - 160), best.at);
        if (NOT_STATEMENT.test(after.slice(0, best.title.length + 25)) || NOT_STATEMENT.test(before.slice(-60))) return { excluded: best.title };
        if (/following table|table below|as follows|sets? forth|derived from|included (?:in|elsewhere)|refer to|see (?:the|our)|read in conjunction/i.test(before)) return { excluded: best.title };
        // A title found only inside the table's own rows ("Income statement") belongs to a note table when the
        // text just above names one (summarized financial information of an associate, a segment table).
        if (!isGap && (NOT_STATEMENT.test(near.slice(-250)) || /\bassociates?\b|joint ventures?|investees?|equity[- ]accounted|equity method|following table|as follows/i.test(near.slice(-250)))) return { excluded: best.title };
        // Title must be close to the table: within the last ~450 characters of the gap.
        if (isGap && text.length - best.at > 450) continue;
        const context = (isGap ? text.slice(Math.max(0, best.at - 250)) : text);
        return { type: best.type, title: best.title, context, caption: text.slice(best.at), consolidated: /\bconsolidated\b|\bcombined\b/i.test(context.slice(0, 600)), interim: /\binterim\b|\bunaudited\b/i.test(context) };
    }
    return null;
}

// ───────────────────────── one table → columns and rows ─────────────────────────

const YEAR_CELL = /^\(?(?:19|20)\d{2}\)?(?:\s*\([0-9a-z]\))?$/i;
function isHeaderRow(row) {
    const nums = row.map(c => c.text).filter(t => t && parseAmount(t).kind === 'number');
    return nums.every(t => YEAR_CELL.test(t.replace(/\s+/g, '')) || /^(?:19|20)\d{2}$/.test(t));
}

// Reads the column header: which grid spans are periods, which is a notes column.
function readColumns(table, title, docCtx) {
    const rows = table.rows;
    let firstData = rows.findIndex(r => !isHeaderRow(r));
    if (firstData < 0) return { error: 'no data rows' };
    const header = rows.slice(0, firstData);
    // the lowest header row holding a year is the leaf row of period columns
    let leafIndex = -1;
    for (let i = header.length - 1; i >= 0; i--) if (header[i].some(c => yearsIn(c.text).length && !/\bnotes?\b/i.test(c.text) && c.c0 > 0)) { leafIndex = i; break; }
    if (leafIndex < 0) return { error: 'no year in column headers' };
    let leaf = header[leafIndex].filter(c => yearsIn(c.text).length && c.c0 > 0);
    // "2026" over "Three months | Six months": the duration row below splits each year column
    for (let i = leafIndex + 1; i < header.length; i++) {
        const sub = header[i].filter(c => c.c0 > 0 && durationOf(c.text).size === 1 && !yearsIn(c.text).length);
        if (sub.length > leaf.length && sub.every(c => leaf.some(l => l.c0 <= c.c0 && c.c1 <= l.c1))) { leaf = sub; leafIndex = i; break; }
    }
    const notes = [];
    for (const r of header) for (const c of r) if (/^(?:notes?|note ref\.?|schedules?|note no\.?)$/i.test(c.text)) notes.push([c.c0, c.c1]);
    const overlap = (a0, a1, b0, b1) => a0 <= b1 && b0 <= a1;
    const periods = [];
    for (const c of leaf) {
        const anc = header.slice(0, leafIndex).flatMap(r => r.filter(x => x.text && overlap(x.c0, x.c1, c.c0, c.c1)).map(x => x.text));
        const below = header.slice(leafIndex + 1).flatMap(r => r.filter(x => x.text && overlap(x.c0, x.c1, c.c0, c.c1)).map(x => x.text));
        periods.push({ c0: c.c0, c1: c.c1, own: c.text, anc: anc.join(' | '), below: below.join(' | ') });
    }
    const headerText = header.map(r => r.map(c => c.text).join(' ')).join(' \n ');
    const firstCol = Math.min(...periods.map(p => p.c0));
    const headerLabels = header.slice(leafIndex).map(r => r.filter(c => c.c1 < firstCol && c.text).map(c => c.text).join(' ')).filter(Boolean);
    return { firstData, header, headerText, periods, notes, headerLabels };
}

// Resolves each period column to an end date (and for flows, a start date).
function resolvePeriods(cols, title, ctx, log) {
    const caption = clean(title.caption ?? title.context);
    const capDates = fullDates(caption);
    const capMonthDays = uniq([...capDates.map(d => ({ m: d.m, d: d.d })), ...monthDays(caption)], x => x.m + '-' + x.d);
    const out = [];
    for (const p of cols.periods) {
        const own = p.own;
        const colText = [p.anc, own].join(' ');
        const colCur = [...currenciesIn([p.anc, own, p.below].join(' '))];
        if (ctx.tableCurrency && colCur.length && !colCur.includes(ctx.tableCurrency)) { log.push(`column "${own}" is in ${colCur.join('/')}, not the statement currency ${ctx.tableCurrency}; dropped`); continue; }
        if (/\bUS\$|\bU\.S\.\s?dollars?\b|\bconvenience\b|\bUSD\b/i.test(colText) && ctx.tableCurrency && ctx.tableCurrency !== 'USD') { log.push(`column "${own}" is a convenience translation; dropped`); continue; }
        if (/\bpro forma\b|\bas adjusted\b|\bchange\b|%|\bvariance\b/i.test(colText)) { log.push(`column "${own}" is not a reported period; dropped`); continue; }
        let end = null;
        const own2 = fullDates(own);
        if (own2.length === 1) end = own2[0];
        else if (own2.length > 1) {
            // "Period from X to Y" carries two dates; anything else is ambiguous.
            log.push(`column "${own}" holds ${own2.length} dates; dropped`); continue;
        } else {
            let ys = yearsIn(own);
            if (!ys.length) ys = yearsIn(p.anc);
            if (ys.length !== 1) { log.push(`column "${own}" has no single year; dropped`); continue; }
            const ancDates = fullDates(p.anc).filter(d => d.y === ys[0]);
            const ancMd = uniq(monthDays(p.anc), x => x.m + '-' + x.d);
            let md = null;
            if (ancDates.length === 1) md = ancDates[0];
            else if (ancMd.length === 1) md = ancMd[0];
            else if (!ancMd.length && capMonthDays.length === 1) md = capMonthDays[0];
            if (!md || !validDay(ys[0], md.m, md.d)) { log.push(`column "${own}" has no printed month and day`); continue; }
            end = { y: ys[0], m: md.m, d: md.d };
        }
        const periodEnd = iso(end.y, end.m, end.d);
        let months = null, weeks = null;
        if (title.type !== 'balance') {
            const own3 = durationOf(own), anc3 = durationOf(p.anc), cap3 = durationOf(caption);
            const pick = own3.size === 1 ? own3 : own3.size ? null : anc3.size === 1 ? anc3 : anc3.size ? null : cap3.size === 1 ? cap3 : null;
            if (pick) months = [...pick][0];
            else if (!own3.size && !anc3.size && !cap3.size && /^(?:10-K|10-KT|20-F|40-F)/.test(ctx.form) && !/\binception\b|\bperiod\b|\bthrough\b/i.test(colText + ' ' + caption) && monthDays(own).length < 2) { months = 12; log.push(`column "${own}" duration taken from the annual form ${ctx.form}`); }
            if (!months) { log.push(`column "${own}" has no single printed duration; dropped`); continue; }
            weeks = weeksOf(colText) || weeksOf(caption);
        }
        out.push({ ...p, periodEnd, months, weeks, header: clean([p.anc, own].filter(Boolean).join(' ')) });
    }
    // Flow starts: a month-end close counts whole months back; a 52/53-week year
    // starts the day after the prior column of the same length, or from a printed week count.
    for (const p of out) {
        if (!p.months) continue;
        if (p.months !== 3 && p.months !== 12) { p.skip = `${p.months}-month column is neither a quarter nor a year`; continue; }
        if (isMonthEnd(p.periodEnd)) { p.periodStart = startForMonths(p.periodEnd, p.months); continue; }
        const prior = out.filter(q => q !== p && q.months === p.months && q.periodEnd < p.periodEnd).map(q => q.periodEnd).sort().pop();
        const gapDays = prior ? (Date.parse(p.periodEnd) - Date.parse(prior)) / 86400000 : null;
        if (p.months === 12 && prior && gapDays >= 357 && gapDays <= 378) p.periodStart = addDays(prior, 1);
        else if (p.months === 3 && prior && gapDays >= 84 && gapDays <= 98) p.periodStart = addDays(prior, 1);
        else if (p.months === 12 && p.weeks) p.periodStart = addDays(p.periodEnd, -(p.weeks * 7) + 1);
        else p.skip = 'non-month-end period with no prior column or printed week count';
    }
    return out;
}

// ───────────────────────── labels → field ids ─────────────────────────

function normLabel(raw) {
    let s = clean(raw).toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"');
    s = s.replace(/\((?:note|notes|refer|see|schedule)[^)]*\)/g, ' ');
    s = s.replace(/\([^)]*\d[^)]*\)/g, ' ');                // "(46,608,796 units)", "(1)"
    s = s.replace(/\((?:[a-h]|[ivx]{1,4})\)/g, ' ');          // "(a)", "(ii)"
    s = s.replace(/\(\s*[+\s]*\)/g, ' ').replace(/(?:^|\s)\+(?=\s|$)/g, ' ');   // what is left of "((i)+(ii))" and "(a) + (b)"
    s = s.replace(/\((?:in |expressed in )?(?:korean won|won|rs\.?|indian rupees|rupees|u\.?s\.? dollars|dollars|us\$|\$|₩|usd|krw|inr|eur|euros?)\)/g, ' ');
    s = s.replace(/[*†‡§]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/[:;,.\s—–-]+$/, '').replace(/^[\s—–-]+/, '').trim();
    return s;
}

const AMOUNT = 'money', PER_SHARE = 'perShare', CHECK = 'check';
// [statement, field, regex, options]. Labels must match whole, after normLabel.
const RULES = [
    // income
    ['income', 'totalRevenue', /^(?:total )?(?:net )?(?:revenues?|sales|net sales|operating revenues?|revenues?, net|sales, net|revenue from contracts? with customers|turnover)$/],
    ['income', 'totalRevenue', /^royalty income$/, { trust: true }],
    ['income', 'costOfRevenue', /^(?:total )?cost of (?:revenues?|sales|goods sold|products sold)$/],
    ['income', 'grossProfit', /^gross (?:profit|margin)(?: \((?:loss)\))?$|^gross (?:loss|profit) \((?:profit|loss)\)$/],
    ['income', 'researchAndDevelopment', /^research and development(?: expenses?| costs?)?$/],
    ['income', 'sellingGeneralAndAdministrative', /^(?:selling, general,? and administrative|selling, general & administrative|selling and administrative)(?: expenses?| costs?)?$/],
    ['income', 'operatingExpenses', /^total operating expenses$|^operating expenses$/, { bankOrTotal: true }],
    ['income', 'operatingIncome', /^(?:operating (?:income|profit)|income from operations|operating (?:income|profit) \(loss\)|operating (?:loss|profit|income)|(?:income|loss) \((?:loss|income)\) from operations|(?:loss|income) from operations|operating loss \(income\)|profit \(loss\) from operations|operating profit \/ \(loss\))$/],
    ['income', 'interestIncome', /^interest income$|^interest earned$/],
    ['income', 'interestExpense', /^interest expense$|^interest expended$/],
    ['income', 'incomeBeforeTax', /^(?:net )?(?:income|profit|earnings|loss)(?: \((?:loss|income)\))?(?: ?\/ ?\((?:loss|income)\))? before (?:provision for )?(?:income )?tax(?:es|ation| expense)?(?: \(benefit\)| expense \(benefit\))?$|^(?:income|profit|loss)(?: \((?:loss|income)\))? before income taxes$/],
    ['income', 'incomeTaxExpense', /^(?:income tax(?:es)?(?: expense)?(?: \(benefits?\))?|provision for income taxes|provision for \(benefit from\) income taxes|income tax expense \(benefits?\)|income taxes? \(expense\) benefit|tax expense)$/, { tax: true }],
    ['income', 'netIncome', /^(?:net (?:income|loss|profit|earnings)(?: \((?:loss|income)\))?|net (?:loss|income) and comprehensive (?:loss|income)|profit(?: \(loss\))?(?: for the (?:year|period))?|(?:loss|profit) for the (?:year|period)|profit \(loss\) for the (?:year|period)|net profit for the (?:year|period))$/, { net: true }],
    ['income', 'netIncome', /^(?:net (?:income|loss|profit)(?: \((?:loss|income)\))?|profit(?: \(loss\))?|consolidated profit(?:\/\(loss\))?(?: for the (?:year|period))?) attributable to (?:the group|owners of the (?:parent|company)(?: company)?|equity holders of the (?:parent|company)|shareholders of the (?:parent|company)|controlling interests?|the company)$/, { parent: true }],
    ['income', 'netIncome', /^distributable income$/, { trust: true, distributable: true }],
    ['income', 'eps', /^(?:basic(?: (?:earnings|net income|net loss|income|loss)(?: \((?:loss|income)\))?)? per (?:common |ordinary )?share|(?:net )?(?:income|earnings|loss)(?: \((?:loss|income)\))? per (?:common |ordinary )?share,? (?:—|-|–)? ?basic|basic earnings \(loss\) per share|basic)$/, { kind: PER_SHARE, eps: 'basic' }],
    ['income', 'dilutedEPS', /^(?:diluted(?: (?:earnings|net income|net loss|income|loss)(?: \((?:loss|income)\))?)? per (?:common |ordinary )?share|(?:net )?(?:income|earnings|loss)(?: \((?:loss|income)\))? per (?:common |ordinary )?share,? (?:—|-|–)? ?diluted|diluted earnings \(loss\) per share|diluted)$/, { kind: PER_SHARE, eps: 'diluted' }],
    ['income', 'eps+dilutedEPS', /^(?:basic and diluted(?: (?:earnings|net income|net loss|income|loss)(?: \((?:loss|income)\))? per (?:common |ordinary )?share)?|(?:net )?(?:income|earnings|loss)(?: \((?:loss|income)\))? per (?:common |ordinary )?share,? (?:—|-|–)? ?basic and diluted)$/, { kind: PER_SHARE, eps: 'both' }],
    ['income', 'eps', /^distributable income per unit$/, { kind: PER_SHARE, trust: true }],
    ['income', 'trustTotalIncome', /^total income$/, { kind: CHECK, trust: true }],
    ['income', 'trustTotalExpenses', /^total (?:expenditures|expenses)$/, { kind: CHECK, trust: true }],
    // balance
    ['balance', 'totalAssets', /^total assets$/],
    ['balance', 'totalLiabilities', /^total liabilities$/],
    ['balance', 'totalCurrentAssets', /^total current assets$/],
    ['balance', 'totalNonCurrentAssets', /^total non-?current assets$/],
    ['balance', 'totalCurrentLiabilities', /^total current liabilities$/],
    ['balance', 'totalNonCurrentLiabilities', /^total non-?current liabilities$/],
    ['balance', 'totalShareholderEquity', /^total (?:stockholders'?|shareholders'?|share ?holders'?|owners'?) (?:equity|deficit|deficiency|equity \((?:deficit|deficiency)\)|(?:deficit|deficiency) \(equity\)|\((?:deficit|deficiency)\) equity)$|^total equity(?: \((?:deficit|deficiency)\))?$|^total (?:members'?|partners'?) (?:equity|capital|deficit)(?: \(deficit\))?$|^total (?:deficit|capital deficiency)$|^(?:total )?net equity$/, { equity: true }],
    ['balance', 'totalShareholderEquity', /^total equity attributable to (?:owners|equity holders|shareholders|stockholders) of the (?:parent|company)(?: company)?$/, { parent: true }],
    ['balance', 'totalShareholderEquity', /^trust corpus\b/, { trust: true }],
    ['balance', 'totalLiabilitiesAndEquity', /^total liabilities\b.*\b(?:and|&) .*\b(?:equity|deficit|deficiency|capital|net investment|net parent investment|trust corpus|net assets)(?: \((?:deficit|deficiency)\))?$|^total capital and liabilities$|^total equity and liabilities$|^total (?:(?:stockholders|shareholders|shareholder|members|partners)'?s?'? )?(?:equity|deficit|deficiency)(?: \((?:deficit|deficiency)\))? and liabilities$/, { kind: CHECK }],
    ['balance', 'cashAndCashEquivalentsAtCarryingValue', /^cash and cash equivalents$|^cash and equivalents$|^cash$/],
    ['balance', 'cashAndShortTermInvestments', /^cash and short-term investments$/],
    ['balance', 'shortTermInvestments', /^short-term investments$/],
    ['balance', 'currentNetReceivables', /^(?:trade |accounts )?receivables?(?:, net)?$|^accounts receivable(?:, net)?(?: of allowances?.*)?$|^trade (?:and other )?receivables(?:, net)?$|^trade accounts receivable(?:, net)?$/, { section: 'current assets' }],
    ['balance', 'inventory', /^inventor(?:y|ies)(?:, net)?$/],
    ['balance', 'propertyPlantEquipment', /^property,? plant,? and equipment(?:, net)?$|^property and equipment(?:, net)?$|^property, plant and equipment, net of accumulated depreciation.*$|^property and equipment, net of accumulated depreciation.*$/],
    ['balance', 'goodwill', /^goodwill(?: on consolidation)?$/],
    ['balance', 'intangibleAssetsExcludingGoodwill', /^intangible assets(?:, net)?$|^other intangible assets(?:, net)?$/],
    ['balance', 'deferredTaxAssets', /^deferred (?:income )?tax assets?(?:, net)?$/],
    ['balance', 'operatingLeaseRightOfUseAsset', /^operating lease right[- ]of[- ]use assets?(?:, net)?$/],
    ['balance', 'currentAccountsPayable', /^accounts payable$|^trade (?:accounts )?payables?$/, { section: 'current liabilities' }],
    ['balance', 'deposits', /^deposits$|^total deposits$/, { section: 'liabilities' }],
    ['balance', 'loans', /^advances$|^loans, net(?: of allowance.*)?$/, { section: 'assets', bank: true }],
    ['balance', 'retainedEarnings', /^retained earnings$|^accumulated deficit$|^retained earnings \(accumulated deficit\)$|^accumulated deficit \(retained earnings\)$/],
    ['balance', 'longTermDebt', /^long-term debt(?:, net)?$|^long-term debt, (?:net of|less) current (?:portion|maturities)$/],
    ['balance', 'cashAndShortTermInvestments', /^cash and short-term investments$/, { trust: true }],
    // cash
    ['cash', 'operatingCashflow', /^net cash (?:flows? )?(?:provided by|used in|from|generated from|generated by|\(used in\) provided by|provided by \(used in\)|used in\) provided by|from \(used in\)|\(used in\) from|from\/\(used in\)|used in\/from|inflow from|outflow from) operating activities$|^net cash (?:flows? )?(?:from|\(used in\)|used in) operations$|^cash flows? (?:from|used in|provided by) operating activities, net$|^net cash flow from\/\(used in\) operating activities$/],
    ['cash', 'cashflowFromInvestment', /^net cash (?:flows? )?(?:provided by|used in|from|generated from|generated by|\(used in\) provided by|provided by \(used in\)|used in\) provided by|from \(used in\)|\(used in\) from|from\/\(used in\)|used in\/from|inflow from|outflow from) investing activities$|^net cash flow from\/\(used in\) investing activities$/],
    ['cash', 'cashflowFromFinancing', /^net cash (?:flows? )?(?:provided by|used in|from|generated from|generated by|\(used in\) provided by|provided by \(used in\)|used in\) provided by|from \(used in\)|\(used in\) from|from\/\(used in\)|used in\/from|inflow from|outflow from) financing activities$|^net cash flow from\/\(used in\) financing activities$/],
    ['cash', 'capitalExpenditures', /^(?:purchases?|acquisitions?|additions?|payments?) (?:of|to|for) (?:property,? plant,? and equipment|property and equipment|fixed assets)$|^capital expenditures$|^purchase of fixed assets$/],
    ['cash', 'dividendPayout', /^(?:cash )?dividends? paid(?: to (?:shareholders|stockholders|owners of the parent(?: company)?|unitholders|common (?:stock|share)holders))?$|^payments? of (?:cash )?dividends$/],
    ['cash', 'changeInCashAndCashEquivalents', /^net (?:increase|decrease|change)(?: \((?:decrease|increase)\))?(?: ?\/ ?\((?:decrease|increase)\))? in cash(?: and cash equivalents| and equivalents)?(?:,? (?:cash equivalents,? )?and restricted cash(?: and cash equivalents)?)?$/],
    ['cash', 'depreciationDepletionAndAmortization', /^depreciation(?:,)? (?:and|&) amorti[sz]ation(?: expenses?)?$|^depreciation, depletion and amorti[sz]ation$/],
    ['cash', 'shareBasedCompensation', /^(?:stock|share)[- ]based compensation(?: expense)?$/],
    ['cash', 'paymentsForRepurchaseOfCommonStock', /^(?:repurchases?|purchases?) of (?:common stock|treasury stock|ordinary shares|treasury shares)$/],
    ['cash', 'fxEffect', /^effects? of (?:foreign )?(?:currency )?exchange\b.*$|^exchange (?:rate )?differences?(?: on cash.*)?$/, { kind: CHECK }],
    ['cash', 'cashBeginning', /^cash(?: and cash equivalents| and equivalents)?(?:,? (?:cash equivalents,? )?and restricted cash)?,? (?:at )?(?:the )?beginning of (?:the )?(?:year|period)$/, { kind: CHECK }],
    ['cash', 'cashEnding', /^cash(?: and cash equivalents| and equivalents)?(?:,? (?:cash equivalents,? )?and restricted cash)?,? (?:at )?(?:the )?end of (?:the )?(?:year|period)$/, { kind: CHECK }],
    ['cash', 'cashFlowNetIncome', /^net (?:income|loss|profit)(?: \((?:loss|income)\))?$|^profit(?: \(loss\))? for the (?:year|period)$/, { firstOnly: true }],
];
const EXPENSE_FIELDS = new Set(['costOfRevenue', 'researchAndDevelopment', 'sellingGeneralAndAdministrative', 'operatingExpenses', 'interestExpense']);
// Result lines whose label names only a loss ("Net loss", "Loss from operations"): a positive number there is a loss.
const RESULT_FIELDS = new Set(['netIncome', 'operatingIncome', 'incomeBeforeTax', 'grossProfit', 'eps', 'dilutedEPS', 'eps+dilutedEPS', 'comprehensiveIncomeNetOfTax']);
const lossOnly = (label) => { const n = normLabel(label); return /\bloss(?:es)?\b/.test(n) && !/\b(?:income|profit|earnings|gain)\b/.test(n.replace(/comprehensive (?:income|loss)|income tax(?:es)?/g, '')); };
const OUTFLOWS = new Set(['capitalExpenditures', 'dividendPayout', 'paymentsForRepurchaseOfCommonStock']);
const BASE_DEFINITIONS = {
    totalRevenue: 'Reported company revenue', netIncome: 'Net income', eps: 'Basic earnings per share', dilutedEPS: 'Diluted earnings per share',
    totalShareholderEquity: 'Total shareholders\' equity', totalAssets: 'Total assets', totalLiabilities: 'Total liabilities',
};

function mapRow(st, label, ctx) {
    const hits = [];
    for (const [s, field, re, opt = {}] of RULES) {
        if (s !== st || !re.test(label)) continue;
        if (opt.trust && !ctx.trust) continue;
        if (opt.bank && !ctx.bank) continue;
        if (opt.bankOrTotal && label === 'operating expenses' && !ctx.bank && !ctx.trust) continue;
        if (opt.section && !ctx.section.includes(opt.section)) continue;
        if (opt.kind === PER_SHARE && opt.eps && !/^(?:basic|diluted)/.test(label) === false && !ctx.perShareSection && /^(?:basic|diluted|basic and diluted)$/.test(label)) continue;
        if (opt.firstOnly && ctx.seenValueRow) continue;
        hits.push({ field, opt });
    }
    if (!hits.length) return null;
    const fields = new Set(hits.map(h => h.field));
    if (fields.size > 1) return null;
    return hits[0];
}

// ───────────────────────── one statement ─────────────────────────

function rowLabel(row, firstCol, notes) {
    const inNotes = (c) => notes.some(([a, b]) => c.c0 <= b && a <= c.c1);
    return row.filter(c => c.c1 < firstCol && c.text && !inNotes(c)).map(c => c.text).join(' ').trim();
}

// Reads the table rows of one statement against resolved periods.
function readRows(table, cols, periods) {
    const firstCol = Math.min(...cols.periods.map(p => p.c0));
    const out = [];
    let stray = 0, dataRows = 0;
    const spans = [...cols.periods.map(p => [p.c0, p.c1]), ...cols.notes];
    for (const label of cols.headerLabels || []) out.push({ label, norm: normLabel(label), values: periods.map(() => ({ text: '', parsed: { kind: 'blank', value: null } })), hasValues: false });
    for (const row of table.rows.slice(cols.firstData)) {
        const label = rowLabel(row, firstCol, cols.notes);
        const values = [];
        for (const p of periods) {
            const idx = [];
            row.forEach((c, i) => { if (c.c0 <= p.c1 && p.c0 <= c.c1 && c.c0 >= firstCol) idx.push(i); });
            let text = idx.map(i => row[i].text).filter(Boolean).join(' ').replace(/\s+\)/g, ')');
            const next = row[(idx[idx.length - 1] ?? -2) + 1];
            if (next && /^\)\s*%?$/.test(next.text) && /\(/.test(text)) text += ')';
            values.push({ text: clean(text), parsed: parseAmount(text) });
        }
        const nums = row.filter(c => c.c0 >= firstCol && parseAmount(c.text).kind === 'number');
        if (nums.length) dataRows++;
        for (const c of nums) if (!spans.some(([a, b]) => c.c0 <= b && a <= c.c1)) { stray++; break; }
        out.push({ label, norm: normLabel(label), values, hasValues: values.some(v => v.parsed.kind === 'number' || v.parsed.kind === 'zero'), unreadable: values.some(v => v.parsed.kind === 'invalid') });
    }
    return { rows: out, stray, dataRows };
}

const TOL = (scale, n) => scale * Math.max(1, n) + 1e-9;

// Maps rows, checks the printed identities, returns {fields, checks, error}.
function mapStatement(st, rows, periods, scale, ctx) {
    const mapped = [];
    let section = '', perShareSection = false, attributable = '', seenValueRow = false, trustTotalSeen = 0;
    const bare = [], unreadable = [];
    for (const r of rows) {
        // a line the rules want whose cells cannot be read is not silently treated as a heading
        if (!r.hasValues && r.unreadable && r.norm && mapRow(st, r.norm, { ...ctx, section: [section, ctx.topSection || ''].join(' | '), perShareSection, seenValueRow })) {
            unreadable.push(`${r.label}: "${r.values.map(v => v.text).join('" / "')}"`);
            continue;
        }
        if (!r.hasValues) {
            if (r.norm) {
                section = r.norm;
                perShareSection = /per (?:share|unit|ads)|earnings \(loss\) per|loss per share|earnings per/.test(r.norm) && !/weighted|number of shares|shares outstanding/.test(r.norm);
                attributable = /attributable to$/.test(r.norm) ? r.norm : (/^(?:owners|non-controlling|noncontrolling)/.test(r.norm) ? attributable : '');
                if (/^(?:assets|liabilities|current assets|non-?current assets|current liabilities|non-?current liabilities|liabilities and|capital and liabilities|equity|stockholders|shareholders)/.test(r.norm)) ctx.topSection = r.norm;
            }
            continue;
        }
        let label = r.norm;
        let hit = null;
        // Rows under "Profit attributable to:" name only the owner.
        if (st === 'income' && /^(?:owners of the parent(?: company)?|owners of the company|equity holders of the parent|shareholders of the company|the group|controlling interests?)$/.test(label)) {
            if (/^(?:net )?(?:profit|income|earnings|loss|net income|net loss|net profit)(?: \((?:loss|income)\))?(?: for the (?:year|period))? attributable to$/.test(attributable)) hit = { field: 'netIncome', opt: { parent: true } };
        } else if (st === 'balance' && label === 'total') {
            bare.push(r);
            const top = ctx.topSection || '';
            if (/^assets/.test(top) && !bare.slice(0, -1).some(b => b.top === 'assets')) { hit = { field: 'totalAssets', opt: { bareTotal: true } }; r.top = 'assets'; }
            else if (/^liabilities and|^capital and liabilities/.test(top)) { hit = { field: 'totalLiabilitiesAndEquity', opt: { kind: CHECK, bareTotal: true } }; r.top = 'le'; }
        } else {
            hit = mapRow(st, label, { ...ctx, section: [section, ctx.topSection || ''].join(' | '), perShareSection, seenValueRow });
        }
        seenValueRow = true;
        if (!hit) { mapped.push({ row: r, field: null }); continue; }
        if (hit.opt.kind === PER_SHARE && /^(?:basic|diluted|basic and diluted)$/.test(label) && !perShareSection) { mapped.push({ row: r, field: null }); continue; }
        mapped.push({ row: r, field: hit.field, opt: hit.opt });
    }
    // A field printed twice with different numbers is ambiguous: drop it.
    const byField = new Map();
    for (const m of mapped) if (m.field) { if (!byField.has(m.field)) byField.set(m.field, []); byField.get(m.field).push(m); }
    const fields = new Map(), notes = [];
    const hasNci = rows.some(r => /non-?controlling interests?|minority interests?/.test(r.norm));
    for (const [field, list] of byField) {
        const scopeOf = (m) => m.opt.parent ? 'parent' : (field === 'netIncome' || field === 'totalShareholderEquity') && hasNci ? 'consolidated' : 'entity';
        const groups = new Map();
        for (const m of list) { const sc = scopeOf(m); if (!groups.has(sc)) groups.set(sc, []); groups.get(sc).push(m); }
        for (const [scope, ms] of groups) {
            const same = ms.every(m => m.row.values.every((v, i) => v.parsed.value === ms[0].row.values[i].parsed.value));
            if (!same) { notes.push(`${field} printed ${ms.length} times with different values; dropped`); continue; }
            fields.set(field + '|' + scope, { field, scope, row: ms[0].row, opt: ms[0].opt });
        }
    }
    const get = (field, i, scope) => {
        const entries = [...fields.values()].filter(f => f.field === field && (!scope || f.scope === scope));
        if (!entries.length) return null;
        // the broadest figure: consolidated or entity first, then parent
        const e = entries.find(f => f.scope !== 'parent') || entries[0];
        const v = e.row.values[i].parsed;
        return v.kind === 'number' || v.kind === 'zero' ? v.value : null;
    };
    const checks = [];
    const fail = unreadable.map(u => 'unreadable cells in a mapped line: ' + u);
    for (let i = 0; i < periods.length; i++) {
        const P = periods[i].periodEnd;
        const eq = (name, a, b, n) => { if (a === null || b === null) return; const ok = Math.abs(a - b) <= TOL(1, n) * 1; checks.push({ period: P, name, ok, left: a, right: b }); if (!ok) fail.push(`${P}: ${name} (${a} vs ${b})`); };
        if (st === 'balance') {
            const ta = get('totalAssets', i), tle = get('totalLiabilitiesAndEquity', i), tl = get('totalLiabilities', i), te = get('totalShareholderEquity', i);
            if (tle !== null) eq('total assets = total liabilities and equity', ta, tle, 1);
            else if (tl !== null && te !== null) {
                // shares subject to redemption (temporary equity) print between liabilities and equity
                const between = rows.filter(r => r.hasValues && !/^total\b/.test(r.norm) && /mezzanine|temporary equity|redeemable|subject to (?:possible )?redemption/.test(r.norm));
                const extra = between.reduce((a, r) => a + (r.values[i].parsed.value || 0), 0);
                if (ta !== null && Math.abs(ta - tl - te) > TOL(1, 2) && between.length) eq('total assets = total liabilities + temporary equity + equity', ta, tl + te + extra, 2 + between.length);
                else eq('total assets = total liabilities + equity', ta, tl + te, 2);
            }
            if (ta !== null && !checks.some(c => c.period === P && /^total assets = /.test(c.name))) fail.push(`${P}: total assets printed but no total liabilities and equity to check it against`);
            const tca = get('totalCurrentAssets', i), tnca = get('totalNonCurrentAssets', i);
            if (tca !== null && tnca !== null) eq('current + non-current assets = total assets', tca + tnca, ta, 2);
            const tcl = get('totalCurrentLiabilities', i), tncl = get('totalNonCurrentLiabilities', i);
            if (tcl !== null && tncl !== null) eq('current + non-current liabilities = total liabilities', tcl + tncl, tl, 2);
        } else if (st === 'income') {
            const rev = get('totalRevenue', i), cor = get('costOfRevenue', i), gp = get('grossProfit', i);
            if (rev !== null && cor !== null && gp !== null) {
                const ok = Math.abs(rev - Math.abs(cor) - gp) <= TOL(1, 2);
                checks.push({ period: P, name: 'revenue - cost of revenue = gross profit', ok, left: rev - Math.abs(cor), right: gp });
                if (!ok) fail.push(`${P}: gross profit (${rev} - ${cor} vs ${gp})`);
            }
            const ti = get('trustTotalIncome', i), tx = get('trustTotalExpenses', i), di = get('netIncome', i);
            if (ctx.trust && ti !== null && tx !== null && di !== null) eq('total income - total expenditures = distributable income', ti - Math.abs(tx), di, 2);
        } else if (st === 'cash') {
            const o = get('operatingCashflow', i), v = get('cashflowFromInvestment', i), f = get('cashflowFromFinancing', i), c = get('changeInCashAndCashEquivalents', i), fx = get('fxEffect', i);
            if (o !== null && v !== null && f !== null && c !== null) {
                let sum = o + v + f + (fx || 0);
                let ok = Math.abs(sum - c) <= TOL(1, 4);
                if (!ok) {
                    // other printed lines between the financing total and the change (discontinued operations, restricted cash)
                    const fi = rows.indexOf(fields.get('cashflowFromFinancing|entity')?.row), ci = rows.indexOf(fields.get('changeInCashAndCashEquivalents|entity')?.row);
                    if (fi >= 0 && ci > fi) { let extra = 0; for (const r of rows.slice(fi + 1, ci)) if (r.hasValues && r !== fields.get('fxEffect|entity')?.row) extra += r.values[i].parsed.value || 0; sum += extra; ok = Math.abs(sum - c) <= TOL(1, 8); }
                }
                checks.push({ period: P, name: 'operating + investing + financing (+ fx) = net change in cash', ok, left: sum, right: c });
                if (!ok) fail.push(`${P}: cash-flow sections (${sum} vs ${c})`);
            }
            const b = get('cashBeginning', i), e = get('cashEnding', i);
            if (b !== null && e !== null && c !== null) {
                // printed adjustments between the opening balance and the closing one ("Add: cash of a subsidiary acquired")
                const bi = rows.indexOf(fields.get('cashBeginning|entity')?.row), ei = rows.indexOf(fields.get('cashEnding|entity')?.row);
                let extra = 0;
                if (Math.abs(b + c - e) > TOL(1, 2) && bi >= 0 && ei > bi) for (const r of rows.slice(bi + 1, ei)) if (r.hasValues && r !== fields.get('changeInCashAndCashEquivalents|entity')?.row) extra += r.values[i].parsed.value || 0;
                eq('beginning cash + net change (+ printed adjustments) = ending cash', b + c + extra, e, 4);
            }
        }
    }
    return { fields, checks, fail, notes };
}

// Printed subtotal rows that equal the sum of the rows directly above them (evidence only).
function subtotalEvidence(rows, periods) {
    let matched = 0, total = 0;
    rows.forEach((r, idx) => {
        if (!/^total\b/.test(r.norm) || !r.hasValues) return;
        total++;
        for (let len = 2; len <= 12 && idx - len >= 0; len++) {
            const block = rows.slice(idx - len, idx);
            if (block.some(b => !b.hasValues)) break;
            const ok = periods.every((p, i) => { const t = r.values[i].parsed.value; if (t === null) return true; const s = block.reduce((a, b) => a + (b.values[i].parsed.value || 0), 0); return Math.abs(s - t) <= len + 1e-9 || Math.abs(block.reduce((a, b, j) => a + (j === 0 ? 1 : -1) * Math.abs(b.values[i].parsed.value || 0), 0) - t) <= len; });
            if (ok) { matched++; break; }
        }
    });
    return { matched, total };
}

// ───────────────────────── accounting basis ─────────────────────────

function accountingBasis(text, form, trust) {
    const t = clean(text);
    if (trust && /modified cash basis/i.test(t)) return 'Modified cash basis';
    const votes = new Map();
    const re = /present fairly[^.]{0,400}?in (?:conformity|accordance) with ([^.;]{0,200})/gi;
    let m, n = 0;
    while ((m = re.exec(t)) && n < 30) { n++; const b = basisOf(m[1]); if (b) votes.set(b, (votes.get(b) || 0) + 1); }
    if (!votes.size) {
        const re2 = /(?:prepared|presented) in (?:conformity|accordance) with ([^.;]{0,200})/gi;
        while ((m = re2.exec(t)) && n < 60) { n++; const b = basisOf(m[1]); if (b) votes.set(b, (votes.get(b) || 0) + 1); }
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) return ranked[0][0];
    return null;
}
function basisOf(s) {
    s = s.toLowerCase();
    if (/modified cash basis/.test(s)) return 'Modified cash basis';
    if (/korean international financial reporting standards|k-ifrs/.test(s)) return 'K-IFRS';
    if (/indian accounting standards|ind as/.test(s)) return 'Ind AS';
    if (/international financial reporting standards|\bifrs\b/.test(s)) return 'IFRS';
    if (/generally accepted accounting principles in india|indian gaap|accounting principles generally accepted in india/.test(s)) return 'Indian GAAP';
    if (/accounting principles generally accepted in the united states|generally accepted accounting principles (?:in|of) the united states|u\.\s?s\.? gaap|\bus gaap|united states generally accepted|u\.\s?s\.? generally accepted accounting principles|accounting principles generally accepted in the u\.s\./.test(s)) return 'US GAAP';
    return null;
}

// ───────────────────────── one document ─────────────────────────

const ANCHOR_FIRST = { balance: ['totalAssets'], income: ['totalRevenue'], cash: ['operatingCashflow'] };
const ANCHOR_LAST = { balance: ['totalLiabilitiesAndEquity', 'totalLiabilities', 'totalShareholderEquity'], income: ['netIncome'], cash: ['changeInCashAndCashEquivalents'] };

function nameTokens(name) {
    const stop = new Set(['the', 'inc', 'corp', 'corporation', 'company', 'co', 'ltd', 'limited', 'plc', 'llc', 'lp', 'trust', 'holdings', 'holding', 'group', 'sa', 'nv', 'ag', 'se', 'and', 'of', 'de', 'bank', 'royalty', 'technologies', 'international']);
    const words = clean(name).replace(/[^A-Za-z0-9 &]/g, ' ').split(/\s+/).filter(Boolean);
    const strong = words.filter(w => w.length >= 3 && !stop.has(w.toLowerCase()));
    return strong.length ? [strong[0]] : words.filter(w => w.length >= 2).slice(0, 1);
}

// The company name printed above a statement title ("JERSEY MIKE'S HOLDCO, LLC AND SUBSIDIARIES
// Consolidated Balance Sheets"), reduced to a comparable key; '' when no short heading is found.
const ENTITY_SUFFIX = /\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|llc|l\s?l\s?c|plc|lp|l\s?p|pte|sa|nv|ag|se|the)\b/g;
function entityKey(name) {
    return clean(name).replace(/\/[A-Z]{2,3}\/?$/, '').toLowerCase().replace(/['’`]/g, '').replace(/\band (?:its )?(?:consolidated )?subsidiar(?:y|ies)\b|\band (?:its )?(?:controlled entities|vies?)\b/g, ' ')
        .replace(/[^a-z0-9 ]/g, ' ').replace(ENTITY_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
function entityOf(tail, title) {
    const t = clean(tail);
    const at = t.toLowerCase().lastIndexOf(String(title).toLowerCase());
    if (at < 0) return '';
    let seg = t.slice(Math.max(0, at - 220), at);
    const cut = [...seg.matchAll(/\bF-\d+\b|\btable of contents\b|\bindex\b|(?<!\b(?:inc|ltd|corp|co|pte|l\.p|n\.v|s\.a|plc|no))[.;:]\s+(?=[A-Z])/gi)].pop();
    if (cut) seg = seg.slice(cut.index + cut[0].length);
    // only a company name counts as a heading: it carries a legal-form word
    if (!/\b(?:inc|incorporated|corp|corporation|company|co|ltd|limited|llc|plc|pte|lp|l\.p|trust|s\.p\.a|spa|oyj|ab|ag|sa|nv|n\.v|se|bancorp|pbc|holdco|holdings?)\b/i.test(seg)) return '';
    seg = seg.replace(/\b(?:consolidated|combined|condensed|unaudited|interim|audited|financial statements|carve-out|(?:amended and )?restated|as restated|statements? of [a-z ,]+|balance sheets?)\b/gi, ' ').replace(/[()]/g, ' ');
    const key = entityKey(seg);
    if (!key || key.length > 70 || key.split(' ').length > 9 || /\d{4}/.test(key)) return '';
    return key;
}

// The whole extraction for one document. Pure: html in, statements and a log out.
function extractDocument(html, ctx) {
    const log = [];
    const { tables, text } = parseTables(decodeHtml(html));
    const trust = /\btrust\b/i.test(ctx.registrantName || '') && /distributable income|trust corpus/i.test(text);
    const bank = /\bbank\b|\bbancorp\b/i.test(ctx.registrantName || '');
    const basis = ctx.accountingBasis || accountingBasis(text, ctx.form, trust);
    const tokens = [...new Set([ctx.registrantName, ...(ctx.formerNames || [])].filter(Boolean).flatMap(nameTokens))];
    const docCurrency = presentationCurrency(text);
    const candidates = [];
    let prev = null;
    for (const table of tables) {
        const gap = text.slice(table.gapStart, table.start);
        const head = table.rows.slice(0, 6).map(r => r.map(c => c.text).join(' ')).join(' ');
        let title = statementTitle(gap, head);
        const shortGap = clean(gap).replace(/\b(?:table of contents|f-\d+|page \d+|\d+)\b/gi, '').trim().length < 160;
        if (title?.excluded) { prev = null; continue; }
        if (!title && prev && prev.table.index === table.index - 1 && shortGap) title = { ...prev.title, continuation: true };
        if (!title) { prev = null; continue; }
        let cols = readColumns(table, title, ctx);
        // A page-break continuation often repeats no column header: it takes the previous table's columns.
        if (cols.error && prev && prev.table.index === table.index - 1 && prev.title.type === title.type && !isHeaderRow(table.rows[0]) === true && (title.continuation || /\bcontinued\b/i.test(clean(gap).slice(-300)) || shortGap)) {
            cols = { ...prev.cols, firstData: 0, header: [], headerText: '', headerLabels: [], inherited: true };
            title = { ...prev.title, continuation: true };
        }
        if (cols.error) { if (!title.continuation) log.push(`table ${table.index} "${title.title}": ${cols.error}`); prev = null; continue; }
        const entry = { table, title, cols, gap, tail: text.slice(Math.max(0, table.start - 2500), table.start) };
        candidates.push(entry);
        prev = entry;
    }
    // Merge a statement split over consecutive tables (the balance sheet across two pages).
    const groups = [];
    for (const c of candidates) {
        const last = groups[groups.length - 1];
        const sig = (x) => x.cols.periods.map(p => clean(p.own)).join('|');
        if (last && last.title.type === c.title.type && last.parts[last.parts.length - 1].table.index === c.table.index - 1 && sig(last.parts[0]) === sig(c) &&
            (c.title.continuation || /\bcontinued\b/i.test(clean(c.gap).slice(-300)) || (!hasAnchor(last, ANCHOR_LAST[c.title.type]) && !hasAnchor({ parts: [c] }, ANCHOR_FIRST[c.title.type])))) {
            last.parts.push(c); continue;
        }
        groups.push({ title: c.title, parts: [c] });
    }
    const statements = [];
    let lastNamed = -Infinity;
    for (const g of groups) {
        const st = g.title.type, first = g.parts[0];
        const where = `table ${first.table.index}${g.parts.length > 1 ? '+' + (g.parts.length - 1) : ''} "${g.title.title}"`;
        const reject = (why) => log.push(`${where}: rejected — ${why}`);
        // The registrant's name heads the statements block; later statements of the same block inherit it.
        const nearText = clean(first.tail).toLowerCase();
        if (tokens.length && tokens.some(t => nearText.includes(t.toLowerCase()))) lastNamed = g.parts[g.parts.length - 1].table.end;
        else if (tokens.length && first.table.start - lastNamed < 8000) lastNamed = g.parts[g.parts.length - 1].table.end;
        else { reject(`registrant name "${tokens[0]}" not found near the statement`); continue; }
        const headerText = g.parts.map(p => p.cols.headerText).join(' ');
        const titleCtx = clean(g.title.context).slice(-500);
        // scale
        let sc = parseScale(headerText);
        if (sc?.ambiguous) { reject('ambiguous scale in header: ' + sc.ambiguous.join(' / ')); continue; }
        if (!sc) {
            // the scale printed alone in a header cell
            const cellScales = new Map();
            for (const p of g.parts) for (const r of p.cols.header || []) for (const c of r) { const x = parseScale(c.text); if (x && !x.ambiguous) cellScales.set(x.scale, x); }
            if (cellScales.size > 1) { reject('ambiguous scale in header cells: ' + [...cellScales.values()].map(x => x.phrase).join(' / ')); continue; }
            if (cellScales.size === 1) sc = [...cellScales.values()][0];
        }
        if (!sc) { sc = parseScale(titleCtx); if (sc?.ambiguous) { reject('ambiguous scale in title: ' + sc.ambiguous.join(' / ')); continue; } }
        const scale = sc ? sc.scale : 1;
        // currency
        const named = currenciesIn(headerText + ' ' + titleCtx);
        const symbols = new Set();
        for (const p of g.parts) for (const r of p.table.rows.slice(p.cols.firstData)) for (const c of r) { const s = symbolCurrency(c.text); if (s) symbols.add(s); }
        let currency = null;
        const strong = new Set([...named, ...[...symbols].filter(s => s !== '$')]);
        if (strong.size === 1) currency = [...strong][0];
        else if (strong.size === 0 && (symbols.has('$') || !symbols.size)) currency = ctx.domestic ? 'USD' : (docCurrency && (!symbols.has('$') || DOLLAR_CURRENCIES.has(docCurrency)) ? docCurrency : null);
        if (!currency && strong.size > 1 && docCurrency && strong.has(docCurrency)) currency = docCurrency;
        else if (!currency && strong.size > 1) {
            // convenience translations: the scale phrase names the reporting currency ("in millions of Korean won")
            const scaled = sc ? currenciesIn(sc.phrase + ' ' + (headerText.match(/\b(?:in|of) (?:thousands|millions|billions) of [a-z. ]{3,30}/i) || [''])[0]) : new Set();
            if (scaled.size === 1) currency = [...scaled][0];
        }
        if (!currency) { reject(`currency not stated (${[...strong, ...symbols].join(',') || 'none'}${ctx.domestic ? '' : ', foreign filer, presentation currency ' + (docCurrency || 'not stated')})`); continue; }
        // periods
        const plog = [];
        const periods = resolvePeriods(first.cols, g.title, { ...ctx, tableCurrency: currency }, plog);
        for (const l of plog) log.push(`${where}: ${l}`);
        const usable = periods.filter(p => !p.skip);
        for (const p of periods.filter(p => p.skip)) log.push(`${where}: column "${p.own}" dropped — ${p.skip}`);
        if (!usable.length) { reject('no column with a clear period'); continue; }
        // rows
        const rowsAll = [];
        let stray = 0, dataRows = 0;
        for (const part of g.parts) {
            const partPeriods = part === first ? usable : usable.map(u => part.cols.periods[first.cols.periods.indexOf(first.cols.periods.find(q => q.c0 === u.c0))] || null);
            if (partPeriods.some(x => !x)) { stray += 999; break; }
            const rr = readRows(part.table, part.cols, partPeriods.map((q, i) => ({ ...q, periodEnd: usable[i].periodEnd })));
            rowsAll.push(...rr.rows); stray += rr.stray; dataRows += rr.dataRows;
        }
        if (stray > Math.max(1, dataRows * 0.1)) { reject(`values outside the period columns in ${stray} of ${dataRows} rows (column alignment)`); continue; }
        const invalid = rowsAll.flatMap(r => r.values.filter(v => v.parsed.kind === 'invalid').map(v => `${r.label}: "${v.text}"`));
        const mctx = { trust, bank, domestic: ctx.domestic };
        const m = mapStatement(st, rowsAll, usable, scale, mctx);
        for (const n of m.notes) log.push(`${where}: ${n}`);
        const mappedInvalid = [...m.fields.values()].some(f => f.row.values.some(v => v.parsed.kind === 'invalid'));
        if (mappedInvalid) { reject('unreadable cell in a mapped row: ' + invalid.slice(0, 3).join('; ')); continue; }
        if (m.fail.length) { reject('identity check failed: ' + m.fail.join('; ')); continue; }
        const anchors = st === 'balance' ? ['totalAssets'] : st === 'income' ? ['totalRevenue', 'netIncome'] : ['operatingCashflow'];
        if (!anchors.some(a => [...m.fields.values()].some(f => f.field === a))) { reject(`no ${anchors.join(' or ')} line`); continue; }
        if (!basis) { reject('accounting basis not stated in the filing'); continue; }
        const sub = subtotalEvidence(rowsAll, usable);
        if (st === 'balance') {
            const ta = [...m.fields.values()].find(f => f.field === 'totalAssets');
            const tav = ta ? ta.row.values.map(v => v.parsed.value).filter(v => v != null) : [];
            if (tav.length && tav.every(v => Math.abs(v * scale) < 1000)) { reject(`total assets under 1,000 ${currency} in every column (a formation-stage shell, not the operating business)`); continue; }
        }
        statements.push({ entity: entityOf(first.tail, g.title.title), type: st, title: g.title.title, consolidated: g.title.consolidated, tables: g.parts.map(p => p.table.index), scale, scalePhrase: sc ? sc.phrase : 'none stated (whole units)', currency, periods: usable, fields: m.fields, checks: m.checks, subtotals: sub, trust, basis });
        log.push(`${where}: kept — ${usable.length} columns, ${m.fields.size} lines, scale ${scale}, ${currency}, ${m.checks.filter(c => c.ok).length} checks passed, ${sub.matched}/${sub.total} printed totals sum`);
    }
    // Consolidated statements win over separate/parent-only ones of the same type.
    // One document can carry several entities' statements: a SPAC and its target, a shell holding company
    // and its operating subsidiary, a predecessor. When more than one company heading appears, only the
    // statements headed by the registrant's own name are kept; a statement with no heading of its own
    // belongs to the heading above it.
    let lastEntity = '';
    for (const s of statements) { if (s.entity) lastEntity = s.entity; else s.entity = lastEntity; }
    const entities = [...new Set(statements.map(s => s.entity).filter(Boolean))];
    const own = new Set([ctx.registrantName, ...(ctx.formerNames || [])].filter(Boolean).map(entityKey));
    const isOwn = (e) => own.has(e) || [...own].some(o => o && e.endsWith(' ' + o));
    const others = entities.filter(e => !isOwn(e));
    // A heading naming another company (an operating subsidiary, a SPAC, a predecessor) is not the
    // registrant's statement; statements under an unreadable heading are kept only when no other
    // company is named in the document.
    const pool = statements.filter(s => s.entity ? isOwn(s.entity) : !others.length);
    if (others.length) log.push(`statements headed by another company dropped: ${others.join(' / ')}${entities.length > others.length ? ' (kept the registrant\'s own)' : ''}`);
    const kept = pool.filter(s => s.consolidated || !pool.some(o => o.type === s.type && o.consolidated));
    for (const s of pool.filter(s => !kept.includes(s))) log.push(`table ${s.tables[0]} "${s.title}": dropped — a consolidated ${s.type} statement exists`);
    // Two statements in one document that print different amounts for the same line and period are
    // different entities (a SPAC and its target, predecessor and successor) or one was read at the wrong
    // scale. Neither can be told apart by rule, so every statement in such a disagreement is dropped.
    const seen = new Map(), bad = new Set();
    kept.forEach((s, si) => {
        for (const f of s.fields.values()) {
            if (f.opt.kind === CHECK) continue;
            s.periods.forEach((p, i) => {
                const v = f.row.values[i].parsed;
                if (v.kind !== 'number' && v.kind !== 'zero') return;
                const amount = f.opt.kind === PER_SHARE ? v.value : v.value * s.scale;
                const key = [f.field, f.scope, p.periodEnd, p.months || 0].join('|');
                for (const o of seen.get(key) || []) {
                    if (o.si === si) continue;
                    const tol = f.opt.kind === PER_SHARE ? 0.005 : Math.max(s.scale, kept[o.si].scale);
                    if (Math.abs(Math.abs(o.amount) - Math.abs(amount)) > tol) { bad.add(si); bad.add(o.si); log.push(`table ${s.tables[0]} and table ${kept[o.si].tables[0]} disagree on ${f.field} at ${p.periodEnd} (${o.amount} vs ${amount}); both dropped`); }
                }
                if (!seen.has(key)) seen.set(key, []);
                seen.get(key).push({ si, amount });
            });
        }
    });
    const consistent = kept.filter((s, si) => !bad.has(si));
    return { statements: consistent.map(s => ({ ...s, fields: [...s.fields.values()].map(f => ({ field: f.field, scope: f.scope, opt: f.opt, label: f.row.label, values: f.row.values.map(v => ({ text: v.text, kind: v.parsed.kind, value: v.parsed.value })) })) })), log, basis, trust, bank, tableCount: tables.length };
}
function hasAnchor(group, fieldsWanted) {
    for (const part of group.parts) for (const r of part.table.rows.slice(part.cols.firstData)) {
        const label = normLabel(rowLabel(r, Math.min(...part.cols.periods.map(p => p.c0)), part.cols.notes));
        for (const [s, field, re] of RULES) if (fieldsWanted.includes(field) && re.test(label)) return true;
        if (label === 'total' && fieldsWanted.includes('totalAssets')) return true;
    }
    return false;
}

// ───────────────────────── statements → observations ─────────────────────────

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function scaled(value, scale, decimals) {
    if (scale === 1) return value;
    const v = value * scale;
    // printed decimals times a scale of thousands or more is a whole number of units
    return Math.round(v);
}
function definitionFor(field, f, st) {
    if (field === 'netIncome' && f.opt.distributable) return `Distributable income (royalty trust, modified cash basis; filing line "${f.label}")`;
    if (field === 'totalRevenue' && f.opt.trust) return `Royalty income (royalty trust, modified cash basis; filing line "${f.label}")`;
    if (field === 'eps' && f.opt.trust) return `Distributable income per unit (filing line "${f.label}")`;
    if (field === 'totalShareholderEquity' && f.opt.trust) return `Trust corpus (filing line "${f.label}")`;
    const base = BASE_DEFINITIONS[field] || field;
    return `${base}${f.scope === 'parent' ? ', attributable to the parent' : f.scope === 'consolidated' ? ', including non-controlling interests' : ''} (filing line "${f.label}")`;
}

function observationsFor(doc, ctx) {
    const out = [];
    const skipped = [];
    for (const s of doc.statements) {
        // sign convention of expense lines in this statement
        const expenseValues = s.fields.filter(f => EXPENSE_FIELDS.has(f.field)).flatMap(f => f.values.map(v => v.value)).filter(v => typeof v === 'number' && v !== 0);
        const deduction = expenseValues.length && expenseValues.filter(v => v < 0).length > expenseValues.length / 2;
        for (const f of s.fields) {
            if (f.opt.kind === CHECK) continue;
            let lossSign = 1;
            if (RESULT_FIELDS.has(f.field) && lossOnly(f.label)) {
                const nums = f.values.filter(v => v.kind === 'number' && v.value !== 0).map(v => v.value);
                if (nums.length && nums.every(v => v > 0)) lossSign = -1;
                else if (nums.some(v => v > 0) && nums.some(v => v < 0)) { skipped.push(`${f.field}: loss-only line "${f.label}" printed with both signs; dropped`); continue; }
            }
            const targets = f.field === 'eps+dilutedEPS' ? ['eps', 'dilutedEPS'] : [f.field];
            for (let i = 0; i < s.periods.length; i++) {
                const p = s.periods[i], v = f.values[i];
                if (v.kind !== 'number' && v.kind !== 'zero') continue;
                let value = v.value * lossSign;
                if (EXPENSE_FIELDS.has(f.field) && deduction) value = -value;
                if (f.field === 'incomeTaxExpense' && deduction) value = -value;
                if (OUTFLOWS.has(f.field) && value > 0) { skipped.push(`${f.field} ${p.periodEnd}: printed as a positive outflow "${v.text}"; sign unclear, dropped`); continue; }
                if (f.field === 'retainedEarnings' && /deficit/.test(normLabel(f.label)) && !/retained/.test(normLabel(f.label)) && value > 0) { skipped.push(`retainedEarnings ${p.periodEnd}: accumulated deficit printed without sign; dropped`); continue; }
                const perShare = f.opt.kind === PER_SHARE;
                value = perShare ? value : scaled(value, s.scale, v.decimals);
                const basis = s.type === 'balance' ? 'instant' : p.months === 12 ? 'annual' : 'quarterly';
                const historyBasis = s.type === 'balance' ? (fiscalYearEndMatch(p.periodEnd, ctx.fiscalYearEnd) ? 'annual' : 'quarterly') : basis;
                for (const field of targets) {
                    const receipt = { label: f.label, cellText: v.text, document: ctx.documentUrl, column: p.header, statement: s.title, scale: s.scalePhrase };
                    const id = sha(JSON.stringify([ctx.accession, ctx.document, field, f.scope, p.periodEnd, basis, f.label, v.text])).slice(0, 16);
                    out.push({
                        issuer: ctx.cik, securitySymbol: ctx.symbol, field, definition: definitionFor(field, f, s.type), value, scale: 1,
                        unit: perShare ? s.currency + '/shares' : s.currency, currency: s.currency,
                        periodStart: s.type === 'balance' ? null : p.periodStart, periodEnd: p.periodEnd, basis, historyBasis,
                        periodDefinition: s.type === 'balance' ? `As of ${p.periodEnd}, column "${p.header}"` : `${p.months === 12 ? 'Year' : 'Three months'} ended ${p.periodEnd}, column "${p.header}"`,
                        accountingBasis: s.basis, scope: f.scope, statement: s.type,
                        sourceType: 'issuer_release', sourceName: SOURCE_NAME, sourceUrl: ctx.documentUrl,
                        publicationDate: ctx.filingDate, sourceDataDate: ctx.filingDate, sourceDateKind: 'publication', retrievedAt: ctx.retrievedAt,
                        sourceVersions: [ctx.accession], verificationMethod: 'filing_html_table', extractionVersion: EXTRACTION_VERSION, state: 'available',
                        sourceIds: ['sec-html:' + ctx.accession + ':' + id], lastRefreshResult: 'success', filingForm: ctx.form, receipt,
                    });
                }
            }
        }
    }
    return { observations: out, skipped };
}
function fiscalYearEndMatch(periodEnd, fye) {
    if (!/^\d{4}$/.test(fye || '')) return false;
    const y = +periodEnd.slice(0, 4), target = Date.UTC(y, +fye.slice(0, 2) - 1, +fye.slice(2));
    const d = Date.parse(periodEnd + 'T00:00:00Z');
    return [target, Date.UTC(y - 1, +fye.slice(0, 2) - 1, +fye.slice(2)), Date.UTC(y + 1, +fye.slice(0, 2) - 1, +fye.slice(2))].some(t => Math.abs(d - t) <= 7 * 86400000);
}

// Same key from two documents: the later filing wins; equal dates must agree.
function combine(observations, log) {
    const key = (f) => [f.field, f.periodStart || '', f.periodEnd, f.unit, f.accountingBasis, f.scope, f.basis].join('|');
    const out = new Map();
    for (const f of observations) {
        const k = key(f), old = out.get(k);
        if (!old) { out.set(k, f); continue; }
        if (old.value === f.value) { if (f.publicationDate > old.publicationDate) out.set(k, f); continue; }
        if (f.publicationDate !== old.publicationDate) { if (f.publicationDate > old.publicationDate) out.set(k, f); log.push(`${k}: ${old.value} (${old.publicationDate}) superseded by ${f.value} (${f.publicationDate})`); continue; }
        // two statements in one filing disagree: keep the finer print only when the coarser one is its rounding
        const fine = Math.abs(old.value) % 1000 ? old : f, coarse = fine === old ? f : old;
        if (Math.abs(fine.value - coarse.value) < 0.5 * 10 ** Math.max(0, String(Math.abs(coarse.value)).match(/0*$/)[0].length)) { out.set(k, fine); continue; }
        out.set(k, { ...old, conflict: true });
        log.push(`${k}: conflicting values ${old.value} / ${f.value} in one filing; dropped`);
    }
    return [...out.values()].filter(f => !f.conflict);
}

// ───────────────────────── SEC access (main thread) ─────────────────────────

const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
let throttle = null;
async function secFetch(url, { binary = false } = {}) {
    if (!throttle) throttle = require(path.join(BACKEND, 'sec-throttle'));
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
        await throttle.take();
        try {
            const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(60000) });
            if (r.status === 404) return null;
            if (r.status === 429 || r.status >= 500) { lastError = new Error('HTTP ' + r.status); await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; }
            if (!r.ok) throw new Error(url + ' HTTP ' + r.status);
            return binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
        } catch (e) { lastError = e; }
    }
    throw lastError;
}
async function cached(cacheDir, rel, url, opts) {
    const file = path.join(cacheDir, rel);
    if (fs.existsSync(file)) return { file, retrievedAt: (JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')).retrievedAt) };
    const body = await secFetch(url, opts);
    if (body === null) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const retrievedAt = new Date().toISOString();
    fs.writeFileSync(file, body);
    fs.writeFileSync(file + '.meta.json', JSON.stringify({ url, retrievedAt }));
    return { file, retrievedAt };
}

// Which listed issuers qualify (no statement XBRL to read).
function discover(submissionsFor) {
    const p = require(path.join(BACKEND, 'sec-coverage'));
    const index = JSON.parse(fs.readFileSync(path.join(p.DATA_DIR, 'public-stock-index.json'), 'utf8'));
    const out = [];
    for (const s of index.securities) {
        if (s.securityType !== 'stock' || !s.cik || SKIP_SYMBOLS.has(s.symbol)) continue;
        if (!['unavailable', 'partial', 'historical_only'].includes(s.financialCoverage)) continue;
        out.push({ symbol: s.symbol, cik: s.cik, coverage: s.financialCoverage, name: s.name });
    }
    return out;
}

const ANNUAL_FORMS = /^(?:10-K|10-KT|20-F|40-F)(?:\/A)?$/;
const PROSPECTUS_FORMS = /^(?:424B4|424B1|F-1\/A|F-1|S-1\/A|S-1)$/;
const INTERIM_FORMS = /^(?:10-Q|10-Q\/A|6-K|6-K\/A)$/;
function filingsOf(subs) {
    const r = subs.filings.recent;
    return r.form.map((form, i) => ({ form, filingDate: r.filingDate[i], accession: r.accessionNumber[i], document: r.primaryDocument[i], isXBRL: r.isXBRL[i], reportDate: r.reportDate[i] }));
}
function qualifies(target, subs) {
    if (!subs || subs.missing) return false;
    const list = filingsOf(subs);
    if (target.coverage === 'unavailable') return true;
    const annual = list.find(f => ANNUAL_FORMS.test(f.form));
    if (annual) return !annual.isXBRL;
    return list.some(f => PROSPECTUS_FORMS.test(f.form));
}

// ───────────────────────── worker pool ─────────────────────────

class Pool {
    constructor(n) {
        this.idle = []; this.queue = []; this.all = [];
        for (let i = 0; i < n; i++) {
            const w = new Worker(__filename, { workerData: { role: 'html-statements-parser' } });
            w.on('message', (msg) => { const job = w.job; w.job = null; this.idle.push(w); msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error)); this.pump(); });
            w.on('error', (e) => { if (w.job) w.job.reject(e); });
            this.idle.push(w); this.all.push(w);
        }
    }
    run(payload) { return new Promise((resolve, reject) => { this.queue.push({ payload, resolve, reject }); this.pump(); }); }
    pump() { while (this.idle.length && this.queue.length) { const w = this.idle.pop(), job = this.queue.shift(); w.job = job; w.postMessage(job.payload); } }
    close() { return Promise.all(this.all.map(w => w.terminate())); }
}
if (!isMainThread && workerData?.role === 'html-statements-parser') {
    parentPort.on('message', ({ file, ctx }) => {
        try { parentPort.postMessage({ ok: true, result: extractDocument(decodeHtml(fs.readFileSync(file)), ctx) }); }
        catch (e) { parentPort.postMessage({ ok: false, error: e.stack }); }
    });
}

// ───────────────────────── per issuer ─────────────────────────

const docUrl = (cik, acc, name) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${name}`;

async function filingDocuments(cacheDir, cik, f) {
    const idx = await cached(cacheDir, `${cik}/${f.accession}/index.json`, `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accession.replace(/-/g, '')}/index.json`);
    if (!idx) return [];
    const items = JSON.parse(fs.readFileSync(idx.file, 'utf8')).directory?.item || [];
    return items.map(i => i.name).filter(n => /\.html?$/i.test(n) && n !== f.document && !/index/i.test(n) && /ex[-_]?(?:13|99)|dex(?:13|99)|exhibit[-_]?(?:13|99)|ex\d*99|ex\d*13/i.test(n)).sort();
}

async function runDocument(pool, cacheDir, issuer, subs, f, name) {
    const got = await cached(cacheDir, `${issuer.cik}/${f.accession}/${name}`, docUrl(issuer.cik, f.accession, name), { binary: true });
    if (!got) return { error: 'document not found', name };
    const ctx = {
        cik: issuer.cik, symbol: issuer.symbol, registrantName: subs.name, formerNames: (subs.formerNames || []).map(n => n.name), form: f.form, filingDate: f.filingDate, accession: f.accession, document: name,
        documentUrl: docUrl(issuer.cik, f.accession, name), retrievedAt: got.retrievedAt, fiscalYearEnd: subs.fiscalYearEnd, domestic: issuer.domestic,
    };
    const result = await pool.run({ file: got.file, ctx });
    const built = observationsFor(result, ctx);
    return { ...result, ...built, ctx, name };
}

async function runFiling(pool, cacheDir, issuer, subs, f, report) {
    const docs = [];
    const primary = await runDocument(pool, cacheDir, issuer, subs, f, f.document);
    docs.push(primary);
    if (!primary.statements?.length || primary.statements.length < 3) {
        for (const name of await filingDocuments(cacheDir, issuer.cik, f)) {
            const r = await runDocument(pool, cacheDir, issuer, subs, f, name);
            docs.push(r);
            if (r.statements?.length >= 3) break;
        }
    }
    const entry = { form: f.form, accession: f.accession, filingDate: f.filingDate, documents: docs.map(d => ({ name: d.name, error: d.error, basis: d.basis, statements: (d.statements || []).map(s => `${s.type}: ${s.periods.map(p => p.periodEnd + (p.months ? '/' + p.months + 'm' : '')).join(', ')}`), observations: d.observations?.length || 0, log: d.log, skipped: d.skipped })) };
    report.filings.push(entry);
    return docs.flatMap(d => d.observations || []);
}

async function runIssuer(pool, cacheDir, issuer, report) {
    const sub = await cached(cacheDir, `submissions/CIK${issuer.cik}.json`, `https://data.sec.gov/submissions/CIK${issuer.cik}.json`);
    if (!sub) { report.result = 'no submissions'; return []; }
    const subs = JSON.parse(fs.readFileSync(sub.file, 'utf8'));
    report.name = subs.name;
    if (!qualifies(issuer, subs)) { const annual = (subs.filings?.recent && filingsOf(subs).find(f => ANNUAL_FORMS.test(f.form))) || null; report.result = annual ? 'has XBRL annual filing; not a target' : 'no annual filing or prospectus; not a target'; return []; }
    const list = filingsOf(subs);
    const state = subs.addresses?.business?.stateOrCountry;
    issuer.domestic = US_STATES.has(state) && list.some(f => /^(?:10-K|10-Q|S-1)/.test(f.form));
    const obsAll = [];
    // annual: newest filing for each of the two newest report periods (amendments first)
    const annual = list.filter(f => ANNUAL_FORMS.test(f.form));
    const periodsSeen = new Set();
    let tried = 0;
    for (const f of annual) {
        if (periodsSeen.size >= 2 || tried >= 4) break;
        if (periodsSeen.has(f.reportDate)) continue;
        tried++;
        const got = await runFiling(pool, cacheDir, issuer, subs, f, report);
        if (got.length) { periodsSeen.add(f.reportDate); obsAll.push(...got); }
    }
    if (!obsAll.length) {
        const newestAnnual = annual.length ? annual[0].filingDate : '';
        for (const f of list.filter(f => PROSPECTUS_FORMS.test(f.form) && f.filingDate > newestAnnual).slice(0, 2)) {
            const got = await runFiling(pool, cacheDir, issuer, subs, f, report);
            if (got.length) { obsAll.push(...got); break; }
        }
    }
    // interim: the newest 10-Q, or the newest 6-K carrying statements, after the latest period found
    const latest = obsAll.map(o => o.periodEnd).sort().pop() || '';
    const interim = list.filter(f => INTERIM_FORMS.test(f.form) && f.filingDate > latest);
    let looked = 0;
    for (const f of interim) {
        if (!annual.length && issuer.coverage !== 'unavailable' && f.isXBRL) continue;
        if (looked >= (f.form.startsWith('10-Q') ? 2 : 10)) break;
        looked++;
        const got = await runFiling(pool, cacheDir, issuer, subs, f, report);
        if (got.some(o => o.periodEnd > latest)) { obsAll.push(...got); break; }
    }
    return obsAll;
}

function writeIssuer(issuer, observations, report, write) {
    const p = require(path.join(BACKEND, 'sec-coverage')), obs = require(path.join(BACKEND, 'company-observations'));
    const combineLog = [];
    let fresh = combine(observations, combineLog);
    report.combine = combineLog;
    const invalid = fresh.filter(f => !obs.validSupplement(f, issuer.cik));
    if (invalid.length) report.invalid = invalid.slice(0, 5).map(f => `${f.field} ${f.periodEnd}`);
    fresh = fresh.filter(f => obs.validSupplement(f, issuer.cik));
    if (!fresh.length) return 0;
    const file = path.join(p.DATA_DIR, 'supplemental-financials', issuer.cik + '.json');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const kept = (previous?.observations || []).filter(f => !(f.sourceIds || []).some(id => String(id).startsWith('sec-html:')) && obs.validSupplement(f, issuer.cik));
    const merged = obs.reconcile([], [...kept, ...fresh]);
    report.written = { file: path.relative(path.join(__dirname, '..'), file), observations: fresh.length, keptFromBefore: kept.length, total: merged.length };
    if (write) p.atomicWrite(file, { ...(previous || {}), schemaVersion: 1, issuer: issuer.cik, cik: issuer.cik, symbol: previous?.symbol || issuer.symbol, checkedAt: new Date().toISOString(), refreshStatus: 'success', observations: merged });
    return fresh.length;
}

async function main() {
    const args = process.argv.slice(2);
    const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
    const cacheDir = path.resolve(opt('--cache', path.join(os.tmpdir(), 'sec-html-statements')));
    const logFile = opt('--log', null);
    const jobs = Math.max(1, Number(opt('--jobs', Math.max(1, os.cpus().length - 1))));
    const write = args.includes('--write');
    const valueArgs = new Set(['--cache', '--log', '--jobs'].map(n => opt(n, null)).filter(Boolean));
    const symbols = new Set(args.filter(a => !a.startsWith('--') && !valueArgs.has(a)).map(s => s.toUpperCase()));
    let targets = discover();
    if (symbols.size) targets = targets.filter(t => symbols.has(t.symbol));
    else if (!args.includes('--all') && !args.includes('--discover')) { console.error('name symbols, or pass --all or --discover'); process.exit(2); }
    const seen = new Set();
    targets = targets.filter(t => !seen.has(t.cik) && seen.add(t.cik));
    if (args.includes('--discover')) {
        const rows = [];
        for (const t of targets) {
            const sub = await cached(cacheDir, `submissions/CIK${t.cik}.json`, `https://data.sec.gov/submissions/CIK${t.cik}.json`);
            const subs = sub ? JSON.parse(fs.readFileSync(sub.file, 'utf8')) : null;
            if (qualifies(t, subs)) rows.push(`${t.symbol}\t${t.cik}\t${t.coverage}\t${subs.name}`);
        }
        console.log(rows.join('\n')); console.log(rows.length + ' issuers qualify');
        return;
    }
    const pool = new Pool(jobs);
    const reports = [];
    try {
        const queue = [...targets];
        await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
            while (queue.length) {
                const t = queue.shift();
                const report = { symbol: t.symbol, cik: t.cik, coverage: t.coverage, filings: [] };
                reports.push(report);
                try {
                    const observations = await runIssuer(pool, cacheDir, t, report);
                    report.observations = writeIssuer(t, observations, report, write);
                    if (!report.result) report.result = report.observations ? 'covered' : 'no statement passed';
                } catch (e) { report.result = 'error: ' + e.message; }
            }
        }));
    } finally { await pool.close(); }
    reports.sort((a, b) => a.symbol.localeCompare(b.symbol));
    for (const r of reports) {
        const forms = r.filings.filter(f => f.documents.some(d => d.observations)).map(f => `${f.form} ${f.accession}`).join(', ');
        console.log(`${r.symbol.padEnd(6)} ${String(r.observations || 0).padStart(4)}  ${r.result}${forms ? '  ← ' + forms : ''}`);
    }
    if (logFile) fs.writeFileSync(logFile, JSON.stringify(reports, null, 1));
    if (write) require(path.join(BACKEND, 'committed-supplements')).readAll();
}

module.exports = { entityOf, entityKey, parseAmount, parseScale, currenciesIn, symbolCurrency, fullDates, durationOf, parseTables, statementTitle, normLabel, mapRow, extractDocument, observationsFor, combine, accountingBasis, resolvePeriods, readColumns, qualifies, EXTRACTION_VERSION, SOURCE_NAME };

if (isMainThread && require.main === module) main().catch(e => { console.error(e); process.exit(1); });
