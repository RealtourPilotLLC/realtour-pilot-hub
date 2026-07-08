import "server-only";
import { prisma } from "@/lib/prisma";
import { slackNotify, slackChannels } from "@/lib/integrations/slack";
import type { Role } from "@/lib/auth/access";

// ---------------------------------------------------------------------------
// Internal operational pings → Slack (never clients). The task engine files
// work into the queue, but nothing ever TOLD anyone — every urgent event waited
// for someone to open the hub. These helpers push a one-line Slack message for
// the handful of events that shouldn't wait (URGENT tasks, new leads, revision
// requests, cron/webhook failures). ALL of it is best-effort: a notify failure
// must never break task creation, a webhook, or a cron run.
// ---------------------------------------------------------------------------

// Kyle's Slack user id — same DM the comms-memory sync reads (slackSync.ts).
// Posting to a user id opens the bot's DM with him.
const KYLE_SLACK_ID = "U07SCBTPDC7";

function appBase(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

// Where alerts go: SLACK_ALERT_CHANNEL env (a channel id or #name) wins; else
// the ops channel the bot is already in (#rp-project-tracker family); else
// Kyle's DM. Cached ~1h so we don't list channels on every ping.
let destCache: { at: number; channel: string } | null = null;
async function alertDestination(): Promise<string> {
  const env = process.env.SLACK_ALERT_CHANNEL;
  if (env) return env;
  if (destCache && Date.now() - destCache.at < 3600_000) return destCache.channel;
  let channel = KYLE_SLACK_ID;
  try {
    const chans = await slackChannels();
    const ops = chans.find((c) => c.is_member && /project-tracker|alert|ops|notif/i.test(c.name));
    if (ops) channel = ops.id;
  } catch {
    /* fall back to Kyle's DM */
  }
  destCache = { at: Date.now(), channel };
  return channel;
}

// Post one internal alert line. Never throws; false = not delivered.
export async function opsAlert(text: string): Promise<boolean> {
  try {
    return await slackNotify(await alertDestination(), text);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-app notifications (the bell). Same philosophy as opsAlert: best-effort,
// NEVER throws — a bell miss must never break a webhook, cron, or task write.
// One Notification row per target: a role broadcast (no userKey) or one person
// ("tm:<teamMemberId>" / "editor:<editorKey>", role still required). Emitters
// dual-write next to their existing Slack ping/task — never instead of it.
// ---------------------------------------------------------------------------

export type { Role };
export type NotifyTarget = { roles: Role[]; userKey?: string; href?: string }; // href overrides the default per row

// ---------------------------------------------------------------------------
// SMS bridge: photographers have no push notifications, so person-addressed
// bell rows for the kinds below ALSO go out as a text via OpenPhone. Rules:
// TEAM MEMBERS ONLY (the recipient's number comes off their TeamMember row,
// never a client contact — the drafts-only policy for client texting is not
// weakened here); title + deep link only, never the body (money-clamp
// philosophy: an SMS is even leakier than the bell); "⚙️ RealTour Hub:" prefix
// so an automated text is never mistaken for Kyle texting from the same
// number; quiet hours 7:00–22:00 ET (the bell row still lands — the text just
// doesn't wake anyone); only fires when the bell row was NEWLY created, so a
// deduped re-announcement can't re-text.
// ---------------------------------------------------------------------------
const SMS_KINDS = new Set(["appointment_change", "order_canceled", "mention", "review_feedback"]);

function withinTextingHours(): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()),
  );
  return hour >= 7 && hour < 22;
}

async function smsPhotographer(teamMemberId: string, title: string, href: string): Promise<void> {
  try {
    if (!withinTextingHours()) return;
    const member = await prisma.teamMember.findUnique({
      where: { id: teamMemberId },
      select: { phone: true },
    });
    const phone = member?.phone?.replace(/[^\d+]/g, "");
    if (!phone) return;
    const { OpenPhone, defaultOpenPhoneNumber, phoneKey } = await import("@/lib/integrations/openphone");
    const from = await defaultOpenPhoneNumber();
    if (!from) return;
    const to = phone.startsWith("+") ? phone : `+1${phoneKey(phone)}`;
    await OpenPhone.sendMessage(from, to, `⚙️ RealTour Hub: ${title}\n${appBase()}${href}`);
  } catch (e) {
    console.warn("smsPhotographer failed", e);
  }
}

export async function notifyInApp(n: {
  kind: string;
  title: string;
  body?: string;
  href: string; // default deep link; a target's href wins for its row
  targets: NotifyTarget[]; // ONE Notification row per target
  dedupeKey?: string; // suffixed "-0","-1",… per target index so multi-target events insert every row
}): Promise<void> {
  try {
    const title = n.title.slice(0, 90);
    for (let i = 0; i < n.targets.length; i++) {
      const t = n.targets[i];
      let roles = t.roles;
      let body = n.body ? n.body.slice(0, 140) : null;
      const href = t.href ?? n.href;
      // Money clamp — the SINGLE enforcement point (not 16 call sites): creatives
      // never see money. Any row that can reach an editor/photographer loses its
      // body; a money destination collapses the row to owner-only.
      if (roles.includes("EDITOR") || roles.includes("PHOTOGRAPHER")) {
        body = null;
        if (href.startsWith("/billing") || href.startsWith("/payouts") || n.kind === "order_paid") {
          roles = ["OWNER"];
          console.warn("notifyInApp money clamp", n.kind);
        }
      }
      try {
        await prisma.notification.create({
          data: {
            kind: n.kind,
            title,
            body,
            href,
            audience: JSON.stringify(roles),
            userKey: t.userKey ?? null,
            dedupeKey: n.dedupeKey ? `${n.dedupeKey}-${i}` : null,
          },
        });
        // Row is NEW (a dedupe hit threw P2002 above) — bridge person-addressed
        // photographer rows to SMS so shoot changes reach the field without push.
        if (SMS_KINDS.has(n.kind) && t.userKey?.startsWith("tm:") && roles.includes("PHOTOGRAPHER")) {
          await smsPhotographer(t.userKey.slice(3), title, href);
        }
      } catch (e) {
        // Unique violation on dedupeKey = this event was already announced —
        // silently skip (recurring events put the changing part IN the key, e.g.
        // a reschedule's new startAt). Anything else is logged but still swallowed.
        if ((e as { code?: string } | null)?.code !== "P2002") {
          console.warn("notifyInApp failed", n.kind, e);
        }
      }
    }
  } catch (e) {
    console.warn("notifyInApp failed", n.kind, e);
  }
}

// Ping the team about a just-created task that shouldn't wait for a hub visit
// (URGENT priority, a new lead, a revision request). Task titles are already
// self-describing ("Revision — 123 Main St", "New lead: …"), so the message is
// the title + a deep link into the queue.
export async function notifyUrgent(taskTitle: string, path: string = "/queue"): Promise<void> {
  await opsAlert(`🔔 ${taskTitle} → ${appBase()}${path}`);
}

// Cheap spike detector for webhook signature rejections: called from a
// receiver's rejection path AFTER it logs the REJECTED row. Counts the last
// hour's rejections for that provider and alerts once as the count crosses the
// threshold (equality check = natural rate limit; a steady rejection stream
// alerts at the crossing, not on every event). Best-effort by design.
const REJECTION_ALERT_THRESHOLD = 6; // "more than 5 in an hour"
export async function alertWebhookRejections(provider: string): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 3600_000);
    const n = await prisma.webhookEvent.count({
      where: { provider, status: "REJECTED", createdAt: { gt: cutoff } },
    });
    if (n === REJECTION_ALERT_THRESHOLD) {
      await opsAlert(
        `⚠️ ${provider} webhooks: ${n} signature rejections in the last hour — real events may be bouncing at the door. ${appBase()}/connections`,
      );
      await notifyInApp({
        kind: "system",
        title: `${provider} webhooks bouncing (${n}/hr)`,
        href: "/connections",
        targets: [{ roles: ["OWNER"] }],
        // Hour-bucketed key = the same natural rate limit as the Slack ping.
        dedupeKey: `whrej-${provider}-${new Date().toISOString().slice(0, 13).replace("T", "-")}`,
      });
    }
  } catch {
    /* never let alerting break the receiver */
  }
}
