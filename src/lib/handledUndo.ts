import "server-only";
import { prisma } from "@/lib/prisma";
import { emailAckKey, requestTaskIdFrom, requestTickKey, threadAckKey } from "@/lib/replyQueue";

// ---------------------------------------------------------------------------
// MARK HANDLED CAN BE TAKEN BACK (Kyle, Oct 29 2026, 5:02 PM: "I clicked on
// marked as handled on this task by mistake 🤦 i was trying to screenshot it").
//
// A tick (app/actions markCommsHandled) writes cut points (the thread's ack,
// the sender group's email ack, a request's own tick), closes reply to-dos and
// stamps them handled by hand, and can file a closed "handled outside the hub"
// trace. Every one of those overwrote what was there, so a tick could not be
// taken back: the Javier Jimenez repair had to reconstruct the earlier cut.
//
// Now the tick is bracketed: handledBefore reads every row it may touch,
// handledAfter keeps what changed (was → now) as one record. undoHandled puts
// each row back only while it still holds what the tick wrote (a newer tick,
// a reply or a new message since is never overwritten), cancels the trace, and
// leaves an audit row. The records are the "Handled today" list's too, so a
// tick is reopenable after its toast is gone. Kept UNDO_DAYS, then pruned.
// ---------------------------------------------------------------------------

export const UNDO_PREFIX = "comms-handled-undo:";
const UNDO_DAYS = 3;
const HAND_PREFIX = "handled-by-hand:"; // lib/opsDay HANDLED_BY_HAND_PREFIX
const CLOSED = ["COMPLETED", "CANCELLED"];
const TRACE_TITLE = "Client reply — handled outside the hub"; // markCommsHandled's trace row

type Family = "phone" | "email";
type KeyWas = { key: string; was: string | null; now: string | null };
type TaskWas = { id: string; title: string; status: string; completedAt: string | null; delegation: string | null; nowStatus: string };

export type HandledRecord = {
  v: 1;
  id: string;
  atISO: string;
  by: string | null;
  clientId: string | null;
  label: string;
  family: Family;
  reason: string | null;
  keys: KeyWas[];
  tasks: TaskWas[];
  /** trace rows the tick filed (cancelled on undo) */
  created: string[];
  undoneAtISO: string | null;
  undoneBy: string | null;
};

export type HandledInput = { clientId: string | null; family: Family; groupKey?: string | null; threadKey?: string | null; reason?: string | null };
export type HandledBefore = HandledInput & {
  atMs: number;
  keys: Map<string, string | null>;
  tasks: Map<string, { title: string; status: string; completedAt: string | null; delegation: string | null }>;
};

/** The rows a tick on this conversation may write (pure). */
export function handledKeys(input: HandledInput, openTaskIds: string[]): string[] {
  const keys = new Set<string>();
  const threadKey = (input.threadKey ?? "").trim() || null;
  if (threadKey) keys.add(threadAckKey(input.family, threadKey));
  if (input.clientId) {
    if (input.family === "email") keys.add(input.groupKey ? emailAckKey(input.clientId, input.groupKey) : `comms-ack-email-${input.clientId}`);
    else {
      keys.add(threadAckKey("phone", `c:${input.clientId}`));
      const named = requestTaskIdFrom(input.groupKey) ?? requestTaskIdFrom(threadKey);
      if (named) keys.add(requestTickKey(named));
    }
  }
  for (const id of openTaskIds) keys.add(`${HAND_PREFIX}${id}`);
  return [...keys];
}

export async function handledBefore(input: HandledInput, now: Date = new Date()): Promise<HandledBefore> {
  const open = input.clientId
    ? await prisma.smartTask.findMany({ where: { clientId: input.clientId, status: { notIn: CLOSED } }, select: { id: true, title: true, status: true, completedAt: true, delegation: true }, take: 200 })
    : [];
  const keys = handledKeys(input, open.map((t) => t.id));
  const rows = await prisma.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  const val = new Map(rows.map((r) => [r.key, r.value]));
  return {
    ...input,
    atMs: now.getTime(),
    keys: new Map(keys.map((k) => [k, val.get(k) ?? null])),
    tasks: new Map(open.map((t) => [t.id, { title: t.title, status: t.status, completedAt: t.completedAt?.toISOString() ?? null, delegation: t.delegation }])),
  };
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Keep what the tick changed; null when it changed nothing. */
export async function handledAfter(before: HandledBefore, who: { name: string | null }, now: Date = new Date()): Promise<string | null> {
  const ids = [...before.tasks.keys()];
  const [after, tasks, created] = await Promise.all([
    prisma.appSetting.findMany({ where: { key: { in: [...before.keys.keys()] } }, select: { key: true, value: true } }),
    ids.length ? prisma.smartTask.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }) : Promise.resolve([]),
    before.clientId
      ? prisma.smartTask.findMany({ where: { clientId: before.clientId, title: TRACE_TITLE, status: "COMPLETED", createdAt: { gte: new Date(before.atMs - 1000) } }, select: { id: true } })
      : Promise.resolve([]),
  ]);
  const nowVal = new Map(after.map((r) => [r.key, r.value]));
  const keys: KeyWas[] = [...before.keys].map(([key, was]) => ({ key, was, now: nowVal.get(key) ?? null })).filter((k) => k.was !== k.now);
  // A trace's own request tick is new: nothing was there before it.
  if (created.length) {
    const ticks = await prisma.appSetting.findMany({ where: { key: { in: created.map((t) => requestTickKey(t.id)) } }, select: { key: true, value: true } });
    for (const t of ticks) keys.push({ key: t.key, was: null, now: t.value });
  }
  const moved: TaskWas[] = tasks.flatMap((t) => {
    const b = before.tasks.get(t.id);
    return b && b.status !== t.status ? [{ id: t.id, title: b.title, status: b.status, completedAt: b.completedAt, delegation: b.delegation, nowStatus: t.status }] : [];
  });
  if (!keys.length && !moved.length && !created.length) return null;
  const client = before.clientId ? await prisma.client.findUnique({ where: { id: before.clientId }, select: { name: true } }).catch(() => null) : null;
  const rec: HandledRecord = {
    v: 1, id: newId(), atISO: now.toISOString(), by: who.name, clientId: before.clientId,
    label: client?.name ?? threadLabel(before.threadKey ?? null), family: before.family, reason: (before.reason ?? "").trim() || null,
    keys, tasks: moved, created: created.map((t) => t.id), undoneAtISO: null, undoneBy: null,
  };
  await prisma.appSetting.create({ data: { key: `${UNDO_PREFIX}${rec.id}`, value: JSON.stringify(rec) } });
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: UNDO_PREFIX }, updatedAt: { lt: new Date(now.getTime() - UNDO_DAYS * 86_400_000) } } }).catch(() => undefined);
  return rec.id;
}

/** "p:2155551234" → "(215) 555-1234"; "e:jimenez|javier" → "Javier Jimenez" (pure). */
export function threadLabel(threadKey: string | null): string {
  const k = (threadKey ?? "").trim();
  const p = /^p:(\d{3})(\d{3})(\d{4})$/.exec(k);
  if (p) return `(${p[1]}) ${p[2]}-${p[3]}`;
  const e = /^e:([^|#@]+)\|([^#]+)/.exec(k);
  if (e) return `${e[2]} ${e[1]}`.replace(/\b\w/g, (c) => c.toUpperCase());
  return k.replace(/^[a-z]:/, "").split("#")[0] || "A conversation";
}

function parse(raw: string | null | undefined): HandledRecord | null {
  try { const r = JSON.parse(raw ?? "") as HandledRecord; return r?.v === 1 && typeof r.id === "string" ? r : null; } catch { return null; }
}

export type UndoResult = { ok: boolean; message: string };

export async function undoHandled(id: string, who: { name: string | null; email: string | null }, now: Date = new Date()): Promise<UndoResult> {
  const row = await prisma.appSetting.findUnique({ where: { key: `${UNDO_PREFIX}${id}` } });
  const rec = parse(row?.value);
  if (!rec) return { ok: false, message: "That can't be reopened any more. Find the conversation in Messages." };
  if (rec.undoneAtISO) return { ok: true, message: `Already back on the list: ${rec.label}.` };
  let skipped = 0;
  await prisma.$transaction(async (tx) => {
    for (const k of rec.keys) {
      const cur = (await tx.appSetting.findUnique({ where: { key: k.key }, select: { value: true } }))?.value ?? null;
      if (cur !== k.now) { skipped++; continue; } // changed since the tick: theirs now
      if (k.was == null) await tx.appSetting.deleteMany({ where: { key: k.key } });
      else await tx.appSetting.update({ where: { key: k.key }, data: { value: k.was } });
    }
    for (const t of rec.tasks) {
      const cur = await tx.smartTask.findUnique({ where: { id: t.id }, select: { status: true } });
      if (!cur || cur.status !== t.nowStatus) { skipped++; continue; }
      await tx.smartTask.update({ where: { id: t.id }, data: { status: t.status, completedAt: t.completedAt ? new Date(t.completedAt) : null, delegation: t.delegation } });
    }
    if (rec.created.length) await tx.smartTask.updateMany({ where: { id: { in: rec.created }, status: "COMPLETED" }, data: { status: "CANCELLED" } });
    const done: HandledRecord = { ...rec, undoneAtISO: now.toISOString(), undoneBy: who.name };
    await tx.appSetting.update({ where: { key: `${UNDO_PREFIX}${id}` }, data: { value: JSON.stringify(done) } });
    await tx.auditLog.create({
      data: {
        actor: who.email ?? who.name ?? "unknown", action: "comms_handled_undone", target: rec.clientId ?? rec.label,
        detail: JSON.stringify({ label: rec.label, handledAt: rec.atISO, handledBy: rec.by, reason: rec.reason, rows: rec.keys.length, tasks: rec.tasks.map((t) => t.id), skipped }),
      },
    });
  });
  return { ok: true, message: skipped ? `Reopened ${rec.label}. Some of it changed since (a reply or a newer tick), so that part was left as it is.` : `Reopened: ${rec.label} is back on the list.` };
}

export type HandledRow = { id: string; atISO: string; by: string | null; label: string; family: Family; reason: string | null };

/** Ticks since `since` that are still handled, newest first. */
export async function recentHandled(since: Date): Promise<HandledRow[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: UNDO_PREFIX }, updatedAt: { gte: since } }, select: { value: true }, take: 300 });
  return rows
    .map((r) => parse(r.value))
    .filter((r): r is HandledRecord => !!r && !r.undoneAtISO && Date.parse(r.atISO) >= since.getTime())
    .sort((a, b) => b.atISO.localeCompare(a.atISO))
    .map((r) => ({ id: r.id, atISO: r.atISO, by: r.by, label: r.label, family: r.family, reason: r.reason }));
}
