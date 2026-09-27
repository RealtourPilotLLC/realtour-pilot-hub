import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// MISSING WORK AND RESHOOTS (§7.6, Sep 25 2026).
//
// Before this, a missing OUTPUT was one of two cards ("Confirm: Video not
// required?" per deliverable, AND "Video marked not completable" per job —
// Kyle got two for one reel), a missed SHOT inside a delivered category was a
// free-text flag with no owner or date, and a reshoot had no shot list or
// scope anywhere. A ProductionGap is the one record of each: what is missing,
// why, the recovery chosen, who owns it and by when.
//
// WHAT IT NEVER DOES: set Deliverable.waivedAt (only the office's "Not
// required" does — and that RESOLVES the gap with its note), create an Aryeo
// order or appointment, or charge anybody. A reshoot is booked by a person
// (or the gated session path); this records that one is owed and what it is.
//
// States: OPEN (raised) → PLANNED (a recovery, owner and date chosen) →
// RESOLVED (done, or the office said not required) | CANCELLED (withdrawn,
// uploaded after all, off the order). Never deleted.
// ---------------------------------------------------------------------------

export type GapKind = "OUTPUT" | "SHOT";
export type GapRecovery = "RESHOOT" | "CLIENT_SUPPLIES" | "USE_EXISTING" | "OFFICE_DECIDES";
export const GAP_RECOVERIES: readonly GapRecovery[] = ["RESHOOT", "CLIENT_SUPPLIES", "USE_EXISTING", "OFFICE_DECIDES"];
export const RECOVERY_LABEL: Record<GapRecovery, string> = {
  RESHOOT: "Reshoot",
  CLIENT_SUPPLIES: "The client supplies it",
  USE_EXISTING: "Use what we already have",
  OFFICE_DECIDES: "The office decides",
};
const OPEN_STATES = ["OPEN", "PLANNED"];

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * A whole ordered item the photographer could not deliver ("couldn't
 * complete" on the wrap-up). One open gap per deliverable: a re-worded reason
 * updates it rather than stacking a second.
 */
export async function recordOutputGap(input: {
  projectId: string;
  deliverableId: string;
  what: string;
  reason: string;
  raisedBy: string;
}): Promise<{ id: string; created: boolean }> {
  const reason = clip(input.reason, 500);
  const open = await prisma.productionGap.findFirst({
    where: { deliverableId: input.deliverableId, kind: "OUTPUT", state: { in: OPEN_STATES } },
    select: { id: true, reason: true },
    orderBy: { createdAt: "asc" },
  });
  if (open) {
    if (open.reason !== reason) await prisma.productionGap.update({ where: { id: open.id }, data: { reason } });
    return { id: open.id, created: false };
  }
  const row = await prisma.productionGap.create({
    data: {
      projectId: input.projectId,
      deliverableId: input.deliverableId,
      kind: "OUTPUT",
      what: clip(input.what, 200),
      reason,
      raisedBy: clip(input.raisedBy, 80) || "the photographer",
    },
    select: { id: true },
  });
  return { id: row.id, created: true };
}

/**
 * Bring a deliverable's OUTPUT gap in line with the deliverable itself. Called
 * from the one place every change of that answer already passes through
 * (tasks.confirmNotRequiredTask — the photographer's reason, the office's
 * waive, the order losing the line). Idempotent.
 */
export async function syncOutputGap(deliverableId: string, taskId?: string | null): Promise<void> {
  const d = await prisma.deliverable.findUnique({
    where: { id: deliverableId },
    select: {
      id: true, projectId: true, type: true, label: true, notCompletedReason: true, uploadedAt: true,
      waivedAt: true, waivedBy: true, waivedNote: true, removedFromOrderAt: true,
    },
  });
  if (!d) return;
  const now = new Date();
  const openWhere = { deliverableId, kind: "OUTPUT", state: { in: OPEN_STATES } };
  if (d.waivedAt) {
    await prisma.productionGap.updateMany({
      where: openWhere,
      data: {
        state: "RESOLVED", resolvedAt: now, resolvedBy: d.waivedBy ?? "the office",
        resolutionNote: clip(`Marked not required${d.waivedNote ? `: ${d.waivedNote}` : ""}`, 500),
      },
    });
    return;
  }
  if (d.removedFromOrderAt || !d.notCompletedReason) {
    await prisma.productionGap.updateMany({
      where: openWhere,
      data: {
        state: "CANCELLED", resolvedAt: now, resolvedBy: "system",
        resolutionNote: d.removedFromOrderAt
          ? "The item came off the order."
          : d.uploadedAt
            ? "Marked uploaded after all."
            : "The photographer withdrew the reason.",
      },
    });
    return;
  }
  // Still owed and still explained: make sure the record exists (a backstop
  // for a reason saved before this table did) and points at the office's card.
  const { DELIVERABLE_META } = await import("@/lib/pipeline");
  const what = d.label ?? DELIVERABLE_META[d.type as keyof typeof DELIVERABLE_META]?.label ?? d.type;
  const g = await recordOutputGap({ projectId: d.projectId, deliverableId, what, reason: d.notCompletedReason, raisedBy: "the photographer" });
  if (taskId) await prisma.productionGap.updateMany({ where: { id: g.id, taskId: null }, data: { taskId } });
}

/**
 * A SHOT that was missed inside something that was delivered — "didn't get
 * the pool at dusk", "the basement was locked". Recorded as a gap with no
 * owner yet; the photographer's words also go to the job's one field-flag loop
 * (the caller does that), so Kyle hears it the way he hears every field flag.
 */
export async function recordShotGap(input: {
  projectId: string;
  what: string;
  reason: string;
  raisedBy: string;
  deliverableId?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const what = clip(input.what, 200);
  const open = await prisma.productionGap.findFirst({
    where: { projectId: input.projectId, kind: "SHOT", what, state: { in: OPEN_STATES } },
    select: { id: true },
  });
  if (open) return { id: open.id, created: false };
  const row = await prisma.productionGap.create({
    data: {
      projectId: input.projectId,
      deliverableId: input.deliverableId ?? null,
      kind: "SHOT",
      what,
      reason: clip(input.reason, 500),
      raisedBy: clip(input.raisedBy, 80) || "the photographer",
    },
    select: { id: true },
  });
  return { id: row.id, created: true };
}

export type ShotLine = { shot: string; note?: string };

/**
 * The office chooses how the gap is recovered. A RESHOOT must say what to
 * shoot (at least one line) and its scope — "a reshoot" with no list is the
 * vague promise this exists to replace. Nothing is booked, waived or charged.
 */
export async function planRecovery(
  gapId: string,
  input: { recovery: string; ownerKey: string; dueAt: Date | string; shotList?: ShotLine[]; scopeNote?: string | null },
  actor: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const recovery = input.recovery as GapRecovery;
  if (!GAP_RECOVERIES.includes(recovery)) return { ok: false, message: "Pick how it will be recovered." };
  const ownerKey = clip(input.ownerKey ?? "", 64).toLowerCase();
  if (!ownerKey) return { ok: false, message: "Say who owns the recovery." };
  const due = input.dueAt instanceof Date ? input.dueAt : new Date(input.dueAt);
  if (Number.isNaN(due.getTime())) return { ok: false, message: "Give it a date it has to be done by." };
  const shots = (input.shotList ?? [])
    .map((l) => ({ shot: clip(l?.shot ?? "", 200), ...(l?.note?.trim() ? { note: clip(l.note, 500) } : {}) }))
    .filter((l) => l.shot)
    .slice(0, 40);
  const scopeNote = clip(input.scopeNote ?? "", 1000);
  if (recovery === "RESHOOT" && shots.length === 0) return { ok: false, message: "A reshoot needs its shot list — at least one shot." };
  if (recovery === "RESHOOT" && !scopeNote) return { ok: false, message: "A reshoot needs its scope — what is and is not being reshot." };
  const r = await prisma.productionGap.updateMany({
    where: { id: gapId, state: { in: OPEN_STATES } },
    data: {
      recovery,
      ownerKey,
      dueAt: due,
      shotListJson: shots.length ? JSON.stringify(shots) : null,
      scopeNote: scopeNote || null,
      state: "PLANNED",
    },
  });
  if (r.count === 0) return { ok: false, message: "That gap is already closed." };
  const g = await prisma.productionGap.findUnique({ where: { id: gapId }, select: { projectId: true, what: true } });
  if (g) {
    await prisma.activity.create({
      data: {
        projectId: g.projectId,
        type: "SYSTEM",
        body: clip(`Recovery planned for "${g.what}" by ${actor}: ${RECOVERY_LABEL[recovery]}, owned by ${ownerKey}, due ${due.toISOString().slice(0, 10)}.${shots.length ? ` ${shots.length} shot${shots.length === 1 ? "" : "s"} listed.` : ""}`, 1000),
      },
    }).catch(() => {});
  }
  return { ok: true };
}

/** Close a gap by hand — recovered, or no longer needed — with the reason on the row. */
export async function closeGap(gapId: string, how: "RESOLVED" | "CANCELLED", note: string, actor: string): Promise<{ ok: boolean; message?: string }> {
  const text = clip(note, 500);
  if (!text) return { ok: false, message: "Say how it was settled — that note is the record." };
  const r = await prisma.productionGap.updateMany({
    where: { id: gapId, state: { in: OPEN_STATES } },
    data: { state: how, resolvedAt: new Date(), resolvedBy: clip(actor, 80), resolutionNote: text },
  });
  return r.count === 1 ? { ok: true } : { ok: false, message: "That gap is already closed." };
}

export type GapView = {
  id: string; kind: GapKind; what: string; reason: string; raisedBy: string; raisedAtISO: string;
  state: string; recovery: GapRecovery | null; ownerKey: string | null; dueISO: string | null;
  shotList: ShotLine[]; scopeNote: string | null; resolutionNote: string | null;
  /** past its date and still not closed */
  overdue: boolean;
};

/** Every gap on a job, open ones first. Never silently dropped: closed ones stay listed with their note. */
export async function gapsForProject(projectId: string, now: Date = new Date()): Promise<GapView[]> {
  const rows = await prisma.productionGap.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }] });
  const views = rows.map((g): GapView => {
    let shotList: ShotLine[] = [];
    try { shotList = g.shotListJson ? (JSON.parse(g.shotListJson) as ShotLine[]) : []; } catch { /* shape-tolerant */ }
    const open = OPEN_STATES.includes(g.state);
    return {
      id: g.id, kind: g.kind as GapKind, what: g.what, reason: g.reason, raisedBy: g.raisedBy, raisedAtISO: g.raisedAt.toISOString(),
      state: g.state, recovery: (g.recovery as GapRecovery | null) ?? null, ownerKey: g.ownerKey, dueISO: g.dueAt?.toISOString() ?? null,
      shotList, scopeNote: g.scopeNote, resolutionNote: g.resolutionNote,
      overdue: open && !!g.dueAt && g.dueAt.getTime() < now.getTime(),
    };
  });
  return [...views.filter((v) => OPEN_STATES.includes(v.state)), ...views.filter((v) => !OPEN_STATES.includes(v.state))];
}

/** Is a whole OUTPUT of this job being handled as a gap right now? */
export async function hasOpenOutputGap(projectId: string, types?: string[]): Promise<boolean> {
  const rows = await prisma.productionGap.findMany({
    where: { projectId, kind: "OUTPUT", state: { in: OPEN_STATES } },
    select: { deliverableId: true },
  });
  if (!types || rows.length === 0) return rows.length > 0;
  const ids = rows.map((r) => r.deliverableId).filter((x): x is string => !!x);
  if (ids.length === 0) return false;
  return (await prisma.deliverable.count({ where: { id: { in: ids }, type: { in: types as never[] } } })) > 0;
}
