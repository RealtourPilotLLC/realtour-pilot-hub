import "server-only";
import { prisma } from "@/lib/prisma";
import { waitingReplyHref } from "@/components/comms/messagesNav";
import { normalizeSubject } from "@/components/comms/emailThreads";

// ---------------------------------------------------------------------------
// AN EMAIL HANDED TO SOMEONE (Jordan's Loom, Oct 27 2026, 5:17 to 6:51: "if I
// delegate this to Kyle, due today ... that should go right to Kyle's
// dashboard. As a task that he needs to handle, and that should go to his
// communications ... email needing my reply should be empty now, because I've
// delegated all of these."). The delegation itself is the one path every
// screen uses (lib/delegation); this file is only the email's identity:
//
//   · THE THREAD IS THE KEY. A delegated email is keyed to its thread's link
//     (the Messages Email view, focused on "<subject>::<clientId>"), never to
//     whichever reply to-do the client happened to have open: that to-do can
//     be a text's, and it changes when the client writes again, which is how
//     a delegated email came back to "You need to reply" (the Loom bug).
//   · The link is kept short enough to be a task's record link (delegation's
//     safeHref takes 300 characters); a long subject is cut, and both sides
//     compare the cut subject, so the key still finds its thread.
//   · Sending the reply in the hub, or marking the thread handled, closes the
//     delegated task with that evidence (closeDelegatedEmailTasks).
// ---------------------------------------------------------------------------

/** Every email thread link starts with this (messagesNav: the Email view, focused). */
export const EMAIL_THREAD_PREFIX = "/communications?tab=email&focus=";
const MAX_HREF = 300;

/** The thread's link, the delegated task's record link and key (`deleg:<href>`). */
export function emailThreadHref(subject: string | null | undefined, clientId: string | null | undefined): string {
  let s = normalizeSubject(subject);
  let href = waitingReplyHref("email", `${s}::${clientId ?? null}`);
  while (href.length > MAX_HREF && s.length > 20) {
    s = s.slice(0, Math.max(20, s.length - 20)).trim();
    href = waitingReplyHref("email", `${s}::${clientId ?? null}`);
  }
  return href;
}

export type EmailThreadRef = { subject: string; clientId: string | null };

/** The thread an email link names, or null for any other link. */
export function parseEmailThreadHref(href: string | null | undefined): EmailThreadRef | null {
  if (!href || !href.startsWith("/communications?")) return null;
  const q = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  if (q.get("tab") !== "email") return null;
  const focus = q.get("focus") ?? "";
  const at = focus.lastIndexOf("::");
  if (at < 0) return null;
  const subject = focus.slice(0, at).trim();
  const id = focus.slice(at + 2).trim();
  if (!subject) return null;
  return { subject, clientId: id && id !== "null" ? id : null };
}

/** Does this thread (a client, and the subjects it is waiting on) match a delegated email's link? */
export function threadMatches(ref: EmailThreadRef, clientId: string | null | undefined, subjects: (string | null | undefined)[]): boolean {
  if ((ref.clientId ?? null) !== (clientId ?? null)) return false;
  return subjects.some((raw) => {
    const s = normalizeSubject(raw);
    return s === ref.subject || (ref.subject.length >= 20 && s.startsWith(ref.subject));
  });
}

/** By the end of today (5 PM ET), or the next business day once it's past 5. */
export async function replyDueAt(now: Date): Promise<string> {
  const { endOfBusinessDaysET, etMinutesOfDay } = await import("@/lib/datetime");
  return endOfBusinessDaysET(now, etMinutesOfDay(now) < 17 * 60 ? 0 : 1).toISOString();
}

const OPEN = { notIn: ["COMPLETED", "CANCELLED"] };
const refKey = (r: EmailThreadRef) => `${r.clientId ?? ""}::${r.subject}`;

export type EmailThreadStatus = {
  /** the newest email they sent in this thread (the reply box answers it) */
  commLogId: string | null;
  lastInAt: Date | null;
  /** our reply after their newest email, when there is one: the thread is answered */
  answeredAt: Date | null;
};

/**
 * Where each thread stands, read from the comms log (the same rows Messages
 * shows): their newest email, and our reply after it. For a delegated email
 * the office's walk does not list (a sender with no client record, or one
 * answered already), so its row still has a Reply, or says it was answered.
 */
export async function emailThreadStatus(refs: EmailThreadRef[], now: Date = new Date()): Promise<Map<string, EmailThreadStatus>> {
  const out = new Map<string, EmailThreadStatus>();
  if (!refs.length) return out;
  const ids = [...new Set(refs.map((r) => r.clientId).filter((x): x is string => !!x))];
  const orphans = refs.some((r) => !r.clientId);
  const rows = await prisma.commLog.findMany({
    where: {
      channel: "email",
      occurredAt: { gte: new Date(now.getTime() - 45 * 86_400_000) },
      OR: [...(ids.length ? [{ clientId: { in: ids } }] : []), ...(orphans ? [{ clientId: null }] : [])],
    },
    select: { id: true, clientId: true, direction: true, subject: true, occurredAt: true, externalId: true },
    orderBy: { occurredAt: "desc" },
    take: 600,
  });
  for (const ref of refs) {
    const mine = rows.filter((r) => threadMatches(ref, r.clientId, [r.subject]));
    const lastIn = mine.find((r) => r.direction !== "out");
    const answer = lastIn ? mine.find((r) => r.direction === "out" && r.occurredAt.getTime() >= lastIn.occurredAt.getTime()) : null;
    out.set(refKey(ref), {
      commLogId: mine.find((r) => r.direction !== "out" && (r.externalId ?? "").startsWith("gmail-"))?.id ?? null,
      lastInAt: lastIn?.occurredAt ?? null,
      answeredAt: answer?.occurredAt ?? null,
    });
  }
  return out;
}
export const emailThreadKey = refKey;

/** The open delegated email tasks for these clients (null: an email with no client record). */
export async function openEmailDelegations(clientIds: (string | null)[]): Promise<{ id: string; clientId: string | null; ref: EmailThreadRef; needsVerification: boolean; assignedKey: string | null }[]> {
  const ids = [...new Set(clientIds.filter((x): x is string => !!x))];
  const orphans = clientIds.some((x) => !x);
  if (!ids.length && !orphans) return [];
  const rows = await prisma.smartTask.findMany({
    where: {
      delegatedAt: { not: null },
      status: OPEN,
      AND: [
        { OR: [...(ids.length ? [{ clientId: { in: ids } }] : []), ...(orphans ? [{ clientId: null }] : [])] },
        { OR: [{ dedupeKey: { startsWith: `deleg:${EMAIL_THREAD_PREFIX}` } }, { sourceDetail: { startsWith: EMAIL_THREAD_PREFIX } }, { delegation: { contains: `"sourceHref":"${EMAIL_THREAD_PREFIX}` } }] },
      ],
    },
    select: { id: true, clientId: true, dedupeKey: true, sourceDetail: true, delegation: true, assignedKey: true },
    take: 200,
  });
  const out: { id: string; clientId: string | null; ref: EmailThreadRef; needsVerification: boolean; assignedKey: string | null }[] = [];
  for (const r of rows) {
    let rec: { sourceHref?: unknown; needsVerification?: unknown } = {};
    try { rec = JSON.parse(r.delegation ?? "{}") ?? {}; } catch { rec = {}; }
    const href = typeof rec.sourceHref === "string" ? rec.sourceHref : r.sourceDetail ?? (r.dedupeKey?.startsWith("deleg:") ? r.dedupeKey.slice(6) : null);
    const ref = parseEmailThreadHref(href);
    if (ref) out.push({ id: r.id, clientId: r.clientId, ref, needsVerification: rec.needsVerification === true, assignedKey: r.assignedKey });
  }
  return out;
}

/**
 * The thread was answered in the hub, or marked handled: its delegated email
 * tasks close with that as their evidence (a task that needs Jordan's check
 * goes to "Ready for verification" instead). `subject` narrows it to that
 * thread; without one, every delegated email of the client closes (the
 * Handled tick clears the sender's whole email conversation). Never throws:
 * the send or the tick has already happened.
 */
export async function closeDelegatedEmailTasks(opts: { clientId: string | null; subject?: string | null; why: "sent" | "handled"; by?: string | null; now?: Date }): Promise<number> {
  try {
    const now = opts.now ?? new Date();
    const open = await openEmailDelegations([opts.clientId ?? null]);
    const hit = open.filter((t) => (t.clientId ?? null) === (opts.clientId ?? null) && (opts.subject == null || threadMatches(t.ref, opts.clientId ?? null, [opts.subject])));
    if (!hit.length) return 0;
    const { hubChange, VERIFY_STATUS } = await import("@/lib/delegation");
    const who = opts.by ? ` by ${opts.by}` : "";
    const text = opts.why === "sent" ? `The reply was sent from the hub${who}` : `The email was marked handled${who}`;
    let n = 0;
    for (const t of hit) {
      const r = await hubChange(
        t.id,
        t.needsVerification
          ? { kind: "submitted", text: `${text}. Ready for verification.`, data: { status: VERIFY_STATUS } }
          : { kind: "completed", text, data: { status: "COMPLETED", completedAt: now, blockedReason: null } },
        now,
      ).catch(() => null);
      if (r?.ok) n++;
    }
    return n;
  } catch (e) {
    console.warn("closeDelegatedEmailTasks failed", (e as Error)?.message);
    return 0;
  }
}
