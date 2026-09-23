'use strict';

// The anonymous company allowance: how many DIFFERENT companies one signed-out
// visitor may look at in a UTC day, before being asked to create an account.
//
// Distinct symbols, not requests. A company page fans out to several endpoints
// for the same stock, so counting calls would punish ordinary browsing — a
// reader would be limited after a few page views — while a scraper, which makes
// one call per company, would go straight through. Counting symbols is what
// makes the allowance mean "companies researched" rather than "requests made".
//
// The limit exists because the free company endpoints do real work:
// /api/company/:symbol/filings runs a live SEC deep fetch on a cache miss, and
// /api/company/:symbol/insider-history starts a ~1-2 minute background build
// for a company nobody has built yet. Those endpoints stay keyless on purpose —
// they are the pages Google indexes and the try-before-you-buy surface — so the
// control is a limit only a machine reaches, not a login wall.
function createCompanyAllowance({ perDay, maxEntries = 50000 } = {}) {
    const seen = new Map(); // key -> { day, symbols: Set }

    return {
        // True when this key may see this symbol: repeats and everything already
        // counted today are free, and a new symbol is counted only if the day's
        // allowance is not yet spent.
        allow(key, symbol, day) {
            let record = seen.get(key);
            if (!record || record.day !== day) {
                record = { day, symbols: new Set() };
                seen.set(key, record);
            }
            if (record.symbols.has(symbol)) return true;
            if (record.symbols.size >= perDay) return false;
            record.symbols.add(symbol);
            // Bound the map so a distributed caller cannot grow it without
            // limit. Insertion-order eviction, the same posture the compare
            // verdict trial takes for its per-day map. This is a memory guard,
            // not a security boundary: an evicted record starts its day again,
            // which is why the per-request limiters still carry the load.
            if (seen.size > maxEntries) {
                const oldest = seen.keys().next().value;
                if (oldest !== key) seen.delete(oldest);
            }
            return true;
        },
        // Distinct companies counted for a key today — for admin visibility.
        used(key, day) {
            const record = seen.get(key);
            return record && record.day === day ? record.symbols.size : 0;
        },
        size() { return seen.size; }
    };
}

module.exports = { createCompanyAllowance };
