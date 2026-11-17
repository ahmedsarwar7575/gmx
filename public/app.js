(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let state = { run: null }, filter = "all", submitting = false, stopping = false, modalJob = null, modalMode = null;
  const counts = { accounts: 0, proxies: 0 };
  const terminal = (job) => ["success", "failed", "cancelled", "needs_attention"].includes(job.status);
  const attention = (job) => ["failed", "attention", "needs_attention"].includes(job.status);
  const status = {
    queued: ["Queued", "neutral"], running: ["Running", "running"], success: ["Verified", "success"],
    attention: ["Manual step", "attention"], needs_attention: ["Needs attention", "attention"],
    failed: ["Failed", "failed"], cancelled: ["Stopped", "neutral"],
  };
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use"); use.setAttribute("href", `#i-${name}`); svg.append(use);
    return svg;
  }
  function toast(message) {
    $("toast").textContent = message; $("toast").hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { $("toast").hidden = true; }, 4500);
  }
  function duration(start, end) {
    if (!start) return "—";
    const seconds = Math.max(0, Math.floor(((end || Date.now()) - start) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  function updateTimes() {
    const run = state.run;
    $("summary-elapsed").textContent = duration(run?.startedAt, run?.finishedAt);
    for (const element of document.querySelectorAll("[data-job-time]")) {
      const job = run?.jobs.find((item) => item.id === element.dataset.jobTime);
      if (job) element.textContent = duration(job.startedAt, job.finishedAt);
    }
  }
  async function readFile(input) {
    const key = input.id, file = input.files[0];
    counts[key] = 0;
    input.closest(".dropzone").classList.remove("loaded");
    if (!file) { $(key+"-name").textContent = `Upload ${key}`; $(key+"-detail").textContent = "TXT · Max 2 MB"; renderControls(); return; }
    $(key+"-name").textContent = file.name;
    if (file.size > 2 * 1024 * 1024) { $(key+"-detail").textContent = "File exceeds the 2 MB limit"; renderControls(); return; }
    const text = await file.text();
    if (input.files[0] !== file) return;
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    counts[key] = lines.length;
    $(key+"-detail").textContent = `${lines.length} ${key === "accounts" ? (lines.length === 1 ? "account" : "accounts") : (lines.length === 1 ? "proxy" : "proxies")} detected · ${(file.size / 1024).toFixed(1)} KB`;
    input.closest(".dropzone").classList.toggle("loaded", lines.length > 0);
    renderControls();
  }
  for (const key of ["accounts", "proxies"]) {
    const input = $(key), zone = input.closest(".dropzone");
    input.addEventListener("change", () => readFile(input).catch(() => { toast("Could not read that file. Choose it again."); }));
    zone.addEventListener("dragover", (event) => { event.preventDefault(); if (!state.run?.active) zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault(); zone.classList.remove("dragover");
      if (state.run?.active || !event.dataTransfer.files.length) return;
      const transfer = new DataTransfer(); transfer.items.add(event.dataTransfer.files[0]); input.files = transfer.files;
      readFile(input).catch(() => toast("Could not read that file."));
    });
  }
  function adjust(by) { $("concurrency").value = Math.min(8, Math.max(1, Number($("concurrency").value || 1)+by)); renderControls(); }
  $("decrement").addEventListener("click", () => adjust(-1));
  $("increment").addEventListener("click", () => adjust(1));
  $("concurrency").addEventListener("input", renderControls);
  document.querySelectorAll('[name="headless"]').forEach((input) => input.addEventListener("change", renderControls));
  $("imap-connection").addEventListener("change", renderControls);
  function renderControls() {
    const active = !!state.run?.active, busy = active || submitting;
    const maskify = $("imap-connection").value === "maskify";
    $("config-fields").disabled = busy;
    $("imap-proxy-field").hidden = maskify;
    $("imap-maskify-help").hidden = !maskify;
    $("proxies").disabled = busy || maskify;
    $("proxies").required = !maskify;
    $("start-button").disabled = busy || !counts.accounts || (!maskify && !counts.proxies);
    $("start-spinner").hidden = !busy;
    $("start-arrow").hidden = busy;
    $("start-label").textContent = submitting ? "Starting…" : active ? "Batch running" : state.run ? "Start new batch" : "Start batch";
    $("stop-button").hidden = !active;
    const isStopping = stopping || !!state.run?.stopping;
    $("stop-button").disabled = isStopping;
    $("stop-button").replaceChildren(...(isStopping ? [node("span", "spinner"), document.createTextNode("Stopping…")] : [document.createTextNode("Stop batch")]));
    $("decrement").disabled = busy || Number($("concurrency").value) <= 1;
    $("increment").disabled = busy || Number($("concurrency").value) >= 8;
    $("summary-mode").textContent = (state.run?.headless ?? (document.querySelector('[name="headless"]:checked').value === "true")) ? "Headless" : "Visible Chrome";
    $("summary-workers").textContent = state.run ? `${state.run.concurrency} / ${state.run.requestedConcurrency} requested` : $("concurrency").value;
  }
  async function request(url, options) {
    const response = await fetch(url, { ...options, headers: { "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]').content } });
    let result;
    try { result = await response.json(); } catch { throw new Error("The local service did not respond. Check the terminal."); }
    if (!response.ok) throw new Error(result.error || "Request failed.");
    return result;
  }
  $("batch-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (state.run?.active || submitting) return;
    const form = new FormData($("batch-form"));
    submitting = true; $("form-error").hidden = true; renderControls();
    try { applyState(await request("/api/runs", { method: "POST", body: form })); toast("Batch started. Progress will update here."); }
    catch (error) { $("form-error").textContent = error.message; $("form-error").hidden = false; }
    finally { submitting = false; renderControls(); }
  });
  $("stop-button").addEventListener("click", async () => {
    if (!state.run?.active || stopping) return;
    stopping = true; renderControls();
    try { applyState(await request(`/api/runs/${state.run.id}/stop`, { method: "POST" })); toast("Stopping workers and saving result images…"); }
    catch (error) { toast(error.message); }
    finally { stopping = false; renderControls(); }
  });
  function applyState(next) {
    if ((next.revision || 0) < (state.revision || 0)) return;
    state = next; render();
  }
  function render() {
    const run = state.run, jobs = run?.jobs || [], done = jobs.filter(terminal).length, verified = jobs.filter((job) => job.status === "success").length;
    $("metric-total").textContent = jobs.length;
    $("metric-running").textContent = jobs.filter((job) => ["running", "attention"].includes(job.status)).length;
    $("metric-success").textContent = verified;
    $("metric-attention").textContent = jobs.filter(attention).length;
    $("nav-count").textContent = jobs.length;
    $("result-count").textContent = `${jobs.length} account${jobs.length === 1 ? "" : "s"}`;
    const progress = jobs.length ? Math.round(done / jobs.length * 100) : 0;
    $("progress-number").replaceChildren(document.createTextNode(String(progress)), node("span", "", "%"));
    $("progress-fill").style.width = `${progress}%`;
    $("progress-detail").textContent = run ? `${done} / ${jobs.length} complete` : "Ready to start";
    $("run-badge").textContent = run ? run.stopping && run.active ? "Stopping" : run.active ? "Running" : "Complete" : "Ready";
    $("run-badge").className = `badge ${run?.active ? "running" : run ? "success" : "neutral"}`;
    $("solver-note").textContent = state.configuredSolver ? "AnySolver ready · manual fallback in visible mode" : "Manual CAPTCHA · use visible mode";
    $("table-summary").textContent = run ? `${verified} verified · ${jobs.filter(attention).length} need attention · ${jobs.filter((job) => job.status === "cancelled").length} stopped` : "No accounts processed";
    const visible = jobs.filter((job) => filter === "all" || (filter === "success" ? job.status === "success" : attention(job)));
    $("empty-state").hidden = visible.length > 0;
    if (jobs.length && !visible.length) { $("empty-state").querySelector("h3").textContent = "No matching accounts"; $("empty-state").querySelector("p").textContent = "Try another filter."; }
    const rows = visible.map((job) => {
      const tr = node("tr"), account = node("td"), cell = node("div", "account-cell"), details = node("div");
      details.append(node("strong", "", job.account), node("small", "", `Account ${String(job.index).padStart(2,"0")} · ${run.connectionMode === "maskify" ? "Maskify session" : job.proxy ? `Proxy ${String(job.proxy).padStart(2,"0")}` : "Awaiting proxy"}`));
      cell.append(node("span", "account-avatar", String(job.index).padStart(2,"0")), details); account.append(cell);
      const badgeCell = node("td"), info = status[job.status] || status.queued, badge = node("span", `badge ${info[1]}`);
      if (job.status === "running") badge.append(node("span", "spinner"));
      badge.append(document.createTextNode(info[0])); badgeCell.append(badge);
      const stage = node("td", "", job.stage); if (job.error) stage.title = job.error;
      const elapsed = node("td", "", duration(job.startedAt, job.finishedAt)); elapsed.dataset.jobTime = job.id;
      const actions = node("td"), logs = node("button", "row-action", "Logs"); logs.type = "button";
      logs.setAttribute("aria-label", `View logs for account ${job.index}`); logs.addEventListener("click", () => openModal(job.id, "logs"));
      if (job.screenshotUrl) {
        const shot = node("button", "row-action"); shot.type = "button"; shot.append(icon("image"), document.createTextNode(job.artifactKind === "diagnostic" ? "Diagnostic" : "Screenshot"));
        shot.setAttribute("aria-label", `View ${job.artifactKind === "diagnostic" ? "diagnostic" : "screenshot"} for account ${job.index}`);
        shot.addEventListener("click", () => openModal(job.id, "image")); actions.append(shot);
      }
      actions.append(logs); tr.append(account,badgeCell,stage,elapsed,actions); return tr;
    });
    $("jobs-body").replaceChildren(...rows);
    const activity = jobs.flatMap((job) => job.logs.map((entry) => ({ ...entry, index: job.index }))).sort((a,b) => b.time-a.time).slice(0,6);
    if (activity.length) $("activity-list").replaceChildren(...activity.map((entry) => {
      const li = node("li"), time = node("time", "", new Date(entry.time).toLocaleTimeString([], { hour12:false }));
      li.append(time, node("strong", "", `Account ${String(entry.index).padStart(2,"0")}`), node("span", "", entry.message)); return li;
    }));
    if (modalJob && $("result-modal").open) renderModal();
    renderControls(); updateTimes();
  }
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    filter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("selected", item === button)); render();
  }));
  document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item === link));
  }));
  function openModal(id, mode) { modalJob = id; modalMode = mode; renderModal(); $("result-modal").showModal(); }
  function renderModal() {
    const job = state.run?.jobs.find((item) => item.id === modalJob);
    if (!job) { $("result-modal").close(); return; }
    $("modal-title").textContent = `${modalMode === "logs" ? "Task log" : job.artifactKind === "diagnostic" ? "Diagnostic image" : "Result screenshot"} · Account ${String(job.index).padStart(2,"0")}`;
    $("modal-subtitle").textContent = `${job.account} · ${status[job.status]?.[0] || job.status}`;
    $("image-container").hidden = modalMode !== "image";
    $("log-container").hidden = modalMode !== "logs";
    $("download-image").hidden = modalMode !== "image";
    if (modalMode === "image") { $("result-image").src = job.screenshotUrl; $("download-image").href = job.screenshotUrl; $("result-image").alt = job.artifactKind === "diagnostic" ? "Diagnostic image: no browser screenshot was available" : "Redacted GMX automation result screenshot"; }
    else $("task-logs").replaceChildren(...(job.logs.length ? job.logs.map((entry) => {
      const li = node("li"); li.append(node("time", "", new Date(entry.time).toLocaleTimeString([], { hour12:false })), document.createTextNode(entry.message)); return li;
    }) : [node("li", "muted", "No worker activity yet.")]));
  }
  $("close-modal").addEventListener("click", () => $("result-modal").close());
  $("result-modal").addEventListener("click", (event) => { if (event.target === $("result-modal")) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
  window.addEventListener("beforeunload", (event) => { if (state.run?.active || submitting) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("keydown", (event) => {
    if ((state.run?.active || submitting) && (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r"))) {
      event.preventDefault(); toast("A batch is running. Jobs stay active on the server if you leave this page.");
    }
  });
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => { try { applyState(JSON.parse(event.data)); } catch { toast("Could not update the dashboard. Reconnecting…"); } });
  events.addEventListener("open", () => { $("connection-dot").classList.add("connected"); $("connection-text").textContent = "Service connected"; });
  events.addEventListener("error", () => { $("connection-dot").classList.remove("connected"); $("connection-text").textContent = "Reconnecting…"; });
  setInterval(updateTimes, 1000);
  render();
})();
