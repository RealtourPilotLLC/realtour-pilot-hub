import "server-only";
import { ActivityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getFeedbackRoster } from "@/lib/photographerFeedback";
import {
  isFieldFlag,
  NOT_COMPLETED_FLAG_PREFIX,
  REVISION_FLAG_PREFIX,
  APPT_CANCELLED_FLAG_PREFIX,
} from "@/lib/debrief";

// ---------------------------------------------------------------------------
// Read layer for /quality — the owner/admin view of feedback about THE WORK
// (client responses + photographer quality signals). The sibling board at
// /feedback is feedback about THE HUB (PlatformFeedback: features + bugs).
//
// NOTHING here is scrubbed or sentiment-filtered. This page is owner/admin
// only, and Jordan has to read the unhappy ones verbatim — the creative-safe
// versions of the same rows live on /shoot/feedback and /shoot/<id> (see
// getClientFeedback + getFeedbackHub, which fail closed on NEGATIVE and run
// stripMoneySentences). Two audiences, two read layers, on purpose.
// ---------------------------------------------------------------------------

const streetOf = (title?: string | null) => (title || "Shoot").split(",")[0].trim() || "Shoot";

// One decimal, and null stays null — an average of "no ratings yet" is not 0.0.
const round1 = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10) / 10);

export type ClientFilter = "all" | "unhappy" | "rated" | "open";

export type ClientFeedbackItem = {
  id: string;
  createdAt: string;
  rating: number | null;
  sentiment: string | null; // POSITIVE | NEUTRAL | NEGATIVE | null
  category: string | null;
  source: string; // form | text | email
  /** The readable transcript of the whole response — for a form row this is the
      three answers composed into one block (see transcript() in
      src/app/feedback/[id]/actions.ts). Always safe to render on its own. */
  body: string;
  // --- The three questions, as their own fields ----------------------------
  // Only rows from the public form carry these (`source: "form"`); a row the
  // comms brain filed off an unhappy text has words in `body` and nulls here.
  // photographerRating is the number that belongs to `photographerName` below —
  // it is THE per-photographer client KPI. contentRating belongs to the work.
  photographerRating: number | null;
  photographerNote: string | null;
  improveNote: string | null;
  contentRating: number | null;
  contentNote: string | null;
  authorName: string | null;
  resolved: boolean;
  /** Whose problem it is — see src/lib/feedbackAttribution.ts. A photographer's
   *  score only counts ONSITE and MIXED, so the row says which it is. */
  attribution: "ONSITE" | "OPERATIONS" | "MIXED" | null;
  attributionWhy: string | null;
  attributionBy: string | null;
  /** the email we sent back, when we have */
  repliedAtISO: string | null;
  replyBy: string | null;
  clientEmail: string | null;
  projectId: string;
  street: string;
  projectTitle: string;
  shootDate: string | null;
  clientId: string | null;
  clientName: string | null;
  photographerName: string | null;
  // true when the name above came from the project's CURRENT photographer
  // rather than the id stamped on the feedback row itself (rows raised from
  // comms never stamp one — see the gap note in getClientFeedbackFeed).
  photographerInferred: boolean;
};

export type ClientFeedbackFeed = {
  items: ClientFeedbackItem[];
  filter: ClientFilter;
  // Counts are over EVERYTHING, never the filtered slice — the strip must not
  // change meaning when you click a chip.
  total: number;
  last90: number;
  avgRating: number | null;
  ratingCount: number;
  // The two per-question averages, kept apart from avgRating on purpose:
  // avgRating is the OVERALL score (and, when a client skipped the overall
  // stars, the lowest thing they did rate — see effectiveOverall in the form
  // action), so it is deliberately the pessimistic number. These two are what
  // the photographer and the work actually scored.
  avgPhotographerRating: number | null;
  photographerRatingCount: number;
  avgContentRating: number | null;
  contentRatingCount: number;
  openNegative: number; // NEGATIVE and not yet marked handled
  formResponses: number; // came from the public form (the delivery-text link)
  delivered90: number; // jobs delivered in the last 90d — the denominator
  counts: Record<ClientFilter, number>;
};

// The two tab badges. Deliberately loaded on BOTH tabs (two cheap counts) so a
// badge never changes or vanishes just because you switched tab — a number that
// only exists on its own tab reads as a bug.
export async function getTabCounts(): Promise<{ clients: number; photographers: number }> {
  const [clients, photographers] = await Promise.all([
    prisma.feedback.count({ where: { resolved: false } }),
    prisma.mediaNote.count({ where: { lane: "PHOTOGRAPHER", parentId: null, status: "OPEN", kind: "fix" } }),
  ]);
  return { clients, photographers };
}

export async function getClientFeedbackFeed(filter: ClientFilter = "all"): Promise<ClientFeedbackFeed> {
  const since = new Date(Date.now() - 90 * 24 * 3600_000);

  const where =
    filter === "unhappy"
      ? { sentiment: "NEGATIVE" }
      : filter === "rated"
        ? { rating: { not: null } }
        : filter === "open"
          ? { resolved: false }
          : {};

  const [
    rows,
    total,
    last90,
    ratingAgg,
    questionAgg,
    openNegative,
    formResponses,
    delivered90,
    unhappyCount,
    ratedCount,
    openCount,
  ] =
    await Promise.all([
      prisma.feedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 300, // a year of responses at any plausible volume; paging can come later
        select: {
          id: true,
          createdAt: true,
          rating: true,
          sentiment: true,
          category: true,
          source: true,
          body: true,
          photographerRating: true,
          photographerNote: true,
          improveNote: true,
          attribution: true,
          attributionWhy: true,
          attributionBy: true,
          repliedAt: true,
          replyBy: true,
          contentRating: true,
          contentNote: true,
          authorName: true,
          resolved: true,
          photographerId: true,
          projectId: true,
          project: {
            select: {
              title: true,
              shootDate: true,
              client: { select: { id: true, name: true, email: true } },
              photographer: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.feedback.count(),
      prisma.feedback.count({ where: { createdAt: { gte: since } } }),
      prisma.feedback.aggregate({ where: { rating: { not: null } }, _avg: { rating: true }, _count: { rating: true } }),
      // One pass for both per-question averages — _count is per FIELD, so a
      // response that rated the photographer but skipped the content stars
      // counts in one and not the other, which is the truth.
      prisma.feedback.aggregate({
        _avg: { photographerRating: true, contentRating: true },
        _count: { photographerRating: true, contentRating: true },
      }),
      prisma.feedback.count({ where: { sentiment: "NEGATIVE", resolved: false } }),
      prisma.feedback.count({ where: { source: "form" } }),
      prisma.project.count({ where: { deliveredAt: { gte: since } } }),
      prisma.feedback.count({ where: { sentiment: "NEGATIVE" } }),
      prisma.feedback.count({ where: { rating: { not: null } } }),
      prisma.feedback.count({ where: { resolved: false } }),
    ]);

  // Feedback.photographerId has no Prisma relation (it's a plain scorecard
  // stamp), so resolve the names in one batched read rather than per row.
  const stampedIds = [...new Set(rows.map((r) => r.photographerId).filter((x): x is string => !!x))];
  const nameById = new Map<string, string>();
  if (stampedIds.length > 0) {
    const members = await prisma.teamMember.findMany({
      where: { id: { in: stampedIds } },
      select: { id: true, name: true },
    });
    for (const m of members) nameById.set(m.id, m.name);
  }

  return {
    filter,
    items: rows.map((r) => {
      const stamped = r.photographerId ? nameById.get(r.photographerId) ?? null : null;
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        rating: r.rating,
        sentiment: r.sentiment,
        category: r.category,
        source: r.source,
        body: r.body,
        photographerRating: r.photographerRating,
        photographerNote: r.photographerNote,
        improveNote: r.improveNote,
        attribution: (r.attribution as "ONSITE" | "OPERATIONS" | "MIXED" | null) ?? null,
        attributionWhy: r.attributionWhy,
        attributionBy: r.attributionBy,
        repliedAtISO: r.repliedAt?.toISOString() ?? null,
        replyBy: r.replyBy,
        clientEmail: r.project?.client?.email ?? null,
        contentRating: r.contentRating,
        contentNote: r.contentNote,
        authorName: r.authorName,
        resolved: r.resolved,
        projectId: r.projectId,
        street: streetOf(r.project.title),
        projectTitle: r.project.title,
        shootDate: r.project.shootDate ? r.project.shootDate.toISOString() : null,
        clientId: r.project.client?.id ?? null,
        clientName: r.project.client?.name ?? null,
        photographerName: stamped ?? r.project.photographer?.name ?? null,
        photographerInferred: !stamped && !!r.project.photographer?.name,
      };
    }),
    total,
    last90,
    avgRating: ratingAgg._avg.rating != null ? Math.round(ratingAgg._avg.rating * 10) / 10 : null,
    ratingCount: ratingAgg._count.rating,
    avgPhotographerRating: round1(questionAgg._avg.photographerRating),
    photographerRatingCount: questionAgg._count.photographerRating,
    avgContentRating: round1(questionAgg._avg.contentRating),
    contentRatingCount: questionAgg._count.contentRating,
    openNegative,
    formResponses,
    delivered90,
    counts: { all: total, unhappy: unhappyCount, rated: ratedCount, open: openCount },
  };
}

// --------------------------- Photographer board -----------------------------

export type CaptureNote = {
  id: string;
  body: string;
  kind: string; // fix | coaching
  status: string; // OPEN | FIXED | RESOLVED
  street: string;
  projectId: string;
  createdAt: string;
  seenAt: string | null; // did the photographer actually open it
  acknowledgedAt: string | null; // their explicit "Got it"
};

export type PhotographerClientWord = {
  id: string;
  rating: number | null;
  sentiment: string | null;
  body: string;
  /** What the client scored THIS PERSON out of 5 (form responses only). */
  photographerRating: number | null;
  /** Their words about this person. */
  photographerNote: string | null;
  /** "What would you like to see done differently?" — the coaching line. */
  improveNote: string | null;
  authorName: string | null;
  street: string;
  projectId: string;
  createdAt: string;
};

// A photographer's field flag is an Activity of type FLAG on the job — the same
// row /shoot, Ops Day and the editor PDF read, filtered by the shared
// isFieldFlag() so client revision asks (whose body is a whole email thread)
// and machine "Not completed" echoes never render as something a photographer
// raised.
//
// This used to read PlatformFeedback rows of kind "field_issue". Nothing writes
// those any more — fileFieldIssue stopped mirroring flags onto the product
// board on Sep 2 — so the section was dead on arrival, showing two DECLINED
// rows from July and nothing since. The live signal is the job.
//
// The field names below still match PlatformFeedbackItem's FeedbackRow so the
// page keeps rendering, but `status` is deliberately NOT one of that
// component's four decision states — none of its Approve / Decline / Mark
// shipped branches may appear, because those call decidePlatformFeedback with
// this row's id and there is no PlatformFeedback row behind it. A field flag is
// closed on its ops loop (the internal_instruction task Ops Day shows with a
// Handled button), never by approving or declining it here.
//
// FOLLOW-UP for whoever owns quality/page.tsx: render these with a plain row
// (title/body/submittedBy/createdAt + a link to `page`) instead of
// PlatformFeedbackItem. That component still shows the owner a "Ping on Slack"
// control, which answers "Item or person not found." for these ids.
const FIELD_FLAG_STATUS = "LOGGED";

export type FieldFlag = {
  id: string; // the Activity id — NOT a PlatformFeedback id
  kind: string; // always "field_issue" (drives the amber chip)
  title: string; // the street — the flag text itself is the body
  body: string | null;
  /** Who raised it: the Activity's author when one is stamped, otherwise the
      job's photographer (these rows carry no author today, so it's the
      photographer — the same inference that groups them below). */
  submittedBy: string | null;
  status: string;
  createdAt: string;
  screenshot: string | null; // always null — a field flag has no screenshot
  page: string | null; // /projects/<id> — "Open where it was flagged →"
  projectId: string;
  street: string;
};

export type PhotographerBlock = {
  memberId: string;
  name: string;
  shoots90: number;
  openFixes: number;
  awaitingReReview: number;
  openCoaching: number;
  totalNotes: number;
  /** Average OVERALL score on their jobs — the long-standing number, which
      includes rows with no per-question answers (an unhappy text, a response
      from before the three-question form). */
  avgRating: number | null;
  ratingCount: number;
  /** THE per-photographer client KPI: the average of what clients scored this
      person on "How was your experience with your photographer?". Separate from
      avgRating because that one also carries the client's view of the WORK —
      an editor's dark video should not cost the photographer a star. */
  avgPhotographerRating: number | null;
  photographerRatingCount: number;
  notes: CaptureNote[];
  clientWords: PhotographerClientWord[];
  flags: FieldFlag[];
};

export type PhotographerBoard = {
  blocks: PhotographerBlock[];
  // Field flags raised on a job with NO photographer assigned — nobody to file
  // them under. Shown in their own group so a flag is never dropped on the
  // floor. (Previously: flags whose free-text submittedBy matched no roster
  // name; attribution now comes from the job itself, so that fuzzy name
  // matching is gone.)
  unmatchedFlags: FieldFlag[];
};

export async function getPhotographerBoard(): Promise<PhotographerBoard> {
  const [roster, notes, clientRows, flags, ratingRoll, photographerRoll] = await Promise.all([
    // The same roster the photographers' own hub scoreboard uses, so the two
    // screens can never disagree about who owes what.
    getFeedbackRoster(),
    prisma.mediaNote.findMany({
      where: { lane: "PHOTOGRAPHER", parentId: null, photographerId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 400,
      select: {
        id: true, body: true, kind: true, status: true, createdAt: true, projectId: true,
        seenAt: true, acknowledgedAt: true, photographerId: true,
        project: { select: { title: true } },
      },
    }),
    prisma.feedback.findMany({
      where: { photographerId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, rating: true, sentiment: true, body: true, authorName: true,
        photographerRating: true, photographerNote: true, improveNote: true,
        createdAt: true, projectId: true, photographerId: true,
        project: { select: { title: true } },
      },
    }),
    // The flags themselves, off the JOB. The three NOT clauses are only a
    // prefilter so the take window doesn't fill with rows isFieldFlag would
    // drop anyway (118 of the 126 FLAG rows in prod on Sep 2 are client
    // revision asks, each carrying a whole email thread) — isFieldFlag below
    // remains the single authority on what counts as a field flag.
    prisma.activity.findMany({
      where: {
        type: ActivityType.FLAG,
        NOT: [
          { body: { startsWith: REVISION_FLAG_PREFIX } },
          { body: { startsWith: NOT_COMPLETED_FLAG_PREFIX } },
          { body: { startsWith: APPT_CANCELLED_FLAG_PREFIX } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true, body: true, createdAt: true, projectId: true,
        author: { select: { name: true } },
        project: {
          select: { title: true, photographerId: true, photographer: { select: { name: true } } },
        },
      },
    }),
    prisma.feedback.groupBy({
      by: ["photographerId"],
      where: { photographerId: { not: null }, rating: { not: null } },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    // The KPI that belongs to the person: only the answer to "How was your
    // experience with your photographer?", never the client's view of the work.
    prisma.feedback.groupBy({
      by: ["photographerId"],
      where: { photographerId: { not: null }, photographerRating: { not: null } },
      _avg: { photographerRating: true },
      _count: { photographerRating: true },
    }),
  ]);

  // Seed from the roster, then fold in anyone who only shows up in the other
  // signals (a photographer with client feedback but no capture notes yet).
  const blocks = new Map<string, PhotographerBlock>();
  const seed = (memberId: string, name = ""): PhotographerBlock => {
    let b = blocks.get(memberId);
    if (!b) {
      b = {
        memberId, name, shoots90: 0, openFixes: 0, awaitingReReview: 0, openCoaching: 0,
        totalNotes: 0, avgRating: null, ratingCount: 0, avgPhotographerRating: null,
        photographerRatingCount: 0, notes: [], clientWords: [], flags: [],
      };
      blocks.set(memberId, b);
    }
    if (!b.name && name) b.name = name;
    return b;
  };
  for (const r of roster) {
    const b = seed(r.memberId, r.name);
    b.shoots90 = r.shoots90;
    b.openFixes = r.openFixes;
    b.awaitingReReview = r.awaitingReReview;
    b.openCoaching = r.openCoaching;
    b.totalNotes = r.totalNotes;
  }
  for (const n of notes) {
    if (!n.photographerId) continue;
    seed(n.photographerId).notes.push({
      id: n.id,
      body: n.body,
      kind: n.kind,
      status: n.status,
      street: streetOf(n.project?.title),
      projectId: n.projectId,
      createdAt: n.createdAt.toISOString(),
      seenAt: n.seenAt ? n.seenAt.toISOString() : null,
      acknowledgedAt: n.acknowledgedAt ? n.acknowledgedAt.toISOString() : null,
    });
  }
  for (const f of clientRows) {
    if (!f.photographerId) continue;
    seed(f.photographerId).clientWords.push({
      id: f.id,
      rating: f.rating,
      sentiment: f.sentiment,
      body: f.body,
      photographerRating: f.photographerRating,
      photographerNote: f.photographerNote,
      improveNote: f.improveNote,
      authorName: f.authorName,
      street: streetOf(f.project?.title),
      projectId: f.projectId,
      createdAt: f.createdAt.toISOString(),
    });
  }
  for (const g of ratingRoll) {
    if (!g.photographerId) continue;
    const b = seed(g.photographerId);
    b.avgRating = round1(g._avg.rating);
    b.ratingCount = g._count.rating;
  }
  for (const g of photographerRoll) {
    if (!g.photographerId) continue;
    const b = seed(g.photographerId);
    b.avgPhotographerRating = round1(g._avg.photographerRating);
    b.photographerRatingCount = g._count.photographerRating;
  }

  // Any member id picked up from notes/feedback that the roster didn't name.
  const unnamed = [...blocks.values()].filter((b) => !b.name).map((b) => b.memberId);
  if (unnamed.length > 0) {
    const members = await prisma.teamMember.findMany({ where: { id: { in: unnamed } }, select: { id: true, name: true } });
    for (const m of members) seed(m.id).name = m.name;
  }
  // A stale id with no TeamMember row can't render anything useful.
  for (const [id, b] of blocks) if (!b.name) blocks.delete(id);

  // Field flags: attributed by the JOB's photographer, which is how every other
  // shoot surface reads them — no fuzzy matching of a free-text name against
  // the roster, and no flag can land on the wrong person because a login is
  // spelled differently from the team record.
  const unmatchedFlags: FieldFlag[] = [];
  for (const a of flags) {
    if (!isFieldFlag(a.body)) continue;
    const street = streetOf(a.project?.title);
    const shooter = a.project?.photographer?.name ?? null;
    const row: FieldFlag = {
      id: a.id,
      kind: "field_issue",
      title: street,
      body: a.body,
      submittedBy: a.author?.name ?? shooter,
      status: FIELD_FLAG_STATUS,
      createdAt: a.createdAt.toISOString(),
      screenshot: null,
      page: `/projects/${a.projectId}`,
      projectId: a.projectId,
      street,
    };
    const memberId = a.project?.photographerId ?? null;
    if (memberId) seed(memberId, shooter ?? "").flags.push(row);
    else unmatchedFlags.push(row);
  }
  for (const [id, b] of blocks) if (!b.name) blocks.delete(id);

  return {
    blocks: [...blocks.values()].sort(
      (a, b) =>
        b.openFixes - a.openFixes ||
        b.clientWords.length - a.clientWords.length ||
        b.totalNotes - a.totalNotes ||
        a.name.localeCompare(b.name),
    ),
    unmatchedFlags,
  };
}
