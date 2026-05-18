const cardsGrid = document.getElementById("cards-grid");

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) { console.log(msg); return; }
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 2600);
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function renderCards(instruments) {
  if (!cardsGrid) return;
  const mapStatus = {
    normal: { label: "Normal", class: "status-normal" },
    maintenance: { label: "Maintenance", class: "status-maintenance" },
    fault: { label: "Fault", class: "status-fault" },
    offline: { label: "Offline", class: "status-offline" },
  };
  cardsGrid.innerHTML = instruments.map((inst) => {
    const status = mapStatus[inst.status] || mapStatus.normal;
    const current = inst.current
      ? `<div class="current-user">${inst.current.user || "-"}</div>
         <div class="subtle">${inst.current.start} - ${inst.current.end}</div>
         <div class="subtle">${inst.current.note || "No notes"}</div>`
      : '<div class="subtle">Currently available</div>';
    const next = inst.next
        ? `<div class="next-user">Next: ${inst.next.user} (${inst.next.start} - ${inst.next.end})</div>`
        : '<div class="next-user">No upcoming bookings</div>';
    const photo = inst.current?.photo_url || "/static/uploads/avatars/default.png";
    return `<div class="instrument-card">
      <div class="instrument-header">
        <div class="instrument-name ${status.class}">${inst.name}</div>
        <div class="status-pill ${status.class}">${status.label}</div>
      </div>
      <div class="card-body">
        <img class="avatar" src="${photo}" onerror="this.src='https://placehold.co/120x120?text=No+Photo'">
        <div>
          ${current}
          ${next}
        </div>
      </div>
    </div>`;
  }).join("");
}

async function refresh() {
  try {
    const data = await api("/api/public/instruments/status");
    renderCards(data);
    const ts = new Date().toLocaleTimeString();
    const status = document.getElementById("public-status");
    if (status) status.textContent = `Updated at ${ts}`;
  } catch (e) { showToast(e.message); }
}

function toggleFull() {
  const body = document.body;
  const btn = document.getElementById("btn-toggle-full-public");
  const active = body.classList.toggle("fullscreen");
  if (btn) btn.textContent = active ? "Exit fullscreen" : "Fullscreen";
}

(function init() {
  document.getElementById("btn-toggle-full-public")?.addEventListener("click", toggleFull);
  refresh();
  setInterval(refresh, 15000);
})();
