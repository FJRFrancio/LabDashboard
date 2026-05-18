async function api(path, method = "GET", body, isJson = true) {
  const opts = { method, credentials: "include" };
  if (body && isJson) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
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
  const el = document.getElementById("toast");
  if (!el) { alert(msg); return; }
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => (el.style.display = "none"), 2200);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-login").onclick = async () => {
    try {
      await api("/api/login", "POST", {
        username: document.getElementById("login-username").value,
        password: document.getElementById("login-password").value,
      });
      window.location = "/dashboard";
    } catch (e) { showToast(e.message); }
  };

  document.getElementById("btn-register").onclick = async () => {
    try {
      await api("/api/register", "POST", {
        username: document.getElementById("login-username").value,
        password: document.getElementById("login-password").value,
      });
      window.location = "/dashboard";
    } catch (e) { showToast(e.message); }
  };
});
