import "server-only";
import { prisma } from "@/lib/prisma";
import { classifyComm, isReaction } from "@/lib/comms";
import { notifyInApp, notifyUrgent, opsAlert } from "@/lib/notify";

// ---------------------------------------------------------------------------
// Reply-SLA escalation for inbound client texts.
//
// The task engine already files a reply task for every inbound text — but a
// task nobody opens is a task nobody answers. A 60-day audit found 13 client
// texts that NEVER got a reply, one of them a "call me quick... Help!!" that
// sat unanswered for 12 days. Nothing in the system escalated any of them.
//
// This module is that escalation. Every 5 minutes (the comms cron) it finds
// clients whose LATEST inbound text has no outbound text after it and pings in
// two tiers:
//   tier 1  >30 min waiting (VIP >15)  → bell to ADMIN + one Slack line
//   tier 2  >2 h waiting   (VIP >1 h)  → ALSO bell to OWNER + urgent Slack
// Dedupe keys make each tier fire exactly once per inbound message, so the
// sweep can run forever without spam; replying (any outbound text to that
// client) naturally clears them from the next sweep.
// ---------------------------------------------------------------------------

// -- No-reply-needed filters -------------------------------------------------
// isReaction comes straight from src/lib/comms.ts ("Liked …" / emoji-only —
// the same filter that suppresses their reply tasks). PRAISE_RE mirrors the
// unexported PRAISE_ONLY regex in src/lib/comms.ts — keep the two in sync.
const PRAISE_RE = /\b(thank|thanks|thx|love|great|perfect|awesome|amazing|looks good|beautiful|gorgeous)\b/i;

// A short, appreciative message with no question in it ("Thank you!!",
// "These look amazing") closes a thread — it doesn't open one.
function isPraiseOnly(text: string): boolean {
  const t = (text || "").trim();
  return t.length <= 120 && PRAISE_RE.test(t) && !t.includes("?");
}

// Conversation-closing acknowledgments ("Will do", "Yup.", "You're the man.",
// "All good homey 🙏"). A prod probe showed these dominate the "unanswered"
// list — without this filter the go-live sweep would page the owner over five
// closers and zero real waits. Two shapes, both vetoed by a question mark:
//  a) the WHOLE message (emoji/punctuation stripped) is a closer token, or
//  b) a short message contains an unambiguous closing phrase AND doesn't read
//     as a change request (classifyComm — the same classifier comms.ts uses).
const ACK_EXACT_RE =
  /^(ok(ay)?|k|kk|yes|yep|yup|yeah|no|nope|sure|cool|nice|done|perfect|will do|got it|all good|all set|sounds (good|great)|no problem|no worries|anytime|(you'?re )?welcome|see you (then|there|soon)|let'?s go|you'?re the (man|best))$/i;
const ACK_PHRASE_RE =
  /\b(will do|sounds (good|great)|no (problem|worries)|all good|all set|you'?re the (man|best)|looking forward to|see you (then|there|soon)|good luck|have a (good|great))\b/i;
function isAckOnly(text: string): boolean {
  const raw = (text || "").trim();
  if (raw.includes("?")) return false;
  const norm = raw.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (ACK_EXACT_RE.test(norm)) return true;
  return raw.length <= 80 && ACK_PHRASE_RE.test(raw) && !classifyComm(raw).isRevision;
}

// Call-log artifacts a backfill wrote into the text channel ("incoming call
// (recording.completed).") — machine breadcrumbs, not a client waiting.
const CALL_ARTIFACT_RE = /^(incoming|outgoing|missed) call\b/i;

function needsReply(text: string): boolean {
  return !isReaction(text) && !isPraiseOnly(text) && !isAckOnly(text) && !CALL_ARTIFACT_RE.test((text || "").trim());
}

// -- Tunables ----------------------------------------------------------------
const SCAN_DAYS = 7; // bound the sweep; anything older is an audit problem, not a live page
const TIER1_MIN = 30;
const TIER1_MIN_VIP = 15;
const TIER2_MIN = 120;
const TIER2_MIN_VIP = 60;
// Top-tier clients get the faster clock. Same pair queries.ts treats as
// top-of-book ("vip" is $20k+, "heavy" $5k–$20k — see src/lib/segments.ts).
const VIP_SEGMENTS = new Set(["vip", "heavy"]);

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
  occurredAt: Date;
  ageMin: number;
  isVip: boolean;
};

// Per client: the LATEST inbound text with no outbound text after it.
// One indexed scan (occurredAt >= cutoff) + in-memory pairing — the text
// volume is ~2k rows / 60 days, so a 7-day window is trivially small.
export async function findUnansweredInbound(now: Date = new Date()): Promise<UnansweredInbound[]> {
  const since = new Date(now.getTime() - SCAN_DAYS * 86_400_000);
  // Both directions in one pull: any outbound AFTER an in-window inbound is
  // itself in-window, so the single cutoff can't miss the answering text.
  const rows = await prisma.commLog.findMany({
    // Calls count too: an ANSWERED outbound call is an answer — Jordan kept
    // getting "client still unanswered" pages two hours after handling it by
    // phone (audit). A missed/unanswered outgoing call clears nothing.
    where: { channel: { in: ["text", "call"] }, occurredAt: { gte: since }, clientId: { not: null } },
    orderBy: { occurredAt: "asc" },
    select: { clientId: true, clientName: true, channel: true, direction: true, body: true, occurredAt: true },
  });

  // Walk in time order: an inbound that needs a reply becomes the client's
  // pending message (newer inbounds replace it — LATEST wins); any outbound
  // to that client clears it. Reactions/praise neither open nor clear.
  const pending = new Map<string, { clientName: string | null; body: string; occurredAt: Date }>();
  for (const r of rows) {
    const cid = r.clientId as string;
    if (r.direction === "out") {
      if (r.channel === "call" && /missed|no answer|unanswered/i.test(r.body ?? "")) continue;
      pending.delete(cid);
    } else if (r.channel === "text" && needsReply(r.body)) {
      pending.set(cid, { clientName: r.clientName, body: r.body, occurredAt: r.occurredAt });
    }
  }
  if (pending.size === 0) return [];

  // A HUMAN JUDGMENT also counts: a client_reply task completed AFTER the
  // pending inbound means someone dealt with it (answered on a personal phone,
  // decided no reply was needed). The pager must respect that (audit).
  const handled = await prisma.smartTask.findMany({
    where: {
      clientId: { in: [...pending.keys()] },
      taskType: "client_reply",
      status: "COMPLETED",
      completedAt: { gte: since },
    },
    select: { clientId: true, completedAt: true },
  });
  for (const h of handled) {
    const pnd = h.clientId ? pending.get(h.clientId) : null;
    if (pnd && h.completedAt && h.completedAt > pnd.occurredAt) pending.delete(h.clientId!);
  }
  if (pending.size === 0) return [];

  // VIP lookup — a folded assistant (parentClientId) texts with the agent's
  // urgency, so the parent's segment counts too (see comms-routing folding).
  const clients = await prisma.client.findMany({
    where: { id: { in: [...pending.keys()] } },
    select: { id: true, name: true, segment: true, parent: { select: { segment: true } } },
  });
  const byId = new Map(clients.map((c) => [c.id, c]));

  const out: UnansweredInbound[] = [];
  for (const [clientId, p] of pending) {
    const c = byId.get(clientId);
    out.push({
      clientId,
      clientName: p.clientName || c?.name || "Unknown client",
      snippet: snippetOf(p.body),
      occurredAt: p.occurredAt,
      ageMin: Math.max(0, Math.floor((now.getTime() - p.occurredAt.getTime()) / 60_000)),
      isVip: VIP_SEGMENTS.has(c?.segment ?? "") || VIP_SEGMENTS.has(c?.parent?.segment ?? ""),
    });
  }
  return out.sort((a, b) => b.ageMin - a.ageMin);
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
    const waiting = await findUnansweredInbound(now);
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

// ---------------------------------------------------------------------------
// replyPulse — responsiveness KPIs over a trailing window, using the same
// in/out pairing as the sweep. NOT wired anywhere yet; built for the future
// dashboard/digest. An "episode" is a run of reply-needing inbound texts from
// one client; the first outbound after it answers it (delta measured from the
// LATEST inbound of the run — the same message the sweep would escalate).
// ---------------------------------------------------------------------------
export async function replyPulse(days: number): Promise<{
  medianMin: number;
  p90Min: number;
  under60Pct: number;
  answered: number;
  unanswered: number;
}> {
  const window = Math.min(Math.max(Math.floor(days) || 1, 1), 90);
  const now = Date.now();
  const since = new Date(now - window * 86_400_000);
  const rows = await prisma.commLog.findMany({
    where: { channel: "text", occurredAt: { gte: since }, clientId: { not: null } },
    orderBy: { occurredAt: "asc" },
    select: { clientId: true, direction: true, body: true, occurredAt: true },
  });

  const pending = new Map<string, Date>(); // clientId → latest inbound of the open episode
  const deltas: number[] = []; // reply minutes for answered episodes
  let unanswered = 0;
  for (const r of rows) {
    const cid = r.clientId as string;
    if (r.direction === "out") {
      const inAt = pending.get(cid);
      if (inAt) {
        deltas.push(Math.max(0, (r.occurredAt.getTime() - inAt.getTime()) / 60_000));
        pending.delete(cid);
      }
    } else if (needsReply(r.body)) {
      pending.set(cid, r.occurredAt); // newer inbound refreshes the episode
    }
  }
  unanswered = pending.size;

  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0);
  // under60: answered-within-an-hour over every episode that HAD an hour to be
  // answered (still-open episodes younger than 60 min could yet make it).
  const overdueOpen = [...pending.values()].filter((d) => now - d.getTime() > 3_600_000).length;
  const denom = sorted.length + overdueOpen;
  const under60 = sorted.filter((d) => d <= 60).length;
  return {
    medianMin: Math.round(pct(0.5)),
    p90Min: Math.round(pct(0.9)),
    under60Pct: denom ? Math.round((under60 / denom) * 100) : 100,
    answered: sorted.length,
    unanswered,
  };
}
