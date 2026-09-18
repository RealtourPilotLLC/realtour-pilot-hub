import "server-only";
import { prisma } from "@/lib/prisma";
import { unansweredComms, type WaitingFamily } from "@/lib/replyQueue";
import { notifyInApp, notifyStaffSms, notifyUrgent, opsAlert } from "@/lib/notify";
import { coverageRules, withinCoverageAt } from "@/lib/coverage";
import { hasStrongComplaint } from "@/lib/comms";

// ---------------------------------------------------------------------------
// Reply-SLA escalation for inbound client comms, and the count behind Kyle's
// Ops Day "unanswered clients" pill.
//
// The task engine already files a reply task for every inbound text — but a
// task nobody opens is a task nobody answers. A 60-day audit found 13 client
// texts that NEVER got a reply, one of them a "call me quick... Help!!" that
// sat unanswered for 12 days. Nothing in the system escalated any of them.
//
// This module is that escalation. Every 5 minutes (the comms cron) it finds
// clients with an unanswered inbound and pings in two tiers:
//   tier 1  >30 min waiting (VIP >15)  → bell to ADMIN + one Slack line
//   tier 2  >2 h waiting   (VIP >1 h)  → ALSO bell to OWNER + urgent Slack
// Dedupe keys make each tier fire exactly once per waiting episode, so the
// sweep can run forever without spam; replying (any outbound to that client)
// naturally clears them from the next sweep.
//
// Since Sep 18 2026 both tiers are gated on COVER, not on a bare ET hour (see
// the window note below): out of hours a routine page waits for the next
// covered sweep, and an urgent one also reaches the named on-call.
//
// WHO IS WAITING is not decided here any more — it is one walk over the comms
// log in src/lib/replyQueue.ts (`unansweredComms`), shared with the Dashboard,
// the Replies tab and the /tasks Comms board, so the pill can never again say
// 1 while the Dashboard says 6. Everything in this file is the ESCALATION
// POLICY on top of that walk.
// ---------------------------------------------------------------------------

// -- Tunables ----------------------------------------------------------------
// The PAGER's own window: bound the sweep — anything older is an audit problem,
// not a live page. It matches the shared walk's window today and is kept
// separate on purpose, so widening what the BOARDS reach back to can never
// silently start paging people about three-week-old messages.
const SCAN_DAYS = 7;
const TIER1_MIN = 30;
const TIER1_MIN_VIP = 15;
const TIER2_MIN = 120;
const TIER2_MIN_VIP = 60;

// First-tier pings only fire while somebody is ON — a 2am text shouldn't page
// anyone at 2:05am. It escalates the moment cover opens (the dedupe key is
// per-message, so the first covered sweep fires whichever tiers its age has
// crossed).
//
// UNTIL SEP 18 2026 THAT WINDOW WAS 8:00–19:00 ET AND NOTHING ELSE — no notion
// of a weekday. Replaying the last 90 days of live rows: 196 reply-SLA pages,
// 47 of them on a Saturday or Sunday and another 61 on a weeknight outside
// 9–18. Every one paged whoever happened to hold the ADMIN or OWNER role, on
// the assumption they were available.
//
// The window now comes from Settings → Internal alerts → Coverage (Mon–Fri
// 9:00–18:00 by default) and NOTHING ELSE CHANGES. That is the point: the
// deferral mechanism above is the feature, and swapping the window preserves
// it. No scheduled-alert table, no new rows, no second clock to go wrong — a
// page suppressed on a Sunday is caught by the same sweep that has always
// caught 2am, on Monday morning instead of at 8:00.
//
// The local helper this replaced is gone rather than rewritten: a one-line
// synonym for withinCoverageAt is the second copy that drifts.

/**
 * ROUTINE OR URGENT — decided from what this sweep already knows and stored
 * NOWHERE. A severity column would be a second source of truth to keep in step
 * with the client's segment and the words in the message.
 *
 * Tier 1 is the gentlest ping this hub has ("somebody has been waiting thirty
 * minutes"), so it is routine by definition and waits for cover. Tier 2 means
 * the wait has crossed two hours — one for a VIP — and that is the escalation,
 * so it goes out whatever day it is.
 *
 * VIP/heavy DELIBERATELY does not promote a tier 1, and this is the one call in
 * here that was made on numbers rather than taste. VIP already buys a faster
 * clock (15 minutes instead of 30, one hour instead of two). 54 of the 62
 * out-of-hours tier-1 pages in the last 90 days were VIP or heavy clients, so
 * promoting them would have deferred 8 pages instead of 62 — the weekend would
 * have stayed exactly as loud as Jordan asked us to stop making it, while the
 * settings screen claimed otherwise.
 *
 * A strong complaint ("unacceptable", "really disappointed") is urgent at any
 * tier. Zero pages in the last 90 days took that branch; it is here for the
 * Saturday it finally does, not because it fires often.
 */
function urgencyOf(w: UnansweredInbound, tier: 1 | 2): "routine" | "urgent" {
  return tier === 2 || w.unhappy ? "urgent" : "routine";
}

/**
 * Out of hours, an URGENT page also goes to the person who agreed to take it —
 * a Slack DM, or a text if they have no Slack ID, to the name in Settings →
 * Coverage. It is ON TOP of the ops-channel line that has always gone out, not
 * instead of it: the record of the page is unchanged, this just puts it in
 * front of a named human instead of a role.
 *
 * NOBODY NAMED = nothing extra happens and the alert reaches exactly who it
 * reaches today. Silence is the one outcome an urgent alert must never have,
 * so an unset rota degrades to the old behaviour rather than swallowing it.
 */
async function pageOnCall(onCallId: string | null, line: string): Promise<void> {
  if (!onCallId) return;
  await notifyStaffSms([onCallId], line, "reply_sla", { urgency: "urgent" }).catch((e) =>
    console.warn("on-call page failed (ops alert already went)", e),
  );
}

function fmtAge(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(min / 1440)}d`;
}

function snippetOf(body: string, max = 80): string {
  const t = (body || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export type UnansweredInbound = {
  clientId: string;
  clientName: string;
  clientAvatarUrl: string | null; // the agent's Aryeo headshot — the home card names them by face too
  snippet: string;
  /** the OLDEST message still owed an answer — the true start of the wait */
  occurredAt: Date;
  ageMin: number;
  isVip: boolean;
  /** A complaint in its own right, anywhere in what they are still owed an
   *  answer to (comms.hasStrongComplaint — the same test /quality files an
   *  "unhappy" feedback row from). The pager reads it as urgency; nothing
   *  stores it. */
  unhappy: boolean;
  family: WaitingFamily;
  channel: "text" | "call" | "email";
};

/**
 * Clients with something still owed an answer, oldest wait first.
 *
 * Defaults are the COUNTING scope — phone AND email, the walk's own 21-day
 * window — because this is what Ops Day's pill renders, and the pill links to
 * /tasks?tab=comms where both boards live. Unanswered EMAIL used to appear on
 * no home screen at all; six conversations were sitting there on go-live week.
 * The pager narrows it (see sweepReplySla).
 *
 * The clock starts at the OLDEST message still owed an answer, not the newest.
 * A client who wrote three hours ago and again five minutes ago has been
 * waiting three hours, and it also means the dedupe key stops changing every
 * time they nudge — one page per waiting episode, not one per message.
 */
export async function findUnansweredInbound(
  now: Date = new Date(),
  opts: { families?: WaitingFamily[]; windowDays?: number } = {},
): Promise<UnansweredInbound[]> {
  const threads = await unansweredComms({
    now,
    families: opts.families,
    windowDays: opts.windowDays,
    includeUnmatched: false, // a page needs a client to point at
    includeTeam: false, // "unanswered CLIENTS", not our own photographers
  });
  // One lookup for the headshots (a few dozen ids at most) — the thread
  // engine only carries names, and the home card shows the face beside them.
  const ids = Array.from(new Set(threads.map((t) => t.clientId).filter((id): id is string => Boolean(id))));
  const avatarById = new Map<string, string | null>();
  if (ids.length) {
    const rows = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, avatarUrl: true } });
    for (const r of rows) avatarById.set(r.id, r.avatarUrl);
  }
  return threads
    .map((t) => {
      const oldest = t.pending[0];
      return {
        clientId: t.clientId as string,
        clientName: t.displayName || t.clientName || "Unknown client",
        clientAvatarUrl: avatarById.get(t.clientId as string) ?? null,
        // The channel is part of the truth: "Erica Walker waiting 42h" reads
        // very differently once you know it's an email, and Ops Day renders
        // this snippet as the whole row.
        snippet: (t.family === "email" ? "Email: " : "") + snippetOf(oldest?.subject || oldest?.body || ""),
        occurredAt: t.waitingSince,
        ageMin: Math.max(0, Math.floor((now.getTime() - t.waitingSince.getTime()) / 60_000)),
        isVip: t.isVip,
        // Every message still owed an answer, not just the oldest: a client
        // who asked politely at 9am and lost patience at 4pm is unhappy now.
        // Read off the FULL body — `snippet` is clipped at 80 characters and
        // most complaints do not open with the complaint.
        unhappy: t.pending.some((m) => hasStrongComplaint(m.body || "")),
        family: t.family,
        channel: oldest?.channel ?? "text",
      };
    })
    .sort((a, b) => b.ageMin - a.ageMin);
}

// Has this tier already been announced for this exact inbound message?
// notifyInApp suffixes dedupeKey with the target index ("-0" for our single
// target), so we probe that concrete row. Knowing freshness OURSELVES (rather
// than relying on notifyInApp's silent P2002 skip) is what lets the Slack
// line fire only alongside a brand-new bell row.
async function alreadySent(dedupeKey: string): Promise<boolean> {
  const row = await prisma.notification.findUnique({
    where: { dedupeKey: `${dedupeKey}-0` },
    select: { id: true },
  });
  return !!row;
}

// The every-5-minutes sweep (wired into /api/cron/gmail). NEVER throws —
// a broken escalation must not take down Gmail polling. Returns counts for
// the cron's step log.
export async function sweepReplySla(): Promise<{ checked: number; tier1: number; tier2: number }> {
  const counts = { checked: 0, tier1: 0, tier2: 0 };
  try {
    const now = new Date();
    // PHONE ONLY, 7 days — the pager's scope, deliberately narrower than the
    // pill's. Every message it wakes someone about is one a person can act on
    // in the next few minutes; unanswered email is real (and now counted and
    // listed on Ops Day and /tasks?tab=comms&via=email) but it belongs on a
    // board, not on a 2am bell. Widening this to ["phone","email"] is the one
    // line to change if Jordan wants email escalating too — on the day it
    // flips, every email already waiting fires its tiers at once.
    const waiting = await findUnansweredInbound(now, { families: ["phone"], windowDays: SCAN_DAYS });
    counts.checked = waiting.length;
    if (!waiting.length) return counts;
    // One read of the rota per sweep, not per client — this runs every five
    // minutes and the answer cannot change inside one pass.
    const cover = await coverageRules();
    const inHours = withinCoverageAt(now, cover);
    const onCall = cover.onCallTeamMemberId;

    for (const w of waiting) {
      const iso = w.occurredAt.toISOString();
      const tier1Key = `sla-1-${w.clientId}-${iso}`;
      const tier2Key = `sla-2-${w.clientId}-${iso}`;
      const age = fmtAge(w.ageMin);
      const vipTag = w.isVip ? " (VIP)" : "";
      const title = `${w.clientName} waiting ${age} — "${w.snippet.slice(0, 45)}"`; // notifyInApp caps at 90
      const href = `/clients/${w.clientId}`; // client page hosts the comms thread (ClientChat)

      // --- Tier 1: bell → ADMIN + one Slack line. Coverage gated. ---
      // Gating the HELPER alone would have left this condition firing — the
      // emit path is where the weekday blindness actually cost something, so
      // `inHours` is replaced here and in the tier-2 lead test below, not just
      // in the function it came from.
      const tier1Urgent = urgencyOf(w, 1) === "urgent";
      if (w.ageMin > (w.isVip ? TIER1_MIN_VIP : TIER1_MIN) && (inHours || tier1Urgent) && !(await alreadySent(tier1Key))) {
        await notifyInApp({
          kind: "reply_sla",
          title,
          body: `Inbound text has no reply yet. Tap to answer.`,
          href,
          targets: [{ roles: ["ADMIN"] }],
          dedupeKey: tier1Key,
        });
        await opsAlert(`💬 Unanswered text${vipTag} — ${w.clientName} waiting ${age}: "${w.snippet}"`);
        if (!inHours) await pageOnCall(onCall, `Unhappy client unanswered${vipTag} — ${w.clientName}, ${age}: "${w.snippet}"`);
        counts.tier1++;
      }

      // --- Tier 2: ALSO bell → OWNER + urgent Slack. Not hours-gated per se,
      // but it never LEADS out of cover: it fires then only when tier 1 already
      // went out (so a 17:30 tier-1 still escalates at 19:30, while a Saturday
      // text stays quiet until Monday, then jumps straight to both tiers).
      //
      // That rule is UNCHANGED and now does more work than it used to: a
      // routine tier 1 deferred over a weekend means its tier 2 cannot lead
      // either, which is why 44 of the last 90 days' tier-2 pages go quiet
      // without a single line about tier 2 being added here. ---
      if (w.ageMin > (w.isVip ? TIER2_MIN_VIP : TIER2_MIN)) {
        const tier1Sent = inHours || (await alreadySent(tier1Key));
        if (tier1Sent && !(await alreadySent(tier2Key))) {
          await notifyInApp({
            kind: "reply_sla",
            title,
            body: `Still no reply after ${age}. Escalated to you.`,
            href,
            targets: [{ roles: ["OWNER"] }],
            dedupeKey: tier2Key,
          });
          await notifyUrgent(`Client still unanswered${vipTag} — ${w.clientName}, ${age}: "${w.snippet}"`, href);
          // Tier 2 IS the urgency (see urgencyOf) — out of cover it goes to
          // the named on-call as well as to the ops channel.
          if (!inHours) await pageOnCall(onCall, `Client still unanswered${vipTag} — ${w.clientName}, ${age}: "${w.snippet}"`);
          counts.tier2++;
        }
      }
    }
  } catch (e) {
    // Cron safety: log and move on — the next 5-minute tick retries naturally.
    console.warn("sweepReplySla failed", e);
  }
  return counts;
}

