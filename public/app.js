/* Remindly front end. Plain JS, no build step. */

const $ = (sel) => document.querySelector(sel);
const views = {
  pin: $("#pin-view"),
  name: $("#name-view"),
  main: $("#main-view"),
  settings: $("#settings-view"),
};

const state = {
  config: null,
  items: [],
  tab: "open", // open | done | settings
  pin: localStorage.getItem("remindly.pin") || "",
  name: localStorage.getItem("remindly.name") || "",
  pushSubscription: null,
};

// ---------- helpers ----------
function show(view) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== view;
  const inApp = view === "main" || view === "settings";
  $("#tabbar").hidden = !inApp;
  $("#fab").hidden = view !== "main";
  window.scrollTo({ top: 0 });
}

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (state.pin) headers["x-pin"] = state.pin;
  const res = await fetch(`/api${path}`, {
    ...options,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    state.pin = "";
    localStorage.removeItem("remindly.pin");
    show("pin");
    throw new Error("pin");
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- rendering ----------
function render() {
  const U = state.config.urgency;
  const open = state.items.filter((i) => !i.done);
  const done = state.items.filter((i) => i.done);
  const total = state.items.length;
  const pct = total ? Math.round((done.length / total) * 100) : 0;
  const urgentCount = open.filter((i) => U[i.urgency].rank >= U.high.rank).length;

  // Hero + progress card
  const isDone = state.tab === "done";
  $("#hero-pill").textContent = isDone
    ? `${done.length} granted`
    : open.length === 0 ? "All caught up" : `${open.length} open · ${urgentCount} burning`;
  $("#hero-title").textContent = isDone ? "Granted" : "Wishes";
  $("#hero-lead").textContent = isDone
    ? "Everything that's already been taken care of."
    : "Everything she's hoping for, sorted by how badly.";
  $("#progress-sub").textContent = `${done.length} of ${total} wish${total === 1 ? "" : "es"}`;
  $("#progress-pct").textContent = `${pct}%`;
  $("#progress-bar").style.width = `${pct}%`;

  const rows = (isDone ? done : open).slice().sort((a, b) => {
    if (isDone) return new Date(b.doneAt || b.createdAt) - new Date(a.doneAt || a.createdAt);
    const r = U[b.urgency].rank - U[a.urgency].rank;
    return r !== 0 ? r : new Date(b.createdAt) - new Date(a.createdAt);
  });

  $("#list").innerHTML = rows
    .map((item) => {
      const u = U[item.urgency];
      const options = Object.entries(U)
        .map(([key, v]) => `<option value="${key}" ${key === item.urgency ? "selected" : ""}>${v.emoji} ${escapeHtml(v.label)}</option>`)
        .join("");
      return `
      <li class="item ${item.urgency} ${item.done ? "done" : ""}" id="item-${item.id}" data-id="${item.id}">
        <div class="head">
          <div class="title">${escapeHtml(item.title)}</div>
          <span class="badge ${item.urgency}">${u.emoji} ${escapeHtml(u.label)}</span>
        </div>
        ${item.note ? `<p class="note">${escapeHtml(item.note)}</p>` : ""}
        ${item.link ? `<a class="link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">↗ ${escapeHtml(item.link.replace(/^https?:\/\//, "").slice(0, 60))}</a>` : ""}
        <div class="meta">${item.addedBy ? `${escapeHtml(item.addedBy)} · ` : ""}${item.done && item.doneAt ? `granted ${timeAgo(item.doneAt)}` : `added ${timeAgo(item.createdAt)}`}</div>
        <div class="actions">
          <button type="button" class="${item.done ? "" : "got"}" data-action="toggle">${item.done ? "Reopen" : "✓ Got it"}</button>
          ${item.done ? "" : `<select data-action="urgency" aria-label="Change urgency">${options}</select>`}
          <span class="spacer"></span>
          <button type="button" class="danger" data-action="delete" aria-label="Delete">🗑</button>
        </div>
      </li>`;
    })
    .join("");
  const empty = $("#empty");
  empty.hidden = rows.length > 0;
  empty.textContent = isDone ? "Nothing granted yet." : "No open wishes. Tap + to add one.";
}

async function refresh() {
  try {
    state.items = await api("/items");
    render();
  } catch (err) {
    if (err.message !== "pin") console.warn(err);
  }
}

// ---------- push notifications ----------
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function getSwRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js");
}

async function updatePushStatus() {
  const status = $("#push-status");
  const btn = $("#push-btn");
  $("#ios-hint").hidden = !(isIOS && !isStandalone);
  $("#telegram-status").textContent = state.config.telegramEnabled
    ? "Telegram is connected too: every wish also lands in your Telegram chat."
    : "";

  if (!state.config.pushEnabled) {
    status.textContent = "Push isn't configured on the server yet (VAPID keys missing).";
    btn.disabled = true;
    return;
  }
  if (!("PushManager" in window) || !("serviceWorker" in navigator)) {
    status.textContent = isIOS && !isStandalone
      ? "Add Remindly to your home screen first to enable notifications."
      : "This browser doesn't support push notifications.";
    btn.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    status.textContent = "Notifications are blocked for this site. Allow them in your browser settings.";
    btn.disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  state.pushSubscription = await reg.pushManager.getSubscription();
  btn.disabled = false;
  if (state.pushSubscription) {
    status.textContent = "✓ This device gets notified for every new wish.";
    btn.textContent = "Stop notifying this device";
    btn.classList.replace("primary", "ghost");
  } else {
    status.textContent = "This device is not receiving notifications yet.";
    btn.textContent = "Notify me on this device";
    btn.classList.replace("ghost", "primary");
  }
}

async function togglePush() {
  const btn = $("#push-btn");
  btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (state.pushSubscription) {
      await api("/subscribe", { method: "DELETE", body: { endpoint: state.pushSubscription.endpoint } });
      await state.pushSubscription.unsubscribe();
      toast("Notifications off for this device");
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast("Notifications not allowed");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.config.vapidPublicKey),
      });
      await api("/subscribe", { method: "POST", body: sub.toJSON() });
      toast("You'll be notified here");
    }
  } catch (err) {
    console.error(err);
    toast(`Couldn't change notifications: ${err.message}`);
  } finally {
    await updatePushStatus();
  }
}

// ---------- add sheet ----------
function openSheet() {
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#title-input").focus(), 50);
}
function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}

// ---------- events ----------
$("#pin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  state.pin = $("#pin-input").value.trim();
  try {
    await api("/items");
    localStorage.setItem("remindly.pin", state.pin);
    $("#pin-error").hidden = true;
    $("#pin-input").value = "";
    boot();
  } catch {
    $("#pin-error").hidden = false;
  }
});

$("#name-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.name = $("#name-input").value.trim();
  if (!state.name) return;
  localStorage.setItem("remindly.name", state.name);
  boot();
});

$("#fab").addEventListener("click", openSheet);
$("#sheet").addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeSheet();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
});

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector("button[type=submit]");
  const body = {
    title: $("#title-input").value,
    urgency: form.urgency.value,
    note: $("#note-input").value,
    link: $("#link-input").value,
    addedBy: state.name,
  };
  btn.disabled = true;
  try {
    const item = await api("/items", { method: "POST", body });
    state.items.unshift(item);
    form.reset();
    closeSheet();
    state.tab = "open";
    setActiveTab();
    render();
    document.getElementById(`item-${item.id}`)?.classList.add("flash");
    toast("Added 💌");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest("li").dataset.id;
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  try {
    if (btn.dataset.action === "toggle") {
      const updated = await api(`/items/${id}`, { method: "PATCH", body: { done: !item.done } });
      Object.assign(item, updated);
      render();
      toast(updated.done ? "🎉 Wish granted" : "Reopened");
    } else if (btn.dataset.action === "delete") {
      if (!confirm(`Delete "${item.title}"?`)) return;
      await api(`/items/${id}`, { method: "DELETE" });
      state.items = state.items.filter((i) => i.id !== id);
      render();
      toast("Deleted");
    }
  } catch (err) {
    toast(err.message);
  }
});

$("#list").addEventListener("change", async (e) => {
  const sel = e.target.closest("select[data-action=urgency]");
  if (!sel) return;
  const id = sel.closest("li").dataset.id;
  const item = state.items.find((i) => i.id === id);
  try {
    const updated = await api(`/items/${id}`, { method: "PATCH", body: { urgency: sel.value } });
    Object.assign(item, updated);
    render();
  } catch (err) {
    toast(err.message);
  }
});

function setActiveTab() {
  document.querySelectorAll(".tabbar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
}
document.querySelectorAll(".tabbar .tab").forEach((t) =>
  t.addEventListener("click", async () => {
    state.tab = t.dataset.tab;
    setActiveTab();
    if (state.tab === "settings") {
      $("#me-name").textContent = state.name;
      show("settings");
      await updatePushStatus();
    } else {
      show("main");
      render();
    }
  })
);

$("#push-btn").addEventListener("click", togglePush);
$("#test-btn").addEventListener("click", async () => {
  try {
    const r = await api("/test-notification", { method: "POST", body: {} });
    toast(`Test sent to ${r.devices} device${r.devices === 1 ? "" : "s"}${r.telegram ? " + Telegram" : ""}`);
  } catch (err) {
    toast(err.message);
  }
});
$("#change-name-btn").addEventListener("click", () => {
  $("#name-input").value = state.name;
  show("name");
});
$("#logout-btn").addEventListener("click", () => {
  localStorage.removeItem("remindly.pin");
  state.pin = "";
  boot();
});

// Keep the list fresh while the app is open.
setInterval(() => { if (!views.main.hidden && document.visibilityState === "visible") refresh(); }, 30_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !views.main.hidden) refresh(); });

// ---------- boot ----------
async function boot() {
  if (!state.config) {
    state.config = await fetch("/api/config").then((r) => r.json());
  }
  if (state.config.pinRequired && !state.pin) return show("pin");
  if (!state.name) return show("name");
  state.tab = state.tab === "settings" ? "open" : state.tab;
  setActiveTab();
  show("main");
  await refresh();
  // Jump to an item when opened from a notification.
  const hash = location.hash;
  if (hash.startsWith("#item-")) {
    const el = document.querySelector(hash);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
    }
    history.replaceState(null, "", "/");
  }
}

getSwRegistration().catch((err) => console.warn("SW registration failed", err));
boot().catch((err) => {
  console.error(err);
  toast("Couldn't load. Is the server running?");
});
