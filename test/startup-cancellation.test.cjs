const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { RegistrationAssistant } = require('../automation/registration.cjs');
const { generateProfile } = require('../random.js');

for (const phase of ['balance', 'launch']) {
  test(`Stop during registration ${phase} cancels promptly and closes a late browser`, { timeout: 2000 }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-startup-cancel-'));
    let finishLaunch, launched = false, closed = false, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const current = new RegistrationAssistant({ directory, cleanupTimeoutMs: 20,
      maskifyEnv: { MASKIFY_USERNAME: 'test-user', MASKIFY_PASSWORD: 'test-password' },
      solverFactory: () => ({ checkAccount: async () => {
        if (phase === 'balance') { entered(); await new Promise(() => {}); }
      }, closeProxy: async () => {} }),
      launch: async () => { launched = true; entered(); return new Promise(resolve => { finishLaunch = resolve; }); },
    });
    current.printLog = () => {};
    current.saveFailureImage = async () => null;
    t.after(async () => { await current.close(); await rm(directory, { recursive: true, force: true }); });
    const controller = new AbortController();
    const started = current.start(generateProfile(), { mode: 'maskify', signal: controller.signal });
    const cancelled = assert.rejects(started);
    await reached;
    controller.abort();
    await cancelled;
    assert.equal(current.starting, false);
    assert.equal(current.state.status, 'cancelled');
    if (phase === 'balance') assert.equal(launched, false);
    else {
      finishLaunch({ close: async () => { closed = true; } });
      await nextTurn();
      assert.equal(closed, true);
      assert.equal(current.browser, null);
    }
  });
}

test('a registration cleanup timeout kills its owned browser and releases the store lock', { timeout: 2000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-cleanup-force-'));
  const current = new RegistrationAssistant({ directory, cleanupTimeoutMs: 10 });
  const kills = [];
  const child = { exitCode: null, killed: false, kill: signal => { kills.push(signal); child.killed = true; } };
  current.state = { status: 'complete' };
  current.browser = { connected: true, process: () => child, close: () => new Promise(() => {}) };
  t.after(async () => { await current.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(current.closeBrowser(), { code: 'CLEANUP_TIMEOUT' });
  assert.deepEqual(kills, ['SIGKILL']);
  assert.equal(current.browser, null);
  await current.close();
  const next = new RegistrationAssistant({ directory });
  await next.close();
});
