const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const aiChat = require('../ai-chat');

test('ever-used review signal is not limited to the current quota month', async (t) => {
  const originalCollection = mongoose.connection.collection;
  const queries = [];
  mongoose.connection.collection = (name) => ({
    findOne: async (query) => {
      queries.push({ name, query });
      return query.userId === 'used-before' ? { _id: 'usage-record' } : null;
    }
  });
  t.after(() => { mongoose.connection.collection = originalCollection; });

  assert.equal(await aiChat.hasEverUsed('used-before'), true);
  assert.equal(await aiChat.hasEverUsed('never-used'), false);
  assert.deepEqual(queries[0], {
    name: 'ai_chat_usage',
    query: { userId: 'used-before', count: { $gt: 0 } }
  });
});
