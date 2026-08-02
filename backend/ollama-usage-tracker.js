'use strict';

// Privacy-safe provider metering. It records request metadata only (never
// prompts, answers, API keys, cookies, or tokens) and keeps the live view behind
// the existing owner-only admin authorization in app.js.
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const requestStore = new AsyncLocalStorage();
const active = new Map();
const recent = [];
const listeners = new Set();
const MAX_RECENT = 300;
const RETENTION_DAYS = 30;

function clean(value, max = 160) {
    const text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
    return text ? text.slice(0, max) : null;
}

function providerFor(baseUrl) {
    return /ollama\.com/i.test(String(baseUrl || '')) ? 'ollama' : 'other';
}

function runRequest(req, next) {
    const method = clean(req && req.method, 12) || 'GET';
    const path = clean(req && (req.path || req.originalUrl), 180) || '/';
    return requestStore.run({
        requestId: crypto.randomUUID(),
        actorType: 'anonymous',
        userId: null,
        email: null,
        route: `${method} ${path}`
    }, next);
}

function setActor({ userId = null, email = null, actorType = 'user' } = {}) {
    const store = requestStore.getStore();
    if (!store) return;
    store.actorType = actorType;
    store.userId = userId ? String(userId) : null;
    store.email = clean(email, 254);
}

function context() {
    const store = requestStore.getStore();
    if (store) return { ...store };
    return {
        requestId: null,
        actorType: 'background',
        userId: null,
        email: null,
        route: 'background'
    };
}

function collection() {
    return mongoose.connection.collection('ollama_usage_events');
}

function broadcast(event) {
    const payload = { ...event };
    listeners.forEach((listener) => {
        try { listener(payload); } catch (_) { /* one dashboard client cannot break metering */ }
    });
}

function publicEvent(event) {
    return {
        callId: event.callId,
        requestId: event.requestId,
        actorType: event.actorType,
        userId: event.userId,
        email: event.email,
        route: event.route,
        provider: event.provider,
        model: event.model,
        purpose: event.purpose,
        status: event.status,
        startedAt: event.startedAt,
        completedAt: event.completedAt || null,
        durationMs: event.durationMs == null ? null : event.durationMs,
        totalTokens: event.totalTokens == null ? null : event.totalTokens,
        errorCode: event.errorCode || null
    };
}

function addRecent(event) {
    recent.unshift(publicEvent(event));
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
}

function persistStart(event) {
    if (mongoose.connection.readyState !== 1) return;
    Promise.resolve().then(async () => {
        const col = collection();
        await col.createIndex({ startedAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 }).catch(() => {});
        await col.createIndex({ callId: 1 }, { unique: true }).catch(() => {});
        await col.insertOne({ ...publicEvent(event), _createdAt: new Date() });
    }).catch(() => {});
}

function persistFinish(event) {
    if (mongoose.connection.readyState !== 1) return;
    Promise.resolve().then(() => collection().updateOne(
        { callId: event.callId },
        { $set: publicEvent(event) }
    )).catch(() => {});
}

function start({ baseUrl, model, purpose }) {
    const c = context();
    const event = {
        callId: crypto.randomUUID(),
        requestId: c.requestId,
        actorType: c.actorType || 'background',
        userId: c.userId,
        email: c.email,
        route: c.route || 'background',
        provider: providerFor(baseUrl),
        model: clean(model, 120) || 'unknown',
        purpose: clean(purpose, 60) || 'briefing',
        status: 'active',
        startedAt: new Date()
    };
    active.set(event.callId, event);
    broadcast({ type: 'start', event: publicEvent(event) });
    persistStart(event);
    return event;
}

function classifyError(error) {
    const message = String(error && error.message || '').toLowerCase();
    if (message.includes('timeout')) return 'timeout';
    if (/provider\s+5\d\d|fetch failed|econnreset|etimedout/.test(message)) return 'provider_unavailable';
    if (/provider\s+4\d\d/.test(message)) return 'provider_rejected';
    return 'error';
}

function finish(event, { status = 'completed', usage = null, error = null } = {}) {
    if (!event || !event.callId) return;
    const current = active.get(event.callId) || event;
    current.status = status;
    current.completedAt = new Date();
    current.durationMs = Math.max(0, current.completedAt.getTime() - new Date(current.startedAt).getTime());
    const reportedTotal = usage && Number(usage.total_tokens);
    const prompt = usage && Number(usage.prompt_tokens);
    const completion = usage && Number(usage.completion_tokens);
    const total = Number.isFinite(reportedTotal)
        ? reportedTotal
        : (Number.isFinite(prompt) && Number.isFinite(completion) ? prompt + completion : null);
    current.totalTokens = Number.isFinite(total) ? total : null;
    current.errorCode = error ? classifyError(error) : null;
    active.delete(current.callId);
    addRecent(current);
    broadcast({ type: 'finish', event: publicEvent(current) });
    persistFinish(current);
}

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

async function snapshot({ sinceMs = 24 * 3600 * 1000, limit = 200 } = {}) {
    const since = new Date(Date.now() - Math.max(60_000, Number(sinceMs) || 0));
    let stored = [];
    if (mongoose.connection.readyState === 1) {
        try {
            stored = await collection().find({ startedAt: { $gte: since } })
                .sort({ startedAt: -1 }).limit(Math.min(Math.max(Number(limit) || 200, 1), 500)).toArray();
        } catch (_) { stored = []; }
    }
    const byId = new Map(stored.map((event) => [event.callId, publicEvent(event)]));
    recent.forEach((event) => {
        if (new Date(event.startedAt).getTime() >= since.getTime() && !byId.has(event.callId)) byId.set(event.callId, event);
    });
    const staleAt = Date.now() - 15 * 60 * 1000;
    const events = [...byId.values()]
        .filter((event) => event.provider === 'ollama')
        .map((event) => {
            if (event.status === 'active' && new Date(event.startedAt).getTime() < staleAt) {
                return { ...event, status: 'abandoned', errorCode: 'stale_call' };
            }
            return event;
        })
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
        .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500));
    const activeEvents = [...active.values()]
        .filter((event) => event.provider === 'ollama' && new Date(event.startedAt).getTime() >= since.getTime())
        .map(publicEvent);
    const users = new Map();
    events.forEach((event) => {
        const key = event.userId || `${event.actorType}:${event.email || 'system'}`;
        const row = users.get(key) || {
            key,
            userId: event.userId,
            email: event.email,
            actorType: event.actorType,
            calls: 0,
            active: 0,
            completed: 0,
            errors: 0,
            totalTokens: 0,
            lastAt: null,
            purposes: {}
        };
        row.calls += 1;
        if (event.status === 'active') row.active += 1;
        if (event.status === 'completed') row.completed += 1;
        if (event.status === 'error') row.errors += 1;
        if (Number.isFinite(event.totalTokens)) row.totalTokens += event.totalTokens;
        row.lastAt = !row.lastAt || new Date(event.startedAt) > new Date(row.lastAt) ? event.startedAt : row.lastAt;
        row.purposes[event.purpose] = (row.purposes[event.purpose] || 0) + 1;
        users.set(key, row);
    });
    activeEvents.forEach((event) => {
        const key = event.userId || `${event.actorType}:${event.email || 'system'}`;
        const row = users.get(key);
        if (row && !events.some((item) => item.callId === event.callId)) {
            row.calls += 1; row.active += 1;
            row.lastAt = !row.lastAt || new Date(event.startedAt) > new Date(row.lastAt) ? event.startedAt : row.lastAt;
        }
    });
    return {
        generatedAt: new Date().toISOString(),
        windowStartedAt: since.toISOString(),
        provider: 'ollama',
        active: activeEvents,
        users: [...users.values()].sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0)),
        recent: events,
        notes: [
            'User attribution comes from the authenticated StockPortfolio session.',
            'Anonymous and background calls are shown separately; they are not assigned to a customer.',
            'Token totals are provider-reported when available and may be null for providers that omit usage.'
        ]
    };
}

module.exports = {
    runRequest,
    setActor,
    context,
    start,
    finish,
    subscribe,
    snapshot,
    providerFor
};
