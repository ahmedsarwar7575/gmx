const { isIP } = require('node:net');

async function checkProxyIp(page, { log = () => {}, signal } = {}) {
  const options = { waitUntil: 'domcontentloaded', timeout: 30_000 };
  const services = [
    { url: 'https://api.ipify.org?format=json', json: true },
    { url: 'https://checkip.amazonaws.com/', json: false },
  ];
  for (const [index, service] of services.entries()) {
    // The same authenticated Chrome page keeps every check on the configured
    // proxy. Refresh only the initial read; there is no direct-network fallback.
    for (let attempt = 0; attempt < (index === 0 ? 2 : 1); attempt++) {
      signal?.throwIfAborted();
      try {
        const response = attempt ? await page.reload(options) : await page.goto(service.url, options);
        signal?.throwIfAborted();
        if (!response?.ok()) {
          const status = Number(response?.status());
          throw Object.assign(new Error('IP service unavailable'), { code: status >= 100 && status <= 599 ? `HTTP_${status}` : 'NO_RESPONSE' });
        }
        const body = await page.evaluate(() => document.body?.innerText || '');
        signal?.throwIfAborted();
        let ip;
        try { ip = service.json ? JSON.parse(body).ip : body.trim(); } catch {}
        if (typeof ip !== 'string' || !isIP(ip)) throw Object.assign(new Error('Invalid IP service response'), { code: 'INVALID_RESPONSE' });
        return ip;
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.name === 'AbortError' || page.isClosed?.() || /Target closed|Session closed|browser.*disconnected/i.test(error?.message || '')) throw error;
        // Never log response bodies, credentials, or an arbitrary error message.
        const network = String(error?.message || '').match(/\bnet::(ERR_[A-Z_]+)/)?.[1];
        const code = error?.name === 'TimeoutError' ? 'NAVIGATION_TIMEOUT' : network
          || (/^(HTTP_\d{3}|NO_RESPONSE|INVALID_RESPONSE)$/.test(error?.code || '') ? error.code : 'NETWORK_ERROR');
        const retry = index === 0 && attempt === 0 && (network || ['NAVIGATION_TIMEOUT', 'NETWORK_ERROR'].includes(code));
        log(`Proxy IP check at ${new URL(service.url).hostname} failed (${code}). ${retry ? 'Refreshing once...' : index === 0 ? 'Trying the fallback IP service...' : 'IP address could not be confirmed.'}`);
        if (!retry) break;
      }
    }
  }
  signal?.throwIfAborted();
  return null;
}

module.exports = { checkProxyIp };
