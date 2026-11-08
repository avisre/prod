'use strict';

// A CSV re-import replaces an account's trades. It used to delete first and
// insert second, so any failed insert (a bad row, or Atlas refusing writes as
// it did on 2026-11-08) left the account with no history at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const wash = require('../wash-sale');

const CSV_A = 'date,symbol,action,quantity,price\n2026-01-05,AAPL,buy,10,150\n2026-02-05,AAPL,sell,10,140\n';
const CSV_B = 'date,symbol,action,quantity,price\n2026-03-05,MSFT,buy,5,400\n';

test('a re-import that cannot be stored leaves the previous trades in place', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create({ instance: { args: ['--setParameter', 'enableTestCommands=1'] } });
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });
    const user = new mongoose.Types.ObjectId();

    const first = await wash.importCsv(user, { account: 'Fidelity', accountType: 'taxable', csv: CSV_A });
    assert.equal(first.imported, 2);

    await mongoose.connection.db.admin().command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['insert'], errorCode: 8000 } });
    await assert.rejects(() => wash.importCsv(user, { account: 'Fidelity', accountType: 'taxable', csv: CSV_B }));
    const kept = await wash.Trade.find({ user, account: 'Fidelity' }).lean();
    assert.deepEqual(kept.map((r) => r.symbol).sort(), ['AAPL', 'AAPL'], 'the old history survives the failed re-import');

    const second = await wash.importCsv(user, { account: 'Fidelity', accountType: 'taxable', csv: CSV_B });
    assert.equal(second.imported, 1);
    const now = await wash.Trade.find({ user, account: 'Fidelity' }).lean();
    assert.deepEqual(now.map((r) => r.symbol), ['MSFT'], 'a successful re-import still replaces the account wholesale');

    await wash.importCsv(user, { account: 'Vanguard IRA', accountType: 'ira', csv: CSV_A });
    await wash.importCsv(user, { account: 'Fidelity', accountType: 'taxable', csv: CSV_A });
    assert.equal(await wash.Trade.countDocuments({ user, account: 'Vanguard IRA' }), 2, 'other accounts are untouched by a re-import');
});
