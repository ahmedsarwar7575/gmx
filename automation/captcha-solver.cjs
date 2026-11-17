const { setTimeout: sleep } = require("node:timers/promises");
const https = require("node:https");
const { parseProxy, openProxy } = require("../proxy.cjs");

const CAPTCHA_HOSTS = ["auth.gmx.net", "mailset-root.gmx.net", "register.gmx.net"];

function requestApi(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      family: 4, signal,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => JSON.parse(text),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function installCaptchaCapture(page, hosts = CAPTCHA_HOSTS) {
  await page.evaluateOnNewDocument((allowed) => {
    if (!allowed.includes(location.hostname)) return;
    const capture = { documentId: crypto.randomUUID(), widgets: [] };
    window.__gmxCaptchaCapture = capture;
    let api;
    const wrap = (value) => {
      if (!value || value.__gmxWrapped) return value;
      value.__gmxWrapped = true;
      const autoWidgets = () => {
        for (const element of document.querySelectorAll('.captchafox[data-sitekey]')) {
          if (capture.widgets.some((widget) => widget.element === element)) continue;
          const child = element.querySelector('[id^="cf-widget-"]');
          capture.widgets.push({ element, sitekey: element.dataset.sitekey,
            widgetId: child?.id.slice("cf-widget-".length) });
        }
      };
      if (typeof value.render === "function") {
        const original = value.render;
        value.render = function (container, options) {
          const element = typeof container === "string" ? document.querySelector(container) : container;
          const widget = { element, sitekey: options?.sitekey, onVerify: options?.onVerify };
          capture.widgets.push(widget);
          const result = Reflect.apply(original, this, arguments);
          Promise.resolve(result).then((id) => { widget.widgetId = id; }, () => {});
          return result;
        };
      }
      if (typeof value.execute === "function") {
        const original = value.execute;
        value.execute = function (...args) {
          autoWidgets();
          const widget = args[0] == null
            ? capture.widgets.find((w) => w.element?.isConnected)
            : capture.widgets.find((w) => String(w.widgetId) === String(args[0]));
          const native = Reflect.apply(original, this, args);
          if (!widget) return native;
          const external = new Promise((resolve) => { widget.executeResolve = resolve; });
          const result = Promise.race([native, external]);
          const clear = () => { widget.executeResolve = null; };
          result.then(clear, clear);
          return result;
        };
      }
      if (typeof value.getResponse === "function") {
        const original = value.getResponse;
        value.getResponse = function (id) {
          const widget = id == null ? capture.widgets.find((w) => w.element?.isConnected)
            : capture.widgets.find((w) => String(w.widgetId) === String(id));
          return widget?.deliveredToken || Reflect.apply(original, this, arguments);
        };
      }
      return value;
    };
    Object.defineProperty(window, "captchafox", {
      configurable: true, enumerable: true,
      get: () => api,
      set: (value) => { api = wrap(value); },
    });
  }, hosts);
}

function createCaptchaSolver(env, { hosts = CAPTCHA_HOSTS, fetchImpl = requestApi, wait = sleep, log = console.log, signal } = {}) {
  const pause = (ms) => wait(ms, undefined, { signal });
  if (!env.ANYSOLVER_API_KEY?.trim() || !env.GMX_PROXY_URL?.trim()) return null;
  const proxy = parseProxy(env.GMX_PROXY_URL.trim());
  const key = env.ANYSOLVER_API_KEY.trim();
  const attempted = new WeakMap();
  let forwarder;

  async function call(endpoint, params) {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetchImpl(`https://api.anysolver.com/${endpoint}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: key, ...params }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        });
        break;
      } catch {
        signal?.throwIfAborted();
        if (endpoint === "createTask" || attempt === 1) throw new Error("NETWORK_ERROR");
        log("AnySolver read request failed; retrying once ...");
        await pause(2_000);
      }
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    let result;
    try { result = await response.json(); } catch { throw new Error("INVALID_RESPONSE"); }
    if (result.errorId !== 0 || result.status === "failed") {
      // Providers can echo proxy credentials or tokens in their error details.
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(result.errorCode || "") ? result.errorCode : "SERVICE_ERROR";
      throw new Error(code);
    }
    return result;
  }

  return {
    async startProxy() {
      forwarder ||= await openProxy(env.GMX_PROXY_URL.trim(), log);
      return forwarder.argument;
    },
    async closeProxy() {
      const current = forwarder;
      forwarder = null;
      await current?.close();
    },
    getRetryDelay() { return forwarder?.getRetryDelay() || 0; },
    async checkAccount() {
      try {
        const account = await call("getBalance", {});
        if (!Number.isFinite(Number(account.balance))) throw new Error("INVALID_BALANCE_RESPONSE");
        if (Number(account.balance) <= 0) throw new Error("ERROR_ZERO_BALANCE");
      } catch (error) {
        throw new Error(`AnySolver account check failed (${error.message}). Check ANYSOLVER_API_KEY and your AnySolver balance.`);
      }
    },
    async preparePage(page) {
      await installCaptchaCapture(page, hosts);
    },
    async trySolve(frame) {
      log("Polling for CaptchaFox widget to render (up to 40s)...");

      const renderDeadline = Date.now() + 40_000;
      let widgetReady = false;
      let lastReason = "unknown";

      while (Date.now() < renderDeadline) {
        const check = await frame.evaluate(() => {
          const w = document.querySelector('.captchafox');
          if (!w) return { ready: false, reason: "no .captchafox element yet" };
          if (w.querySelector('.cf-checkbox, [role="checkbox"]')) return { ready: true };
          if (w.querySelector('iframe')) return { ready: true };
          const child = w.querySelector('[id^="cf-widget-"]');
          if (child && child.querySelector('.cf-button')) return { ready: true };
          return { ready: false, reason: "widget element present, checkbox not yet rendered" };
        }).catch((e) => ({ ready: false, reason: "evaluate error: " + e.message }));

        if (check.ready) {
          widgetReady = true;
          log("Widget rendered.");
          break;
        }
        lastReason = check.reason;
        await pause(500);
      }

      if (!widgetReady) {
        log(`Widget did not render within 40s (${lastReason}).`);
        return false;
      }

      const metadata = await frame.evaluate((allowed) => {
        if (!allowed.includes(location.hostname)) return { error: "Host not allowed" };
        const capture = window.__gmxCaptchaCapture;
        if (!capture) return { error: "Capture hook missing" };

        const index = capture.widgets.findLastIndex((w) => w.element?.isConnected && w.sitekey
          && (typeof w.onVerify === "function" || typeof w.executeResolve === "function"));

        if (index < 0) return { error: "No active widget with callback" };

        const apiServer = [...document.scripts].map((s) => s.src).find((src) => /captchafox.*\/api\.js(?:\?|$)/i.test(src));
        if (!apiServer) return { error: "CaptchaFox API script not found" };

        return {
          documentId: capture.documentId,
          index,
          websiteKey: capture.widgets[index].sitekey,
          websiteURL: location.origin + location.pathname,
          userAgent: navigator.userAgent,
          apiServer,
        };
      }, hosts).catch((e) => ({ error: e.message }));

      if (metadata.error) {
        log(`Metadata error: ${metadata.error}`);
        return false;
      }

      const attempt = `${metadata.documentId}:${metadata.index}`;
      const seen = attempted.get(frame) || new Set();
      if (seen.has(attempt)) {
        log("Already attempted this widget. Skipping to avoid double charge.");
        return false;
      }

      log(`Found widget! Sitekey: ${metadata.websiteKey.substring(0, 10)}...`);

      // Reserve before sending: a failed or lost response must not replay a
      // potentially paid request for this widget on the next registration poll.
      seen.add(attempt);
      attempted.set(frame, seen);

      try {
        log("Sending CaptchaFoxToken to AnySolver...");
        const created = await call("createTask", {
          task: { type: "CaptchaFoxToken", websiteURL: metadata.websiteURL,
            websiteKey: metadata.websiteKey, userAgent: metadata.userAgent,
            apiServer: metadata.apiServer, proxy },
          settings: { retry: { enabled: false }, fallback: { enabled: false }, analytics: false },
        });
        if (typeof created.taskId !== "string" || !created.taskId) throw new Error("MISSING_TASK_ID");
        log(`Task created (CaptchaFoxToken): ${created.taskId}`);
        const deadline = Date.now() + 62 * 60_000;
        let token;

        while (Date.now() < deadline) {
          await pause(2_000);
          const result = await call("getTaskResult", { taskId: created.taskId });

          if (result.status === "ready") {
            token = result.solution?.token;
            log("Solution received from AnySolver!");
            break;
          }
          if (result.status !== "processing") throw new Error(`Unexpected status: ${result.status}`);

          if (Date.now() % 10_000 < 2_500) log("Still waiting for solution...");
        }

        if (typeof token !== "string" || !token) throw new Error("NO_SOLUTION_RECEIVED");
        if (metadata.apiServer.includes("uicdn.com/") && !token.startsWith("MAM_")) throw new Error("WRONG_TOKEN_VARIANT");

        log("Injecting token into the widget...");

        const delivered = await frame.evaluate(({ token, documentId, index }) => {
          const capture = window.__gmxCaptchaCapture;
          const widget = capture?.documentId === documentId && capture.widgets[index];
          if (!widget?.element?.isConnected) return false;

          const currentIndex = capture.widgets.findLastIndex((w) => w.element?.isConnected && w.sitekey
            && (typeof w.onVerify === "function" || typeof w.executeResolve === "function"));
          if (currentIndex !== index) return false;

          widget.deliveredToken = token;

          const textarea = document.querySelector(`[name="cf-captcha-response"]`);
          if (textarea) {
            textarea.value = token;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
          }

          let called = false;
          if (typeof widget.executeResolve === "function") {
            widget.executeResolve(token);
            window.captchafox?.remove?.(widget.widgetId);
            called = true;
          }
          if (typeof widget.onVerify === "function") {
            widget.onVerify(token);
            called = true;
          }
          return called || !!textarea;
        }, { token, documentId: metadata.documentId, index: metadata.index }).catch(() => false);

        if (!delivered) throw new Error("WIDGET_CHANGED_OR_REMOVED");

        log("Token injected. Waiting for overlay to clear...");

        const cleared = await frame.waitForFunction(() => {
          const roots = [document];
          for (const root of roots) for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) roots.push(el.shadowRoot);
            if (!el.matches('#container-captcha, .cf-modal__wrap, .cf-modal__challenge')) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width && rect.height && getComputedStyle(el).visibility !== 'hidden') return false;
          }
          return true;
        }, { timeout: 30_000 }).then((handle) => handle.dispose().then(() => true)).catch(() => false);

        if (!cleared) throw new Error("CHALLENGE_NOT_CLEARED");

        log("✅ CAPTCHA cleared; continuing.");
        return true;
      } catch (error) {
        signal?.throwIfAborted();
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "SOLVER_ERROR";
        log(`❌ Solver failed (${code}).`);
        return false;
      }
    },
  };
}

module.exports = { createCaptchaSolver, installCaptchaCapture, parseProxy };
