const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { createHeroSmsClient } = require('../herosms-client.cjs');

test('cancelling an SMS purchase aborts the HTTP request without retrying it', { timeout: 2000 }, async t => {
  const previous = process.env.HEROSMS_API_KEY;
  process.env.HEROSMS_API_KEY = 'test-only-key';
  t.after(() => { if (previous === undefined) delete process.env.HEROSMS_API_KEY; else process.env.HEROSMS_API_KEY = previous; });
  let calls = 0, transportSignal;
  const client = createHeroSmsClient({ log() {}, requestImpl: (url, { signal }) => {
    calls++; transportSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const purchase = client('getNumberV2', {}, { signal: controller.signal });
  await nextTurn(); controller.abort();
  await assert.rejects(purchase, { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(transportSignal.aborted, true);
});
