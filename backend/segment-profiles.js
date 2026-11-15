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

// The annual report and the tagged figures spell one segment differently: "U.S. Consumer Services
// (USCS)" / "US Consumer Services", "Total Workforce Solutions" / "Workforce Solutions", "Conventional
// Shell Eggs" / "Conventional Shell Egg", "Wealth Manage- ment", "PaperPie" / "Paper Pie".
const STOP = new Set(('the segment segments reportable operating operation operations business businesses division group and '
    + 'net revenue revenues sales total line lines product products corporation corp inc co company companies lp llc holding holdings partners').split(' '));
const clean = s => String(s || '').replace(/\s*\([^)]*\)/g, ' ').replace(/["“”]/g, '').replace(/\bU\.\s?S\.?(?=\s|$)/gi, 'US')
    // "P&C Business Insurance" and "Business Insurance" name the same segment: the tagged row keeps the
    // line of business the note leaves out.
    .replace(/^\s*P\s*&\s*C\s+/i, '').replace(/(\w)- (\w)/g, '$1$2').replace(/\s+/g, ' ').trim();
const stem = w => w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w;
// Words a filing writes two ways. A list, not a distance: "Laboratory"/"Lab" is the same segment,
// and "utilities"/"companies" name the same corporate grouping ("Transmission and Distribution
// Utilities" / "... Companies"); the plural of a stop word stays noise.
const WORD = new Map([['laboratory', 'lab'], ['utilities', 'companies'], ['utility', 'companies']]);
// Filed short forms, spelled out once so a name and its initialism compare as words: APAC is Asia
// Pacific, SPD Specialty Products, AEPTHCo AEP Transmission Holdco, PSE&G Public Service Electric and
// Gas Company. Matched whole-name only, never inside a longer name.
const SHORT = new Map([['apac', 'asia pacific'], ['emea', 'europe middle east africa'], ['latam', 'latin america'],
    ['spd', 'specialty products'], ['aepthco', 'aep transmission holdco'], ['pseg', 'public service electric and gas']]);
const compact = s => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const tokens = s => (SHORT.get(compact(s)) || clean(s)).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ').filter(Boolean);
const rawWords = s => tokens(s).map(w => WORD.get(w) || w);
const key = s => {
    const plain = tokens(s), kept = rawWords(s).filter(w => !STOP.has(w));
    return (kept.length ? kept : plain).map(stem).join(' '); // "Business" alone is a name, not a generic word
};
const sameKey = (a, b) => { const x = key(a).replace(/ /g, ''), y = key(b).replace(/ /g, ''); return !!x && x === y; };
// "FPD" is Flowserve Pumps Division, "EMEA" Europe Middle East Africa; "BD Medical" is the Medical row.
const parts = s => clean(s).split(/[\s,&/-]+/).filter(w => w && !/^(and|of|the|for)$/i.test(w));
const initials = s => parts(s).map(w => w[0].toUpperCase()).join('');
// "PSE&G" is Public Service Electric and Gas Company: an initialism never carries the corporate noun.
const initialsShort = s => parts(s).filter(w => !/^(company|companies|division|group|corporation|inc|co)$/i.test(w)).map(w => w[0].toUpperCase()).join('');
const acronym = s => (/^[A-Z]{2,6}$/.test(String(s || '').trim()) ? String(s).trim() : null);
// "PSE&G" keeps its ampersand; the letters are the initialism.
const compactAcronym = s => { const t = clean(s).replace(/[^A-Za-z]/g, ''); return /^[A-Z]{2,6}$/.test(t) ? t : null; };
// The filing's own initialism written after the name, with no brackets: "Natural Gas Distribution NJNG".
const trailingInitialism = s => { const m = String(s || '').trim().match(/^(.+?)\s+([A-Z]{2,6})$/); return m ? m[1] : null; };
const tagged = s => [...String(s || '').matchAll(/\(\s*["“]?([A-Z]{2,6})["”]?\s*\)/g)].map(m => m[1]);
const withoutPrefix = s => { const m = clean(s).match(/^([A-Z]{2,5}) (.+)$/); return m && !/^(US|UK|EU)$/.test(m[1]) ? m[2] : null; };
// Never on a fragment: "Pottery Barn" and "Pottery Barn Kids" are two brands, "Services" and
// "Financial Services" two segments.
const inBrackets = s => [...String(s || '').matchAll(/\(([^)]+)\)/g)].map(m => m[1]);
// A filing's filler words on a shorter name: "Chili's Restaurants", "Merchant Solutions", "Camping &
// Watercraft Recreation", "North American Towable Recreational Vehicles". Nothing else may be added,
// except the issuer's own name ("Carlisle Construction Materials", "Verizon Consumer Group"), so
// "Pottery Barn Kids" and "Financial Services" never match their shorter names.
const FILL = new Set(['restaurant', 'solution', 'recreation', 'recreational', 'vehicle', 'service', 'group', 'banking']);
// A filing's filler can also be a word the matcher already ignores ("ZERUST® products and services").
const STOP_STEM = new Set([...STOP].map(stem));
const keyWords = s => key(s).split(' ').filter(Boolean);
// Every word, stop words included: "Business" against "Verizon Business Group" needs the business word.
const allWords = s => rawWords(s).map(stem);
const ownerWords = issuer => new Set(String(issuer || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1).map(stem));
function fillerOnly(a, b, issuer) {
    const small = allWords(a), big = allWords(b);
    if (!small.length || !big.length || big.length <= small.length) return false;
    let i = 0; // every word of the shorter name, in the longer name's order
    for (const w of big) if (i < small.length && w === small[i]) i++;
    if (i !== small.length) return false;
    const rest = [...big];
    for (const w of small) { const at = rest.indexOf(w); if (at < 0) return false; rest.splice(at, 1); }
    const own = ownerWords(issuer);
    return rest.every(w => FILL.has(w) || own.has(w) || STOP_STEM.has(w));
}
function sameSegment(a, b, issuer = null) {
    if (sameKey(a, b)) return true;
    // "Light Vehicle Drive Systems (Light Vehicle)": the report gives the filed name in brackets.
    if (inBrackets(a).some(x => sameKey(x, b)) || inBrackets(b).some(x => sameKey(x, a))) return true;
    for (const [x, y] of [[a, b], [b, a]]) {
        const tail = trailingInitialism(x);
        if (tail && sameKey(tail, y)) return true;
        const ax = compactAcronym(x) || acronym(x);
        if (ax && (ax === initials(y) || ax === initialsShort(y) || tagged(y).includes(ax))) return true;
        const px = withoutPrefix(x);
        if (px && sameKey(px, y)) return true;
    }
    return fillerOnly(a, b, issuer) || fillerOnly(b, a, issuer);
}
const GENERIC = /^single reportable segment$/i;

// rows: [{ name, ... }] as the page already shows them. Returns the rows with the profile's words on
// the ones it names, and the profile itself for the parts of the card that have no figure.
function enrich(cik, rows, { kind = null, issuer = null } = {}) {
    const p = usable(cik);
    if (!p) return { rows, profile: null };
    // The issuer's own name, so a row the filing prefixes with it ("Verizon Consumer Group" against
    // "Consumer") is the segment and not a different cut. The profile carries the filed name; callers
    // that hold the listing's name pass it.
    const owner = issuer || p.issuerName || null;
    const used = new Set();
    // Same spelling first, so a looser match never takes a segment another row names exactly.
    const exact = (rows || []).map(r => { const s = p.segments.find(x => !used.has(x) && sameKey(x.name, r.name)); if (s) used.add(s); return s; });
    const out = (rows || []).map((r, i) => {
        let seg = exact[i] || p.segments.find(s => !used.has(s) && sameSegment(s.name, r.name, owner));
        // The filing tags its one segment with a generic member ("ReportableSegmentMember"); the
        // annual report names it.
        if (!seg && GENERIC.test(String(r.name || '').trim()) && p.segments.length === 1) seg = p.segments[0];
        // One segment row against one reported segment is that segment under its filed name
        // ("Retail" / "Retail food").
        if (!seg && rows.length === 1 && p.segments.length === 1 && (!kind || kind === 'operating segments')) seg = p.segments[0];
        if (!seg) return r;
        used.add(seg);
        return { ...r, name: GENERIC.test(String(r.name || '').trim()) ? seg.name : r.name, products: seg.products, description: seg.description };
    });
    // Rows none of which is a segment the report names (ADI tags its end markets beside one
    // "Reportable Segment") are a breakdown, not the segments; which row is which is never guessed.
    // A row that shares a word with a segment name (GATX's "Portfolio Management" beside "Engine
    // Leasing") is still a segment row under a spelling the matcher has not learned, so it is not
    // thrown into the "as tagged" cut.
    const sharesWord = out.some(r => {
        const rw = new Set(keyWords(r.name));
        return p.segments.some(s => keyWords(s.name).some(w => rw.has(w)));
    });
    const noneNamed = out.length > 0 && used.size === 0 && !sharesWord;
    return {
        rows: out,
        profile: {
            segments: p.segments.map(s => ({ name: s.name, products: s.products, description: s.description, shown: used.has(s) })),
            rowsAreSegments: noneNamed ? false : kind ? kind === 'operating segments' : null,
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
