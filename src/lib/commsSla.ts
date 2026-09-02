import "server-only";
import { prisma } from "@/lib/prisma";
import { unansweredComms, type WaitingFamily } from "@/lib/replyQueue";
import { notifyInApp, notifyUrgent, opsAlert } from "@/lib/notify";

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

// First-tier pings only fire 8:00–19:00 ET — a 2am text shouldn't page anyone
// at 2:05am. It escalates the moment business hours open (the dedupe key is
// per-message, so the 8:00 sweep fires whichever tiers its age has crossed).
function withinBusinessHours(now: Date = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(now),
  );
  return hour >= 8 && hour < 19;
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
  snippet: string;
  /** the OLDEST message still owed an answer — the true start of the wait */
  occurredAt: Date;
  ageMin: number;
  isVip: boolean;
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
  return threads
    .map((t) => {
      const oldest = t.pending[0];
      return {
        clientId: t.clientId as string,
        clientName: t.displayName || t.clientName || "Unknown client",
        // The channel is part of the truth: "Erica Walker waiting 42h" reads
        // very differently once you know it's an email, and Ops Day renders
        // this snippet as the whole row.
        snippet: (t.family === "email" ? "Email: " : "") + snippetOf(oldest?.subject || oldest?.body || ""),
        occurredAt: t.waitingSince,
        ageMin: Math.max(0, Math.floor((now.getTime() - t.waitingSince.getTime()) / 60_000)),
        isVip: t.isVip,
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
    const inHours = withinBusinessHours(now);

    for (const w of waiting) {
      const iso = w.occurredAt.toISOString();
      const tier1Key = `sla-1-${w.clientId}-${iso}`;
      const tier2Key = `sla-2-${w.clientId}-${iso}`;
      const age = fmtAge(w.ageMin);
      const vipTag = w.isVip ? " (VIP)" : "";
      const title = `${w.clientName} waiting ${age} — "${w.snippet.slice(0, 45)}"`; // notifyInApp caps at 90
      const href = `/clients/${w.clientId}`; // client page hosts the comms thread (ClientChat)

      // --- Tier 1: bell → ADMIN + one Slack line. Business-hours gated. ---
      if (w.ageMin > (w.isVip ? TIER1_MIN_VIP : TIER1_MIN) && inHours && !(await alreadySent(tier1Key))) {
        await notifyInApp({
          kind: "reply_sla",
          title,
          body: `Inbound text has no reply yet. Tap to answer.`,
          href,
          targets: [{ roles: ["ADMIN"] }],
          dedupeKey: tier1Key,
        });
        await opsAlert(`💬 Unanswered text${vipTag} — ${w.clientName} waiting ${age}: "${w.snippet}"`);
        counts.tier1++;
      }

      // --- Tier 2: ALSO bell → OWNER + urgent Slack. Not hours-gated per se,
      // but it never LEADS overnight: it fires after-hours only when tier 1
      // already went out during business hours (so an 18:30 tier-1 still
      // escalates at 20:30, while a 2am text stays quiet until 8:00, then
      // jumps straight to both tiers). ---
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

