'use strict';

// The dashboard uses only adjusted closes. Keep the legacy OHLC response for
// every other consumer and preserve every date/value in the requested history.
function number(value) {
    if (value === null || value === undefined ||
        (typeof value === 'string' && /^(?:none|null)?$/i.test(value.trim()))) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function closes(payload) {
    const daily = payload?.['Time Series (Daily)'] || {};
    return {
        prices: Object.keys(daily).sort().map((day) => [day,
            number(daily[day]?.['5. adjusted close']) ?? number(daily[day]?.['4. close'])])
    };
}

module.exports = { closes };
