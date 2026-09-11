'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const botBlocker = require('../bot-blocker');

const ROBOTS_PATH = path.join(__dirname, '..', '..', 'frontend', 'robots.txt');
const robotsText = fs.readFileSync(ROBOTS_PATH, 'utf8');

// Parses robots.txt into an ordered list of { agent, lines } stanzas. This
// file never groups multiple "User-agent:" lines under one shared rule set
// (every agent gets its own stanza), so each User-agent line simply starts a
// fresh stanza — this parser intentionally does not support grouping.
function parseStanzas(text) {
    const stanzas = [];
    let current = null;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const uaMatch = line.match(/^User-agent:\s*(.+)$/i);
        if (uaMatch) {
            current = { agent: uaMatch[1].trim(), lines: [] };
            stanzas.push(current);
            continue;
        }
        if (current) current.lines.push(line);
    }
    return stanzas;
}

const stanzas = parseStanzas(robotsText);

function topLevelAllowsRoot(stanza) {
    // "Allow: /" as the first path directive in the stanza — i.e. nothing
    // before it disallows the root first.
    const firstPathDirective = stanza.lines.find((l) => /^(Allow|Disallow):/i.test(l));
    return Boolean(firstPathDirective && /^Allow:\s*\/\s*$/i.test(firstPathDirective));
}

test('robots.txt allow-listed agents match bot-blocker.js exactly', () => {
    const allowedInRobots = stanzas
        .filter((s) => s.agent !== '*' && topLevelAllowsRoot(s))
        .map((s) => s.agent.toLowerCase())
        .sort();
    const allowedInCode = [...botBlocker.ALLOWED_UAS].sort();
    assert.deepEqual(allowedInRobots, allowedInCode,
        'frontend/robots.txt Allow-listed agents must exactly match backend/bot-blocker.js ALLOWED_UAS');
});

test('Google-Extended has its own explicit Disallow, separate from the wildcard group', () => {
    const stanza = stanzas.find((s) => s.agent.toLowerCase() === 'google-extended');
    assert.ok(stanza, 'Google-Extended must have its own User-agent stanza');
    assert.ok(stanza.lines.some((l) => /^Disallow:\s*\/\s*$/i.test(l)),
        'Google-Extended must be explicitly disallowed, not merely inherit the wildcard rule');
});

test('the wildcard User-agent disallows everything by default', () => {
    const wildcard = stanzas.find((s) => s.agent === '*');
    assert.ok(wildcard, 'a wildcard User-agent stanza must exist');
    const firstPathDirective = wildcard.lines.find((l) => /^(Allow|Disallow):/i.test(l));
    assert.match(firstPathDirective, /^Disallow:\s*\/\s*$/i);
});

test('every named crawler bot-blocker.js denies by pattern has a matching Disallow stanza', () => {
    const namedDeniedAgents = [
        'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'anthropic-ai', 'ClaudeBot', 'Claude-Web',
        'PerplexityBot', 'Perplexity-User', 'CCBot', 'Bytespider', 'Amazonbot', 'cohere-ai',
        'Diffbot', 'meta-externalagent', 'DuckDuckBot', 'YandexBot', 'Baiduspider', 'Applebot',
        'Applebot-Extended', 'FacebookBot', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot'
    ];
    for (const agent of namedDeniedAgents) {
        const stanza = stanzas.find((s) => s.agent.toLowerCase() === agent.toLowerCase());
        assert.ok(stanza, `${agent} must have its own User-agent stanza`);
        assert.ok(stanza.lines.some((l) => /^Disallow:\s*\/\s*$/i.test(l)), `${agent} must be Disallow: /`);
    }
});

test('the sitemap declaration and /v1//v2 mirror-path disallows survive the rewrite', () => {
    assert.match(robotsText, /Sitemap:\s*https:\/\/www\.stockportfolio\.pro\/sitemap\.xml/);
    const wildcard = stanzas.find((s) => s.agent === '*');
    assert.ok(wildcard.lines.some((l) => /^Disallow:\s*\/v1\/\s*$/i.test(l)));
    assert.ok(wildcard.lines.some((l) => /^Disallow:\s*\/v2\/\s*$/i.test(l)));
});

test('robots.txt has no duplicate User-agent stanza with conflicting top-level directives', () => {
    const byAgent = new Map();
    for (const s of stanzas) {
        const key = s.agent.toLowerCase();
        const firstPathDirective = s.lines.find((l) => /^(Allow|Disallow):/i.test(l));
        if (!byAgent.has(key)) byAgent.set(key, []);
        byAgent.get(key).push(firstPathDirective);
    }
    for (const [agent, directives] of byAgent) {
        const unique = new Set(directives.map((d) => (d || '').toLowerCase()));
        assert.equal(unique.size, 1, `${agent} has conflicting directives across stanzas: ${directives.join(' | ')}`);
    }
});

test('every stanza has at least one Allow or Disallow directive', () => {
    for (const s of stanzas) {
        assert.ok(s.lines.some((l) => /^(Allow|Disallow):/i.test(l)), `stanza for ${s.agent} has no Allow/Disallow line`);
    }
});
