/* Remindly front end. Plain JS, no build step. */
import { icon, mountIcons } from "/icons.js";

// Lucide icon per urgency level (the server keeps emoji for notification text).
const URGENCY_ICON = { low: "leaf", medium: "clock", high: "flame", urgent: "siren" };

// Copy per category. Travel and home are shared idea lists, not shopping.
const CATEGORY_UI = {
  wish: { icon: "heart", title: "Wishes", pill: "Wishlist", lead: "Things we're hoping for, sorted by how badly.", placeholder: "I want…", sheet: "New wish", submit: "Add wish", progress: "Wishes granted", unit: "wish", units: "wishes", done: "Got it", doneVerb: "granted", emptyOpen: "No open wishes. Tap + to add one.", emptyDone: "Nothing granted yet." },
  travel: { icon: "plane", title: "Travel", pill: "Places & trips", lead: "Where we want to go, sooner or later.", placeholder: "Somewhere we should go…", sheet: "New travel idea", submit: "Add idea", progress: "Places visited", unit: "idea", units: "ideas", done: "Been there", doneVerb: "visited", emptyOpen: "No travel ideas yet. Tap + to dream a little.", emptyDone: "No trips ticked off yet." },
  home: { icon: "armchair", title: "Home", pill: "Furniture & home", lead: "Ideas for our place, big and small.", placeholder: "Something for our place…", sheet: "New home idea", submit: "Add idea", progress: "Home ideas done", unit: "idea", units: "ideas", done: "Done", doneVerb: "done", emptyOpen: "No home ideas yet. Tap + to add one.", emptyDone: "Nothing done yet." },
};
const ROLE_LABEL = { her: "Her", him: "Him" };
const CATEGORY_ICON = { wish: "heart", travel: "plane", home: "armchair", support: "hand-heart" };
const MOOD_ICON = { great: "sun", good: "smile", meh: "meh", low: "cloud-rain", overwhelmed: "cloud-lightning" };
const otherRole = (r) => (r === "her" ? "him" : r === "him" ? "her" : null);

const $ = (sel) => document.querySelector(sel);
const views = {
  pin: $("#pin-view"),
  name: $("#name-view"),
  main: $("#main-view"),
  score: $("#score-view"),
  support: $("#support-view"),
  settings: $("#settings-view"),
};

const state = {
  config: null,
  items: [],
  tab: "wish", // wish | travel | home | settings
  status: "open", // open | done
  who: "all", // all | her | him
  pin: localStorage.getItem("remindly.pin") || "",
  name: localStorage.getItem("remindly.name") || "",
  role: localStorage.getItem("remindly.role") || "",
  pushSubscription: null,
  score: null,
  moments: [],
  needs: new Set(),
};

/** Points the current user would earn by granting this item (mirrors game.js). */
function worth(item) {
  const g = state.config.game;
  if (!g || item.done || !item.role || !state.role || item.role === state.role) return 0;
  let pts = g.points[item.urgency] ?? g.points.medium;
  if (item.category === "travel") pts *= g.travelMultiplier;
  const days = (Date.now() - new Date(item.createdAt)) / 86400000;
  if (days <= g.quickDays) pts += g.quickBonus;
  return pts;
}

function confetti() {
  const box = $("#confetti");
  const colors = ["#ef6a45", "#e0567a", "#3f7fc4", "#f4b942", "#7bb37a", "#ffd1a8"];
  for (let i = 0; i < 36; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 0.4}s`;
    p.style.animationDuration = `${1.3 + Math.random() * 0.8}s`;
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
    setTimeout(() => p.remove(), 2400);
  }
}

// ---------- helpers ----------
function show(view) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== view;
  const inApp = view === "main" || view === "settings" || view === "score" || view === "support";
  $("#tabbar").hidden = !inApp;
  $("#settings-btn").hidden = !inApp || view === "settings";
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
  const ui = CATEGORY_UI[state.tab] || CATEGORY_UI.wish;
  const inCat = state.items.filter((i) => (i.category || "wish") === state.tab);
  const mine = state.who === "all" ? inCat : inCat.filter((i) => i.role === state.who);
  const open = mine.filter((i) => !i.done);
  const done = mine.filter((i) => i.done);
  const total = mine.length;
  const pct = total ? Math.round((done.length / total) * 100) : 0;
  const urgentCount = open.filter((i) => U[i.urgency].rank >= U.high.rank).length;
  const isDone = state.status === "done";

  // Hero + progress card
  $("#hero-pill").innerHTML = `${icon(ui.icon, "13px")} ${
    open.length === 0 ? ui.pill : `${open.length} open · ${urgentCount} burning`
  }`;
  $("#hero-title").textContent = ui.title;
  $("#hero-lead").textContent = ui.lead;
  $(".progress-title").textContent = ui.progress;
  $("#progress-sub").textContent = `${done.length} of ${total} ${total === 1 ? ui.unit : ui.units}`;
  $("#progress-pct").textContent = `${pct}%`;
  $("#progress-bar").style.width = `${pct}%`;
  document.querySelectorAll("#status-seg button").forEach((b) => b.classList.toggle("active", b.dataset.status === state.status));
  document.querySelectorAll("#who-seg button").forEach((b) => b.classList.toggle("active", b.dataset.who === state.who));

  const rows = (isDone ? done : open).slice().sort((a, b) => {
    if (isDone) return new Date(b.doneAt || b.createdAt) - new Date(a.doneAt || a.createdAt);
    const r = U[b.urgency].rank - U[a.urgency].rank;
    return r !== 0 ? r : new Date(b.createdAt) - new Date(a.createdAt);
  });

  $("#list").innerHTML = rows
    .map((item) => {
      const u = U[item.urgency];
      const options = Object.entries(U)
        .map(([key, v]) => `<option value="${key}" ${key === item.urgency ? "selected" : ""}>${escapeHtml(v.label)}</option>`)
        .join("");
      return `
      <li class="item ${item.urgency} ${item.done ? "done" : ""}" id="item-${item.id}" data-id="${item.id}">
        <div class="head">
          <div class="title">${escapeHtml(item.title)}</div>
          <span class="badge ${item.urgency}">${icon(URGENCY_ICON[item.urgency], "14px")} ${escapeHtml(u.label)}</span>
        </div>
        ${worth(item) ? `<div class="worth-row"><span class="worth">${icon("zap", "12px")} worth ${worth(item)} pts</span></div>` : ""}
        ${item.note ? `<p class="note">${escapeHtml(item.note)}</p>` : ""}
        ${item.link ? `<a class="link" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${icon("external-link", "14px")} ${escapeHtml(item.link.replace(/^https?:\/\//, "").slice(0, 60))}</a>` : ""}
        <div class="meta"><span class="who ${item.role || ""}">${escapeHtml(item.addedBy || ROLE_LABEL[item.role] || "Someone")}</span> · ${item.done && item.doneAt ? `${ui.doneVerb} ${timeAgo(item.doneAt)}` : `added ${timeAgo(item.createdAt)}`}</div>
        <div class="actions">
          <button type="button" class="${item.done ? "" : "got"}" data-action="toggle">${item.done ? icon("rotate-ccw", "16px") + " Reopen" : icon("check", "16px") + " " + ui.done + (worth(item) ? ` · +${worth(item)}` : "")}</button>
          ${item.done ? "" : `<select data-action="urgency" aria-label="Change urgency">${options}</select>`}
          <span class="spacer"></span>
          <button type="button" class="danger" data-action="delete" aria-label="Delete">${icon("trash-2", "17px")}</button>
        </div>
      </li>`;
    })
    .join("");
  const empty = $("#empty");
  empty.hidden = rows.length > 0;
  empty.innerHTML = isDone
    ? `${icon("party-popper", "28px")}<br>${ui.emptyDone}`
    : `${icon("sparkles", "28px")}<br>${ui.emptyOpen}`;
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
    status.textContent = "This device gets notified for every new wish.";
    btn.innerHTML = `${icon("bell-off", "18px")} <span>Stop notifying this device</span>`;
    btn.classList.replace("primary", "ghost");
  } else {
    status.textContent = "This device is not receiving notifications yet.";
    btn.innerHTML = `${icon("bell-ring", "18px")} <span>Notify me on this device</span>`;
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
      await api("/subscribe", { method: "POST", body: { ...sub.toJSON(), role: state.role } });
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
function syncSheetCategory() {
  const cat = $("#add-form").category.value;
  const ui = CATEGORY_UI[cat];
  $("#sheet-title").textContent = ui.sheet;
  $("#sheet-submit").textContent = ui.submit;
  $("#title-input").placeholder = ui.placeholder;
}

function openSheet() {
  const form = $("#add-form");
  form.category.value = CATEGORY_UI[state.tab] ? state.tab : "wish";
  syncSheetCategory();
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
  const form = e.currentTarget;
  state.name = $("#name-input").value.trim();
  state.role = form.role.value;
  if (!state.name || !state.role) return;
  localStorage.setItem("remindly.name", state.name);
  localStorage.setItem("remindly.role", state.role);
  boot();
});

$("#cat-seg").addEventListener("change", syncSheetCategory);

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
    category: form.category.value,
    note: $("#note-input").value,
    link: $("#link-input").value,
    addedBy: state.name,
    role: state.role,
  };
  btn.disabled = true;
  try {
    const item = await api("/items", { method: "POST", body });
    state.items.unshift(item);
    form.reset();
    closeSheet();
    state.tab = item.category;
    state.status = "open";
    if (state.who !== "all") state.who = "all";
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
      const updated = await api(`/items/${id}`, { method: "PATCH", body: { done: !item.done, role: state.role, actorName: state.name } });
      const { earned, levelUp, ...rest } = updated;
      Object.assign(item, rest);
      render();
      if (updated.done && earned > 0) {
        confetti();
        toast(levelUp ? `🏆 +${earned} pts · Level ${levelUp.level}: ${levelUp.title}!` : `🎉 +${earned} pts for you!`, 3000);
      } else {
        toast(updated.done ? `${CATEGORY_UI[state.tab]?.done || "Done"}!` : "Reopened");
      }
      state.score = null; // refetch next time the score tab opens
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

// ---------- support ----------
function chipHtml(label, on = false) {
  return `<button type="button" class="chip ${on ? "on" : ""}" data-chip="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
}

function renderSupportChips() {
  const sp = state.config.support;
  $("#needs-chips").innerHTML = sp.needs.map((n) => chipHtml(n, state.needs.has(n))).join("");
  $("#note-chips").innerHTML = sp.notePrompts.map((n) => chipHtml(n)).join("");
}

function renderMoments() {
  const sp = state.config.support;
  const list = $("#moments");
  const rows = state.moments.slice(0, 20);
  list.innerHTML = rows
    .map((m) => {
      const mine = m.role === state.role;
      const isCheckin = m.type === "checkin";
      const mood = isCheckin ? sp.moods[m.mood] : null;
      const title = isCheckin
        ? `${escapeHtml(m.name)} ${mine ? "felt" : "is feeling"} ${escapeHtml((mood?.label || m.mood).toLowerCase())}`
        : `Note from ${escapeHtml(m.name)}`;
      const iconName = isCheckin ? MOOD_ICON[m.mood] || "meh" : "message-circle-heart";
      const canReply = !mine && !m.response;
      return `
      <li data-id="${m.id}">
        <div class="moment-head">
          <div class="moment-icon ${isCheckin ? m.mood : "note"}">${icon(iconName, "18px")}</div>
          <div>
            <div class="moment-title">${title}</div>
            <div class="moment-sub"><span class="who ${m.role}">${escapeHtml(m.name)}</span> · ${timeAgo(m.createdAt)}</div>
          </div>
        </div>
        ${isCheckin && m.needs?.length ? `<div class="moment-needs">${m.needs.map((n) => `<span>${escapeHtml(n)}</span>`).join("")}</div>` : ""}
        ${m.text ? `<p class="moment-text">${escapeHtml(m.text)}</p>` : ""}
        ${m.response ? `<div class="moment-reply">${icon("reply", "15px")}<div>${escapeHtml(m.response.text)}<small><span class="who ${m.response.role}">${escapeHtml(m.response.name)}</span> · ${timeAgo(m.response.at)}</small></div></div>` : ""}
        ${canReply ? `<div class="reply-chips">${sp.replies.map((r) => `<button type="button" class="chip" data-reply="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join("")}</div>` : ""}
      </li>`;
    })
    .join("");
  $("#moments-empty").hidden = rows.length > 0;
}

async function renderSupport() {
  renderSupportChips();
  state.moments = await api("/support");
  renderMoments();
}

$("#needs-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-chip]");
  if (!b) return;
  const n = b.dataset.chip;
  state.needs.has(n) ? state.needs.delete(n) : state.needs.add(n);
  b.classList.toggle("on", state.needs.has(n));
});

$("#note-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-chip]");
  if (!b) return;
  $("#note-text").value = b.dataset.chip;
  $("#note-text").focus();
});

$("#checkin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const mood = form.mood.value;
  if (!mood) return toast("Pick how you're feeling first");
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const m = await api("/support/checkin", { method: "POST", body: { mood, needs: [...state.needs], text: $("#checkin-text").value, role: state.role, name: state.name } });
    state.moments.unshift(m);
    form.reset();
    state.needs.clear();
    renderSupportChips();
    renderMoments();
    toast("Sent. They'll get a nudge 💛");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#note-text").value.trim();
  if (!text) return toast("Write a few words first");
  const btn = e.currentTarget.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const m = await api("/support/note", { method: "POST", body: { text, role: state.role, name: state.name } });
    state.moments.unshift(m);
    $("#note-text").value = "";
    renderMoments();
    toast("Note sent 💌");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#moments").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-reply]");
  if (!b) return;
  const id = b.closest("li").dataset.id;
  try {
    const r = await api(`/support/${id}/reply`, { method: "POST", body: { text: b.dataset.reply, role: state.role, name: state.name } });
    const { earned, levelUp, ...m } = r;
    const idx = state.moments.findIndex((x) => x.id === id);
    if (idx >= 0) state.moments[idx] = m;
    renderMoments();
    if (earned > 0) {
      confetti();
      toast(levelUp ? `🏆 +${earned} pts · Level ${levelUp.level}: ${levelUp.title}!` : `💛 +${earned} pts for being there`, 3000);
    } else {
      toast("Sent 💛");
    }
    state.score = null;
  } catch (err) {
    toast(err.message);
  }
});

async function renderScore() {
  const data = await api("/score");
  state.score = data;
  const her = data.her, him = data.him;
  const name = (side) => side.name || ROLE_LABEL[side.role];
  $("#vs-her-name").textContent = name(her);
  $("#vs-him-name").textContent = name(him);
  $("#vs-her-pts").textContent = her.points;
  $("#vs-him-pts").textContent = him.points;
  $("#vs-her-sub").textContent = `Lv ${her.level} · ${her.title}`;
  $("#vs-him-sub").textContent = `Lv ${him.level} · ${him.title}`;
  const total = her.points + him.points;
  $("#tug-her").style.width = total ? `${(her.points / total) * 100}%` : "50%";
  $("#tug-him").style.width = total ? `${(him.points / total) * 100}%` : "50%";
  const diff = Math.abs(her.points - him.points);
  $("#vs-lead").textContent = total === 0
    ? "Nobody has scored yet. First grant takes the lead!"
    : diff === 0 ? "Dead heat. Someone grant something!"
    : `${name(her.points > him.points ? her : him)} leads by ${diff} pts${diff <= 30 ? " · it's close!" : ""}`;

  const me = data[state.role] || her;
  $("#level-num").textContent = me.level;
  $("#level-title").textContent = me.title;
  $("#level-sub").textContent = me.nextAt ? `${me.nextAt - me.points} pts to ${me.nextTitle}` : "Max level. Legendary.";
  $("#level-pts").textContent = me.points;
  $("#level-bar").style.width = `${Math.round(me.progress * 100)}%`;
  $("#stat-grants").textContent = me.grants;
  $("#stat-streak").textContent = me.streak;
  $("#stat-month").textContent = me.month;
  $("#badges").innerHTML = me.badges
    .map((b) => `<div class="badge-tile ${b.earned ? "earned" : "locked"}"><div class="ring">${icon(b.earned ? b.icon : "lock", "20px")}</div><div class="bname">${escapeHtml(b.name)}</div><div class="bdesc">${escapeHtml(b.desc)}</div></div>`)
    .join("");

  const feed = [...her.recent.map((r) => ({ ...r, by: name(her), side: "her" })), ...him.recent.map((r) => ({ ...r, by: name(him), side: "him" }))]
    .sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt))
    .slice(0, 8);
  $("#feed").innerHTML = feed
    .map((f) => `<li><div class="ficon">${icon(CATEGORY_ICON[f.category] || "heart", "16px")}</div><div class="ftext"><div class="ftitle">${escapeHtml(f.title)}</div><div class="fsub"><span class="who ${f.side}">${escapeHtml(f.by)}</span> · ${timeAgo(f.doneAt)}</div></div><div class="fpts">+${f.points}</div></li>`)
    .join("");
  $("#feed-empty").hidden = feed.length > 0;
}

function setActiveTab() {
  document.querySelectorAll(".tabbar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));
}
document.querySelectorAll(".tabbar .tab").forEach((t) =>
  t.addEventListener("click", async () => {
    state.tab = t.dataset.tab;
    setActiveTab();
    if (state.tab === "settings") {
      $("#me-name").textContent = state.name;
      $("#me-role").textContent = ROLE_LABEL[state.role] || "no side picked";
      show("settings");
      await updatePushStatus();
    } else if (state.tab === "score") {
      show("score");
      try { await renderScore(); } catch (err) { if (err.message !== "pin") toast(err.message); }
    } else if (state.tab === "support") {
      show("support");
      try { await renderSupport(); } catch (err) { if (err.message !== "pin") toast(err.message); }
    } else {
      state.status = "open";
      show("main");
      render();
    }
  })
);

$("#status-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-status]");
  if (!b) return;
  state.status = b.dataset.status;
  render();
});
$("#who-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-who]");
  if (!b) return;
  state.who = b.dataset.who;
  render();
});

async function openSettings() {
  $("#me-name").textContent = state.name;
  $("#me-role").textContent = ROLE_LABEL[state.role] || "no side picked";
  document.querySelectorAll(".tabbar .tab").forEach((t) => t.classList.remove("active"));
  show("settings");
  await updatePushStatus();
}
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-back").addEventListener("click", () => {
  state.tab = CATEGORY_UI[state.tab] || state.tab === "score" || state.tab === "support" ? state.tab : "wish";
  document.querySelector(`.tabbar .tab[data-tab="${state.tab}"]`)?.click();
});

$("#push-btn").addEventListener("click", togglePush);
$("#test-btn").addEventListener("click", async () => {
  try {
    const r = await api("/test-notification", { method: "POST", body: { role: state.role } });
    toast(`Test sent to ${r.devices} device${r.devices === 1 ? "" : "s"}${r.telegram ? " + Telegram" : ""}`);
  } catch (err) {
    toast(err.message);
  }
});
$("#change-name-btn").addEventListener("click", () => {
  $("#name-input").value = state.name;
  const r = $("#name-form").querySelector(`input[name=role][value="${state.role}"]`);
  if (r) r.checked = true;
  show("name");
});
$("#logout-btn").addEventListener("click", () => {
  localStorage.removeItem("remindly.pin");
  state.pin = "";
  boot();
});

// Keep the list fresh while the app is open.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (!views.main.hidden) refresh();
  else if (!views.score.hidden) renderScore().catch(() => {});
  else if (!views.support.hidden) api("/support").then((m) => { state.moments = m; renderMoments(); }).catch(() => {});
}, 30_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !views.main.hidden) refresh(); });

// ---------- boot ----------
async function boot() {
  if (!state.config) {
    state.config = await fetch("/api/config").then((r) => r.json());
  }
  if (state.config.pinRequired && !state.pin) return show("pin");
  if (!state.name || !state.role) return show("name");
  if (location.hash === "#score") state.tab = "score";
  if (location.hash === "#support") state.tab = "support";
  state.tab = state.tab === "settings" ? "wish" : state.tab;
  setActiveTab();
  if (state.tab === "score" || state.tab === "support") {
    const tab = state.tab;
    show(tab);
    history.replaceState(null, "", "/");
    await (tab === "score" ? renderScore() : renderSupport());
    return;
  }
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

mountIcons();
getSwRegistration().catch((err) => console.warn("SW registration failed", err));
boot().catch((err) => {
  console.error(err);
  toast("Couldn't load. Is the server running?");
});
