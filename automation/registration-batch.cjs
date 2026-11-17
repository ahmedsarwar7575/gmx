const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { parseProxies } = require('../inputs.cjs');
const { createMaskifyProxy } = require('../maskify.cjs');
const { generateProfile } = require('../random.js');

const finished = new Set(['complete', 'user_confirmed', 'failed', 'paused', 'cancelled']);

function batchInput({ connectionMode, accountCount, concurrency, proxyText } = {}) {
  if (!['maskify', 'proxy'].includes(connectionMode)) throw new Error('Choose Maskify API or HTTP proxy.');
  const count = Number(accountCount), workers = Number(concurrency);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('Account count must be a whole number from 1 to 500.');
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error('Parallel workers must be a whole number from 1 to 8.');
  let proxies = [];
  if (connectionMode === 'proxy') {
    if (typeof proxyText !== 'string' || Buffer.byteLength(proxyText) > 2 * 1024 * 1024) throw new Error('Upload a proxy TXT file up to 2 MB.');
    proxies = parseProxies(proxyText);
    if (proxies.length < count) throw new Error(`Upload at least ${count} different proxies, one per registration attempt.`);
  } else if (proxyText) throw new Error('Proxy uploads require HTTP proxy mode.');
  return { connectionMode, accountCount: count, concurrency: workers, proxies };
}

class RegistrationBatchRunner extends EventEmitter {
  constructor({ assistant, makeProfile = generateProfile, timeoutMs = 90 * 60_000 } = {}) {
    super();
    Object.assign(this, { assistant, makeProfile, timeoutMs, run: null, done: Promise.resolve(), workers: new Map() });
  }

  snapshot() { return { run: this.run ? structuredClone(this.run) : null }; }
  publish() { this.emit('state', this.snapshot()); }
  session(id) { return [...this.workers.values()].find(worker => worker.activeId === id); }

  start(input) {
    if (this.run?.active || this.assistant.starting || this.assistant.browser?.connected) throw new Error('Finish or close the active registration before starting a batch.');
    const options = batchInput(input);
    if (options.connectionMode === 'maskify') createMaskifyProxy(this.assistant.maskifyEnv || {});
    const run = {
      id: randomUUID(), active: true, stopping: false, startedAt: Date.now(), finishedAt: null,
      connectionMode: options.connectionMode, accountCount: options.accountCount,
      concurrency: Math.min(options.concurrency, options.accountCount), requestedConcurrency: options.concurrency,
      proxyCount: options.proxies.length,
      jobs: Array.from({ length: options.accountCount }, (_, index) => ({ id: randomUUID(), index: index + 1,
        registrationId: null, status: 'queued', stage: 'Waiting for a worker', session: null, startedAt: null, finishedAt: null })),
    };
    this.assistant.store.createBatch(run.id);
    this.run = run;
    this.controller = new AbortController();
    this.publish();
    this.done = this.execute(run, options).catch(() => {
      for (const job of run.jobs) if (!job.finishedAt) {
        job.status = 'failed'; job.stage = 'Registration worker failed'; job.finishedAt = Date.now();
      }
    }).finally(() => {
      options.proxies.fill(''); options.proxies.length = 0;
      run.active = false; run.finishedAt = Date.now();
      try { this.assistant.store.finishBatch(run.id, run.stopping ? 'stopped' : 'complete'); }
      catch { run.error = 'Could not save batch completion. Check database permissions and disk space.'; }
      this.publish();
    });
    return this.snapshot();
  }

  async execute(run, options) {
    let next = 0;
    const results = await Promise.allSettled(Array.from({ length: run.concurrency }, async () => {
      while (next < run.jobs.length) {
        const index = next++, job = run.jobs[index];
        if (run.stopping) {
          Object.assign(job, { status: 'cancelled', stage: 'Stopped before opening Chrome', finishedAt: Date.now() });
          this.publish(); continue;
        }
        await this.executeAccount(run, job, options.proxies[index]);
      }
    }));
    if (results.some(result => result.status === 'rejected')) throw new Error('Registration worker failed.');
  }

  async executeAccount(run, job, proxyText) {
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, timeout.signal]);
    const deadline = setTimeout(() => timeout.abort(), this.timeoutMs);
    let worker, update, abort;
    Object.assign(job, { status: 'running', stage: 'Generating profile', startedAt: Date.now() });
    this.publish();
    try {
      const profile = await this.makeProfile();
      signal.throwIfAborted();
      worker = this.assistant.createWorker();
      this.workers.set(job.id, worker);
      update = snapshot => {
        const session = snapshot.active;
        if (!session) return;
        if (!job.registrationId) {
          this.assistant.store.linkBatchAccount(run.id, session.id);
          job.registrationId = session.id;
        }
        job.session = session;
        job.stage = session.stage;
        job.status = ['complete', 'user_confirmed'].includes(session.status) ? 'success'
          : session.status === 'cancelled' ? 'cancelled' : ['failed', 'paused'].includes(session.status) ? 'failed' : session.status;
        this.publish();
      };
      worker.on('state', update);
      abort = () => { void worker.closeBrowser().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      // Each uploaded pool entry is consumed once. Maskify builds a fresh sticky
      // session inside each worker. A repeated exit IP always fails closed.
      await worker.start(profile, { mode: run.connectionMode, ...(proxyText ? { proxyText } : {}) });
      await this.waitForAccount(worker, signal);
      if (!['complete', 'user_confirmed'].includes(worker.state?.status)) throw new Error('Registration did not complete.');
      job.status = 'success'; job.stage = worker.state.stage || 'Account created';
    } catch (error) {
      job.status = this.controller.signal.aborted ? 'cancelled' : 'failed';
      job.stage = this.controller.signal.aborted ? 'Stopped by user' : timeout.signal.aborted
        ? 'Registration timed out. The account was not retried.' : worker?.safeError(error) || 'Could not prepare the registration profile.';
      if (worker?.activeId && !['complete', 'user_confirmed'].includes(worker.state?.status)) {
        try { worker.setState(job.status, job.stage); } catch {}
      }
      // A stop can race with the site's final success marker. Keep confirmed
      // successes in the result and export even when stopping the other jobs.
      if (['complete', 'user_confirmed'].includes(worker?.state?.status)) { job.status = 'success'; job.stage = worker.state.stage || 'Account created'; }
    } finally {
      clearTimeout(deadline);
      if (worker) {
        signal.removeEventListener('abort', abort);
        worker.off('state', update);
        try { await worker.close(); }
        catch { job.status = 'failed'; job.stage = 'Could not close the registration browser.'; }
        if (job.session) job.session.browserOpen = false;
        this.workers.delete(job.id);
      }
      job.finishedAt = Date.now();
      this.publish();
    }
  }

  waitForAccount(worker, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { worker.off('state', check); signal.removeEventListener('abort', abort); };
      const check = () => { if (finished.has(worker.state?.status)) { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(new Error('Stopped by user')); };
      worker.on('state', check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }

  stop() {
    if (!this.run?.active) return;
    this.run.stopping = true;
    this.controller.abort();
    this.publish();
  }
  export(id) { return this.assistant.store.exportBatch(id); }
  async close() { this.stop(); await this.done; }
}

module.exports = { RegistrationBatchRunner, batchInput };
