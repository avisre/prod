#!/usr/bin/env node
'use strict';
// Refresh all US exchange-listed stocks; keep the last good file on failure.
const fs = require('fs');
const path = require('path');
const { buildUniverse,validateTimestamp } = require('./lib/us-listings');
const DATA = path.join(__dirname, '../frontend/data');
const OUT = path.join(DATA, 'us-companies.json');
async function get(url) {
    if(new URL(url).hostname.endsWith('sec.gov'))await require('../backend/sec-throttle').take();
    const response = await fetch(url, { headers: { 'User-Agent': 'stockportfolio.pro contact@stockportfolio.pro' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.text();
}
async function main() {
    const [nasdaq, other, sec] = await Promise.all([
        get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'),
        get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'),
        get('https://www.sec.gov/files/company_tickers_exchange.json')
    ]);
    validateTimestamp(nasdaq);validateTimestamp(other);
    const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).companies || []; } catch (_) { return []; } };
    const previous = read(OUT);
    // Retain excluded instrument identities and URLs across successive reconciliations.
    let legacy=[];try{legacy=JSON.parse(fs.readFileSync(path.join(DATA,'legacy-instruments.json'),'utf8')).companies || [];}catch(e){if(e.code!=='ENOENT')throw e;}
    const metadata={};
    try{const report=JSON.parse(fs.readFileSync(path.join(DATA,'sec-reporting.json'),'utf8'));for(const e of Object.values(report.issuers || {}))for(const symbol of e.symbols || [])metadata[symbol.replace(/\./g,'-')]={confirmedStock:e.entityType==='operating' || /^(10-K|20-F|40-F)$/.test(e.latestAnnual?.form || ''),confirmedFund:e.fundRegistrant===true || e.entityType==='investment' || e.sic==='6726',source:'SEC submissions issuer classification',evidence:{sourceUrl:'https://data.sec.gov/submissions/CIK'+e.cik+'.json',retrievedAt:e.lastSuccessfulCheckAt,registeredFundReports:e.fundRegistrant===true,registeredFundReport:e.registeredFundReport || null,annualForm:e.latestAnnual?.form || null}};}catch(e){if(e.code!=='ENOENT')throw e;}
    const result = buildUniverse(nasdaq, other, JSON.parse(sec), read(path.join(DATA, 'sp1500-companies.json')), [...previous,...legacy.filter(c=>!previous.some(p=>p.symbol===c.symbol))],metadata);
    if (result.count < 4000 || result.count < previous.length * 0.65) throw new Error(`Suspicious directory size (${result.count}); keeping previous file`);
    result.manifest.generatedAt=result.generatedAt;
    result.manifest.sources.push({directory:'sec_issuer_identity',url:'https://www.sec.gov/files/company_tickers_exchange.json',retrievedAt:new Date().toISOString(),sha256:require('node:crypto').createHash('sha256').update(sec).digest('hex')});
    if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ count: result.count, excluded: result.excluded })); return; }
    fs.writeFileSync(path.join(DATA,'stock-universe-manifest.json.tmp'),JSON.stringify(result.manifest));
    fs.renameSync(path.join(DATA,'stock-universe-manifest.json.tmp'),path.join(DATA,'stock-universe-manifest.json'));
    const members=new Set(result.companies.map(c=>c.symbol));
    const archived=[...previous,...legacy].filter(c=>!members.has(c.symbol)).map(c=>({...c,listingStatus:'no_longer_in_directory',securityType:'unresolved',historicalSecurityType:c.historicalSecurityType || c.securityType,removedAt:c.removedAt || result.generatedAt}));
    const legacyRecords=[...new Map([...result.companies.filter(c=>c.securityType!=='stock'),...archived].map(c=>[c.symbol,c])).values()];
    fs.writeFileSync(path.join(DATA,'legacy-instruments.json'),JSON.stringify({generatedAt:result.generatedAt,companies:legacyRecords}));
    delete result.manifest;
    fs.writeFileSync(OUT + '.tmp', JSON.stringify(result));
    fs.renameSync(OUT + '.tmp', OUT);
    console.log(`US-listed stock directory: ${result.count}; excluded non-stock issues: ${JSON.stringify(result.excluded)}`);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
