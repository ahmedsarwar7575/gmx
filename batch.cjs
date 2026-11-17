const { EventEmitter } = require("node:events");
const { randomUUID, randomInt } = require("node:crypto");
const path = require("node:path");
const { main, createRedactor } = require("./login.cjs");
const { ARTIFACTS, clearScreenshots, diagnosticImage } = require("./artifacts.cjs");
const { maskEmail } = require("./inputs.cjs");

class BatchRunner extends EventEmitter {
  constructor({ automate = main, root = ARTIFACTS, apiKey = process.env.ANYSOLVER_API_KEY } = {}) {
    super();
    this.automate = automate;
    this.root = root;
    this.apiKey = apiKey;
    this.run = null;
    this.controllers = new Set();
    this.revision = 0;
    this.done = Promise.resolve();
  }

  snapshot() { return { revision: this.revision, run: this.run ? structuredClone(this.run) : null, configuredSolver: !!this.apiKey }; }
  publish() { this.revision++; this.emit("state", this.snapshot()); }

  async start({ accounts, proxies, concurrency = 2, headless = false }) {
    if (this.run?.active) throw new Error("A batch is already running.");
    if (!accounts.length || !proxies.length || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Choose accounts, proxies and 1–8 parallel tasks.");
    const id = randomUUID();
    const run = this.run = { id, active: true, stopping: false, startedAt: Date.now(), finishedAt: null,
      concurrency: Math.min(concurrency, accounts.length, proxies.length), requestedConcurrency: concurrency,
      headless, proxyCount: proxies.length, removedScreenshots: 0,
      jobs: accounts.map((account, index) => ({ id: randomUUID(), index: index+1, account: maskEmail(account.email),
        status: "queued", stage: "Waiting for a worker", logs: [], startedAt: null, finishedAt: null,
        proxy: null, screenshotUrl: null, artifactKind: null, error: null, alreadyEnabled: null })),
    };
    try { run.removedScreenshots = await clearScreenshots(this.root); }
    catch { run.active = false; throw new Error("Could not clear previous screenshots. Check artifacts directory permissions."); }
    this.publish();
    // Keep credentials in this closure only. Public run data never contains them.
    this.done = this.execute(run, accounts, proxies).finally(() => {
      for (const account of accounts) account.password = "";
      accounts.length = 0;
      proxies.length = 0;
      run.active = false;
      run.finishedAt = Date.now();
      this.publish();
    });
    return this.snapshot();
  }

  async execute(run, accounts, proxies) {
    const available = proxies.map((_, index) => index);
    let next = 0;
    const workers = Array.from({ length: run.concurrency }, async () => {
      while (next < run.jobs.length) {
        const index = next++, job = run.jobs[index], account = accounts[index];
        const filename = path.join(this.root, run.id, `${job.id}.png`);
        if (run.stopping) {
          job.status = "cancelled";
          job.stage = "Stopped before opening Chrome";
          const image = await diagnosticImage(filename, "Cancelled before a browser was started.", job.stage);
          this.setArtifact(run, job, image.path, image.kind);
          job.finishedAt = Date.now();
          this.publish();
          continue;
        }
        const slot = randomInt(available.length), proxyIndex = available.splice(slot, 1)[0];
        const proxyUrl = proxies[proxyIndex];
        const controller = new AbortController();
        this.controllers.add(controller);
        const hide = createRedactor([account.email, account.password, proxyUrl, this.apiKey]);
        const log = (message) => {
          job.logs.push({ time: Date.now(), message: hide(message).slice(0, 1800) });
          if (job.logs.length > 120) job.logs.shift();
          this.publish();
        };
        Object.assign(job, { status: "running", startedAt: Date.now(), proxy: proxyIndex+1, stage: "Starting Chrome" });
        this.publish();
        try {
          const result = await this.automate({ ...account, proxyUrl, apiKey: this.apiKey, headless: run.headless,
            signal: controller.signal, closeDelayMs: 0, screenshotPath: filename, onLog: log,
            onStage: (stage) => { if (job.stage !== stage) { job.stage = hide(stage); this.publish(); } },
            onPause: (reason) => { job.status = "attention"; job.stage = hide(reason); this.publish(); },
            onResume: (stage) => { job.status = "running"; job.stage = hide(stage); this.publish(); },
          });
          if (!result?.enabled) throw new Error("POP3 / IMAP persistence was not verified.");
          job.status = "success";
          job.stage = result.alreadyEnabled ? "Already enabled · verified after refresh" : "Enabled · verified after refresh";
          job.alreadyEnabled = result.alreadyEnabled;
          this.setArtifact(run, job, result.screenshotPath, result.artifactKind || "screenshot");
        } catch (error) {
          job.status = controller.signal.aborted ? "cancelled" : error.code === "MANUAL_VERIFICATION_REQUIRED" ? "needs_attention" : "failed";
          job.error = hide(error.message).slice(0, 2000);
          job.stage = job.status === "cancelled" ? "Stopped by user" : job.status === "needs_attention" ? "Retry with visible Chrome" : "Could not complete this account";
          log(job.error);
          let image = { path: error.screenshotPath, kind: error.artifactKind };
          if (!image.path) image = await diagnosticImage(filename, job.error, job.stage);
          this.setArtifact(run, job, image.path, image.kind);
        } finally {
          this.controllers.delete(controller);
          available.push(proxyIndex);
          account.password = "";
          job.finishedAt = Date.now();
          this.publish();
        }
      }
    });
    // One worker's storage failure must not release the batch lock while others run.
    const results = await Promise.allSettled(workers);
    if (results.some((result) => result.status === "rejected")) {
      for (const job of run.jobs) if (["running", "queued", "attention"].includes(job.status)) {
        job.status = "failed"; job.stage = "Artifact storage failed";
        job.error = "Could not save a result image. Check available disk space and directory permissions.";
        job.finishedAt = Date.now();
      }
    }
  }

  setArtifact(run, job, filename, kind) {
    if (!filename || path.dirname(path.resolve(filename)) !== path.join(this.root, run.id)) throw new Error("Result image is outside the batch directory.");
    job.screenshotUrl = `/artifacts/${run.id}/${path.basename(filename)}`;
    job.artifactKind = kind;
  }

  stop() {
    if (!this.run?.active) return;
    this.run.stopping = true;
    for (const controller of this.controllers) controller.abort();
    this.publish();
  }
}

module.exports = { BatchRunner };
