const https = require('node:https');
const { setTimeout: delay } = require('node:timers/promises');

const BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
const READ_ACTIONS = new Set(['getBalance', 'getCountries', 'getStatus', 'getStatusV2', 'getOperators', 'getServicesList']);
const PROVIDER_CODES = new Set(['NO_BALANCE', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS', 'PAYMENT_REQUIRED',
  'NO_NUMBERS', 'BAD_KEY', 'BAD_SERVICE', 'BAD_ACTION', 'BAD_STATUS', 'BAD_COUNTRY', 'ACCESS_DENIED', 'BANNED']);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID']);

function requestApi(url, { signal }) {
  return new Promise((resolve, reject) => {
    // Native HTTPS over IPv4 avoids the fetch/Undici connect timeouts seen on
    // this host. Use normal TLS certificate verification.
    const request = https.request(url, { method: 'GET', family: 4, signal }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('aborted', () => reject(Object.assign(new Error('Response interrupted'), { code: 'ECONNRESET' })));
      response.on('end', () => resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        text: async () => body,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function failureCode(error) {
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) return `HTTP_${error.httpStatus}`;
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') return 'TIMEOUT';
  const code = error?.cause?.code || error?.code;
  return NETWORK_CODES.has(code) ? code : 'NETWORK_ERROR';
}

function providerErrorCode(data) {
  return [data, data?.code, data?.errorCode, data?.error_code, data?.error, data?.title,
    data?.info?.code, data?.error?.code].find(value => PROVIDER_CODES.has(value));
}

function createHeroSmsClient({ requestImpl = requestApi, wait = delay, log = console.error } = {}) {
  return async function heroSMS(action, params = {}, { signal } = {}) {
    const apiKey = process.env.HEROSMS_API_KEY?.trim();
    if (!apiKey) throw new Error('Missing HEROSMS_API_KEY');
    signal?.throwIfAborted();
    const url = new URL(BASE_URL);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    // A lost purchase response can already have charged the account. Retry
    // reads only; never automatically submit a number purchase twice.
    const maxAttempts = READ_ACTIONS.has(action) ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const timeout = AbortSignal.timeout(30_000);
        const response = await requestImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        const text = (await response.text()).trim();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (!response.ok) throw Object.assign(new Error('HTTP error'), { httpStatus: response.status, providerCode: providerErrorCode(data) });
        return data;
      } catch (error) {
        signal?.throwIfAborted();
        const code = failureCode(error);
        const providerCode = PROVIDER_CODES.has(error?.providerCode) ? error.providerCode : undefined;
        // Never echo the API URL, provider body, key, phone number or SMS.
        log(`HeroSMS ${action} request failed (${code}${providerCode ? `; ${providerCode}` : ''}; attempt ${attempt}/${maxAttempts}).`);
        const retryable = !error?.httpStatus || error.httpStatus === 429 || error.httpStatus >= 500;
        if (attempt === maxAttempts || !retryable) {
          const paymentHint = code === 'HTTP_402' ? ' HeroSMS rejected payment; check your available balance and the selected operator price.' : '';
          throw Object.assign(new Error(`HeroSMS ${action} failed (${code}).${paymentHint}`), {
            code, httpStatus: error?.httpStatus, providerCode,
          });
        }
        await wait(attempt * 2000, undefined, { signal });
      }
    }
  };
}

module.exports = { createHeroSmsClient };
