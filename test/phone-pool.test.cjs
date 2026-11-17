const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { RegistrationStore, RegistrationAssistant } = require('../automation/registration.cjs');
const { PhoneNumberPool, PHONE_TTL_MS } = require('../automation/phone-pool.cjs');

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-phone-pool-'));
  const store = new RegistrationStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let time = Date.now(), bought = 0;
  const resets = [];
  const purchasePhone = async () => ({ phoneNumber: `+491512345${String(++bought).padStart(4, '0')}`,
    activationId: `activation-${bought}`, ...options.number });
  const pool = new PhoneNumberPool({ store, purchasePhone, now: () => time,
    requestNextSms: options.requestNextSms || (async id => { resets.push(id); }),
    checkProvider: async () => {}, ...options.poolOptions });
  return { store, pool, directory, purchasePhone, resets, purchases: () => bought, advance: ms => { time += ms; } };
}

test('one number supports exactly three sequential accounts, then a fresh number is bought', async t => {
  const { pool, store, resets, purchases } = await setup(t);
  const leases = [];
  for (const id of ['account-1', 'account-2', 'account-3']) {
    const lease = await pool.acquire(id);
    leases.push(lease);
    store.reservePhone({ phone: lease.number.phoneNumber, country: 'Germany' }, id);
    pool.finish(id);
  }
  assert.equal(new Set(leases.map(lease => lease.number.phoneNumber)).size, 1);
  assert.deepEqual(leases.map(lease => lease.uses), [1, 2, 3]);
  assert.deepEqual(resets, ['activation-1', 'activation-1']);
  const fourth = await pool.acquire('account-4');
  assert.equal(purchases(), 2);
  assert.notEqual(fourth.number.phoneNumber, leases[0].number.phoneNumber);
  assert.equal(fourth.uses, 1);
  assert.equal(pool.snapshot().find(number => number.id === leases[0].fingerprint).uses, 3);
});

test('parallel registrations cannot hold the same number or activation', async t => {
  const { pool, purchases } = await setup(t);
  const [first, second] = await Promise.all([pool.acquire('one'), pool.acquire('two')]);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(purchases(), 2);
  pool.finish('one');
  const third = await pool.acquire('three');
  assert.equal(third.fingerprint, first.fingerprint);
  assert.equal(third.uses, 2);
  assert.equal(pool.assertActive('two').uses, 1);
});

test('a failure retires a number at 3/3 and it is never leased again', async t => {
  const { pool } = await setup(t);
  const first = await pool.acquire('one');
  pool.retire('one', 'registration exception');
  const second = await pool.acquire('two');
  assert.notEqual(second.fingerprint, first.fingerprint);
  const retired = pool.snapshot().find(number => number.id === first.fingerprint);
  assert.equal(retired.uses, 3);
  assert.equal(retired.status, 'registration exception');
});

test('expiry uses the original purchase time and is never extended on reuse', async t => {
  const { pool, advance } = await setup(t);
  const first = await pool.acquire('one');
  pool.finish('one');
  advance(17 * 60_000);
  const second = await pool.acquire('two');
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.expiresAt, first.expiresAt);
  advance(3 * 60_000);
  assert.throws(() => pool.assertActive('two'), { code: 'PHONE_EXPIRED' });
  const third = await pool.acquire('three');
  assert.notEqual(third.fingerprint, first.fingerprint);
  assert.equal(pool.snapshot().find(number => number.id === first.fingerprint).uses, 3);
});

test('provider expiry shortens the twenty-minute window', async t => {
  const end = Date.now() + 3 * 60_000;
  const { pool } = await setup(t, { number: { activationEndTime: end } });
  const lease = await pool.acquire('one');
  assert.equal(lease.expiresAt, end);
  assert.ok(lease.expiresAt < Date.now() + PHONE_TTL_MS);
});

test('a failed SMS reset burns the old number and acquires a new one', async t => {
  const { pool, purchases } = await setup(t, { requestNextSms: async () => { throw new Error('Provider rejected reset'); } });
  const first = await pool.acquire('one');
  pool.finish('one');
  const second = await pool.acquire('two');
  assert.equal(purchases(), 2);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(pool.snapshot().find(number => number.id === first.fingerprint).status, 'SMS reset failed');
});

test('saved code hashes prevent an earlier SMS code being submitted to another account', async t => {
  const { pool, directory } = await setup(t);
  const first = await pool.acquire('one');
  pool.rememberCode('one', '918273');
  pool.finish('one');
  await pool.acquire('two');
  assert.equal(pool.isPreviousCode('two', '918273'), true);
  assert.equal(pool.isPreviousCode('two', '564738'), false);
  const database = await readFile(path.join(directory, 'registrations.sqlite'));
  assert.equal(database.includes(Buffer.from(first.number.phoneNumber)), false);
  assert.equal(database.includes(Buffer.from(first.number.activationId)), false);
  assert.equal(database.includes(Buffer.from('918273')), false);
  assert.equal(JSON.stringify(pool.snapshot()).includes(first.number.phoneNumber), false);
});

test('restart retires numbers that were in use and preserves eligible idle numbers', async t => {
  const { store, pool, purchasePhone } = await setup(t);
  const active = await pool.acquire('active');
  const idle = await pool.acquire('idle');
  pool.finish('idle');
  store.markInterrupted();
  const restarted = new PhoneNumberPool({ store, purchasePhone, requestNextSms: async () => {} });
  const next = await restarted.acquire('next');
  assert.equal(next.fingerprint, idle.fingerprint);
  assert.equal(restarted.snapshot().find(number => number.id === active.fingerprint).uses, 3);
});

test('malformed activation metadata retires the known phone rather than returning it to the pool', async t => {
  const { pool } = await setup(t, { number: { activationId: 'invalid activation!' } });
  await assert.rejects(pool.acquire('one'), { code: 'PHONE_ACTIVATION_INVALID' });
  assert.equal(pool.snapshot()[0].uses, 3);
  assert.equal(pool.snapshot()[0].status, 'invalid activation');
});

test('registration workers share the pool; attention failures retire their number', async t => {
  const { store, pool, purchasePhone } = await setup(t);
  const root = new RegistrationAssistant({ store, phonePool: pool, purchasePhone });
  const worker = () => {
    const current = root.createWorker();
    current.activeId = store.create({ country: 'Germany', password: 'test-password' });
    Object.assign(current, { state: { id: current.activeId, status: 'running', phase: 'phone' }, stopped: false,
      redactions: new Set(), smsController: new AbortController(), phonePurchaseStatus: 'idle',
      printLog() {}, watch() {} });
    return current;
  };
  const first = worker();
  await first.acquirePhone();
  const phone = store.get(first.activeId).phone;
  first.setState('complete', 'Created');
  const second = worker();
  await second.acquirePhone();
  assert.equal(store.get(second.activeId).phone, phone);
  assert.equal(second.state.phoneUsage, 2);
  second.setState('needs_attention', 'GMX rejected the form');
  assert.equal(second.state.phoneUsage, 3);
  const third = worker();
  await third.acquirePhone();
  assert.notEqual(store.get(third.activeId).phone, phone);
});

test('SMS polling ignores a previous code, accepts a fresh one, and retires on a read exception', async t => {
  const { store, pool, purchasePhone } = await setup(t);
  const root = new RegistrationAssistant({ store, phonePool: pool, purchasePhone });
  const makeWorker = () => {
    const current = root.createWorker();
    current.activeId = store.create({ country: 'Germany', password: 'test-password' });
    Object.assign(current, { state: { id: current.activeId, status: 'running', phase: 'phone' }, stopped: false,
      redactions: new Set(), smsController: new AbortController(), phonePurchaseStatus: 'idle',
      browser: { connected: true }, printLog() {}, watch() {} });
    return current;
  };
  const first = makeWorker();
  await first.acquirePhone();
  pool.rememberCode(first.activeId, '112233');
  first.setState('complete', 'Created');
  const second = makeWorker();
  await second.acquirePhone();
  second.smsClient = async () => ({ status: 'RECEIVED', otp: '112233' });
  await second.pollSms();
  assert.equal(second.pendingCode, undefined);
  assert.equal(second.smsPoll.finished, false);
  second.smsClient = async () => ({ status: 'RECEIVED', otp: '445566' });
  second.smsPoll.nextAt = 0;
  await second.pollSms();
  assert.equal(second.pendingCode, '445566');
  assert.equal(pool.isPreviousCode(second.activeId, '445566'), true);
  second.setState('complete', 'Created');
  const third = makeWorker();
  await third.acquirePhone();
  third.smsClient = async () => { throw Object.assign(new Error('SMS connection failed'), { code: 'HTTP_503' }); };
  await third.pollSms();
  assert.equal(third.state.status, 'failed');
  assert.equal(third.state.failureCode, 'HTTP_503');
  assert.equal(pool.providerStatus().paused, true);
  assert.equal(third.state.phoneUsage, 3);
  assert.equal(pool.snapshot().find(number => number.id === third.phoneLease.fingerprint).uses, 3);
});

test('an expired active number fails its registration before another SMS request', async t => {
  const { store, pool, purchasePhone, advance } = await setup(t);
  let requested = false;
  const current = new RegistrationAssistant({ store, phonePool: pool, purchasePhone,
    smsClient: async () => { requested = true; } });
  current.activeId = store.create({ country: 'Germany', password: 'test-password' });
  Object.assign(current, { state: { id: current.activeId, status: 'running', phase: 'phone' }, stopped: false,
    redactions: new Set(), smsController: new AbortController(), phonePurchaseStatus: 'idle', printLog() {} });
  await current.acquirePhone();
  advance(PHONE_TTL_MS);
  await current.pollSms();
  assert.equal(requested, false);
  assert.equal(current.state.status, 'failed');
  assert.equal(current.state.failureCode, 'PHONE_EXPIRED');
  assert.equal(current.state.phoneUsage, 3);
});

test('purchase latency does not add time to the twenty-minute window', async t => {
  const { pool, advance } = await setup(t);
  const before = pool.now();
  const buy = pool.purchasePhone;
  pool.purchasePhone = async () => { advance(2 * 60_000); return buy(); };
  const lease = await pool.acquire('one');
  assert.equal(lease.expiresAt, before + PHONE_TTL_MS);
});

test('provider denial of additional SMS prevents reuse even below three accounts', async t => {
  const { pool } = await setup(t, { number: { canGetAnotherSms: false } });
  const first = await pool.acquire('one');
  pool.finish('one');
  const second = await pool.acquire('two');
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(pool.snapshot().find(number => number.id === first.fingerprint).uses, 3);
});

test('near-expiry numbers are skipped before resetting or consuming another use', async t => {
  const { pool, advance, purchases, resets } = await setup(t);
  const first = await pool.acquire('one');
  pool.finish('one');
  advance(PHONE_TTL_MS - 1000);
  const second = await pool.acquire('two');
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(purchases(), 2);
  assert.deepEqual(resets, []);
  const old = pool.snapshot().find(number => number.id === first.fingerprint);
  assert.equal(old.uses, 1);
  assert.equal(old.status, 'too close to expiry');
});

test('a shared outage retires only the affected number and probes health before resuming', { timeout: 2000 }, async t => {
  const { pool, advance, purchases } = await setup(t);
  for (const id of ['one', 'two', 'three']) await pool.acquire(id);
  for (const id of ['one', 'two', 'three']) pool.finish(id);
  let resets = 0, probes = 0;
  pool.requestNextSms = async () => { if (++resets === 1) throw Object.assign(new Error('Outage'), { code: 'HTTP_503' }); };
  pool.wait = async ms => { advance(ms); };
  pool.checkProvider = async () => {
    probes++;
    assert.equal(pool.snapshot().filter(number => number.status === 'SMS reset failed').length, 1);
    assert.equal(purchases(), 3);
    if (probes === 1) throw Object.assign(new Error('Still down'), { code: 'HTTP_503' });
  };
  const recovered = await pool.acquire('four');
  assert.equal(recovered.uses, 2);
  assert.equal(probes, 2);
  assert.equal(resets, 2);
  assert.equal(purchases(), 3);
  assert.equal(pool.providerStatus().paused, false);
});

test('Stop interrupts a provider pause without allocating or retiring other numbers', { timeout: 2000 }, async t => {
  const { pool, purchases } = await setup(t);
  const one = await pool.acquire('one');
  const two = await pool.acquire('two');
  pool.finish('one'); pool.finish('two');
  pool.requestNextSms = async () => { throw Object.assign(new Error('Outage'), { code: 'NETWORK_ERROR' }); };
  const controller = new AbortController();
  const request = pool.acquire('three', { signal: controller.signal, onPause: () => controller.abort() });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(purchases(), 2);
  const rows = pool.snapshot();
  assert.equal(rows.filter(number => number.uses === 3).length, 1);
  assert.equal(rows.filter(number => number.uses === 1).length, 1);
  assert.equal(rows.length, 2);
  assert.notEqual(one.fingerprint, two.fingerprint);
});

test('Stop cancels a pending purchase and retires a number returned by an uncooperative provider later', { timeout: 2000 }, async t => {
  const { pool } = await setup(t);
  let finish, receivedSignal;
  pool.purchasePhone = ({ signal }) => { receivedSignal = signal; return new Promise(resolve => { finish = resolve; }); };
  const controller = new AbortController();
  const pending = pool.acquire('one', { signal: controller.signal });
  await nextTurn();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(receivedSignal, controller.signal);
  finish({ phoneNumber: '+4915123459999', activationId: 'late-result' });
  await nextTurn();
  assert.equal(pool.snapshot()[0].uses, 3);
  assert.equal(pool.snapshot()[0].status, 'cancelled during purchase');
  assert.throws(() => pool.assertActive('one'), { code: 'PHONE_EXPIRED' });
});

test('Stop during SMS reset does not start a replacement purchase', { timeout: 2000 }, async t => {
  const { pool, purchases } = await setup(t);
  await pool.acquire('one'); pool.finish('one');
  pool.requestNextSms = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = pool.acquire('two', { signal: controller.signal });
  await nextTurn(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(purchases(), 1);
  assert.equal(pool.snapshot()[0].uses, 3);
});

test('parallel waiters share one provider health probe after a cooldown', { timeout: 2000 }, async t => {
  const { pool, advance } = await setup(t);
  await pool.acquire('one'); await pool.acquire('two');
  pool.finish('one'); pool.finish('two');
  let probes = 0, finish;
  pool.wait = async ms => { advance(ms); };
  pool.checkProvider = () => { probes++; return new Promise(resolve => { finish = resolve; }); };
  pool.pause({ code: 'HTTP_503' });
  const first = pool.acquire('three'), second = pool.acquire('four');
  await nextTurn();
  assert.equal(probes, 1);
  finish();
  const leases = await Promise.all([first, second]);
  assert.notEqual(leases[0].fingerprint, leases[1].fingerprint);
  assert.equal(pool.providerStatus().paused, false);
});

test('a number that becomes too old during SMS reset is retired and replaced', async t => {
  const { pool, advance, purchases } = await setup(t);
  const first = await pool.acquire('one'); pool.finish('one');
  advance(17 * 60_000);
  pool.requestNextSms = async () => { advance(2 * 60_000); };
  const next = await pool.acquire('two');
  assert.notEqual(first.fingerprint, next.fingerprint);
  assert.equal(purchases(), 2);
  assert.equal(pool.snapshot().find(number => number.id === first.fingerprint).uses, 3);
});
