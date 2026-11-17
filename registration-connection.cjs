const { parseProxies } = require('./inputs.cjs');
const { parseProxy } = require('./proxy.cjs');

function registrationConnection(options = { mode: 'maskify' }) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || !['maskify', 'proxy'].includes(options.mode)) {
    throw new Error('Choose Maskify API or HTTP proxy. Direct connections are disabled.');
  }
  if (options.mode !== 'proxy') {
    if (options.proxyText) throw new Error('Proxy uploads require HTTP proxy mode.');
    return { mode: options.mode, proxy: null };
  }
  if (typeof options.proxyText !== 'string' || !options.proxyText.trim() || Buffer.byteLength(options.proxyText) > 4096) {
    throw new Error('Upload one HTTP proxy in a TXT file, up to 4 KB.');
  }
  const proxies = parseProxies(options.proxyText);
  if (proxies.length !== 1) throw new Error('The TXT file must contain exactly one HTTP proxy.');
  const parsed = parseProxy(proxies[0]);
  return { mode: 'proxy', proxy: { ...parsed, url: proxies[0],
    argument: `--proxy-server=${parsed.type}://${parsed.host}:${parsed.port}` } };
}

module.exports = { registrationConnection };
