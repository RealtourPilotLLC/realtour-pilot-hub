import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CalendarCheck, MessageSquareHeart, Radar } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess, homeFor } from "@/lib/auth/access";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { prisma } from "@/lib/prisma";
import { etDateYear, etDayStartUtc } from "@/lib/datetime";
import {
  bucketClientThreads,
  coachingAuditKey,
  commsCoachingSettings,
  listCoachingAudits,
  COMMS_COACHING_ET_HOUR,
  type CoachingAudit,
  type CoachOwnRow,
  type CommsCoachingSettings,
} from "@/lib/commsCoaching";
// The house email → TeamMember resolution. It is named for the surface that
// needed it first; the question it answers ("which person on the team is this
// login?") is not photographer-specific, and having two answers to that
// question is how a coaching note ends up on the wrong person's screen.
import { photographerMemberId as teamMemberIdForLogin } from "@/lib/shoot";
import { NoteCard } from "@/components/coaching/NoteCard";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /coaching — THE REPORT (Jordan, Sep 21 2026: "I don't have time to track this
// with Kyle … and I should be able to see a report too").
//
// This page READS. Everything it shows is written by src/lib/commsCoaching.ts
// from the evening cron; the only rule this screen owns is who may look at it.
//
// WHO SEES WHAT. Jordan sees the whole thing. A person on the coached roster
// sees their OWN notes and nothing else: not the roster, not the coverage
// numbers, not another person's note, not how many people are audited. A signed
// in colleague who is not coached gets a plain "nothing here for you" that names
// nobody. Everyone else is sent home.
//
// NO PAGE KEY, DELIBERATELY — same as /quality. Middleware's pathKey() only
// recognises paths registered in PAGES, so /coaching resolves to null and
// middleware checks nothing beyond "you are signed in". The owner / coached-
// roster check below IS the gate and must stay. The nav entry rides the
// `review` key the way "Client & Team Feedback" does; giving this page a real
// PageKey means touching src/lib/auth/access.ts and is worth doing the next
// time that file is open.
//
// WHAT AN EMPTY REPORT MEANS. Sender attribution only began on Sep 21 2026 —
// before that every message from the company line was logged as "Us", so there
// is nothing to read back through. For the first stretch most days will have
// nothing, and this page must say "nothing we can attribute yet" in those
// words. It must never render as "Kyle sent nothing" or, worse, as a clean
// sheet nobody earned. The date in that sentence is READ FROM THE DATA rather
// than typed here, because a page that states the same fact twice in two ways
// eventually states it two different ways and the typed one is the lie.
// ---------------------------------------------------------------------------

/** One name the hub put on outbound texts this week, and how many. */
type SenderCount = { id: string; name: string | null; count: number };

/**
 * One window, split the way the audit itself splits it.
 *
 * COUNT WHAT THE AUDIT READS, NOT WHAT WENT OUT (review, Sep 21 2026). This
 * card used to show `named of every outbound human text`, and that denominator
 * is not the corpus. Measured read-only on production the same day: in 7 days
 * 146 texts left the company line by hand, and 50 of them went to a TEAMMATE's
 * handset and 2 to a number with no Client record. gatherDay drops all 52
 * before the judge sees a word of them. So the old ratio could not pass about
 * two thirds however healthy the pipe was, it would have sat there looking like
 * a permanent fault, and — the part that actually matters — a real failure of
 * attribution would have been indistinguishable from the structural shortfall.
 * The one question this card exists to answer is "is this a quiet week or a
 * blind one", and a number that is always wrong by an unexplained third cannot
 * answer it.
 */
type WindowCoverage = {
  /** Every human text that left the line in the window. */
  total: number;
  /** Of those, how many carry a sender. Pairs with the by-sender list below. */
  named: number;
  /** Of those, the ones on a conversation with a client: THE AUDIT'S CORPUS. */
  clientTotal: number;
  /** Of the corpus, how many carry a sender — the honest coverage ratio. */
  clientNamed: number;
  /** Went to one of our own numbers. Real work, never client care. */
  internal: number;
  /** No Client record on the conversation. Left alone rather than guessed at. */
  unplaceable: number;
};

/** How much of what actually went out the audit could put a name to. Without
 *  this strip an empty report looks like a quiet week instead of a blind one. */
type Coverage = {
  today: WindowCoverage;
  week: WindowCoverage;
  /** Every id the hub stamped on a text in the last 7 days, busiest first,
   *  roster or not. Whether a name here BELONGS on those messages is the
   *  question this card exists to answer: see SenderSplit below. */
  weekBySender: SenderCount[];
  /** the first message we were ever able to attribute, i.e. when this started */
  firstAttributed: Date | null;
  /** True if the week held more rows than ROW_CAP and the split below is read
   *  off the freshest ROW_CAP of them. Said out loud rather than shown as a
   *  smaller number that looks like a quiet week. */
  capped: boolean;
  /** True when we could not establish which numbers are ours, so the client /
   *  internal split below is not knowable and must not be drawn as a figure.
   *  The engine refuses to coach in this state; the card refuses to count. */
  internalUnknown: boolean;
};

// A person typing on the company line is `source: "openphone"`. Every
// auto-confirmation / auto-delivery / upload-nag / upload-digest /
// auto-afterhours / auto-welcome row is the hub's own words and is excluded
// here for the same reason the audit never coaches on them.
const HUMAN_TEXT = { direction: "out", channel: "text", source: "openphone" } as const;

// A week runs about 150 of these rows (146 measured, Sep 21 2026). The cap is an
// order of magnitude of headroom so a page render can never pull an unbounded
// table, and `capped` says so on the screen if it is ever reached.
const ROW_CAP = 2000;

/**
 * WHO IS INTERNAL — asked of the engine, never re-decided here.
 *
 * This used to be a second copy of commsCoaching's own lookup, with a comment
 * saying so and asking to be deleted once the engine exported it. The engine
 * now does, so this is that deletion. Two answers to "who is internal" is how
 * the headline on this card quietly stops describing what the audit actually
 * read, which is the one failure this card exists to prevent.
 *
 * It also inherits the engine's direction of failure, which is the half the
 * copy got wrong. The copy caught a failed roster read and carried on with a
 * short set; a short set moves internal traffic INTO the client column, so the
 * card would have reported a healthy-looking number built on messages the audit
 * never graded. The engine throws instead, and here that surfaces as an honest
 * "could not work out" rather than a figure nobody can trust.
 */
async function ourNumberKeys(): Promise<Set<string> | null> {
  const { ourPhoneKeys } = await import("@/lib/commsCoaching");
  return ourPhoneKeys().catch((e) => {
    console.warn("coaching report could not establish which numbers are ours", e);
    return null;
  });
}

/**
 * Split one window's rows the way gatherDay does, by calling the engine's own
 * bucketing rather than re-deciding what a client conversation is.
 *
 * TWO PASSES, AND THE SECOND ONE CAN ONLY UNDERSTATE. bucketClientThreads
 * classifies per CONVERSATION — one message carrying a clientId is enough to
 * say who the other party is — so running it over the named rows alone can turn
 * a thread client-ward only if a named row carries the link. That makes
 * clientNamed <= clientTotal always, and the direction of any error is towards
 * claiming less coverage than we have. That is the right way round: an
 * overstated ratio would tell Jordan the pipe is healthy on the day it is not.
 */
function splitWindow(
  rows: (CoachOwnRow & { senderTeamMemberId: string | null })[],
  ours: Set<string>,
  phoneKey: (p?: string | null) => string,
): WindowCoverage {
  const all = bucketClientThreads(rows, ours, phoneKey);
  const named = rows.filter((r) => r.senderTeamMemberId);
  const namedOnly = bucketClientThreads(named, ours, phoneKey);
  return {
    total: rows.length,
    named: named.length,
    clientTotal: all.buckets.reduce((n, b) => n + b.own, 0),
    clientNamed: namedOnly.buckets.reduce((n, b) => n + b.own, 0),
    internal: all.internal,
    unplaceable: all.unplaceable,
  };
}

async function loadCoverage(): Promise<Coverage> {
  const weekStart = new Date(Date.now() - 7 * 86_400_000);
  const todayStart = etDayStartUtc();
  const { phoneKey } = await import("@/lib/integrations/openphone");

  // ONE READ FOR THE WEEK, today filtered out of it. Two reads could disagree
  // across the boundary of a text landing mid-render, and a card whose two
  // tiles contradict each other is worse than a card with one tile. Newest
  // first so that if ROW_CAP were ever reached it is the OLD end of the week
  // that goes, never today.
  const [rows, first, ours] = await Promise.all([
    prisma.commLog.findMany({
      where: { ...HUMAN_TEXT, occurredAt: { gte: weekStart } },
      select: {
        id: true,
        occurredAt: true,
        clientId: true,
        clientName: true,
        fromPhone: true,
        senderTeamMemberId: true,
      },
      orderBy: { occurredAt: "desc" },
      take: ROW_CAP,
    }),
    prisma.commLog.findFirst({
      where: { senderTeamMemberId: { not: null } },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    ourNumberKeys(),
  ]);

  // WITHOUT THE INTERNAL SET THERE IS NO SPLIT TO DRAW. Every number would fall
  // into the client column and the card would report a confident, wrong figure
  // on the one question it exists to answer. An empty window plus
  // internalUnknown reads as "could not work out", which is the truth.
  const blank: WindowCoverage = { total: 0, named: 0, clientTotal: 0, clientNamed: 0, internal: 0, unplaceable: 0 };
  const week = ours ? splitWindow(rows, ours, phoneKey) : blank;
  const today = ours
    ? splitWindow(rows.filter((r) => r.occurredAt >= todayStart), ours, phoneKey)
    : blank;

  // EVERY sender, not just the coached ones, and counted over everything that
  // went out rather than over client work alone: a name accumulating messages
  // it should not be is the visible symptom of the pipe being wired to the
  // wrong person, and it shows up in internal traffic just as plainly.
  // Filtering to the roster here is exactly what would hide it.
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.senderTeamMemberId) continue;
    counts.set(r.senderTeamMemberId, (counts.get(r.senderTeamMemberId) ?? 0) + 1);
  }
  const ids = [...counts.keys()];
  const named = ids.length
    ? await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(named.map((t) => [t.id, t.name]));
  const weekBySender: SenderCount[] = ids
    .map((id) => ({ id, name: nameById.get(id) ?? null, count: counts.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count);

  return {
    today,
    week,
    weekBySender,
    firstAttributed: first?.occurredAt ?? null,
    capped: rows.length >= ROW_CAP,
    internalUnknown: !ours,
  };
}

/**
 * Every stored note for the people named, newest day first.
 *
 * ONE READ PER PERSON, NOT ONE MIXED PAGE (found in review, Sep 21 2026). The
 * engine's keys are comms-coaching:<teamMemberId>:<day> and listCoachingAudits
 * takes the top N ordered by key DESCENDING, which sorts by team member first
 * and only then by day. With two coached people and more than N stored rows,
 * every row that came back could belong to whichever id sorts higher, and the
 * other person would disappear from the report while their notes sat in the
 * table — their trend row reading "no day has had enough messages yet" about a
 * week they were in fact coached on. The engine's own sort by day runs after
 * the take and cannot undo it. A read per person gives each of them their own
 * budget, so nobody can lose that race.
 *
 * It also answers the one thing listCoachingAudits() cannot tell us. That
 * helper swallows its own read errors and returns [] — right for a cron step
 * that must not die, wrong for a report, because "no notes yet" and "the
 * database did not answer" are different sentences and only one of them is
 * true. So the rows are counted separately: an empty list beside a non-zero
 * count is a failed read, and the page says so instead of implying a clean
 * sheet nobody earned.
 */
async function loadAudits(
  teamMemberIds: string[],
  perPerson = 60,
): Promise<{ audits: CoachingAudit[]; failed: boolean }> {
  const each = await Promise.all(
    teamMemberIds.map(async (teamMemberId) => {
      const [audits, stored] = await Promise.all([
        listCoachingAudits({ teamMemberId, limit: perPerson }),
        // The prefix comes from the engine's own key builder rather than a
        // second copy of the literal: coachingAuditKey(id, "") IS "everything
        // on file for this person". Keeping our own copy is the two-contracts
        // drift that was already retired out of settings.ts once — if the
        // engine renamed its keys, this count would quietly return 0, `failed`
        // would never fire, and the page would report a clean sheet while the
        // cron filled rows nobody read.
        prisma.appSetting.count({ where: { key: { startsWith: coachingAuditKey(teamMemberId, "") } } }),
      ]);
      return { audits, failed: audits.length === 0 && stored > 0 };
    }),
  );
  const audits = each.flatMap((e) => e.audits);
  // Newest day first across everybody; same day sorted by person so the order
  // is stable between renders instead of following whichever query landed first.
  audits.sort((a, b) =>
    a.dayKey === b.dayKey ? a.teamMemberId.localeCompare(b.teamMemberId) : a.dayKey < b.dayKey ? 1 : -1,
  );
  // One person's read failing is enough: the alternative is a report that
  // silently shows one of two people and looks complete.
  return { audits, failed: each.some((e) => e.failed) };
}

function CouldNotLoad({ what }: { what: string }) {
  return (
    <p className="text-sm text-muted">
      {`${what} could not be read just now — reload to try again. Nothing has changed, and nothing has been sent.`}
    </p>
  );
}

/** Why the report is empty, in the words the live data supports. Three states,
 *  because "we read nothing" and "we could not read" must not sound alike. */
function whyNothingYet(coverage: Coverage | null) {
  if (!coverage) {
    return "the message counts could not be read just now, so we cannot yet tell you whether this is a quiet stretch or a blind one";
  }
  if (!coverage.firstAttributed) {
    return "no text from the company line carries a sender yet, so there is nothing for it to read";
  }
  return (
    <>
      naming the sender of a text from the company line started on{" "}
      <b>{etDateYear(coverage.firstAttributed)}</b>, so nothing older can be read back through
    </>
  );
}

/**
 * The headline: named out of THE AUDIT'S CORPUS, not out of everything sent.
 *
 * "96 of 146" is an alarm nobody can action, because the 50 it is missing were
 * never this feature's business. "96 of 98 client texts" is a fact Jordan can
 * read in one second, and the day it reads "4 of 98" he knows something broke.
 */
function CoverageTile({ window: w, label }: { window: WindowCoverage; label: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="text-lg font-semibold tabular-nums">
        {w.clientNamed}
        <span className="text-sm font-normal text-muted-2">{` of ${w.clientTotal}`}</span>
      </div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

/**
 * WHERE THE REST WENT — the shortfall in words instead of an unexplained gap.
 *
 * Measured over 30 days on Sep 21 2026: 498 human texts left the line and 272
 * of them (55%) went to a teammate's handset. That is not a fault and it is not
 * going to change, so a coverage number that silently carried it would sit
 * around two thirds forever and read as a permanent break. Named and counted,
 * it is just information: it says how much of the line is internal, and it is
 * the number to look at on a week where the report seems thin.
 *
 * Own-handset texts are the other half of why the headline is not built to
 * reach 100%. When somebody texts a client from their OWN phone rather than
 * from the hub, OpenPhone hands it back with their name in contactName and a
 * shape the webhook cannot attribute, so no sender stamp is possible. Measured
 * the same day: 12 of this week's 94 client texts were that shape (James 9,
 * Jordan 3). They are genuinely client work and genuinely unattributable, which
 * is exactly what NULL MEANS UNKNOWN, NEVER A GUESS is for. A ceiling near 87%
 * is the honest number for this week, and the prose below says so rather than
 * leaving a permanent shortfall looking like a break.
 */
function NotCoached({ week: w }: { week: WindowCoverage }) {
  const skipped = w.internal + w.unplaceable;
  if (w.total === 0) return null;
  const share = Math.round((skipped / w.total) * 100);
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">
        Where the last 7 days of texts went
      </p>
      {/* The client row is last and carries the weight, because it is the one
          the headline above is a fraction OF. The two above it are the part
          that used to be inside that fraction with nothing to explain it. */}
      <ul className="mt-2 space-y-1">
        <li className="flex items-baseline gap-2 text-[13px]">
          <span>To a teammate on the line</span>
          <span className="ml-auto tabular-nums text-muted">{w.internal}</span>
        </li>
        <li className="flex items-baseline gap-2 text-[13px]">
          <span>To a number with no client on it</span>
          <span className="ml-auto tabular-nums text-muted">{w.unplaceable}</span>
        </li>
        <li className="flex items-baseline gap-2 border-t border-border pt-1 text-[13px] font-medium">
          <span>Client texts, which is what the audit reads</span>
          <span className="ml-auto tabular-nums">{w.clientTotal}</span>
        </li>
      </ul>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        {`${share}% of what left the company line this week was to the team or to a number we could not place, and none of it is coached on. `}
        That share is normal here, not a fault. It is worth a look only when it moves a long way: a week where it
        jumps is a week the office was talking to itself instead of to clients. The headline above is deliberately
        not built to reach 100% either, because a text somebody sends a client from their own handset arrives back
        as incoming and cannot carry a name, so it is counted and left alone rather than pinned on a guess.
      </p>
    </div>
  );
}

/**
 * THE SPLIT BY SENDER — the reason this card exists at all.
 *
 * "120 of 146 named" reads as a healthy week whether or not those 120 names are
 * the right ones, so an aggregate on its own would have shown a reassuring
 * number on the exact day the audit started reading the wrong person's words.
 * Broken out, a count sitting against somebody who did not write that many is
 * visible on the page instead of only in a query somebody has to think to run.
 */
function SenderSplit({ coverage, roster }: { coverage: Coverage; roster: Set<string> }) {
  if (coverage.week.total === 0) return null;
  const unnamed = Math.max(0, coverage.week.total - coverage.week.named);
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">
        Who the hub says sent them, last 7 days
      </p>
      {/* Everything that left the line, client work and internal together. The
          headline above is deliberately narrower; this list is deliberately
          wider, because a name accumulating messages it should not be shows up
          in office chatter just as plainly as in client care. */}
      <ul className="mt-2 space-y-1">
        {coverage.weekBySender.map((s) => (
          <li key={s.id} className="flex items-baseline gap-2 text-[13px]">
            <span className="font-medium">{s.name ?? "Someone no longer on the team"}</span>
            {roster.has(s.id) && (
              <span className="rounded-full bg-brand-soft px-1.5 text-[10px] font-semibold text-brand">coached</span>
            )}
            <span className="ml-auto tabular-nums text-muted">{s.count}</span>
          </li>
        ))}
        {unnamed > 0 && (
          <li className="flex items-baseline gap-2 text-[13px] text-muted-2">
            <span>No name recorded</span>
            <span className="ml-auto tabular-nums">{unnamed}</span>
          </li>
        )}
      </ul>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        These are the names the hub put on the texts, not proof of who typed them. If somebody here did not send
        that many, the sender is being recorded wrong and the audit would be coaching them on words that were not
        theirs. The name to watch is Jordan: the OpenPhone key sends as him, so a message anyone composes in the
        hub can come back with his name on it. If that count climbs while the people actually on the line stay
        flat, say so and it gets fixed before any note goes out.
      </p>
    </div>
  );
}

/** A signed-in colleague who is not coached. Says nothing about who is. */
function NothingForYou() {
  return (
    <div>
      <PageHeader eyebrow="Your comms" title="Coaching" />
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
        <Section icon={MessageSquareHeart} title="Nothing here for you">
          <p className="text-sm leading-relaxed text-muted">
            This page holds end-of-day notes on the texts we send clients, and it only ever shows a note to the
            person it was written about. There is nothing set up for you, so there is nothing to read. If you
            would like notes on your own messages, ask Jordan and he can switch them on for you.
          </p>
        </Section>
      </div>
    </div>
  );
}

export default async function CoachingPage() {
  const user = await getCurrentUser().catch(() => null);
  // Fail CLOSED on a null user under enforcement: a stale JWT whose AppUser was
  // disabled still passes middleware (it only checks the token), and this page
  // shows one named employee's performance.
  if (!user && authEnforced()) redirect("/login?next=/coaching");
  const isOwner = user ? user.role === "OWNER" : !authEnforced();

  // The settings row decides who may read this page at all, so a failed read is
  // a refusal to render anybody's notes rather than a guess in either direction.
  const settings: CommsCoachingSettings | null = await commsCoachingSettings().catch(() => null);

  if (!isOwner) {
    if (!settings) {
      return (
        <div>
          <PageHeader eyebrow="Your comms" title="Coaching" />
          <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
            <CouldNotLoad what="Your coaching notes" />
          </div>
        </div>
      );
    }
    const myId = await teamMemberIdForLogin(user).catch(() => null);
    if (!myId || !settings.teamMemberIds.includes(myId)) {
      // NO DEAD DOOR (review, Sep 21 2026). The nav entry rides the `review`
      // PageKey, so every admin sees "Comms coaching" in the menu whether or not
      // they are coached — James today. Bouncing him to Home with no
      // explanation is the silent failure the photographer filter beside that
      // nav item exists to prevent. Anyone who can see the door gets a real
      // answer behind it; anyone who cannot is still sent home, and neither
      // path tells them who IS coached.
      if (user && canAccess(user, "review")) return <NothingForYou />;
      redirect(homeFor(user?.role));
    }

    // Scoped at the QUERY, not filtered after: the key prefix carries their own
    // id, so this read cannot return another person's note.
    const mine = await loadAudits([myId]).catch(() => null);
    const firstName = (user?.name ?? "").split(" ")[0];
    return (
      <div>
        <PageHeader
          eyebrow="Your comms"
          title="Coaching"
          subtitle="What your client messages looked like, and one thing to try next time"
        />
        <div className="mx-auto max-w-2xl space-y-5 px-4 py-5 sm:px-6">
          <Section icon={MessageSquareHeart} title="Your notes">
            {mine === null || mine.failed ? (
              <CouldNotLoad what="Your coaching notes" />
            ) : mine.audits.length === 0 ? (
              <p className="text-sm leading-relaxed text-muted">
                {`Nothing here yet${firstName ? `, ${firstName}` : ""}. A note is written at the end of a day when there are enough messages to say anything useful about. Quiet days are skipped on purpose.`}
              </p>
            ) : (
              <div className="space-y-3">
                {mine.audits.map((a) => (
                  <NoteCard key={`${a.teamMemberId}:${a.dayKey}`} audit={a} />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    );
  }

  // ---- The owner's report --------------------------------------------------
  const rosterIds = settings?.teamMemberIds ?? [];
  const [notes, coverage, roster] = await Promise.all([
    loadAudits(rosterIds).catch(() => null),
    loadCoverage().catch(() => null),
    rosterIds.length
      ? prisma.teamMember
          .findMany({ where: { id: { in: rosterIds } }, select: { id: true, name: true } })
          .catch(() => null)
      : Promise.resolve([]),
  ]);

  const audits = notes?.audits ?? [];
  const notesBroken = notes === null || notes.failed;
  const rosterSet = new Set(rosterIds);

  // The freshest day we have per person — the "what happened today" answer,
  // which on the morning after an audit IS yesterday's note. loadAudits hands
  // them back newest day first, so the first one wins.
  const latestPerPerson = new Map<string, CoachingAudit>();
  for (const a of audits) if (!latestPerPerson.has(a.teamMemberId)) latestPerPerson.set(a.teamMemberId, a);

  // Per-person shape of the last stretch: enough to see a direction without
  // reading every note. Counts, not a score — nobody asked for a score, and a
  // number out of ten is the fastest way to make this adversarial.
  const trend = rosterIds.map((id) => {
    const theirs = audits.filter((a) => a.teamMemberId === id);
    return {
      id,
      name: roster?.find((r) => r.id === id)?.name ?? theirs[0]?.personName ?? null,
      days: theirs.length,
      clean: theirs.filter((a) => a.suggestions.length === 0).length,
      read: theirs.reduce((sum, a) => sum + a.messagesAnalysed, 0),
      sent: theirs.filter((a) => a.sent).length,
      week: coverage?.weekBySender.find((s) => s.id === id)?.count ?? 0,
    };
  });

  const nobodyPicked = settings ? settings.teamMemberIds.length === 0 : false;

  return (
    <div>
      <PageHeader
        eyebrow="Quality desk"
        title="Comms coaching"
        subtitle="What the office said to clients, what the end-of-day audit made of it, and whether anything needs you"
        actions={
          <Link
            href="/settings#coaching"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:border-brand/40"
          >
            Rules <ArrowRight className="size-3.5" />
          </Link>
        }
      />

      <div className="mx-auto max-w-3xl space-y-5 px-4 py-5 pb-16 sm:px-6">
        <Section
          icon={MessageSquareHeart}
          title="The latest note"
          count={latestPerPerson.size || undefined}
          action={
            settings && !settings.sendEnabled && latestPerPerson.size > 0 ? (
              <span className="text-[11px] text-muted-2">nothing is being sent &mdash; you see these first</span>
            ) : undefined
          }
        >
          {!settings ? (
            <CouldNotLoad what="The coaching rules" />
          ) : notesBroken ? (
            <CouldNotLoad what="The coaching notes" />
          ) : nobodyPicked ? (
            <p className="text-sm leading-relaxed text-muted">
              Nobody is on the coached roster, so nothing is being read or written.{" "}
              <Link href="/settings#coaching" className="font-semibold text-brand hover:underline">
                Pick who this is about
              </Link>{" "}
              {`and the first note lands after the evening run at ${COMMS_COACHING_ET_HOUR}:00 ET.`}
            </p>
          ) : latestPerPerson.size === 0 ? (
            <p className="text-sm leading-relaxed text-muted">
              Nothing to show yet. This is not a verdict on anybody&rsquo;s week. The audit only reads messages it
              can put a name to, and {whyNothingYet(coverage)}. A day with too few attributable messages is
              skipped rather than judged.
            </p>
          ) : (
            <div className="space-y-3">
              {Array.from(latestPerPerson.values()).map((a) => (
                <NoteCard key={`latest:${a.teamMemberId}:${a.dayKey}`} audit={a} showPerson showDelivery />
              ))}
            </div>
          )}
        </Section>

        <Section icon={Radar} title="What the audit can actually see">
          {coverage === null ? (
            <CouldNotLoad what="The message counts" />
          ) : coverage.internalUnknown ? (
            /* WITHOUT THE ROSTER THERE IS NO SPLIT. Every tile on this card
               divides what went out into client work and internal chatter, and
               that division is the whole point of it: 272 of 498 outbound texts
               in 30 days went to our own team. With the roster unreadable every
               one of those would land in the client column and the tiles would
               read high and wrong, on the single question the card exists to
               answer. The engine refuses to coach in this state; this refuses to
               count, and says which it is. */
            <CouldNotLoad what="Which numbers are ours, so the client and internal split cannot be worked out. No coaching runs in this state either." />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <CoverageTile window={coverage.today} label="client texts today we can name" />
                <CoverageTile window={coverage.week} label="in the last 7 days" />
              </div>
              <NotCoached week={coverage.week} />
              <SenderSplit coverage={coverage} roster={rosterSet} />
              <p className="text-[13px] leading-relaxed text-muted">
                {coverage.firstAttributed ? (
                  <>
                    The hub started recording who sent each text on{" "}
                    <b>{etDateYear(coverage.firstAttributed)}</b>. Anything older is logged only as
                    &ldquo;Us&rdquo; and is left out rather than guessed at.
                  </>
                ) : (
                  <>
                    No outbound text carries a sender yet. Until OpenPhone has delivered a message through the
                    webhook since the change went in, every day here will read as nothing to show &mdash; which
                    is the truth, not a quiet week.
                  </>
                )}{" "}
                Automatic texts (confirmations, delivery notes, upload chasers) are never counted anywhere on this
                card or coached on: they are the hub&rsquo;s words, not anyone&rsquo;s.
                {coverage.capped && (
                  <>
                    {" "}
                    This week held more messages than this page reads in one go, so the split is off the most
                    recent {ROW_CAP}. Today&rsquo;s number is unaffected.
                  </>
                )}
              </p>
            </div>
          )}
        </Section>

        <Section icon={CalendarCheck} title="How it has been going">
          {!settings || notesBroken ? (
            <CouldNotLoad what="The trend" />
          ) : trend.length === 0 ? (
            <p className="text-sm text-muted">Nobody on the roster, so there is nothing to trend.</p>
          ) : (
            <div className="space-y-2.5">
              {trend.map((t) => (
                <div key={t.id} className="rounded-xl border border-border bg-surface-2/40 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold">{t.name ?? "Someone no longer on the team"}</span>
                    {/* Says exactly what it counts. It used to read
                        "attributable messages", which sat next to the note
                        counts and read as "messages the audit judged" — but it
                        is every text from the line carrying this name, client
                        work and internal together, and better than half of the
                        line is internal (measured Sep 21 2026). A number that
                        does not say which of the two it is turns a week of
                        office chatter into an apparent coaching failure. */}
                    <span className="text-[11px] text-muted-2">
                      {`${t.week} text${t.week === 1 ? "" : "s"} from the line carry their name this week`}
                    </span>
                  </div>
                  {t.days === 0 ? (
                    <p className="mt-1 text-[13px] text-muted">
                      No day has had enough attributable messages to write a note yet.
                    </p>
                  ) : (
                    <p className="mt-1 text-[13px] text-muted">
                      {`${t.days} day${t.days === 1 ? "" : "s"} audited · ${t.clean} read fine as-is · ` +
                        `${t.read} message${t.read === 1 ? "" : "s"} read · ` +
                        `${t.sent} note${t.sent === 1 ? "" : "s"} sent to them`}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* The wall of detail, folded away. He said he does not have time to
            track this; the summary above is the page, and this is here for the
            day he wants to read a run of days straight through.
            It says "for the people on the roster" and means it: the notes are
            now read one person at a time off the roster, so a note written for
            somebody since taken off it stays on file (nothing is deleted) but
            stops appearing here. Claiming "every note on file" would be the
            easier label and the false one. */}
        {audits.length > 0 && (
          <details className="rounded-2xl border bg-surface">
            <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold">
              {`Every note on file for the people on the roster (${audits.length})`}
            </summary>
            <div className="space-y-3 border-t px-5 py-4">
              {audits.map((a) => (
                <NoteCard key={`all:${a.teamMemberId}:${a.dayKey}`} audit={a} showPerson showDelivery />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
