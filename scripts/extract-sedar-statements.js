#!/usr/bin/env node
'use strict';
// Primary financial statements for Canadian issuers whose only filing is a
// SEDAR+ PDF (Canada has no broad XBRL mandate).
//
// Reads the statement tables out of the filed PDF's `pdftotext -layout` text
// with fixed rules: no model, nothing estimated, nothing derived except the
// scale multiplication. Every value keeps a receipt: the row label as printed,
// the cell text as printed, the PDF page it came from.
//
// A statement is kept only when
//   - a statement title sits on the page and the issuer's name is near it,
//   - the scale and the currency are stated ("in thousands of Canadian dollars"),
//   - every kept column has a printed date, and for a flow statement a printed
//     duration (three/six/nine months, year),
//   - the identities printed in the table hold in every column: total assets =
//     total liabilities + total equity, gross profit = revenue - cost, net income
//     = pre-tax - tax, cash at end = cash at beginning + net change (+ FX effect),
//     and the cash-flow net income equals the income statement's.
// A failed check rejects the whole statement, and the reason is logged.
//
//   node scripts/extract-sedar-statements.js                 # every PDF in .cache/sedar/downloads
//   node scripts/extract-sedar-statements.js FILE.pdf ...    # named PDFs
//   node scripts/extract-sedar-statements.js --report docs/qa/x.md
// Options: --out DIR (receipts, default .cache/sedar/receipts), --quiet.
//
// Pilot-only: writes receipts under .cache/sedar/ and never touches the
// committed product stores. Local text extraction only; no network.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const EXTRACTION_VERSION = '20261109-sedar1';
const CACHE = path.join(__dirname, '..', '.cache', 'sedar');
const DL_DIR = path.join(CACHE, 'downloads');
const TEXT_DIR = path.join(CACHE, 'text');

// ───────────────────────── printed text and numbers ─────────────────────────

function clean(s) {
    return String(s == null ? '' : s).replace(/[   ]/g, ' ').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}
const DASH = /^[—–‒―−\-‑]+$/;

// One printed cell. kind: number | zero (a dash) | blank | nil | invalid.
function parseAmount(raw) {
    let s = clean(raw);
    if (!s) return { kind: 'blank', value: null };
    for (let i = 0; i < 3; i++) {
        const t = s.replace(/^(?:US\$|U\.S\.\$|C\$|CDN\$|A\$|\$)\s*/, '');
        if (t === s) break;
        s = t.trim();
    }
    if (DASH.test(s) || /^nil$/i.test(s)) return { kind: 'zero', value: 0 };
    if (/^(\.\.|n\/?a|nm|\*)$/i.test(s)) return { kind: 'nil', value: null };
    let neg = false;
    if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1).trim(); }
    else if (s.startsWith('(') || s.endsWith(')')) return { kind: 'invalid', value: null };
    if (/^[-−]/.test(s)) { neg = !neg; s = s.slice(1).trim(); }
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) return { kind: 'invalid', value: null };
    const value = Number(s.replace(/,/g, ''));
    if (!Number.isFinite(value)) return { kind: 'invalid', value: null };
    return { kind: 'number', value: neg ? -value : value, decimals: (s.split('.')[1] || '').length, text: clean(raw) };
}

// Numbers with their position on the line. Currency symbols are blanked first so
// "  $   167,007" keeps the column alignment of the digits.
const NUM_RE = /(?:\(\s*)?[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*\))?|[—–‒―−](?=\s|$)/g;
function numberTokens(line) {
    const padded = line.replace(/\$/g, ' ');
    const out = [];
    NUM_RE.lastIndex = 0;
    let m;
    while ((m = NUM_RE.exec(padded))) {
        const before = m.index > 0 ? padded[m.index - 1] : ' ';
        if (before === ',' || before === '.') continue;
        const text = m[0].trim();
        const end = m.index + m[0].length;
        const start = m.index + (m[0].length - m[0].trimStart().length);
        out.push({ start, end, text });
    }
    return out;
}

// ───────────────────────── table geometry ─────────────────────────

// Right-aligned columns: cluster the right edge of every printed number.
// pdftotext's layout mode drifts a column's right edge by a couple of characters
// between rows, so clusters closer than the column pitch but further than that
// drift are merged (mergeCloseColumns) after the note column is set aside.
function clusterColumns(tokens, tolerance = 3) {
    const sorted = [...tokens].sort((a, b) => a.end - b.end);
    const clusters = [];
    for (const t of sorted) {
        const last = clusters[clusters.length - 1];
        if (last && t.end - last.anchor <= tolerance) {
            last.tokens.push(t);
            last.lines.add(t.lineIdx);
        } else {
            clusters.push({ anchor: t.end, tokens: [t], lines: new Set([t.lineIdx]) });
        }
    }
    return clusters.map(c => {
        const ends = c.tokens.map(t => t.end).sort((a, b) => a - b);
        return {
            center: ends[Math.floor(ends.length / 2)],
            minEnd: ends[0],
            maxEnd: ends[ends.length - 1],
            tokens: c.tokens,
            lineCount: c.lines.size,
        };
    }).sort((a, b) => a.center - b.center);
}

function mergeCloseColumns(clusters, maxGap = 8) {
    const out = [];
    for (const c of clusters) {
        const prev = out[out.length - 1];
        if (prev && c.center - prev.center <= maxGap) {
            const tokensAll = [...prev.tokens, ...c.tokens];
            const ends = tokensAll.map(t => t.end).sort((a, b) => a - b);
            out[out.length - 1] = {
                center: ends[Math.floor(ends.length / 2)],
                minEnd: ends[0],
                maxEnd: ends[ends.length - 1],
                tokens: tokensAll,
                lineCount: new Set(tokensAll.map(t => t.lineIdx)).size,
            };
        } else out.push(c);
    }
    return out;
}

function columnTolerance(c) {
    return Math.max(3, Math.ceil((c.maxEnd - c.minEnd) / 2) + 1);
}

// ───────────────────────── dates and scale ─────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function iso(y, monthName, day) {
    const mi = MONTHS.findIndex(m => m.toLowerCase() === String(monthName).toLowerCase());
    if (mi < 0) return null;
    const d = Number(day), yr = Number(y);
    if (!(d >= 1 && d <= 31) || !(yr >= 1900 && yr <= 2100)) return null;
    return `${yr}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Every printed date in a block of text, plus bare trailing years that continue
// the previous date ("June 30, 2026 and 2025" prints the day once).
function printedDates(text) {
    const t = clean(text);
    const out = [];
    const re = /([A-Z][a-z]+)\s+(\d{1,2}),?\s*(\d{4})/g;
    let m;
    while ((m = re.exec(t))) {
        const end = iso(m[3], m[1], m[2]);
        if (end) out.push({ endDate: end, index: m.index, print: clean(m[0]) });
    }
    for (const m2 of t.matchAll(/(?:and|,)\s+(\d{4})\b(?!\s*[,.]?\s*\d)/g)) {
        const before = out.filter(d => d.index < m2.index).pop();
        if (!before) continue;
        const [, mm, dd] = before.endDate.split('-');
        const end = `${m2[1]}-${mm}-${dd}`;
        if (MONTHS[Number(mm) - 1] && !out.some(d => d.endDate === end)) {
            out.push({ endDate: end, index: m2.index, print: clean(m2[0]) });
        }
    }
    return out.sort((a, b) => a.index - b.index);
}

const DURATION_WORDS = { three: 3, four: 4, six: 6, nine: 9, twelve: 12 };
// Period from a printed column header. Returns {endDate, durationMonths, print}.
function parsePeriod(label) {
    const t = clean(label);
    if (!t) return null;
    const datePart = '([A-Z][a-z]+)\\s+(\\d{1,2}),?\\s*(\\d{4})';
    let m = new RegExp(`\\b(${Object.keys(DURATION_WORDS).join('|')})\\s+months?\\s+ended\\s+${datePart}`, 'i').exec(t);
    if (m) {
        const endDate = iso(m[4], m[2], m[3]);
        if (endDate) return { endDate, durationMonths: DURATION_WORDS[m[1].toLowerCase()], print: clean(m[0]) };
    }
    m = new RegExp(`years?\\s+(?:and\\s+\\w+\\s+months?\\s+)?ended\\s+${datePart}`, 'i').exec(t);
    if (m) {
        const endDate = iso(m[3], m[1], m[2]);
        if (endDate) return { endDate, durationMonths: 12, print: clean(m[0]) };
    }
    m = new RegExp(`months?\\s+ended\\s+${datePart}`, 'i').exec(t);
    if (m) {
        const endDate = iso(m[3], m[1], m[2]);
        if (endDate) return { endDate, durationMonths: null, print: clean(m[0]) };
    }
    m = new RegExp(`as\\s+at\\s+${datePart}`, 'i').exec(t);
    if (m) {
        const endDate = iso(m[3], m[1], m[2]);
        if (endDate) return { endDate, durationMonths: null, print: clean(m[0]) };
    }
    m = new RegExp(datePart, 'i').exec(t);
    if (m) {
        const endDate = iso(m[3], m[1], m[2]);
        if (endDate) return { endDate, durationMonths: null, print: clean(m[0]) };
    }
    m = /\b(19|20)\d{2}\b/.exec(t);
    if (m) return { endDate: null, year: Number(m[0]), durationMonths: null, print: m[0] };
    return null;
}

const CURRENCIES = [
    ['CAD', /\bcanadian dollars?\b|\bC\$|\bCDN\$|\bCAD\b/i],
    ['USD', /\bU\.?\s?S\.?\s+dollars?\b|\bUS\$|\bUSD\b|\bunited states dollars?\b/i],
    ['EUR', /\beuros?\b|€|\bEUR\b/i],
    ['GBP', /\bpounds? sterling\b|£|\bGBP\b/i],
];
const SCALE_WORDS = { thousand: 1e3, thousands: 1e3, million: 1e6, millions: 1e6, billion: 1e9, billions: 1e9 };

// Currency and scale as stated for a table. Both must be printed.
function parseScaleCurrency(text) {
    const t = clean(text);
    const scaleHits = new Map();
    const re = /\b(thousands?|millions?|billions?)\b/gi;
    let m;
    while ((m = re.exec(t))) {
        if (/except\s*$/i.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
        scaleHits.set(SCALE_WORDS[m[1].toLowerCase()], clean(m[0]));
    }
    const currencyHits = [];
    for (const [code, rx] of CURRENCIES) {
        const hit = rx.exec(t);
        if (hit) currencyHits.push({ code, print: clean(hit[0]) });
    }
    return {
        scale: scaleHits.size === 1 ? [...scaleHits.keys()][0] : null,
        scalePrint: scaleHits.size === 1 ? [...scaleHits.values()][0] : [...scaleHits.values()],
        scaleAmbiguous: scaleHits.size > 1,
        currency: currencyHits.length === 1 ? currencyHits[0].code : null,
        currencyPrint: currencyHits.map(c => c.print),
        currencyAmbiguous: currencyHits.length > 1,
    };
}

// ───────────────────────── statements ─────────────────────────

const TITLE_RE = /^(?:condensed\s+interim\s+|interim\s+)?consolidated\s+(?:condensed\s+)?(?:interim\s+)?(?:statements?|balance\s+sheets?)\s+(?:of\s+)?(.*)$/i;
function classifyTitle(line) {
    const t = clean(line);
    const m = TITLE_RE.exec(t);
    if (!m) {
        if (/^consolidated\s+(?:condensed\s+)?balance\s+sheets?$/i.test(t)) return { kind: 'balance_sheet', title: t };
        return null;
    }
    const tail = m[1].toLowerCase();
    if (/^(?:financial\s+position|financial\s+condition|balance\s+sheets?)/.test(tail)) return { kind: 'balance_sheet', title: t };
    if (/^(?:cash\s+flows?)/.test(tail)) return { kind: 'cash_flow', title: t };
    if (/^(?:loss\s+and\s+comprehensive\s+loss|income\s+and\s+comprehensive\s+income|operations\s+and\s+comprehensive|comprehensive\s+income\s+\(loss\))/.test(tail)
        && !/^comprehensive/.test(tail)) return { kind: 'income_statement', title: t };
    if (/^(?:income|operations|earnings|loss|revenues?)/.test(tail)) return { kind: 'income_statement', title: t };
    return null;
}

const END_MARKERS = [
    /^the accompanying notes/i,
    /^notes to the (?:consolidated|interim|condensed)/i,
    /^approved by the board/i,
    /^\(signed\)/i,
    /^\d{1,2}\)\s/,                        // "1) December 31, 2025 comparatives ..."
    /^\*?\s*see accompanying notes/i,
];
const FOOTER_RE = /^[A-Za-z0-9 .&'’()|\/-]{8,}\s{2,}.*\s\d{1,3}$/;   // "BIRD CONSTRUCTION INC.   ANNUAL 2025 ...   9"
// A page footer names the issuer/statement and ends with a page number. It is
// only ever at the very bottom of a page, so a long row label with two small
// amounts ("Accumulated other comprehensive income (loss)   65   20") is not one.
function isPageFooter(line) {
    const t = line.trim();
    if (!t) return false;
    if (!/[A-Za-z]{3}/.test(t) || !FOOTER_RE.test(t)) return false;
    return t.replace(/\s+\d{1,3}$/, '').split(/\s+/).length >= 5;
}
function isEndMarker(line, pageIdx, lines) {
    const t = line.trim();
    if (!t) return false;
    if (END_MARKERS.some(rx => rx.test(t))) return true;
    let last = lines.length - 1;
    while (last > 0 && !clean(lines[last])) last--;
    return pageIdx >= last - 2 && isPageFooter(line);
}

// Header cells are separated by two or more spaces; each keeps its position.
function headerCells(line) {
    const out = [];
    const re = /\S+(?:[ ]\S+)*/g;
    let m;
    while ((m = re.exec(line))) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    return out;
}

function pickHeaderCell(cells, center) {
    let best = null;
    for (const c of cells) {
        const mid = (c.start + c.end) / 2;
        const d = Math.abs(mid - center);
        if (d > 32) continue;
        if (!best || d < best.d) best = { cell: c, d };
    }
    return best ? best.cell : null;
}

function normalizeLabel(s) {
    return clean(s)
        .replace(/^[(\[]?\d{1,2}[)\]]?\s+/, '')      // stray "1) " start
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .replace(/[.]$/, '');
}

// ───────────────────────── one document ─────────────────────────

function pdfToText(pdfPath) {
    const base = path.basename(pdfPath).replace(/\.pdf$/i, '');
    const txtPath = path.join(TEXT_DIR, base + '.txt');
    let need = true;
    try {
        need = fs.statSync(txtPath).mtimeMs < fs.statSync(pdfPath).mtimeMs;
    } catch { /* missing */ }
    if (need) {
        fs.mkdirSync(TEXT_DIR, { recursive: true });
        execFileSync('pdftotext', ['-layout', pdfPath, txtPath], { stdio: 'pipe' });
    }
    return fs.readFileSync(txtPath, 'utf8');
}

function pageCount(pdfPath) {
    try {
        const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
        const m = info.match(/^Pages:\s+(\d+)/m);
        return m ? Number(m[1]) : null;
    } catch { return null; }
}

function extractStatement(pages, pageIdx, titleInfo) {
    const statement = {
        kind: titleInfo.kind,
        title: titleInfo.title,
        page: pageIdx + 1,
        currency: null,
        scale: null,
        columns: [],
        rows: [],
        checks: [],
        verified: false,
        rejections: [],
    };
    const lines = pages[pageIdx];
    const titleLine = lines.findIndex(l => clean(l) === titleInfo.title);
    if (titleLine < 0) { statement.rejections.push('title line not found'); return statement; }

    // The issuer's name is printed above the title.
    const issuerLine = lines.slice(Math.max(0, titleLine - 4), titleLine).map(clean).filter(Boolean).pop() || null;
    statement.issuerPrinted = issuerLine;

    // Body runs from the title to the first end marker.
    let end = lines.length;
    for (let i = titleLine + 1; i < lines.length; i++) {
        if (isEndMarker(lines[i], i, lines)) { end = i; break; }
    }
    const body = lines.slice(titleLine + 1, end);
    const bodyToPage = (i) => titleLine + 1 + i;

    // Scale/currency line, and the subtitle above it.
    let scaleIdx = -1;
    for (let i = 0; i < body.length; i++) {
        const t =clean(body[i]);
        if (/^\(?.*\b(thousands?|millions?|billions?)\b.*\)?$/i.test(t) && parseScaleCurrency(t).scale) { scaleIdx = i; break; }
    }
    if (scaleIdx < 0) { statement.rejections.push('scale/currency line not stated'); return statement; }
    const sc = parseScaleCurrency(body[scaleIdx]);
    statement.scale = sc.scale;
    statement.currency = sc.currency;
    statement.scalePrint = sc.scalePrint;
    statement.currencyPrint = sc.currencyPrint;
    if (!sc.scale) statement.rejections.push('scale not stated unambiguously');
    if (!sc.currency) statement.rejections.push('currency not stated unambiguously');
    if (statement.rejections.length) return statement;

    const subtitle = body.slice(0, scaleIdx).map(clean).filter(Boolean).join(' ');
    statement.subtitle = subtitle;

    // Column geometry from the whole printed table area, excluding prose.
    const tokens = [];
    body.forEach((line, i) => {
        if (i <= scaleIdx) return;
        if (isEndMarker(line, bodyToPage(i), lines)) return;
        for (const t of numberTokens(line)) tokens.push({ ...t, lineIdx: i, line });
    });
    // A note-reference column prints as one- and two-digit integers ("9", "10",
    // "9,10" splits into 9 and 10) and sits close to the first amount column, so
    // it is set aside before the drifting amount columns are merged.
    const rawClusters = clusterColumns(tokens).filter(c => c.lineCount >= 4);
    const isNoteColumn = (c) => c.tokens.every(t => /^\d{1,2}$/.test(t.text));
    const noteLikeClusters = rawClusters.filter(isNoteColumn);
    const clusters = mergeCloseColumns(rawClusters.filter(c => !isNoteColumn(c)));
    if (!clusters.length) { statement.rejections.push('no numeric table columns found'); return statement; }

    const assignAny = (tok) => {
        let best = null;
        for (const c of [...clusters, ...noteLikeClusters]) {
            const d = Math.abs(tok.end - c.center);
            if (d <= columnTolerance(c) && (!best || d < best.d)) best = { col: c, d };
        }
        return best ? best.col : null;
    };

    // The table starts at the first line that prints a row label plus at least
    // two amounts; header lines ("Note 2025 2024", "September 30, March 31,",
    // "$  $") carry a printed date instead of a label and are skipped.
    const DATE_WORDS = new RegExp(`\\b(?:19|20)\\d{2}\\b|\\b(?:${MONTHS.join('|')})\\b`);
    const headerStart = scaleIdx + 1;
    let dataStart = body.length;
    for (let i = headerStart; i < body.length; i++) {
        const line = body[i];
        if (!clean(line)) continue;
        if (isEndMarker(line, bodyToPage(i), lines)) break;
        if (DATE_WORDS.test(line)) continue;
        const toks = numberTokens(line).map(t => ({ ...t, col: assignAny(t) }));
        if (toks.filter(t => t.col).length < 2) continue;
        const labelEnd = Math.min(...toks.filter(t => t.col).map(t => t.start));
        const label = clean(line.slice(0, labelEnd)).replace(/[\s$]+$/, '');
        if (!label || /^notes?$/i.test(label)) continue;
        dataStart = i;
        break;
    }
    if (dataStart >= body.length) { statement.rejections.push('no data rows found'); return statement; }

    const headerLines = body.slice(headerStart, dataStart);
    statement.headerPrint = headerLines.map(clean).filter(Boolean);

    // Column labels: one header cell per header line, the one closest to the column: "Three
    // months ended June 30," on the first line, "2026" on the second.
    const withHeader = clusters.map(c => {
        const parts = [];
        let noteCell = false;
        for (const hl of headerLines) {
            const cell = pickHeaderCell(headerCells(hl), c.center);
            if (!cell || /^\$+$/.test(cell.text)) continue;
            if (/^notes?$/i.test(cell.text)) noteCell = true;
            parts.push(cell.text);
        }
        return { ...c, headerText: clean(parts.join(' ')), noteCell };
    });
    // The note column is dropped when its header says "Note(s)"; a second cluster
    // of one- and two-digit integers ("9,10" splits into 9 and 10) is set aside
    // before the amount columns are merged.
    const kept = withHeader.filter(c => !c.noteCell);
    const dropped = withHeader.filter(c => !kept.includes(c));
    statement.droppedColumns = [...noteLikeClusters, ...dropped].map(c => ({ center: c.center, header: c.headerText || null, values: c.tokens.slice(0, 6).map(t => t.text) }));
    if (!kept.length) { statement.rejections.push('no amount columns left after dropping note column'); return statement; }
    kept.sort((a, b) => a.center - b.center);
    if (process.env.SEDAR_DEBUG) console.error('COLS', kept.map(c => c.center + '|' + c.headerText + '|' + c.tokens.slice(0, 8).map(t => t.text).join('/')));

    // Assign every token to the nearest printed column: the amount columns give
    // the values, all of them (notes included) mark where the row label ends.
    const nearest = (tok, cols) => {
        let best = null;
        for (const c of cols) {
            const d = Math.abs(tok.end - c.center);
            if (d <= columnTolerance(c) && (!best || d < best.d)) best = { col: c, d };
        }
        return best ? best.col : null;
    };
    const assign = (tok) => nearest(tok, kept);
    const assignBoundary = (tok) => nearest(tok, rawClusters);

    // Column labels: one cell per header line, chosen by closest position.
    const colLabels = kept.map(c => c.headerText);

    // Resolve each column to a printed period.
    const dates = printedDates([subtitle, ...headerLines].join(' '));
    statement.columns = kept.map((c, i) => {
        const label = colLabels[i];
        let period = parsePeriod(label);
        if (period && period.endDate) {
            return { label, print: period.print, endDate: period.endDate, durationMonths: period.durationMonths, resolvedFrom: 'column header' };
        }
        const year = period && period.year;
        if (!year) return { label, endDate: null, durationMonths: null, resolvedFrom: null };
        const exact = dates.find(d => d.endDate.startsWith(String(year)));
        if (exact) {
            const dur = /years?\s+ended/i.test(subtitle) ? 12 : (/months?\s+ended/i.test(subtitle) ? null : null);
            return { label, print: exact.print, endDate: exact.endDate, durationMonths: statement.kind === 'balance_sheet' ? null : dur, resolvedFrom: 'subtitle' };
        }
        const anyDate = dates[0];
        if (anyDate) {
            const [, mm, dd] = anyDate.endDate.split('-');
            const endDate = `${year}-${mm}-${dd}`;
            if (Number(mm) >= 1 && Number(mm) <= 12 && year <= Number(anyDate.endDate.slice(0, 4)) + 1) {
                const dur = /years?\s+ended/i.test(subtitle) ? 12 : null;
                return { label, print: anyDate.print, endDate, durationMonths: statement.kind === 'balance_sheet' ? null : dur, resolvedFrom: 'subtitle (year matched)' };
            }
        }
        return { label, endDate: null, durationMonths: null, resolvedFrom: null };
    });
    if (statement.columns.some(c => !c.endDate)) {
        statement.rejections.push('a column has no printed date: ' + statement.columns.filter(c => !c.endDate).map(c => c.label || '(blank header)').join(', '));
        return statement;
    }
    if (statement.kind !== 'balance_sheet' && statement.columns.some(c => !c.durationMonths)) {
        statement.rejections.push('a flow column has no printed duration: ' + statement.columns.filter(c => !c.durationMonths).map(c => c.label).join(', '));
        return statement;
    }

    // Rows.
    for (let i = dataStart; i < body.length; i++) {
        const line = body[i];
        if (!clean(line)) continue;
        if (isEndMarker(line, bodyToPage(i), lines)) break;
        const toks = numberTokens(line).map(t => ({ ...t, col: assign(t), boundary: assignBoundary(t) }));
        const amounts = toks.filter(t => t.col);
        if (process.env.SEDAR_DEBUG) console.error('ROWDBG', JSON.stringify(clean(line).slice(0, 60)), toks.map(t => t.text + '@' + t.end + '->' + (t.col ? t.col.center : 'none')));
        if (!amounts.length) {
            const cont = clean(line.replace(/\$/g, ' '));
            if (cont && statement.rows.length && cont.length >= 3 && !/^\$+$/.test(cont)) {
                const last = statement.rows[statement.rows.length - 1];
                if (!last.values.some(v => v.kind === 'number')) last.label = clean(last.label + ' ' + cont);
            }
            continue;
        }
        const labelEnd = Math.min(...toks.filter(t => t.boundary).map(t => t.start));
        const label = clean(line.slice(0, labelEnd)).replace(/[\s$]+$/, '');
        if (label && /^notes?$/i.test(label)) continue;
        const values = kept.map(() => ({ kind: 'blank', value: null, text: '' }));
        for (const t of amounts) {
            const idx = kept.indexOf(t.col);
            const parsed = parseAmount(t.text);
            values[idx] = { ...parsed, text: t.text, raw: t.text };
        }
        statement.rows.push({ label: label || '(unlabelled)', unlabelled: !label, values });
    }

    // Scale the values, keep the printed text.
    for (const row of statement.rows) {
        row.scaled = row.values.map(v => (v.kind === 'number' || v.kind === 'zero') ? v.value * statement.scale : null);
    }

    statement.rowsFound = statement.rows.length;
    runChecks(statement);
    return statement;
}

// ───────────────────────── printed identities ─────────────────────────

function findRow(rows, patterns) {
    for (const rx of patterns) {
        const row = rows.find(r => rx.test(normalizeLabel(r.label)));
        if (row) return row;
    }
    return null;
}

function checkColumns(statement, name, detail, left, right) {
    const failures = [];
    const perColumn = statement.columns.map((c, i) => {
        const a = left(i), b = right(i);
        if (a == null || b == null) return { column: c.label, skipped: true };
        const diff = a - b;
        const ok = Math.abs(diff) < 0.5;
        if (!ok) failures.push({ column: c.label, left: a, right: b, diff });
        return { column: c.label, left: a, right: b, diff, ok };
    });
    const ran = perColumn.filter(c => !c.skipped).length;
    statement.checks.push({
        name,
        detail,
        status: ran === 0 ? 'skipped' : (failures.length ? 'failed' : 'passed'),
        ran,
        columns: perColumn,
        failures,
    });
}

const RX = {
    totalAssets: [/^total assets$/, /^total\s+assets$/],
    totalLiabilities: [/^total liabilities$/],
    totalEquity: [/^total shareholders'? equity$/, /^total stockholders'? equity$/, /^total equity$/],
    totalLiabEquity: [/^total liabilities and (?:shareholders'?|stockholders'?) equity$/, /^total liabilities and equity$/],
    revenue: [/^(?:total )?(?:construction |contract )?revenues?$/, /^total (?:revenue|revenues|sales)$/],
    cost: [/^total cost of revenue$/, /^costs? of (?:revenue|construction|sales|goods sold)$/, /^total costs? of (?:revenue|sales|construction)$/],
    grossProfit: [/^gross profit(?: \(loss\))?$/],
    netIncome: [/^net (?:income|loss|earnings)(?: for the (?:period|year))?$/],
    preTax: [/^(?:income|loss) before income tax(?:es)?(?: expense)?(?: \(recovery\))?$/, /^(?:income|loss) before income tax(?:es)?$/],
    tax: [/^income tax (?:expense|recovery)(?: \(recovery\)| \(expense\))?$/, /^income tax provision$/],
    cfNetIncome: [/^net (?:income|loss)(?: for the (?:period|year))?$/],
    cfEnd: [/^cash and cash equivalents[,\s]*(?:[–-]\s*)?(?:end|at end) of (?:the )?(?:period|year)$/],
    cfBegin: [/^cash and cash equivalents[,\s]*(?:[–-]\s*)?beginning of (?:the )?(?:period|year)$/],
    cfChange: [/^(?:net )?(?:increase|decrease) \(?(?:increase|decrease)?\)? in cash and cash equivalents.*(?:period|year)$/, /^(?:net )?(?:increase|decrease) in cash and cash equivalents.*(?:period|year)$/],
    cfFx: [/^(?:effect|effects) of (?:foreign )?(?:exchange|currency).*cash and cash equivalents/],
};

function runChecks(statement) {
    const rows = statement.rows;
    const col = (row, i) => (row && row.scaled ? row.scaled[i] : null);

    if (statement.kind === 'balance_sheet') {
        const ta = findRow(rows, RX.totalAssets);
        const tl = findRow(rows, RX.totalLiabilities);
        const te = findRow(rows, RX.totalEquity);
        if (ta && tl && te) {
            checkColumns(statement, 'assets = liabilities + equity',
                `printed "Total assets" vs "Total liabilities" + "Total shareholders' equity" (${tl.label} + ${te.label})`,
                i => col(ta, i), i => (col(tl, i) == null || col(te, i) == null) ? null : col(tl, i) + col(te, i));
        } else {
            statement.checks.push({ name: 'assets = liabilities + equity', status: 'skipped', detail: 'one of the printed totals is missing' });
        }
        const tle = findRow(rows, RX.totalLiabEquity);
        if (ta && tle) {
            checkColumns(statement, 'assets = total liabilities and equity', `printed "${ta.label}" vs "${tle.label}"`, i => col(ta, i), i => col(tle, i));
        }
        const cur = findRow(rows, [/^total current assets$/]);
        const noncur = findRow(rows, [/^total non-current assets$/, /^total noncurrent assets$/]);
        if (ta && cur && noncur) {
            checkColumns(statement, 'current + non-current assets = total assets', `"${cur.label}" + "${noncur.label}" vs "${ta.label}"`,
                i => (col(cur, i) == null || col(noncur, i) == null) ? null : col(cur, i) + col(noncur, i), i => col(ta, i));
        }
    }

    if (statement.kind === 'income_statement') {
        const rev = findRow(rows, RX.revenue);
        const cost = findRow(rows, RX.cost);
        const gp = findRow(rows, RX.grossProfit);
        if (rev && cost && gp) {
            checkColumns(statement, 'revenue - cost = gross profit', `"${rev.label}" - "${cost.label}" vs "${gp.label}"`,
                i => (col(rev, i) == null || col(cost, i) == null) ? null : col(rev, i) - col(cost, i), i => col(gp, i));
        }
        const net = findRow(rows, RX.netIncome);
        const pre = findRow(rows, RX.preTax);
        const tax = findRow(rows, RX.tax);
        if (net && pre && tax) {
            checkColumns(statement, 'pre-tax - tax = net income', `"${pre.label}" - "${tax.label}" vs "${net.label}"`,
                i => (col(pre, i) == null || col(tax, i) == null) ? null : col(pre, i) - col(tax, i), i => col(net, i));
        }
        if (!statement.checks.some(c => c.status === 'passed')) {
            statement.checks.push({ name: 'income identities', status: 'skipped', detail: 'the printed lines needed for an identity check were not found' });
        }
    }

    if (statement.kind === 'cash_flow') {
        const beg = findRow(rows, RX.cfBegin);
        const end = findRow(rows, RX.cfEnd);
        const chg = findRow(rows, RX.cfChange);
        const fx = findRow(rows, RX.cfFx);
        if (beg && end && chg) {
            // Issuers differ on whether the printed FX line is already inside the
            // printed net change; a statement passes when either printed identity holds.
            const perColumn = statement.columns.map((c, i) => {
                const b = col(beg, i), ch = col(chg, i), e = col(end, i);
                if (b == null || ch == null || e == null) return { column: c.label, skipped: true };
                const withFx = fx && col(fx, i) != null ? b + ch + col(fx, i) : null;
                const withoutFx = b + ch;
                const used = withFx != null && Math.abs(withFx - e) < 0.5 ? 'with FX effect'
                    : (Math.abs(withoutFx - e) < 0.5 ? 'without FX effect (printed change already includes it)' : null);
                return { column: c.label, beginning: b, change: ch, fxEffect: fx ? col(fx, i) : null, end: e, used, ok: !!used };
            });
            const ran = perColumn.filter(c => !c.skipped);
            statement.checks.push({
                name: 'beginning + net change = end',
                detail: `"${beg.label}" + "${chg.label}" (+ "${fx ? fx.label : 'FX effect'}") vs "${end.label}"`,
                status: ran.length === 0 ? 'skipped' : (ran.every(c => c.ok) ? 'passed' : 'failed'),
                ran: ran.length,
                columns: perColumn,
                failures: ran.filter(c => !c.ok),
            });
        }
        const cfNet = findRow(rows, RX.cfNetIncome);
        const isNet = findRow(rows, [/^net (?:income|loss)(?: for the (?:period|year))?$/]);
        if (cfNet && isNet) {
            // Same document: the two printed lines must agree (income vs cash flow).
            checkColumns(statement, 'cash-flow net income = income-statement net income', `"${cfNet.label}" in both statements`,
                i => col(cfNet, i), i => col(isNet, i));
        }
        const cashSplit = findRow(rows, [/^cash$/]);
        const cashEq = findRow(rows, [/^cash equivalents$/]);
        if (end && cashSplit && cashEq) {
            checkColumns(statement, 'cash + cash equivalents = end of period', `"${cashSplit.label}" + "${cashEq.label}" vs "${end.label}"`,
                i => (col(cashSplit, i) == null || col(cashEq, i) == null) ? null : col(cashSplit, i) + col(cashEq, i), i => col(end, i));
        }
    }

    const failed = statement.checks.filter(c => c.status === 'failed');
    const passed = statement.checks.filter(c => c.status === 'passed');
    statement.verified = !failed.length && passed.length >= (statement.kind === 'cash_flow' ? 1 : 1);
    if (failed.length) statement.rejections.push(...failed.map(f => `${f.name} failed in ${f.failures.map(x => x.column).join(', ')}`));
}

// ───────────────────────── document driver ─────────────────────────

const KIND_ORDER = ['balance_sheet', 'income_statement', 'cash_flow'];

function extractDocument(pdfPath) {
    const text = pdfToText(pdfPath);
    const pages = text.split('\f').map(p => p.split('\n'));
    const found = [];
    for (let i = 0; i < pages.length; i++) {
        // A statement title is at the head of its page; a matching phrase deep in
        // a notes page is a cross-reference, not a statement.
        const head = pages[i].map((l, idx) => ({ l, idx })).filter(x => clean(x.l)).slice(0, 5);
        for (const { l: line } of head) {
            const info = classifyTitle(line);
            if (!info) continue;
            found.push(extractStatement(pages, i, info));
            break; // one statement per page in the filed PDFs seen so far
        }
    }
    // Cross-statement: cash-flow net income equals the income statement's, period by period.
    const is = found.find(s => s.kind === 'income_statement' && s.verified);
    const cf = found.find(s => s.kind === 'cash_flow');
    if (is && cf) {
        const isNet = findRow(is.rows, RX.netIncome);
        const cfNet = findRow(cf.rows, RX.cfNetIncome);
        if (isNet && cfNet) {
            const pairs = [];
            for (const iColumn of cf.columns) {
                const isIdx = is.columns.findIndex(c => c.endDate === iColumn.endDate && c.durationMonths === iColumn.durationMonths);
                const cfIdx = cf.columns.indexOf(iColumn);
                if (isIdx < 0) continue;
                pairs.push({
                    period: iColumn.label, cf: cfNet.scaled[cfIdx], is: isNet.scaled[isIdx],
                    ok: cfNet.scaled[cfIdx] != null && isNet.scaled[isIdx] != null && Math.abs(cfNet.scaled[cfIdx] - isNet.scaled[isIdx]) < 0.5,
                });
            }
            cf.checks.push({
                name: 'cash-flow net income = income statement net income (same period)',
                status: pairs.length ? (pairs.every(p => p.ok) ? 'passed' : 'failed') : 'skipped',
                detail: 'matched by printed period end and duration',
                columns: pairs,
            });
            if (pairs.length && !pairs.every(p => p.ok)) {
                cf.verified = false;
                cf.rejections.push('cross-statement net income differs');
            }
        }
    }

    const pdfBytes = fs.readFileSync(pdfPath);
    const receipt = {
        schemaVersion: 'sedar-receipt-1',
        extractor: 'scripts/extract-sedar-statements.js',
        extractorVersion: EXTRACTION_VERSION,
        extractedAt: new Date().toISOString(),
        document: {
            file: path.basename(pdfPath),
            bytes: pdfBytes.length,
            sha256: crypto.createHash('sha256').update(pdfBytes).digest('hex'),
            pages: pageCount(pdfPath),
        },
        issuer: found.map(s => s.issuerPrinted).find(Boolean) || null,
        statements: found,
        complete: KIND_ORDER.every(k => found.some(s => s.kind === k && s.verified)),
    };
    return receipt;
}

// ───────────────────────── manifest + report ─────────────────────────

function loadManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(DL_DIR, 'manifest.json'), 'utf8'));
    } catch { return null; }
}

function manifestEntry(manifest, file) {
    if (!manifest || !Array.isArray(manifest.documents)) return null;
    const node = (file.match(/-(W\d+)\.pdf$/i) || [])[1];
    const entry = manifest.documents.find(d => d.file === file || (node && d.sedarNode === node));
    return entry ? { ...entry, ticker: manifest.ticker, issuer: manifest.issuer, sedarIssuerNumber: manifest.sedarIssuerNumber } : null;
}

function markdownReport(receipts) {
    const out = [];
    out.push('| document | page | statement | currency/scale | columns | checks | verified |');
    out.push('|---|---|---|---|---|---|---|');
    for (const r of receipts) {
        for (const s of r.statements) {
            const cols = s.columns.map(c => c.endDate + (c.durationMonths ? ` (${c.durationMonths}m)` : '')).join('; ');
            const checks = s.checks.map(c => `${c.name}: ${c.status}`).join('; ');
            out.push(`| ${r.document.file} | ${s.page} | ${s.kind} | ${s.currency || '?'} / ${s.scale ? '×' + s.scale : '?'} | ${cols || '—'} | ${checks} | ${s.verified ? 'yes' : 'NO'} |`);
            for (const rej of s.rejections) out.push(`| | | ↳ rejected: ${rej} | | | | |`);
        }
    }
    return out.join('\n');
}

// ───────────────────────── main ─────────────────────────

function main() {
    const args = process.argv.slice(2);
    const opt = (name, def) => {
        const i = args.indexOf(name);
        if (i < 0) return def;
        const v = args[i + 1];
        args.splice(i, 2);
        return v;
    };
    const outDir = opt('--out', path.join(CACHE, 'receipts'));
    const reportPath = opt('--report', null);
    const quiet = args.includes('--quiet');
    if (quiet) args.splice(args.indexOf('--quiet'), 1);

    let pdfs = args.filter(a => !a.startsWith('--'));
    if (!pdfs.length) {
        pdfs = fs.existsSync(DL_DIR) ? fs.readdirSync(DL_DIR).filter(f => /\.pdf$/i.test(f)).sort().map(f => path.join(DL_DIR, f)) : [];
    }
    if (!pdfs.length) { console.error('no PDFs to read (put them in .cache/sedar/downloads/)'); process.exit(2); }

    fs.mkdirSync(outDir, { recursive: true });
    const manifest = loadManifest();
    const receipts = [];
    for (const pdf of pdfs) {
        const receipt = extractDocument(pdf);
        const entry = manifestEntry(manifest, path.basename(pdf));
        if (entry) receipt.manifest = entry;
        const outFile = path.join(outDir, path.basename(pdf).replace(/\.pdf$/i, '.json'));
        fs.writeFileSync(outFile, JSON.stringify(receipt, null, 1));
        receipts.push(receipt);
        if (!quiet) {
            console.log(`\n${receipt.document.file}  (${receipt.statements.length} statement pages, complete=${receipt.complete})`);
            for (const s of receipt.statements) {
                console.log(`  p${s.page}  ${s.kind.padEnd(16)} ${s.verified ? 'VERIFIED' : 'rejected'}  ${s.currency || '?'}/${s.scale ? 'x' + s.scale : '?'}  ${s.columns.map(c => c.endDate + (c.durationMonths ? `/${c.durationMonths}m` : '')).join(' ')}`);
                for (const c of s.checks) {
                    console.log(`      ${c.status.padEnd(8)} ${c.name}`);
                }
                for (const rej of s.rejections) console.log(`      ! ${rej}`);
            }
            console.log(`  receipt: ${path.relative(process.cwd(), outFile)}`);
        }
    }

    if (reportPath) {
        fs.writeFileSync(reportPath, markdownReport(receipts) + '\n');
        if (!quiet) console.log(`\nreport: ${reportPath}`);
    }

    const complete = receipts.filter(r => r.complete).length;
    if (!quiet) {
        console.log(`\n${complete}/${receipts.length} documents with a verified balance sheet, income statement and cash flow`);
        const partial = receipts.filter(r => !r.complete).map(r => r.document.file);
        if (partial.length) console.log('incomplete: ' + partial.join(', '));
    }
    process.exitCode = complete === receipts.length ? 0 : 1;
}

if (require.main === module) main();

module.exports = { extractDocument, extractStatement, parsePeriod, parseScaleCurrency, parseAmount, numberTokens, clusterColumns, printedDates, classifyTitle };
