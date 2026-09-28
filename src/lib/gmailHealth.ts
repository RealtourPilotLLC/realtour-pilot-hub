import "server-only";
import { prisma } from "@/lib/prisma";
import { notifyInApp } from "@/lib/notify";
import { etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Gmail-SEND health (audit finding #41). The token can read mail but lack the
// send scope (Google drops it if the reconnect consent skipped it), and only
// Jordan can fix that — /connections is owner-only. Before this, a failed send
// surfaced only as an inline "reconnect Google" error to whoever pressed Send,
// which an ADMIN literally cannot act on. These helpers route the failure to
// the one person who can: an owner bell + a reopenable owner task, and the
// task self-closes when the SAME mailbox sends successfully.
//
// PER-MAILBOX on purpose: info@ and hello@ hold separate tokens, so info@
// working must not close a task about hello@ being broken — that flip-flopped
// the durable item every time an unrelated send succeeded.
//
// Both are BEST-EFFORT and never throw — send-health reporting must never
// break the send path (or a cron) that calls it. Callers should AWAIT them
// (they're cheap): fire-and-forget writes get killed by the serverless freeze
// right after the response, which silently loses the one ping this exists for.
// ---------------------------------------------------------------------------

// One reopenable owner task per mailbox ("unknown" when the failing mailbox
// couldn't be determined — still routed, just less specific).
const taskKey = (mailbox: string) => `gmail-reconnect-${mailbox.toLowerCase()}`;

export async function reportGmailSendBroken(context: string, mailbox = "unknown"): Promise<void> {
  const mb = mailbox.toLowerCase();
  // Owner bell — day-bucketed dedupe so a burst of failed sends rings once,
  // not once per attempt. kind "system" is bell-only under eventForKind
  // (src/lib/notifyPrefs.ts) — no text, no Slack DM.
  await notifyInApp({
    kind: "system",
    title: `Gmail can't send${mb !== "unknown" ? ` (${mb})` : ""} — reconnect Google`,
    body: `A hub email failed (${context}).`.slice(0, 140),
    href: "/connections",
    targets: [{ roles: ["OWNER"] }],
    dedupeKey: `gmail-reconnect-${mb}-${etDayKey(new Date())}`,
  });

  // Owner task: mint once per mailbox, reopen if a past failure's task was
  // closed without the scope actually being granted (a later send failed again).
  try {
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: taskKey(mb) } });
    if (existing) {
      if (existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return; // already open
      await prisma.smartTask.update({
        where: { id: existing.id },
        data: { status: "OPEN", completedAt: null, reasonCreated: `Gmail send failed (${context})` },
      });
      return;
    }
    // Engine-minted — never set assignedManually (that flag is the humans'
    // "hands off" signal to every automatic engine, this task included).
    await prisma.smartTask.create({
      data: {
        taskType: "connection_fix",
        title: `Reconnect Google so hub emails send${mb !== "unknown" ? ` — ${mb}` : ""}`.slice(0, 120),
        summary:
          `Hub email replies are failing${mb !== "unknown" ? ` from ${mb}` : ""} — Gmail can read but not send. ` +
          "Open Connections → Google → Reconnect and approve BOTH mailboxes (info@ + hello@). " +
          "This task closes itself when this mailbox sends successfully.",
        reasonCreated: `Gmail send failed (${context})`,
        source: "system",
        sourceDetail: "/connections",
        priority: "URGENT",
        assignedKey: "jordan",
        dedupeKey: taskKey(mb),
      },
    });
  } catch {
    /* best-effort — the failed send already reported its own error to the user */
  }
}

// A send went through on THIS mailbox → its scope is granted; retire that
// mailbox's reconnect task (plus any legacy/unknown-keyed one — a working
// send is the strongest signal the generic task is stale too).
// updateMany (not update) so "no task exists" is a no-op, not an error.
export async function reportGmailSendWorking(mailbox = "unknown"): Promise<void> {
  await prisma.smartTask
    .updateMany({
      where: {
        dedupeKey: { in: [taskKey(mailbox), taskKey("unknown"), "gmail-reconnect"] },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      data: { status: "COMPLETED", completedAt: new Date() },
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Gmail-READ health (§9, Sep 26 2026). The send task above can only say a
// mailbox cannot SEND; nothing said when one could not be READ. syncGmail
// skipped a mailbox whose token Google refused with no record at all and the
// comms cron stayed green, so the only symptom of hello@ going dark was mail
// that never appeared — and hello@ is where every email lead comes in.
//
// Same shape as the send task, keyed separately (`gmail-read-<mailbox>`), so a
// good SEND from info@ can never close a READ problem on hello@, and the other
// way round:
//   · reportGmailReadBroken  — one reopenable owner connection_fix task per
//     mailbox, and one owner bell when it opens (the task is the record;
//     ringing every five minutes while it stays broken would be noise);
//   · reportGmailReadWorking — closes only that mailbox's read task and
//     stamps `gmail-read-ok:<mailbox>`, the "last successful read" the
//     Connections page and the client email panel print. The stamp is
//     refreshed at most every READ_STAMP_EVERY_MS (the scan runs every five
//     minutes; the readers only care whether it is over an hour old).
// ---------------------------------------------------------------------------

const readTaskKey = (mailbox: string) => `gmail-read-${mailbox.toLowerCase()}`;
export const gmailReadOkKey = (mailbox: string) => `gmail-read-ok:${mailbox.toLowerCase()}`;
const READ_STAMP_EVERY_MS = 30 * 60_000;
/** Past this, a mailbox's last good read is news (the scan runs every 5 minutes). */
export const MAILBOX_READ_STALE_MS = 60 * 60_000;

export async function reportGmailReadBroken(mailbox: string, reason: string): Promise<void> {
  const mb = mailbox.toLowerCase();
  const leads = mb.startsWith("hello@");
  try {
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: readTaskKey(mb) }, select: { id: true, status: true } });
    if (existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED") return; // already open — the task is the record
    const summary =
      `${mb} is not being read (${reason}). ` +
      (leads
        ? "Email leads and any client mail sent only to hello@ are not reaching the hub. "
        : "Client mail sent to this inbox is not reaching the hub. ") +
      "Open Connections → Google → Reconnect and approve this mailbox. This task closes itself on the next successful read.";
    if (existing) {
      await prisma.smartTask.update({
        where: { id: existing.id },
        data: { status: "OPEN", completedAt: null, reasonCreated: `Gmail read failed (${reason})`.slice(0, 200), summary: summary.slice(0, 500) },
      });
    } else {
      // Engine-minted — never assignedManually (see the send task above).
      await prisma.smartTask.create({
        data: {
          taskType: "connection_fix",
          title: `Reconnect Google — ${mb} is not being read`.slice(0, 120),
          summary: summary.slice(0, 500),
          reasonCreated: `Gmail read failed (${reason})`.slice(0, 200),
          source: "system",
          sourceDetail: "/connections",
          priority: "URGENT",
          assignedKey: "jordan",
          dedupeKey: readTaskKey(mb),
        },
      });
    }
    // Rung once per opening — bell-only (kind "system"; see the send bell).
    await notifyInApp({
      kind: "system",
      title: `Gmail isn't reading ${mb} — reconnect Google`,
      body: (leads ? "Email leads are not reaching the hub. " : "") + `Reason: ${reason}.`.slice(0, 120),
      href: "/connections",
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `gmail-read-${mb}-${etDayKey(new Date())}`,
    });
  } catch {
    /* best-effort — the scan's own result still says degraded */
  }
}

export async function reportGmailReadWorking(mailbox: string): Promise<void> {
  const mb = mailbox.toLowerCase();
  await prisma.smartTask
    .updateMany({
      where: { dedupeKey: readTaskKey(mb), status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    })
    .catch(() => {});
  try {
    const key = gmailReadOkKey(mb);
    const row = await prisma.appSetting.findUnique({ where: { key }, select: { updatedAt: true } });
    if (row && Date.now() - row.updatedAt.getTime() < READ_STAMP_EVERY_MS) return;
    const value = JSON.stringify({ at: new Date().toISOString() });
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  } catch {
    /* the stamp is a courtesy for the readers below */
  }
}

export type MailboxReadHealth = {
  email: string;
  /** in the connected-mailbox map at all */
  connected: boolean;
  /** the last scan that read this inbox successfully (null = never on record) */
  lastReadAt: Date | null;
  /** why it is not being read, when an open read task says so */
  problem: string | null;
  /** read within the last hour and no open read task */
  reading: boolean;
};

/** Every expected mailbox plus any other connected one, with its read state —
 *  for /connections and the "not every inbox is synced" footnotes. Never
 *  touches Google: it reads what the scans recorded. */
export async function mailboxReadHealth(now: Date = new Date()): Promise<MailboxReadHealth[]> {
  const { EXPECTED_MAILBOXES, connectedGmailMailboxes } = await import("@/lib/integrations/google");
  const connected = await connectedGmailMailboxes().catch(() => [] as string[]);
  const all = [...new Set([...EXPECTED_MAILBOXES, ...connected])];
  const [stamps, tasks] = await Promise.all([
    prisma.appSetting.findMany({ where: { key: { in: all.map(gmailReadOkKey) } }, select: { key: true, value: true } }),
    prisma.smartTask.findMany({
      where: { dedupeKey: { in: all.map(readTaskKey) }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { dedupeKey: true, reasonCreated: true },
    }),
  ]);
  return all.map((email) => {
    const raw = stamps.find((s) => s.key === gmailReadOkKey(email))?.value;
    let lastReadAt: Date | null = null;
    try {
      const at = raw ? new Date((JSON.parse(raw) as { at?: string }).at ?? "") : null;
      lastReadAt = at && !isNaN(at.getTime()) ? at : null;
    } catch {
      lastReadAt = null;
    }
    const open = tasks.find((t) => t.dedupeKey === readTaskKey(email));
    const problem = open ? (open.reasonCreated ?? "not read").replace(/^Gmail read failed \(/, "").replace(/\)$/, "") : null;
    const isConnected = connected.includes(email);
    return {
      email,
      connected: isConnected,
      lastReadAt,
      problem: problem ?? (isConnected ? null : "not connected"),
      reading: isConnected && !open && !!lastReadAt && now.getTime() - lastReadAt.getTime() <= MAILBOX_READ_STALE_MS,
    };
  });
}

/** The one sentence a related-message view carries when an inbox is not
 *  being read (§9: "a related-message view is not a guarantee all inboxes are
 *  synced"). Pure; null when every expected mailbox is reading. */
export function mailboxGapSentence(rows: Pick<MailboxReadHealth, "email" | "lastReadAt" | "reading" | "connected">[]): string | null {
  const gaps = rows.filter((r) => !r.reading);
  if (!gaps.length) return null;
  const fmt = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const bits = gaps.map((g) =>
    !g.connected ? `${g.email} is not connected` : g.lastReadAt ? `${g.email} has not been read since ${fmt(g.lastReadAt)} ET` : `${g.email} has no successful read on record`,
  );
  return `${bits.join("; ")} — email sent only there may be missing here.`;
}
