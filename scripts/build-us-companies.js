#!/usr/bin/env node
'use strict';
// Refresh all US exchange-listed stocks; keep the last good file on failure.
const fs = require('fs');
const path = require('path');
const { buildUniverse } = require('./lib/us-listings');
const DATA = path.join(__dirname, '../frontend/data');
const OUT = path.join(DATA, 'us-companies.json');
async function get(url) {
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
    const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).companies || []; } catch (_) { return []; } };
    const previous = read(OUT);
    const result = buildUniverse(nasdaq, other, JSON.parse(sec), read(path.join(DATA, 'sp1500-companies.json')), previous);
    if (result.count < 4000 || result.count < previous.length * 0.65) throw new Error(`Suspicious directory size (${result.count}); keeping previous file`);
    if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ count: result.count, excluded: result.excluded })); return; }
    fs.writeFileSync(OUT + '.tmp', JSON.stringify(result));
    fs.renameSync(OUT + '.tmp', OUT);
    console.log(`US-listed stock directory: ${result.count}; excluded non-stock issues: ${JSON.stringify(result.excluded)}`);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
