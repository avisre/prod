'use strict';

// Which tickers stopped resolving at Yahoo, and since when.
//
// The fundamentals refresh used to treat a permanently dead ticker exactly like
// a transient error: it logged the failure, kept the last good file, and tried
// again forever. Nothing recorded the pattern, so a delisted or renamed symbol
// (measured 2026-09-28: AVNS, BLD, CPRX, CWEN.A, FDP, GTLS, JHG, KW, MASI, NSA,
// PRA, SATS, SEM, STEL, TMHC — all "Quote not found") stayed in the sitemap and
// on a live page indefinitely.
//
// This module is the sensor. scripts/refresh-fundamentals.js reports each run's
// per-symbol outcome here; the manifest carries consecutive failures across
// runs. A ticker is only called unlisted after UNLISTED_AFTER *separate days*
// of "not found", so a same-day retry, a rate-limit, or a network blip cannot
// condemn it. A successful run clears the entry.
//
// Consumers: backend/seo-pages.js (sitemap exclusion + page label),
// backend/quote-store.js (a dead ticker gets no live lookup).

const fs = require('fs');
const path = require('path');

const FILE = process.env.FUNDAMENTALS_STATUS_FILE
    || path.join(__dirname, '..', 'frontend', 'data', 'fundamentals-status.json');
const UNLISTED_AFTER = 2;
const FRESH_CACHE_MS = 60 * 1000;

let _cache = { at: 0, manifest: null };

function load() {
    if (_cache.manifest && Date.now() - _cache.at < FRESH_CACHE_MS) return _cache.manifest;
    let manifest = { generatedAt: null, symbols: {} };
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.symbols && typeof parsed.symbols === 'object') {
            manifest = { generatedAt: parsed.generatedAt || null, symbols: parsed.symbols };
        }
    } catch (_) { /* no manifest yet */ }
    _cache = { at: Date.now(), manifest };
    return manifest;
}

function save(manifest) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, FILE);
    _cache = { at: Date.now(), manifest };
}

// Yahoo's two permanent shapes are "Quote not found for symbol: X" and
// "No data found, symbol may be delisted". Everything else — 429s, timeouts,
// ECONNRESET — is transient and must not count toward unlisted.
function classify(reasons) {
    const text = (reasons || []).map(String).join(' ').toLowerCase();
    if (!text) return 'empty';
    if (/not found|no data found|may be delisted|delisted|invalid symbol|404/.test(text)) return 'not-found';
    return 'transient';
}

// Pure merge: previous manifest + one run's outcomes -> next manifest.
// results: [{ symbol, ok, reasons: string[] }]
// day: 'YYYY-MM-DD' of the run (consecutive counts only advance across days).
function recordRun(manifest, results, day) {
    const next = {
        generatedAt: new Date().toISOString(),
        symbols: { ...((manifest && manifest.symbols) || {}) }
    };
    for (const row of results || []) {
        const sym = String((row && row.symbol) || '').toUpperCase();
        if (!sym) continue;
        if (row.ok) { delete next.symbols[sym]; continue; }
        const prev = next.symbols[sym] || null;
        const kind = classify(row.reasons);
        const sameDay = prev && prev.lastFailedDay === day;
        const consecutive = sameDay ? (prev.consecutive || 1) : (prev ? (prev.consecutive || 0) + 1 : 1);
        const entry = {
            firstFailedDay: prev ? (prev.firstFailedDay || day) : day,
            lastFailedDay: day,
            lastFailedAt: new Date().toISOString(),
            consecutive,
            kind,
            lastError: String((row.reasons && row.reasons[0]) || '').slice(0, 200)
        };
        if (kind === 'not-found' && consecutive >= UNLISTED_AFTER) {
            entry.unlistedSince = prev && prev.unlistedSince ? prev.unlistedSince : day;
        } else if (prev && prev.unlistedSince) {
            entry.unlistedSince = prev.unlistedSince; // stay flagged until a success clears it
        }
        next.symbols[sym] = entry;
    }
    return next;
}

function info(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const row = load().symbols[sym];
    if (!row) return { unlisted: false, since: null, kind: null, lastError: null };
    return {
        unlisted: !!row.unlistedSince,
        since: row.unlistedSince || null,
        kind: row.kind || null,
        lastError: row.lastError || null,
        consecutive: row.consecutive || 0
    };
}

function isUnlisted(symbol) {
    return info(symbol).unlisted;
}

module.exports = { load, save, classify, recordRun, info, isUnlisted, FILE, UNLISTED_AFTER };
