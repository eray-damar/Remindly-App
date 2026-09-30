import express from "express";
import webpush from "web-push";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
let subscriptions = loadJson("subscriptions.json", []);
const saveItems = () => saveJson("items.json", items);
const saveSubscriptions = () => saveJson("subscriptions.json", subscriptions);

// ---------- notifications ----------
async function sendPush(payload) {
  if (!PUSH_ENABLED || subscriptions.length === 0) return;
  const body = JSON.stringify(payload);
  const dead = new Set();
  await Promise.all(
    subscriptions.map(async (sub) => {
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

function notify({ title, body, url = "/", tag }) {
  // Fire and forget: the API response should not wait on push servers.
  sendPush({ title, body, url, tag }).catch(() => {});
  sendTelegram(`${title}\n${body}`).catch(() => {});
}

function describe(item) {
  const u = URGENCY[item.urgency];
  const parts = [`${u.emoji} ${u.label}`];
  if (item.note) parts.push(item.note);
  return parts.join(" · ");
}

// ---------- daily reminder ----------
let lastReminderDay = null;
function maybeSendDailyReminder() {
  if (REMINDER_HOUR === null || Number.isNaN(REMINDER_HOUR)) return;
  const now = new Date();
  const today = now.toDateString();
  if (now.getHours() !== REMINDER_HOUR || lastReminderDay === today) return;
  lastReminderDay = today;
  const open = items.filter((i) => !i.done && URGENCY[i.urgency].rank >= URGENCY.high.rank);
  if (open.length === 0) return;
  const lines = open
    .sort((a, b) => URGENCY[b.urgency].rank - URGENCY[a.urgency].rank)
    .map((i) => `${URGENCY[i.urgency].emoji} ${i.title}`);
  notify({
    title: `${open.length} wish${open.length === 1 ? "" : "es"} still waiting`,
    body: lines.slice(0, 5).join("\n") + (lines.length > 5 ? `\n…and ${lines.length - 5} more` : ""),
    tag: "daily-reminder",
  });
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
  res.json(items);
});

app.post("/api/items", (req, res) => {
  const title = String(req.body?.title ?? "").trim().slice(0, 140);
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  const link = String(req.body?.link ?? "").trim().slice(0, 500);
  const urgency = String(req.body?.urgency ?? "medium");
  const addedBy = String(req.body?.addedBy ?? "").trim().slice(0, 40);
  if (!title) return res.status(400).json({ error: "title is required" });
  if (!URGENCY[urgency]) return res.status(400).json({ error: "unknown urgency" });
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: "link must start with http(s)://" });

  const item = {
    id: randomUUID(),
    title,
    note,
    link,
    urgency,
    addedBy,
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: null,
  };
  items.unshift(item);
  saveItems();

  const who = addedBy ? `${addedBy} wants` : "New wish:";
  notify({
    title: `${URGENCY[urgency].emoji} ${who} ${title}`,
    body: describe(item),
    url: `/#item-${item.id}`,
    tag: `item-${item.id}`,
  });
  res.status(201).json(item);
});

app.patch("/api/items/:id", (req, res) => {
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  const { done, urgency, title, note, link } = req.body ?? {};
  if (typeof done === "boolean") {
    item.done = done;
    item.doneAt = done ? new Date().toISOString() : null;
  }
  if (urgency !== undefined) {
    if (!URGENCY[urgency]) return res.status(400).json({ error: "unknown urgency" });
    const bumped = URGENCY[urgency].rank > URGENCY[item.urgency].rank;
    item.urgency = urgency;
    if (bumped && !item.done) {
      notify({
        title: `${URGENCY[urgency].emoji} Bumped: ${item.title}`,
        body: describe(item),
        url: `/#item-${item.id}`,
        tag: `item-${item.id}`,
      });
    }
  }
  if (typeof title === "string" && title.trim()) item.title = title.trim().slice(0, 140);
  if (typeof note === "string") item.note = note.trim().slice(0, 500);
  if (typeof link === "string") item.link = link.trim().slice(0, 500);
  saveItems();
  res.json(item);
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
  if (!subscriptions.some((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null });
    saveSubscriptions();
  }
  res.status(201).json({ ok: true, count: subscriptions.length });
});

app.delete("/api/subscribe", (req, res) => {
  const endpoint = req.body?.endpoint;
  subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
  saveSubscriptions();
  res.status(204).end();
});

app.post("/api/test-notification", (_req, res) => {
  notify({ title: "💌 Remindly is working", body: "You'll get a ping like this for every new wish.", tag: "test" });
  res.json({ ok: true, push: PUSH_ENABLED, telegram: TELEGRAM_ENABLED, devices: subscriptions.length });
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
