const ROLE_SUPER_ADMIN = "super_admin";
const ROLE_INSTRUMENT_ADMIN = "instrument_admin";
const ROLE_USER = "user";

﻿const state = {
  user: null,
  instruments: [],
  instrumentList: [],
  options: [],
  samples: [],
  submissions: [],
  allSubmissions: [],
  users: [],
  scheduleFor: null,
};

const SCHEDULE_PAGE_SIZE = 20;
let schedulePage = 1;
let scheduleTotalPages = 1;
let scheduleFilterOption = "all";

const page = document.body.dataset.page;
const cardsGrid = document.getElementById("cards-grid");
const modalBackdrop = document.getElementById("modal-backdrop");
const modalContent = document.getElementById("modal-content");

const sampleDetailCache = new Map();
const modalHistoryStack = [];

function pushModalState(renderFn, replace = false) {
  if (replace) {
    modalHistoryStack.length = 0;
  }
  modalHistoryStack.push(renderFn);
  renderFn();
}

function goBackModal() {
  if (!modalHistoryStack.length) {
    return closeModal();
  }
  modalHistoryStack.pop();
  const previous = modalHistoryStack[modalHistoryStack.length - 1];
  if (previous) {
    previous();
  } else {
    closeModal();
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (chr) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[chr];
  });
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function cacheSampleDetail(sample) {
  if (sample && sample.id) {
    sampleDetailCache.set(sample.id, sample);
  }
}

function renderImagePreview(url, label = "Image") {
  if (!url) {
    return showToast("Image not available");
  }
  const canGoBack = modalHistoryStack.length > 1;
  const controls = canGoBack
    ? `<div class="flex" style="gap:8px;">
        <button class="ghost" onclick="goBackModal()">Back</button>
        <button class="ghost" onclick="closeModal()">Close</button>
      </div>`
    : `<button class="ghost" onclick="closeModal()">Close</button>`;
  openModal(`
    <div class="flex-between">
      <h3>${escapeHtml(label)}</h3>
      ${controls}
    </div>
    <div style="margin-top:12px;">
      <img class="image-preview" src="${escapeAttr(url)}" alt="${escapeHtml(label)}">
    </div>
  `);
}

function openImagePreview(url, label = "Image") {
  pushModalState(() => renderImagePreview(url, label));
}

function attachImagePreviewHandlers(scope = document) {
  if (!scope) return;
  const elements = [];
  if (scope instanceof Element) {
    if (scope.matches("[data-full-url]")) {
      elements.push(scope);
    }
    elements.push(...scope.querySelectorAll("[data-full-url]"));
  } else {
    elements.push(...document.querySelectorAll("[data-full-url]"));
  }
  elements.forEach((el) => {
    if (el.dataset.previewBound) return;
    el.style.cursor = "pointer";
    el.addEventListener("click", () => openImagePreview(el.dataset.fullUrl, el.dataset.fullLabel || "Image"));
    el.dataset.previewBound = "1";
  });
}

function renderSampleDetailModal(sample) {
  if (!sample) return showToast("Sample data is unavailable");
  const remarkText = sample.remark ? escapeHtml(sample.remark) : "No notes";
  const nameText = escapeHtml(sample.name);
  const makeThumb = (label, url) => url
    ? `<img class="clickable-thumb" src="${escapeAttr(url)}" data-full-url="${escapeAttr(url)}" data-full-label="${escapeAttr(`${label} • ${sample.name}`)}" alt="${escapeHtml(label)}">`
    : `<div class="subtle">No data</div>`;
  const canGoBack = modalHistoryStack.length > 1;
  const controls = canGoBack
    ? `<div class="flex" style="gap:8px;">
        <button class="ghost" onclick="goBackModal()">Back</button>
        <button class="ghost" onclick="closeModal()">Close</button>
      </div>`
    : `<button class="ghost" onclick="closeModal()">Close</button>`;
  openModal(`
    <div class="flex-between">
      <h3>Sample details: ${nameText}</h3>
      ${controls}
    </div>
    <p class="subtle">Notes: ${remarkText}</p>
    <div class="grid-3 sample-image-grid">
      <div>
        <div class="subtle">TGA</div>
        ${makeThumb("TGA", sample.tga_image)}
      </div>
      <div>
        <div class="subtle">BET</div>
        ${makeThumb("BET", sample.bet_image)}
      </div>
      <div>
        <div class="subtle">PXRD</div>
        ${makeThumb("PXRD", sample.pxrd_image)}
      </div>
    </div>
  `);
  attachImagePreviewHandlers(modalContent);
}

function openSampleDetailById(sampleId) {
  const id = parseInt(sampleId, 10);
  if (!id) return;
  const sample = sampleDetailCache.get(id);
  if (!sample) return showToast("Sample not found");
  pushModalState(() => renderSampleDetailModal(sample));
}

function $(id) { return document.getElementById(id); }

async function api(path, method = "GET", body) {
  const opts = { method, credentials: "include" };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch (e) {}
    throw new Error(detail || "Request failed");
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

function showToast(msg) {
  const el = $("toast");
  if (!el) { console.log(msg); return; }
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 2600);
}

async function uploadImage(kind, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await api(`/api/upload/${kind}`, "POST", fd);
  return res.url;
}

async function loadMe() {
  try { state.user = await api("/api/me"); fillProfileForm(); } catch (e) { window.location = "/login"; }
}

async function loadInstruments() {
  try { state.instruments = await api("/api/instruments/status"); renderCards(); } catch (e) { console.error(e); }
}

async function loadInstrumentList() {
  try {
    state.instrumentList = await api("/api/instruments");
    renderInstrumentPrefer();
    renderInstrumentTable();
    renderUrgentInsertForm();
  } catch (e) {
    console.error(e);
  }
}

function renderUrgentInsertForm() {
  const instSelect = $("insert-inst-select");
  if (instSelect) {
    instSelect.innerHTML = `<option value="">Select an instrument</option>` +
      state.instrumentList.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");
  }
  const userSelect = $("insert-user-select");
  if (userSelect) {
    userSelect.innerHTML = `<option value="">Select a user</option>` +
      (state.users || []).map((u) => `<option value="${u.id}">${u.full_name || u.username}</option>`).join("");
  }
}

function findInstrumentName(id) {
  const inst = state.instrumentList.find((i) => i.id === id);
  return inst ? inst.name : null;
}

async function loadOptions() {
  try { state.options = await api("/api/options"); renderOptionSelect(); renderOptionTable(); } catch (e) { console.error(e); }
  renderScheduleFilterOptions();
}

async function loadSamples() {
  try {
    state.samples = await api("/api/samples");
    renderSamplesTable();
    refreshSampleRows();
  } catch (e) { console.error(e); }
}

async function loadMySubmissions() {
  try { state.submissions = await api("/api/submissions/my"); renderMySubmissions(); } catch (e) {}
}

async function loadAllSubmissions() {
  try { state.allSubmissions = await api("/api/submissions"); renderAllSubmissions(); } catch (e) {}
}

async function loadUsers() {
  try {
    state.users = await api("/api/users");
    renderUsersTable();
    renderUrgentInsertForm();
  } catch (e) {
    console.error(e);
  }
}

function renderUsersTable() {
  const table = $("users-table");
  if (!table) return;
  const header = `<tr><th>Username</th><th>Name</th><th>Role</th><th>Instruments</th><th>Samples</th><th>Actions</th></tr>`;
  if (!state.users.length) {
    table.innerHTML = header + `<tr><td colspan="6">No users</td></tr>`;
    return;
  }
  const rows = state.users
    .map((user) => {
      const instrumentNames = user.instruments.length
        ? user.instruments.map((inst) => inst.name).join(" / ")
        : "-";
      const roleControl = user.role === ROLE_SUPER_ADMIN
        ? '<span class="chip">Super administrator</span>'
        : `<select data-role-select="${user.id}" data-prev-role="${user.role}">
            <option value="${ROLE_USER}" ${user.role === ROLE_USER ? "selected" : ""}>Regular user</option>
            <option value="${ROLE_INSTRUMENT_ADMIN}" ${user.role === ROLE_INSTRUMENT_ADMIN ? "selected" : ""}>Instrument admin</option>
          </select>`;
      const assignButton = user.role === ROLE_INSTRUMENT_ADMIN
        ? `<button class="ghost" data-manage-instruments="${user.id}">Assign instruments</button>`
        : "";
      const deleteDisabled = user.role === ROLE_SUPER_ADMIN ? "disabled" : "";
      return `<tr>
        <td>${user.username}</td>
        <td>${user.full_name || "-"}</td>
        <td>${roleControl}</td>
        <td>${instrumentNames}</td>
        <td>${user.sample_count || 0}</td>
        <td class="flex" style="gap:6px; flex-wrap:wrap;">
          ${assignButton}
          <button class="ghost" data-view-samples="${user.id}">View samples (${user.sample_count || 0})</button>
          <button class="ghost" data-reset-password="${user.id}" data-username="${user.username}" ${user.role === ROLE_SUPER_ADMIN ? "disabled" : ""}>Reset password</button>
          <button class="danger" data-delete-user="${user.id}" data-username="${user.username}" ${deleteDisabled}>Delete</button>
        </td>
      </tr>`;
    })
    .join("");
  table.innerHTML = header + rows;
}

function onUsersTableClick(e) {
  const manageBtn = e.target.closest("button[data-manage-instruments]");
  if (manageBtn) {
    const userId = parseInt(manageBtn.dataset.manageInstruments, 10);
    const user = state.users.find((u) => u.id === userId);
    if (user) openInstrumentAssignmentModal(user);
    return;
  }
  const viewBtn = e.target.closest("button[data-view-samples]");
  if (viewBtn) {
    const userId = parseInt(viewBtn.dataset.viewSamples, 10);
    openUserSamples(userId);
    return;
  }
  const resetBtn = e.target.closest("button[data-reset-password]");
  if (resetBtn) {
    const userId = parseInt(resetBtn.dataset.resetPassword, 10);
    const username = resetBtn.dataset.username;
    if (userId) openPasswordResetModal(userId, username);
    return;
  }
  const deleteBtn = e.target.closest("button[data-delete-user]");
  if (deleteBtn) {
    const userId = parseInt(deleteBtn.dataset.deleteUser, 10);
    const username = deleteBtn.dataset.username;
    if (userId && !confirm(`Delete ${username}? This removes their reservations and samples permanently.`)) {
      return;
    }
    if (userId) handleDeleteUser(userId);
    return;
  }
}

async function onUsersTableChange(e) {
  const select = e.target.closest("select[data-role-select]");
  if (!select) return;
  const userId = parseInt(select.dataset.roleSelect, 10);
  const prevRole = select.dataset.prevRole || select.value;
  if (select.value === prevRole) return;
  try {
    await api(`/api/users/${userId}/role`, "PUT", { role: select.value });
    showToast("Role updated");
    await loadUsers();
  } catch (err) {
    select.value = prevRole;
    showToast(err.message);
  }
}

async function handleCreateUser() {
  try {
    const username = $("new-user-username").value.trim();
    const password = $("new-user-password").value;
    const role = $("new-user-role").value;
    if (!username || !password) return showToast("Username and password are required");
    await api("/api/users", "POST", {
      username,
      password,
      role,
      full_name: $("new-user-fullname").value || undefined,
      email: $("new-user-email").value || undefined,
    });
    showToast("User created");
    $("new-user-username").value = "";
    $("new-user-password").value = "";
    $("new-user-fullname").value = "";
    $("new-user-email").value = "";
    await loadUsers();
  } catch (e) {
    showToast(e.message);
  }
}

async function openInstrumentAssignmentModal(user) {
  const assigned = new Set(user.instruments.map((inst) => inst.id));
  const list = state.instrumentList || [];
  const optionsHtml = list.length
    ? list
        .map((inst) => `
          <label class="flex" style="gap:6px; align-items:center;">
            <input type="checkbox" data-inst-id="${inst.id}" ${assigned.has(inst.id) ? "checked" : ""}>
            ${inst.name}
          </label>
        `)
        .join("")
    : '<div class="subtle">No instruments available; please add some in the admin panel first.</div>';
  openModal(`
    <div class="flex-between">
      <h3>Assign instruments to ${user.full_name || user.username}</h3>
      <button class="ghost" onclick="closeModal()">Cancel</button>
    </div>
    <div class="flex" style="flex-wrap:wrap; gap:10px; margin-top:12px;">
      ${optionsHtml}
    </div>
    <div style="margin-top:12px;" class="flex">
      <button class="primary" onclick="saveInstrumentAssignment(${user.id})">Save</button>
      <button class="ghost" onclick="closeModal()">Close</button>
    </div>
  `);
}

async function saveInstrumentAssignment(userId) {
  try {
    const checks = Array.from(modalContent.querySelectorAll("input[data-inst-id]"));
    const selected = checks.filter((c) => c.checked).map((c) => parseInt(c.dataset.instId, 10));
    await api(`/api/users/${userId}/instruments`, "PUT", { instrument_ids: selected });
    showToast("Instrument assignment saved");
    closeModal();
    await loadUsers();
  } catch (e) { showToast(e.message); }
}

function openPasswordResetModal(userId, username) {
  openModal(`
    <div class="flex-between">
      <h3>Reset password for ${username}</h3>
      <button class="ghost" onclick="closeModal()">Close</button>
    </div>
    <label>New password</label>
    <input id="reset-user-password" type="password" placeholder="Enter a new password">
    <div class="flex" style="margin-top:12px; gap:10px;">
      <button class="primary" onclick="handleResetUserPassword(${userId})">Save</button>
      <button class="ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function handleResetUserPassword(userId) {
  const password = $("reset-user-password").value;
  if (!password) return showToast("Password is required");
  try {
    await api(`/api/users/${userId}/password`, "PUT", { password });
    showToast("Password reset");
    closeModal();
    $("reset-user-password").value = "";
    await loadUsers();
  } catch (e) {
    showToast(e.message);
  }
}

async function handleDeleteUser(userId) {
  try {
    await api(`/api/users/${userId}`, "DELETE");
    showToast("User deleted");
    await loadUsers();
  } catch (e) {
    showToast(e.message);
  }
}

async function openUserSamples(userId) {
  try {
    const user = state.users.find((u) => u.id === userId);
    const samples = await api(`/api/users/${userId}/samples`);
    samples.forEach(cacheSampleDetail);
    const rows = samples.length
      ? samples
          .map((s) => `
            <tr>
              <td>${escapeHtml(s.name)}</td>
              <td>${escapeHtml(s.remark) || "-"}</td>
              <td>${s.tga_image ? "✔" : ""}</td>
              <td>${s.bet_image ? "✔" : ""}</td>
              <td>${s.pxrd_image ? "✔" : ""}</td>
              <td><button class="ghost" onclick="openSampleDetailById(${s.id})">View sample</button></td>
            </tr>
          `)
          .join("")
      : '<tr><td colspan="6">No samples</td></tr>';
    openModal(`
      <div class="flex-between">
        <h3>${user ? `${user.full_name || user.username}` : "User"}'s samples</h3>
        <button class="ghost" onclick="closeModal()">Close</button>
      </div>
      <table class="table" style="margin-top:10px;">
        <tr><th>Name</th><th>Notes</th><th>TGA</th><th>BET</th><th>PXRD</th><th>Action</th></tr>
        ${rows}
      </table>
    `);
  } catch (e) { showToast(e.message); }
}

function renderCards() {
  if (!cardsGrid) return;
  const statusMeta = {
    normal: { label: "Normal", class: "status-normal" },
    maintenance: { label: "Maintenance", class: "status-maintenance" },
    fault: { label: "Fault", class: "status-fault" },
    offline: { label: "Offline", class: "status-offline" },
  };
  const defaultAvatar = "/static/uploads/avatars/default.png";
  cardsGrid.innerHTML = state.instruments
    .map((inst) => {
      const status = statusMeta[inst.status] || statusMeta.normal;
      const photo = inst.current?.photo_url || defaultAvatar;
      const currentName = inst.current ? inst.current.user || "Unknown" : "Currently available";
      const currentPeriod = inst.current ? `${inst.current.start} - ${inst.current.end}` : "—";
      const currentNote = inst.current?.note || "No notes";
      const nextName = inst.next ? inst.next.user || "-" : "No upcoming bookings";
      const nextPeriod = inst.next ? `${inst.next.start} - ${inst.next.end}` : "—";
      return `
        <div class="instrument-card" data-id="${inst.id}">
          <div class="instrument-header">
            <span class="instrument-name ${status.class}">${inst.name}</span>
            <span class="status-pill">Status: ${status.label}</span>
          </div>
          <div class="header-divider"></div>
          <div class="instrument-card-body">
            <div class="card-photo">
              <img class="avatar" src="${photo}" onerror="this.src='${defaultAvatar}'" alt="${escapeAttr(inst.name)}" data-full-url="${escapeAttr(photo)}" data-full-label="${escapeAttr(`${inst.name} avatar`)}">
            </div>
            <div class="reservation-details">
              <div class="current-user-name">${currentName}</div>
              <div class="current-period">${currentPeriod}</div>
              <div class="current-note">${currentNote}</div>
            </div>
          </div>
          <div class="bottom-divider"></div>
          <div class="next-row">
            <span class="next-user">${nextName}</span>
            <span class="next-period">${nextPeriod}</span>
          </div>
        </div>
      `;
    })
    .join("");
  attachImagePreviewHandlers(cardsGrid);
}

function renderInstrumentPrefer() {
  const prefer = $("instrument-prefer");
  if (!prefer) return;
  prefer.innerHTML = `<option value="ASAP">ASAP (assign flexibly based on availability)</option>` +
    state.instrumentList.map((i) => `<option value="${i.name}">${i.name}</option>`).join("");
}

function renderInstrumentTable() {
  const table = $("inst-table");
  if (!table) return;
  table.innerHTML = `<tr><th>Name</th><th>Status</th><th></th></tr>` +
    state.instrumentList.map((i) => `<tr>
      <td>${i.name}</td>
      <td>${i.status}</td>
      <td><button class="ghost" data-edit-inst="${i.id}">Edit</button></td>
    </tr>`).join("");
}

function renderOptionSelect() {
  const sel = $("opt-select");
  if (!sel) return;
  sel.innerHTML = state.options.map((o) => `<option value="${o.id}">${o.name}</option>`).join("");
  updateOptionHint();
}

function renderOptionTable() {
  const table = $("opt-table");
  if (!table) return;
  table.innerHTML = `<tr><th>Name</th><th>Requirements</th></tr>` +
    state.options.map((o) => {
      const chips = [];
      if (o.require_tga) chips.push("TGA");
      if (o.require_pxrd) chips.push("PXRD");
      if (o.require_bet) chips.push("BET");
      return `<tr><td>${o.name}</td><td>${chips.join(" / ")}</td></tr>`;
    }).join("");
}

function renderSamplesTable() {
  const table = $("samples-table");
  if (!table) return;
  if (!state.samples.length) {
    table.innerHTML = `<tr><td>No samples</td></tr>`;
    return;
  }
  state.samples.forEach(cacheSampleDetail);
  table.innerHTML = `<tr><th>Name</th><th>Notes</th><th>TGA</th><th>BET</th><th>PXRD</th><th>Actions</th></tr>` +
    state.samples.map((s) => `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.remark) || "-"}</td>
        <td>${s.tga_image ? "✔" : ""}</td>
        <td>${s.bet_image ? "✔" : ""}</td>
        <td>${s.pxrd_image ? "✔" : ""}</td>
        <td class="flex" style="gap:6px;">
          <button class="ghost" data-view-sample="${s.id}">View sample</button>
          <button class="ghost" data-edit-sample="${s.id}">Edit</button>
        </td>
      </tr>`).join("");
}

function refreshSampleRows() {
  const container = $("sample-rows");
  if (!container) return;
  if (!container.children.length) addSampleRow();
  Array.from(container.querySelectorAll("select")).forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = `<option value="">Select a sample</option>` + state.samples.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
    sel.value = current;
  });
}

function addSampleRow() {
  const container = $("sample-rows");
  if (!container) return;
  const row = document.createElement("div");
  row.className = "flex sample-row";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <select style="flex:1" class="sample-select"></select>
    <input style="flex:1" placeholder="Notes (optional)" class="sample-note" />
    <button class="ghost" type="button">Delete</button>
  `;
  row.querySelector("button").onclick = () => row.remove();
  container.appendChild(row);
  refreshSampleRows();
}

function renderMySubmissions() {
  const table = $("my-submissions-table");
  if (!table) return;
  const header = `<tr><th>ID</th><th>Option</th><th>Instrument preference</th><th>Status</th><th>Time slot</th><th>Assigned instrument</th><th>Notes</th><th>Actions</th></tr>`;
  const rows = state.submissions
    .map((s) => {
      const displayStatus = getSubmissionDisplayStatus(s);
      const statusTag = renderSubmissionStatusTag(displayStatus);
      const baseStatus = (s.status || "").toLowerCase();
      const hasReservation = Boolean(s.reservation_id);
      const canDelete = !hasReservation && ["submitted", "rejected"].includes(baseStatus);
      const deleteButton = canDelete
        ? `<button class="ghost" data-delete-submission="${s.id}">Delete</button>`
        : "-";
      return `<tr>
        <td>${s.id}</td>
        <td>${s.option_name}</td>
        <td>${s.instrument_preference}</td>
        <td>${statusTag}</td>
        <td>${s.scheduled_start || "-"}${s.scheduled_end ? " - " + s.scheduled_end : ""}</td>
        <td>${s.instrument_assigned_id ? (findInstrumentName(s.instrument_assigned_id) || s.instrument_assigned_id) : "Unassigned"}</td>
        <td>${s.remark || ""}</td>
        <td class="flex" style="gap:6px;">
          <button class="ghost" data-view-sub="${s.id}">View details</button>
          ${deleteButton}
        </td>
      </tr>`;
    })
    .join("");
  table.innerHTML = header + (rows || `<tr><td colspan="8">No submissions</td></tr>`);
}

function getSubmissionDisplayStatus(submission) {
  const raw = (submission.status || "").toLowerCase();
  if (raw === "scheduled" && submission.scheduled_end) {
    const now = new Date();
    const end = new Date(`${submission.scheduled_end}T23:59:59`);
    if (end < now) {
      return "completed";
    }
  }
  return raw || "submitted";
}

function renderSubmissionStatusTag(status) {
  const map = {
    scheduled: { label: "Scheduled", cls: "submission-scheduled" },
    submitted: { label: "Submitted", cls: "submission-submitted" },
    rejected: { label: "Rejected", cls: "submission-rejected" },
    completed: { label: "Completed", cls: "submission-completed" },
  };
  const data = map[status?.toLowerCase()] || { label: status || "Unknown", cls: "submission-default" };
  return `<span class="submission-status ${data.cls}">${data.label}</span>`;
}

function renderAllSubmissions() {
  const table = $("all-submissions-table");
  if (!table) return;
  const filtered = getFilteredSubmissions();
  scheduleTotalPages = Math.max(1, Math.ceil(filtered.length / SCHEDULE_PAGE_SIZE));
  if (schedulePage > scheduleTotalPages) schedulePage = scheduleTotalPages;
  const offset = (schedulePage - 1) * SCHEDULE_PAGE_SIZE;
  const pageRows = filtered.slice(offset, offset + SCHEDULE_PAGE_SIZE);
  const header = `<tr><th>ID</th><th>User</th><th>Option</th><th>Instrument preference</th><th>Notes</th><th>Samples</th><th>Status</th><th>Schedule</th><th>Details</th><th>Unschedule</th><th>Reject</th></tr>`;
  const rows = pageRows
    .map((s) => {
      const displayStatus = getSubmissionDisplayStatus(s);
      const rejectDisabled = ["rejected", "completed"].includes(displayStatus);
      return `<tr>
      <td>${s.id}</td>
      <td>${s.user}</td>
      <td>${s.option_name}</td>
      <td>${s.instrument_preference}</td>
      <td>${s.remark || ""}</td>
      <td>${s.samples}</td>
      <td>${renderSubmissionStatusTag(displayStatus)}</td>
      <td><a class="primary" href="/dashboard?schedule_for=${s.id}&user_id=${s.user_id}&user_name=${encodeURIComponent(s.user)}">Schedule</a></td>
      <td><button class="ghost" data-view-sub="${s.id}">View details</button></td>
      <td><button class="danger" data-unschedule="${s.reservation_id || ""}" ${s.reservation_id ? "" : 'disabled'}>Unschedule</button></td>
      <td><button class="danger" data-reject-sub="${s.id}" ${rejectDisabled ? "disabled" : ""}>Reject</button></td>
    </tr>`;
    })
    .join("");
  table.innerHTML = header + (rows || `<tr><td colspan="11">No submissions for the selected option</td></tr>`);
  renderScheduleFilterOptions();
  renderSchedulePagination();
}

function getFilteredSubmissions() {
  if (scheduleFilterOption === "all") return state.allSubmissions;
  return state.allSubmissions.filter((s) => s.option_name === scheduleFilterOption);
}

function renderScheduleFilterOptions() {
  const select = $("schedule-option-filter");
  if (!select) return;
  const options = state.options.map((opt) => opt.name).filter(Boolean);
  const unique = [...new Set(options)];
  const optionsHtml = ["all", ...unique]
    .map((name) => `<option value="${name}">${name === "all" ? "All options" : name}</option>`)
    .join("");
  select.innerHTML = optionsHtml;
  if (scheduleFilterOption !== "all" && !unique.includes(scheduleFilterOption)) {
    scheduleFilterOption = "all";
  }
  select.value = scheduleFilterOption;
}

function renderSchedulePagination() {
  const container = $("schedule-pagination");
  if (!container) return;
  const prevDisabled = schedulePage <= 1 ? "disabled" : "";
  const nextDisabled = schedulePage >= scheduleTotalPages ? "disabled" : "";
  container.innerHTML = `
    <button class="ghost" data-page-target="prev" ${prevDisabled}>Prev</button>
    <span>Page ${schedulePage} / ${scheduleTotalPages}</span>
    <button class="ghost" data-page-target="next" ${nextDisabled}>Next</button>
  `;
}

function handleScheduleFilterChange(e) {
  scheduleFilterOption = e.target.value;
  schedulePage = 1;
  renderAllSubmissions();
}

function handleSchedulePagination(e) {
  const btn = e.target.closest("button[data-page-target]");
  if (!btn) return;
  const target = btn.dataset.pageTarget;
  if (target === "prev") {
    if (schedulePage > 1) schedulePage -= 1;
  } else if (target === "next") {
    if (schedulePage < scheduleTotalPages) schedulePage += 1;
  }
  renderAllSubmissions();
}

function updateOptionHint() {
  const optIdEl = $("opt-select");
  if (!optIdEl) return;
  const opt = state.options.find((o) => o.id === parseInt(optIdEl.value));
  if (!opt) return;
  const tags = [];
  if (opt.require_tga) tags.push("TGA");
  if (opt.require_pxrd) tags.push("PXRD");
  if (opt.require_bet) tags.push("BET");
  const hint = $("reserve-hint");
  if (hint) hint.textContent = `Requirements: ${tags.join(" / ")}`;
}

function closeModal() {
  if (modalBackdrop) {
    modalBackdrop.style.display = "none";
    modalContent.innerHTML = "";
  }
  modalHistoryStack.length = 0;
}

function openModal(html) {
  if (modalBackdrop) {
    modalContent.innerHTML = html;
    modalBackdrop.style.display = "flex";
  }
}

async function openInstrumentModal(instId) {
  try {
    const list = await api(`/api/instruments/${instId}/reservations`);
    const inst = state.instruments.find((i) => i.id === instId) || state.instrumentList.find((i) => i.id === instId);
    const rows = list.map((r) => `<tr><td>${r.user}</td><td>${r.start} - ${r.end}</td><td>${r.status}</td><td>${r.note || ""}</td></tr>`).join("");
    openModal(`
      <div class="flex-between">
        <h3>${inst?.name || "Instrument"} schedule</h3>
        <button class="ghost" onclick="closeModal()">Close</button>
      </div>
      <table class="table"><tr><th>User</th><th>Date</th><th>Status</th><th>Notes</th></tr>${rows || '<tr><td>No reservations</td></tr>'}</table>
    `);
  } catch (e) { showToast(e.message); }
}

async function openScheduleModal(instId) {
  try {
    const list = await api(`/api/instruments/${instId}/reservations`);
    const inst = state.instruments.find((i) => i.id === instId) || state.instrumentList.find((i) => i.id === instId);
    const rows = list.map((r) => `<tr><td>${r.user}</td><td>${r.start} - ${r.end}</td><td>${r.status}</td></tr>`).join("");
    openModal(`
      <div class="flex-between">
    <h3>Assign ${inst?.name || "Instrument"} to ${state.scheduleFor?.user || "User"}</h3>
    <button class="ghost" onclick="closeModal()">Cancel</button>
      </div>
      <div class="subtle">Select start and end dates (full days) to avoid overlapping existing bookings below.</div>
      <div class="grid-2" style="margin:12px 0;">
        <div>
          <label>Start date</label>
          <input type="date" id="sched-start">
        </div>
        <div>
          <label>End date</label>
          <input type="date" id="sched-end">
        </div>
      </div>
      <table class="table"><tr><th>User</th><th>Date</th><th>Status</th></tr>${rows || '<tr><td>No reservations</td></tr>'}</table>
      <div style="margin-top:12px;">
        <button class="primary" onclick="assignSchedule(${instId})">Confirm assignment</button>
      </div>
    `);
  } catch (e) { showToast(e.message); }
}

async function assignSchedule(instId) {
  try {
    const start = $("sched-start").value;
    const end = $("sched-end").value;
    if (!start || !end) return showToast("Please select dates");
    await api(`/api/instruments/${instId}/reserve`, "POST", {
      user_id: state.scheduleFor.user_id,
      start_date: start,
      end_date: end,
      note: `From submission ${state.scheduleFor.id}`,
      submission_id: state.scheduleFor.id,
    });
    showToast("Time slot assigned");
    window.location = "/dashboard";
  } catch (e) { showToast(e.message); }
}

async function handleLogout() {
  await api("/api/logout", "POST");
  window.location = "/login";
}

async function handleAddSample() {
  try {
    const name = $("sample-name").value;
    if (!name) return showToast("Sample name is required");
    const tgaFile = $("sample-tga").files[0];
    const betFile = $("sample-bet").files[0];
    const pxrdFile = $("sample-pxrd").files[0];

    const [tgaUrl, betUrl, pxrdUrl] = await Promise.all([
      tgaFile ? uploadImage("tga", tgaFile) : null,
      betFile ? uploadImage("bet", betFile) : null,
      pxrdFile ? uploadImage("pxrd", pxrdFile) : null,
    ]);

    await api("/api/samples", "POST", {
      name,
      remark: $("sample-remark").value,
      tga_image: tgaUrl,
      bet_image: betUrl,
      pxrd_image: pxrdUrl,
    });
    showToast("Sample created");
    $("sample-name").value = "";
    ["sample-tga", "sample-bet", "sample-pxrd"].forEach((id) => { const el = $(id); if (el) el.value = ""; });
    await loadSamples();
  } catch (e) { showToast(e.message); }
}

function samplesMeetRequirement(sampleId, option) {
  const sample = state.samples.find((s) => s.id === parseInt(sampleId));
  if (!sample) return false;
  if (option.require_tga && !sample.tga_image) return false;
  if (option.require_pxrd && !sample.pxrd_image) return false;
  if (option.require_bet && !sample.bet_image) return false;
  return true;
}

async function handleSubmitReserve() {
  try {
    const optionId = parseInt($("opt-select").value);
    const option = state.options.find((o) => o.id === optionId);
    const samples = Array.from(document.querySelectorAll(".sample-row"))
      .map((row) => ({ sample_id: parseInt(row.querySelector("select").value), note: row.querySelector(".sample-note").value }))
      .filter((s) => s.sample_id);
    if (!option) return showToast("Please select a reservation option");
    if (!samples.length) return showToast("Select at least one sample");
    for (const s of samples) {
      if (!samplesMeetRequirement(s.sample_id, option)) return showToast("Sample attributes do not meet the reservation option requirements");
    }
    await api("/api/submissions", "POST", {
      option_id: optionId,
      instrument_preference: $("instrument-prefer").value,
      samples,
      remark: $("reserve-remark").value,
    });
    showToast("Submitted");
    await loadMySubmissions();
    await loadAllSubmissions();
  } catch (e) { showToast(e.message); }
}

async function handleCreateInstrument() {
  try {
    await api("/api/instruments", "POST", {
      name: $("adm-inst-name").value,
      status: $("adm-inst-status").value,
      description: $("adm-inst-desc").value,
    });
    showToast("Instrument created");
    $("adm-inst-name").value = "";
    await loadInstrumentList();
  } catch (e) { showToast(e.message); }
}

async function handleCreateOption() {
  try {
    await api("/api/options", "POST", {
      name: $("adm-opt-name").value,
      require_tga: $("chk-tga").checked,
      require_pxrd: $("chk-pxrd").checked,
      require_bet: $("chk-bet").checked,
    });
    showToast("Reservation option created");
    $("adm-opt-name").value = "";
    await loadOptions();
  } catch (e) { showToast(e.message); }
}

async function handleInsertUrgent() {
  try {
    const instId = parseInt($("insert-inst-select").value, 10);
    const userId = parseInt($("insert-user-select").value, 10);
    const startDate = $("insert-start-date").value;
    const days = parseInt($("insert-days").value, 10);
    const note = $("insert-note").value;
    if (!instId) return showToast("Select an instrument");
    if (!userId) return showToast("Select a user");
    if (!startDate) return showToast("Choose a start date");
    if (!days || days <= 0) return showToast("Duration must be at least 1 day");
    await api(`/api/instruments/${instId}/insert`, "POST", {
      user_id: userId,
      start_date: startDate,
      days,
      note: note || undefined,
    });
    showToast("Priority slot inserted");
    $("insert-note").value = "";
    $("insert-start-date").value = "";
    $("insert-days").value = "1";
    $("insert-inst-select").value = "";
    $("insert-user-select").value = "";
    await loadAllSubmissions();
    await loadInstruments();
    await loadInstrumentList();
  } catch (e) {
    showToast(e.message);
  }
}

function fillProfileForm() {
  if (!state.user) return;
  $("prof-fullname") && ($("prof-fullname").value = state.user.full_name || "");
  $("prof-grade") && ($("prof-grade").value = state.user.grade || "");
  $("prof-org") && ($("prof-org").value = state.user.org || "");
  $("prof-phone") && ($("prof-phone").value = state.user.phone || "");
  $("prof-email") && ($("prof-email").value = state.user.email || "");
  $("prof-photo") && ($("prof-photo").value = state.user.photo_url || "");
  if ($("prof-photo-file")) $("prof-photo-file").value = "";
  if (state.user && !state.user.photo_url && $("prof-photo")) {
    $("prof-photo").value = "/static/uploads/avatars/default.png";
  }
  const avatarPreview = $("profile-avatar-preview");
  if (avatarPreview) {
    const url = state.user.photo_url || "/static/uploads/avatars/default.png";
    avatarPreview.src = url;
    avatarPreview.dataset.fullUrl = url;
    avatarPreview.dataset.fullLabel = `${state.user.full_name || state.user.username}'s avatar`;
    attachImagePreviewHandlers(avatarPreview);
  }
}

async function handleSaveProfile() {
  try {
    let photoUrl = $("prof-photo").value || null;
    const file = $("prof-photo-file")?.files?.[0];
    if (file) photoUrl = await uploadImage("avatars", file);
    await api("/api/me", "PUT", {
      full_name: $("prof-fullname").value,
      grade: $("prof-grade").value,
      org: $("prof-org").value,
      phone: $("prof-phone").value,
      email: $("prof-email").value,
      photo_url: photoUrl || undefined,
    });
    showToast("Saved");
    await loadMe();
  } catch (e) { showToast(e.message); }
}

async function handleChangePassword() {
  try {
    const current = $("prof-current-password").value;
    const next = $("prof-new-password").value;
    if (!current || !next) return showToast("Current and new passwords are required");
    await api("/api/me/password", "PUT", { current_password: current, new_password: next });
    showToast("Password updated");
    $("prof-current-password").value = "";
    $("prof-new-password").value = "";
  } catch (e) {
    showToast(e.message);
  }
}

function onSampleTableClick(e) {
  const viewBtn = e.target.closest("button[data-view-sample]");
  if (viewBtn) {
    const id = parseInt(viewBtn.dataset.viewSample, 10);
    openSampleDetailById(id);
    return;
  }
  const btn = e.target.closest("button[data-edit-sample]");
  if (!btn) return;
  const id = parseInt(btn.dataset.editSample);
  const sample = state.samples.find((s) => s.id === id);
  if (!sample) return;
  openSampleEditModal(sample);
}

function openSampleEditModal(sample) {
  openModal(`
    <div class="flex-between">
      <h3>Edit sample: ${sample.name}</h3>
      <button class="ghost" onclick="closeModal()">Close</button>
    </div>
    <label>Name</label>
    <input id="edit-name" value="${sample.name}">
    <label>Notes</label>
    <input id="edit-remark" value="${sample.remark || ""}">
    <label>TGA image (leave blank to keep)</label>
    <input id="edit-tga" type="file" accept="image/*">
    <label>BET image (leave blank to keep)</label>
    <input id="edit-bet" type="file" accept="image/*">
    <label>PXRD image (leave blank to keep)</label>
    <input id="edit-pxrd" type="file" accept="image/*">
    <div style="margin-top:12px;" class="flex">
      <button class="primary" onclick="handleUpdateSample(${sample.id})">Save</button>
      <button class="ghost" onclick="handleDeleteSample(${sample.id})">Delete</button>
    </div>
  `);
}

async function handleUpdateSample(sampleId) {
  try {
    const name = $("edit-name").value;
    const remark = $("edit-remark").value;
    const tgaFile = $("edit-tga").files[0];
    const betFile = $("edit-bet").files[0];
    const pxrdFile = $("edit-pxrd").files[0];
    const [tgaUrl, betUrl, pxrdUrl] = await Promise.all([
      tgaFile ? uploadImage("tga", tgaFile) : null,
      betFile ? uploadImage("bet", betFile) : null,
      pxrdFile ? uploadImage("pxrd", pxrdFile) : null,
    ]);
    const body = { name, remark };
    if (tgaUrl) body.tga_image = tgaUrl;
    if (betUrl) body.bet_image = betUrl;
    if (pxrdUrl) body.pxrd_image = pxrdUrl;
    await api(`/api/samples/${sampleId}`, "PUT", body);
    showToast("Sample updated");
    closeModal();
    await loadSamples();
  } catch (e) { showToast(e.message); }
}

async function handleDeleteSample(sampleId) {
  if (!confirm("Are you sure you want to delete this sample?")) return;
  try {
    await api(`/api/samples/${sampleId}`, "DELETE");
    showToast("Sample deleted");
    closeModal();
    await loadSamples();
  } catch (e) { showToast(e.message); }
}

function onInstTableClick(e) {
  const btn = e.target.closest("button[data-edit-inst]");
  if (!btn) return;
  const id = parseInt(btn.dataset.editInst);
  const inst = state.instrumentList.find((i) => i.id === id);
  if (!inst) return;
  openInstrumentEditModal(inst);
}

function openInstrumentEditModal(inst) {
  openModal(`
    <div class="flex-between">
      <h3>Edit instrument: ${inst.name}</h3>
      <button class="ghost" onclick="closeModal()">Close</button>
    </div>
    <label>Name</label>
    <input id="edit-inst-name" value="${inst.name}">
    <label>Status</label>
    <select id="edit-inst-status">
      <option value="normal" ${inst.status === "normal" ? "selected" : ""}>Normal</option>
      <option value="maintenance" ${inst.status === "maintenance" ? "selected" : ""}>Maintenance</option>
      <option value="fault" ${inst.status === "fault" ? "selected" : ""}>Fault</option>
      <option value="offline" ${inst.status === "offline" ? "selected" : ""}>Offline</option>
    </select>
    <label>Description</label>
    <input id="edit-inst-desc" value="${inst.description || ""}">
    <div style="margin-top:12px;" class="flex">
      <button class="primary" onclick="handleUpdateInstrument(${inst.id})">Save</button>
      <button class="ghost" onclick="handleDeleteInstrument(${inst.id})">Delete</button>
    </div>
  `);
}

async function handleUpdateInstrument(instId) {
  try {
    await api(`/api/instruments/${instId}`, "PUT", {
      name: $("edit-inst-name").value,
      status: $("edit-inst-status").value,
      description: $("edit-inst-desc").value,
    });
    showToast("Instrument updated");
    closeModal();
    await loadInstrumentList();
  } catch (e) { showToast(e.message); }
}

async function handleDeleteInstrument(instId) {
  if (!confirm("Are you sure you want to delete this instrument?")) return;
  try {
    await api(`/api/instruments/${instId}`, "DELETE");
    showToast("Instrument deleted");
    closeModal();
    await loadInstrumentList();
  } catch (e) { showToast(e.message); }
}

async function handleViewSubmission(subId) {
  try {
    const detail = await api(`/api/submissions/${subId}`);
    const samples = detail.samples || [];
    samples.forEach(cacheSampleDetail);
    pushModalState(() => renderSubmissionDetail(detail), true);
    attachImagePreviewHandlers(modalContent);
  } catch (e) { showToast(e.message); }
}

function renderSubmissionDetail(detail) {
  const samples = detail.samples || [];
  const samplesHtml = samples.length
    ? samples.map((s) => `<li>${escapeHtml(s.name)} (${escapeHtml(s.note || "no notes")}) <button class="ghost" onclick="openSampleDetailById(${s.id})">View sample</button></li>`).join("")
    : "<li>No samples</li>";
  openModal(`
    <div class="flex-between">
      <h3>Submission details #${detail.id}</h3>
      <button class="ghost" onclick="closeModal()">Close</button>
    </div>
    <p>Submitted by: ${escapeHtml(detail.user || "")}</p>
    <p>Reservation option: ${escapeHtml(detail.option || "")}</p>
    <p>Instrument preference: ${escapeHtml(detail.instrument_preference || "")}</p>
    <p>Notes: ${escapeHtml(detail.remark || "")}</p>
    <p>Status: ${escapeHtml(detail.status || "")}</p>
    <p>Time slot: ${escapeHtml(detail.scheduled_start || "-")} ${detail.scheduled_end ? " - " + escapeHtml(detail.scheduled_end) : ""}</p>
    <h4>Samples</h4>
    <ul>${samplesHtml}</ul>
  `);
}

function onAllSubsTableClick(e) {
  const btn = e.target.closest("button[data-view-sub]");
  if (btn) {
    const id = parseInt(btn.dataset.viewSub);
    handleViewSubmission(id);
    return;
  }
  const rejectBtn = e.target.closest("button[data-reject-sub]");
  if (rejectBtn) {
    const id = parseInt(rejectBtn.dataset.rejectSub);
    if (!id) return;
    handleRejectSubmission(id);
    return;
  }
  const unschedBtn = e.target.closest("button[data-unschedule]");
  if (unschedBtn) {
    const id = parseInt(unschedBtn.dataset.unschedule);
    if (!id) return;
    handleUnschedule(id);
  }
}

async function handleUnschedule(reservationId) {
  if (!confirm("Are you sure you want to remove this scheduled slot?")) return;
  try {
    await api(`/api/reservations/${reservationId}`, "DELETE");
    showToast("Reservation removed");
    await loadAllSubmissions();
    await loadInstruments();
  } catch (e) {
    showToast(e.message);
  }
}

async function handleRejectSubmission(submissionId) {
  if (!confirm("Rejecting this submission will remove it from the scheduling queue. Continue?")) return;
  try {
    await api(`/api/submissions/${submissionId}/status`, "PUT", { status: "rejected" });
    showToast("Submission rejected");
    await loadAllSubmissions();
    await loadMySubmissions();
  } catch (e) {
    showToast(e.message);
  }
}

function onMySubmissionsTableClick(e) {
  const viewBtn = e.target.closest("button[data-view-sub]");
  if (viewBtn) {
    const id = parseInt(viewBtn.dataset.viewSub, 10);
    if (id) handleViewSubmission(id);
    return;
  }
  const deleteBtn = e.target.closest("button[data-delete-submission]");
  if (!deleteBtn) return;
  const id = parseInt(deleteBtn.dataset.deleteSubmission, 10);
  if (!id) return;
  handleDeleteSubmission(id);
}

async function handleDeleteSubmission(submissionId) {
  if (!confirm("Are you sure you want to delete this submission?")) return;
  try {
    await api(`/api/submissions/${submissionId}`, "DELETE");
    showToast("Submission deleted");
    await loadMySubmissions();
  } catch (e) {
    showToast(e.message);
  }
}

function initEvents() {
  if ($("btn-logout")) $("btn-logout").onclick = handleLogout;
  if ($("btn-add-sample")) $("btn-add-sample").onclick = handleAddSample;
  if ($("btn-add-sample-row")) $("btn-add-sample-row").onclick = addSampleRow;
  if ($("btn-submit-reserve")) $("btn-submit-reserve").onclick = handleSubmitReserve;
  if ($("btn-create-inst")) $("btn-create-inst").onclick = handleCreateInstrument;
  if ($("btn-create-opt")) $("btn-create-opt").onclick = handleCreateOption;
  if ($("btn-insert-urgent")) $("btn-insert-urgent").onclick = handleInsertUrgent;
  if ($("btn-create-user")) $("btn-create-user").onclick = handleCreateUser;
  if ($("opt-select")) $("opt-select").onchange = updateOptionHint;
  if (cardsGrid) cardsGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".instrument-card");
    if (!card) return;
    const id = parseInt(card.dataset.id);
    if (state.scheduleFor) openScheduleModal(id); else openInstrumentModal(id);
  });
  if (modalBackdrop) modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModal(); });
  const sampleTable = $("samples-table");
  if (sampleTable) sampleTable.addEventListener("click", onSampleTableClick);
  const instTable = $("inst-table");
  if (instTable) instTable.addEventListener("click", onInstTableClick);
  const allSubsTable = $("all-submissions-table");
  if (allSubsTable) allSubsTable.addEventListener("click", onAllSubsTableClick);
  const mySubsTable = $("my-submissions-table");
  if (mySubsTable) mySubsTable.addEventListener("click", onMySubmissionsTableClick);
  const usersTable = $("users-table");
  if (usersTable) {
    usersTable.addEventListener("click", onUsersTableClick);
    usersTable.addEventListener("change", onUsersTableChange);
  }
  const scheduleFilter = $("schedule-option-filter");
  if (scheduleFilter) scheduleFilter.addEventListener("change", handleScheduleFilterChange);
  const schedulePagination = $("schedule-pagination");
  if (schedulePagination) schedulePagination.addEventListener("click", handleSchedulePagination);
  if ($("btn-save-profile")) $("btn-save-profile").onclick = handleSaveProfile;
  if ($("btn-change-password")) $("btn-change-password").onclick = handleChangePassword;
  if ($("btn-toggle-full")) $("btn-toggle-full").onclick = toggleFullScreen;
}

(function parseScheduleParam() {
  const params = new URLSearchParams(window.location.search);
  const sid = params.get("schedule_for");
  if (sid) {
    state.scheduleFor = {
      id: parseInt(sid),
      user_id: parseInt(params.get("user_id")),
      user: params.get("user_name") || "User",
    };
    showToast(`Scheduling mode: submission ${state.scheduleFor.id}`);
  }
})();

(async function bootstrap() {
  initEvents();
  await loadMe();

  if (page === "dashboard") {
    await loadInstruments();
    setInterval(loadInstruments, 15000);
  }
  if (page === "samples") {
    await loadSamples();
  }
  if (page === "reservations") {
    await loadOptions();
    await loadInstrumentList();
    await loadSamples();
    await loadMySubmissions();
    addSampleRow();
  }
  if (page === "profile") {
    fillProfileForm();
  }
  if (page === "admin") {
    await loadInstrumentList();
    await loadOptions();
    await loadAllSubmissions();
    if (state.user?.role === ROLE_SUPER_ADMIN) {
      await loadUsers();
    }
  }
  if (page === "personnel") {
    await loadInstrumentList();
    await loadUsers();
  }
})();

function toggleFullScreen() {
  const body = document.body;
  const btn = $("btn-toggle-full");
  const active = body.classList.toggle("fullscreen");
  if (btn) btn.textContent = active ? "Exit fullscreen" : "Fullscreen";
}
