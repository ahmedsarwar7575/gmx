const { setTimeout: sleep } = require("node:timers/promises");

const UI_HOSTS = new Set([
  "www.gmx.net", "auth.gmx.net", "navigator.gmx.net", "webmailer.gmx.net", "plus.gmx.net",
  "mailset-root.gmx.net", "assistent.gmx.net", "obligation.gmx.net", "gmx.netid.de", "bap.navigator.gmx.net",
]);

// This runs inside the page, including its open shadow roots. CaptchaFox's
// outer modal has zero dimensions; its visible wrap is the actual challenge.
function inspectUi({ returnDismiss = false } = {}) {
  const roots = [document], elements = [];
  for (const root of roots) for (const el of root.querySelectorAll("*")) {
    elements.push(el);
    if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  const parent = (el) => el.parentElement || el.getRootNode()?.host;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let node = el; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      if (node.tagName === "DIALOG" && !node.open) return false;
    }
    return true;
  };
  const captcha = elements.find((el) => el.matches(
    '.cf-modal__wrap, .cf-modal__challenge, #container-captcha, [data-testid="captcha-container"], .g-recaptcha, .h-captcha'
  ) && visible(el));
  if (captcha) return returnDismiss ? null : { kind: "CAPTCHA" };
  const code = elements.find((el) => el.matches('input[autocomplete="one-time-code"]') && visible(el));
  if (code) return returnDismiss ? null : { kind: "2FA" };

  const dialogs = elements.filter((el) =>
    (el.matches('dialog[open], [role="alertdialog"], [role="dialog"][aria-modal="true"]')
      || el.tagName === "LUX-DIALOG" && el.open) && visible(el));
  if (!dialogs.length) return returnDismiss ? null : null;
  const dialog = dialogs[0];
  const contains = (el) => {
    const dialogHost = dialog.tagName === "DIALOG" ? dialog.getRootNode().host : null;
    for (let node = el; node; node = parent(node)) {
      if (node === dialog || node === dialogHost) return true;
    }
    return false;
  };
  const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
  const safeLabels = /^(Schließen|Schliessen|Jetzt nicht|Nicht jetzt|Später|Vielleicht später|Überspringen|Nein danke|Close|Not now|Later|No, thank you)$/i;
  const dismiss = elements.find((el) => el.tagName === "BUTTON" && contains(el) && visible(el)
    && !el.disabled && safeLabels.test(label(el)));
  if (returnDismiss) return dismiss || null;
  const title = dialog.getAttribute("headline") || dialog.getRootNode().host?.getAttribute("headline")
    || dialog.getAttribute("aria-label") || dialog.querySelector("h1,h2,h3")?.textContent || "Dialog";
  return { kind: "popup", title: title.trim().slice(0,160), dismissLabel: dismiss ? label(dismiss) : null };
}

async function frameVisible(frame) {
  for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
    let element;
    try {
      element = await current.frameElement();
      if (!await element.isVisible()) return false;
      const exposed = await element.evaluate((el) => {
        for (let node = el; node; node = node.parentElement || node.getRootNode()?.host) {
          const s = getComputedStyle(node);
          if (s.opacity === "0" || s.visibility === "hidden" || s.display === "none") return false;
        }
        return true;
      });
      if (!exposed) return false;
    } catch { return false; }
    finally { await element?.dispose().catch(() => {}); }
  }
  return true;
}

async function exposed(element) {
  return element.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let node = el; node; node = node.parentElement || node.getRootNode()?.host) {
      const s = getComputedStyle(node);
      if (s.opacity === "0" || s.visibility === "hidden" || s.display === "none") return false;
    }
    let root = el.getRootNode();
    let hit = root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    while (hit?.shadowRoot) {
      const child = hit.shadowRoot.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!child || child === hit) break;
      hit = child;
    }
    // lux-sidebar-item handles its label's click on the containing item.
    // GMX can hit-test that container rather than the visual label button.
    const sidebarItem = el.matches("button.label") && el.getRootNode().host?.tagName === "LUX-SIDEBAR-ITEM"
      && hit?.classList.contains("item") && hit.contains(el);
    return hit === el || el.contains(hit) || !!sidebarItem;
  });
}

function createUiGuard(browser, { log = console.log, redact = String, skipLoginCaptcha = false, solver, headless = false, signal, onPause = () => {}, onResume = () => {} } = {}) {
  let paused = null;
  let dismissed = 0;
  let blockedDismiss = 0;
  const consentAttempts = new WeakMap();
  return {
    async checkpoint(step, { manualCaptcha = false } = {}) {
      while (true) {
        signal?.throwIfAborted();
        if (!browser.connected) throw new Error("Browser closed during verification.");
        let active, consentCleared = false;
        for (const page of await browser.pages()) for (const frame of page.frames()) {
          let host;
          try { host = new URL(frame.url()).hostname; } catch { continue; }
          if (!UI_HOSTS.has(host) || !await frameVisible(frame)) continue;
          // GMX may ask again after login, above the authenticated settings UI.
          // This is the same nested consent button inspected on the live site.
          if (host === "plus.gmx.net") {
            const accept = await frame.$("button#save-all-pur");
            try {
              if (accept && await accept.isVisible() && await exposed(accept)) {
                const attempts = (consentAttempts.get(frame) || 0) + 1;
                if (attempts > 3) throw new Error("GMX cookie consent stayed open after three attempts. Check the proxy connection.");
                consentAttempts.set(frame, attempts);
                log(`Accepting GMX cookie consent during ${step}.`);
                await accept.click();
                await frame.waitForFunction(() => {
                  const button = document.querySelector("button#save-all-pur");
                  return !button || !button.getBoundingClientRect().width || getComputedStyle(button).visibility === "hidden";
                }, { timeout: 5000 }).then(handle => handle.dispose()).catch(() => {});
                consentCleared = true;
              }
            } finally { await accept?.dispose().catch(() => {}); }
            if (consentCleared) break;
          }
          const state = await frame.evaluate(inspectUi).catch(() => null);
          if (!state) continue;
          if (state.kind === "CAPTCHA" && host === "auth.gmx.net" && skipLoginCaptcha && !manualCaptcha) continue;
          if (state.kind === "CAPTCHA" || state.kind === "2FA") { active = { frame, state }; break; }
          if (!active) active = { frame, state };
        }
        if (consentCleared) { await sleep(250, undefined, { signal }); continue; }
        if (!active) {
          if (paused) { log(`Verification/popup cleared; resuming ${step}.`); onResume(step); }
          paused = null;
          blockedDismiss = 0;
          return;
        }
        const { frame, state } = active;
        if (state.kind === "CAPTCHA" && solver && !manualCaptcha && await solver.trySolve(frame)) continue;
        if (state.kind === "popup" && state.dismissLabel && dismissed < 10 && blockedDismiss < 3) {
          const handle = await frame.evaluateHandle(inspectUi, { returnDismiss: true });
          const button = handle.asElement();
          try {
            if (button && await exposed(button)) {
              log(`Dismissing optional popup with “${redact(state.dismissLabel)}”.`);
              await button.click();
              dismissed++;
              blockedDismiss = 0;
            } else blockedDismiss++;
          } catch { blockedDismiss++; }
          finally { await handle.dispose().catch(() => {}); }
        } else {
          if (headless) {
            const error = new Error(`Manual ${state.kind} verification required during ${step}. Run this account in visible Chrome to continue.`);
            error.code = "MANUAL_VERIFICATION_REQUIRED";
            throw error;
          }
          const key = `${state.kind}:${state.title || ""}`;
          if (paused !== key) {
            log(`Paused during ${step}: ${state.kind}${state.title ? ` (${redact(state.title)})` : ""}. Complete/dismiss it manually in the browser.`);
            log("The browser stays open. Automation resumes automatically; Ctrl+C stops it.");
            await frame.page().bringToFront();
            paused = key;
            onPause(`${state.kind}: ${step}`);
          }
        }
        await sleep(250, undefined, { signal });
      }
    },
  };
}

module.exports = { createUiGuard, inspectUi, frameVisible, exposed };
