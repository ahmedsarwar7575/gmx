const { setTimeout: sleep } = require("node:timers/promises");
const https = require("node:https");
const { parseProxy, openProxy } = require("./proxy.cjs");

// Native HTTPS over IPv4 avoids the fetch/Undici connection timeouts observed
// here. Certificate verification remains enabled.
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

// Install before navigation so the actual GMX widget supplies its sitekey and
// success callback. Response tokens are never logged.
async function installCaptchaCapture(page) {
  await page.evaluateOnNewDocument(() => {
    if (!["auth.gmx.net", "mailset-root.gmx.net"].includes(location.hostname)) return;
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
  });
}

function createCaptchaSolver(env, { fetchImpl = requestApi, wait = sleep, log = console.log, signal } = {}) {
  const pause = (ms) => wait(ms, undefined, { signal });
  if (!env.ANYSOLVER_API_KEY?.trim() || !env.GMX_PROXY_URL?.trim()) return null;
  const proxy = parseProxy(env.GMX_PROXY_URL.trim());
  const key = env.ANYSOLVER_API_KEY.trim();
  const attempts = new WeakMap();
  let forwarder;

  async function call(endpoint, params) {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetchImpl(`https://api.anysolver.com/${endpoint}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: key, ...params }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        break;
      } catch {
        signal?.throwIfAborted();
        // Only retry reads: retrying createTask could produce a second charge.
        if (endpoint === "createTask" || attempt === 1) throw new Error("NETWORK_ERROR");
        log("AnySolver read request failed; retrying once ...");
        await pause(2_000);
      }
    }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    let result;
    try { result = await response.json(); } catch { throw new Error("INVALID_RESPONSE"); }
    if (result.errorId !== 0 || result.status === "failed") {
      // Never print errorDescription/raw: providers may echo secrets or tokens.
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
      await installCaptchaCapture(page);
    },
    async trySolve(frame) {
      const metadata = await frame.evaluate(() => {
        if (!["auth.gmx.net", "mailset-root.gmx.net"].includes(location.hostname)) return null;
        const capture = window.__gmxCaptchaCapture;
        if (!capture) return null;
        const index = capture.widgets.findLastIndex((w) => w.element?.isConnected
          && w.sitekey && (typeof w.onVerify === "function" || typeof w.executeResolve === "function"));
        if (index < 0) return null;
        const apiServer = [...document.scripts].map((s) => s.src).find((src) => /captchafox.*\/api\.js(?:\?|$)/i.test(src));
        if (!apiServer) return null;
        return {
          documentId: capture.documentId, index, websiteKey: capture.widgets[index].sitekey,
          websiteURL: location.origin + location.pathname, userAgent: navigator.userAgent, apiServer,
        };
      }).catch(() => null);
      if (!metadata) return false;
      const attempt = `${metadata.documentId}:${metadata.index}`;
      const seen = attempts.get(frame) || new Set();
      if (seen.has(attempt)) return false;
      seen.add(attempt);
      attempts.set(frame, seen);

      try {
        log("Sending CaptchaFox challenge to AnySolver (one task; credentials hidden) ...");
        const created = await call("createTask", {
          task: { type: "CaptchaFoxToken", websiteURL: metadata.websiteURL,
            websiteKey: metadata.websiteKey, userAgent: metadata.userAgent, apiServer: metadata.apiServer, proxy },
          settings: { retry: { enabled: false }, fallback: { enabled: false }, analytics: false },
        });
        if (typeof created.taskId !== "string" || !created.taskId) throw new Error("MISSING_TASK_ID");
        const deadline = Date.now() + 31 * 60_000;
        let token;
        while (Date.now() < deadline) {
          await pause(2_000);
          const result = await call("getTaskResult", { taskId: created.taskId });
          if (result.status === "ready") {
            token = result.solution?.token;
            break;
          }
          if (result.status !== "processing") throw new Error("INVALID_STATUS");
        }
        if (typeof token !== "string" || !token) throw new Error("NO_SOLUTION");
        if (metadata.apiServer.includes("uicdn.com/") && !token.startsWith("MAM_")) throw new Error("WRONG_TOKEN_VARIANT");
        const delivered = await frame.evaluate(({ token, documentId, index }) => {
          const capture = window.__gmxCaptchaCapture;
          const widget = capture?.documentId === documentId && capture.widgets[index];
          if (!widget?.element?.isConnected) return false;
          if (capture.widgets.findLastIndex((w) => w.element?.isConnected && w.sitekey
            && (typeof w.onVerify === "function" || typeof w.executeResolve === "function")) !== index) return false;
          widget.deliveredToken = token;
          const response = widget.widgetId && document.getElementById(`cf-response-${widget.widgetId}`);
          if (response) response.value = token;
          if (typeof widget.executeResolve === "function") {
            widget.executeResolve(token);
            // Use the widget's own removal API to close the challenge. The app
            // still performs its normal authenticated save with the solved token.
            window.captchafox?.remove?.(widget.widgetId);
          } else if (typeof widget.onVerify === "function") widget.onVerify(token);
          else return false;
          return true;
        }, { token, documentId: metadata.documentId, index: metadata.index }).catch(() => false);
        if (!delivered) throw new Error("WIDGET_CHANGED");
        const cleared = await frame.waitForFunction(() => {
          const roots = [document];
          for (const root of roots) for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) roots.push(el.shadowRoot);
            if (!el.matches('#container-captcha, .cf-modal__wrap, .cf-modal__challenge')) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width && rect.height && getComputedStyle(el).visibility !== 'hidden') return false;
          }
          return true;
        }, { timeout: 15_000 }).then((handle) => handle.dispose().then(() => true)).catch(() => false);
        if (!cleared) throw new Error("CHALLENGE_NOT_CLEARED");
        log("CAPTCHA step cleared; continuing.");
        return true;
      } catch (error) {
        signal?.throwIfAborted();
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "SOLVER_ERROR";
        log(`AnySolver could not complete this challenge (${code}). Continue manually.`);
        return false;
      }
    },
  };
}

module.exports = { createCaptchaSolver, installCaptchaCapture, parseProxy };
