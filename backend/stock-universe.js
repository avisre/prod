'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(process.env.SEC_COVERAGE_DATA_DIR || path.join(__dirname, '../frontend/data'), 'us-companies.json');
let cached = null;
const key = (s) => String(s || '').trim().toUpperCase().replace(/\./g, '-');
function companies() {
    if (!cached) cached = JSON.parse(fs.readFileSync(FILE, 'utf8')).companies;
    return cached;
}
let bySymbol,archived;const runtime=new Map();
function register(company){if(!company?.symbol || !['stock','closed_end_fund','unresolved'].includes(company.securityType))return;runtime.set(key(company.symbol),company);while(runtime.size>96)runtime.delete(runtime.keys().next().value);}
function lookup(symbol) {
    if (!bySymbol) bySymbol = new Map(companies().map((c) => [key(c.symbol), c]));
    if(!archived){let list=[];try{list=JSON.parse(fs.readFileSync(path.join(path.dirname(FILE),'legacy-instruments.json'),'utf8')).companies || [];}catch(e){if(e.code!=='ENOENT')throw e;}archived=new Map(list.filter(c=>c.listingStatus==='no_longer_in_directory').map(c=>[key(c.symbol),c]));}
    return bySymbol.get(key(symbol)) || runtime.get(key(symbol)) || archived.get(key(symbol)) || null;
}
function hasStatements(data) {
    return ['income', 'balance', 'cash'].some((st) => ['annualReports', 'quarterlyReports'].some((p) =>
        (data?.[st]?.[p] || []).some((r) => r.fiscalDateEnding && Object.entries(r).some(([k, v]) =>
            !/date|currency|source|form|accession|filed|^fy$|^fp$/i.test(k) && v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v))))));
}
function usable(data) { return !!(data?.overview?.Symbol && data.overview.Name && hasStatements(data)); }
// Description, sector and industry for companies whose fundamentals file has
// none (scripts/refresh-profiles.js). Read once; absent file means no profiles.
let profiles;
function profileFor(symbol) {
    if (profiles === undefined) {
        try { profiles = JSON.parse(fs.readFileSync(path.join(path.dirname(FILE), 'company-profiles.json'), 'utf8')).profiles || {}; }
        catch (e) { if (e.code !== 'ENOENT') throw e; profiles = {}; }
    }
    return profiles[symbol] || profiles[String(symbol).replace(/-/g, '.')] || profiles[String(symbol).replace(/\./g, '-')] || null;
}
function withIdentity(data, company) {
    if (!data || !company) return data;
    const profile = profileFor(company.symbol), stored = data.overview || {};
    const ov = profile ? { ...stored,
        ...(profile.description && !String(stored.Description || '').trim() ? { Description: profile.description } : {}),
        ...(profile.sector && !stored.Sector && !company.sector ? { Sector: profile.sector } : {}),
        ...(profile.industry && !stored.Industry ? { Industry: profile.industry } : {}) } : stored;
    if (ov.Symbol && key(ov.Symbol) !== key(company.symbol)) throw new Error('Fundamentals symbol does not match listing');
    return { ...data, overview: { ...ov, Symbol: company.symbol, Name: ov.Name || company.name,
        ...(company.cik && !ov.CIK ? { CIK: String(company.cik) } : {}),
        ...(company.exchange && !ov.Exchange ? { Exchange: company.exchange } : {}),
        ...(company.sector && !ov.Sector ? { Sector: company.sector } : {}) } };
}
module.exports = { register,resolveListing:(...args)=>require('./listing-resolver').resolveListing(...args),companies, lookup, hasStatements, usable, withIdentity };
