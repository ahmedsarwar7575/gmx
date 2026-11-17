const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { abortable, withDeadline, closeOwnedBrowser } = require('../async-control.cjs');

test('aborted work rejects promptly and reconciles a late result once', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let complete, late = [];
  const work = abortable(() => new Promise(resolve => { complete = resolve; }), {
    signal: controller.signal, onLateResult: result => { late.push(result); },
  });
  await nextTurn();
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  complete('late purchase');
  await nextTurn();
  assert.deepEqual(late, ['late purchase']);
});

test('already cancelled work never starts', async () => {
  const controller = new AbortController(); controller.abort();
  let started = false;
  assert.throws(() => abortable(() => { started = true; }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(started, false);
});

test('cleanup deadlines reject hung operations and kill only the owned browser process', { timeout: 2000 }, async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), 10), { code: 'CLEANUP_TIMEOUT' });
  const signals = [];
  const browser = { close: () => new Promise(() => {}), process: () => ({ exitCode: null, killed: false, kill: signal => signals.push(signal) }) };
  await assert.rejects(closeOwnedBrowser(browser, 10), { code: 'CLEANUP_TIMEOUT' });
  assert.deepEqual(signals, ['SIGKILL']);
});
