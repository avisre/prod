'use strict';

/**
 * Holdings CSV import — pure parsing, no DB / express / network.
 *
 * Brokers export positions as CSV with wildly different headers, quoted
 * company names, "$1,234.50" prices, disclaimer preamble lines and a zoo of
 * date formats. This module turns any of that into clean holdings rows
 * ({ symbol, shares, price, purchaseDate }) that the rest of the app can
 * trust. Every rejected row comes back with a reason so an import is never
 * silently lossy. Techniques mirror wash-sale.js's proven parser, but the
 * shape here is a position (what do I own and what did I pay), not a trade.
 */

// Recognised header aliases (lowercased, spaces/underscores/hyphens stripped).
// Alias order is priority order: "Symbol" beats "Stock" when both appear.
const HEADER_ALIASES = {
    symbol: ['symbol', 'ticker', 'instrument', 'security', 'stock'],
    shares: ['shares', 'quantity', 'qty', 'units'],
    price: ['price', 'purchaseprice', 'avgprice', 'shareprice', 'unitprice', 'pricepershare'],
    date: ['date', 'purchasedate', 'tradedate', 'dateacquired', 'transactiondate']
};

const MAX_DATA_ROWS = 2000;   // refuse absurd files rather than OOM the server
const MAX_SKIP_REASONS = 20;  // report enough to debug, not a wall of repeats

// Broker exports carry summary/footer rows ("Total", "Cash & equivalents").
// Anything that cannot be a ticker by shape is reported as a skip rather than
// saved as a holding that will never resolve to a price.
const SYMBOL_SHAPE = /^[A-Z0-9^][A-Z0-9.=-]{0,11}$/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
        if (ch === '"') { q = !q; continue; }
        if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

function normalizeDate(raw) {
    const s = String(raw || '').trim().replace(/['"]/g, '');
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);             // ISO 2024-03-15
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);          // US MM/DD/YYYY or MM/DD/YY
    if (m) {
        const year = m[3].length === 2 ? `20${m[3]}` : m[3];
        return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    }
    // "March 14, 2024" / "14 March 2024" — parsed by hand because `new Date`
    // treats it as local midnight and toISOString() then shifts it a day
    // for anyone west of UTC.
    m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)
        || /^(\d{1,2})\s+([A-Za-z]{3,}),?\s+(\d{4})$/.exec(s);
    if (m) {
        const [day, month, year] = /^[A-Za-z]/.test(s) ? [m[2], m[1], m[3]] : [m[1], m[2], m[3]];
        const mo = MONTHS[month.slice(0, 3).toLowerCase()];
        if (mo) return `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
}

// "$1,234.50" and "1,234.50" both arrive as money-formatted strings; strip the
// decoration first. Empty means "unknown", so we return 0 rather than NaN.
function parsePrice(raw) {
    const s = String(raw || '').trim().replace(/[$,]/g, '');
    if (!s) return 0;
    const n = parseFloat(s);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseHoldingsCsv(csvText) {
    const lines = String(csvText || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
    const norm = (h) => h.toLowerCase().replace(/[ _-]/g, '');
    // Find the header row (broker exports often lead with disclaimers).
    let headerIdx = -1; let cols = null;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const cells = splitCsvLine(lines[i]).map(norm);
        const map = {};
        for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
            for (const alias of aliases) {
                const at = cells.indexOf(alias);
                if (at >= 0) { map[field] = at; break; }
            }
        }
        if (map.symbol !== undefined && map.shares !== undefined) {
            headerIdx = i; cols = map; break;
        }
    }
    if (headerIdx < 0) {
        return {
            error: 'Could not find a header row. The CSV needs headers including: '
                + 'symbol/ticker/instrument/security/stock and shares/quantity/qty/units '
                + '(price and purchase-date columns optional but recommended).'
        };
    }
    const dataLines = lines.slice(headerIdx + 1);
    if (dataLines.length > MAX_DATA_ROWS) {
        return { error: `This CSV has more than ${MAX_DATA_ROWS} data rows — please split it into smaller files.` };
    }
    const rows = [];
    const skipped = [];
    for (let i = 0; i < dataLines.length; i++) {
        const cells = splitCsvLine(dataLines[i]);
        const lineNo = headerIdx + i + 2; // 1-based source line, header inclusive
        const symbol = String(cells[cols.symbol] || '').trim().toUpperCase();
        if (!symbol) { skipped.push({ line: lineNo, reason: 'missing ticker' }); continue; }
        if (!SYMBOL_SHAPE.test(symbol)) { skipped.push({ line: lineNo, reason: `'${symbol}' is not a valid ticker` }); continue; }
        const sharesRaw = String(cells[cols.shares] || '').trim().replace(/[$,]/g, '');
        if (!sharesRaw) { skipped.push({ line: lineNo, reason: 'missing quantity' }); continue; }
        const shares = parseFloat(sharesRaw);
        if (!Number.isFinite(shares) || shares <= 0) { skipped.push({ line: lineNo, reason: 'bad quantity' }); continue; }
        const price = parsePrice(cells[cols.price]);
        const dateRaw = cols.date !== undefined ? String(cells[cols.date] || '').trim() : '';
        if (dateRaw) {
            const purchaseDate = normalizeDate(dateRaw);
            if (!purchaseDate) { skipped.push({ line: lineNo, reason: 'bad date' }); continue; }
            rows.push({ symbol, shares, price, purchaseDate });
        } else {
            // no date given — caller treats it as "bought today"
            rows.push({ symbol, shares, price, purchaseDate: null });
        }
    }
    // Keep every row parsed, but only list the first N reasons — after that
    // the user needs to fix the file, not read a scroll of repeats.
    const reported = skipped.slice(0, MAX_SKIP_REASONS);
    if (skipped.length > MAX_SKIP_REASONS) {
        reported.push({ line: null, reason: `…and ${skipped.length - MAX_SKIP_REASONS} more` });
    }
    return { rows, skipped: reported };
}

/**
 * Merge repeated symbols into one row per symbol: summed shares, a
 * qty-weighted average price, and the earliest known purchase date.
 * A 0 price carries no information, so it never drags the average down —
 * only rows that actually know their price contribute to it.
 */
function consolidateRows(rows) {
    const bySymbol = new Map();
    for (const r of rows || []) {
        const cur = bySymbol.get(r.symbol) || { symbol: r.symbol, shares: 0, priceQty: 0, priceTotal: 0, allZero: true, purchaseDate: null };
        cur.shares += r.shares;
        if (r.price > 0) {
            cur.priceQty += r.shares;
            cur.priceTotal += r.shares * r.price;
            cur.allZero = false;
        }
        if (r.purchaseDate && (!cur.purchaseDate || r.purchaseDate < cur.purchaseDate)) {
            cur.purchaseDate = r.purchaseDate;
        }
        bySymbol.set(r.symbol, cur);
    }
    return [...bySymbol.values()]
        .map((c) => ({
            symbol: c.symbol,
            shares: c.shares,
            price: c.allZero ? 0 : c.priceTotal / c.priceQty,
            purchaseDate: c.purchaseDate
        }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

module.exports = { parseHoldingsCsv, consolidateRows };