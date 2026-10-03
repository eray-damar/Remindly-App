import express from "express";
import webpush from "web-push";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScores, pointsFor, levelFor, POINTS, TRAVEL_MULTIPLIER, QUICK_DAYS, QUICK_BONUS, SUPPORT_POINTS, LEVELS, BADGES } from "./game.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const PORT = Number(process.env.PORT) || 3000;
const APP_PIN = (process.env.APP_PIN || "").trim();
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const REMINDER_HOUR =
  process.env.REMINDER_HOUR === undefined || process.env.REMINDER_HOUR === ""
    ? null
    : Number(process.env.REMINDER_HOUR);

const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("[remindly] VAPID keys missing: browser push disabled. Run `npm run vapid`.");
}
const TELEGRAM_ENABLED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

export const CATEGORIES = {
  wish: { label: "Wishes", emoji: "🎁", verb: "wants", doneLabel: "Got it" },
  travel: { label: "Travel ideas", emoji: "✈️", verb: "wants to go", doneLabel: "Been there" },
  home: { label: "Home ideas", emoji: "🛋️", verb: "wants for home", doneLabel: "Got it" },
};

export const MOODS = {
  great: { label: "Great", emoji: "☀️" },
  good: { label: "Good", emoji: "🙂" },
  meh: { label: "Meh", emoji: "😐" },
  low: { label: "Low", emoji: "🌧️" },
  overwhelmed: { label: "Overwhelmed", emoji: "⛈️" },
};
export const NEEDS = ["A hug", "Listen to me", "Some space", "Distract me", "Dinner together", "Just a text", "Tell me it's okay"];
export const NOTE_PROMPTS = ["Proud of you", "Thinking of you", "You've got this", "Miss you", "Thank you for today"];
export const REPLIES = ["I'm here 💛", "Hug incoming", "On my way", "Call you in 5", "Take all the time you need"];

export const ROLES = ["her", "him"];
const otherRole = (role) => (role === "her" ? "him" : role === "him" ? "her" : null);

export const URGENCY = {
  low: { rank: 0, label: "Whenever", emoji: "🙂" },
  medium: { rank: 1, label: "Soon-ish", emoji: "🙏" },
  high: { rank: 2, label: "Really want", emoji: "🔥" },
  urgent: { rank: 3, label: "NEED IT", emoji: "🚨" },
};

// ---------- tiny JSON store ----------
mkdirSync(DATA_DIR, { recursive: true });

function loadJson(name, fallback) {
  const file = join(DATA_DIR, name);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[remindly] could not read ${file}, starting fresh:`, err.message);
    return fallback;
  }
}

function saveJson(name, value) {
  const file = join(DATA_DIR, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file); // atomic on the same filesystem
}

let items = loadJson("items.json", []);
let moments = loadJson("moments.json", []);
let subscriptions = loadJson("subscriptions.json", []);
const saveItems = () => saveJson("items.json", items);
const saveMoments = () => saveJson("moments.json", moments);
const saveSubscriptions = () => saveJson("subscriptions.json", subscriptions);

// ---------- notifications ----------
async function sendPush(payload, toRole = null) {
  if (!PUSH_ENABLED || subscriptions.length === 0) return;
  const body = JSON.stringify(payload);
  const dead = new Set();
  // A device subscribed as "her" only hears about what "him" adds, and vice versa.
  // Devices that never picked a side get everything.
  const targets = subscriptions.filter((s) => !toRole || !s.role || s.role === toRole);
  await Promise.all(
    targets.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, { TTL: 60 * 60 * 24 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          dead.add(sub.endpoint); // subscription expired or was revoked
        } else {
          console.error("[remindly] push failed:", err.statusCode || err.message);
        }
      }
    })
  );
  if (dead.size) {
    subscriptions = subscriptions.filter((s) => !dead.has(s.endpoint));
    saveSubscriptions();
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_ENABLED) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.error("[remindly] telegram failed:", res.status, await res.text());
  } catch (err) {
    console.error("[remindly] telegram failed:", err.message);
  }
}

function notify({ title, body, url = "/", tag, toRole = null }) {
  // Fire and forget: the API response should not wait on push servers.
  sendPush({ title, body, url, tag }, toRole).catch(() => {});
  sendTelegram(`${title}\n${body}`).catch(() => {});
}

function describe(item) {
  const u = URGENCY[item.urgency];
  const parts = [`${u.emoji} ${u.label}`];
  if (item.note) parts.push(item.note);
  return parts.join(" · ");
}

function itemTitle(item, prefix = "") {
  const c = CATEGORIES[item.category] || CATEGORIES.wish;
  const who = item.addedBy || (item.role === "her" ? "She" : item.role === "him" ? "He" : "Someone");
  return `${c.emoji} ${prefix}${who} ${c.verb}: ${item.title}`;
}

// ---------- daily reminder ----------
let lastReminderDay = null;
function maybeSendDailyReminder() {
  if (REMINDER_HOUR === null || Number.isNaN(REMINDER_HOUR)) return;
  const now = new Date();
  const today = now.toDateString();
  if (now.getHours() !== REMINDER_HOUR || lastReminderDay === today) return;
  lastReminderDay = today;
  const burning = items.filter((i) => !i.done && URGENCY[i.urgency].rank >= URGENCY.high.rank);
  if (burning.length === 0) return;
  // Each side is reminded about what the *other* side is still waiting for.
  const sides = [...new Set(subscriptions.map((s) => s.role || null))];
  if (sides.length === 0) sides.push(null);
  for (const side of sides) {
    const open = burning.filter((i) => !side || !i.role || i.role === otherRole(side));
    if (open.length === 0) continue;
    const lines = open
      .sort((a, b) => URGENCY[b.urgency].rank - URGENCY[a.urgency].rank)
      .map((i) => `${(CATEGORIES[i.category] || CATEGORIES.wish).emoji} ${i.title}`);
    notify({
      title: `${open.length} wish${open.length === 1 ? "" : "es"} still waiting`,
      body: lines.slice(0, 5).join("\n") + (lines.length > 5 ? `\n…and ${lines.length - 5} more` : ""),
      tag: "daily-reminder",
      toRole: side,
    });
  }
}
setInterval(maybeSendDailyReminder, 60 * 1000).unref();

// ---------- http ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(join(__dirname, "public"), { extensions: ["html"] }));

app.get("/api/config", (_req, res) => {
  res.json({
    pinRequired: Boolean(APP_PIN),
    pushEnabled: PUSH_ENABLED,
    vapidPublicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null,
    telegramEnabled: TELEGRAM_ENABLED,
    urgency: URGENCY,
    categories: CATEGORIES,
    roles: ROLES,
    game: { points: POINTS, travelMultiplier: TRAVEL_MULTIPLIER, quickDays: QUICK_DAYS, quickBonus: QUICK_BONUS, supportPoints: SUPPORT_POINTS, levels: LEVELS, badges: BADGES },
    support: { moods: MOODS, needs: NEEDS, notePrompts: NOTE_PROMPTS, replies: REPLIES },
  });
});

// Everything below needs the shared PIN (when one is configured).
app.use("/api", (req, res, next) => {
  if (!APP_PIN) return next();
  const given = req.get("x-pin") || "";
  if (given === APP_PIN) return next();
  res.status(401).json({ error: "wrong pin" });
});

app.get("/api/items", (_req, res) => {
  res.json(items.map((i) => ({ category: "wish", role: "", doneBy: null, ...i })));
});

app.get("/api/score", (_req, res) => {
  res.json(computeScores(items, moments));
});

// ---------- emotional support ----------
app.get("/api/support", (_req, res) => {
  res.json(moments.slice(0, 50));
});

function newMoment(req, type) {
  const role = String(req.body?.role ?? "");
  if (!ROLES.includes(role)) return { error: "pick a side first" };
  return {
    id: randomUUID(),
    type,
    role,
    name: String(req.body?.name ?? "").trim().slice(0, 40) || (role === "her" ? "She" : "He"),
    createdAt: new Date().toISOString(),
    response: null,
  };
}

app.post("/api/support/checkin", (req, res) => {
  const m = newMoment(req, "checkin");
  if (m.error) return res.status(400).json(m);
  const mood = String(req.body?.mood ?? "");
  if (!MOODS[mood]) return res.status(400).json({ error: "unknown mood" });
  const needs = Array.isArray(req.body?.needs) ? req.body.needs.map((n) => String(n).trim().slice(0, 40)).filter(Boolean).slice(0, 5) : [];
  const text = String(req.body?.text ?? "").trim().slice(0, 500);
  Object.assign(m, { mood, needs, text });
  moments.unshift(m);
  moments = moments.slice(0, 500);
  saveMoments();
  const body = [needs.length ? `Would help: ${needs.join(", ")}` : "", text].filter(Boolean).join(" · ") || "Tap to reply.";
  notify({ title: `${MOODS[mood].emoji} ${m.name} is feeling ${MOODS[mood].label.toLowerCase()}`, body, url: "/#support", tag: `moment-${m.id}`, toRole: otherRole(m.role) });
  res.status(201).json(m);
});

app.post("/api/support/note", (req, res) => {
  const m = newMoment(req, "note");
  if (m.error) return res.status(400).json(m);
  const text = String(req.body?.text ?? "").trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: "write something" });
  m.text = text;
  moments.unshift(m);
  moments = moments.slice(0, 500);
  saveMoments();
  notify({ title: `💌 Note from ${m.name}`, body: text, url: "/#support", tag: `moment-${m.id}`, toRole: otherRole(m.role) });
  res.status(201).json(m);
});

app.post("/api/support/:id/reply", (req, res) => {
  const m = moments.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "not found" });
  const role = String(req.body?.role ?? "");
  if (!ROLES.includes(role)) return res.status(400).json({ error: "pick a side first" });
  if (role === m.role) return res.status(400).json({ error: "you can't reply to yourself" });
  if (m.response) return res.status(409).json({ error: "already replied" });
  const text = String(req.body?.text ?? "").trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: "write something" });
  const name = String(req.body?.name ?? "").trim().slice(0, 40) || (role === "her" ? "She" : "He");
  const before = levelFor(computeScores(items, moments)[role].points);
  m.response = { role, name, text, at: new Date().toISOString() };
  saveMoments();
  const earned = m.type === "checkin" ? SUPPORT_POINTS : 0;
  const after = levelFor(computeScores(items, moments)[role].points);
  const levelUp = after.level > before.level ? { level: after.level, title: after.title } : null;
  notify({ title: `💛 ${name}: ${text}`, body: m.type === "checkin" ? "Replying to your check-in." : "Replying to your note.", url: "/#support", tag: `moment-${m.id}`, toRole: m.role });
  if (levelUp) {
    notify({ title: `🏆 ${name} reached level ${levelUp.level}: ${levelUp.title}`, body: `${after.points} points and counting.`, url: "/#score", tag: "level-up", toRole: role });
  }
  res.json({ ...m, earned, levelUp });
});

app.post("/api/items", (req, res) => {
  const title = String(req.body?.title ?? "").trim().slice(0, 140);
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  const link = String(req.body?.link ?? "").trim().slice(0, 500);
  const urgency = String(req.body?.urgency ?? "medium");
  const category = String(req.body?.category ?? "wish");
  const role = String(req.body?.role ?? "");
  const addedBy = String(req.body?.addedBy ?? "").trim().slice(0, 40);
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!URGENCY[urgency]) return res.status(400).json({ error: "unknown urgency" });
  if (!CATEGORIES[category]) return res.status(400).json({ error: "unknown category" });
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: "unknown role" });
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: "link must start with http(s)://" });

  const item = {
    id: randomUUID(),
    title,
    note,
    link,
    urgency,
    category,
    role,
    addedBy,
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: null,
    doneBy: null,
  };
  items.unshift(item);
  saveItems();

  notify({
    title: itemTitle(item),
    body: describe(item),
    url: `/#item-${item.id}`,
    tag: `item-${item.id}`,
    toRole: otherRole(role),
  });
  res.status(201).json(item);
});

app.patch("/api/items/:id", (req, res) => {
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  const { done, urgency, title, note, link } = req.body ?? {};
  const actor = ROLES.includes(req.body?.role) ? req.body.role : null;
  let earned = 0;
  let levelUp = null;
  if (typeof done === "boolean" && done !== item.done) {
    const before = actor ? levelFor(computeScores(items, moments)[actor].points) : null;
    item.done = done;
    item.doneAt = done ? new Date().toISOString() : null;
    item.doneBy = done ? actor : null;
    if (done) {
      earned = pointsFor(item);
      const actorName = req.body?.actorName ? String(req.body.actorName).trim().slice(0, 40) : (actor === "her" ? "She" : actor === "him" ? "He" : "Someone");
      const c = CATEGORIES[item.category] || CATEGORIES.wish;
      if (earned > 0) {
        const after = levelFor(computeScores(items, moments)[actor].points);
        if (before && after.level > before.level) levelUp = { level: after.level, title: after.title };
        // Tell the person whose wish it was.
        notify({
          title: `🎉 ${actorName} granted: ${item.title}`,
          body: `${c.emoji} ${c.doneLabel} · +${earned} pts for ${actorName}${levelUp ? ` · now level ${levelUp.level} ${levelUp.title}!` : ""}`,
          url: "/#score",
          tag: `item-${item.id}`,
          toRole: item.role,
        });
        if (levelUp) {
          notify({ title: `🏆 ${actorName} reached level ${levelUp.level}: ${levelUp.title}`, body: `${after.points} points and counting.`, url: "/#score", tag: "level-up", toRole: actor });
        }
      }
    }
  }
  if (urgency !== undefined) {
    if (!URGENCY[urgency]) return res.status(400).json({ error: "unknown urgency" });
    const bumped = URGENCY[urgency].rank > URGENCY[item.urgency].rank;
    item.urgency = urgency;
    if (bumped && !item.done) {
      notify({
        title: itemTitle(item, `${URGENCY[urgency].emoji} Bumped · `),
        body: describe(item),
        url: `/#item-${item.id}`,
        tag: `item-${item.id}`,
        toRole: otherRole(item.role),
      });
    }
  }
  if (typeof title === "string" && title.trim()) item.title = title.trim().slice(0, 140);
  if (typeof note === "string") item.note = note.trim().slice(0, 500);
  if (typeof link === "string") item.link = link.trim().slice(0, 500);
  saveItems();
  res.json({ ...item, earned, levelUp });
});

app.delete("/api/items/:id", (req, res) => {
  const before = items.length;
  items = items.filter((i) => i.id !== req.params.id);
  if (items.length === before) return res.status(404).json({ error: "not found" });
  saveItems();
  res.status(204).end();
});

app.post("/api/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: "invalid subscription" });
  }
  const role = ROLES.includes(sub.role) ? sub.role : "";
  const existing = subscriptions.find((s) => s.endpoint === sub.endpoint);
  if (existing) {
    existing.role = role; // re-subscribing updates which side this device is on
  } else {
    subscriptions.push({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null, role });
  }
  saveSubscriptions();
  res.status(201).json({ ok: true, count: subscriptions.length });
});

app.delete("/api/subscribe", (req, res) => {
  const endpoint = req.body?.endpoint;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  saveSubscriptions();
  res.status(204).end();
});

app.post("/api/test-notification", (req, res) => {
  // The test goes to the caller's own side so they see it on the phone in their hand.
  const role = ROLES.includes(req.body?.role) ? req.body.role : null;
  notify({ title: "💌 Remindly is working", body: "You'll get a ping like this for every new wish.", tag: "test", toRole: role });
  const devices = subscriptions.filter((s) => !role || !s.role || s.role === role).length;
  res.json({ ok: true, push: PUSH_ENABLED, telegram: TELEGRAM_ENABLED, devices });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "bad json" });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

app.listen(PORT, () => {
  console.log(`[remindly] listening on http://localhost:${PORT}`);
  console.log(`[remindly] pin: ${APP_PIN ? "on" : "OFF"} · push: ${PUSH_ENABLED ? "on" : "off"} · telegram: ${TELEGRAM_ENABLED ? "on" : "off"} · reminder hour: ${REMINDER_HOUR ?? "off"}`);
});
