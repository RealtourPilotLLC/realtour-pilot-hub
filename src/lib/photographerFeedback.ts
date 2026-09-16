import "server-only";
import { prisma } from "@/lib/prisma";
import { toReviewNote, type ReviewNote } from "@/lib/review";
import { stripMoneySentences } from "@/lib/text";
import { hasNegativeCues } from "@/lib/feedback";

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

// A recent piece of client praise, creative-safe: POSITIVE/NEUTRAL only (the
// sentiment-in filter fails closed on NEGATIVE/null — negative client feedback
// never reaches creatives) and money-scrubbed (clients mention price in praise).
export type HubPraise = {
  rating: number | null;
  body: string;
  authorName: string | null;
  createdAt: string;
  street: string;
};

export type FeedbackHub = {
  memberId: string;
  memberName: string;
  kpis: HubKpis;
  recentPraise: HubPraise[]; // latest client praise, capped for the card
  active: HubGroup[]; // shoots with unresolved notes, newest note first
  resolved: HubGroup[]; // fully-resolved history (capped)
};

export async function getFeedbackHub(memberId: string): Promise<FeedbackHub | null> {
  const now = Date.now();
  const since = new Date(now - 90 * 24 * 3600_000);
  const prevSince = new Date(now - 180 * 24 * 3600_000);
  const reviewLag = new Date(now - 3 * 24 * 3600_000); // shoots newer than this likely aren't reviewed yet
  const rootNotes = { photographerId: memberId, lane: "PHOTOGRAPHER", parentId: null } as const;

  const [member, notes, statusRoll, inWindow, inPrev, shoots, prevShoots, ratingAgg, recentShoots, praiseRows] =
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
      // Both feedback reads skip rows an owner dismissed as "not feedback" on
      // /quality (Sep 16); `sentiment` is already the human-corrected value.
      prisma.feedback.aggregate({
        where: { photographerId: memberId, rating: { not: null }, dismissedAt: null },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      prisma.project.findMany({
        where: { ...ownsShoot(memberId), status: { not: "CANCELLED" }, shootDate: { lte: new Date(now) } },
        orderBy: { shootDate: "desc" },
        take: 25,
        select: { id: true, shootDate: true },
      }),
      // Latest client praise, creative-safe (see HubPraise).
      prisma.feedback.findMany({
        where: { photographerId: memberId, sentiment: { in: ["POSITIVE", "NEUTRAL"] }, body: { not: "" }, dismissedAt: null },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { rating: true, body: true, authorName: true, createdAt: true, project: { select: { title: true } } },
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
    recentPraise: praiseRows
      // Stars outrank words in the sentiment column, so a 4★ "please redo the
      // yard" reads POSITIVE — but the criticism must never render here. The
      // quote IS this card, so mixed reviews are dropped outright.
      .filter((p) => !hasNegativeCues(p.body))
      .map((p) => ({
        rating: p.rating,
        body: stripMoneySentences(p.body),
        authorName: p.authorName,
        createdAt: p.createdAt.toISOString(),
        street: streetOf(p.project?.title),
      }))
      // The quote IS the card — drop a row whose body scrubbed away entirely.
      .filter((p) => p.body),
    active: all.filter((g) => g.openCount > 0),
    resolved: all.filter((g) => g.openCount === 0).slice(0, 8),
  };
}

// --------------------------- My Shoots reminder ----------------------------

export type NextShootFocus = {
  openCount: number; // all OPEN root notes (fix + coaching)
  openFixes: number; // OPEN fix notes only — the tab badge, matching the hub's "To fix"
  // The THEMES to work on — Jordan's per-photo feedback rolled into a handful of
  // habits, so the card reads like a coach's reminder instead of a list of
  // individual critiques. Empty until the summary is built (see rebuild below);
  // `items` is the verbatim fallback so the card is never blank.
  bullets: string[];
  items: { id: string; body: string; kind: "fix" | "coaching"; street: string | null; projectId: string }[];
};

// Fingerprint of the notes a summary was built from — when a note is added,
// resolved or acknowledged this stops matching and the summary is rebuilt.
function focusKey(ids: string[]): string {
  return `${ids.length}:${[...ids].sort().join(",")}`.slice(0, 900);
}

// Rebuild one photographer's work-on themes. Called on note WRITE and from the
// daily cron — never from a page render, so /shoot never waits on the model.
export async function rebuildShootFocusSummary(memberId: string): Promise<{ bullets: string[] }> {
  const notes = await prisma.mediaNote.findMany({
    where: {
      photographerId: memberId, lane: "PHOTOGRAPHER", parentId: null, status: "OPEN",
      OR: [{ kind: "fix" }, { acknowledgedAt: null }],
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, body: true, kind: true, project: { select: { title: true } } },
  });
  const key = focusKey(notes.map((n) => n.id));
  const member = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { focusSummary: true, focusSummaryKey: true },
  });
  if (member?.focusSummaryKey === key && member.focusSummary) {
    try { return { bullets: JSON.parse(member.focusSummary) as string[] }; } catch { /* rebuild */ }
  }
  if (notes.length === 0) {
    await prisma.teamMember.update({
      where: { id: memberId },
      data: { focusSummary: "[]", focusSummaryKey: key, focusSummaryAt: new Date() },
    }).catch(() => {});
    return { bullets: [] };
  }
  const { summarizeShootFocus } = await import("@/lib/integrations/ai");
  const bullets = await summarizeShootFocus({
    notes: notes.map((n) => ({
      body: n.body,
      kind: n.kind === "coaching" ? ("coaching" as const) : ("fix" as const),
      street: n.project ? streetOf(n.project.title) : null,
    })),
  });
  // A failed/empty model call must NOT poison the cache — leave the old summary
  // (and the verbatim fallback) in place and try again next time.
  if (bullets.length === 0) return { bullets: [] };
  await prisma.teamMember.update({
    where: { id: memberId },
    data: { focusSummary: JSON.stringify(bullets), focusSummaryKey: key, focusSummaryAt: new Date() },
  }).catch(() => {});
  return { bullets };
}

// Every photographer with open capture feedback — the daily-cron backstop.
export async function rebuildAllShootFocusSummaries(): Promise<{ rebuilt: number }> {
  const rows = await prisma.mediaNote.groupBy({
    by: ["photographerId"],
    where: {
      lane: "PHOTOGRAPHER", parentId: null, status: "OPEN",
      photographerId: { not: null },
      OR: [{ kind: "fix" }, { acknowledgedAt: null }],
    },
  });
  let rebuilt = 0;
  for (const r of rows) {
    if (!r.photographerId) continue;
    try { await rebuildShootFocusSummary(r.photographerId); rebuilt++; } catch { /* keep going */ }
  }
  return { rebuilt };
}

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
  const [openCount, openFixes, rows, member, allIds] = await Promise.all([
    prisma.mediaNote.count({ where }),
    prisma.mediaNote.count({ where: { ...where, kind: "fix" } }),
    prisma.mediaNote.findMany({
      where,
      // "fix" sorts after "coaching" alphabetically, so desc puts fixes first.
      orderBy: [{ kind: "desc" }, { createdAt: "desc" }],
      take: 4,
      select: { id: true, body: true, kind: true, projectId: true, project: { select: { title: true } } },
    }),
    prisma.teamMember.findUnique({ where: { id: memberId }, select: { focusSummary: true, focusSummaryKey: true } }),
    prisma.mediaNote.findMany({ where, orderBy: { createdAt: "desc" }, take: 40, select: { id: true } }),
  ]);

  // Show the themes whenever we have them — a slightly stale summary still
  // reads far better than a wall of per-photo critiques, and the rebuild (note
  // share + daily cron) catches up. `focusKey` only decides WHETHER to rebuild,
  // never whether to display. Verbatim notes are the fallback for a photographer
  // who has no summary yet.
  void focusKey(allIds.map((n) => n.id));
  let bullets: string[] = [];
  if (member?.focusSummary) {
    try {
      const parsed = JSON.parse(member.focusSummary) as unknown;
      if (Array.isArray(parsed)) bullets = parsed.filter((b): b is string => typeof b === "string");
    } catch { /* fall back to verbatim */ }
  }

  return {
    openCount,
    openFixes,
    bullets,
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
