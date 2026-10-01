// Gamification rules. Pure functions over the items array, so scores are always
// derived from the data (reopening an item simply takes its points back).

export const POINTS = { low: 10, medium: 20, high: 35, urgent: 50 };
export const TRAVEL_MULTIPLIER = 2;
export const QUICK_DAYS = 3; // grant within this many days of adding -> bonus
export const QUICK_BONUS = 10;

export const LEVELS = [
  { level: 1, min: 0, title: "Newbie" },
  { level: 2, min: 100, title: "Sweetheart" },
  { level: 3, min: 250, title: "Thoughtful" },
  { level: 4, min: 500, title: "Attentive" },
  { level: 5, min: 900, title: "Mind reader" },
  { level: 6, min: 1500, title: "Wish genie" },
  { level: 7, min: 2500, title: "Legend" },
];

export const BADGES = [
  { id: "first", name: "First spark", icon: "sparkles", desc: "Grant your first wish" },
  { id: "five", name: "Giver", icon: "heart-handshake", desc: "Grant 5 wishes" },
  { id: "ten", name: "Wish genie", icon: "wand-sparkles", desc: "Grant 10 wishes" },
  { id: "firefighter", name: "Firefighter", icon: "flame", desc: "Grant a NEED IT" },
  { id: "lightning", name: "Lightning", icon: "zap", desc: "Grant within 24 hours" },
  { id: "globetrotter", name: "Globetrotter", icon: "plane", desc: "Tick off a travel idea" },
  { id: "nest", name: "Nest builder", icon: "armchair", desc: "Finish a home idea" },
  { id: "hattrick", name: "Hat-trick", icon: "medal", desc: "Grant 3 wishes in one day" },
  { id: "streak3", name: "On a roll", icon: "calendar-check", desc: "3 weeks in a row" },
];

const ROLES = ["her", "him"];
export const otherRole = (role) => (role === "her" ? "him" : role === "him" ? "her" : null);

/** A grant counts when someone ticks off an item the *other* side added. */
export function isGrant(item) {
  return Boolean(item.done && item.doneBy && item.role && item.doneBy !== item.role && ROLES.includes(item.doneBy));
}

/** Points the granter earns for this item (0 if it isn't a grant). */
export function pointsFor(item) {
  if (!isGrant(item)) return 0;
  let pts = POINTS[item.urgency] ?? POINTS.medium;
  if (item.category === "travel") pts *= TRAVEL_MULTIPLIER;
  if (item.doneAt && item.createdAt) {
    const days = (new Date(item.doneAt) - new Date(item.createdAt)) / 86400000;
    if (days >= 0 && days <= QUICK_DAYS) pts += QUICK_BONUS;
  }
  return pts;
}

export function levelFor(points) {
  let current = LEVELS[0];
  for (const l of LEVELS) if (points >= l.min) current = l;
  const next = LEVELS.find((l) => l.min > points) || null;
  const span = next ? next.min - current.min : 1;
  return {
    level: current.level,
    title: current.title,
    points,
    nextAt: next ? next.min : null,
    nextTitle: next ? next.title : null,
    progress: next ? Math.min(1, (points - current.min) / span) : 1,
  };
}

// ISO-ish week key (weeks start on Monday) in UTC, e.g. "2026-W40".
function weekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function addWeeks(date, n) {
  return new Date(date.getTime() + n * 7 * 86400000);
}

/** Consecutive weeks (ending this week or last week) with at least one grant. */
export function streakWeeks(grantDates, now = new Date()) {
  const weeks = new Set(grantDates.map((d) => weekKey(new Date(d))));
  let cursor = now;
  if (!weeks.has(weekKey(cursor))) cursor = addWeeks(cursor, -1); // this week not yet, allow last week
  let streak = 0;
  while (weeks.has(weekKey(cursor))) {
    streak++;
    cursor = addWeeks(cursor, -1);
  }
  return streak;
}

function dayKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Scores for both sides, derived from items. */
export function computeScores(items, now = new Date()) {
  const monthKey = now.toISOString().slice(0, 7);
  const result = {};
  for (const role of ROLES) {
    const grants = items
      .filter((i) => isGrant(i) && i.doneBy === role)
      .map((i) => ({ ...i, points: pointsFor(i) }))
      .sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));
    const points = grants.reduce((s, g) => s + g.points, 0);
    const month = grants.filter((g) => g.doneAt.slice(0, 7) === monthKey).reduce((s, g) => s + g.points, 0);
    const perDay = {};
    for (const g of grants) perDay[dayKey(g.doneAt)] = (perDay[dayKey(g.doneAt)] || 0) + 1;
    const streak = streakWeeks(grants.map((g) => g.doneAt), now);
    const have = {
      first: grants.length >= 1,
      five: grants.length >= 5,
      ten: grants.length >= 10,
      firefighter: grants.some((g) => g.urgency === "urgent"),
      lightning: grants.some((g) => new Date(g.doneAt) - new Date(g.createdAt) <= 86400000),
      globetrotter: grants.some((g) => g.category === "travel"),
      nest: grants.some((g) => g.category === "home"),
      hattrick: Object.values(perDay).some((n) => n >= 3),
      streak3: streak >= 3,
    };
    // Last name this side used when adding something, for display.
    const named = items.filter((i) => i.role === role && i.addedBy).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    result[role] = {
      role,
      name: named[0]?.addedBy || "",
      points,
      month,
      grants: grants.length,
      streak,
      ...levelFor(points),
      badges: BADGES.map((b) => ({ ...b, earned: Boolean(have[b.id]) })),
      recent: grants.slice(0, 8).map((g) => ({ id: g.id, title: g.title, category: g.category, urgency: g.urgency, points: g.points, doneAt: g.doneAt, addedBy: g.addedBy })),
    };
  }
  return result;
}
