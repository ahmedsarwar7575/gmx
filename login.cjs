const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const puppeteer = require("puppeteer");
const { createCaptchaSolver } = require("./captcha.cjs");
const { createUiGuard } = require("./ui.cjs");
const { enablePopImap, SETTINGS } = require("./settings.cjs");
const { frameVisible } = require("./ui.cjs");
const { openProxy } = require("./proxy.cjs");
const { checkProxyIp } = require("./proxy-ip.cjs");
const { captureFailure, clearScreenshots } = require("./artifacts.cjs");

require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

const TIMEOUT = process.env.ANYSOLVER_API_KEY && process.env.GMX_PROXY_URL ? 120_000 : 60_000;
const captchaSolvers = new WeakMap();
const uiGuards = new WeakMap();
const navigationRecovery = new WeakMap();
const runtimes = new WeakMap();
const SELECTORS = {
  consent: "button#save-all-pur",
  reloadConsent: "button.goToHPButton",
  // The icon renders while its account-manager iframe is still loading.
  // aria-expanded is added only after the avatar becomes interactive.
  avatar: 'account-avatar[aria-expanded]:not([aria-disabled="true"]) >>> .appa-user-icon',
  // The other button opens registration.
  login: 'account-avatar[aria-expanded="true"] >>> button.account-avatar__button:not(.lux-button-outline)',
  email: "input#input-username:not([readonly])",
  next: "button#button-next",
  // The shadow root also contains a checkbox: select the password input only.
  password: 'lux-password#input-password >>> input[type="password"]',
  // Confirmed against GMX's live passkey prompt.
  skipPasskey: ["::-p-text(Nein danke)", "::-p-text(No, thank you)"],
};

function createRedactor(secrets) {
  const values = [...secrets];
  for (const secret of secrets) {
    try { const url = new URL(secret); values.push(decodeURIComponent(url.username), decodeURIComponent(url.password)); } catch {}
  }
  return (value) => {
    let text = String(value);
    for (const secret of values.sort((a,b) => (b?.length || 0) - (a?.length || 0))) if (secret) text = text.split(secret).join("[redacted]");
    return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
      .replace(/https?:\/\/[^\s"'<>]+/g, (url) => { try { return new URL(url).origin; } catch { return "[URL redacted]"; } });
  };
}
const redact = (value) => createRedactor([process.env.EMAIL, process.env.PASSWORD, process.env.ANYSOLVER_API_KEY, process.env.GMX_PROXY_URL])(value);

async function recoverNavigation(browser, page, code) {
  const runtime = runtimes.get(browser) || { log: console.log, redact };
  const recovery = navigationRecovery.get(browser);
  const target = recovery?.lastGet.get(page);
  if (!target || !/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE/.test(code)) return false;
  const attempt = (recovery.attempts.get(target) || 0) + 1;
  if (attempt > 3) return false;
  recovery.attempts.set(target, attempt);
  const delay = Math.max(attempt * 3000, recovery.solver?.getRetryDelay() || 0);
  runtime.log(`Retrying GET navigation to ${new URL(target).origin} in ${delay / 1000}s (attempt ${attempt}/3).`);
  await sleep(delay, undefined, { signal: runtime.signal });
  try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: TIMEOUT }); }
  catch (error) { runtime.log(`Navigation retry did not finish: ${runtime.redact(error.message)}`); }
  return true;
}

function gmxAddress(frame) {
  try {
    const url = new URL(frame.url());
    if (url.protocol === "https:" && /(^|\.)gmx\.net$/.test(url.hostname)) return url;
  } catch {
    // Ignore about:blank and frames being replaced by navigation.
  }
  return null;
}

function rememberNavigation(recovery, page, request) {
  try {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    const url = new URL(request.url());
    const trusted = url.protocol === "https:" && (/(^|\.)gmx\.net$/.test(url.hostname) || url.hostname === "gmx.netid.de");
    if (request.method() === "GET" && trusted) recovery.lastGet.set(page, request.url());
    else recovery.lastGet.delete(page);
  } catch { recovery.lastGet.delete(page); }
}

async function frames(browser) {
  return (await browser.pages()).filter((page) => !page.isClosed()).flatMap((page) => page.frames());
}

async function findElement(browser, selectors, hosts) {
  for (const frame of await frames(browser)) {
    const address = gmxAddress(frame);
    if (!address || (hosts && !hosts.includes(address.hostname))) continue;
    for (const selector of selectors) {
      let element;
      try {
        element = await frame.$(selector);
        if (!element || !await element.isVisible()) continue;
        if (selector === SELECTORS.reloadConsent) {
          // GMX keeps this error control underneath its loading iframe, even
          // with positive dimensions. Retry only when it is actually exposed.
          const exposed = await element.evaluate((el) => {
            for (let node = el; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              if (style.opacity === "0" || style.visibility === "hidden" || style.display === "none") return false;
            }
            const rect = el.getBoundingClientRect();
            const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return top === el || el.contains(top);
          });
          if (!exposed) continue;
        }
        return { frame, selector };
      } catch {
        // Navigation may detach a frame during inspection.
      } finally {
        await element?.dispose().catch(() => {});
      }
    }
  }
  return null;
}

async function inspectState(frame, address) {
  const isLogin = address.hostname === "auth.gmx.net";
  const isVerification = ["obligation.gmx.net", "assistent.gmx.net"].includes(address.hostname);
  const isWebmailer = address.hostname === "webmailer.gmx.net";
  const isMailbox = isWebmailer || /^\/mail\/client(?:[;/]|$)/.test(address.pathname);
  if (!isLogin && !isVerification && !isMailbox) return {};

  return frame.evaluate(({ isLogin, isVerification, isMailbox, isWebmailer }) => {
    if (!document.body) return {};
    const visible = (el) => el.getBoundingClientRect().width > 0
      && el.getBoundingClientRect().height > 0
      && getComputedStyle(el).visibility !== "hidden";
    const roots = [document];
    const elements = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        elements.push(el);
      }
    }

    if (elements.some((el) => el.matches('.cf-modal__wrap, .cf-modal__challenge, #container-captcha, [data-testid="captcha-container"]') && visible(el))) {
      return { challenge: "CAPTCHA" };
    }
    if (elements.some((el) => el.getAttribute("autocomplete") === "one-time-code" && visible(el))) {
      return { challenge: "2FA / identity verification" };
    }

    // The live navigator embeds webmailer.gmx.net with nested sidebar shadows.
    // Verify navigation controls without reading message contents.
    if (isMailbox) {
      const controls = elements.filter((el) => ["A", "BUTTON"].includes(el.tagName)
        || ["treeitem", "tab"].includes(el.getAttribute("role")));
      const inbox = controls.some((el) =>
        /^(Posteingang|Inbox)(?:\s*\(\d+\))?$/i.test(el.textContent.trim())
        && visible(el));
      const compose = !isWebmailer || controls.some((el) =>
        /^(E-Mail schreiben|Compose|Compose email)$/i.test(el.textContent.trim())
        && visible(el));
      return { mailbox: inbox && compose };
    }

    const text = document.body.innerText;
    if (isVerification) {
      return { challenge: "GMX phone-number recovery / identity verification" };
    }
    if (elements.some((el) => el.id === "container-captcha" && visible(el))) {
      return { challenge: "CAPTCHA" };
    }
    if (/Zwei-Faktor|Zwei-Schritt|Bestätigungscode|Sicherheitscode|Authentifizierungscode|two.factor|two.step|verification code|confirm your identity|Identität bestätigen/i.test(text)
      || elements.some((el) => el.getAttribute("autocomplete") === "one-time-code" && visible(el))) {
      return { challenge: "2FA / identity verification" };
    }
    if (isLogin) {
      const error = elements.find((el) =>
        (el.getAttribute("role") === "alert" || el.classList.contains("lux-form-message-error"))
        && visible(el) && el.textContent.trim());
      if (error) return { error: error.textContent.trim() };
    }
    return {};
  }, { isLogin, isVerification, isMailbox, isWebmailer });
}

// Search every open tab and frame; navigation or a popup needs no guessed URL.
async function waitFor(browser, description, selectors, { hosts, mailbox = false, settingsReady = false } = {}) {
  const runtime = runtimes.get(browser) || { log: console.log, redact };
  let deadline = Date.now() + TIMEOUT;
  let paused = false;
  while (Date.now() < deadline) {
    runtime.signal?.throwIfAborted();
    if (!browser.connected) throw new Error("The browser was closed before login was verified.");
    const before = Date.now();
    await uiGuards.get(browser)?.checkpoint(description);
    deadline += Date.now() - before;
    let challenge;
    let connectionError;
    for (const frame of await frames(browser)) {
      if (frame === frame.page().mainFrame() && frame.url().startsWith("chrome-error:")) {
        const code = await frame.evaluate(() => document.body?.innerText.match(/ERR_[A-Z_]+/)?.[0] || null).catch(() => null)
          || navigationRecovery.get(browser)?.failureCodes?.get(frame.page()) || "BROWSER_CONNECTION_ERROR";
        connectionError = { code, page: frame.page() };
        continue;
      }
      const address = gmxAddress(frame);
      if (!address) continue;
      // The gear is usable before the inbox has finished loading. Do not wait
      // for message lists, unrelated resources, or network idleness.
      if (settingsReady && address.hostname === "webmailer.gmx.net" && await frameVisible(frame)) {
        const gear = await frame.$(SETTINGS.gear).catch(() => null);
        const ready = gear && await gear.isVisible();
        await gear?.dispose();
        if (ready) return { settingsReady: true };
      }
      const state = await inspectState(frame, address).catch(() => ({}));
      if (state.error) throw new Error(`GMX reported: ${runtime.redact(state.error)}`);
      if (mailbox && state.mailbox) return { mailbox: true };
      if (state.challenge) challenge = { frame, kind: state.challenge };
    }
    if (challenge) {
      const solver = captchaSolvers.get(browser);
      if (challenge.kind === "CAPTCHA" && solver && await solver.trySolve(challenge.frame)) {
        deadline = Date.now() + TIMEOUT;
        continue;
      }
      if (runtime.headless) {
        const error = new Error(`Manual ${challenge.kind} required. Retry this account with visible Chrome.`);
        error.code = "MANUAL_VERIFICATION_REQUIRED";
        throw error;
      }
      if (!paused) {
        runtime.onPause?.(challenge.kind);
        runtime.log(`Paused for ${challenge.kind}. Complete it manually in the browser.`);
        runtime.log("Automation resumes when verification clears. Press Ctrl+C to stop.");
        await challenge.frame.page().bringToFront();
        paused = true;
      }
      // Manual verification has no automation timeout.
      deadline = Date.now() + TIMEOUT;
    } else {
      if (paused) {
        runtime.log("Verification cleared; resuming.");
        runtime.onResume?.(description);
        paused = false;
        deadline = Date.now() + TIMEOUT;
      }
      const found = await findElement(browser, selectors, hosts);
      if (found) return found;
      if (connectionError) {
        if (await recoverNavigation(browser, connectionError.page, connectionError.code)) {
          deadline = Date.now() + TIMEOUT;
          continue;
        }
        throw new Error(`Chrome reported ${connectionError.code}. Check network/proxy access to GMX's login site.`);
      }
    }
    await sleep(250, undefined, { signal: runtime.signal });
  }
  // Origins only: URLs may contain usernames or authentication/session tokens.
  const origins = [...new Set((await frames(browser)).map(gmxAddress).filter(Boolean).map((url) => url.origin))];
  throw new Error(`Timed out waiting for ${description}. Open GMX origins: ${origins.join(", ") || "none"}.`);
}

async function click(browser, description, selector, hosts) {
  const match = await waitFor(browser, description, [selector], { hosts });
  await match.frame.page().bringToFront();
  await match.frame.locator(match.selector).click();
}

async function main({ afterLogin = enablePopImap, email = process.env.EMAIL, password = process.env.PASSWORD,
  proxyUrl = process.env.GMX_PROXY_URL, apiKey = process.env.ANYSOLVER_API_KEY, headless = false,
  onLog = console.log, onStage = () => {}, onPause = () => {}, onResume = () => {}, signal,
  screenshotPath = path.join(__dirname, "artifacts", "gmx-pop3-imap-enabled.png"), closeDelayMs = 10_000 } = {}) {
  const secrets = [email, password, proxyUrl, apiKey];
  const hide = createRedactor(secrets);
  const log = (message) => onLog(hide(message));
  let step = "checking configuration", browser, proxy, solver, artifact, result;
  const stage = (value) => { step = value; onStage(value); signal?.throwIfAborted(); };
  let capturing;
  const capture = () => capturing ||= captureFailure(browser, screenshotPath, { message: signal?.aborted ? "Stopped by user." : "Automation failed. See the task log for details.", stage: step, secrets });
  const abort = () => { capture().finally(() => browser?.close().catch(() => {})); };
  try {
    stage(step);
    if (!email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Provide a full EMAIL address and PASSWORD.");
    solver = createCaptchaSolver({ ANYSOLVER_API_KEY: apiKey, GMX_PROXY_URL: proxyUrl }, { log, signal });
    if (solver) {
      log("Checking AnySolver API access and balance ...");
      await solver.checkAccount();
    }
    stage("launching Chrome");
    proxy = await openProxy(proxyUrl, log);
    signal?.throwIfAborted();
    browser = await puppeteer.launch({ headless,
      defaultViewport: headless ? { width: 1440, height: 1000 } : null,
      args: ["--start-maximized", ...(process.platform === "linux" && process.env.DISPLAY ? ["--ozone-platform=x11"] : []),
        ...(proxy.argument ? [proxy.argument] : [])],
    });
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    const runtime = { log, redact: hide, signal, headless, onPause, onResume };
    runtimes.set(browser, runtime);
    if (solver) captchaSolvers.set(browser, solver);
    const guard = createUiGuard(browser, { ...runtime, skipLoginCaptcha: !!solver, solver });
    uiGuards.set(browser, guard);
    const page = (await browser.pages())[0] || await browser.newPage();
    const recovery = { lastGet: new WeakMap(), attempts: new Map(), failureCodes: new WeakMap(), solver: proxy };
    navigationRecovery.set(browser, recovery);
    const prepare = async (tab) => {
      tab.on("request", (request) => rememberNavigation(recovery, tab, request));
      tab.on("requestfailed", (request) => {
        if (!request.isNavigationRequest() || request.frame() !== tab.mainFrame()) return;
        try {
          const code = request.failure()?.errorText?.match(/ERR_[A-Z_]+/)?.[0] || "NETWORK_ERROR";
          recovery.failureCodes.set(tab, code);
          log(`Navigation to ${new URL(request.url()).origin} failed (${code}).`);
        } catch {}
      });
      tab.setDefaultTimeout(TIMEOUT);
      if (solver) await solver.preparePage(tab);
    };
    await prepare(page);
    browser.on("targetcreated", (target) => {
      if (target.type() === "page") target.page().then((tab) => tab && prepare(tab)).catch(() => {});
    });
    if (proxy.argument) {
      stage("checking proxy public IP");
      const ip = await checkProxyIp(page, { log, signal });
      const message = ip ? `Proxy public IP: ${ip}` : 'Proxy public IP unavailable. Continuing to GMX with the configured proxy.';
      log(message);
      if (onLog !== console.log) console.log(`[IMAP / POP3] ${message}`);
    }
    stage("opening GMX and handling consent");
    log("1. Opening https://www.gmx.net/ ...");
    try { await page.goto("https://www.gmx.net/", { waitUntil: "domcontentloaded", timeout: TIMEOUT }); }
    catch (error) { if (!await recoverNavigation(browser, page, error.message)) throw error; }
    let start;
    for (let attempt = 0; attempt < 2; attempt++) {
      start = await waitFor(browser, "cookie consent or the avatar", [SELECTORS.consent, SELECTORS.avatar, SELECTORS.reloadConsent], {
        hosts: ["www.gmx.net", "plus.gmx.net", "dl.gmx.net"],
      });
      if (start.selector !== SELECTORS.reloadConsent) break;
      if (attempt === 1) throw new Error("GMX could not load cookie consent after a reload. Check the proxy connection.");
      log("GMX consent failed to load; retrying its reload button once ...");
      await Promise.all([start.frame.page().waitForNavigation({ waitUntil: "domcontentloaded", timeout: TIMEOUT }), start.frame.locator(start.selector).click()]);
    }
    if (start.selector === SELECTORS.consent) {
      log("2. Accepting cookie consent in the nested consent iframe ...");
      await start.frame.locator(start.selector).click();
    } else log("2. No cookie consent needed.");
    stage("opening the account menu");
    log("3. Opening the user avatar ...");
    await click(browser, "the avatar", SELECTORS.avatar, ["www.gmx.net"]);
    stage("opening Login");
    log("4. Clicking Login ...");
    await click(browser, "Login in the account menu", SELECTORS.login, ["www.gmx.net"]);
    stage("entering email");
    log("5. Entering email (hidden) ...");
    const username = await waitFor(browser, "the email input", [SELECTORS.email], { hosts: ["auth.gmx.net"] });
    await username.frame.locator(username.selector).fill(email);
    stage("continuing to the password step");
    log("6. Clicking Weiter ...");
    await click(browser, "Weiter", SELECTORS.next, ["auth.gmx.net"]);
    stage("entering password");
    const passwordInput = await waitFor(browser, "the password input", [SELECTORS.password], { hosts: ["auth.gmx.net"] });
    log("7. Entering password in lux-password's shadow input (hidden) ...");
    await passwordInput.frame.locator(passwordInput.selector).fill(password);
    stage("submitting Login and handling verification");
    log("8. Submitting Login ...");
    await click(browser, "the Login submit button", SELECTORS.next, ["auth.gmx.net"]);
    const ready = await waitFor(browser, "the passkey prompt or settings gear", SELECTORS.skipPasskey, { hosts: ["auth.gmx.net"], settingsReady: true });
    if (!ready.settingsReady) {
      log("Declining optional passkey setup ...");
      await ready.frame.locator(ready.selector).click();
      await waitFor(browser, "the settings gear after skipping passkey setup", [], { settingsReady: true });
    }
    log("Login verified: authenticated mailbox sidebar and settings gear are visible.");
    stage("opening POP3 / IMAP settings");
    if (afterLogin) result = await afterLogin(browser, { guard, solver, log, redact: hide, screenshotPath, signal, onStage: stage });
    else {
      artifact = await captureFailure(browser, screenshotPath, { stage: "Login verified", secrets });
      result = { screenshotPath: artifact.path, artifactKind: artifact.kind };
    }
    stage("complete");
    if (closeDelayMs > 0) { log(`Waiting ${closeDelayMs / 1000} seconds before closing ...`); await sleep(closeDelayMs, undefined, { signal }); }
    return { ...result, artifactKind: result.artifactKind || "screenshot" };
  } catch (error) {
    artifact = await capture();
    const failure = new Error(signal?.aborted ? "Stopped by user." : `Failed while ${step}: ${hide(error.message)}`);
    Object.assign(failure, { code: signal?.aborted ? "CANCELLED" : error.code, step, screenshotPath: artifact.path, artifactKind: artifact.kind });
    throw failure;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (capturing) await capturing;
    if (browser) await browser.close().catch(() => {});
    await proxy?.close().catch(() => {});
    log("Browser closed.");
  }
}

if (require.main === module) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  clearScreenshots().then(() => main({ signal: controller.signal })).catch((error) => {
    console.error(`Login automation failed: ${redact(error.message)}`);
    if (error.screenshotPath) console.error(`Result image: ${error.screenshotPath}`);
    process.exitCode = error.code === "CANCELLED" ? 130 : 1;
  });
}

module.exports = { main, findElement, waitFor, inspectState, SELECTORS, redact, createRedactor, rememberNavigation };
