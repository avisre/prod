const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tracker = require('../ollama-usage-tracker');

test('provider detection distinguishes Ollama from fallback providers', () => {
  assert.equal(tracker.providerFor('https://ollama.com/v1'), 'ollama');
  assert.equal(tracker.providerFor('https://openrouter.ai/api/v1'), 'other');
});

test('authenticated request context is attached without recording prompt content', async () => {
  let call;
  await new Promise((resolve) => tracker.runRequest({ method: 'POST', path: '/api/ai/chat' }, () => {
    tracker.setActor({ userId: 'user-123', email: 'customer@example.com' });
    call = tracker.start({ baseUrl: 'https://ollama.com/v1', model: 'glm-5.1', purpose: 'chat' });
    tracker.finish(call, { status: 'completed', usage: { total_tokens: 42 } });
    resolve();
  }));
  assert.equal(call.email, 'customer@example.com');
  assert.equal(call.userId, 'user-123');
  assert.equal(call.route, 'POST /api/ai/chat');
  assert.equal(call.totalTokens, 42);
  assert.equal(Object.prototype.hasOwnProperty.call(call, 'prompt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(call, 'messages'), false);
  const data = await tracker.snapshot({ sinceMs: 60_000, limit: 20 });
  assert.ok(data.recent.some((event) => event.callId === call.callId && event.email === 'customer@example.com'));
});

test('calls outside a request are labelled background instead of a customer', () => {
  const call = tracker.start({ baseUrl: 'https://ollama.com/v1', model: 'glm-5.1', purpose: 'dossier' });
  assert.equal(call.actorType, 'background');
  assert.equal(call.userId, null);
  assert.equal(call.email, null);
  tracker.finish(call, { status: 'error', error: new Error('provider timeout') });
  assert.equal(call.errorCode, 'timeout');
});

test('Ollama dashboard page and data endpoints require login plus the rin allowlist', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /email !== 'rin@gmail\.com'/);
  assert.match(source, /app\.get\('\/admin\/ollama', authMiddleware, marketingDashboardOnly/);
  assert.match(source, /app\.get\('\/api\/admin\/ollama\/usage', authMiddleware, marketingDashboardOnly/);
  assert.match(source, /app\.get\('\/api\/admin\/ollama\/usage\/stream', authMiddleware, marketingDashboardOnly/);
});
