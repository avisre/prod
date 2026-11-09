'use strict';

// Temporary, metadata-only audit of connections opened by this process.
// Accepted HTTP connections never call connect(), so browser responses are
// excluded. Node's socket counters include protocol traffic at that socket's
// layer; TLS/kernel overhead can differ from Render's billed wire bytes.
const net = require('node:net');

function destination(args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (first && typeof first === 'object' && first.path) return null;
    const options = first && typeof first === 'object' ? first : {};
    const port = Number(options.port || first);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const host = String(options.host || options.hostname || (typeof args[1] === 'string' ? args[1] : 'localhost')).toLowerCase();
    if (host.length > 253 || !/^[a-z0-9_.:\-]+$/.test(host)) return null;
    return { host, port };
}

function createMeter({ maxDestinations = 128, maxSockets = 512, now = () => new Date() } = {}) {
    const rows = new Map(), active = new Map();
    const seen = new WeakSet();
    const since = now().toISOString();
    let droppedSockets = 0, restore = null, timer = null, expiry = null;

    function sample(socket, state) {
        const sent = Number(socket.bytesWritten) || 0, received = Number(socket.bytesRead) || 0;
        state.row.sentBytes += Math.max(0, sent - state.sent);
        state.row.receivedBytes += Math.max(0, received - state.received);
        state.sent = sent; state.received = received;
    }
    function track(socket, target) {
        if (!target || seen.has(socket)) return;
        seen.add(socket);
        if (active.size >= maxSockets) { droppedSockets++; return; }
        let key = `${target.host}:${target.port}`;
        if (!rows.has(key) && rows.size >= maxDestinations) key = 'other';
        if (!rows.has(key)) rows.set(key, { destination: key, attempts: 0, sentBytes: 0, receivedBytes: 0 });
        const row = rows.get(key);
        row.attempts++;
        const state = { row, sent: 0, received: 0, onClose: null };
        active.set(socket, state);
        state.onClose = () => { sample(socket, state); active.delete(socket); };
        socket.once('close', state.onClose);
    }
    function snapshot() {
        for (const [socket, state] of active) sample(socket, state);
        const sorted = [...rows.values()].map(row => ({ ...row })).sort((a, b) => b.sentBytes - a.sentBytes);
        return { since, measuredAt: now().toISOString(), running: !!restore, activeSockets: active.size, droppedSockets,
            sentBytes: sorted.reduce((sum, row) => sum + row.sentBytes, 0),
            receivedBytes: sorted.reduce((sum, row) => sum + row.receivedBytes, 0), rows: sorted };
    }
    function stop() {
        clearInterval(timer); clearTimeout(expiry); timer = expiry = null;
        snapshot();
        if (restore) restore();
        restore = null;
        for (const [socket, state] of active) socket.removeListener('close', state.onClose);
        active.clear();
    }
    function start({ log = null, intervalMs = 5 * 60 * 1000, durationMs = 24 * 3600 * 1000 } = {}) {
        if (restore) return;
        const original = net.Socket.prototype.connect;
        function connect(...args) {
            // Diagnostics must never prevent an application connection.
            try { track(this, destination(args)); } catch (_) {}
            return Reflect.apply(original, this, args);
        }
        net.Socket.prototype.connect = connect;
        restore = () => { if (net.Socket.prototype.connect === connect) net.Socket.prototype.connect = original; };
        if (log) {
            timer = setInterval(() => { try { log(snapshot()); } catch (_) {} }, intervalMs);
            timer.unref();
        }
        expiry = setTimeout(() => { stop(); if (log) { try { log(snapshot()); } catch (_) {} } }, durationMs);
        expiry.unref();
    }
    return { start, stop, snapshot };
}

module.exports = { createMeter, ...createMeter() };
