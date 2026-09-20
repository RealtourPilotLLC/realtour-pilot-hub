import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The bell's data feed.
//   GET  → a page of the notifications visible to the signed-in user (their
//          role's broadcasts + rows targeted at their tm:/editor: key) plus the
//          unread count vs. their watermark. `?count=1` for the badge alone,
//          `?before=<id>` for the next page of older rows.
//   POST → advance the watermark. Owner "view as" is strictly read-only: it
//          renders the impersonated person's bell but must never move THEIR
//          watermark.
// Role names are distinct words, so matching the audience JSON with a quoted
// substring is safe (no role is a substring of another).
//
// WHY THE WATERMARK IS NOW FUSSY (Sep 20 2026). AppUser.notificationsSeenAt is a
// single scalar and unread means `createdAt > seenAt`, so a watermark can only
// ever mark a CONTIGUOUS TAIL read. The bell used to show the newest 30 rows and
// then stamp the watermark at now() the instant the panel opened, which marks
// every older row read too. On the day this was found James had 887 rows behind
// his watermark and the panel could only ever render 30 of them: one click would
// have retired 857 rows he had never been shown, 181 of them addressed to him by
// name, and there was no second page, no /notifications screen and no way back.
// Two rules now hold, and both of them are about never retiring a row the person
// was not given the chance to read:
//   1. The watermark only moves when the rows actually delivered to the browser
//      COVER the whole unread span (checked server-side in POST, not taken on
//      the client's word), or when the person explicitly clicks "Mark all read".
//   2. It moves to the newest row that was on screen, never to now(), so a row
//      minted between the fetch and the close stays unread.
// Rows past the page are reachable now: the list is keyset-paginated and the
// panel has a "Load older" button.
//
// DO NOT try to make this quieter by filtering kinds out of the query or by
// pruning rows. `reply_sla` and `photos_undelivered` Notification rows are not
// messages, they are the dedupe LEDGERS src/lib/commsSla.ts and
// src/lib/deliveryWatch.ts read back by dedupeKey to decide whether they already
// paged someone. Drop them and the client pager re-fires every five minutes.

// One screenful. Older rows come back a page at a time via ?before=.
const PAGE_SIZE = 30;
// The first page stretches to cover the backlog so the common case (a day or two
// away from the bell) is one open, one close, watermark honest. The ceiling stops
// a two-month backlog from becoming a 900-row payload; past it the panel says so
// and the watermark simply stays put.
const MAX_FIRST_PAGE = 200;

const ROW_SELECT = {
  id: true,
  kind: true,
  title: true,
  body: true,
  href: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

function visibleWhere(u: {
  role: string;
  teamMemberId: string | null;
  editorKey: string | null;
}): Prisma.NotificationWhereInput {
  const userKeys = [
    u.teamMemberId ? `tm:${u.teamMemberId}` : null,
    u.editorKey ? `editor:${u.editorKey}` : null,
  ].filter((k): k is string => !!k);
  // A row ADDRESSED to this person (their tm:/editor: key) is theirs no matter
  // what audience role it was minted with — James (ADMIN login, works as a
  // photographer) had 100+ personally-addressed field rows invisible because
  // they carried audience ["PHOTOGRAPHER"] (audit Aug 25). Role gating applies
  // only to broadcasts.
  return {
    OR: [
      { audience: { contains: `"${u.role}"` }, userKey: null },
      ...(userKeys.length ? [{ userKey: { in: userKeys } }] : []),
    ],
  };
}

// Newest first, with the id as a tiebreak. createdAt is not unique and nothing
// in the schema stops two rows sharing a millisecond; a keyset cursor built on a
// non-unique column silently skips or repeats rows across a page boundary the
// first time that happens. The id is insurance, not a description of the data —
// the table has no ties today (checked Sep 20 2026: 1699 rows, 1699 distinct
// createdAt values, the closest pair 3ms apart, because notifyInApp writes one
// row at a time with the Slack/SMS bridge awaited in between). Don't drop it on
// the strength of that count: the cost is one column in an ORDER BY and the
// failure it prevents is a row that vanishes from the feed with no trace.
const FEED_ORDER: Prisma.NotificationOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

// Everything strictly older than `before` in that same ordering.
function olderThan(
  where: Prisma.NotificationWhereInput,
  before: { id: string; createdAt: Date },
): Prisma.NotificationWhereInput {
  return {
    AND: [
      where,
      {
        OR: [
          { createdAt: { lt: before.createdAt } },
          { createdAt: before.createdAt, id: { lt: before.id } },
        ],
      },
    ],
  };
}

export async function GET(req: NextRequest) {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const where = visibleWhere(u);
  const seenAt = u.notificationsSeenAt ?? new Date(0);

  const unread = await prisma.notification.count({
    where: { ...where, createdAt: { gt: seenAt } },
  });

  // The 60s poll only needs the badge. It used to pull 30 full rows every minute
  // in every open tab for a number.
  if (req.nextUrl.searchParams.get("count") === "1") {
    return NextResponse.json({ unread, seenAt: u.notificationsSeenAt });
  }

  const beforeId = req.nextUrl.searchParams.get("before");
  let before: { id: string; createdAt: Date } | null = null;
  if (beforeId) {
    before = await prisma.notification.findFirst({
      where: { AND: [where, { id: beforeId }] },
      select: { id: true, createdAt: true },
    });
    // A cursor we cannot resolve used to fall through to the FIRST page. That
    // reads to the client as a page of rows it already holds: it dedupes every
    // one of them away, the list does not grow, and "Load older" stays lit and
    // does nothing on every further click, with no way out but closing the
    // panel. An empty last page is the honest answer. The way this actually
    // happens is the 90-day trim in the daily cron deleting the tail row
    // mid-session — and that trim deletes by age, so everything older than the
    // tail went with it and there genuinely is nothing further to hand back.
    if (!before) {
      return NextResponse.json({
        items: [],
        unread,
        seenAt: u.notificationsSeenAt,
        hasMore: false,
      });
    }
  }

  const take = before
    ? PAGE_SIZE
    : Math.min(Math.max(PAGE_SIZE, unread), MAX_FIRST_PAGE);
  // One extra row is the "is there more" probe — cheaper than a second count.
  const rows = await prisma.notification.findMany({
    where: before ? olderThan(where, before) : where,
    orderBy: FEED_ORDER,
    take: take + 1,
    select: ROW_SELECT,
  });
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;

  return NextResponse.json({ items, unread, seenAt: u.notificationsSeenAt, hasMore });
}

type MarkBody = { newestId?: unknown; oldestId?: unknown; all?: unknown };

export async function POST(req: NextRequest) {
  const u = await getCurrentUser();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (u.impersonating) return new NextResponse(null, { status: 204 });

  const body = (await req.json().catch(() => null)) as MarkBody | null;
  const where = visibleWhere(u);
  const seenAt = u.notificationsSeenAt ?? new Date(0);

  // "Mark all read" is the one path allowed to retire rows nobody looked at,
  // because a person pressed a button that says so. Everything else has to earn
  // it by having shown the rows.
  if (body?.all === true) {
    const next = new Date();
    await prisma.appUser.update({
      where: { id: u.id },
      data: { notificationsSeenAt: next },
    });
    return NextResponse.json({ ok: true, unread: 0, seenAt: next, advanced: true });
  }

  const newestId = typeof body?.newestId === "string" ? body.newestId : null;
  const oldestId = typeof body?.oldestId === "string" ? body.oldestId : null;
  if (!newestId || !oldestId) {
    // A bodiless POST used to mean "mark everything read". It no longer means
    // anything: refusing is the safe answer, and the badge simply stays.
    return NextResponse.json(
      { error: "Send the newest and oldest rows that were on screen, or all: true." },
      { status: 400 },
    );
  }

  // Resolve the claimed window against rows this person can actually see, so a
  // hand-rolled POST cannot move the watermark past someone else's row.
  const ends = await prisma.notification.findMany({
    where: { AND: [where, { id: { in: [newestId, oldestId] } }] },
    select: { id: true, createdAt: true },
    orderBy: FEED_ORDER,
  });
  const newest = ends.find((r) => r.id === newestId);
  const oldest = ends.find((r) => r.id === oldestId);
  if (!newest || !oldest) {
    // The rows went away under us (the 90-day trim in the daily cron deletes
    // them). Nothing to be sure of, so nothing moves.
    const unread = await prisma.notification.count({
      where: { ...where, createdAt: { gt: seenAt } },
    });
    return NextResponse.json({
      ok: true,
      unread,
      seenAt: u.notificationsSeenAt,
      advanced: false,
    });
  }

  // THE COVERAGE TEST. Is there anything unread that was NOT on screen, i.e. a
  // row newer than the watermark but older than the oldest row delivered? If so
  // the watermark stays where it is: advancing it would mark those read.
  const uncovered = await prisma.notification.count({
    where: {
      AND: [olderThan(where, oldest), { createdAt: { gt: seenAt } }],
    },
  });

  let next = u.notificationsSeenAt;
  let advanced = false;
  if (uncovered === 0 && newest.createdAt > seenAt) {
    next = newest.createdAt;
    advanced = true;
    await prisma.appUser.update({
      where: { id: u.id },
      data: { notificationsSeenAt: next },
    });
  }

  const remaining = await prisma.notification.count({
    where: { ...where, createdAt: { gt: next ?? new Date(0) } },
  });
  return NextResponse.json({ ok: true, unread: remaining, seenAt: next, advanced });
}
