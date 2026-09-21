"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { scrubMoney } from "@/lib/text";

// ---------------------------------------------------------------------------
// The task full-view: the COMPLETE original conversation behind a task, pulled
// live from where it actually happened. sourceDetail tells us where:
//   gmail-thread:<mailbox>:<threadId>  → fetch the real Gmail thread
//   phone:<number> / source openphone  → the client's text/call log (CommLog)
//   channel <C…> · <ts> / source slack → that Slack channel around that message
//   anything else                      → the client's recent comms, any channel
// READ-ONLY, and comms are privileged: client emails/texts can contain pricing
// and other owner-tier content, so the conversation section is OWNER/ADMIN only
// — an editor/photographer gets the task's own text and nothing else. "View as"
// therefore also hides it (the preview shows what THAT role would see). One
// more boundary INSIDE that: info@ is Jordan's personal mailbox (its unknown-
// sender comms are logged minRole OWNER), so its threads never live-fetch for
// an ADMIN — those requests fall through to CommLog, which enforces minRole.
// ---------------------------------------------------------------------------

export type SourceMessage = {
  from: string;
  fromUs: boolean;
  date: string; // ISO
  body: string;
  subject?: string | null;
  channel: string; // email | text | call | slack | note
};

export type TaskFullView = {
  ok: boolean;
  message?: string;
  conversation?: SourceMessage[];
  /** Shown when the conversation section is visible but empty. */
  note?: string;
  canSeeConversation?: boolean;
};

const LOAD_FAILED: TaskFullView = {
  ok: true,
  canSeeConversation: true,
  conversation: [],
  note: "Couldn't load the conversation — try again.",
};

// ADMIN = full operations, no money anywhere (Jordan). The card text is already
// scrubbed for a non-owner; the live conversation behind it was not (audit, Sep 8).
const forRole = (role: string) => (m: SourceMessage): SourceMessage =>
  role === "OWNER" ? m : { ...m, body: scrubMoney(m.body), subject: m.subject ? scrubMoney(m.subject) : m.subject };

export async function getTaskConversation(taskId: string): Promise<TaskFullView> {
  // Everything — auth lookup included — stays inside the try: a transient DB
  // blip must resolve to the friendly note, not an unhandled rejection. The
  // catch returns NO conversation data, so failing closed here leaks nothing.
  try {
    const user = await getCurrentUser();
    if (!user && authEnforced()) return { ok: false, message: "Please sign in." };

    const task = await prisma.smartTask.findUnique({
      where: { id: taskId },
      select: { id: true, source: true, sourceDetail: true, clientId: true, createdAt: true },
    });
    if (!task) return { ok: false, message: "Task not found." };

    // Effective role (so "view as" previews honestly). No user + unenforced dev = owner-equivalent.
    const role = user?.role ?? "OWNER";
    if (role !== "OWNER" && role !== "ADMIN") {
      // Editors/photographers: the card's own text is already on screen; the
      // client conversation is not their lane.
      return { ok: true, canSeeConversation: false };
    }

    // 1) Email tasks → the real Gmail thread, fetched live. Jordan's personal
    // mailbox is OWNER-only — ADMIN falls through to the minRole-filtered log.
    const sd = task.sourceDetail ?? "";
    if (sd.startsWith("gmail-thread:")) {
      const [, mailbox, threadId] = sd.split(":");
      const { fetchGmailThread, isPersonalMailbox } = await import("@/lib/integrations/google");
      if (mailbox && threadId && (role === "OWNER" || !isPersonalMailbox(mailbox))) {
        const msgs = await fetchGmailThread(mailbox, threadId).catch(() => []);
        if (msgs.length > 0) {
          return {
            ok: true,
            canSeeConversation: true,
            conversation: msgs.slice(-12).map((m) => forRole(role)({ ...m, channel: "email" })),
          };
        }
      }
      // fall through to CommLog if gated or the live fetch came up empty
    }

    // 2) Slack tasks → the channel's logged messages around THAT message
    // (sourceDetail carries its ts — task.createdAt lags when the hourly poll
    // backfills). Newest rows win; shown oldest-first.
    if (task.source === "slack") {
      const m = sd.match(/channel (\S+)/);
      const ts = sd.match(/(\d{9,})(?:\.\d+)?\s*$/)?.[1];
      const anchor = ts ? new Date(Number(ts) * 1000) : task.createdAt;
      const rows = await prisma.commLog.findMany({
        where: {
          channel: "slack",
          ...(m ? { externalId: { startsWith: `slack-${m[1]}-` } } : {}),
          occurredAt: { gte: new Date(anchor.getTime() - 12 * 3600_000), lte: new Date(anchor.getTime() + 2 * 3600_000) },
          ...(role !== "OWNER" ? { minRole: { not: "OWNER" } } : {}),
        },
        orderBy: { occurredAt: "desc" },
        take: 15,
      });
      rows.reverse();
      const names = await senderNames(rows);
      return {
        ok: true,
        canSeeConversation: true,
        conversation: rows.map((r) => rowToMessage(r, names)).map(forRole(role)),
        note: rows.length === 0 ? "No Slack history captured around this message." : undefined,
      };
    }

    // 3) Everything client-attached → their recent comms, matched to the task's
    // channel (a gmail task shows their emails, an openphone task their texts —
    // mixing lanes buried the email under months of text history).
    if (task.clientId) {
      const rows = await prisma.commLog.findMany({
        where: {
          clientId: task.clientId,
          ...(task.source === "openphone" ? { channel: { in: ["text", "call"] } } : task.source === "gmail" ? { channel: "email" } : {}),
          ...(role !== "OWNER" ? { minRole: { not: "OWNER" } } : {}),
        },
        orderBy: { occurredAt: "desc" },
        take: 12,
      });
      rows.reverse();
      const names = await senderNames(rows);
      return {
        ok: true,
        canSeeConversation: true,
        conversation: rows.map((r) => rowToMessage(r, names)).map(forRole(role)),
        note: rows.length === 0 ? "No conversation on record for this client yet." : undefined,
      };
    }

    return { ok: true, canSeeConversation: true, conversation: [], note: "This task isn't linked to a conversation." };
  } catch (e) {
    console.warn("getTaskConversation failed", e);
    return LOAD_FAILED;
  }
}

// WHO ON OUR SIDE SAID IT (Sep 21 2026). Every outbound text from the company
// line used to read "Us" here, because Kyle's handset IS that line. Now that the
// OpenPhone sender is kept (see lib/commSenders), the person shows through —
// months later this is the difference between reading a thread and reading a
// conversation. Rows with no attribution keep saying "Us": null means UNKNOWN,
// and inventing a name on an old row would be worse than the vagueness.
async function senderNames(rows: { senderTeamMemberId: string | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.senderTeamMemberId).filter((v): v is string => !!v))];
  if (ids.length === 0) return new Map();
  const team = await prisma.teamMember
    .findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    .catch(() => [] as { id: string; name: string }[]);
  return new Map(team.map((t) => [t.id, t.name]));
}

function rowToMessage(
  r: {
    channel: string;
    direction: string;
    clientName: string | null;
    contactName: string | null;
    subject: string | null;
    body: string;
    occurredAt: Date;
    senderTeamMemberId: string | null;
  },
  names: Map<string, string>,
): SourceMessage {
  const fromUs = r.direction === "out";
  const ours = (r.senderTeamMemberId && names.get(r.senderTeamMemberId)) || null;
  return {
    from: fromUs ? ours ?? "Us" : r.contactName || r.clientName || "Client",
    fromUs,
    date: r.occurredAt.toISOString(),
    body: r.body,
    subject: r.subject,
    channel: r.channel,
  };
}
