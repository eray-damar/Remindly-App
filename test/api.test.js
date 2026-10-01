// End-to-end API tests: spawn the real server on a random port with a temp data dir.
// Also verifies push delivery against a local mock push service, and that
// expired subscriptions (HTTP 410) are pruned.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const PIN = "2468";
let proc, base, dataDir, pushServer, pushHits = 0, pushMode = "ok", pushUrls = [];

const H = { "content-type": "application/json", "x-pin": PIN };
const j = async (path, init = {}) => {
  const res = await fetch(base + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "remindly-"));
  // web-push always talks HTTPS to the push service, so the mock needs a (self-signed) certificate.
  const keyFile = join(dataDir, "key.pem");
  const certFile = join(dataDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  pushServer = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    pushHits++;
    pushUrls.push(req.url);
    req.resume().on("end", () => {
      res.statusCode = pushMode === "ok" ? 201 : 410;
      res.end();
    });
  });
  await new Promise((r) => pushServer.listen(0, "127.0.0.1", r));

  const keys = webpush.generateVAPIDKeys();
  const port = 40000 + Math.floor(Math.random() * 10000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      APP_PIN: PIN,
      DATA_DIR: dataDir,
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      REMINDER_HOUR: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      NODE_EXTRA_CA_CERTS: join(dataDir, "cert.pem"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const r = await fetch(base + "/api/config");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});

after(async () => {
  proc?.kill();
  pushServer?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("config is public, everything else needs the pin", async () => {
  const cfg = await (await fetch(base + "/api/config")).json();
  assert.equal(cfg.pinRequired, true);
  assert.equal(cfg.pushEnabled, true);
  assert.ok(cfg.vapidPublicKey);
  assert.equal((await fetch(base + "/api/items")).status, 401);
  assert.equal((await fetch(base + "/api/items", { headers: { "x-pin": "nope" } })).status, 401);
});

test("create, validate, update, sort by urgency, delete", async () => {
  assert.equal((await j("/api/items", { method: "POST", body: JSON.stringify({ title: "  " }) })).status, 400);
  assert.equal((await j("/api/items", { method: "POST", body: JSON.stringify({ title: "x", urgency: "asap" }) })).status, 400);
  assert.equal((await j("/api/items", { method: "POST", body: JSON.stringify({ title: "x", link: "javascript:alert(1)" }) })).status, 400);
  assert.equal((await j("/api/items", { method: "POST", body: JSON.stringify({ title: "x", category: "cars" }) })).status, 400);
  assert.equal((await j("/api/items", { method: "POST", body: JSON.stringify({ title: "x", role: "them" }) })).status, 400);

  const a = await j("/api/items", { method: "POST", body: JSON.stringify({ title: "Socks", urgency: "low", addedBy: "Ana", role: "her" }) });
  assert.equal(a.status, 201);
  assert.equal(a.body.done, false);
  assert.equal(a.body.category, "wish"); // default
  assert.equal(a.body.role, "her");
  const t = await j("/api/items", { method: "POST", body: JSON.stringify({ title: "Lisbon", category: "travel", role: "him" }) });
  assert.equal(t.body.category, "travel");
  assert.equal((await fetch(`${base}/api/items/${t.body.id}`, { method: "DELETE", headers: H })).status, 204);
  const b = await j("/api/items", { method: "POST", body: JSON.stringify({ title: "Tickets", urgency: "urgent", note: "2 seats", link: "https://x.y/z" }) });
  assert.equal(b.status, 201);

  const list = (await j("/api/items")).body;
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "Tickets"); // newest first from the server; client sorts by urgency

  const done = await j(`/api/items/${a.body.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
  assert.equal(done.body.done, true);
  assert.ok(done.body.doneAt);

  const bumped = await j(`/api/items/${a.body.id}`, { method: "PATCH", body: JSON.stringify({ done: false, urgency: "high" }) });
  assert.equal(bumped.body.urgency, "high");
  assert.equal(bumped.body.doneAt, null);
  assert.equal((await j(`/api/items/${a.body.id}`, { method: "PATCH", body: JSON.stringify({ urgency: "nah" }) })).status, 400);

  // Persisted to disk.
  const onDisk = JSON.parse(readFileSync(join(dataDir, "items.json"), "utf8"));
  assert.equal(onDisk.length, 2);

  assert.equal((await fetch(`${base}/api/items/${a.body.id}`, { method: "DELETE", headers: H })).status, 204);
  assert.equal((await fetch(`${base}/api/items/${a.body.id}`, { method: "DELETE", headers: H })).status, 404);
  assert.equal((await j("/api/items")).body.length, 1);
});

function fakeSubscription(path, role) {
  const { address, port } = pushServer.address();
  // A real P-256 key pair, like a browser would generate for the subscription.
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return {
    endpoint: `https://${address}:${port}${path}`,
    keys: { p256dh: raw.toString("base64url"), auth: randomBytes(16).toString("base64url") },
    role,
  };
}

test("push: her phone hears about his wishes and vice versa; expired subscription is pruned", async () => {
  assert.equal((await j("/api/subscribe", { method: "POST", body: JSON.stringify({ endpoint: "x" }) })).status, 400);
  const herPhone = fakeSubscription("/push/her-phone", "her");
  const hisPhone = fakeSubscription("/push/his-phone", "him");
  assert.equal((await j("/api/subscribe", { method: "POST", body: JSON.stringify(herPhone) })).body.count, 1);
  assert.equal((await j("/api/subscribe", { method: "POST", body: JSON.stringify(hisPhone) })).body.count, 2);
  // Subscribing the same device twice does not duplicate it.
  assert.equal((await j("/api/subscribe", { method: "POST", body: JSON.stringify(hisPhone) })).body.count, 2);

  pushHits = 0; pushUrls = []; pushMode = "ok";
  await j("/api/items", { method: "POST", body: JSON.stringify({ title: "Flowers", urgency: "medium", role: "him", addedBy: "Eray" }) });
  await waitFor(() => pushHits === 1);
  await new Promise((r) => setTimeout(r, 150)); // give a wrong extra push a chance to show up
  assert.deepEqual(pushUrls, ["/push/her-phone"]); // only her side is told about his wish

  pushHits = 0; pushUrls = [];
  await j("/api/items", { method: "POST", body: JSON.stringify({ title: "Rome", category: "travel", urgency: "high", role: "her" }) });
  await waitFor(() => pushHits === 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(pushUrls, ["/push/his-phone"]);

  // An item with no side goes to everyone.
  pushHits = 0; pushUrls = [];
  await j("/api/items", { method: "POST", body: JSON.stringify({ title: "Anything", urgency: "low" }) });
  await waitFor(() => pushHits === 2);
  assert.deepEqual(pushUrls.sort(), ["/push/her-phone", "/push/his-phone"]);

  // The test ping goes to the caller's own side.
  pushHits = 0; pushUrls = [];
  const t = await j("/api/test-notification", { method: "POST", body: JSON.stringify({ role: "her" }) });
  assert.equal(t.body.devices, 1);
  await waitFor(() => pushHits === 1);
  assert.deepEqual(pushUrls, ["/push/her-phone"]);

  // Expired subscriptions are pruned.
  pushMode = "gone"; pushHits = 0;
  await j("/api/test-notification", { method: "POST", body: "{}" });
  await waitFor(() => pushHits === 2);
  await waitFor(() => JSON.parse(readFileSync(join(dataDir, "subscriptions.json"), "utf8")).length === 0);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "subscriptions.json"), "utf8")).length, 0);
});

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}
