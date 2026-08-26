import "server-only";
import { prisma } from "@/lib/prisma";
import { PAGES } from "@/lib/auth/access";
import { etDayStartUtc } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Read layer for the OWNER-ONLY Activity tab (People page): who's using the
// platform, how often, and where. Events come from the /api/activity beacon
// (one row per navigation, session-derived identity, previews excluded).
// Counts come from SQL aggregation — never from a capped slice — so a heavy
// week can't silently zero out someone's real activity (adversarial-review
// finding). The caller gates on OWNER — this module does no auth itself.
// ---------------------------------------------------------------------------

const RETENTION_DAYS = 90;

// Detail routes that don't map to a nav PAGES entry.
const DETAIL: [RegExp, string][] = [
  [/^\/shoot\/feedback$/, "Quality feedback"],
  [/^\/shoot\/[^/]+$/, "Shoot screen"],
  [/^\/projects\/[^/]+$/, "Project page"],
  [/^\/edit\/[^/]+$/, "Editor brief"],
  [/^\/review\/[^/]+$/, "Cut review"],
  [/^\/upload\/[^/]+$/, "Upload checklist"],
  [/^\/clients\/[^/]+/, "Client page"],
  [/^\/training\/.+/, "Training lesson"],
  [/^\/resources\/.+/, "SOP"],
];
// Redirect stubs that briefly render as real pathnames.
const STUBS = ["/today", "/queue", "/history", "/texts", "/team", "/map", "/billing", "/payouts", "/my-pay"];

const cleanPath = (path: string) => (path.split("?")[0] || "/").replace(/\/+$/, "") || "/";

// Only record paths that look like OUR routes — the beacon's `path` is
// client-supplied, and an arbitrary string would let a user paint whatever
// they want into the owner's trail (and grow the table unboundedly).
export function isTrackablePath(path: string): boolean {
  const clean = cleanPath(path);
  if (clean === "/") return true;
  if (DETAIL.some(([re]) => re.test(clean))) return true;
  if (STUBS.some((s) => clean === s || clean.startsWith(s + "/"))) return true;
  return PAGES.some((p) => p.href !== "/" && (clean === p.href || clean.startsWith(p.href + "/")));
}

// Friendly label for a pathname: nav pages by their real names, detail routes
// by their section. Falls back to the raw path so nothing renders blank.
export function pageLabel(path: string): string {
  const clean = cleanPath(path);
  if (clean === "/") return "Dashboard";
  for (const [re, label] of DETAIL) if (re.test(clean)) return label;
  for (const p of PAGES) {
    if (p.href !== "/" && (clean === p.href || clean.startsWith(p.href + "/"))) return p.label;
  }
  return clean;
}

export type UserUsage = {
  userId: string;
  name: string | null;
  email: string;
  role: string;
  status: string; // ACTIVE | INVITED | DISABLED
  lastLoginAt: string | null;
  lastSeenAt: string | null; // newest event
  lastPage: string | null; // friendly label of the newest event
  eventsToday: number;
  eventsWindow: number; // whole window
  activeDays: number; // distinct ET days with any activity in the window
  topPages: { label: string; count: number }[];
};

export type UsageFeedItem = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  label: string;
  path: string;
  createdAt: string;
};

export type UsageOverview = {
  windowDays: number;
  users: UserUsage[]; // most recently seen first; never-seen last
  feed: UsageFeedItem[]; // newest first
};

export async function getUsageOverview(windowDays = 14): Promise<UsageOverview> {
  const now = Date.now();
  const since = new Date(now - windowDays * 24 * 3600_000);
  const todayStart = etDayStartUtc();

  // Cheap retention: prune on read (owner opens this tab rarely; volume tiny).
  await prisma.usageEvent
    .deleteMany({ where: { createdAt: { lt: new Date(now - RETENTION_DAYS * 24 * 3600_000) } } })
    .catch(() => null);

  const [accounts, totals, todays, byPage, activeDayRows, feedRows] = await Promise.all([
    prisma.appUser.findMany({
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true },
    }),
    // Exact per-user totals + last-seen, straight from SQL — no slice cap.
    prisma.usageEvent.groupBy({
      by: ["userId"],
      where: { createdAt: { gte: since } },
      _count: true,
      _max: { createdAt: true },
    }),
    prisma.usageEvent.groupBy({
      by: ["userId"],
      where: { createdAt: { gte: todayStart } },
      _count: true,
    }),
    prisma.usageEvent.groupBy({
      by: ["userId", "path"],
      where: { createdAt: { gte: since } },
      _count: true,
    }),
    // Distinct ET calendar days with activity, per user.
    // createdAt is stored as a naive UTC timestamp — mark it UTC first, THEN
    // convert to New York, or Postgres would read the UTC digits as NY time.
    prisma.$queryRaw<{ userId: string; days: bigint }[]>`
      SELECT "userId", COUNT(DISTINCT DATE(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York')) AS days
      FROM "UsageEvent" WHERE "createdAt" >= ${since} GROUP BY "userId"`,
    prisma.usageEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, userId: true, name: true, email: true, role: true, path: true, createdAt: true },
    }),
  ]);

  const totalOf = new Map(totals.map((t) => [t.userId, t]));
  const todayOf = new Map(todays.map((t) => [t.userId, t._count]));
  const daysOf = new Map(activeDayRows.map((r) => [r.userId, Number(r.days)]));

  // Top pages: aggregate the per-path counts under their friendly labels.
  const pagesOf = new Map<string, Map<string, number>>();
  for (const r of byPage) {
    let m = pagesOf.get(r.userId);
    if (!m) {
      m = new Map();
      pagesOf.set(r.userId, m);
    }
    const label = pageLabel(r.path);
    m.set(label, (m.get(label) ?? 0) + r._count);
  }

  // The page each user was last on: their newest row (tiny indexed lookup per
  // user with activity — this team is single-digit sized).
  const lastRows = await Promise.all(
    totals.map((t) =>
      prisma.usageEvent
        .findFirst({
          where: { userId: t.userId },
          orderBy: { createdAt: "desc" },
          select: { userId: true, path: true },
        })
        .catch(() => null),
    ),
  );
  const lastPathOf = new Map(lastRows.filter((r) => r != null).map((r) => [r.userId, r.path]));

  const users: UserUsage[] = accounts.map((u) => {
    const total = totalOf.get(u.id);
    const pages = pagesOf.get(u.id);
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      status: u.status,
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      lastSeenAt: total?._max.createdAt ? total._max.createdAt.toISOString() : null,
      lastPage: lastPathOf.has(u.id) ? pageLabel(lastPathOf.get(u.id)!) : null,
      eventsToday: todayOf.get(u.id) ?? 0,
      eventsWindow: total?._count ?? 0,
      activeDays: daysOf.get(u.id) ?? 0,
      topPages: pages
        ? [...pages.entries()]
            .map(([label, count]) => ({ label, count }))
            .sort((x, y) => y.count - x.count)
            .slice(0, 3)
        : [],
    };
  });
  users.sort((x, y) => (y.lastSeenAt ?? "").localeCompare(x.lastSeenAt ?? "") || x.email.localeCompare(y.email));

  return {
    windowDays,
    users,
    feed: feedRows.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      role: e.role,
      label: pageLabel(e.path),
      path: e.path,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Ops go-dark alarm (daily cron). Two checks, both born from the Kyle incident
// (audit Aug 25: his login was flipped to PHOTOGRAPHER ~Aug 18 and he vanished
// for 19 days before a database probe noticed):
//   1. An ops-flagged person (opsAlerts / creativeManager / MANAGER) with a
//      login and ZERO recorded activity in 5+ days.
//   2. An ops-flagged person whose LOGIN role can't open the ops surfaces.
// Owner bell, deduped per person per week.
// ---------------------------------------------------------------------------
export async function checkOpsGoDark(): Promise<{ alerts: number }> {
  const members = await prisma.teamMember.findMany({
    where: { active: true, OR: [{ opsAlerts: true }, { creativeManager: true }, { role: "MANAGER" }] },
    select: { id: true, name: true, email: true },
  });
  if (members.length === 0) return { alerts: 0 };
  const emails = members.map((m) => m.email).filter((e): e is string => !!e);
  const [users, lastEvents] = await Promise.all([
    prisma.appUser.findMany({
      where: { OR: [{ email: { in: emails } }, { teamMemberId: { in: members.map((m) => m.id) } }] },
      select: { email: true, role: true, status: true, teamMemberId: true },
    }),
    prisma.usageEvent.groupBy({ by: ["email"], where: { email: { in: emails } }, _max: { createdAt: true } }),
  ]);
  const lastByEmail = new Map(lastEvents.map((e) => [e.email, e._max.createdAt]));
  const { notifyInApp } = await import("@/lib/notify");
  const week = new Date().toISOString().slice(0, 7) + "-w" + Math.ceil(new Date().getUTCDate() / 7);
  let alerts = 0;
  for (const m of members) {
    const user = users.find((u) => u.teamMemberId === m.id || (m.email && u.email === m.email));
    const first = m.name.split(/\s+/)[0];
    if (user && user.status === "ACTIVE" && user.role !== "ADMIN" && user.role !== "OWNER") {
      await notifyInApp({
        kind: "system",
        title: `${first} runs ops but their login can't open it`,
        body: `${m.name}'s login role is ${user.role} — Tasks/Communications/Pipeline are closed to them. If that's not intentional, fix it on People → Logins.`,
        href: "/users",
        targets: [{ roles: ["OWNER"] }],
        dedupeKey: `ops-role-${m.id}-${week}`,
      });
      alerts++;
    }
    const last = m.email ? lastByEmail.get(m.email) : null;
    if (user && user.status === "ACTIVE" && (!last || Date.now() - last.getTime() > 5 * 864e5)) {
      await notifyInApp({
        kind: "system",
        title: `${first} hasn't opened the hub in ${last ? Math.floor((Date.now() - last.getTime()) / 864e5) : "many"} days`,
        body: `${m.name} carries ops duties and has no recorded activity since ${last ? last.toISOString().slice(0, 10) : "tracking began"}. Worth a check-in.`,
        href: "/users?tab=activity",
        targets: [{ roles: ["OWNER"] }],
        dedupeKey: `ops-dark-${m.id}-${week}`,
      });
      alerts++;
    }
  }
  return { alerts };
}
