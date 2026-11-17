const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { createUiGuard, frameVisible, exposed } = require("./ui.cjs");

const SETTINGS = {
  gear: 'webmailer-mail-sidebar >>> button#settingsButton',
  receive: 'pierce/lux-sidebar-item[data-view="mailset-receive"]',
  pop: 'pierce/lux-sidebar-item[data-action="pop3Imap"][data-webdriver="POP3IMAP"]',
  input: 'pierce/input[data-webdriver="pop3imap-access-toggle"]',
  panel: 'pierce/section[data-section="pop3Imap"]',
};
const LIMIT = 120_000;

async function settingsFrame(browser) {
  for (const page of await browser.pages()) for (const frame of page.frames()) {
    try {
      if (new URL(frame.url()).hostname === "mailset-root.gmx.net" && await frameVisible(frame)) return frame;
    } catch { /* A navigation can replace the frame. */ }
  }
  return null;
}

async function enablePopImap(browser, { guard, solver, manualCaptcha = false, log = console.log, redact = String,
  signal, onStage = () => {}, screenshotPath = path.join(__dirname, "artifacts", "gmx-pop3-imap-enabled.png") } = {}) {
  guard ||= createUiGuard(browser, { log, redact, solver });
  const checkpoint = (step) => { signal?.throwIfAborted(); onStage(step); return guard.checkpoint(step, { manualCaptcha }); };
  const pendingSaves = new Set(), watchers = [];
  let lastChange = Date.now(), saveError = null;
  for (const page of await browser.pages()) {
    const started = (request) => {
      try {
        if (!["POST", "PUT", "PATCH"].includes(request.method())) return;
        if (new URL(request.frame().url()).hostname !== "mailset-root.gmx.net") return;
        if (!/(^|\.)gmx\.net$/.test(new URL(request.url()).hostname)) return;
        pendingSaves.add(request);
        lastChange = Date.now();
      } catch { /* Ignore frames being replaced by navigation. */ }
    };
    const finished = (request) => {
      if (!pendingSaves.delete(request)) return;
      lastChange = Date.now();
      if (request.failure() || request.response()?.status() >= 400) saveError = "A settings save request failed; persistence is not confirmed.";
    };
    page.on("request", started);
    page.on("requestfinished", finished);
    page.on("requestfailed", finished);
    watchers.push({ page, started, finished });
  }

  async function waitFor(description, operation, timeout = LIMIT) {
    let deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const before = Date.now();
      await checkpoint(description);
      // Manual verification must never consume the ordinary step timeout.
      deadline += Date.now() - before;
      const value = await operation().catch((error) => {
        if (/detached|context.*destroyed|Target closed|Cannot find context/i.test(error.message)) return null;
        throw error;
      });
      if (value !== null && value !== undefined && value !== false) return value;
      await sleep(250, undefined, { signal });
    }
    throw new Error(`Timed out waiting for ${description}.`);
  }

  async function retry(description, operation) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await checkpoint(description);
        return await operation();
      } catch (error) {
        log(`Settings step “${description}” failed (attempt ${attempt}/3): ${redact(error.message)}`);
        if (!browser.connected || signal?.aborted || error.code === "MANUAL_VERIFICATION_REQUIRED" || attempt === 3) throw error;
        log(`Retrying ${description} after checking the current page state ...`);
        await checkpoint(description);
        await sleep(500 * attempt, undefined, { signal });
      }
    }
  }

  async function clickElement(element, description) {
    try {
      await element.scrollIntoView();
      await waitFor(`${description} to be uncovered`, () => exposed(element), 30_000);
      await checkpoint(description);
      lastChange = Date.now();
      await element.click();
    } finally { await element.dispose().catch(() => {}); }
  }

  async function menuButton(frame, selector, buttonSelector = "pierce/button.label") {
    const host = await frame.$(selector);
    if (!host) return null;
    try { return await host.$(buttonSelector); }
    finally { await host.dispose(); }
  }

  async function openPanel() {
    const destination = await waitFor("the mailbox or settings iframe", async () => {
      const frame = await settingsFrame(browser);
      if (frame) return { frame };
      for (const page of await browser.pages()) for (const candidate of page.frames()) {
        let host;
        try { host = new URL(candidate.url()).hostname; } catch { continue; }
        if (host !== "webmailer.gmx.net" || !await frameVisible(candidate)) continue;
        const gear = await candidate.$(SETTINGS.gear);
        if (gear && await gear.isVisible()) return { gear };
        await gear?.dispose();
      }
      return null;
    });
    let frame = destination.frame;
    if (!frame) {
      log("Opening the settings gear at the bottom of the mailbox sidebar ...");
      await clickElement(destination.gear, "opening settings");
      frame = await waitFor("the settings iframe", () => settingsFrame(browser));
    }
    let pop = await menuButton(frame, SETTINGS.pop);
    const visible = pop && await pop.isVisible();
    await pop?.dispose();
    if (!visible) {
      log("Expanding E-Mail empfangen ...");
      await retry("expanding E-Mail empfangen", async () => {
        const current = await menuButton(frame, SETTINGS.pop);
        const expanded = current && await current.isVisible();
        await current?.dispose();
        if (expanded) return;
        const receive = await waitFor("E-Mail empfangen", async () =>
          await menuButton(frame, SETTINGS.receive, "pierce/button.collapse") || await menuButton(frame, SETTINGS.receive));
        await clickElement(receive, "expanding E-Mail empfangen");
        await waitFor("the expanded E-Mail empfangen menu", async () => {
          const button = await menuButton(frame, SETTINGS.pop);
          const ready = button && await button.isVisible();
          await button?.dispose();
          return ready;
        }, 8000);
      });
    }
    log("Opening POP3 / IMAP ...");
    pop = await waitFor("the POP3 / IMAP menu", async () => {
      const button = await menuButton(frame, SETTINGS.pop);
      if (button && await button.isVisible()) return button;
      await button?.dispose();
      return null;
    });
    await clickElement(pop, "opening POP3 / IMAP");
    await waitFor("the POP3 / IMAP switch", async () => {
      const input = await frame.$(SETTINGS.input);
      const visible = input && await input.isVisible();
      await input?.dispose();
      return visible;
    });
    return frame;
  }

  async function readSwitch() {
    const frame = await settingsFrame(browser);
    const input = frame && await frame.$(SETTINGS.input);
    if (!input) return null;
    try {
      return await input.evaluate((el) => {
        if (el.tagName !== "INPUT" || el.type !== "checkbox") throw new Error("Expected the native POP3 / IMAP checkbox.");
        return { checked: el.checked, disabled: el.disabled };
      });
    } finally { await input.dispose(); }
  }

  async function saveIfPresent() {
    const frame = await settingsFrame(browser);
    const panel = frame && await frame.$(SETTINGS.panel);
    if (!panel) return;
    try {
      // The live panel autosaves. Also handle an explicit save/confirmation
      // control if GMX renders one inside this exact settings panel.
      for (const button of await panel.$$("button")) {
        const save = await button.evaluate((el) => /^(Speichern|Änderungen speichern|Bestätigen|Save|Save changes|Confirm)$/i.test(el.textContent.trim()) && !el.disabled);
        if (save && await button.isVisible()) {
          log("Saving/confirming POP3 / IMAP access ...");
          await clickElement(button, "saving POP3 / IMAP access");
          await checkpoint("saving POP3 / IMAP access");
        } else await button.dispose();
      }
    } finally { await panel.dispose(); }
  }

  try {
    log("9. Checking POP3 / IMAP settings ...");
    await retry("opening POP3 / IMAP settings", openPanel);
    await checkpoint("reading the POP3 / IMAP switch");
    const initial = await readSwitch();
    if (!initial) throw new Error("The POP3 / IMAP switch disappeared before its state could be read.");
    log(`Actual POP3 / IMAP checked state: ${initial.checked}.`);
    if (initial.checked) log("POP3 / IMAP access is already enabled; leaving it enabled.");
    else {
      await retry("enabling POP3 / IMAP access", async () => {
        await openPanel();
        await checkpoint("enabling POP3 / IMAP access");
        const state = await readSwitch();
        if (state?.checked) return;
        const frame = await settingsFrame(browser);
        const input = await waitFor("the enabled activation control", async () => {
          const element = await frame.$(SETTINGS.input);
          if (element && !await element.evaluate((el) => el.disabled)) return element;
          await element?.dispose();
          return null;
        });
        log("Enabling POP3 / IMAP access; checking for CAPTCHA ...");
        await clickElement(input, "enabling POP3 / IMAP access");
        await waitFor("POP3 / IMAP access to become enabled", async () => {
          await saveIfPresent();
          const current = await readSwitch();
          return current?.checked ? current : null;
        }, 45_000);
      });
    }
    await checkpoint("confirming POP3 / IMAP access");
    await saveIfPresent();
    await waitFor("settings saves to finish", async () => pendingSaves.size === 0 && Date.now() - lastChange >= 800);
    if (saveError) throw new Error(saveError);

    await retry("refreshing and verifying saved POP3 / IMAP access", async () => {
      await checkpoint("refreshing saved settings");
      const frame = await settingsFrame(browser);
      if (!frame) throw new Error("The settings iframe disappeared before refresh.");
      log("Refreshing the settings frame to verify POP3 / IMAP access was saved ...");
      if (frame === frame.page().mainFrame()) await frame.page().reload({ waitUntil: "domcontentloaded", timeout: LIMIT });
      else await frame.goto(frame.url(), { waitUntil: "domcontentloaded", timeout: LIMIT });
      await openPanel();
      await checkpoint("verifying the switch after refresh");
      const persisted = await readSwitch();
      if (!persisted?.checked) throw new Error("POP3 / IMAP access is not enabled after refresh; persistence has not been verified.");
    });

    await checkpoint("saving the verified settings screenshot");
    const frame = await settingsFrame(browser);
    const panel = await frame.$(SETTINGS.panel);
    if (!panel) throw new Error("The verified settings panel was not available for a screenshot.");
    try {
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true, mode: 0o700 });
      await panel.screenshot({ path: screenshotPath, waitForFonts: false });
      await fs.chmod(screenshotPath, 0o600);
    } finally { await panel.dispose(); }
    const finalState = await readSwitch();
    if (!finalState?.checked) throw new Error("POP3 / IMAP state changed before the final screenshot could be verified.");
    log("POP3 / IMAP access verified enabled after refresh.");
    log(`Screenshot saved: ${screenshotPath}`);
    return { enabled: true, alreadyEnabled: initial.checked, screenshotPath };
  } finally {
    for (const { page, started, finished } of watchers) {
      page.off("request", started);
      page.off("requestfinished", finished);
      page.off("requestfailed", finished);
    }
  }
}

module.exports = { enablePopImap, settingsFrame, SETTINGS };
