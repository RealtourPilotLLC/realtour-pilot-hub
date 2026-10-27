import "server-only";
import { prisma } from "@/lib/prisma";
import { normalizeSubject } from "@/components/comms/emailThreads";

// ---------------------------------------------------------------------------
// UNREAD ON EVERY CLIENT THREAD (Jordan, Oct 27 2026 Loom, 37:49: "we should
// know if it's unread").
//
// One read mark per person per client conversation, kept where the team chat
// keeps its own (ThreadRead, userKey = the AppUser id), under a "msg:" key so
// the team chat's readers (they look up real job ids only) never see them:
//   msg:t:<card key>              a text conversation: c:<clientId> or p:<phone>
//   msg:e:<subject>::<clientId>   an email thread, as Messages · Email groups it
// A conversation is unread when something they sent is newer than the mark.
// Marks move when a person opens the conversation: a text's reply screen, an
// email thread unfolded (or opened by Reply). A "view as" preview never moves
// anyone's mark. No schema change: ThreadRead.projectId is a plain string.
// ---------------------------------------------------------------------------

export const MSG_READ_PREFIX = "msg:";

/** The read key for a text conversation (a ledger row's `#task` suffix is the same conversation). */
export function textReadKey(cardKey: string): string {
  return `${MSG_READ_PREFIX}t:${cardKey.split("#")[0]}`;
}

/** The read key for an email thread (Messages · Email's own thread key). */
export function emailReadKey(threadKey: string): string {
  return `${MSG_READ_PREFIX}e:${threadKey}`;
}

/** An email message's thread read key, from its subject and client. */
export function emailReadKeyFor(subject: string | null | undefined, clientId: string | null | undefined): string {
  return emailReadKey(`${normalizeSubject(subject)}::${clientId || "unknown"}`);
}

/** Pure: is a conversation whose newest message from them is `lastInboundAt` unread against `seenAt`? */
export function isUnread(lastInboundAt: Date | string | null | undefined, seenAt: Date | null | undefined): boolean {
  if (!lastInboundAt) return false;
  const at = typeof lastInboundAt === "string" ? new Date(lastInboundAt) : lastInboundAt;
  if (isNaN(at.getTime())) return false;
  return !seenAt || at.getTime() > seenAt.getTime();
}

/** This person's marks for these keys. A failed read returns no marks: everything reads unread, nothing is hidden. */
export async function readMarks(userKey: string | null | undefined, keys: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const ids = [...new Set(keys.filter(Boolean))];
  if (!userKey || ids.length === 0) return out;
  const rows = await prisma.threadRead
    .findMany({ where: { userKey, projectId: { in: ids } }, select: { projectId: true, seenAt: true } })
    .catch(() => [] as { projectId: string; seenAt: Date }[]);
  for (const r of rows) out.set(r.projectId, r.seenAt);
  return out;
}

/** The read keys one waiting conversation is judged on, each with when they
 *  wrote: a text conversation by its newest message, an email row by each
 *  message's own thread (one sender can write on two subjects). */
export function waitingReadKeys(
  family: "phone" | "email",
  g: { key: string; clientId: string; items: { subject: string | null; atISO: string }[] },
): { key: string; at: string }[] {
  if (family === "phone") {
    const last = g.items[g.items.length - 1];
    return last ? [{ key: textReadKey(g.key), at: last.atISO }] : [];
  }
  return g.items.map((i) => ({ key: emailReadKeyFor(i.subject, g.clientId), at: i.atISO }));
}

/** Which of these rows this person has not read, in one read of their marks. */
export async function unreadRows<T>(userKey: string | null | undefined, rows: T[], keysOf: (r: T) => { key: string; at: string | null }[]): Promise<Set<T>> {
  const keyed = rows.map((r) => ({ r, keys: keysOf(r) }));
  const marks = await readMarks(userKey, keyed.flatMap((k) => k.keys.map((x) => x.key)));
  return new Set(keyed.filter((k) => k.keys.some((x) => isUnread(x.at, marks.get(x.key)))).map((k) => k.r));
}

/** Move this person's mark on one conversation forward to `at` (never back). Never throws. */
export async function markRead(userKey: string | null | undefined, key: string, at: Date = new Date()): Promise<void> {
  if (!userKey || !key.startsWith(MSG_READ_PREFIX) || isNaN(at.getTime())) return;
  const when = new Date(Math.min(at.getTime(), Date.now()));
  try {
    const where = { userKey, projectId: key };
    const existing = await prisma.threadRead.findUnique({ where: { userKey_projectId: where }, select: { seenAt: true } });
    if (!existing) {
      await prisma.threadRead.create({ data: { ...where, seenAt: when } }).catch(async (e: unknown) => {
        // Another tab made it first: only advance an older mark.
        if ((e as { code?: string } | null)?.code !== "P2002") throw e;
        await prisma.threadRead.updateMany({ where: { ...where, seenAt: { lt: when } }, data: { seenAt: when } });
      });
    } else if (existing.seenAt < when) {
      await prisma.threadRead.updateMany({ where: { ...where, seenAt: { lt: when } }, data: { seenAt: when } });
    }
  } catch (e) {
    console.warn("[messageReads] could not mark read", key, e);
  }
}
