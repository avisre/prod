'use strict';

// Connector usage for the profile page (owner decision 2026-10-08).
//
// The credit ledger already holds one row per successful connector call, but
// it could not answer the two questions a customer has after a session: what
// did the assistant pull, and how many calls bounced. A connector row carried
// no subject (the REST API stored the ticker, the connector stored null), and a
// refused call was written nowhere at all — the first paying connector customer
// spent a month's credits in 28 minutes and neither he nor we could see what
// happened after the balance hit zero.
//
// This module is the shape of the answer and nothing else: what to record for a
// call, how rows fold into sessions, how fast a session is spending, and the
// CSV. No database handle is opened here; callers pass collections in, so the
// folding logic is tested without one.

const SUBJECT_MAX = 80;
const QUESTION_WORDS = 8;
// Two calls further apart than this belong to different sittings. An assistant
// working through a list fires every few seconds; a person coming back after
// lunch is a new session.
const SESSION_GAP_MS = 15 * 60 * 1000;
// A session counts as still running if its last call is this recent.
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
// Past this the forecast is noise, so it is not shown.
const PACE_HORIZON_MINUTES = 180;
// A client stuck retrying a refused call must not fill the collection.
const REFUSALS_PER_USER_PER_HOUR = 60;

const REFUSAL_LABELS = Object.freeze({
    QUOTA_EXCEEDED: 'Out of credits',
    ENTITLEMENT_REQUIRED: 'Plan does not include the connector',
    REGION_PAID_ONLY: 'Region requires a paid plan',
    NETWORK_PAID_ONLY: 'VPN or data-centre connection requires a paid plan'
});

function clean(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// What a call was about, short enough to list and never the whole prompt: the
// ticker for a lookup, the ticker plus the first few words for a question.
function subjectFor(args) {
    const a = args && typeof args === 'object' ? args : {};
    const ticker = clean(a.ticker || a.symbol, 12).toUpperCase();
    const asked = clean(a.question || a.query, 400);
    const words = asked ? asked.split(' ') : [];
    const snippet = words.slice(0, QUESTION_WORDS).join(' ') + (words.length > QUESTION_WORDS ? '…' : '');
    const accession = clean(a.accession_number, 30);
    const subject = [ticker, snippet].filter(Boolean).join(': ') || accession;
    return subject ? subject.slice(0, SUBJECT_MAX) : null;
}

const refusalWindow = new Map(); // userId -> { startedAt, count }

function refusalAllowed(userId, now = Date.now()) {
    const key = String(userId);
    const w = refusalWindow.get(key);
    if (!w || now - w.startedAt >= 60 * 60 * 1000) {
        refusalWindow.set(key, { startedAt: now, count: 1 });
        return true;
    }
    if (w.count >= REFUSALS_PER_USER_PER_HOUR) return false;
    w.count += 1;
    return true;
}

// Never throws: a refusal is already on its way to the caller, and a logging
// failure must not turn it into a server error.
async function recordRefusal(col, { userId, tool, subject, code, client } = {}, now = new Date()) {
    if (!col || !userId || !REFUSAL_LABELS[code]) return false;
    if (!refusalAllowed(userId, now.getTime())) return false;
    try {
        await col.insertOne({
            userId: String(userId),
            month: now.toISOString().slice(0, 7),
            at: now,
            tool: clean(tool, 60),
            subject: subject ? clean(subject, SUBJECT_MAX) : null,
            code,
            client: client ? clean(client, 60) : null
        });
        return true;
    } catch (error) {
        console.error('[connector-usage] refusal not recorded:', error && error.message);
        return false;
    }
}

function toolOf(reason) {
    return String(reason || '').replace(/^(mcp|mcp-apps|api):/, '');
}

// One list of events, calls and refusals together, oldest first.
function events(ledgerRows, refusalRows) {
    const calls = (ledgerRows || [])
        .filter((r) => /^(mcp|mcp-apps|api):/.test(String(r.reason || '')) && Number(r.delta) < 0)
        .map((r) => ({
            at: new Date(r.at),
            kind: 'call',
            via: String(r.reason).startsWith('api:') ? 'api' : 'connector',
            tool: toolOf(r.reason),
            subject: r.refId || null,
            credits: -Number(r.delta),
            client: r.client || null,
            code: null
        }));
    const refused = (refusalRows || []).map((r) => ({
        at: new Date(r.at),
        kind: 'refused',
        via: 'connector',
        tool: String(r.tool || ''),
        subject: r.subject || null,
        credits: 0,
        client: r.client || null,
        code: r.code
    }));
    return [...calls, ...refused]
        .filter((e) => !Number.isNaN(e.at.getTime()))
        .sort((a, b) => a.at - b.at);
}

// Fold events into sittings, newest first. A session is what the customer did
// in one go, so it is the unit they recognise: "Claude, 12:56 to 13:24, 32
// calls, 104 credits" rather than 32 identical lines.
function sessions(ledgerRows, refusalRows, { gapMs = SESSION_GAP_MS, subjectCap = 60 } = {}) {
    const out = [];
    let cur = null;
    for (const e of events(ledgerRows, refusalRows)) {
        if (!cur || e.at - cur.end > gapMs) {
            cur = { start: e.at, end: e.at, calls: 0, credits: 0, refused: 0, tools: {}, refusedBy: {}, subjects: [], clients: [], via: [] };
            out.push(cur);
        }
        cur.end = e.at;
        if (e.kind === 'call') {
            cur.calls += 1;
            cur.credits += e.credits;
            cur.tools[e.tool] = (cur.tools[e.tool] || 0) + 1;
        } else {
            cur.refused += 1;
            cur.refusedBy[e.code] = (cur.refusedBy[e.code] || 0) + 1;
        }
        if (e.subject && !cur.subjects.includes(e.subject) && cur.subjects.length < subjectCap) cur.subjects.push(e.subject);
        if (e.client && !cur.clients.includes(e.client)) cur.clients.push(e.client);
        if (!cur.via.includes(e.via)) cur.via.push(e.via);
    }
    return out.reverse().map((s) => ({
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        calls: s.calls,
        credits: s.credits,
        refused: s.refused,
        refusedBy: Object.entries(s.refusedBy).map(([code, count]) => ({ code, label: REFUSAL_LABELS[code] || code, count })),
        tools: Object.entries(s.tools).map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
        subjects: s.subjects,
        client: s.clients.length === 1 ? s.clients[0] : (s.clients.length > 1 ? s.clients.join(' and ') : null),
        via: s.via.length === 1 ? s.via[0] : 'connector'
    }));
}

// How long the balance lasts if the session that is running now keeps going at
// its own rate. Null unless a session is actually running and the answer is
// near enough to act on — a forecast for a session that ended an hour ago, or
// one that says "eleven days", is decoration.
function pace(sessionList, remaining, now = new Date()) {
    const latest = (sessionList || [])[0];
    const left = Number(remaining);
    if (!latest || !latest.calls || !Number.isFinite(left)) return null;
    const end = new Date(latest.end).getTime();
    const start = new Date(latest.start).getTime();
    if (now.getTime() - end > ACTIVE_WINDOW_MS) return null;
    // A single call has no rate. One minute is the floor so a burst of calls in
    // the same few seconds is not read as an infinite pace.
    if (latest.calls < 3) return null;
    const minutes = Math.max(1, (end - start) / 60000);
    const creditsPerMinute = latest.credits / minutes;
    if (!(creditsPerMinute > 0)) return null;
    if (left <= 0) return { creditsPerMinute: Math.round(creditsPerMinute * 10) / 10, minutesLeft: 0 };
    const minutesLeft = Math.floor(left / creditsPerMinute);
    if (minutesLeft > PACE_HORIZON_MINUTES) return null;
    return { creditsPerMinute: Math.round(creditsPerMinute * 10) / 10, minutesLeft };
}

function csvCell(value) {
    let s = String(value == null ? '' : value);
    // A cell that starts with one of these runs as a formula in a spreadsheet.
    // The subject is text an assistant typed, so it is neutralised.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(ledgerRows, refusalRows) {
    const lines = [['time_utc', 'via', 'client', 'tool', 'subject', 'result', 'credits'].join(',')];
    for (const e of events(ledgerRows, refusalRows)) {
        lines.push([
            e.at.toISOString(),
            e.via,
            e.client || '',
            e.tool,
            e.subject || '',
            e.kind === 'call' ? 'ok' : `refused: ${REFUSAL_LABELS[e.code] || e.code}`,
            e.credits
        ].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}

function _resetForTest() { refusalWindow.clear(); }

module.exports = {
    SESSION_GAP_MS, ACTIVE_WINDOW_MS, PACE_HORIZON_MINUTES, REFUSALS_PER_USER_PER_HOUR, REFUSAL_LABELS,
    subjectFor, recordRefusal, events, sessions, pace, toCsv, _resetForTest
};
