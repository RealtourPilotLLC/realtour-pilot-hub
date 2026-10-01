import "server-only";
import { prisma } from "@/lib/prisma";
import { unansweredComms, type WaitingFamily } from "@/lib/replyQueue";
import { notifyInApp, notifyStaffSms, notifyUrgent, opsAlert } from "@/lib/notify";
import { coverageRules, coveredHoursBetween, withinCoverageAt } from "@/lib/coverage";
import { hasStrongComplaint } from "@/lib/comms";
import { getSetting, putSetting } from "@/lib/settings";

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
  opts: { families?: WaitingFamily[]; windowDays?: number; excludeClientIds?: string[] } = {},
): Promise<UnansweredInbound[]> {
  const threads = await unansweredComms({
    now,
    families: opts.families,
    windowDays: opts.windowDays,
    excludeClientIds: opts.excludeClientIds,
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
export async function sweepReplySla(): Promise<{ checked: number; tier1: number; tier2: number; email: EmailSlaCounts }> {
  const counts = { checked: 0, tier1: 0, tier2: 0, email: { ...NO_EMAIL_COUNTS } };
  try {
    const now = new Date();
    // One read of the rota per sweep, not per client — this runs every five
    // minutes and the answer cannot change inside one pass.
    const cover = await coverageRules();
    const inHours = withinCoverageAt(now, cover);
    const onCall = cover.onCallTeamMemberId;
    // PHONE ONLY, 7 days — the pager's scope, deliberately narrower than the
    // pill's. Every message it wakes someone about is one a person can act on
    // in the next few minutes. Unanswered EMAIL has its own, quieter lane below
    // (Sep 26 2026): bell only, covered hours only, and never a backlog.
    const waiting = await findUnansweredInbound(now, { families: ["phone"], windowDays: SCAN_DAYS });
    counts.checked = waiting.length;
    // WHOSE IT IS (§9, Sep 26): the open reply task's owner — Kyle, as a rule.
    const owners = await replyOwners(waiting.map((w) => w.clientId), "phone");

    for (const w of waiting) {
      const iso = w.occurredAt.toISOString();
      const tier1Key = `sla-1-${w.clientId}-${iso}`;
      const tier2Key = `sla-2-${w.clientId}-${iso}`;
      const age = fmtAge(w.ageMin);
      const vipTag = w.isVip ? " (VIP)" : "";
      const title = `${w.clientName} waiting ${age} — "${w.snippet.slice(0, 45)}"`; // notifyInApp caps at 90
      const href = `/clients/${w.clientId}`; // client page hosts the comms thread (ClientChat)
      const owner = owners.get(w.clientId) ?? null;

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
          // The ADMIN row is the informational copy; it names whose reply it
          // is, so nobody reads a broadcast as "someone should" (§9).
          body: owner ? `Inbound text has no reply yet — ${owner.name}'s to answer. Tap to answer.` : `Inbound text has no reply yet. Tap to answer.`,
          href,
          // Index 0 stays the ADMIN broadcast: it is the ledger alreadySent()
          // reads. The owner gets a row of their own only when their login
          // cannot see ADMIN broadcasts — Kyle can, and two rows for one page
          // would ring him twice.
          targets: [{ roles: ["ADMIN"] }, ...(owner && !owner.seesAdminBroadcasts ? [{ roles: ["ADMIN" as const], userKey: `tm:${owner.teamMemberId}` }] : [])],
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
  // Its own try: a failure in one lane must not silence the other.
  try {
    counts.email = await sweepEmailSla(new Date());
  } catch (e) {
    console.warn("sweepEmailSla failed", e);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// UNANSWERED CLIENT EMAIL (O06 / AU-07, Sep 26 2026).
//
// Email was always COUNTED and LISTED — the Ops pill, /tasks?tab=comms&via=email
// — but nothing ever rang for it: the pager above reads phone only, and the
// comment that stood here said widening it was "the one line to change if
// Jordan wants email escalating too". He does, on his own terms, and they are
// not the phone pager's, so this is a lane of its own on the same walk:
//
//   "Bell only — no texts or Slack DMs; counting covered hours only (Mon–Fri
//    9–6 ET); Kyle's bell after 4 covered hours unanswered, Jordan's after 9;
//    a client flagged unhappy escalates at 4; never nights or weekends."
//
//   · BELL ONLY. kind `reply_sla_email` is absent from notifyPrefs'
//     KIND_TO_EVENT, so the channel bridge writes the bell row and nothing
//     else — no Slack DM, no text, whatever anyone's matrix says — and no ops
//     Slack line goes out from here either.
//   · COVERED HOURS. The age is coveredHoursBetween(waiting since, now) on the
//     Settings → Coverage rota: an email at Fri 5:30pm has waited half an hour
//     by Monday 9am, not sixty-four.
//   · NEVER NIGHTS OR WEEKENDS. It only rings while cover is on — urgency does
//     not change that, the way it does for a text.
//   · KYLE'S BELL is the open reply task's owner (Kyle mints them), else Kyle
//     off the roster, else the ADMIN broadcast. JORDAN'S is the OWNER bell.
//     Unhappy (comms.hasStrongComplaint, the same test the text pager uses)
//     rings both at the earlier line.
//   · NO BACKLOG. The day this is switched on, every email already waiting
//     would fire its tiers at once. `email_sla_since` is the watermark: only a
//     wait that began after it can ring. It is written by the first sweep that
//     finds the lane on and cleared by the first that finds it off, so turning
//     it off and on again starts clean.
//   · IDEMPOTENT the same way the phone pager is: the bell row at index 0 IS the
//     ledger (alreadySent), keyed on the client and the wait's start, so three
//     sweeps — or one email that landed in both info@ and hello@, which the
//     walk shows once — make one row per tier.
//
// The rules live in their own AppSetting (`email_sla`), not inside the
// internal-alerts row, so a stale Settings tab saving that card cannot put an
// old copy of this one back (the per-person-key reasoning Jordan asked for on
// the notification schedule).
// ---------------------------------------------------------------------------

export type EmailSlaRules = {
  enabled: boolean;
  /** Kyle's bell after this many covered hours unanswered. */
  kyleCoveredHours: number;
  /** Jordan's bell after this many. */
  ownerCoveredHours: number;
  /** An unhappy client reaches Jordan at this many instead. */
  unhappyCoveredHours: number;
};

/** Jordan's numbers (Sep 25–26). ON: he answered the question the switch was
 *  waiting on. */
export const DEFAULT_EMAIL_SLA: EmailSlaRules = { enabled: true, kyleCoveredHours: 4, ownerCoveredHours: 9, unhappyCoveredHours: 4 };
export const EMAIL_SLA_KEY = "email_sla";
export const EMAIL_SLA_SINCE_KEY = "email_sla_since";
/** A week of Mon–Fri 9–6 cover; past it an email is an audit problem, not a bell. */
export const EMAIL_SLA_MAX_HOURS = 45;

export function normaliseEmailSla(raw: Partial<EmailSlaRules> | null | undefined): EmailSlaRules {
  const d = DEFAULT_EMAIL_SLA;
  const hrs = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= EMAIL_SLA_MAX_HOURS ? Math.round(v * 2) / 2 : fallback;
  const kyle = hrs(raw?.kyleCoveredHours, d.kyleCoveredHours);
  const owner = hrs(raw?.ownerCoveredHours, d.ownerCoveredHours);
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : d.enabled,
    kyleCoveredHours: kyle,
    // Jordan hears about it AFTER Kyle, never before: an inverted pair reads as
    // the default rather than as an escalation that skips the person who owns it.
    ownerCoveredHours: owner >= kyle ? owner : Math.max(kyle, d.ownerCoveredHours),
    unhappyCoveredHours: hrs(raw?.unhappyCoveredHours, d.unhappyCoveredHours),
  };
}

export async function emailSlaRules(): Promise<EmailSlaRules> {
  return normaliseEmailSla(await getSetting<Partial<EmailSlaRules>>(EMAIL_SLA_KEY, DEFAULT_EMAIL_SLA));
}

export async function saveEmailSlaRules(input: Partial<EmailSlaRules>, updatedBy: string | null): Promise<EmailSlaRules> {
  const before = await emailSlaRules();
  const next = normaliseEmailSla({ ...before, ...input });
  await putSetting(EMAIL_SLA_KEY, next, updatedBy);
  // Turning it on starts a fresh watermark; turning it off clears it (the
  // sweep would do both within five minutes — this makes it immediate).
  if (next.enabled && !before.enabled) await putSetting(EMAIL_SLA_SINCE_KEY, { since: new Date().toISOString() }, updatedBy);
  if (!next.enabled) await prisma.appSetting.deleteMany({ where: { key: EMAIL_SLA_SINCE_KEY } }).catch(() => {});
  return next;
}

/** The backlog watermark: when this lane started ringing. Written once, by the
 *  first sweep (or save) that finds it on. Null = off. */
export async function emailSlaSince(rules: EmailSlaRules, now: Date): Promise<Date | null> {
  if (!rules.enabled) {
    // Read first: this runs every five minutes, and an off switch should cost
    // a lookup, not a write.
    const had = await prisma.appSetting.findUnique({ where: { key: EMAIL_SLA_SINCE_KEY }, select: { key: true } }).catch(() => null);
    if (had) await prisma.appSetting.deleteMany({ where: { key: EMAIL_SLA_SINCE_KEY } }).catch(() => {});
    return null;
  }
  const read = async () => {
    const row = await prisma.appSetting.findUnique({ where: { key: EMAIL_SLA_SINCE_KEY }, select: { value: true } });
    if (!row) return null;
    try {
      const at = new Date((JSON.parse(row.value) as { since?: string }).since ?? "");
      return isNaN(at.getTime()) ? null : at;
    } catch {
      return null;
    }
  };
  const have = await read();
  if (have) return have;
  // skipDuplicates: two overlapping sweeps must agree on ONE watermark.
  await prisma.appSetting.createMany({ data: [{ key: EMAIL_SLA_SINCE_KEY, value: JSON.stringify({ since: now.toISOString() }) }], skipDuplicates: true });
  return (await read()) ?? now;
}

export type EmailSlaCounts = { enabled: boolean; checked: number; eligible: number; tier1: number; tier2: number; inHours: boolean };
const NO_EMAIL_COUNTS: EmailSlaCounts = { enabled: false, checked: 0, eligible: 0, tier1: 0, tier2: 0, inHours: false };

/** The email lane (see the block above). Exported for the acceptance drill;
 *  the cron reaches it through sweepReplySla. */
export async function sweepEmailSla(now: Date = new Date()): Promise<EmailSlaCounts> {
  const rules = await emailSlaRules();
  const since = await emailSlaSince(rules, now);
  if (!rules.enabled || !since) return { ...NO_EMAIL_COUNTS };
  const cover = await coverageRules();
  const inHours = withinCoverageAt(now, cover);
  const counts: EmailSlaCounts = { enabled: true, checked: 0, eligible: 0, tier1: 0, tier2: 0, inHours };
  // Never nights or weekends: nothing is even read out of cover.
  if (!inHours) return counts;
  const waiting = await findUnansweredInbound(now, { families: ["email"], windowDays: SCAN_DAYS });
  counts.checked = waiting.length;
  // The watermark: a wait that began before the lane was switched on is the
  // backlog, and the backlog is listed, never rung.
  const fresh = waiting.filter((w) => w.occurredAt.getTime() >= since.getTime());
  counts.eligible = fresh.length;
  if (!fresh.length) return counts;
  const owners = await replyOwners(fresh.map((w) => w.clientId), "email");
  const kyle = await kyleMember();

  for (const w of fresh) {
    const covered = coveredHoursBetween(w.occurredAt, now, cover);
    const iso = w.occurredAt.toISOString();
    const e1 = `sla-e1-${w.clientId}-${iso}`;
    const e2 = `sla-e2-${w.clientId}-${iso}`;
    const age = fmtCovered(covered);
    const subject = w.snippet.replace(/^Email:\s*/, "");
    const title = `${w.clientName} — email waiting ${age} — "${subject.slice(0, 40)}"`;
    const href = `/clients/${w.clientId}`; // the client page carries the email thread and its Draft reply
    const owner = owners.get(w.clientId) ?? (kyle ? { teamMemberId: kyle.id, name: kyle.name, seesAdminBroadcasts: true } : null);

    if (covered >= rules.kyleCoveredHours && !(await alreadySent(e1))) {
      await notifyInApp({
        kind: "reply_sla_email",
        title,
        body: `No reply after ${age} of covered time. It is on Tasks → Comms → Email.`,
        href,
        // Kyle's own bell, by name — not an ADMIN broadcast (Jordan: "Kyle's
        // bell"). Nobody to name → the office, rather than nobody.
        targets: owner ? [{ roles: ["ADMIN"], userKey: `tm:${owner.teamMemberId}` }] : [{ roles: ["ADMIN"] }],
        dedupeKey: e1,
      });
      counts.tier1++;
    }
    const ownerLine = w.unhappy ? Math.min(rules.unhappyCoveredHours, rules.ownerCoveredHours) : rules.ownerCoveredHours;
    if (covered >= ownerLine && !(await alreadySent(e2))) {
      await notifyInApp({
        kind: "reply_sla_email",
        title,
        body: w.unhappy
          ? `An unhappy client's email has had no reply for ${age} of covered time.`
          : `Still no reply after ${age} of covered time. Escalated to you.`,
        href,
        targets: [{ roles: ["OWNER"] }],
        dedupeKey: e2,
      });
      counts.tier2++;
    }
  }
  return counts;
}

function fmtCovered(h: number): string {
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  if (whole === 0) return `${min}m`;
  return min ? `${whole}h ${min}m` : `${whole}h`;
}

type ReplyOwner = { teamMemberId: string; name: string; seesAdminBroadcasts: boolean };

/** Who owns each client's open reply task — the §9 "one owner" for a page.
 *  One read for the whole sweep. Prefers the task filed from the same family
 *  (a Gmail task for an email wait, an OpenPhone one for a text); a client
 *  with no owned task is simply absent. */
async function replyOwners(clientIds: string[], family: "phone" | "email"): Promise<Map<string, ReplyOwner>> {
  const out = new Map<string, ReplyOwner>();
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const tasks = await prisma.smartTask.findMany({
      where: { clientId: { in: ids }, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] }, ownerId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { clientId: true, source: true, ownerId: true, owner: { select: { name: true, active: true } } },
    });
    const logins = await prisma.appUser.findMany({
      where: { teamMemberId: { in: [...new Set(tasks.map((t) => t.ownerId as string))] }, status: "ACTIVE" },
      select: { teamMemberId: true, role: true },
    });
    const seesAdmin = new Set(logins.filter((l) => l.role === "ADMIN" || l.role === "OWNER").map((l) => l.teamMemberId));
    const sameFamily = (src: string) => (family === "email" ? src === "gmail" : src !== "gmail");
    for (const pass of [true, false]) {
      for (const t of tasks) {
        if (!t.clientId || !t.ownerId || !t.owner?.active || out.has(t.clientId)) continue;
        if (pass && !sameFamily(t.source)) continue;
        out.set(t.clientId, { teamMemberId: t.ownerId, name: t.owner.name, seesAdminBroadcasts: seesAdmin.has(t.ownerId) });
      }
    }
  } catch (e) {
    console.warn("reply owners lookup failed (the office gets the page)", e);
  }
  return out;
}

async function kyleMember(): Promise<{ id: string; name: string } | null> {
  return prisma.teamMember
    .findFirst({ where: { name: { contains: "Kyle", mode: "insensitive" }, active: true }, select: { id: true, name: true } })
    .catch(() => null);
}
