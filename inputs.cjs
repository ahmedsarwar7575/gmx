const { parseProxy } = require("./captcha.cjs");

function lines(text) {
  return String(text).replace(/^\uFEFF/, "").split(/\n/).map((value, index) => ({ value: value.replace(/\r$/, ""), line: index+1 }))
    .filter(({ value }) => value.trim() && !value.trimStart().startsWith("#"));
}

function parseAccounts(text) {
  const accounts = [], seen = new Set();
  for (const { value, line } of lines(text)) {
    const separator = value.indexOf(":");
    const email = value.slice(0, separator).trim();
    const password = value.slice(separator+1);
    if (separator < 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) throw new Error(`Accounts line ${line}: expected email:password.`);
    if (seen.has(email.toLowerCase())) throw new Error(`Accounts line ${line}: duplicate account.`);
    seen.add(email.toLowerCase());
    accounts.push({ email, password });
  }
  if (!accounts.length) throw new Error("Choose a nonempty account list.");
  if (accounts.length > 500) throw new Error("Use at most 500 accounts per batch.");
  return accounts;
}

function parseProxies(text) {
  const proxies = [], seen = new Set();
  for (const { value, line } of lines(text)) {
    let formatted = value.trim();
    if (!/^https?:\/\//i.test(formatted)) {
      const parts = formatted.split(":");
      if (parts.length < 2 || !parts[0] || !/^\d+$/.test(parts[1]) || (parts.length > 2 && parts.length < 4)) throw new Error(`Proxies line ${line}: expected host:port:user:password or an HTTP/HTTPS proxy URL.`);
      try {
        const url = new URL(`http://${parts[0]}:${parts[1]}`);
        if (parts.length >= 4) { url.username = encodeURIComponent(parts[2]); url.password = encodeURIComponent(parts.slice(3).join(":")); }
        formatted = url.href;
      } catch { throw new Error(`Proxies line ${line}: invalid proxy address.`); }
    }
    try { const parsed = parseProxy(formatted); if (!parsed.port || parsed.port > 65535) throw new Error(); } catch { throw new Error(`Proxies line ${line}: invalid HTTP/HTTPS proxy.`); }
    if (!seen.has(formatted)) { proxies.push(formatted); seen.add(formatted); }
  }
  if (!proxies.length) throw new Error("Choose a nonempty proxy list.");
  if (proxies.length > 1000) throw new Error("Use at most 1,000 proxies per batch.");
  return proxies;
}

function maskEmail(email) {
  const [name, domain] = email.split("@");
  return `${name.slice(0, Math.min(2, name.length))}•••@${domain}`;
}

module.exports = { parseAccounts, parseProxies, maskEmail };
