'use strict';

// ai-platform-egress.js — which requests came out of an AI platform's own
// network, and therefore meter against the shared platform pool instead of a
// per-visitor window. Pure in-memory matching, so no database here: what is
// under test is the CIDR arithmetic and the published lists.

const test = require('node:test');
const assert = require('node:assert/strict');
const egress = require('../ai-platform-egress');

// Anthropic publishes one range, 160.79.104.0/21 (source URL in the module):
// 160.79.104.0 through 160.79.111.255.
const ANTHROPIC_FIRST = '160.79.104.0';
const ANTHROPIC_LAST = '160.79.111.255';

test('the Anthropic range matches its first and last address, and nothing just outside', () => {
    assert.equal(egress.match(ANTHROPIC_FIRST), 'anthropic', 'first address of the /21');
    assert.equal(egress.match('160.79.108.42'), 'anthropic', 'an address inside the range');
    assert.equal(egress.match(ANTHROPIC_LAST), 'anthropic', 'last address of the /21');
    assert.equal(egress.match('160.79.103.255'), null, 'one below the range is a visitor');
    assert.equal(egress.match('160.79.112.0'), null, 'one above the range is a visitor');
});

test('OpenAI connector ranges match, at both a /32 and a wider prefix', () => {
    // 100.31.168.162/32 and 104.210.139.192/28 are entries from the vendored
    // openai.com/chatgpt-connectors.json snapshot; the /28 spans .192-.207.
    assert.equal(egress.match('100.31.168.162'), 'openai', 'a published /32 matches itself');
    assert.equal(egress.match('100.31.168.161'), null, 'and not its neighbour');
    assert.equal(egress.match('104.210.139.192'), 'openai', 'the network address of a /28');
    assert.equal(egress.match('104.210.139.207'), 'openai', 'the broadcast address of the /28');
    assert.equal(egress.match('104.210.139.208'), null, 'the address after the /28 is a visitor');
});

test('a mapped IPv6 address is folded to IPv4 before matching', () => {
    assert.equal(egress.match('::ffff:' + ANTHROPIC_FIRST), 'anthropic', '::ffff: mapped IPv4 matches the range');
    assert.equal(egress.match('::ffff:160.79.103.255'), null, 'and stays outside it');
    assert.equal(egress.match('::ffff:100.31.168.162'), 'openai', 'mapped OpenAI addresses match too');
    // An IPv6 address that is NOT a mapped IPv4 has no entry in either list.
    assert.equal(egress.match('2600:1f13:6cd:ee00:0:0:0:0'), null, 'plain IPv6 outside the lists reads as a visitor');
    assert.equal(egress.match('not-an-ip'), null, 'garbage never matches');
    assert.equal(egress.match(''), null);
});

test('AI_PLATFORM_EGRESS_POOL=false switches the shared pool off entirely', () => {
    const prior = process.env.AI_PLATFORM_EGRESS_POOL;
    process.env.AI_PLATFORM_EGRESS_POOL = 'false';
    try {
        assert.equal(egress.match(ANTHROPIC_FIRST), null, 'the kill switch answers null even inside the range');
        assert.equal(egress.match('100.31.168.162'), null, 'OpenAI addresses too');
    } finally {
        if (prior === undefined) delete process.env.AI_PLATFORM_EGRESS_POOL;
        else process.env.AI_PLATFORM_EGRESS_POOL = prior;
    }
    assert.equal(egress.match(ANTHROPIC_FIRST), 'anthropic', 'and matching returns once the switch is cleared');
});