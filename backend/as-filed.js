'use strict';
// Each company's income statement, balance sheet and cash-flow statement as it files
// them: its own line items, labels and order, company-defined (custom) tags included,
// from SEC's Financial Statement Data Sets (PRE gives the lines of each statement, NUM
// their values). The standardized rows on the page come from a fixed list of us-gaap /
// ifrs tags, so a line a company files under its own tag has no row there; here every
// filed line is a row.
//
// Built by scripts/build-as-filed.js into frontend/data/sec-as-filed/<cik>.json.
//
// Years are stitched from successive annual reports, newest first: the latest report
// sets the lines and their labels, and each older report adds the years the newer
// ones do not reach. An older report's line is matched to a row by its tag, else by
// the same figure for a year both reports present, else by the same label; a line
// that matches no row is kept as its own row, placed after the row its predecessor
// matched. A value is the one in the newest report that presents that year (so a
// restatement wins). Nothing is computed: a cell is a filed value or empty.
const fs = require('node:fs');
const path = require('node:path');
const p = require('./sec-coverage');

const DIR = () => path.join(p.DATA_DIR, 'sec-as-filed');
const STATEMENTS = { IS: 'income', BS: 'balance', CF: 'cash' };
const MAX_YEARS = 10;

const norm = (s) => String(s || '').toLowerCase().replace(/\(in [^)]*\)/g, '').replace(/[^a-z0-9]+/g, '');
const kindOf = (uom) => uom === 'shares' ? 'shares' : /\/shares$/.test(uom) ? 'ps' : /^[A-Z]{3}$/.test(uom) ? 'money' : 'other';

// The year-end columns a report presents for one statement: dates where at least half
// as many of its lines carry a value as at its best-covered date (a stray date that a
// single line carries, such as a balance at an acquisition date, is not a column).
function columnsOf(filing, lines, stmt) {
    const qtrs = stmt === 'BS' ? 0 : 4, count = new Map();
    for (const ln of lines) {
        const seen = new Set();
        for (const [end, q] of filing.n[ln[0]] || []) if (q === qtrs && end <= filing.p && !seen.has(end)) { seen.add(end); count.set(end, (count.get(end) || 0) + 1); }
    }
    const best = Math.max(0, ...count.values());
    return [...count].filter(([, n]) => n >= Math.max(1, best / 2)).map(([end]) => end);
}

const DAY = 86400000;
const OPENING = /\b(beginning|start|opening)\b/i, CLOSING = /\b(end|ending|closing)\b/i;
// One line's filed value for a column ending at `end`, in the statement currency where it
// has one. A cash-flow line that is a balance (cash at the beginning or end of the year) is
// filed as an instant: the beginning line is the balance a year before the column's end.
function valueAt(filing, line, end, stmt, currency) {
    const rows = filing.n[line[0]] || [];
    let qtrs = stmt === 'BS' ? 0 : 4, at = end;
    if (qtrs === 4 && !rows.some(([, q]) => q === 4) && rows.some(([, q]) => q === 0)) {
        qtrs = 0;
        if (line[4] ?? OPENING.test(line[2])) {
            const want = Date.parse(end) - 365.25 * DAY;
            at = rows.filter(([e, q]) => q === 0 && Math.abs(Date.parse(e) - want) <= 25 * DAY).map(([e]) => e).sort((a, b) => Math.abs(Date.parse(a) - want) - Math.abs(Date.parse(b) - want))[0];
            if (!at) return null;
        }
    }
    const hits = rows.filter(([e, q]) => e === at && q === qtrs);
    if (!hits.length) return null;
    const pick = hits.find(([, , u]) => u === currency) || hits.find(([, , u]) => u === currency + '/shares') || hits.find(([, , u]) => u === 'shares') || (hits.length === 1 ? hits[0] : null);
    return pick ? { v: pick[3], u: pick[2] } : null;
}

function currencyOf(filing) {
    const count = new Map();
    for (const rows of Object.values(filing.n)) for (const [, , u] of rows) if (/^[A-Z]{3}$/.test(u)) count.set(u, (count.get(u) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// filings: [{a, m (form), d (filed), p (period end), st: {IS|BS|CF: [[tag, custom, plabel, negating]]},
// n: {tag: [[end, qtrs, uom, value]]}}] for one issuer, any order.
function assemble(filings) {
    const list = filings.filter((f) => f.st && Object.keys(f.st).length).sort((a, b) => b.p.localeCompare(a.p) || b.d.localeCompare(a.d));
    if (!list.length) return null;
    const currency = currencyOf(list[0]);
    const out = { currency, filings: {}, statements: {} };
    for (const [stmt, name] of Object.entries(STATEMENTS)) {
        const rows = [], source = new Map();
        for (const f of list) {
            // a balance line filed twice on one statement (cash at the beginning and end of the year) is the
            // opening one when its label says so, else when it comes first
            const lines = f.st[stmt]?.map((ln, i, all) => {
                const again = all.findIndex((o, j) => j !== i && o[0] === ln[0]);
                return again < 0 ? ln : [ln[0], ln[1], ln[2], ln[3], OPENING.test(ln[2]) || (!CLOSING.test(ln[2]) && again > i)];
            });
            if (!lines?.length) continue;
            const cols = columnsOf(f, lines, stmt).filter((end) => !source.has(end));
            if (!cols.length) continue;
            const overlap = [...source.keys()];
            const claimed = new Set(), at = new Array(lines.length).fill(-1);
            const val = (ln, end) => { const x = valueAt(f, ln, end, stmt, currency); return x ? (ln[3] ? -x.v : x.v) : null; };
            // 1) same tag, 2) the same non-zero figure at every shared year (one row only), 3) same label (one row only)
            lines.forEach((ln, i) => { const r = rows.findIndex((row, j) => !claimed.has(j) && row.t === ln[0] && row.o === !!ln[4]); if (r >= 0) { at[i] = r; claimed.add(r); } });
            lines.forEach((ln, i) => {
                if (at[i] >= 0 || !overlap.length) return;
                const mine = overlap.map((end) => val(ln, end));
                if (!mine.some((v) => v)) return;
                const fit = rows.map((row, j) => j).filter((j) => !claimed.has(j) && overlap.every((end, k) => mine[k] === null || (rows[j].v.get(end) ?? null) !== null && Math.abs(rows[j].v.get(end)) === Math.abs(mine[k])) && overlap.some((end, k) => mine[k]));
                if (fit.length === 1) { at[i] = fit[0]; claimed.add(fit[0]); }
            });
            lines.forEach((ln, i) => {
                if (at[i] >= 0) return;
                const fit = rows.map((row, j) => j).filter((j) => !claimed.has(j) && norm(rows[j].l) === norm(ln[2]));
                if (fit.length === 1) { at[i] = fit[0]; claimed.add(fit[0]); }
            });
            // unmatched lines become rows of their own, after the row their predecessor matched
            let after = -1;
            lines.forEach((ln, i) => {
                if (at[i] >= 0) { after = at[i]; return; }
                const row = { l: ln[2], t: ln[0], c: ln[1], o: !!ln[4], v: new Map(), u: null, in: new Set() };
                rows.splice(after + 1, 0, row);
                for (let k = 0; k < at.length; k++) if (k !== i && at[k] > after) at[k]++;
                at[i] = after + 1; after = at[i];
            });
            lines.forEach((ln, i) => {
                const row = rows[at[i]];
                (row.in ||= new Set()).add(f.a);
                for (const end of cols) {
                    if (row.v.has(end)) continue;
                    const x = valueAt(f, ln, end, stmt, currency);
                    if (!x) continue;
                    row.v.set(end, ln[3] ? -x.v : x.v);
                    row.u ||= x.u;
                }
            });
            for (const end of cols) source.set(end, f.a);
            if (cols.length) out.filings[f.a] = { form: f.m, filed: f.d, period: f.p };
        }
        const ends = [...source.keys()].sort().slice(-MAX_YEARS);
        const kept = rows.filter((row) => ends.some((end) => row.v.has(end)));
        if (!kept.length) continue;
        out.statements[name] = {
            ends,
            src: ends.map((end) => source.get(end)),
            // x: the columns whose report does not present this line at all (as opposed to presenting it with no amount)
            lines: kept.map((row) => {
                const x = ends.map((end, i) => row.v.has(end) || row.in.has(source.get(end)) ? -1 : i).filter((i) => i >= 0);
                return { l: row.l, t: row.t, ...(row.c ? { c: 1 } : {}), k: kindOf(row.u || ''), v: ends.map((end) => row.v.has(end) ? row.v.get(end) : null), ...(x.length ? { x } : {}) };
            })
        };
    }
    const used = new Set(Object.values(out.statements).flatMap((s) => s.src));
    for (const a of Object.keys(out.filings)) if (!used.has(a)) delete out.filings[a];
    return Object.keys(out.statements).length ? out : null;
}

function forCik(cik) {
    const id = p.cik(cik);
    if (!id) return null;
    try { return JSON.parse(fs.readFileSync(path.join(DIR(), id + '.json'), 'utf8')); } catch (_) { return null; }
}

module.exports = { DIR, STATEMENTS, assemble, forCik, columnsOf, norm };
