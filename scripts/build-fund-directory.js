#!/usr/bin/env node
/**
 * build-fund-directory.js
 *
 * Writes frontend/data/top-funds.json — the local ETF and index-fund directory
 * the asset search ranks alongside top-100-companies.json.
 *
 * Why it exists: measured 2026-09-07, Yahoo's own symbol search returns no
 * funds at all for a one- or two-letter query ("v" answers V, HWGV, TRUM…;
 * "s" answers S, SI=F, SOL-USD…), so no amount of re-ranking on our side can
 * surface VOO for someone typing "vo" — the row is not in the response. A
 * local directory fixes exactly that, the same way top-100-companies.json does
 * for equities, and Yahoo keeps covering the long tail from three characters on.
 *
 * Nothing here is typed from memory: the seed list is only a list of tickers,
 * and every name, category and net-asset figure written to disk comes from a
 * live Yahoo quote. A seed that does not resolve as a fund is dropped, and the
 * output is sorted by real net assets.
 *
 * Usage:  node scripts/build-fund-directory.js
 */

const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'frontend', 'data', 'top-funds.json');

const noop = () => {};
const yahoo = new YahooFinance({
    suppressNotices: ['yahooSurvey', 'ripHistorical'],
    logger: { info: noop, warn: noop, error: noop, debug: noop, dir: noop },
    validation: { logErrors: false, logOptionsErrors: false }
});

// Seed tickers only — the widely held US ETFs and index mutual funds. Yahoo
// supplies every attribute below; a ticker that is not a fund is discarded.
const SEED = [
    // Broad US equity
    'SPY', 'IVV', 'VOO', 'VTI', 'ITOT', 'SCHB', 'SPLG', 'VV', 'SCHX', 'IWB', 'SPTM',
    // Nasdaq / growth / value
    'QQQ', 'QQQM', 'VUG', 'IWF', 'SCHG', 'VTV', 'IWD', 'SCHV', 'MGK', 'VOOG', 'VOOV',
    // Size
    'IJH', 'IJR', 'VO', 'VB', 'IWM', 'MDY', 'SCHA', 'SCHM', 'VXF', 'AVUV', 'IWN', 'IWO',
    // Dividend / income
    'SCHD', 'VYM', 'VIG', 'DGRO', 'HDV', 'SPYD', 'NOBL', 'DVY', 'JEPI', 'JEPQ', 'SPHD', 'QYLD', 'RDVY',
    // Sectors
    'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC',
    'VGT', 'VHT', 'VFH', 'VDE', 'VNQ', 'VPU', 'VAW', 'VIS', 'VCR', 'VDC', 'VOX',
    'SMH', 'SOXX', 'IBB', 'XBI', 'ITB', 'KRE', 'XOP', 'OIH', 'IYR', 'SCHH',
    // Thematic
    'ARKK', 'ARKG', 'ARKW', 'BOTZ', 'ROBO', 'ICLN', 'TAN', 'LIT', 'HACK', 'CIBR', 'SKYY', 'FDN', 'MOAT', 'QUAL', 'USMV', 'SPLV', 'MTUM', 'VLUE',
    // International
    'VXUS', 'VEU', 'IXUS', 'VEA', 'IEFA', 'EFA', 'VWO', 'IEMG', 'EEM', 'SCHF', 'SCHE', 'VGK', 'EWJ', 'FXI', 'MCHI', 'KWEB', 'INDA', 'EWZ', 'EWY', 'EWT', 'ACWI', 'VT',
    // Bonds
    'BND', 'AGG', 'BNDX', 'BSV', 'BIV', 'BLV', 'VCIT', 'VCSH', 'VCLT', 'LQD', 'HYG', 'JNK', 'TLT', 'IEF', 'SHY', 'GOVT', 'TIP', 'VTIP', 'SCHZ', 'MUB', 'VTEB', 'SGOV', 'BIL', 'SHV', 'USFR', 'TFLO', 'EMB', 'BNDW',
    // Commodities, crypto, currency
    'GLD', 'GLDM', 'IAU', 'SLV', 'PDBC', 'DBC', 'USO', 'UNG', 'IBIT', 'FBTC', 'ETHA', 'BITO',
    // Target-risk / allocation
    'AOA', 'AOR', 'AOM', 'AOK', 'AOA',
    // Leveraged / inverse (widely traded, and users hold them)
    'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'UPRO', 'SPXU', 'TNA', 'TMF', 'UVXY', 'SVXY',
    // Index mutual funds
    'VFIAX', 'VTSAX', 'VTIAX', 'VBTLX', 'VIGAX', 'VSMAX', 'VGSLX', 'VFIFX', 'VTTHX', 'VTWNX',
    'FXAIX', 'FSKAX', 'FZROX', 'FTIHX', 'FXNAX', 'FSPSX', 'FCNTX',
    'SWPPX', 'SWTSX', 'SWISX', 'SWAGX',
    'PRWCX', 'PRGFX', 'AGTHX', 'ANCFX', 'AIVSX', 'DODGX', 'DODFX', 'VWELX', 'VWINX', 'VWUSX', 'VPMAX'
];

const CHUNK = 20;

async function main() {
    const seen = new Set();
    const tickers = SEED.filter((t) => t && !seen.has(t) && seen.add(t));
    const rows = [];
    const dropped = [];

    for (let i = 0; i < tickers.length; i += CHUNK) {
        const batch = tickers.slice(i, i + CHUNK);
        const quotes = await yahoo.quote(batch, {}, { validateResult: false }).catch(() => []);
        const list = Array.isArray(quotes) ? quotes : [quotes];
        for (const ticker of batch) {
            const q = list.find((row) => row && String(row.symbol).toUpperCase() === ticker);
            const type = String((q && (q.quoteType || q.typeDisp)) || '').toUpperCase();
            if (!q || !['ETF', 'MUTUALFUND', 'FUND'].includes(type)) { dropped.push(`${ticker}${q ? ` (${type || 'no type'})` : ' (no quote)'}`); continue; }
            rows.push({
                symbol: ticker,
                name: q.longName || q.shortName || ticker,
                assetType: type === 'ETF' ? 'etf' : 'mutual_fund',
                netAssets: Number.isFinite(q.netAssets) ? q.netAssets : null
            });
        }
        process.stderr.write(`  …${Math.min(i + CHUNK, tickers.length)}/${tickers.length}\n`);
    }

    rows.sort((a, b) => (b.netAssets || 0) - (a.netAssets || 0) || a.symbol.localeCompare(b.symbol));
    fs.writeFileSync(OUT_FILE, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        source: 'Yahoo Finance quotes for a seed ticker list',
        count: rows.length,
        funds: rows
    }, null, 2)}\n`);
    console.log(`Wrote ${rows.length} funds to ${path.relative(ROOT, OUT_FILE)}`);
    if (dropped.length) console.log(`Dropped ${dropped.length} seeds that did not resolve as funds: ${dropped.join(', ')}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
