const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const express = require("express");
const multer = require("multer");
const { BatchRunner } = require("./batch.cjs");
const { parseAccounts, parseProxies } = require("./inputs.cjs");
const { RegistrationAssistant, createRegistrationRouter } = require("./automation/registration.cjs");
const { RegistrationBatchRunner } = require("./automation/registration-batch.cjs");
const { getGermanNumber } = require("./random.js");

function createApp({ runner = new BatchRunner(), registrationAssistant = null, generateRegistrationProfile, registrationBatch = null } = {}) {
  registrationBatch ||= registrationAssistant?.createWorker ? new RegistrationBatchRunner({ assistant: registrationAssistant, makeProfile: generateRegistrationProfile }) : null;
  const app = express();
  const csrf = randomBytes(32).toString("hex");
  app.disable("x-powered-by");
  app.set("views", path.join(__dirname, "views"));
  app.set("view engine", "ejs");
  app.use(express.json({ limit: "8kb" }));
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (!["127.0.0.1", "localhost", "[::1]"].includes(req.hostname)) return res.status(403).json({ error: "Use the local dashboard address." });
    next();
  });
  app.use("/public", express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
  app.get("/", (_req, res) => res.render("index", { csrf }));
  app.get("/registration", (_req, res) => res.render("registration", { csrf }));
  app.get("/api/state", (_req, res) => res.json(runner.snapshot()));
  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Connection": "keep-alive" });
    res.flushHeaders();
    const send = (state) => { if (!res.destroyed) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); };
    runner.on("state", send);
    send(runner.snapshot());
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    req.on("close", () => { clearInterval(heartbeat); runner.off("state", send); });
  });
  app.get("/artifacts/:run/:image", (req, res) => {
    const run = runner.run;
    const url = `/artifacts/${req.params.run}/${req.params.image}`;
    if (!run || run.id !== req.params.run || !run.jobs.some((job) => job.screenshotUrl === url)) return res.sendStatus(404);
    res.sendFile(path.join(runner.root, req.params.run, req.params.image));
  });
  app.use("/api", (req, res, next) => {
    if (req.method !== "POST") return next();
    const token = Buffer.from(req.get("X-CSRF-Token") || "");
    if (token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf))) return res.status(403).json({ error: "Reload the dashboard before starting a batch." });
    const origin = req.get("Origin");
    if (origin && origin !== `http://${req.get("Host")}`) return res.status(403).json({ error: "Request origin rejected." });
    next();
  });
  app.use("/api/registration", createRegistrationRouter(registrationAssistant, { generateProfile: generateRegistrationProfile, batch: registrationBatch }));
  const imapConnection = req => {
    const connectionMode = req.body.connectionMode || 'proxy';
    if (!['proxy', 'maskify'].includes(connectionMode)) throw new Error('Choose HTTP proxy or Maskify API.');
    const file = req.file || req.files?.proxies?.[0];
    if (connectionMode === 'proxy' && !file) throw new Error('Choose a proxy TXT file.');
    return { connectionMode, proxies: connectionMode === 'proxy' ? parseProxies(file.buffer.toString('utf8')) : [] };
  };
  const selectedUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4, parts: 5, fieldSize: 25_000 } });
  app.post('/api/registration-runs', (req, res, next) => {
    if (runner.run?.active) return res.status(409).json({ error: 'A batch is already running.' });
    if (!registrationAssistant?.accountsForBatch) return res.status(503).json({ error: 'Saved account automation is unavailable.' });
    next();
  }, selectedUpload.single('proxies'), async (req, res) => {
    let accounts;
    try {
      const connection = imapConnection(req);
      const concurrency = Number(req.body.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Workers must be a whole number from 1 to 8.');
      if (!['true', 'false'].includes(req.body.headless)) throw new Error('Choose visible Chrome or headless mode.');
      let ids;
      try { ids = JSON.parse(req.body.registrationIds); } catch { throw new Error('Select saved registrations.'); }
      accounts = registrationAssistant.accountsForBatch(ids);
      res.status(202).json(await runner.start({ accounts, ...connection, concurrency, headless: req.body.headless === 'true' }));
    } catch (error) {
      // runner.start takes ownership of credentials only after a successful start.
      if (accounts) for (const account of accounts) account.password = '';
      res.status(400).json({ error: error.message });
    } finally { req.file?.buffer.fill(0); }
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 2, fields: 3, parts: 5, fieldSize: 100 } });
  app.post("/api/runs", (req, res, next) => {
    if (runner.run?.active) return res.status(409).json({ error: "A batch is already running." });
    next();
  }, upload.fields([{ name: "accounts", maxCount: 1 }, { name: "proxies", maxCount: 1 }]), async (req, res) => {
    let accounts;
    try {
      if (!req.files?.accounts?.[0]) throw new Error("Choose an account TXT file.");
      accounts = parseAccounts(req.files.accounts[0].buffer.toString("utf8"));
      const connection = imapConnection(req);
      const concurrency = Number(req.body.concurrency);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Parallel tasks must be a whole number from 1 to 8.");
      if (!["true", "false"].includes(req.body.headless)) throw new Error("Choose visible Chrome or headless mode.");
      const state = await runner.start({ accounts, ...connection, concurrency, headless: req.body.headless === "true" });
      res.status(202).json(state);
    } catch (error) {
      if (accounts) for (const account of accounts) account.password = '';
      res.status(400).json({ error: error.message });
    }
    finally { for (const file of Object.values(req.files || {}).flat()) file.buffer.fill(0); }
  });
  app.post("/api/runs/:id/stop", (req, res) => {
    if (runner.run?.id !== req.params.id) return res.status(404).json({ error: "Batch not found." });
    runner.stop();
    res.json(runner.snapshot());
  });
  app.use((error, _req, res, _next) => {
    res.status(400).json({ error: error instanceof multer.MulterError ? "Upload rejected. Use TXT files, up to 2 MB each." : "Request failed. Check the selected files and try again." });
  });
  return { app, runner, registrationAssistant, registrationBatch };
}

if (require.main === module) {
  const usesMaskify = !!(process.env.MASKIFY_USERNAME?.trim() || process.env.MASKIFY_PASSWORD);
  const registrationAssistant = new RegistrationAssistant({ maskifyEnv: process.env,
    purchasePhone: process.env.HEROSMS_API_KEY?.trim() ? getGermanNumber : null });
  const { app, runner, registrationBatch } = createApp({ registrationAssistant });
  const port = Number(process.env.PORT || 3000);
  
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`GMX dashboard: http://127.0.0.1:${port}`);
    const enabled = usesMaskify && process.env.MASKIFY_USERNAME?.trim() && process.env.MASKIFY_PASSWORD && process.env.ANYSOLVER_API_KEY?.trim();
    if (enabled) {
      console.log('✅ Registration CAPTCHA solver: ENABLED (AnySolver + Maskify)');
    } else {
      console.log('Registration CAPTCHA solver: manual verification');
    }
  });

  server.on("error", (error) => { 
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use. Set PORT to another port.` : "Could not start the dashboard server."); 
    process.exitCode = 1; 
    void registrationAssistant.close().catch(() => {});
  });

  const shutdown = async () => {
    console.log("Stopping workers and saving result images ...");
    runner.stop();
    registrationBatch?.stop();
    await runner.done;
    await registrationBatch?.done;
    await registrationAssistant.close();
    server.closeAllConnections();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = { createApp };
