import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// WHO IS OUT, AND WHEN (§10 capacity and training — G2, G3, A4, Sep 26 2026).
//
// The Editing Room could say how much work sits on each desk and how fast each
// editor has actually been going (editorWorkload.ts). It could not say that
// John is out Thursday and Friday, that Kim's internet has been down since
// noon, or that Tuesday afternoon is protected training time. Those are facts
// a PERSON knows and the hub had nowhere to put.
//
// A CapacityException is one such fact: who, what kind, from when, until when,
// why, and who wrote it down. That is ALL it is:
//   · the hub records the decision; it never makes one. Nothing here reassigns
//     a job, moves a due date, pages anybody's backup or re-plans the queue.
//   · no hours maths. "Out Thu–Fri" is shown as that sentence, never turned
//     into "16 hours of capacity lost" — the workload panel has no invented
//     hours anywhere, and this does not start.
//   · no payroll. Time off here is not a pay record, and nothing that computes
//     pay reads this table (the drill proves the payroll inputs are identical
//     with and without it).
//
// WHO MAY WRITE ONE: the owner and the office, for anybody — that is where a
// staffing decision is made (a protected training block, a backup editor for a
// week, as TRAINING or OTHER with a note). An EDITOR may record their OWN
// "offline" or "blocked", because they are the first to know and the office
// would otherwise hear about it from a missed deadline. They cannot book their
// own time off here: that is a conversation, not a form.
// ---------------------------------------------------------------------------

export const CAPACITY_KINDS = ["TIME_OFF", "TRAINING", "BLOCKED", "CONNECTIVITY", "OTHER"] as const;
export type CapacityKind = (typeof CAPACITY_KINDS)[number];

export const CAPACITY_LABEL: Record<CapacityKind, string> = {
  TIME_OFF: "Time off",
  TRAINING: "Training",
  BLOCKED: "Blocked",
  CONNECTIVITY: "Offline",
  OTHER: "Other",
};

/** The two kinds an editor may record for themselves. */
export const SELF_SERVICE_KINDS: ReadonlySet<CapacityKind> = new Set(["CONNECTIVITY", "BLOCKED"]);

const DAY = 86_400_000;
/** How far ahead the Editing Room looks for "coming up". */
export const CAPACITY_LOOKAHEAD_DAYS = 7;
/** A ceiling on one entry: a leave longer than this is a staffing change, not an exception. */
const MAX_SPAN_DAYS = 90;
const ET = "America/New_York";

export type CapacityActor = {
  name: string;
  realRole: string | null;
  teamMemberId: string | null;
  impersonating: boolean;
} | null;

/** May this person record (or cancel) this kind of entry for this person?
 *  `actor` null = no session, which only local dev allows (the guards' rule). */
export function mayRecordCapacity(
  actor: CapacityActor,
  target: { teamMemberId: string; kind: CapacityKind },
  opts: { authEnforced: boolean },
): { ok: true } | { ok: false; why: string } {
  if (!actor) return opts.authEnforced ? { ok: false, why: "Please sign in to do that." } : { ok: true };
  if (actor.impersonating) return { ok: false, why: "You're previewing another user — exit the preview to make changes." };
  if (actor.realRole === "OWNER" || actor.realRole === "ADMIN") return { ok: true };
  if (actor.realRole === "EDITOR") {
    if (!actor.teamMemberId) return { ok: false, why: "Your login isn't linked to a roster profile yet — ask Jordan or Kyle." };
    if (actor.teamMemberId !== target.teamMemberId) return { ok: false, why: "You can only record your own availability." };
    if (!SELF_SERVICE_KINDS.has(target.kind)) return { ok: false, why: "Tell Jordan or Kyle about time off or training — you can record being offline or blocked yourself." };
    return { ok: true };
  }
  return { ok: false, why: "You don't have access to do that." };
}

export type CapacityInput = {
  teamMemberId: string;
  kind: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  note?: string | null;
};

type Clean = { teamMemberId: string; kind: CapacityKind; startsAt: Date; endsAt: Date | null; note: string | null };

/** Check an entry's shape. Pure — the action and the drill share it. */
export function validateCapacity(input: CapacityInput): { ok: true; value: Clean } | { ok: false; why: string } {
  const kind = input.kind as CapacityKind;
  if (!(CAPACITY_KINDS as readonly string[]).includes(kind)) return { ok: false, why: "Pick what kind of time this is." };
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, why: "That start isn't a real date." };
  let endsAt: Date | null = null;
  if (input.endsAt != null && input.endsAt !== "") {
    endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime())) return { ok: false, why: "That end isn't a real date." };
    if (endsAt <= startsAt) return { ok: false, why: "The end has to be after the start." };
    if (endsAt.getTime() - startsAt.getTime() > MAX_SPAN_DAYS * DAY) return { ok: false, why: `Keep one entry under ${MAX_SPAN_DAYS} days — longer is a staffing change; tell Jordan.` };
  }
  const note = (input.note ?? "").trim() || null;
  if (note && note.length > 300) return { ok: false, why: "Keep the note under 300 characters." };
  if (!input.teamMemberId) return { ok: false, why: "Pick whose time this is." };
  return { ok: true, value: { teamMemberId: input.teamMemberId, kind, startsAt, endsAt, note } };
}

export async function recordCapacityException(
  input: CapacityInput,
  actor: CapacityActor,
  opts: { authEnforced: boolean },
): Promise<{ ok: boolean; message: string; id?: string }> {
  const v = validateCapacity(input);
  if (!v.ok) return { ok: false, message: v.why };
  const may = mayRecordCapacity(actor, { teamMemberId: v.value.teamMemberId, kind: v.value.kind }, opts);
  if (!may.ok) return { ok: false, message: may.why };
  const tm = await prisma.teamMember.findUnique({ where: { id: v.value.teamMemberId }, select: { id: true, name: true, active: true } });
  if (!tm || !tm.active) return { ok: false, message: "That person isn't on the active roster." };
  const row = await prisma.capacityException.create({
    data: { ...v.value, recordedBy: actor?.name ?? "The office" },
    select: { id: true },
  });
  // An editor telling the office they are offline or stuck is the one entry the
  // office needs to HEAR about, not just find later. A bell row for the office;
  // nothing to a phone, nothing to a client.
  const self = !!actor && actor.realRole === "EDITOR";
  if (self) {
    try {
      const { notifyInApp } = await import("@/lib/notify");
      await notifyInApp({
        kind: "capacity_exception",
        title: `${tm.name.split(/\s+/)[0]}: ${CAPACITY_LABEL[v.value.kind].toLowerCase()} ${spanWords(v.value.startsAt, v.value.endsAt, new Date())}`.slice(0, 90),
        body: v.value.note ?? undefined,
        href: "/people/capacity",
        targets: [{ roles: ["OWNER", "ADMIN"] }],
        dedupeKey: `capacity-${row.id}`,
      });
    } catch { /* the row is the record; the bell is a courtesy */ }
  }
  return { ok: true, id: row.id, message: `Recorded: ${tm.name} — ${CAPACITY_LABEL[v.value.kind].toLowerCase()} ${spanWords(v.value.startsAt, v.value.endsAt, new Date())}.` };
}

export async function cancelCapacityException(
  id: string,
  actor: CapacityActor,
  opts: { authEnforced: boolean },
): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.capacityException.findUnique({ where: { id }, select: { id: true, teamMemberId: true, kind: true, cancelledAt: true } });
  if (!row) return { ok: false, message: "That entry no longer exists." };
  const kind = (CAPACITY_KINDS as readonly string[]).includes(row.kind) ? (row.kind as CapacityKind) : "OTHER";
  const may = mayRecordCapacity(actor, { teamMemberId: row.teamMemberId, kind }, opts);
  if (!may.ok) return { ok: false, message: may.why };
  if (row.cancelledAt) return { ok: true, message: "Already cancelled." };
  // Conditional, so two presses write one cancel. Cancelled, never deleted: the
  // register keeps what was decided and when.
  const done = await prisma.capacityException.updateMany({
    where: { id, cancelledAt: null },
    data: { cancelledAt: new Date(), cancelledBy: actor?.name ?? "The office" },
  });
  return { ok: true, message: done.count ? "Cancelled." : "Already cancelled." };
}

// ---- reading -------------------------------------------------------------------

export type CapacityChip = {
  id: string;
  kind: CapacityKind;
  label: string;
  /** "until Fri 5:00 PM", "Thu Oct 1 – Fri Oct 2", "since Tue, no end set" */
  when: string;
  note: string | null;
  startsAtISO: string;
  endsAtISO: string | null;
  recordedBy: string;
};

export type CapacityWindows = { now: CapacityChip[]; next7d: CapacityChip[] };

const dayWord = (d: Date) => d.toLocaleDateString("en-US", { timeZone: ET, weekday: "short", month: "short", day: "numeric" });
const timeWord = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const sameEtDay = (a: Date, b: Date) => dayWord(a) === dayWord(b);

/** Midnight ET: an entry that ends at the start of a day ends the day before. */
const etMidnight = (d: Date) => timeWord(d) === "12:00 AM";

/** The span in words, ET. Never a number of hours. Whole days read as days:
 *  Thu 00:00 → Sat 00:00 is "Thu, Oct 1 – Fri, Oct 2", not "– Sat". */
export function spanWords(startsAt: Date, endsAt: Date | null, now: Date): string {
  const started = startsAt <= now;
  if (!endsAt) return started ? `since ${dayWord(startsAt)}, no end set` : `from ${dayWord(startsAt)} ${timeWord(startsAt)}, no end set`;
  const lastDay = etMidnight(endsAt) ? new Date(endsAt.getTime() - 1) : endsAt;
  if (started) {
    if (etMidnight(endsAt)) return sameEtDay(lastDay, now) ? "until the end of today" : `through ${dayWord(lastDay)}`;
    return sameEtDay(endsAt, now) ? `until ${timeWord(endsAt)} today` : `until ${dayWord(endsAt)} ${timeWord(endsAt)}`;
  }
  if (etMidnight(startsAt) && etMidnight(endsAt)) return sameEtDay(startsAt, lastDay) ? `${dayWord(startsAt)}, all day` : `${dayWord(startsAt)} – ${dayWord(lastDay)}`;
  if (sameEtDay(startsAt, endsAt)) return `${dayWord(startsAt)}, ${timeWord(startsAt)}–${timeWord(endsAt)}`;
  return `${dayWord(startsAt)} ${timeWord(startsAt)} – ${dayWord(endsAt)} ${timeWord(endsAt)}`;
}

const chipOf = (r: { id: string; kind: string; startsAt: Date; endsAt: Date | null; note: string | null; recordedBy: string }, now: Date): CapacityChip => {
  const kind = (CAPACITY_KINDS as readonly string[]).includes(r.kind) ? (r.kind as CapacityKind) : "OTHER";
  return {
    id: r.id,
    kind,
    label: CAPACITY_LABEL[kind],
    when: spanWords(r.startsAt, r.endsAt, now),
    note: r.note,
    startsAtISO: r.startsAt.toISOString(),
    endsAtISO: r.endsAt?.toISOString() ?? null,
    recordedBy: r.recordedBy,
  };
};

/** Live and upcoming entries for these people: `now` is in force at this
 *  moment, `next7d` starts within the next week. Cancelled or finished entries
 *  are gone on the next read — there is nothing to expire. */
export async function capacityWindows(teamMemberIds: string[], at: Date = new Date()): Promise<Map<string, CapacityWindows>> {
  const out = new Map<string, CapacityWindows>();
  const ids = [...new Set(teamMemberIds.filter(Boolean))];
  if (!ids.length) return out;
  const horizon = new Date(at.getTime() + CAPACITY_LOOKAHEAD_DAYS * DAY);
  const rows = await prisma.capacityException.findMany({
    where: {
      teamMemberId: { in: ids },
      cancelledAt: null,
      startsAt: { lte: horizon },
      OR: [{ endsAt: null }, { endsAt: { gt: at } }],
    },
    orderBy: { startsAt: "asc" },
    select: { id: true, teamMemberId: true, kind: true, startsAt: true, endsAt: true, note: true, recordedBy: true },
  });
  for (const r of rows) {
    const w = out.get(r.teamMemberId) ?? { now: [], next7d: [] };
    (r.startsAt <= at ? w.now : w.next7d).push(chipOf(r, at));
    out.set(r.teamMemberId, w);
  }
  return out;
}

export type CapacityRegisterRow = CapacityChip & {
  teamMemberId: string;
  person: string;
  state: "now" | "upcoming" | "ended" | "cancelled";
  cancelledBy: string | null;
  createdAtISO: string;
};

/** The register: everything current or upcoming, and the last 30 days of what
 *  ended or was cancelled, newest first. `onlyTeamMemberId` scopes an editor to
 *  their own entries. */
export async function capacityRegister(opts: { at?: Date; onlyTeamMemberId?: string | null } = {}): Promise<CapacityRegisterRow[]> {
  const at = opts.at ?? new Date();
  const since = new Date(at.getTime() - 30 * DAY);
  const rows = await prisma.capacityException.findMany({
    where: {
      ...(opts.onlyTeamMemberId ? { teamMemberId: opts.onlyTeamMemberId } : {}),
      OR: [{ endsAt: null }, { endsAt: { gt: since } }, { createdAt: { gt: since } }],
    },
    orderBy: { startsAt: "desc" },
    take: 200,
  });
  const names = new Map(
    (await prisma.teamMember.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.teamMemberId))] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]),
  );
  return rows.map((r) => ({
    ...chipOf(r, at),
    teamMemberId: r.teamMemberId,
    person: names.get(r.teamMemberId) ?? "Someone who left",
    state: r.cancelledAt ? "cancelled" : r.endsAt && r.endsAt <= at ? "ended" : r.startsAt <= at ? "now" : "upcoming",
    cancelledBy: r.cancelledBy,
    createdAtISO: r.createdAt.toISOString(),
  }));
}
