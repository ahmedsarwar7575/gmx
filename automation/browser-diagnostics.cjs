const { withDeadline } = require('../async-control.cjs');

function readFingerprint() {
  const webdriver = navigator.webdriver;
  return {
    origin: location.origin,
    documentId: performance.timeOrigin,
    readyState: document.readyState,
    ua: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: [...navigator.languages],
    webdriver: webdriver === undefined ? null : webdriver,
    webdriverType: typeof webdriver,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
  };
}

async function auditPage(page, { log = () => {}, stage = 'document', timeoutMs = 1000 } = {}) {
  const emit = message => { try { log(message); } catch { /* Diagnostics never change the workflow. */ } };
  try {
    const fp = await withDeadline(() => page.evaluate(readFingerprint), timeoutMs, 'BROWSER_DIAGNOSTIC_TIMEOUT');
    emit(`Fingerprint: ${JSON.stringify({ stage, ...fp })}`);
    if (fp.webdriver === true) emit('[WARN] Fingerprint reports navigator.webdriver=true.');
    return fp;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'EVALUATION_FAILED';
    emit(`Fingerprint audit (${stage}) unavailable (${code}).`);
    return null;
  }
}

module.exports = { auditPage, readFingerprint };
