const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { RegistrationAssistant, RegistrationStore } = require('../automation/registration.cjs');

test('a second instance is rejected without altering the running instance or its phone lease', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-instance-test-'));
  const first = new RegistrationAssistant({ directory, purchasePhone: async () => ({ phoneNumber: '+4915123450001', activationId: 'first' }) });
  t.after(async () => { await first.close(); await rm(directory, { recursive: true, force: true }); });
  await first.phonePool.acquire('active-account');
  const before = first.phonePool.snapshot();
  assert.throws(() => new RegistrationAssistant({ directory }), { code: 'APP_ALREADY_RUNNING' });
  assert.deepEqual(first.phonePool.snapshot(), before);
  assert.equal(first.phonePool.assertActive('active-account').uses, 1);
});

test('closing a store releases its instance lock', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-lock-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new RegistrationStore(directory);
  first.close();
  const next = new RegistrationStore(directory);
  next.close();
});

test('the OS releases the instance lock after a process crashes', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-lock-crash-'));
  const source = `const { acquireInstanceLock } = require(${JSON.stringify(path.resolve(__dirname, '../instance-lock.cjs'))}); acquireInstanceLock(process.argv[1]); process.stdout.write('locked'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', source, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode == null && !child.killed) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  assert.throws(() => new RegistrationStore(directory), { code: 'APP_ALREADY_RUNNING' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const recovered = new RegistrationStore(directory);
  recovered.close();
});
