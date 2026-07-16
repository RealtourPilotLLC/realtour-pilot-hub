import "server-only";
import { prisma } from "@/lib/prisma";
import { toReviewNote, type ReviewNote } from "@/lib/review";

// ---------------------------------------------------------------------------
// Read layer for the photographer QUALITY FEEDBACK hub (/shoot/feedback) — the
// cross-shoot view of everything getPhotographerFeedback shows per shoot:
// every PHOTOGRAPHER-lane note ever addressed to one photographer (photo pins
// AND video-cut capture notes — both carry photographerId), grouped by shoot,
// with the KPIs that answer "how am I doing". The owner/admin roster overview
// (getFeedbackRoster) is the flip side: every photographer at a glance.
// The My Shoots reminder card reads getNextShootFocus.
// ---------------------------------------------------------------------------

const streetOf = (title?: string | null) => (title || "Shoot").split(",")[0].trim() || "Shoot";

// A shoot belongs to a photographer if they're the project's photographer OR an
// appointment assignee — same OR photographerOwnsShoot / My Shoots use.
const ownsShoot = (memberId: string) => ({
  OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId } } }],
});

export type HubKpis = {
  windowDays: number; // the shoots/notes rate window (90d)
  shoots: number; // shoots in the window
  openFixes: number; // OPEN fix notes (all time — they owe these)
  awaitingReReview: number; // FIXED, waiting on the owner's re-look
  openCoaching: number; // OPEN coaching notes (do-better-next-time)
  notesPerTenShoots: number | null; // capture notes per 10 shoots in the window
  prevNotesPerTenShoots: number | null; // same rate, the 90d before — the trend
  cleanStreak: number; // consecutive recent shoots (3+ days old) with zero notes
  avgRating: number | null; // client stars (Feedback.rating), all time
  ratingCount: number;
};

export type HubGroup = {
  projectId: string;
  street: string;
  shootDate: string | null;
  openCount: number; // root notes not yet RESOLVED
  notes: ReviewNote[];
};

export type FeedbackHub = {
  memberId: string;
  memberName: string;
  kpis: HubKpis;
  active: HubGroup[]; // shoots with unresolved notes, newest note first
  resolved: HubGroup[]; // fully-resolved history (capped)
};

export async function getFeedbackHub(memberId: string): Promise<FeedbackHub | null> {
  const now = Date.now();
  const since = new Date(now - 90 * 24 * 3600_000);
  const prevSince = new Date(now - 180 * 24 * 3600_000);
  const reviewLag = new Date(now - 3 * 24 * 3600_000); // shoots newer than this likely aren't reviewed yet
  const rootNotes = { photographerId: memberId, lane: "PHOTOGRAPHER", parentId: null } as const;

  const [member, notes, statusRoll, inWindow, inPrev, shoots, prevShoots, ratingAgg, recentShoots] =
    await Promise.all([
      prisma.teamMember.findUnique({ where: { id: memberId }, select: { id: true, name: true } }),
      prisma.mediaNote.findMany({
        where: rootNotes,
        orderBy: { createdAt: "desc" },
        take: 300, // the displayed history; KPI counts come from the exact queries below
        include: {
          replies: { orderBy: { createdAt: "asc" } },
          project: { select: { title: true, shootDate: true } },
        },
      }),
      // Exact all-time status/kind counts — never clipped by the display cap.
      prisma.mediaNote.groupBy({ by: ["status", "kind"], where: rootNotes, _count: true }),
      prisma.mediaNote.count({ where: { ...rootNotes, createdAt: { gte: since } } }),
      prisma.mediaNote.count({ where: { ...rootNotes, createdAt: { gte: prevSince, lt: since } } }),
      prisma.project.count({
        where: { ...ownsShoot(memberId), status: { not: "CANCELLED" }, shootDate: { gte: since, lte: new Date(now) } },
      }),
      prisma.project.count({
        where: { ...ownsShoot(memberId), status: { not: "CANCELLED" }, shootDate: { gte: prevSince, lt: since } },
      }),
      prisma.feedback.aggregate({
        where: { photographerId: memberId, rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      prisma.project.findMany({
        where: { ...ownsShoot(memberId), status: { not: "CANCELLED" }, shootDate: { lte: new Date(now) } },
        orderBy: { shootDate: "desc" },
        take: 25,
        select: { id: true, shootDate: true },
      }),
    ]);
  if (!member) return null;

  const rate = (count: number, s: number) => (s > 0 ? Math.round((count / s) * 100) / 10 : null);
  const rollCount = (f: (r: { status: string; kind: string }) => boolean) =>
    statusRoll.filter(f).reduce((sum, r) => sum + r._count, 0);

  // Clean streak: walk the most recent shoots, newest first. A noted shoot
  // breaks the streak no matter how fresh; an un-noted shoot younger than the
  // review lag is skipped (it just hasn't had its review yet), older ones count.
  const notedProjects = new Set(notes.map((n) => n.projectId));
  let cleanStreak = 0;
  for (const p of recentShoots) {
    if (notedProjects.has(p.id)) break;
    if (p.shootDate && p.shootDate > reviewLag) continue;
    cleanStreak++;
  }

  const kpis: HubKpis = {
    windowDays: 90,
    shoots,
    openFixes: rollCount((r) => r.kind === "fix" && r.status === "OPEN"),
    awaitingReReview: rollCount((r) => r.status === "FIXED"),
    openCoaching: rollCount((r) => r.kind === "coaching" && r.status === "OPEN"),
    notesPerTenShoots: rate(inWindow, shoots),
    prevNotesPerTenShoots: rate(inPrev, prevShoots),
    cleanStreak,
    avgRating: ratingAgg._avg.rating != null ? Math.round(ratingAgg._avg.rating * 10) / 10 : null,
    ratingCount: ratingAgg._count.rating,
  };

  // Group by shoot, keeping the notes' newest-first order for group order too.
  const groups = new Map<string, HubGroup>();
  for (const n of notes) {
    let g = groups.get(n.projectId);
    if (!g) {
      g = {
        projectId: n.projectId,
        street: streetOf(n.project?.title),
        shootDate: n.project?.shootDate ? n.project.shootDate.toISOString() : null,
        openCount: 0,
        notes: [],
      };
      groups.set(n.projectId, g);
    }
    if (n.status !== "RESOLVED") g.openCount++;
    g.notes.push(toReviewNote(n));
  }
  const all = [...groups.values()];
  return {
    memberId: member.id,
    memberName: member.name,
    kpis,
    active: all.filter((g) => g.openCount > 0),
    resolved: all.filter((g) => g.openCount === 0).slice(0, 8),
  };
}

// --------------------------- My Shoots reminder ----------------------------

export type NextShootFocus = {
  openCount: number; // all OPEN root notes (fix + coaching)
  openFixes: number; // OPEN fix notes only — the tab badge, matching the hub's "To fix"
  items: { id: string; body: string; kind: "fix" | "coaching"; street: string | null; projectId: string }[];
};

// The open capture notes worth re-reading before the next shoot: fixes first,
// then coaching, newest first — capped for the card.
export async function getNextShootFocus(memberId: string): Promise<NextShootFocus> {
  // "Got it" retires a coaching note from the work-ons card — acknowledged
  // notes sat there forever with nothing the photographer could do (audit).
  // Open FIXES always stay (they're work, not reading).
  const where: import("@prisma/client").Prisma.MediaNoteWhereInput = {
    photographerId: memberId,
    lane: "PHOTOGRAPHER",
    parentId: null,
    status: "OPEN",
    OR: [{ kind: "fix" }, { acknowledgedAt: null }],
  };
  const [openCount, openFixes, rows] = await Promise.all([
    prisma.mediaNote.count({ where }),
    prisma.mediaNote.count({ where: { ...where, kind: "fix" } }),
    prisma.mediaNote.findMany({
      where,
      // "fix" sorts after "coaching" alphabetically, so desc puts fixes first.
      orderBy: [{ kind: "desc" }, { createdAt: "desc" }],
      take: 4,
      select: { id: true, body: true, kind: true, projectId: true, project: { select: { title: true } } },
    }),
  ]);
  return {
    openCount,
    openFixes,
    items: rows.map((r) => ({
      id: r.id,
      body: r.body.length > 120 ? `${r.body.slice(0, 117)}…` : r.body,
      kind: r.kind === "coaching" ? "coaching" : "fix",
      street: r.project ? streetOf(r.project.title) : null,
      projectId: r.projectId,
    })),
  };
}

// --------------------------- Owner/admin roster -----------------------------

export type RosterRow = {
  memberId: string;
  name: string;
  shoots90: number;
  openFixes: number;
  awaitingReReview: number;
  openCoaching: number;
  totalNotes: number;
};

// Every photographer with capture feedback or recent shoots — Jordan's (and
// Kyle's) at-a-glance "how's everyone doing" table on /shoot/feedback.
export async function getFeedbackRoster(): Promise<RosterRow[]> {
  const since = new Date(Date.now() - 90 * 24 * 3600_000);
  const [noteRoll, windowShoots] = await Promise.all([
    prisma.mediaNote.groupBy({
      by: ["photographerId", "status", "kind"],
      where: { lane: "PHOTOGRAPHER", parentId: null, photographerId: { not: null } },
      _count: true,
    }),
    // Shoot counts must use the same OR-ownership as everywhere else (project
    // photographer OR appointment assignee) — some jobs are assigned only via
    // the appointment. One narrow window read, counted in JS.
    prisma.project.findMany({
      where: { status: { not: "CANCELLED" }, shootDate: { gte: since, lte: new Date() } },
      select: { photographerId: true, appointments: { select: { assignedToId: true } } },
    }),
  ]);

  const rows = new Map<string, RosterRow>();
  const row = (id: string): RosterRow => {
    let r = rows.get(id);
    if (!r) {
      r = { memberId: id, name: "", shoots90: 0, openFixes: 0, awaitingReReview: 0, openCoaching: 0, totalNotes: 0 };
      rows.set(id, r);
    }
    return r;
  };
  for (const n of noteRoll) {
    if (!n.photographerId) continue;
    const r = row(n.photographerId);
    r.totalNotes += n._count;
    if (n.status === "OPEN" && n.kind === "fix") r.openFixes += n._count;
    if (n.status === "OPEN" && n.kind === "coaching") r.openCoaching += n._count;
    if (n.status === "FIXED") r.awaitingReReview += n._count;
  }
  for (const p of windowShoots) {
    // Each shoot counts once per distinct owning member.
    const owners = new Set<string>();
    if (p.photographerId) owners.add(p.photographerId);
    for (const a of p.appointments) if (a.assignedToId) owners.add(a.assignedToId);
    for (const id of owners) row(id).shoots90++;
  }

  const ids = [...rows.keys()];
  if (ids.length === 0) return [];
  const members = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  for (const m of members) {
    const r = rows.get(m.id);
    if (r) r.name = m.name;
  }
  return [...rows.values()]
    .filter((r) => r.name) // a stale photographerId with no TeamMember row renders nothing useful
    .sort((a, b) => b.openFixes - a.openFixes || b.totalNotes - a.totalNotes || a.name.localeCompare(b.name));
}
