import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsFor, isGrant, levelFor, streakWeeks, computeScores, isSupport, SUPPORT_POINTS } from "../game.js";

const base = { id: "1", title: "x", category: "wish", urgency: "high", role: "her", addedBy: "Geane", done: true, doneBy: "him", createdAt: "2026-09-01T10:00:00Z", doneAt: "2026-09-10T10:00:00Z" };

test("only ticking the other side's item is a grant", () => {
  assert.equal(isGrant(base), true);
  assert.equal(isGrant({ ...base, doneBy: "her" }), false); // own item
  assert.equal(isGrant({ ...base, role: "" }), false); // nobody's item
  assert.equal(isGrant({ ...base, done: false }), false);
  assert.equal(pointsFor({ ...base, doneBy: "her" }), 0);
});

test("points scale with urgency, double for travel, bonus when quick", () => {
  assert.equal(pointsFor({ ...base, urgency: "low" }), 10);
  assert.equal(pointsFor({ ...base, urgency: "medium" }), 20);
  assert.equal(pointsFor({ ...base, urgency: "high" }), 35);
  assert.equal(pointsFor({ ...base, urgency: "urgent" }), 50);
  assert.equal(pointsFor({ ...base, urgency: "urgent", category: "travel" }), 100);
  assert.equal(pointsFor({ ...base, urgency: "low", doneAt: "2026-09-02T10:00:00Z" }), 20); // +10 quick bonus
});

test("levels", () => {
  assert.deepEqual([levelFor(0).title, levelFor(99).title, levelFor(100).title, levelFor(2500).title], ["Newbie", "Newbie", "Sweetheart", "Legend"]);
  assert.equal(levelFor(50).progress, 0.5);
  assert.equal(levelFor(3000).nextAt, null);
});

test("weekly streak counts consecutive weeks, tolerating the current week being empty", () => {
  const now = new Date("2026-09-30T12:00:00Z"); // Wednesday
  assert.equal(streakWeeks([], now), 0);
  assert.equal(streakWeeks(["2026-09-29T00:00:00Z"], now), 1);
  assert.equal(streakWeeks(["2026-09-22T00:00:00Z", "2026-09-15T00:00:00Z"], now), 2); // last two weeks, none this week
  assert.equal(streakWeeks(["2026-09-29T00:00:00Z", "2026-09-22T00:00:00Z", "2026-09-08T00:00:00Z"], now), 2); // gap breaks it
});

test("computeScores aggregates per side with badges and recent feed", () => {
  const items = [
    base,
    { ...base, id: "2", urgency: "urgent", doneAt: "2026-09-10T11:00:00Z" },
    { ...base, id: "3", category: "travel", urgency: "medium", doneAt: "2026-09-10T12:00:00Z" },
    { ...base, id: "4", role: "him", addedBy: "Eray", doneBy: "her", urgency: "low", createdAt: "2026-09-30T00:00:00Z", doneAt: "2026-09-30T05:00:00Z" },
    { ...base, id: "5", done: false, doneBy: null, doneAt: null },
  ];
  const s = computeScores(items, [], new Date("2026-09-30T12:00:00Z"));
  assert.equal(s.him.name, "Eray");
  assert.equal(s.her.name, "Geane");
  assert.equal(s.him.points, 35 + 50 + 40);
  assert.equal(s.him.grants, 3);
  assert.equal(s.him.title, "Sweetheart");
  assert.equal(s.him.month, 125);
  const earned = s.him.badges.filter((b) => b.earned).map((b) => b.id).sort();
  assert.deepEqual(earned, ["firefighter", "first", "globetrotter", "hattrick"]);
  assert.equal(s.her.points, 20); // low + quick bonus, lightning badge
  assert.ok(s.her.badges.find((b) => b.id === "lightning").earned);
  assert.equal(s.her.recent[0].title, "x");
});

test("replying to the other side's check-in earns support points and the harbour badge", () => {
  const checkin = (i, by, replyBy) => ({ id: `m${i}`, type: "checkin", role: by, name: by === "her" ? "Geane" : "Eray", mood: "low", needs: ["A hug"], text: "", createdAt: "2026-09-20T10:00:00Z", response: replyBy ? { role: replyBy, name: "x", text: "I'm here", at: `2026-09-2${i}T11:00:00Z` } : null });
  assert.equal(isSupport(checkin(1, "her", "him")), true);
  assert.equal(isSupport(checkin(1, "her", "her")), false);
  assert.equal(isSupport(checkin(1, "her", null)), false);
  assert.equal(isSupport({ ...checkin(1, "her", "him"), type: "note" }), false); // replies to notes are free

  const moments = [1, 2, 3, 4, 5].map((i) => checkin(i, "her", "him"));
  const s = computeScores([], moments, new Date("2026-09-30T12:00:00Z"));
  assert.equal(s.him.points, 5 * SUPPORT_POINTS);
  assert.equal(s.him.supports, 5);
  assert.equal(s.him.grants, 0);
  assert.ok(s.him.badges.find((b) => b.id === "harbour").earned);
  assert.equal(s.him.recent[0].category, "support");
  assert.equal(s.her.points, 0);
});
