'use strict';
// Filing HTML → readable text, the character half. Each htmlToText copy strips
// tags its own way, but they all used to decode only a handful of entities, so a
// filing's &#8203; (the zero-width space Workiva puts between table cells), &#8220;
// and the like reached users verbatim inside "verified" quotations (INOD 10-Q,
// 2026-10-18: "Revenues &#8203; $ 92,142 &#8203; $ 58,393").

const NAMED = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
    ndash: '–', mdash: '—', minus: '−', hellip: '…', bull: '•', middot: '·',
    copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', deg: '°',
    times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
    cent: '¢', pound: '£', euro: '€', yen: '¥',
    ensp: ' ', emsp: ' ', thinsp: ' ', zwsp: ' ', zwnj: '', zwj: ''
};

// Zero-width and BOM characters: a cell separator in filings, so a space.
const INVISIBLE = /[​-‍⁠﻿]/g;

function decodeEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&#(\d{1,7});/g, (m, d) => { const n = Number(d); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '; })
        .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '; })
        .replace(/&([a-z][a-z0-9]{1,8});/gi, (m, name) => (Object.prototype.hasOwnProperty.call(NAMED, name.toLowerCase()) ? NAMED[name.toLowerCase()] : m))
        .replace(INVISIBLE, ' ')
        .replace(/ /g, ' ');
}

// A quotation as a reader should see it. Also cleans quotes cached before the
// decoder existed, including one cut off part-way through an entity.
function tidyQuote(s) {
    if (s == null) return s;
    return decodeEntities(s)
        .replace(/&#?[a-z0-9]{0,8}$/i, '')
        .replace(/\s+/g, ' ')
        .replace(/([$€£¥])\s+(?=[\d(])/g, '$1')
        .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
        .replace(/(\d)\s+%/g, '$1%')
        .trim();
}

module.exports = { decodeEntities, tidyQuote };
