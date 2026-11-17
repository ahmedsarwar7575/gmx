const { Server } = require("proxy-chain");
function parseProxy(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("GMX_PROXY_URL must be a valid HTTP/HTTPS proxy URL."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.search || url.hash || url.pathname !== "/") {
    throw new Error("GMX_PROXY_URL must use http:// or https:// with a host and port.");
  }
  const proxy = {
    type: url.protocol.slice(0, -1), host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
  if (url.username || url.password) {
    proxy.username = decodeURIComponent(url.username);
    proxy.password = decodeURIComponent(url.password);
  }
  return proxy;
}

async function openProxy(url, log) {
  if (!url) return { argument: null, close: async () => {}, getRetryDelay: () => 0 };
  parseProxy(url);
  let retryDelay = 0;
  const server = new Server({ host: "127.0.0.1", port: 0, verbose: false,
    prepareRequestFunction: ({ hostname }) => ({ upstreamProxyUrl: url, customTag: { hostname } }),
  });
  server.on("tunnelConnectFailed", ({ response, customTag }) => {
    if (response.statusCode === 429) {
      retryDelay = Math.min(Number(response.headers["retry-after"]) * 1000 || 3000, 30_000);
    }
    if (["www.gmx.net", "auth.gmx.net", "appa.gmx.net", "webmailer.gmx.net", "mailset-root.gmx.net"].includes(customTag?.hostname)) {
      log(`Proxy tunnel to ${customTag.hostname} rejected (HTTP ${response.statusCode}).`);
    }
  });
  await server.listen();
  return { argument: `--proxy-server=http://127.0.0.1:${server.port}`,
    close: () => server.close(true), getRetryDelay: () => retryDelay };
}

module.exports = { openProxy, parseProxy };
