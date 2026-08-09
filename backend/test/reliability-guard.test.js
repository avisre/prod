'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('background health surfaces use the synchronous bounded cache', () => {
    const watchdog = read('watchdog.js');
    const seo = read('seo-pages.js');
    const xray = read('xray.js');

    assert.match(watchdog, /healthChecksFromData\(aiChat\.loadFund\(symbol\), symbol\)/);
    assert.doesNotMatch(watchdog, /runTool\(['"]get_health_checks['"]\)/);
    assert.match(seo, /healthChecksFromData\(data, sym\)/);
    assert.doesNotMatch(seo, /runTool\(['"]get_health_checks['"]\)/);
    assert.match(xray, /healthChecksFromData\(aiChat\.loadFund\(p\.symbol\), p\.symbol\)/);
    assert.doesNotMatch(xray, /runTool\(['"]get_health_checks['"]\)/);
});

test('AI chat exports preserve identity across watchdog circular loading', () => {
    const aiChat = read('ai-chat.js');
    assert.match(aiChat, /Object\.assign\(module\.exports/);
    assert.doesNotMatch(aiChat, /module\.exports\s*=\s*\{[^}]*healthChecksFromData/);
});

test('4xx and 5xx route telemetry is bounded and query-free', () => {
    const app = read('app.js');
    assert.match(app, /\[http-status\]/);
    assert.match(app, /count >= 100/);
    assert.match(app, /path: req\.path/);
    assert.doesNotMatch(app, /query: req\.query/);
});

test('API JSON is compressible while streaming endpoints remain excluded', () => {
    const app = read('app.js');
    assert.match(app, /gzip public HTML\/CSS\/JS and JSON API responses/);
    assert.match(app, /req\.path === '\/api\/admin\/ollama\/usage\/stream'/);
    assert.match(app, /req\.path === '\/api\/ai\/chat' && req\.body && req\.body\.stream === true/);
    assert.doesNotMatch(app, /if \(req\.path\.startsWith\('\/api'\)\) return false/);
});
