const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { test } = require('node:test');
const { RegistrationBatchRunner } = require('../automation/registration-batch.cjs');

function createBatch({ outcomes = [], timing = 'watch' } = {}) {
  const workers = [], events = [], records = new Map();
  let active = 0, maxActive = 0, batchStatus;
  const store = {
    createBatch() {},
    linkBatchAccount() {},
    finishBatch(id, status) { batchStatus = status; },
  };
  const assistant = {
    store,
    createWorker() {
      const index = workers.length + 1;
      const outcome = outcomes[index - 1] || { status: 'complete', stage: 'Account created' };
      const worker = new EventEmitter();
      workers.push(worker);
      worker.activeId = `registration-${index}`;
      worker.browser = { connected: false };
      worker.snapshot = () => ({ active: { ...worker.state, browserOpen: worker.browser.connected } });
      worker.safeError = error => typeof error === 'string' ? error : error.message;
      worker.setState = (status, stage) => {
        worker.state = { ...worker.state, status, stage };
        records.set(worker.activeId, { ...worker.state });
        worker.emit('state', worker.snapshot());
      };
      worker.recordFailure = (code, reason, { phase, status }) => {
        worker.state = { ...worker.state, failureCode: code, failurePhase: phase };
        worker.setState(status, reason);
      };
      worker.start = async () => {
        active++; maxActive = Math.max(maxActive, active);
        events.push(`start:${index}`);
        worker.browser.connected = true;
        worker.state = { id: worker.activeId, phase: 'phone' };
        worker.setState('running', 'Registering');
        const finish = () => {
          worker.state = { ...worker.state, ...outcome };
          worker.setState(outcome.status, outcome.stage);
        };
        if (timing === 'startup') finish();
        else worker.timer = setImmediate(finish);
        return worker.snapshot();
      };
      worker.closeBrowser = () => {
        worker.closing ||= (async () => {
          clearImmediate(worker.timer);
          await nextTurn();
          if (worker.state.status !== 'complete') {
            worker.state.failureImageUrl = `/api/registration/${worker.activeId}/failure-image`;
            worker.state.failureArtifactKind = 'screenshot';
          }
          worker.browser.connected = false;
          active--;
          events.push(`close:${index}`);
        })();
        return worker.closing;
      };
      worker.close = () => worker.closeBrowser();
      return worker;
    },
  };
  const runner = new RegistrationBatchRunner({ assistant, makeProfile: async () => ({}), timeoutMs: 250 });
  const start = () => runner.start({ connectionMode: 'proxy', accountCount: 10, concurrency: 2,
    proxyText: Array.from({ length: 10 }, (_, index) => `http://127.0.0.1:${21000 + index}`).join('\n') });
  return { runner, start, workers, events, records, stats: () => ({ active, maxActive, batchStatus }) };
}

for (const timing of ['startup', 'watch']) {
  for (const status of ['help', 'needs_attention']) {
    test(`${status} during ${timing} closes failed browsers and runs all 10 attempts with 2 workers`, { timeout: 2000 }, async () => {
      const outcome = status === 'help'
        ? { status: 'failed', stage: 'GMX redirected to registration help', failureCode: 'GMX_REGISTRATION_HELP', failurePhase: 'phone' }
        : { status: 'needs_attention', stage: 'GMX has not advanced; review Chrome and retry' };
      const { runner, start, workers, events, records, stats } = createBatch({ timing, outcomes: [outcome, outcome] });
      start();
      await runner.done;

      assert.equal(workers.length, 10);
      assert.deepEqual(stats(), { active: 0, maxActive: 2, batchStatus: 'complete' });
      assert.equal(runner.run.active, false);
      assert.equal(runner.workers.size, 0);
      assert.deepEqual(runner.run.jobs.map(job => job.status), ['failed', 'failed', ...Array(8).fill('success')]);
      assert.ok(runner.run.jobs.every(job => job.startedAt && job.finishedAt));
      assert.ok(events.indexOf('close:1') < events.indexOf('start:3'));
      for (const job of runner.run.jobs.slice(0, 2)) {
        assert.equal(job.failureCode, status === 'help' ? 'GMX_REGISTRATION_HELP' : 'REGISTRATION_FAILED');
        assert.equal(job.failurePhase, 'phone');
        assert.equal(job.stage, outcome.stage);
        assert.equal(job.session.status, 'failed');
        assert.equal(job.session.browserOpen, false);
        assert.equal(job.screenshotUrl, `/api/registration/${job.registrationId}/failure-image`);
        assert.equal(records.get(job.registrationId).status, 'failed');
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
