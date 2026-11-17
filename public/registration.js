const form = document.getElementById("registration-form");
const startButton = document.getElementById("registration-start");
const spinner = document.getElementById("registration-spinner");
const errorEl = document.getElementById("registration-error");
const messageEl = document.getElementById("registration-message");
const badge = document.getElementById("registration-badge");
const detail = document.getElementById("registration-detail");
const logs = document.getElementById("registration-logs");
const captchaNotice = document.getElementById("registration-captcha");
const inspectBtn = document.getElementById("registration-inspect");
const phoneForm = document.getElementById("registration-phone-form");
const otpForm = document.getElementById("registration-otp-form");
const closeBtn = document.getElementById("registration-close");
const recordList = document.getElementById("registration-record-list");
const recordCount = document.getElementById("record-count");
const credentialsDialog = document.getElementById("registration-credentials");
const closeCredentialsBtn = document.getElementById("registration-credentials-close");
const savedEmail = document.getElementById("saved-email");
const savedPassword = document.getElementById("saved-password");
const togglePasswordBtn = document.getElementById("toggle-password");
const toast = document.getElementById("toast");
const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
const connectionFields = document.getElementById("registration-connection");
const registrationProxyFile = document.getElementById("registration-proxy-file");

let activeId = null, selectedJobId = null;
let registrationRun = null, registrationSubmitting = false, latestSnapshot = null, autoDownloadAttemptId = null, downloading = false;
const sessionSelect = document.getElementById("registration-session");
const downloadButton = document.getElementById("registration-download");
const registrationStopButton = document.getElementById("registration-batch-stop");
let recordsVersion = null, recordsRequest = 0, recordRows = [], batchState = null, batchSubmitting = false;
const selectedRecords = new Set(), revealedPasswords = new Map();

function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

async function api(endpoint, body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (registrationSubmitting || registrationRun?.active) return;
  const body = new FormData(form);
  registrationSubmitting = true;
  updateRegistrationControls();
  errorEl.hidden = true;
  messageEl.textContent = "Preparing registration...";

  try {
    const mode = body.get("connectionMode");
    if (mode === "proxy") {
      const file = registrationProxyFile.files[0];
      if (!file || !/\.txt$/i.test(file.name) || file.size > 2 * 1024 * 1024) throw new Error("Upload a proxy TXT file up to 2 MB.");
    }
    const response = await fetch("/api/registration/batches", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Registration batch could not start.");
    activeId = null;
    selectedJobId = null;
    updateUI(data);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    // A failed navigation can still leave a saved session and Chrome open.
    // Restore its controls so Retry does not require starting another profile.
    try {
      const response = await fetch("/api/registration/state");
      if (response.ok) updateUI(await response.json());
    } catch {}
  } finally {
    registrationSubmitting = false;
    updateRegistrationControls();
  }
});

function updateConnectionChoice() {
  const mode = form.querySelector('[name="connectionMode"]:checked').value;
  document.getElementById("registration-proxy-field").hidden = mode !== "proxy";
  registrationProxyFile.disabled = mode !== "proxy";
  registrationProxyFile.required = mode === "proxy";
  document.getElementById("connection-help").textContent = mode === "maskify"
    ? "Uses a separate German Maskify session for each account."
    : "Uses each uploaded proxy once. Complete any manual verification in its Chrome window.";
}
form.querySelectorAll('[name="connectionMode"]').forEach(input => input.addEventListener("change", updateConnectionChoice));
updateConnectionChoice();

function updateRegistrationControls() {
  const busy = registrationSubmitting || !!registrationRun?.active || !!latestSnapshot?.active?.browserOpen;
  startButton.disabled = busy;
  connectionFields.disabled = busy;
  spinner.hidden = !registrationSubmitting;
  document.getElementById("registration-start-label").textContent = registrationSubmitting ? "Starting…" : registrationRun?.active ? "Batch running" : "Start batch";
  messageEl.textContent = registrationSubmitting ? "Preparing registration…" : registrationRun?.active
    ? `${registrationRun.concurrency} parallel worker${registrationRun.concurrency === 1 ? "" : "s"}. Keep the server running.` : "One Chrome window per active worker.";
  registrationStopButton.hidden = !registrationRun?.active;
  registrationStopButton.disabled = !!registrationRun?.stopping;
  downloadButton.hidden = !registrationRun || registrationRun.active;
  downloadButton.disabled = downloading;
}

registrationStopButton.addEventListener("click", async () => {
  if (!registrationRun?.active) return;
  try { updateUI(await api(`/api/registration/batches/${registrationRun.id}/stop`)); }
  catch (error) { showToast(error.message); }
});
sessionSelect.addEventListener("change", () => { selectedJobId = sessionSelect.value; updateUI(latestSnapshot); });

function updateFailureImage(url, kind, error) {
  const view = document.getElementById("registration-failure-view"), download = document.getElementById("registration-failure-download");
  view.hidden = download.hidden = !url;
  if (url) {
    view.href = url; download.href = `${url}?download=1`;
    view.textContent = kind === "diagnostic" ? "View failure diagnostic" : "View failure screenshot";
  } else { view.removeAttribute("href"); download.removeAttribute("href"); }
  const notice = document.getElementById("registration-failure-error");
  notice.hidden = !error; notice.textContent = error || "";
}

async function downloadRegistrationExport() {
  if (!registrationRun || registrationRun.active || downloading) return;
  const id = registrationRun.id;
  const notice = document.getElementById("registration-download-status");
  downloading = true; updateRegistrationControls();
  try {
    const response = await fetch(`/api/registration/batches/${id}/export`, { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
    if (!response.ok) throw new Error((await response.json()).error || "Download failed.");
    const blob = await response.blob(), url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `gmx-accounts-${id}.txt`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notice.textContent = blob.size ? "TXT download ready. Use Download to save another copy." : "No accounts completed. The TXT file is empty; review the account sessions.";
    notice.hidden = false;
  } catch (error) { notice.textContent = `${error.message} Use Download to try again.`; notice.hidden = false; }
  finally { downloading = false; updateRegistrationControls(); }
}
downloadButton.addEventListener("click", downloadRegistrationExport);

inspectBtn.addEventListener("click", async () => {
  if (!activeId) return;
  inspectBtn.disabled = true;
  try { updateUI(await api(`/api/registration/${activeId}/inspect-next`)); errorEl.hidden = true; }
  catch (err) { showToast(err.message); }
  finally { inspectBtn.disabled = false; }
});

phoneForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeId) return;
  const btn = document.getElementById("send-code-button");
  const sph = document.getElementById("phone-spinner");
  btn.disabled = true; sph.hidden = false;
  try {
    updateUI(await api(`/api/registration/${activeId}/phone`, {
      phone: phoneForm.elements.phone.value.trim(),
      countryCode: phoneForm.elements.countryCode.value.trim()
    }));
  } catch (err) { showToast(err.message); }
  finally { btn.disabled = false; sph.hidden = true; }
});

otpForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeId) return;
  const btn = document.getElementById("submit-code-button");
  const sph = document.getElementById("otp-spinner");
  btn.disabled = true; sph.hidden = false;
  try {
    updateUI(await api(`/api/registration/${activeId}/otp`, { code: otpForm.elements.code.value.trim() }));
  } catch (err) { showToast(err.message); }
  finally { btn.disabled = false; sph.hidden = true; }
});

closeBtn.addEventListener("click", async () => {
  if (!activeId) return;
  try { updateUI(await api(`/api/registration/${activeId}/close`)); }
  catch (err) { showToast(err.message); }
});

function updateUI(snapshot) {
  if (!snapshot) return;
  latestSnapshot = snapshot;
  registrationRun = snapshot.run || null;
  let active = snapshot.active;
  let selectedJob = null;
  if (registrationRun) {
    const jobs = registrationRun.jobs;
    const success = jobs.filter(job => job.status === "success").length;
    const failed = jobs.filter(job => job.status === "failed").length;
    const cancelled = jobs.filter(job => job.status === "cancelled").length;
    document.getElementById("registration-batch-status").textContent = `${registrationRun.stopping && registrationRun.active ? "Stopping" : registrationRun.active ? "Running" : "Finished"} · ${success} created · ${failed} failed · ${cancelled} cancelled · ${success + failed + cancelled} / ${jobs.length} finished${registrationRun.error ? ` · ${registrationRun.error}` : ""}`;
    const sessions = jobs.filter(job => job.session || job.startedAt || job.screenshotUrl || job.artifactError);
    if (!sessions.some(job => job.id === selectedJobId)) selectedJobId = (sessions.find(job => !job.finishedAt) || sessions[0])?.id || null;
    sessionSelect.replaceChildren(...sessions.map(job => {
      const option = document.createElement("option");
      option.value = job.id;
      option.textContent = `#${job.index} · ${job.session?.emailHint || "Profile preparation"} · ${job.status.replace(/_/g, " ")}`;
      return option;
    }));
    sessionSelect.value = selectedJobId || "";
    document.getElementById("registration-session-field").hidden = !sessions.length;
    selectedJob = sessions.find(job => job.id === selectedJobId) || null;
    active = selectedJob?.session || null;
    if (!registrationRun.active && autoDownloadAttemptId !== registrationRun.id) {
      autoDownloadAttemptId = registrationRun.id;
      void downloadRegistrationExport();
    }
  }
  updateFailureImage(selectedJob?.screenshotUrl || active?.failureImageUrl, selectedJob?.artifactKind || active?.failureArtifactKind,
    selectedJob?.artifactError || active?.failureImageError);
  updateRegistrationControls();
  document.getElementById("connection-text").textContent = "Service connected";
  document.getElementById("connection-dot").classList.add("connected");

  if (active) {
    activeId = active.id;
    badge.textContent = active.status.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
    badge.className = "badge " + (active.status === "complete" ? "success" : active.status === "needs_attention" ? "danger" : active.status.startsWith("awaiting") ? "warning" : "neutral");
    detail.textContent = active.stage || "Waiting...";
    
    captchaNotice.hidden = active.status !== "awaiting_captcha";
    inspectBtn.hidden = !active.browserOpen || (active.status !== "needs_attention" && !active.smsRetryAvailable);
    inspectBtn.textContent = active.smsRetryAvailable ? "Check SMS again" : "Retry current step";
    phoneForm.hidden = !active.browserOpen || active.status !== "awaiting_phone";
    otpForm.hidden = !active.browserOpen || active.status !== "awaiting_otp";
    closeBtn.hidden = !active.browserOpen;

    if (active.logs) {
      logs.replaceChildren(...active.logs.map(log => {
        const item = document.createElement("li");
        const time = document.createElement("time");
        const message = document.createElement("span");
        time.textContent = new Date(log.time).toLocaleTimeString();
        message.textContent = log.message;
        item.append(time, message);
        return item;
      }));
    }
    
  } else {
    activeId = null;
    badge.textContent = "Ready";
    badge.className = "badge neutral";
    detail.textContent = selectedJob?.stage || "No active registration.";
    captchaNotice.hidden = true;
    inspectBtn.hidden = true;
    phoneForm.hidden = true;
    otpForm.hidden = true;
    closeBtn.hidden = true;
    logs.innerHTML = "";
  }

  const steps = ["step-profile", "step-captcha", "step-details", "step-phone"].map(id => document.getElementById(id));
  steps.forEach(s => s.classList.remove("current", "done"));
  
  if (active) {
    const phase = active.phase || "profile";
    if (phase === "profile") steps[0].classList.add("current");
    else if (phase === "email" || phase === "password" || phase === "address") steps[2].classList.add("current");
    else if (phase === "phone" || phase === "otp") steps[3].classList.add("current");
    else if (phase === "unknown" && active.status === "awaiting_captcha") steps[1].classList.add("current");
    
    if (active.status === "complete") {
      steps.forEach(s => s.classList.add("done"));
    }
  } else {
    steps[0].classList.add("current");
  }

  if (snapshot.records) {
    const version = JSON.stringify(snapshot.records);
    if (version !== recordsVersion) {
      recordsVersion = version;
      refreshRecords(snapshot.records);
    }
  }
}

window.openCredentials = async (id) => {
  try {
    const res = await fetch(`/api/registration/${id}/credentials`, {
      method: "POST", headers: { "X-CSRF-Token": csrfToken }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    savedEmail.value = data.email;
    savedPassword.value = data.password;
    credentialsDialog.showModal();
  } catch (err) { showToast(err.message); }
};

recordList.addEventListener("click", event => {
  const button = event.target.closest("button[data-credentials-id]");
  if (button) window.openCredentials(button.dataset.credentialsId);
});

closeCredentialsBtn.addEventListener("click", () => credentialsDialog.close());

togglePasswordBtn.addEventListener("click", () => {
  if (savedPassword.type === "password") {
    savedPassword.type = "text";
    togglePasswordBtn.textContent = "Hide";
  } else {
    savedPassword.type = "password";
    togglePasswordBtn.textContent = "Show";
  }
});

async function refreshRegistrationState() {
  try {
    const response = await fetch("/api/registration/state");
    if (response.ok) updateUI(await response.json());
  } catch {}
}
void refreshRegistrationState();
setInterval(refreshRegistrationState, 2000);


function tableNode(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function refreshRecords(fallback = []) {
  const request = ++recordsRequest;
  try {
    const data = await api("/api/registration/records");
    if (request !== recordsRequest) return;
    recordRows = data.records.length ? data.records : fallback;
    document.getElementById("records-error").hidden = true;
    renderRecords();
  } catch (error) {
    if (request !== recordsRequest) return;
    const notice = document.getElementById("records-error");
    notice.textContent = error.message; notice.hidden = false;
  }
}

function renderRecords() {
  const existing = new Set(recordRows.map(record => record.id));
  for (const id of selectedRecords) if (!recordRows.some(record => record.id === id && record.eligible)) selectedRecords.delete(id);
  for (const id of revealedPasswords.keys()) if (!existing.has(id)) revealedPasswords.delete(id);
  recordCount.textContent = `${recordRows.length} saved`;
  const rows = recordRows.map(record => {
    const row = tableNode("tr"), selection = tableNode("td"), checkbox = tableNode("input");
    checkbox.type = "checkbox"; checkbox.dataset.recordId = record.id;
    checkbox.checked = selectedRecords.has(record.id); checkbox.disabled = !record.eligible;
    checkbox.setAttribute("aria-label", `Select ${record.email || record.emailHint}`);
    if (!record.eligible) checkbox.title = "Available after a verified GMX Navigator mailbox redirect";
    selection.append(checkbox);
    const email = tableNode("td", "record-email", record.email || record.emailHint || "—");
    const passwordCell = tableNode("td"), passwordWrap = tableNode("div", "record-password");
    const reveal = revealedPasswords.get(record.id);
    const password = tableNode("code", "", reveal?.visible ? reveal.password : "••••••••");
    const show = tableNode("button", "password-toggle", reveal?.visible ? "Hide" : "Show");
    show.type = "button"; show.dataset.passwordId = record.id;
    show.setAttribute("aria-label", `${reveal?.visible ? "Hide" : "Show"} password for ${record.email || record.emailHint}`);
    passwordWrap.append(password, show); passwordCell.append(passwordWrap);
    const name = tableNode("td", "", [record.firstName, record.lastName].filter(Boolean).join(" ") || "—");
    const dob = tableNode("td", "record-date", record.birthDate || "—");
    const gender = tableNode("td", "record-gender", record.gender || "—");
    const phone = tableNode("td", "record-phone", record.phone || "—");
    const address = tableNode("td", "record-address", [record.street, [record.postalCode, record.city].filter(Boolean).join(" "), record.country].filter(Boolean).join(", ") || "—");
    const statusCell = tableNode("td");
    statusCell.append(tableNode("span", `badge ${record.eligible ? "success" : record.status === "failed" ? "danger" : "neutral"}`, record.status.replace(/_/g, " ")));
    const action = tableNode("td"), button = tableNode("button", "row-action", "Details");
    button.type = "button"; button.dataset.credentialsId = record.id; action.append(button);
    if (record.failureImageUrl) {
      const image = tableNode("a", "row-action", record.failureArtifactKind === "diagnostic" ? "Diagnostic" : "Screenshot");
      image.href = record.failureImageUrl; image.target = "_blank"; image.rel = "noopener noreferrer"; action.append(image);
    }
    row.append(selection, email, passwordCell, name, dob, gender, phone, address, statusCell, action);
    return row;
  });
  if (!rows.length) {
    const row = tableNode("tr"), empty = tableNode("td", "registration-record-empty", "No saved registrations.");
    empty.colSpan = 10; row.append(empty); rows.push(row);
  }
  document.getElementById("registration-records-body").replaceChildren(...rows);
  updateBatchControls();
}

function updateBatchControls() {
  const eligible = recordRows.filter(record => record.eligible);
  const all = document.getElementById("select-all-records");
  all.checked = eligible.length > 0 && eligible.every(record => selectedRecords.has(record.id));
  all.indeterminate = selectedRecords.size > 0 && !all.checked;
  all.disabled = !eligible.length;
  document.getElementById("selected-count").textContent = `${selectedRecords.size} selected`;
  const busy = batchSubmitting || !!batchState?.active;
  document.getElementById("saved-batch-start").disabled = busy || !selectedRecords.size || !document.getElementById("saved-proxies").files.length;
  document.getElementById("saved-batch-start").textContent = batchSubmitting ? "Starting…" : batchState?.active ? "Batch running" : "Run IMAP / POP3";
  for (const id of ["saved-proxies", "saved-workers", "saved-browser"]) document.getElementById(id).disabled = busy;
  document.getElementById("saved-batch-stop").hidden = !batchState?.active;
  document.getElementById("saved-batch-stop").disabled = !!batchState?.stopping;
}

recordList.addEventListener("change", event => {
  const checkbox = event.target.closest("input[data-record-id]");
  if (!checkbox) return;
  if (checkbox.checked) selectedRecords.add(checkbox.dataset.recordId); else selectedRecords.delete(checkbox.dataset.recordId);
  updateBatchControls();
});
document.getElementById("select-all-records").addEventListener("change", event => {
  for (const record of recordRows.filter(record => record.eligible)) {
    if (event.target.checked) selectedRecords.add(record.id); else selectedRecords.delete(record.id);
  }
  for (const input of recordList.querySelectorAll("input[data-record-id]")) input.checked = selectedRecords.has(input.dataset.recordId);
  updateBatchControls();
});
recordList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-password-id]");
  if (!button) return;
  const id = button.dataset.passwordId;
  button.disabled = true;
  try {
    let value = revealedPasswords.get(id);
    if (!value) {
      const data = await api(`/api/registration/${id}/credentials`);
      value = { password: data.password, visible: false };
      revealedPasswords.set(id, value);
    }
    value.visible = !value.visible;
    button.previousElementSibling.textContent = value.visible ? value.password : "••••••••";
    button.textContent = value.visible ? "Hide" : "Show";
    button.setAttribute("aria-label", `${value.visible ? "Hide" : "Show"} password`);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
document.getElementById("records-refresh").addEventListener("click", () => refreshRecords());
document.getElementById("saved-proxies").addEventListener("change", updateBatchControls);
document.getElementById("saved-batch-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (batchSubmitting || batchState?.active || !selectedRecords.size) return;
  const file = document.getElementById("saved-proxies").files[0];
  const errorEl = document.getElementById("saved-batch-error");
  errorEl.hidden = true;
  if (!file || file.size > 2 * 1024 * 1024) { errorEl.textContent = "Choose a proxy TXT file up to 2 MB."; errorEl.hidden = false; return; }
  const data = new FormData(event.target);
  data.append("registrationIds", JSON.stringify([...selectedRecords]));
  batchSubmitting = true; updateBatchControls();
  try {
    const response = await fetch("/api/registration-runs", { method: "POST", headers: { "X-CSRF-Token": csrfToken }, body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Batch could not start.");
    batchState = result.run;
    document.getElementById("saved-batch-results").hidden = false;
    showToast("IMAP / POP3 batch started.");
  } catch (error) { errorEl.textContent = error.message; errorEl.hidden = false; }
  finally { batchSubmitting = false; updateBatchControls(); }
});
document.getElementById("saved-batch-stop").addEventListener("click", async () => {
  if (!batchState?.active) return;
  try { const result = await api(`/api/runs/${batchState.id}/stop`); batchState = result.run; updateBatchControls(); }
  catch (error) { showToast(error.message); }
});
const batchEvents = new EventSource("/api/events");
batchEvents.addEventListener("state", event => {
  try {
    batchState = JSON.parse(event.data).run;
    if (batchState) {
      const complete = batchState.jobs.filter(job => ["success", "failed", "cancelled", "needs_attention"].includes(job.status)).length;
      document.getElementById("saved-batch-status").textContent = `${batchState.active ? "Running" : "Complete"} · ${complete} / ${batchState.jobs.length}`;
      document.getElementById("saved-batch-results").hidden = false;
    }
    updateBatchControls();
  } catch {}
});
