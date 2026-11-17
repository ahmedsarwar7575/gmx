const crypto = require("node:crypto");

function createMaskifyProxy(env = process.env, { optional = false } = {}) {
  const baseUsername = env.MASKIFY_USERNAME?.trim();
  const password = env.MASKIFY_PASSWORD;
  if (optional && !baseUsername && !password) return null;
  if (!baseUsername || !password) {
    throw new Error("Missing Maskify credentials in .env");
  }
  const host = env.MASKIFY_HOST?.trim() || 'resi.maskify.su';
  const port = String(env.MASKIFY_PORT || '80').trim();
  let url;
  try { url = new URL(`http://${host}:${port}`); } catch { throw new Error('Invalid Maskify host or port in .env'); }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !url.hostname
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid Maskify host or port in .env');
  }
  const sessionId = crypto.randomBytes(6).toString("hex");
  const country = 'DE', ttl = 3600;
  const username = `${baseUsername}-cc-${country}-s-${sessionId}-ttl-${ttl}`;
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return { host, port, country, ttl, sessionId, username, password, url: url.href,
    argument: `--proxy-server=http://${host}:${port}` };
}

module.exports = { createMaskifyProxy };
