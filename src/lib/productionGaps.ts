import "server-only";
import { prisma } from "@/lib/prisma";
import { etDate } from "@/lib/datetime";
import { stripMoneySentences } from "@/lib/text";

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
  /** the one video it is about, when it came from that video's brief (§7.5) */
  outputId: string | null;
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
      outputId: g.outputId,
      state: g.state, recovery: (g.recovery as GapRecovery | null) ?? null, ownerKey: g.ownerKey, dueISO: g.dueAt?.toISOString() ?? null,
      shotList, scopeNote: g.scopeNote, resolutionNote: g.resolutionNote,
      overdue: open && !!g.dueAt && g.dueAt.getTime() < now.getTime(),
    };
  });
  return [...views.filter((v) => OPEN_STATES.includes(v.state)), ...views.filter((v) => !OPEN_STATES.includes(v.state))];
}

// ---------------------------------------------------------------------------
// MONEY NEVER REACHES AN EDITOR OR A PHOTOGRAPHER (§4; review, Sep 28 2026).
//
// A gap's words are printed to the editor on /edit/<id> and to the
// photographer on /upload/<id>, and the office writes most of them: a
// limitation on a brief ("Drone was not ordered ($175 add-on). No aerials."),
// a reshoot's scope, how it was settled. The creative rule every brief uses
// drops a sentence that talks money (stripMoneySentences); redactMoney then
// takes out a figure that rule does not know ("the drone fee is 175"). When
// dropping leaves nothing, the words stay with the figure withheld, so a line
// is never blank. Line by line, so a multi-line scope keeps its lines.
// ---------------------------------------------------------------------------
export async function moneySafeWords(text: string | null | undefined): Promise<string> {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const { redactMoney } = await import("@/lib/hubTools");
  return raw
    .split("\n")
    .map((line) => {
      if (!line.trim()) return "";
      const kept = stripMoneySentences(line).trim();
      return (kept ? redactMoney(kept) : "") || redactMoney(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every gap on a job as an editor or a photographer may read it: the same rows, money taken out of every word the office or the field wrote. */
export async function gapsForCreatives(gaps: GapView[]): Promise<GapView[]> {
  return Promise.all(
    gaps.map(async (g) => ({
      ...g,
      what: (await moneySafeWords(g.what)) || "Missing work (the office has the details)",
      reason: await moneySafeWords(g.reason),
      shotList: await Promise.all(
        g.shotList.map(async (l) => {
          const note = l.note ? await moneySafeWords(l.note) : "";
          return { shot: (await moneySafeWords(l.shot)) || "A shot (the office has the details)", ...(note ? { note } : {}) };
        }),
      ),
      scopeNote: g.scopeNote ? (await moneySafeWords(g.scopeNote)) || null : null,
      resolutionNote: g.resolutionNote ? (await moneySafeWords(g.resolutionNote)) || null : null,
    })),
  );
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

// ---------------------------------------------------------------------------
// A LIMITATION ON A VIDEO'S BRIEF CAN BECOME MISSING WORK (§7.6 × §7.5, Sep 28).
//
// The per-video brief has a "Limitations" section — "no drone, it was
// raining", "the basement was locked". Written there it reached the editor and
// nobody else: no owner, no date, nothing on Kyle's board. One press turns it
// into a production gap on THAT video, attributed to whoever pressed it, with
// the limitation's own words. Nothing is waived, booked or charged; the office
// plans the recovery exactly as for any other gap.
//
// The words are money-safe FROM THE START (review, Sep 28): the gap is read by
// the editor and the photographer, and the brief's own scrub only covers the
// brief. So what, reason and the timeline line are built from moneySafeWords
// of the limitation; the office still has the full text on the brief itself.
// ---------------------------------------------------------------------------
export async function raiseGapFromBrief(input: {
  outputId: string;
  /** when given (a form post), the video must be one of THIS job's */
  projectId?: string | null;
  actor: string;
}): Promise<{ ok: true; id: string; created: boolean } | { ok: false; message: string }> {
  const o = await prisma.deliverableOutput.findUnique({
    where: { id: input.outputId },
    select: { id: true, projectId: true, deliverableId: true, slot: true, title: true, briefJson: true, waivedAt: true, removedFromOrderAt: true },
  });
  if (!o) return { ok: false, message: "That video is not on this job any more." };
  if (input.projectId && o.projectId !== input.projectId) return { ok: false, message: "That video belongs to a different job." };
  if (o.waivedAt || o.removedFromOrderAt) return { ok: false, message: "This video is no longer owed on the job." };
  const { readOutputBrief } = await import("@/lib/deliverableOutputs");
  const brief = readOutputBrief(o.briefJson);
  const limitation = clip(brief?.sections.limitations ?? "", 1000);
  if (!brief || !limitation) return { ok: false, message: "This video's brief has no limitation written down to raise." };
  const slotLabel = await import("@/lib/reviewCuts")
    .then((m) => m.cutSlots(o.projectId))
    .then((ss) => ss.find((x) => x.deliverableId === o.deliverableId && x.slot === o.slot)?.label ?? null)
    .catch(() => null);
  const name = o.title?.trim() || slotLabel || `video ${o.slot}`;
  const actor = clip(input.actor ?? "", 80) || "the office";
  // Never the raw words: see above. Empty only when every sentence was money.
  const said = clip(await moneySafeWords(limitation), 1000);
  const what = clip(`${said ? clip(said, 150) : "A limitation on the brief"} (${name})`, 200);
  const open = await prisma.productionGap.findFirst({
    where: { outputId: o.id, what, state: { in: OPEN_STATES } },
    select: { id: true },
  });
  if (open) return { ok: true, id: open.id, created: false };
  const row = await prisma.productionGap.create({
    data: {
      projectId: o.projectId,
      deliverableId: o.deliverableId,
      outputId: o.id,
      kind: "SHOT",
      what,
      reason: clip(
        said
          ? `Written as a limitation on the brief for ${name} (v${brief.version}): ${said}`
          : `Written as a limitation on the brief for ${name} (v${brief.version}). The office's copy of the brief has the words.`,
        500,
      ),
      raisedBy: actor,
    },
    select: { id: true },
  });
  await prisma.activity
    .create({ data: { projectId: o.projectId, type: "SYSTEM", body: clip(`Missing work raised from the brief for ${name} by ${actor}: ${said || "a limitation on the brief"}`, 1000) } })
    .catch(() => {});
  return { ok: true, id: row.id, created: true };
}

// ---------------------------------------------------------------------------
// ON KYLE'S BOARD (§7.6, Sep 28 2026). An open gap is the thing in the way of
// that job, said the way he would say it: "Missing work: <what> — <owner> by
// <due>". Until the office plans a recovery there is no owner or date, and the
// line says exactly that rather than leaving a blank to read as fine.
// ---------------------------------------------------------------------------
export type BoardGap = { what: string; ownerKey: string | null; dueAt: Date | null; raisedAt: Date };

const shortWhat = (w: string) => {
  const t = w.replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 89).trimEnd()}…` : t;
};

/** One gap's words. `ownerName` is the display name for its ownerKey. Pure. */
export function gapBoardLine(g: BoardGap, ownerName: string | null, now: Date = new Date()): string {
  const head = `Missing work: ${shortWhat(g.what)}`;
  if (!g.ownerKey && !g.dueAt) return `${head} — no owner or date yet`;
  const who = ownerName || g.ownerKey || "nobody yet";
  if (!g.dueAt) return `${head} — ${who}, no date yet`;
  const day = etDate(g.dueAt);
  return g.dueAt.getTime() < now.getTime() ? `${head} — ${who}, was due ${day}` : `${head} — ${who} by ${day}`;
}

/** The board's one line per job: the most pressing open gap, and how many more. Pure. */
export function gapBoardLabel(gaps: BoardGap[], nameOf: (key: string) => string | null, now: Date = new Date()): string | null {
  if (gaps.length === 0) return null;
  // Past its date first, then the soonest date, then the oldest raised.
  const rank = (g: BoardGap) => (g.dueAt ? (g.dueAt.getTime() < now.getTime() ? 0 : 1) : 2);
  const first = [...gaps].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
      a.raisedAt.getTime() - b.raisedAt.getTime(),
  )[0];
  const line = gapBoardLine(first, first.ownerKey ? nameOf(first.ownerKey) : null, now);
  return gaps.length > 1 ? `${line} (+${gaps.length - 1} more)` : line;
}

/** Open gaps for many jobs at once, as the board's line per job. One query; a failed read is an empty map. */
export async function openGapLabelsFor(projectIds: string[], now: Date = new Date()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (projectIds.length === 0) return out;
  const rows = await prisma.productionGap
    .findMany({
      where: { projectId: { in: projectIds }, state: { in: OPEN_STATES } },
      select: { projectId: true, what: true, ownerKey: true, dueAt: true, raisedAt: true },
    })
    .catch(() => [] as { projectId: string; what: string; ownerKey: string | null; dueAt: Date | null; raisedAt: Date }[]);
  if (rows.length === 0) return out;
  let names: (key: string) => string | null = (k) => k.charAt(0).toUpperCase() + k.slice(1);
  if (rows.some((r) => r.ownerKey)) {
    const { listAssignees, assigneeName } = await import("@/lib/assignees");
    const list = await listAssignees().catch(() => null);
    if (list) names = (k) => assigneeName(k, list);
  }
  const byJob = new Map<string, BoardGap[]>();
  for (const r of rows) byJob.set(r.projectId, [...(byJob.get(r.projectId) ?? []), r]);
  for (const [id, gaps] of byJob) {
    const label = gapBoardLabel(gaps, names, now);
    if (label) out.set(id, label);
  }
  return out;
}
