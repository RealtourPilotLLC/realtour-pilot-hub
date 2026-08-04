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
const SMS_KINDS = new Set([
  "appointment_change", "order_canceled", "mention", "review_feedback", "cull", "raws_missing", "task_assigned",
  // Someone answered on a note thread the photographer is part of — their
  // question finally has a reply; reach the field. (feedback_shared stays
  // NON-SMS: the share-text flow already sends its own text.)
  "note_reply",
]);
// The video editors (Kim/Remar) have no push either, and the whole point of the
// editor platform is that raws-landed / a revision / a review-back actually
// REACH them — in Manila. These kinds bridge an `editor:<key>` bell row to their
// channel (Slack DM if we have their id, else SMS via their TeamMember phone),
// gated by quiet hours in THEIR timezone (see channelForEditor).
const EDITOR_CHANNEL_KINDS = new Set([
  "raws_landed", "revision_raised", "revision_resolved", "mention", "edit_finished",
  // Review Room round-trips: changes requested on a cut / cut approved.
  "review_changes", "review_approved",
  // Owner/admin manually put a job in this editor's queue (/editing → Add a job).
  "edit_assigned",
  // A reply landed on a note thread this editor is part of.
  "note_reply",
]);

// Quiet hours in a SPECIFIC timezone (7:00–22:00 local). Photographer texting
// stays ET via the default; editor texting passes the recipient's tz so a
// Manila editor isn't pinged at 3am (their night = the old ET window exactly).
function withinTextingHours(tz = "America/New_York"): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()),
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

// ---------------------------------------------------------------------------
// INTERNAL STAFF SMS. For alerts that must reach a named person's phone rather
// than a role's bell — "photos still not delivered", the kind of thing that has
// to interrupt someone.
//
// Numbers come ONLY from TeamMember rows, resolved from ids the caller passes.
// It deliberately accepts no raw phone string: the one thing separating a staff
// text from a client text in this codebase is which table the number came out
// of, so that boundary is enforced by the signature, not by a comment.
//
// It also refuses to text OUR OWN OpenPhone line. That is not hypothetical —
// Kyle's TeamMember.phone is currently the company number (215) 645-4889, so a
// naive send would text the office line from itself and echo back through the
// inbound webhook as a fake client message. When that happens the alert is
// relayed to Slack instead of being silently dropped, because a missed alert is
// the failure this whole feature exists to prevent.
// ---------------------------------------------------------------------------
export type StaffSmsResult = { teamMemberId: string; name: string; outcome: "sent" | "no-phone" | "own-line" | "quiet-hours" | "failed" };

export async function notifyStaffSms(teamMemberIds: string[], text: string): Promise<StaffSmsResult[]> {
  const ids = [...new Set(teamMemberIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const out: StaffSmsResult[] = [];
  try {
    const members = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } });
    const quiet = !withinTextingHours();
    const { OpenPhone, defaultOpenPhoneNumber, phoneKey, ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
    const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
    // Resolved ONCE — defaultOpenPhoneNumber is a live API round trip.
    const from = ids.length ? await defaultOpenPhoneNumber() : null;
    const body = `⚙️ RealTour Hub: ${text}`;

    for (const m of members) {
      const digits = m.phone?.replace(/[^\d+]/g, "") ?? "";
      const key = digits ? phoneKey(digits) : "";
      if (!digits || key.length !== 10) {
        out.push({ teamMemberId: m.id, name: m.name, outcome: "no-phone" });
        continue;
      }
      if (ours.has(key)) {
        // Loud, not silent: this is a data problem someone has to fix.
        console.warn(`notifyStaffSms: ${m.name}'s number is our own OpenPhone line — cannot text, relaying to ops`);
        out.push({ teamMemberId: m.id, name: m.name, outcome: "own-line" });
        continue;
      }
      if (quiet) {
        out.push({ teamMemberId: m.id, name: m.name, outcome: "quiet-hours" });
        continue;
      }
      try {
        if (!from) throw new Error("no OpenPhone number");
        await OpenPhone.sendMessage(from, digits.startsWith("+") ? digits : `+1${key}`, body);
        out.push({ teamMemberId: m.id, name: m.name, outcome: "sent" });
      } catch (e) {
        console.warn("notifyStaffSms send failed", m.name, e);
        out.push({ teamMemberId: m.id, name: m.name, outcome: "failed" });
      }
    }
    // Anyone we could not reach by text still gets the alert — via Slack ops.
    const unreached = out.filter((r) => r.outcome !== "sent" && r.outcome !== "quiet-hours");
    if (unreached.length) {
      await opsAlert(`⚠️ Couldn't text ${unreached.map((r) => `${r.name} (${r.outcome})`).join(", ")} — relaying: ${text}`);
    }
  } catch (e) {
    console.warn("notifyStaffSms failed", e);
  }
  return out;
}

// What actually happened when we tried to reach an editor — callers use this
// to log the truth ("texted" vs "relayed to ops") instead of assuming Slack.
export type EditorChannel = "slack" | "sms" | "relay" | "quiet" | "none";

// Reach an editor addressed by `editor:<key>` (Kim/Remar) on THEIR channel:
//   · Slack DM if the roster carries a slackUserId (preferred — same path as
//     Kyle's DM, no phone dependency, no quiet-hours phone leak);
//   · else SMS via their TeamMember phone (Kim has one; Remar until Jordan adds
//     hers — the lookup no-ops cleanly when absent).
// Quiet hours are checked in the EDITOR's timezone (default Asia/Manila) so an
// offshore editor isn't pinged at 3am. Title + deep link only (money clamp —
// same as photographer SMS). Best-effort; never throws — returns which channel
// actually carried the ping.
async function channelForEditor(editorKey: string, title: string, href: string): Promise<EditorChannel> {
  try {
    const { editorMeta, editorTeamMemberId, DEFAULT_EDITOR_TZ } = await import("@/lib/editors");
    const meta = editorMeta(editorKey);
    if (!meta) return "none";
    if (!withinTextingHours(meta.tz ?? DEFAULT_EDITOR_TZ)) return "quiet"; // bell row still landed
    const link = `${appBase()}${href}`;
    // Prefer a Slack DM when we have the id (opening the bot's DM with them).
    if (meta.slackUserId) {
      const ok = await slackNotify(meta.slackUserId, `⚙️ RealTour Hub: ${title}\n${link}`);
      return ok ? "slack" : "none";
    }
    // Fall back to SMS via their TeamMember phone.
    const tmId = await editorTeamMemberId(editorKey);
    const member = tmId ? await prisma.teamMember.findUnique({ where: { id: tmId }, select: { phone: true } }) : null;
    const phone = member?.phone?.replace(/[^\d+]/g, "");
    if (!phone) {
      // NO reachable channel (no Slack id, no phone — e.g. Remar today). The
      // old silent return meant editor-addressed work landed NOWHERE a human
      // saw (audit critical) — make it loud so ops relays it by hand.
      const relayed = await opsAlert(`⚠️ Couldn't reach ${meta.name} (no Slack/phone on file) — relay this: ${title} → ${link}`);
      return relayed ? "relay" : "none";
    }
    const { OpenPhone, defaultOpenPhoneNumber, phoneKey } = await import("@/lib/integrations/openphone");
    const from = await defaultOpenPhoneNumber();
    if (!from) return "none";
    // Editors are offshore — keep an explicit + international number as-is; only
    // bare 10-digit US numbers get the +1 prefix.
    const to = phone.startsWith("+") ? phone : `+1${phoneKey(phone)}`;
    await OpenPhone.sendMessage(from, to, `⚙️ RealTour Hub: ${title}\n${link}`);
    return "sms";
  } catch (e) {
    console.warn("channelForEditor failed", e);
    return "none";
  }
}

export async function notifyInApp(n: {
  kind: string;
  title: string;
  body?: string;
  href: string; // default deep link; a target's href wins for its row
  targets: NotifyTarget[]; // ONE Notification row per target
  dedupeKey?: string; // suffixed "-0","-1",… per target index so multi-target events insert every row
}): Promise<{ bridged: Array<{ userKey: string; channel: EditorChannel }> }> {
  const bridged: Array<{ userKey: string; channel: EditorChannel }> = [];
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
        // …and bridge person-addressed EDITOR rows (editor:<key>) to Slack/SMS so
        // raws-landed / a revision / a review-back reaches Kim/Remar in Manila.
        if (EDITOR_CHANNEL_KINDS.has(n.kind) && t.userKey?.startsWith("editor:") && roles.includes("EDITOR")) {
          const channel = await channelForEditor(t.userKey.slice(7), title, href);
          bridged.push({ userKey: t.userKey, channel });
        }
        // A NEW editor-addressed bell row with no login to see it → nudge Jordan
        // once (deduped inside) to send that editor their Hub invite.
        if (t.userKey?.startsWith("editor:")) {
          try {
            const { ensureEditorLoginNudge } = await import("@/lib/tasks");
            await ensureEditorLoginNudge(t.userKey.slice(7));
          } catch { /* the nudge must never break the bell */ }
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
  return { bridged };
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
