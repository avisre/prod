'use strict';

// Canonical symbol normalization shared by request handlers and server-rendered
// SEO routes. Keep the separator behavior in one place: the application already
// treats class-share spellings such as BRK.B, BRK/B, BRK B and BRK-B as the same
// security, and changing that behavior would create aliases or redirect loops.
function safeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function isValidTicker(value = '') {
  return /^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(String(value || '').trim().toUpperCase());
}

function normalizeTicker(value = '') {
  return safeUpper(value)
    .replace(/[.\/\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { safeUpper, isValidTicker, normalizeTicker };
