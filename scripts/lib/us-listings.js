'use strict';

// Exchange listings are authoritative for membership; SEC adds issuer IDs.
const EXCHANGES = { A: 'NYSE American', N: 'NYSE', P: 'NYSE Arca', Z: 'Cboe', V: 'IEX', Q: 'Nasdaq' };
const key = (s) => String(s || '').trim().toUpperCase().replace(/[.-]/g, '');
function parseDirectory(text, kind) {
    const lines = String(text).trim().split(/\r?\n/);
    const fields = lines.shift().split('|');
    const symbolField = kind === 'nasdaq' ? 'Symbol' : 'ACT Symbol';
    for (const required of [symbolField, 'Security Name', 'ETF', 'Test Issue']) {
        if (!fields.includes(required)) throw new Error(`Invalid ${kind} directory: missing ${required}`);
    }
    if (!lines.some((line) => line.startsWith('File Creation Time:'))) throw new Error(`Incomplete ${kind} directory`);
    return lines.filter((line) => line && !line.startsWith('File Creation Time:')).map((line) => {
        const values = line.split('|');
        if (values.length !== fields.length) throw new Error(`Malformed ${kind} directory row`);
        const r = Object.fromEntries(fields.map((f, i) => [f, values[i].trim()]));
        return { symbol: r[symbolField], name: r['Security Name'], etf: r.ETF === 'Y', test: r['Test Issue'] === 'Y',
            exchange: kind === 'nasdaq' ? 'Nasdaq' : (EXCHANGES[r.Exchange] || r.Exchange), financialStatus: r['Financial Status'] || '' };
    });
}
function securityType(row) {
    if (row.test) return 'test';
    if (row.etf) return 'etf';
    if (row.symbol.includes('$')) return 'preferred';
    const n = row.name;
    if (/ - Units?$/i.test(n) || /\bunits?\b.*\b(?:consist|comprised)\b.*\bwarrants?\b/i.test(n)) return 'unit';
    if (/\bwarrants?\b/i.test(n)) return 'warrant';
    if (/\bright(s)?\b.*(?:share|stock)|\b(?:subscription|contingent value) rights?\b| - (?:Series .* )?Rights?$/i.test(n)) return 'right';
    if (/\b(?:preferred|preference)\b/i.test(n)) return 'preferred';
    if (/\b(?:notes|bonds|debentures)\b.*\b(?:due|20\d\d)|\bexchange.traded notes\b/i.test(n)) return 'debt';
    if (/\bunits?\b.*\b(?:consist|comprised|each|one|warrant)| - Units?$/i.test(n)) return 'unit';
    return 'stock';
}
function buildUniverse(nasdaq, other, sec, curated = [], previous = []) {
    if (!Array.isArray(sec.fields) || !Array.isArray(sec.data)) throw new Error('Invalid SEC ticker directory');
    const secRows = sec.data.map((r) => Object.fromEntries(sec.fields.map((f, i) => [f, r[i]])));
    const issuers = new Map(secRows.filter((r) => r.ticker).map((r) => [key(r.ticker), r]));
    const names = new Map(curated.map((r) => [key(r.symbol), r]));
    const old = new Map(previous.map((r) => [key(r.symbol), r]));
    const excluded = {}, companies = new Map();
    for (const row of [...parseDirectory(nasdaq, 'nasdaq'), ...parseDirectory(other, 'other')]) {
        const type = securityType(row);
        const previouslyCovered = old.has(key(row.symbol));
        if (type !== 'stock' && !(previouslyCovered && ['unit', 'right'].includes(type))) { excluded[type] = (excluded[type] || 0) + 1; continue; }
        if (!/^[A-Z0-9]+(?:[.-][A-Z0-9]+)?$/.test(row.symbol)) throw new Error(`Unsupported stock symbol: ${row.symbol}`);
        const k = key(row.symbol), issuer = issuers.get(k), cur = names.get(k), prev = old.get(k);
        const symbol = cur?.symbol || prev?.symbol || row.symbol;
        if (companies.has(k)) throw new Error(`Normalized symbol collision: ${row.symbol}`);
        companies.set(k, { symbol, name: cur?.name || row.name.replace(/ - (?:Class .*|Common .*|Ordinary .*|American .*|ADS.*)$/, ''),
            securityName: row.name, exchange: row.exchange, securityType: type,
            ...(issuer?.cik ? { cik: String(issuer.cik).padStart(10, '0') } : {}),
            ...(cur?.sector || prev?.sector ? { sector: cur?.sector || prev.sector } : {}),
            ...(row.financialStatus && row.financialStatus !== 'N' ? { financialStatus: row.financialStatus } : {}) });
    }
    const rank = new Map();
    for (const c of [...curated, ...previous]) if (!rank.has(key(c.symbol))) rank.set(key(c.symbol), rank.size);
    const list = [...companies.values()].sort((a, b) => (rank.get(key(a.symbol)) ?? 1e9) - (rank.get(key(b.symbol)) ?? 1e9) || a.symbol.localeCompare(b.symbol));
    return { generatedAt: new Date().toISOString(), source: 'Nasdaq Trader nasdaqlisted.txt + otherlisted.txt; SEC issuer identifiers',
        count: list.length, excluded, companies: list };
}
module.exports = { parseDirectory, securityType, buildUniverse };
