'use strict';

// How complete a stock's statements are, for the nav-search badge. Read from the
// index scripts/audit-statement-rows.js writes (frontend/data/statement-completeness.json):
//   full    = every annual row is filled, or blank only for years SEC has nothing
//   partial = some annual row is blank although SEC reports it (m of them)
//   none    = no statement row is filled at all

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'frontend', 'data', 'statement-completeness.json');
let cache = null;

function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')).stocks || {}; }
    catch (_) { cache = {}; }
    return cache;
}

function flagFrom(entry) {
    if (!entry || !Number.isInteger(entry.m)) return null;
    const filled = entry.i[0] + entry.b[0] + entry.c[0];
    const rows = entry.i[1] + entry.b[1] + entry.c[1];
    if (!filled) return { status: 'none' };
    if (!entry.m) return { status: 'full', rows };
    return { status: 'partial', missing: entry.m, rows };
}

function flagFor(symbol, assetType) {
    if (assetType && assetType !== 'stock') return null;
    return flagFrom(load()[String(symbol || '').toUpperCase()]);
}

module.exports = { flagFor, flagFrom };
