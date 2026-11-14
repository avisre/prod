'use strict';
// What each company sells, in its own annual report's words (scripts/build-segment-profiles.js):
// reportable segments by name, the products in each, who pays it, and recent segment changes, each
// with a verbatim quote. Figures never come from here; enrich() only attaches words to the rows the
// filing's tagged tables already supply.
const fs = require('fs'), path = require('path');
const DIR = process.env.SEGMENT_PROFILES_DIR || path.join(__dirname, 'data', 'segment-profiles');
const VERSION = 1;
const cik10 = cik => String(cik || '').replace(/\D/g, '').padStart(10, '0');
const cache = new Map();

function read(cik) {
    const id = cik10(cik);
    if (!/^\d{10}$/.test(id) || id === '0000000000') return null;
    if (cache.has(id)) return cache.get(id);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    cache.set(id, rec);
    return rec;
}
function write(cik, rec) {
    fs.mkdirSync(DIR, { recursive: true });
    const id = cik10(cik), tmp = path.join(DIR, `.${id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 1) + '\n');
    fs.renameSync(tmp, path.join(DIR, id + '.json'));
    cache.set(id, rec);
}
const current = rec => !!(rec && rec.version === VERSION && rec.status);
// Only a profile whose segments survived the check against the filing is shown.
const usable = cik => { const r = read(cik); return r && r.status === 'ok' && r.segments?.length ? r : null; };

// "Pottery Barn" and "Pottery Barn segment", "Primary" and "Primary Segment" are the same row.
const key = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(?:the|segment|segments|reportable|operating|business|businesses|division|group|and|net|revenue|revenues|sales)\b/g, ' ').replace(/\s+/g, ' ').trim();
// Only the same name: "Pottery Barn" and "Pottery Barn Kids" are two brands, "Services" and
// "Financial Services" two segments.
function sameSegment(a, b) {
    const x = key(a), y = key(b);
    return !!x && x === y;
}
const GENERIC = /^single reportable segment$/i;

// rows: [{ name, ... }] as the page already shows them. Returns the rows with the profile's words on
// the ones it names, and the profile itself for the parts of the card that have no figure.
function enrich(cik, rows, { kind = null } = {}) {
    const p = usable(cik);
    if (!p) return { rows, profile: null };
    const used = new Set();
    const out = (rows || []).map(r => {
        let seg = p.segments.find(s => !used.has(s) && sameSegment(s.name, r.name));
        // The filing tags its one segment with a generic member ("ReportableSegmentMember"); the
        // annual report names it.
        if (!seg && GENERIC.test(String(r.name || '').trim()) && p.segments.length === 1) seg = p.segments[0];
        if (!seg) return r;
        used.add(seg);
        return { ...r, name: GENERIC.test(String(r.name || '').trim()) ? seg.name : r.name, products: seg.products, description: seg.description };
    });
    return {
        rows: out,
        profile: {
            segments: p.segments.map(s => ({ name: s.name, products: s.products, description: s.description, shown: used.has(s) })),
            rowsAreSegments: kind ? kind === 'operating segments' : null,
            productRevenueBrokenOut: p.productRevenueBrokenOut,
            revenueModel: p.revenueModel ? p.revenueModel.text : null,
            changes: (p.changes || []).map(c => c.text),
            filing: p.filing
        }
    };
}

// A history table can carry one segment under two members over the years: AppLovin's generic
// "ReportableSegmentMember" (2023 on) and its "AdvertisingSegmentMember" (2022) are both "Advertising"
// once named. Rows of the same name whose years never overlap are one row; overlapping ones stay apart.
function mergeNamed(rows) {
    const out = [];
    for (const r of rows || []) {
        const same = Array.isArray(r.sales) && out.find(m => m.name === r.name && Array.isArray(m.sales) && m.sales.length === r.sales.length
            && m.sales.every((v, i) => v === null || r.sales[i] === null));
        if (!same) { out.push({ ...r }); continue; }
        for (const k of ['sales', 'profit', 'assets', 'contexts', 'filedIn']) if (Array.isArray(r[k])) same[k] = Array.isArray(same[k]) ? same[k].map((v, i) => v ?? r[k][i] ?? null) : r[k].slice();
        if (Array.isArray(same.members) && Array.isArray(r.members)) same.members = [...new Set(same.members.concat(r.members))];
        if (!same.products?.length && r.products?.length) { same.products = r.products; same.description = r.description; }
    }
    return out;
}

module.exports = { DIR, VERSION, read, write, current, usable, enrich, mergeNamed, sameSegment, key };
