'use strict';

// Exchange listings are authoritative for membership; SEC adds issuer IDs.
const crypto = require('node:crypto');
const EXCHANGES = { A: 'NYSE American', N: 'NYSE', P: 'NYSE Arca', Z: 'Cboe', V: 'IEX', Q: 'Nasdaq' };
const key = (s) => String(s || '').trim().toUpperCase().replace(/\./g, '-');
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
function validateTimestamp(text,now=Date.now()) {
 const stamp=String(text).match(/File Creation Time:\s*(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})/);
 if(!stamp)throw new Error('Invalid directory timestamp');
 const [,month,day,year,hour,minute]=stamp,date=new Date(Date.UTC(+year,+month-1,+day,+hour,+minute));
 if(date.getUTCMonth()!==+month-1 || date.getUTCDate()!==+day || +hour>23 || +minute>59 || now-date.getTime()>8*86400000 || date.getTime()-now>86400000)throw new Error('Stale or future directory timestamp');
 return date.toISOString();
}
function securityType(row) {
    if (row.test) return 'test';
    if (row.etf) return 'etf';
    if (row.symbol.includes('$')) return 'preferred';
    const n = row.name;
    if(/\bRights?(?:\s*\(|\s+when issued|$)/i.test(n))return 'right';
    if(/\b(?:Tangible Equity|Equity) Unit$/i.test(n))return 'unit';
    if (/ - Units?\.?$/i.test(n) || /\bunits?\b.*\b(?:consist|comprised)\b.*\bwarrants?\b/i.test(n)) return 'unit';
    if (/\bwarrants?\b/i.test(n)) return 'warrant';
    if (/\bright(s)?\b.*(?:share|stock)|\b(?:subscription|contingent value) rights?\b| - (?:Series .* )?Rights?$/i.test(n)) return 'right';
    if (/\b(?:preferred|preference)\b/i.test(n)) return 'preferred';
    if (/\b(?:notes|bonds|debentures)\b.*\b(?:due|20\d\d)|\bexchange.traded notes\b/i.test(n)) return 'debt';
    if (/\bunits?\b.*\b(?:consist|comprised|each|one|warrant)| - Units?\.?$/i.test(n)) return 'unit';
    if (row.confirmedFund || /closed[ -]end fund/i.test(row.name)) return 'closed_end_fund';
    return 'stock';
}
function buildUniverse(nasdaq, other, sec, curated = [], previous = [], metadata = {}) {
    if (!Array.isArray(sec.fields) || !Array.isArray(sec.data)) throw new Error('Invalid SEC ticker directory');
    const secRows = sec.data.map((r) => Object.fromEntries(sec.fields.map((f, i) => [f, r[i]])));
    const issuers = new Map(secRows.filter((r) => r.ticker).map((r) => [key(r.ticker), r]));
    const names = new Map(curated.map((r) => [key(r.symbol), r]));
    const old = new Map(previous.map((r) => [key(r.symbol), r]));
    const outcomes = [];
    const excluded = {}, companies = new Map();
    for (const row of [...parseDirectory(nasdaq, 'nasdaq'), ...parseDirectory(other, 'other')]) {
        const issuerMetadata = metadata[key(row.symbol)] || {};
        let type = securityType({...row, confirmedFund:issuerMetadata.confirmedFund});
        const uncertain = type==='stock' && !/common|ordinary|depositary|depository|\bADR\b|\bADSs?\b|registry shares|voting shares|capital stock|limited partner|beneficial interest/i.test(row.name) && !issuerMetadata.confirmedStock;
        outcomes.push({...row,...(issuers.get(key(row.symbol))?.cik?{cik:String(issuers.get(key(row.symbol)).cik).padStart(10,'0')}:{}), classification:uncertain?'unresolved':type, decision:uncertain?'review':type==='stock'?'include':'exclude', classificationSource:(issuerMetadata.confirmedStock || issuerMetadata.confirmedFund)?issuerMetadata.source:'Exchange flags and security name',classificationEvidence:issuerMetadata.evidence || null});
        const previouslyCovered = old.has(key(row.symbol));
        if (uncertain) { excluded.unresolved=(excluded.unresolved || 0)+1; if(!previouslyCovered)continue; }
        if(uncertain)type='unresolved';
        if (type !== 'stock' && !(previouslyCovered && ['unit','right','closed_end_fund','unresolved'].includes(type))) { excluded[type] = (excluded[type] || 0) + 1; continue; }
        if (!/^[A-Z0-9]+(?:[.-][A-Z0-9]+)?$/.test(row.symbol)) throw new Error(`Unsupported stock symbol: ${row.symbol}`);
        const k = key(row.symbol), issuer = issuers.get(k), cur = names.get(k), prev = old.get(k);
        const symbol = cur?.symbol || prev?.symbol || row.symbol;
        if (companies.has(k)) throw new Error(`Normalized symbol collision: ${row.symbol}`);
        companies.set(k, { symbol, name: cur?.name || row.name.replace(/ - (?:Class .*|Common .*|Ordinary .*|American .*|ADS.*)$/, ''),
            securityName: row.name, exchange: row.exchange, securityType: type, aliases:[...new Set([symbol,row.symbol,issuer?.ticker].filter(Boolean))], isADR:/American Deposit|\bADR\b|\bADS\b/i.test(row.name),
            ...(issuer?.cik ? { cik: String(issuer.cik).padStart(10, '0') } : {}),
            ...(cur?.sector || prev?.sector ? { sector: cur?.sector || prev.sector } : {}),
            ...(row.financialStatus && row.financialStatus !== 'N' ? { financialStatus: row.financialStatus } : {}) });
    }
    const rank = new Map();
    for (const c of [...curated, ...previous]) if (!rank.has(key(c.symbol))) rank.set(key(c.symbol), rank.size);
    const list = [...companies.values()].sort((a, b) => (rank.get(key(a.symbol)) ?? 1e9) - (rank.get(key(b.symbol)) ?? 1e9) || a.symbol.localeCompare(b.symbol));
    const sources = [['nasdaq',nasdaq],['other',other]].map(([directory,text])=>({directory,url:'https://www.nasdaqtrader.com/dynamic/SymDir/'+(directory==='nasdaq'?'nasdaqlisted':'otherlisted')+'.txt',fileTimestamp:String(text).match(/File Creation Time:([^|\r\n]+)/)?.[1]?.trim(),retrievedAt:new Date().toISOString(),sha256:crypto.createHash('sha256').update(text).digest('hex')}));
    const prevMap=new Map(previous.map(c=>[key(c.symbol),c]));
    const stocks=list.filter(c=>c.securityType==='stock');
    const retainedInstrumentsByType=list.filter(c=>c.securityType!=='stock').reduce((types,c)=>(types[c.securityType]=(types[c.securityType] || 0)+1,types),{});
    const manifest={schemaVersion:1,definition:'US exchange-listed common equities including REITs and operating-company ADRs; share classes counted separately',sources,counts:{directoryRecords:outcomes.length,stockListings:stocks.length,uniqueIssuers:new Set(stocks.filter(c=>c.cik).map(c=>c.cik)).size,adrs:stocks.filter(c=>c.isADR).length,funds:outcomes.filter(c=>['etf','closed_end_fund'].includes(c.classification)).length,unresolved:outcomes.filter(c=>c.decision==='review').length},outcomes,changes:{additions:list.filter(c=>!prevMap.has(key(c.symbol))).map(c=>c.symbol),removals:previous.filter(c=>!companies.has(key(c.symbol))).map(c=>({symbol:c.symbol,cik:c.cik || null,legacyUrl:'/stocks/'+c.symbol.toLowerCase()})),exchangeChanges:list.filter(c=>prevMap.has(key(c.symbol)) && prevMap.get(key(c.symbol)).exchange!==c.exchange).map(c=>({symbol:c.symbol,previous:prevMap.get(key(c.symbol)).exchange,current:c.exchange}))}};
    manifest.counts.retainedInstrumentsByType=retainedInstrumentsByType;
    const removed=previous.filter(c=>!companies.has(key(c.symbol))),added=list.filter(c=>!prevMap.has(key(c.symbol)));
    manifest.changes.possibleTickerChanges=removed.filter(c=>c.cik).flatMap(c=>{const matches=added.filter(n=>n.cik===c.cik && n.securityType===c.securityType);return matches.length===1 && removed.filter(n=>n.cik===c.cik).length===1?[{cik:c.cik,previous:c.symbol,current:matches[0].symbol,state:'requires_listing_confirmation'}]:[];});
    return { manifest, generatedAt: new Date().toISOString(), source: 'Nasdaq Trader nasdaqlisted.txt + otherlisted.txt; SEC issuer identifiers',
        count: list.length, excluded, companies: list };
}
module.exports = { parseDirectory, securityType, buildUniverse,validateTimestamp };
