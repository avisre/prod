'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { createMeter } = require('../outbound-byte-usage');

test('counts outgoing connections and both byte directions without counting accepted sockets twice', async () => {
    const meter = createMeter();
    const original = net.Socket.prototype.connect;
    const server = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('r'.repeat(32768))); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    meter.start();
    try {
        await new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', agent: false,
                headers: { Authorization: 'Bearer secret-must-not-be-recorded' } }, res => {
                res.resume(); res.on('end', resolve);
            });
            req.on('error', reject); req.end('s'.repeat(8192));
        });
        const result = meter.snapshot();
        assert.equal(result.rows.length, 1);
        assert.equal(result.rows[0].destination, `127.0.0.1:${port}`);
        assert.equal(result.rows[0].attempts, 1);
        assert.ok(result.sentBytes >= 8192 && result.sentBytes < 16384, 'response bytes were not counted as outgoing');
        assert.ok(result.receivedBytes >= 32768);
        const again = meter.snapshot();
        assert.equal(again.sentBytes, result.sentBytes, 'repeated reads do not count bytes twice');
        assert.ok(!JSON.stringify(result).includes('secret-must-not-be-recorded'));
    } finally { meter.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.equal(net.Socket.prototype.connect, original);
});

test('accounts for pooled connections while open and stops automatically', async () => {
    const meter = createMeter();
    const server = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    meter.start({ durationMs: 100 });
    const socket = net.connect(server.address().port, '127.0.0.1');
    try {
        await once(socket, 'connect');
        socket.write('first'); await once(socket, 'data');
        assert.equal(meter.snapshot().sentBytes, 5);
        socket.write('second'); await once(socket, 'data');
        assert.equal(meter.snapshot().sentBytes, 11);
        await new Promise(resolve => setTimeout(resolve, 130));
        assert.equal(meter.snapshot().running, false);
    } finally { socket.destroy(); meter.stop(); await new Promise(resolve => server.close(resolve)); }
});

test('bounds destinations and reports sockets omitted by the tracking limit', async () => {
    const meter = createMeter({ maxDestinations: 1, maxSockets: 2 });
    const servers = Array.from({ length: 3 }, () => net.createServer(socket => socket.on('data', () => {})));
    for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    meter.start();
    const sockets = servers.map(server => net.connect(server.address().port, '127.0.0.1'));
    try {
        await Promise.all(sockets.map(socket => once(socket, 'connect')));
        const result = meter.snapshot();
        assert.equal(result.rows.length, 2);
        assert.equal(result.rows[1].destination, 'other');
        assert.equal(result.droppedSockets, 1);
    } finally {
        sockets.forEach(socket => socket.destroy()); meter.stop();
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    }
});
