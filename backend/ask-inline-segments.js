'use strict';
// Bind a table amount to the segment, currency and period in that filing's
// inline XBRL. XML is inspected as text; no external entities are resolved.
const crypto = require('node:crypto');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const compact = s => String(s || '').replace(/\s+/g, ' ').trim();
const labelKey = s => String(s || '').replace(/Member$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
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
module.exports = { bindings, matches, select };
