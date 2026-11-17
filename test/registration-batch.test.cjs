const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { RegistrationBatchRunner } = require('../automation/registration-batch.cjs');
const { RegistrationAssistant } = require('../automation/registration.cjs');

function createBatch({ outcomes = [], outcomeFor, timing = 'watch', proxyCount = 40, profile: suppliedProfile,
  closeError = false, connectionMode = 'proxy', makeProfile, directory, hangClose = false, hangStart = false,
  cleanupTimeoutMs = 100 } = {}) {
  const workers = [], events = [], records = new Map(), links = [], purchases = [], reservations = new Map();
  let active = 0, maxActive = 0, batchStatus, profilesGenerated = 0;
  const store = {
    dbPath: directory && path.join(directory, 'registrations.sqlite'),
    createBatch() {},
    linkBatchAccount(batchId, id) { links.push(id); },
    finishBatch(id, status) { batchStatus = status; },
    get(id) { return records.get(id); },
    update(id, fields) { records.set(id, { ...records.get(id), ...fields }); },
    reservePhone(details, id) {
      const phone = `${details.phoneCountryCode}${details.phone}`;
      assert.ok(!reservations.has(phone) || reservations.get(phone) === id, 'Phone numbers cannot be reused');
      reservations.set(phone, id);
    },
  };
  const assistant = {
    store,
    maskifyEnv: { MASKIFY_USERNAME: 'test-user', MASKIFY_PASSWORD: 'test-secret' },
    createWorker({ logLabel }) {
      const sequence = workers.length + 1;
      const [, account, attempt] = /Account (\d+) Attempt (\d+)/.exec(logLabel);
      const index = Number(account), attemptNumber = Number(attempt);
      const outcome = outcomeFor?.(index, attemptNumber) || outcomes[sequence - 1] || { status: 'complete', stage: 'Account created' };
      const worker = new EventEmitter();
      workers.push(worker);
      Object.assign(worker, { index, attempt: attemptNumber, activeId: `registration-${sequence}`, store,
        redactions: new Set(), stopped: false, smsController: new AbortController(), addLog() {},
        purchasePhone: async () => {
          const number = { phoneNumber: `+491512345${String(sequence).padStart(4, '0')}`, activationId: `activation-${sequence}` };
          purchases.push(number);
          return number;
        } });
      worker.browser = { connected: false };
      worker.snapshot = () => ({ active: { ...worker.state, browserOpen: worker.browser.connected } });
      worker.safeError = error => typeof error === 'string' ? error : error.message;
      worker.setState = (status, stage) => {
        worker.state = { ...worker.state, status, stage };
        store.update(worker.activeId, worker.state);
        worker.emit('state', worker.snapshot());
      };
      worker.recordFailure = (code, reason, { phase, status }) => {
        worker.state = { ...worker.state, failureCode: code, failurePhase: phase };
        worker.setState(status, reason);
      };
      worker.start = async (profile, options) => {
        worker.profile = structuredClone(profile);
        worker.connectionMode = options.mode;
        worker.startSignal = options.signal;
        worker.proxyText = options.proxyText;
        active++; maxActive = Math.max(maxActive, active);
        events.push(`start:${sequence}`);
        worker.activeAtStart = active;
        worker.browser.connected = true;
        store.update(worker.activeId, { ...profile, country: 'Germany', candidateEmail: `account${index}@gmx.de` });
        worker.state = { id: worker.activeId, phase: 'phone' };
        worker.phonePurchaseStatus = profile.phone ? 'provided' : 'idle';
        worker.phoneApproved = !!profile.phone;
        worker.setState('running', 'Registering');
        if (hangStart) await new Promise(() => {});
        if (!worker.stopped) await RegistrationAssistant.prototype.acquirePhone.call(worker);
        const finish = () => {
          if (worker.stopped) return;
          worker.state = { ...worker.state, ...outcome };
          worker.setState(outcome.status, outcome.stage);
        };
        if (timing === 'startup') finish();
        else worker.timer = setImmediate(finish);
        return worker.snapshot();
      };
      worker.closeBrowser = () => {
        worker.stopped = true;
        worker.closing ||= (async () => {
          clearImmediate(worker.timer);
          await nextTurn();
          if (worker.state.status !== 'complete') {
            worker.state.failureImageUrl = `/api/registration/${worker.activeId}/failure-image`;
            worker.state.failureArtifactKind = 'screenshot';
          }
          worker.browser.connected = false;
          active--;
          events.push(`close:${sequence}`);
        })();
        return worker.closing;
      };
      worker.close = async () => {
        if (hangClose) await new Promise(() => {});
        await worker.closeBrowser();
        if (closeError) throw new Error('Simulated cleanup failure');
      };
      worker.forceClose = () => {
        worker.forced = true; worker.stopped = true; clearImmediate(worker.timer);
        if (worker.browser.connected) { worker.browser.connected = false; active--; events.push(`close:${sequence}`); }
      };
      return worker;
    },
  };
  const runner = new RegistrationBatchRunner({ assistant, makeProfile: makeProfile || (async () => {
    profilesGenerated++;
    return { firstName: `Profile${profilesGenerated}`, password: 'test-password', ...suppliedProfile };
  }), timeoutMs: 250, cleanupTimeoutMs });
  const start = () => runner.start({ connectionMode, accountCount: 10, concurrency: 2,
    ...(connectionMode === 'proxy' ? { proxyText: Array.from({ length: proxyCount }, (_, index) => `http://127.0.0.1:${21000 + index}`).join('\n') } : {}) });
  return { runner, start, workers, events, records, links, purchases,
    stats: () => ({ active, maxActive, batchStatus }), profilesGenerated: () => profilesGenerated };
}

for (const timing of ['startup', 'watch']) {
  for (const status of ['help', 'needs_attention']) {
    test(`${status} during ${timing} releases workers, finishes the initial batch, then retries`, { timeout: 2000 }, async () => {
      const outcome = status === 'help'
        ? { status: 'failed', stage: 'GMX redirected to registration help', failureCode: 'GMX_REGISTRATION_HELP', failurePhase: 'phone' }
        : { status: 'needs_attention', stage: 'GMX has not advanced; review Chrome and retry' };
      const { runner, start, workers, events, records, stats } = createBatch({ timing, outcomes: [outcome, outcome] });
      start();
      await runner.done;

      assert.equal(workers.length, 12);
      assert.deepEqual(stats(), { active: 0, maxActive: 2, batchStatus: 'complete' });
      assert.equal(runner.run.active, false);
      assert.equal(runner.workers.size, 0);
      assert.deepEqual(runner.run.jobs.map(job => job.status), Array(10).fill('success'));
      assert.ok(runner.run.jobs.every(job => job.startedAt && job.finishedAt));
      assert.ok(events.indexOf('close:1') < events.indexOf('start:3'));
      for (const job of runner.run.jobs.slice(0, 2)) {
        const first = job.attempts[0];
        assert.equal(first.failureCode, status === 'help' ? 'GMX_REGISTRATION_HELP' : 'REGISTRATION_FAILED');
        assert.equal(first.failurePhase, 'phone');
        assert.equal(first.stage, outcome.stage);
        assert.equal(first.status, 'failed');
        assert.equal(first.screenshotUrl, `/api/registration/${first.registrationId}/failure-image`);
        assert.equal(records.get(first.registrationId).status, 'failed');
        assert.equal(job.attempt, 2);
        assert.equal(job.failureCode, null);
        assert.equal(job.attempts[1].status, 'success');
      }
      assert.ok(workers.every(worker => !worker.browser.connected && worker.listenerCount('state') === 0));
    });
  }
}

test('Stop still cancels active and queued registrations and keeps confirmed successes', { timeout: 2000 }, async () => {
  const { runner, start, workers, stats } = createBatch({ outcomes: [
    { status: 'complete', stage: 'Account created' },
    { status: 'running', stage: 'Waiting for GMX' },
  ] });
  let stopped = false;
  runner.on('state', ({ run }) => {
    if (!stopped && run.jobs.some(job => job.status === 'success')) {
      stopped = true;
      runner.stop();
    }
  });
  start();
  await runner.done;

  assert.equal(stopped, true);
  assert.equal(workers.length, 2);
  assert.deepEqual(runner.run.jobs.map(job => job.status), ['success', ...Array(9).fill('cancelled')]);
  assert.equal(stats().active, 0);
  assert.equal(stats().batchStatus, 'stopped');
  assert.ok(workers.every(worker => !worker.browser.connected));
});

const failure = { status: 'failed', stage: 'GMX redirected to registration help', failureCode: 'GMX_REGISTRATION_HELP', failurePhase: 'phone' };
const success = { status: 'complete', stage: 'Account created' };

test('accounts 3 and 7 retry after all initial browsers close; recovered accounts leave later rounds', { timeout: 2000 }, async () => {
  const { runner, start, workers, events, links, profilesGenerated } = createBatch({
    outcomeFor: (index, attempt) => (index === 3 && attempt === 1 || index === 7 && attempt < 4) ? failure : success,
  });
  start();
  await runner.done;

  assert.deepEqual(workers.map(worker => worker.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 3, 7, 7, 7]);
  assert.ok(Array.from({ length: 10 }, (_, i) => events.indexOf(`close:${i + 1}`)).every(index => index < events.indexOf('start:11')));
  assert.ok(workers.slice(10).every(worker => worker.activeAtStart === 1));
  assert.deepEqual(runner.run.jobs.map(job => job.status), Array(10).fill('success'));
  assert.equal(runner.run.jobs.length, 10);
  assert.equal(runner.run.jobs[2].attempt, 2);
  assert.equal(runner.run.jobs[6].attempt, 4);
  assert.equal(runner.run.retryRound, 3);
  assert.equal(profilesGenerated(), 10);
  assert.equal(workers[10].profile.firstName, workers[2].profile.firstName);
  assert.equal(workers[10].profile.password, workers[2].profile.password);
  assert.equal(workers[10].profile.email, 'account3@gmx.de');
  assert.equal(new Set(links).size, workers.length, 'Every attempt must link its new registration to the batch export');
  assert.equal(new Set(workers.map(worker => worker.proxyText)).size, workers.length);
  assert.equal(JSON.stringify(runner.snapshot()).includes('test-password'), false);
});

test('permanent failures receive exactly 3 retries, in account order in every round', { timeout: 2000 }, async () => {
  const { runner, start, workers, records } = createBatch({ outcomeFor: index => [3, 7].includes(index) ? failure : success });
  start();
  await runner.done;

  assert.deepEqual(workers.slice(10).map(worker => worker.index), [3, 7, 3, 7, 3, 7]);
  assert.equal(workers.length, 16);
  assert.equal(runner.run.jobs.filter(job => job.status === 'success').length, 8);
  for (const job of [runner.run.jobs[2], runner.run.jobs[6]]) {
    assert.equal(job.status, 'failed');
    assert.equal(job.attempt, 4);
    assert.equal(job.attempts.length, 4);
    assert.equal(new Set(job.attempts.map(attempt => attempt.id)).size, 4);
    assert.equal(new Set(job.attempts.map(attempt => attempt.registrationId)).size, 4);
    assert.ok(job.attempts.every(attempt => attempt.status === 'failed' && records.get(attempt.registrationId).status === 'failed'));
  }
  assert.ok(workers.every(worker => !worker.browser.connected));
});

test('retries clear old phone and activation fields and purchase fresh numbers through acquirePhone', { timeout: 2000 }, async () => {
  const oldPhone = '+4915123450000';
  const { runner, start, workers, purchases, records } = createBatch({
    profile: { phone: oldPhone, countryCode: '+49', phoneCountryCode: '+49', heroSMS: { activationId: 'old-activation' } },
    outcomeFor: (index, attempt) => [3, 7].includes(index) && attempt === 1 ? failure : success,
  });
  start();
  await runner.done;

  assert.equal(purchases.length, 2);
  assert.equal(new Set(purchases.map(number => number.phoneNumber)).size, 2);
  assert.ok(purchases.every(number => number.phoneNumber !== oldPhone));
  for (const worker of workers.slice(10)) {
    for (const field of ['phone', 'countryCode', 'phoneCountryCode', 'heroSMS']) assert.equal(worker.profile[field], undefined);
    assert.equal(worker.phonePurchaseStatus, 'purchased');
    assert.equal(records.get(worker.activeId).heroSMS.activationId, `activation-${workers.indexOf(worker) + 1}`);
    assert.equal(worker.smsPoll.activationId, records.get(worker.activeId).heroSMS.activationId);
  }
});

test('no spare proxy skips retries without reusing a consumed proxy or buying another phone', { timeout: 2000 }, async () => {
  const { runner, start, workers, purchases } = createBatch({ proxyCount: 10,
    outcomeFor: index => [3, 7].includes(index) ? failure : success });
  start();
  await runner.done;

  assert.equal(workers.length, 10);
  assert.equal(purchases.length, 10);
  assert.match(runner.run.error, /extra unused proxies/);
  for (const job of [runner.run.jobs[2], runner.run.jobs[6]]) {
    assert.equal(job.status, 'failed');
    assert.equal(job.attempt, 1);
    assert.match(job.retrySkipped, /No unused uploaded proxy/);
  }
});

test('Stop during a retry closes it, preserves successes, and prevents pending retry rounds', { timeout: 2000 }, async () => {
  const { runner, start, workers, stats } = createBatch({ outcomeFor: index => [3, 7].includes(index) ? failure : success });
  let stopped = false;
  runner.on('state', ({ run }) => {
    if (!stopped && run.retryRound && run.jobs[2].session?.status === 'running') {
      stopped = true;
      runner.stop();
    }
  });
  start();
  await runner.done;

  assert.equal(stopped, true);
  assert.equal(workers.length, 11);
  assert.equal(runner.run.jobs[2].status, 'cancelled');
  assert.equal(runner.run.jobs[6].status, 'failed');
  assert.equal(runner.run.jobs[6].attempt, 1);
  assert.equal(runner.run.jobs.filter(job => job.status === 'success').length, 8);
  assert.equal(stats().batchStatus, 'stopped');
  assert.ok(workers.every(worker => !worker.browser.connected));
});

test('confirmed successes are never retried even if browser cleanup reports an error', { timeout: 2000 }, async () => {
  const { runner, start, workers } = createBatch({ closeError: true });
  start();
  await runner.done;

  assert.equal(workers.length, 10);
  assert.ok(runner.run.jobs.every(job => job.status === 'success' && job.attempt === 1 && job.cleanupError));
  assert.equal(runner.run.retryRound, 0);
});

test('Maskify failures retry without requiring an uploaded proxy pool', { timeout: 2000 }, async () => {
  const { runner, start, workers } = createBatch({ connectionMode: 'maskify',
    outcomeFor: (index, attempt) => [3, 7].includes(index) && attempt === 1
      ? { status: 'failed', stage: 'Proxy exit IP was already used', failureCode: 'IP_REUSED', failurePhase: 'proxy_check' } : success });
  start();
  await runner.done;

  assert.deepEqual(workers.slice(10).map(worker => worker.index), [3, 7]);
  assert.ok(workers.every(worker => worker.connectionMode === 'maskify' && worker.proxyText === undefined));
  assert.ok(runner.run.jobs.every(job => job.status === 'success'));
  assert.equal(runner.run.error, undefined);
  assert.equal(runner.run.jobs[2].attempts[0].failureCode, 'IP_REUSED');
});

test('profile failures retain separate diagnostic images accessible after every retry', { timeout: 2000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gmx-retry-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let generated = 0;
  const { runner, start, workers } = createBatch({ directory, makeProfile: async () => {
    generated++;
    if (generated === 3 || generated > 10) throw new Error('Simulated profile service failure');
    return { firstName: `Profile${generated}`, password: 'test-password' };
  } });
  start();
  await runner.done;

  const job = runner.run.jobs[2];
  assert.equal(workers.length, 9);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts.length, 4);
  assert.equal(new Set(job.attempts.map(attempt => attempt.screenshotUrl)).size, 4);
  for (const attempt of job.attempts) {
    const artifact = runner.failureImage(attempt.id);
    assert.equal(attempt.failureCode, 'PROFILE_GENERATION_FAILED');
    assert.equal(artifact.kind, 'diagnostic');
    assert.match(await readFile(artifact.path, 'utf8'), /PROFILE_GENERATION_FAILED/);
  }
});

test('hung browser cleanup is forced and the remaining queue still runs', { timeout: 2000 }, async () => {
  const { runner, start, workers, stats } = createBatch({ hangClose: true, cleanupTimeoutMs: 10 });
  start(); await runner.done;
  assert.equal(workers.length, 10);
  assert.ok(workers.every(worker => worker.forced && !worker.browser.connected));
  assert.ok(runner.run.jobs.every(job => job.status === 'success' && job.cleanupError));
  assert.equal(stats().active, 0);
});

test('Stop during startup cancels hung workers and never opens queued registrations', { timeout: 2000 }, async () => {
  const { runner, start, workers, stats } = createBatch({ hangStart: true });
  start(); await nextTurn(); runner.stop(); await runner.done;
  assert.equal(workers.length, 2);
  assert.ok(workers.every(worker => worker.startSignal.aborted && !worker.browser.connected));
  assert.ok(runner.run.jobs.every(job => job.status === 'cancelled'));
  assert.equal(stats().active, 0);
});

test('Stop during asynchronous profile generation does not create a browser later', { timeout: 2000 }, async () => {
  let finish;
  const { runner, start, workers } = createBatch({ makeProfile: () => new Promise(resolve => { finish = resolve; }) });
  start(); await nextTurn(); runner.stop(); await runner.done;
  finish({ firstName: 'Late profile' }); await nextTurn();
  assert.equal(workers.length, 0);
  assert.ok(runner.run.jobs.every(job => job.status === 'cancelled'));
});
