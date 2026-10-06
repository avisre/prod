'use strict';
// Bind a table amount to the segment, currency and period in that filing's
// inline XBRL. XML is inspected as text; no external entities are resolved.
const crypto = require('node:crypto');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const compact = s => String(s || '').replace(/\s+/g, ' ').trim();
const labelKey = s => String(s || '').replace(/Member$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase().replace(/threesixfive/g, '365');
const attributes = s => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]));
const content = (s, tag) => s.match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, 'i'))?.[1]?.trim();
const REVENUE = /^(?:us-gaap:(?:Revenues|SalesRevenueNet|RevenueFromContractWithCustomerExcludingAssessedTax|RevenueFromContractWithCustomerIncludingAssessedTax)|ifrs-full:Revenue)$/;
const witness = s => ({ excerpt: compact(s), digest: hash(compact(s)) });
function inspect(contextXml, unitXml, factXml, anchor, issuer) {
    const context = attributes(contextXml), unit = attributes(unitXml), match = factXml.match(/^<ix:nonfraction\b([^>]*)>([\s\S]*)<\/ix:nonfraction>$/i);
    if (!match) return null;
    const fact = attributes(match[1]), start = content(contextXml, 'startDate'), end = content(contextXml, 'endDate');
    const identity = content(contextXml, 'identifier');
    const members = [...contextXml.matchAll(/<(?:[\w.-]+:)?explicitMember\b([^>]*)>([^<]+)<\/(?:[\w.-]+:)?explicitMember>/gi)];
    if (members.length !== 1 || !/^(?:us-gaap:StatementBusinessSegmentsAxis|ifrs-full:SegmentsAxis)$/.test(attributes(members[0][1]).dimension || '') ||
        !/^\d+$/.test(identity || '') || Number(identity) !== Number(issuer) || start !== anchor.periodStart || end !== anchor.periodEnd ||
        !REVENUE.test(fact.name || '') || fact.contextref !== context.id || fact.unitref !== unit.id ||
        content(unitXml, 'measure') !== 'iso4217:' + anchor.currency || fact.sign === '-' || /<[^>]*continuation/i.test(match[2])) return null;
    const scalePower = Number(fact.scale || 0);
    if (![0, 3, 6, 9].includes(scalePower)) return null;
    let printed = compact(match[2].replace(/<[^>]+>/g, '')).replace(/&nbsp;|&#160;/g, '').replace(/\s+/g, '');
    if (/num[-]?comma[-]?decimal/i.test(fact.format || '')) printed = printed.replace(/\./g, '').replace(',', '.');
    else printed = printed.replace(/,/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(printed)) return null;
    const reportedValue = Number(printed), scale = 10 ** scalePower, value = reportedValue * scale;
    if (!(value > 0) || !Number.isFinite(value)) return null;
    return { member: members[0][2].split(':').at(-1), reportedValue, scale, value, currency: anchor.currency,
        periodStart: start, periodEnd: end, concept: fact.name };
}
function bindings(html, anchor, issuer) {
    const contexts = new Map(), units = new Map(), out = [];
    for (const m of html.matchAll(/<(?:[\w.-]+:)?context\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?context>/gi)) {
        const id = attributes(m[0]).id;
        if (id && m[0].length <= 5000) contexts.set(id, m[0]);
        if (contexts.size > 20000) return [];
    }
    for (const m of html.matchAll(/<(?:[\w.-]+:)?unit\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?unit>/gi)) {
        const id = attributes(m[0]).id; if (id && m[0].length <= 1500) units.set(id, m[0]);
    }
    for (const m of html.matchAll(/<ix:nonfraction\b[^>]*>[\s\S]*?<\/ix:nonfraction>/gi)) {
        const attrs = attributes(m[0]), contextXml = contexts.get(attrs.contextref), unitXml = units.get(attrs.unitref);
        if (!contextXml || !unitXml || m[0].length > 1500) continue;
        const observation = inspect(contextXml, unitXml, m[0], anchor, issuer);
        if (observation) out.push({ ...observation, context: witness(contextXml), unit: witness(unitXml), fact: witness(m[0]) });
        if (out.length > 500) return [];
    }
    return out;
}
function matches(binding, name, value, scale, anchor, issuer) {
    if (!binding || ![binding.context, binding.unit, binding.fact].every(p => p && typeof p.excerpt === 'string' && p.excerpt.length <= 5000 && p.digest === hash(p.excerpt))) return false;
    const parsed = inspect(binding.context.excerpt, binding.unit.excerpt, binding.fact.excerpt, anchor, issuer);
    return !!parsed && labelKey(parsed.member) === labelKey(name) && parsed.value === value && parsed.scale === scale &&
        parsed.reportedValue === binding.reportedValue && parsed.currency === binding.currency && parsed.member === binding.member;
}
function select(rows, name, value, scale, anchor, issuer) {
    const named = rows.filter(r => labelKey(r.member) === labelKey(name));
    if (new Set(named.map(r => r.value + ':' + r.currency)).size !== 1) return null;
    return named.find(r => matches(r, name, value, scale, anchor, issuer)) || null;
}
// ---- Model-free reading of the filing's own tagged revenue breakdowns ----
// A filing tags each segment, product-line and regional revenue figure with the
// axis it belongs to, so the tables can be read directly; no extraction model
// is involved and nothing is estimated.
const AXES = [
    [/^(?:us-gaap:StatementBusinessSegmentsAxis|ifrs-full:SegmentsAxis)$/, 'segments'],
    [/^(?:srt:ProductOrServiceAxis|ifrs-full:ProductsAndServicesAxis)$/, 'products'],
    [/^(?:srt:StatementGeographicalAxis|ifrs-full:GeographicalAreasAxis)$/, 'regions']
];
const BROAD_REVENUE = /^(?:us-gaap:(?:Revenues|SalesRevenueNet|RevenueFromContractWithCustomerExcludingAssessedTax|RevenueFromContractWithCustomerIncludingAssessedTax|RevenuesNetOfInterestExpense|RegulatedAndUnregulatedOperatingRevenue|RevenueNotFromContractWithCustomer|RealEstateRevenueNet|ElectricUtilityRevenue|PremiumsEarnedNet)|ifrs-full:(?:Revenue|RevenueFromContractsWithCustomers))$/;
// What the rows measure when it is not plain revenue: an insurer's segment note
// breaks down premiums, and the table must say so.
const MEASURES = { 'us-gaap:PremiumsEarnedNet': 'net premiums earned' };
const SMALL = new Set(['And', 'Of', 'The', 'For', 'In', 'To', 'Or']);
// Element names glue a trailing conjunction onto the word before it
// ("AssetandWealthManagement"). These are the real words that end the same way,
// measured across every stored segment member, and they are left whole.
const WHOLE = /^(?:[a-z]*land|(?:co)?brand|(?:broad|head|hus)?band|(?:before|first|second)?hand|(?:under)?stand|demand|command|expand|(?:quick)?sand|strand|grand|errand|operand|thousand|[a-z]*(?:roof|proof)|hoof|thereof)$/i;
const UNGLUED = /^(?:oil|small|rental|control|cereal|agricultural|individual|commercial|land)and$/i;
const unglue = w => {
    const m = w.match(/^([A-Za-z]{3,})(and|of)$/);
    return m && (UNGLUED.test(w) || !WHOLE.test(w)) ? m[1] + ' ' + m[2] : w;
};
const ACRONYMS = new Set(['usa', 'us', 'uk', 'eu', 'emea', 'apac', 'aws', 'oem', 'atm', 'it', 'ai', 'ip', 'tv', 'ev', 'hvac', 'reit', 'etf', 'api', 'crm', 'erp', 'gps', 'led', 'lng', 'llc', 'pc', 'rv']);
const ABBREVIATIONS = new Set(['ltd', 'st', 'mr', 'dr', 'vs', 'jr', 'sr', 'mt', 'by', 'my']);
// A short token with no vowel is an initialism the filer wrote in title case
// ("Dds" for Digital Data Solutions), not a word.
const initialism = w => ACRONYMS.has(w.toLowerCase()) || /^[B-DF-HJ-NP-TV-XZ][b-df-hj-np-tv-xz]{1,3}$/.test(w) && !ABBREVIATIONS.has(w.toLowerCase());
const BRANDS = [[/\bThree Six Five\b/g, '365'], [/\bLinked in\b/gi, 'LinkedIn'], [/\bXBOX\b/g, 'Xbox'], [/\bYou Tube\b/g, 'YouTube'],
    [/\bWhats App\b/g, 'WhatsApp'], [/\bGit Hub\b/g, 'GitHub'], [/\b([SPBI])aa ?[Ss]\b/g, '$1aaS'], [/\bIo T\b/g, 'IoT'],
    [/\bI (Phone|Pad|Cloud)\b/g, 'i$1'], [/\bU S\b/g, 'US'], [/\bU K\b/g, 'UK']];
// "us-gaap:AmazonWebServicesSegmentMember" -> "Amazon Web Services"
function label(member) {
    const bare = String(member || '').split(':').pop().replace(/(?:Member)+$/, '').replace(/^[A-Za-z]{2,10}_(?=[A-Z])/, '').replace(/_+/g, ' ').replace(/^ProductAndServiceOther(?=[A-Z])/, '');
    const raw = bare.replace(/(?:Reportable|Operating)?Segments?$/, '').replace(/^Segment(?=[A-Z])/, '') || bare;
    const words = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/\s+/).filter(Boolean)
        .flatMap(w => unglue(w).split(' ')).map(w => initialism(w) ? w.toUpperCase() : w);
    const text = words.map((w, i) => i && SMALL.has(w[0].toUpperCase() + w.slice(1)) ? w.toLowerCase() : w).join(' ');
    // "Otherrevenues" and a doubled "Other Other Revenue" are filer typos in the element name.
    const tidy = text.replace(/\bOther(?!wise\b)([a-z])([a-z]{4,})\b/g, (_, a, rest) => 'Other ' + a.toUpperCase() + rest).replace(/\b(\w+) \1\b/g, '$1');
    return BRANDS.reduce((out, [pattern, value]) => out.replace(pattern, value), tidy).trim();
}
// A breakdown often carries its own subtotals next to their parts ("Products"
// beside iPhone, Mac and iPad). While the rows add up to more than filed
// revenue, drop the row whose removal lands closest to it.
function prune(rows, total) {
    let kept = rows.filter(r => r.value > 0);
    const sum = list => list.reduce((n, r) => n + r.value, 0);
    for (let i = 0; i < 6 && kept.length > 2 && sum(kept) > total * 1.005; i++) {
        const current = sum(kept);
        const best = kept.slice().sort((a, b) => Math.abs(total - (current - a.value)) - Math.abs(total - (current - b.value)))[0];
        if (Math.abs(total - (current - best.value)) >= Math.abs(total - current)) break;
        kept = kept.filter(r => r !== best);
    }
    return kept;
}
// Operating segments are reported before intersegment eliminations, so they may
// legitimately add up to more than revenue: only a row that is exactly the sum
// of two or three others (a filed subtotal) is dropped, never a real segment.
function dropSubtotals(rows) {
    const kept = rows.filter(r => r.value > 0), near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.001;
    const subtotal = row => { const rest = kept.filter(r => r !== row && r.value < row.value);
        for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) {
            if (near(rest[i].value + rest[j].value, row.value)) return true;
            for (let k = j + 1; k < rest.length; k++) if (near(rest[i].value + rest[j].value + rest[k].value, row.value)) return true;
        }
        return rest.length > 3 && near(rest.reduce((n, r) => n + r.value, 0), row.value); };
    return kept.length > 12 ? kept : kept.filter(r => !subtotal(r));
}
// A member that is itself a roll-up of the segments is not a segment.
const AGGREGATE = /Aggregation|SegmentsTotal|TotalSegments|TotalReportable|AllReportableSegments/i;
function taggedFacts(html, anchor, issuer) {
    const contexts = new Map(), units = new Map(), found = new Map();
    for (const m of html.matchAll(/<(?:[\w.-]+:)?context\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?context>/gi)) {
        const id = attributes(m[0]).id;
        if (!id || m[0].length > 5000 || content(m[0], 'startDate') !== anchor.periodStart || content(m[0], 'endDate') !== anchor.periodEnd) continue;
        if (Number(content(m[0], 'identifier')) !== Number(issuer) || /typedMember/i.test(m[0])) continue;
        const members = [...m[0].matchAll(/<(?:[\w.-]+:)?explicitMember\b([^>]*)>([^<]+)<\/(?:[\w.-]+:)?explicitMember>/gi)]
            .map(x => ({ dimension: attributes(x[1]).dimension || '', member: x[2].trim() }))
            .filter(x => !(x.dimension === 'srt:ConsolidationItemsAxis' && x.member === 'us-gaap:OperatingSegmentsMember'))
            .map(x => ({ ...x, kind: AXES.find(([re]) => re.test(x.dimension))?.[1] }));
        if (members.length === 1 && members[0].kind) contexts.set(id, { kind: members[0].kind, member: members[0].member });
        // A segment split again by region or product ("Upstream / United States"):
        // the parts are added back up to the segment.
        else if (members.length === 2 && members.every(x => x.kind) && members.filter(x => x.kind === 'segments').length === 1)
            contexts.set(id, { kind: 'segments-by-part', member: members.find(x => x.kind === 'segments').member, part: members.find(x => x.kind !== 'segments').member });
    }
    if (!contexts.size) return found;
    for (const m of html.matchAll(/<(?:[\w.-]+:)?unit\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?unit>/gi)) {
        const id = attributes(m[0]).id; if (id && m[0].length <= 1500 && content(m[0], 'measure') === 'iso4217:' + anchor.currency) units.set(id, true);
    }
    for (const m of html.matchAll(/<ix:nonfraction\b([^>]*)>([\s\S]*?)<\/ix:nonfraction>/gi)) {
        const fact = attributes(m[1]), context = contexts.get(fact.contextref);
        if (!context || !units.has(fact.unitref) || !BROAD_REVENUE.test(fact.name || '') || fact.sign === '-' || m[0].length > 1500) continue;
        const power = Number(fact.scale || 0);
        let printed = compact(m[2].replace(/<[^>]+>/g, '')).replace(/&nbsp;|&#160;/g, '').replace(/\s+/g, '');
        if (/num[-]?comma[-]?decimal/i.test(fact.format || '')) printed = printed.replace(/\./g, '').replace(',', '.'); else printed = printed.replace(/,/g, '');
        if (!/^\d+(?:\.\d+)?$/.test(printed) || ![0, 3, 6, 9].includes(power)) continue;
        const value = Number(printed) * 10 ** power; if (!(value > 0)) continue;
        const key = context.kind + '|' + fact.name, group = found.get(key) || new Map(), id = context.member + (context.part ? '|' + context.part : ''), old = group.get(id);
        group.set(id, old !== undefined && old !== value ? null : value); found.set(key, group);
    }
    return found;
}
function groups(html, anchor, issuer) {
    const out = {};
    const consider = (kind, concept, rows) => {
        rows = kind === 'segments' ? dropSubtotals(rows) : prune(rows, anchor.value);
        const sum = rows.reduce((n, r) => n + r.value, 0), share = sum / anchor.value;
        if (rows.length < 2 || share < 0.5 || share > (kind === 'segments' ? 1.6 : 1.005)) return;
        const candidate = { concept, measure: MEASURES[concept] || 'revenue', rows, sum, share, reconciled: Math.abs(1 - share) <= 0.005 };
        // Plain revenue outranks another measure; then the closest to filed revenue wins.
        const rank = g => (g.measure === 'revenue' ? 0 : 10) + Math.abs(1 - g.share);
        if (!out[kind] || rank(candidate) < rank(out[kind])) out[kind] = candidate;
    };
    const found = taggedFacts(html, anchor, issuer);
    for (const [key, group] of found) {
        const [kind, concept] = key.split('|');
        if (kind !== 'segments-by-part') consider(kind, concept, [...group].filter(([member, v]) => v !== null && !AGGREGATE.test(member)).map(([member, value]) => ({ member, name: label(member), value })));
    }
    if (!out.segments) for (const [key, group] of found) {
        const [kind, concept] = key.split('|'); if (kind !== 'segments-by-part') continue;
        const bySegment = new Map(), parts = new Map();
        for (const [id, value] of group) { if (value === null) continue; const [member, part] = id.split('|'); (parts.get(member) || parts.set(member, []).get(member)).push({ member: part, value }); }
        // Within one segment the parts may carry their own total; keep the parts.
        for (const [member, list] of parts) bySegment.set(member, dropSubtotals(list).reduce((n, r) => n + r.value, 0));
        consider('segments', concept, [...bySegment].map(([member, value]) => ({ member, name: label(member), value })));
    }
    return out;
}
module.exports = { bindings, matches, select, groups, label, prune, dropSubtotals };
