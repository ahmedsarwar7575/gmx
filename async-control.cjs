function abortable(work, { signal, onLateResult } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { if (!settled) { settled = true; cleanup(); reject(signal.reason || new Error('Stopped')); } };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); }).then(value => {
      if (settled) { if (onLateResult) Promise.resolve().then(() => onLateResult(value)).catch(() => {}); return; }
      settled = true; cleanup(); resolve(value);
    }, error => { if (!settled) { settled = true; cleanup(); reject(error); } });
  });
}

async function withDeadline(work, timeoutMs = 20_000, code = 'CLEANUP_TIMEOUT') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Operation exceeded its cleanup deadline.'), { code })), timeoutMs);
  try { return await abortable(work, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function killOwnedBrowser(browser) {
  const child = browser?.process?.();
  if (child && child.exitCode == null && !child.killed) child.kill('SIGKILL');
}

async function closeOwnedBrowser(browser, timeoutMs = 20_000) {
  if (!browser) return;
  try { await withDeadline(() => browser.close(), timeoutMs); }
  catch (error) { killOwnedBrowser(browser); throw error; }
}

module.exports = { abortable, withDeadline, killOwnedBrowser, closeOwnedBrowser };
