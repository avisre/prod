'use strict';

// api-keys.js — the identity bridge between an external API/MCP caller and
// a website account's credit_ledger wallet. Real Mongo (in-memory), same
// pattern as test/credits.test.js: the point of these tests is the actual
// hash/lookup/revoke behavior, which a hand-rolled fake would risk getting
// subtly wrong.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const apiKeys = require('../api-keys');

test('api keys: create, resolve, revoke, and per-user isolation', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const created = await apiKeys.createKey('user-1', 'CI key');
    assert.ok(created.rawKey.startsWith('sp_live_'), 'raw key carries the public prefix');
    assert.equal(created.label, 'CI key');
    assert.equal(created.keyPrefix, created.rawKey.slice(0, created.keyPrefix.length));

    // The raw key resolves to its owner...
    const resolved = await apiKeys.resolveKey(created.rawKey);
    assert.ok(resolved, 'a fresh key resolves');
    assert.equal(resolved.userId, 'user-1');

    // ...but an unknown key, a garbled key, and an empty key all resolve to
    // null (fail closed) rather than throwing or silently matching anything.
    assert.equal(await apiKeys.resolveKey('sp_live_' + 'f'.repeat(48)), null);
    assert.equal(await apiKeys.resolveKey('not-even-the-right-prefix'), null);
    assert.equal(await apiKeys.resolveKey(''), null);
    assert.equal(await apiKeys.resolveKey(undefined), null);

    // Default label when none is given.
    const unlabeled = await apiKeys.createKey('user-1', '');
    assert.equal(unlabeled.label, 'Default key');

    // listKeys never exposes the hash, and is scoped per user.
    const listed = await apiKeys.listKeys('user-1');
    assert.equal(listed.length, 2);
    assert.ok(listed.every((k) => !('keyHash' in k)));
    assert.equal((await apiKeys.listKeys('user-2')).length, 0, "user-2 sees none of user-1's keys");

    // Revoking a key immediately stops it resolving, and can't be done by
    // another user.
    const other = await apiKeys.createKey('user-2', 'other');
    assert.equal(await apiKeys.revokeKey('user-1', (await apiKeys.listKeys('user-2'))[0].id), false, "user-1 can't revoke user-2's key");
    assert.ok(await apiKeys.resolveKey(other.rawKey), "user-2's key still resolves — the cross-user revoke did nothing");

    const createdRow = (await apiKeys.listKeys('user-1')).find((k) => k.keyPrefix === created.keyPrefix);
    assert.ok(createdRow, 'the row for `created` is findable by its prefix');
    assert.equal(await apiKeys.revokeKey('user-1', createdRow.id), true);
    assert.equal(await apiKeys.resolveKey(created.rawKey), null, 'a revoked key no longer resolves');
    // Revoking the same key twice is a no-op, not an error.
    assert.equal(await apiKeys.revokeKey('user-1', createdRow.id), false);
    // The unlabeled key (still active) is unaffected by revoking `created`.
    assert.ok(await apiKeys.resolveKey(unlabeled.rawKey), "revoking one key doesn't touch another");
});
