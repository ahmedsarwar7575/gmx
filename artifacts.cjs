const fs = require("node:fs/promises");
const path = require("node:path");

const ARTIFACTS = path.join(__dirname, "artifacts");

async function clearScreenshots(root = ARTIFACTS) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      removed += await clearScreenshots(target);
      if (!(await fs.readdir(target)).length) await fs.rmdir(target);
    } else if (/\.(png|jpe?g|webp|svg)$/i.test(entry.name)) {
      await fs.unlink(target);
      removed++;
    }
  }
  return removed;
}

const escapeXml = (value) => String(value).replace(/[<>&"']/g, (s) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[s]);

async function diagnosticImage(filename, message = "Browser unavailable", stage = "Automation stopped") {
  filename = filename.replace(/\.[^.]+$/, "") + ".svg";
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const lines = String(message).match(/.{1,85}(?:\s|$)|.{1,85}/g)?.slice(0, 5) || [];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="560" viewBox="0 0 1100 560"><rect width="1100" height="560" fill="#0f172a"/><rect x="50" y="48" width="46" height="46" rx="13" fill="#fef3c7"/><text x="73" y="81" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#b45309">!</text><text x="50" y="160" fill="#f8fafc" font-size="30" font-family="sans-serif" font-weight="700">${escapeXml(stage).slice(0, 160)}</text><text x="50" y="205" fill="#94a3b8" font-size="17" font-family="sans-serif">Diagnostic image — no browser screenshot was available.</text>${lines.map((line,i)=>`<text x="50" y="${268+i*30}" fill="#cbd5e1" font-size="18" font-family="sans-serif">${escapeXml(line)}</text>`).join("")}<text x="50" y="510" fill="#64748b" font-size="15" font-family="sans-serif">Mailbox Operations · ${escapeXml(new Date().toISOString())}</text></svg>`;
  await fs.writeFile(filename, svg, { mode: 0o600 });
  return { path: filename, kind: "diagnostic" };
}

async function captureFailure(browser, filename, { message, stage, secrets = [], preferredPage = null, redactPhones = false, redactUrlQueries = false } = {}) {
  let pages = [];
  try { if (browser?.connected) pages = await browser.pages(); } catch {}
  const page = preferredPage && !preferredPage.isClosed() ? preferredPage : pages.findLast((p) => !p.isClosed() && p.url() !== "about:blank") || pages[0];
  if (!page) return diagnosticImage(filename, message, stage);
  const frames = page.frames();
  try {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    for (const frame of frames) await frame.evaluate(({ secrets, redactPhones, redactUrlQueries }) => {
      const records = [], roots = [document];
      window.__gmxScreenshotRestore = records;
      for (const root of roots) for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]),textarea,[contenteditable],mail-list-container,list-mail-list,webmailer-mail-list,webmailer-mail-view,webmailer-mail-compose')) {
          records.push({ node: el, style: el.getAttribute("style") });
          el.style.setProperty("visibility", "hidden", "important");
        }
      }
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName)) continue;
          let next = node.textContent;
          for (const secret of secrets) if (secret) next = next.split(secret).join("[hidden]");
          next = next.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email hidden]");
          if (redactPhones) next = next.replace(/\+\d(?:[\d ()-]{5,22}\d)/g, '[phone hidden]');
          if (redactUrlQueries) next = next.replace(/\b(sid|session|token|activationId|api_key|password)\s*[=:]\s*["']?[^\s"'&<>]+/gi, '$1=[hidden]');
          if (next !== node.textContent) { records.push({ node, text: node.textContent }); node.textContent = next; }
        }
      }
    }, { secrets: secrets.filter(Boolean), redactPhones, redactUrlQueries }).catch((error) => { if (!frame.detached) throw error; });
    let timer;
    try {
      await Promise.race([
        page.screenshot({ path: filename, waitForFonts: false }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Screenshot timeout")), 10_000); }),
      ]);
    } finally { clearTimeout(timer); }
    await fs.chmod(filename, 0o600);
    return { path: filename, kind: "screenshot" };
  } catch { return diagnosticImage(filename, message, stage); }
  finally {
    for (const frame of frames) await frame.evaluate(() => {
      for (const record of window.__gmxScreenshotRestore || []) {
        if ("text" in record) record.node.textContent = record.text;
        else if (record.style === null) record.node.removeAttribute("style");
        else record.node.setAttribute("style", record.style);
      }
      delete window.__gmxScreenshotRestore;
    }).catch(() => {});
  }
}

module.exports = { ARTIFACTS, clearScreenshots, captureFailure, diagnosticImage };
