import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// A FILE THE WORK CANNOT START WITHOUT (§10 assets/special corrections — J3,
// Sep 26 2026).
//
// Some work waits on a thing only the client or a record can supply: the
// client's logo file for an intro card, the recorded plat or survey before
// anybody draws lot lines on an aerial. Until now that wait lived in someone's
// head. The "Lot Lines" product maps to OTHER, so the job carried a line nobody
// owned, and the only way to learn what it needed was to ask Jordan.
//
// A dependency is TWO tasks, because they are two jobs done by different people:
//   · RETRIEVAL (asset_dependency) — find the file and attach it. Kyle's, by
//     his established role. Open at once.
//   · INTERPRETATION (asset_interpretation) — read or draw from it. A named
//     specialist, or Jordan. BLOCKED until the file is attached, with the
//     missing reference named in blockedReason.
// Both carry SmartTask.outputId when the dependency is for ONE video, so the
// brief for video 2 lists it and video 1's does not; a job-level dependency
// (lot lines on the aerials) carries its category instead.
//
// RULES:
//   · Attaching the file closes RETRIEVAL ONLY. Interpretation is its own work.
//   · Boundary, lot-line, acreage or survey facts come ONLY from an attached
//     document. Nothing here — and no AI prompt that reads a brief — states or
//     estimates them (revisionBrief's rule 11 says the same to the model).
//   · Nothing is client-facing. No message, no promise, no portal change.
//   · Idempotent: the same dependency on a rerun is the same two rows.
// ---------------------------------------------------------------------------

export const RETRIEVAL_TASK = "asset_dependency";
export const INTERPRETATION_TASK = "asset_interpretation";

export type AssetDependencyInput = {
  projectId: string;
  /** DeliverableOutput id — the one video this is for; null = the whole job/category */
  outputId?: string | null;
  /** a deliverable category when it is not one output (e.g. "OTHER" for lot lines) */
  category?: string | null;
  /** stable id for the thing needed: "lot-lines-plat", "client-logo" */
  slug: string;
  /** the missing reference, in words: "the recorded plat or survey for the lot lines" */
  need: string;
  /** who reads or draws from it; omit when retrieval is the whole job */
  interpretation?: { what: string; ownerKey?: string | null } | null;
  /** "system" for an engine (an order line), else the person's name */
  by: string;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** A dependency's id. Exported so the job page's card (which derives it from
 *  the words typed) and its drill test the same rule the server applies. */
export const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(s);

/** Who the office may name to read or draw from a file (personFor below puts
 *  each on a roster row): Jordan — the default, and the only one for property
 *  lines — Kyle, and the two in-house editors. The job page offers these and
 *  nothing else, and anything else is refused rather than written as a key no
 *  board knows (Sep 28). */
export const INTERPRETER_KEYS = ["jordan", "kyle", "kim", "john"] as const;

/** The pair's keys. Scope = the output, else the category, else the job. */
export function assetKeys(projectId: string, scope: { outputId?: string | null; category?: string | null }, slug: string) {
  const base = `asset-dep:${projectId}:${scope.outputId ?? scope.category ?? "job"}:${slug}`;
  return { retrieval: base, interpretation: `${base}:interpret` };
}

async function personFor(key: string): Promise<{ key: string; teamMemberId: string | null }> {
  if (key === "jordan") {
    // Jordan's roster row: the fallback review seat, else the owner's login.
    const { reviewRoomRules } = await import("@/lib/settings");
    const rules = await reviewRoomRules().catch(() => null);
    const owner = rules?.fallbackReviewerTeamMemberId
      ? null
      : await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE" }, select: { teamMemberId: true } }).catch(() => null);
    return { key, teamMemberId: rules?.fallbackReviewerTeamMemberId ?? owner?.teamMemberId ?? null };
  }
  const { editorTeamMemberId } = await import("@/lib/editors");
  const tm = key === "kyle"
    ? await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } }).catch(() => null)
    : null;
  return { key, teamMemberId: tm?.id ?? (await editorTeamMemberId(key)) };
}

/** Record a dependency: the retrieval task (open) and, when someone must read
 *  or draw from the file, the interpretation task (blocked on it). */
export async function recordAssetDependency(input: AssetDependencyInput): Promise<{ ok: boolean; message: string; created: number }> {
  if (!slugOk(input.slug)) return { ok: false, message: "That dependency needs a short id.", created: 0 };
  const need = input.need.trim();
  if (!need) return { ok: false, message: "Say what file is needed.", created: 0 };
  const ownerKey = input.interpretation?.what ? input.interpretation.ownerKey || null : null;
  if (ownerKey && !(INTERPRETER_KEYS as readonly string[]).includes(ownerKey)) {
    return { ok: false, message: "Pick who works from the file: Jordan, Kyle, Kim or John Mark.", created: 0 };
  }
  const p = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, title: true, clientId: true } });
  if (!p) return { ok: false, message: "That job no longer exists.", created: 0 };
  if (input.outputId) {
    const o = await prisma.deliverableOutput.findUnique({ where: { id: input.outputId }, select: { projectId: true } }).catch(() => null);
    if (!o || o.projectId !== p.id) return { ok: false, message: "That video isn't on this job.", created: 0 };
  }
  const street = (p.title || "this job").split(",")[0].trim();
  const keys = assetKeys(p.id, input, input.slug);
  const system = input.by === "system";
  const kyle = await personFor("kyle");
  const shared = {
    projectId: p.id,
    clientId: p.clientId,
    propertyAddress: p.title,
    outputId: input.outputId ?? null,
    deliverableType: input.category ?? null,
    source: system ? "system" : "manual",
    priority: "MEDIUM",
  };
  const rows: Prisma.SmartTaskCreateManyInput[] = [
    {
      ...shared,
      taskType: RETRIEVAL_TASK,
      status: "OPEN",
      title: clip(`Find ${need} — ${street}`, 120),
      summary: clip(
        `Find ${need} and attach it to the job. Until it is attached nobody works from a guess, and nothing is promised to the client.`,
        500,
      ),
      description: need,
      reasonCreated: system ? "The order carries work that needs a file first" : `Recorded by ${input.by}`,
      assignedKey: "kyle",
      ownerId: kyle.teamMemberId,
      dedupeKey: keys.retrieval,
    },
  ];
  if (input.interpretation?.what) {
    const who = await personFor(input.interpretation.ownerKey || "jordan");
    rows.push({
      ...shared,
      taskType: INTERPRETATION_TASK,
      status: "BLOCKED",
      title: clip(`${input.interpretation.what} — ${street}`, 120),
      summary: clip(
        `${input.interpretation.what} from the attached file only — never from a map estimate or a guess. Internal: nothing goes to the client from this until it is checked.`,
        500,
      ),
      description: need,
      reasonCreated: system ? "The order carries work that needs a file first" : `Recorded by ${input.by}`,
      assignedKey: who.key,
      ownerId: who.teamMemberId,
      dedupeKey: keys.interpretation,
      // THE MISSING REFERENCE, BY NAME (the board prints this sentence).
      blockedReason: clip(`Waiting on ${need}`, 200),
    });
  }
  // createMany + skipDuplicates: a rerun, or two sweeps at once, is a no-op —
  // and a retrieval already COMPLETED stays completed.
  const made = await prisma.smartTask.createMany({ data: rows, skipDuplicates: true });
  if (made.count > 0) {
    await prisma.activity
      .create({ data: { projectId: p.id, type: "SYSTEM", body: `Needs ${need} before the work can start${input.interpretation?.what ? ` — ${input.interpretation.what.toLowerCase()} from it once it is attached` : ""}. Kyle to find it.` } })
      .catch(() => {});
  }
  return { ok: true, message: made.count ? `Recorded: ${need}.` : "Already recorded.", created: made.count };
}

/** Attach the file: closes RETRIEVAL only, and unblocks its interpretation. */
export async function attachAssetReference(retrievalTaskId: string, ref: string, by: string): Promise<{ ok: boolean; message: string }> {
  const reference = (ref ?? "").trim();
  if (!reference) return { ok: false, message: "Paste the link or path to the file." };
  if (reference.length > 500) return { ok: false, message: "Keep the link under 500 characters." };
  const t = await prisma.smartTask.findUnique({
    where: { id: retrievalTaskId },
    select: { id: true, taskType: true, dedupeKey: true, projectId: true, status: true, description: true, summary: true },
  });
  if (!t || t.taskType !== RETRIEVAL_TASK || !t.dedupeKey) return { ok: false, message: "That isn't a file to find." };
  const now = new Date();
  // Conditional: two presses attach once.
  const closed = await prisma.smartTask.updateMany({
    where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: {
      status: "COMPLETED",
      completedAt: now,
      sourceDetail: reference,
      summary: clip(`${t.summary ?? ""} Attached by ${by}: ${reference}`.trim(), 500),
    },
  });
  if (!closed.count) return { ok: true, message: "Already attached." };
  await prisma.smartTask.updateMany({
    where: { dedupeKey: `${t.dedupeKey}:interpret`, status: "BLOCKED" },
    data: { status: "OPEN", blockedReason: null, sourceDetail: reference },
  });
  if (t.projectId) {
    await prisma.activity
      .create({ data: { projectId: t.projectId, type: "SYSTEM", body: `${by} attached ${t.description ?? "the file"}: ${reference}` } })
      .catch(() => {});
  }
  return { ok: true, message: "Attached — the next step can start from it." };
}

/** A retrieval closed some other way (the task board's Done) still releases
 *  its interpretation. The sweep runs this; it is the same one-way move. */
export async function releaseAttachedInterpretations(projectId: string): Promise<number> {
  const blocked = await prisma.smartTask.findMany({
    where: { projectId, taskType: INTERPRETATION_TASK, status: "BLOCKED" },
    select: { id: true, dedupeKey: true },
  });
  let released = 0;
  for (const b of blocked) {
    if (!b.dedupeKey?.endsWith(":interpret")) continue;
    const retrieval = await prisma.smartTask.findUnique({ where: { dedupeKey: b.dedupeKey.slice(0, -":interpret".length) }, select: { status: true, sourceDetail: true } });
    if (retrieval?.status !== "COMPLETED") continue;
    const r = await prisma.smartTask.updateMany({
      where: { id: b.id, status: "BLOCKED" },
      data: { status: "OPEN", blockedReason: null, sourceDetail: retrieval.sourceDetail ?? null },
    });
    released += r.count;
  }
  return released;
}

export type OpenAssetDependency = {
  taskId: string;
  outputId: string | null;
  category: string | null;
  stage: "retrieval" | "interpretation";
  owner: string;
  /** one line for a brief: what is missing, or who works from the file */
  sentence: string;
};

/** The open dependencies on a job, for the brief. Retrieval first ("waiting on
 *  the plat"); an interpretation shows once its file is in. */
export async function openAssetDependencies(projectId: string): Promise<OpenAssetDependency[]> {
  const rows = await prisma.smartTask.findMany({
    where: { projectId, taskType: { in: [RETRIEVAL_TASK, INTERPRETATION_TASK] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, taskType: true, status: true, outputId: true, deliverableType: true, description: true, title: true, assignedKey: true, owner: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const nameOf = (r: (typeof rows)[number]) =>
    r.owner?.name?.split(/\s+/)[0] ?? (r.assignedKey ? r.assignedKey.charAt(0).toUpperCase() + r.assignedKey.slice(1) : "Kyle");
  const out: OpenAssetDependency[] = [];
  for (const r of rows) {
    if (r.taskType === INTERPRETATION_TASK && r.status === "BLOCKED") continue; // the retrieval line says it
    const need = r.description ?? "a file";
    out.push({
      taskId: r.id,
      outputId: r.outputId,
      category: r.deliverableType,
      stage: r.taskType === RETRIEVAL_TASK ? "retrieval" : "interpretation",
      owner: nameOf(r),
      sentence:
        r.taskType === RETRIEVAL_TASK
          ? `Waiting on ${need} (${nameOf(r)} to find it)`
          : `${r.title.split(" — ")[0]} (${nameOf(r)}) — from the attached file only`,
    });
  }
  return out;
}

/** Just what one video's brief should carry: its own, plus the job-wide ones. */
export function dependenciesForOutput(all: OpenAssetDependency[], outputId: string | null): OpenAssetDependency[] {
  return all.filter((d) => !d.outputId || d.outputId === outputId);
}

// ---- products that always need a file first -------------------------------------

/** Order lines whose work cannot start without a document. Only what Jordan's
 *  catalogue actually sells — "Lot Lines" today; add a line here as others are
 *  named, never a guess. */
const SPECIAL_CORRECTIONS: { re: RegExp; slug: string; category: string; need: string; interpret: string }[] = [
  {
    re: /\b(lot|property|parcel|boundary)[\s-]*lines?\b/i,
    slug: "lot-lines-plat",
    category: "OTHER",
    need: "the recorded plat or survey for the lot lines",
    interpret: "Draw the lot lines from the attached plat or survey",
  },
];

/** What this order's lines need first. Pure. */
export function specialCorrectionNeeds(titles: string[]): { slug: string; category: string; need: string; interpret: string }[] {
  const out = new Map<string, { slug: string; category: string; need: string; interpret: string }>();
  for (const t of titles) for (const s of SPECIAL_CORRECTIONS) if (s.re.test(t) && !out.has(s.slug)) out.set(s.slug, s);
  return [...out.values()];
}

/** The hourly task sweep's hook: make sure every special line on a live order
 *  has its pair, release interpretations whose file is in, and retire the
 *  system's own pair when the line has gone from the order. Returns rows made. */
export async function ensureSpecialCorrectionDependencies(projectId: string, orderItemTitles: string[]): Promise<number> {
  const needs = specialCorrectionNeeds(orderItemTitles);
  let created = 0;
  for (const n of needs) {
    const r = await recordAssetDependency({
      projectId,
      category: n.category,
      slug: n.slug,
      need: n.need,
      interpretation: { what: n.interpret, ownerKey: "jordan" },
      by: "system",
    });
    created += r.created;
  }
  // ONE read of the job's open asset tasks answers both follow-ups below, and
  // a job with none (nearly every job, every hour) stops here.
  const open = await prisma.smartTask.findMany({
    where: { projectId, taskType: { in: [RETRIEVAL_TASK, INTERPRETATION_TASK] }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true, dedupeKey: true, source: true, taskType: true, status: true },
  });
  if (!open.length) return created;
  // The line came OFF the order: the system's own open pair goes with it (a
  // person's hand-recorded dependency is theirs to close).
  const wanted = new Set(needs.flatMap((n) => Object.values(assetKeys(projectId, { category: n.category }, n.slug))));
  const gone = open
    .filter((s) => s.source === "system" && s.dedupeKey?.startsWith(`asset-dep:${projectId}:`) && !wanted.has(s.dedupeKey))
    .map((s) => s.id);
  if (gone.length) {
    await prisma.smartTask.updateMany({
      where: { id: { in: gone }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "CANCELLED", summary: "The order no longer has this line, so the file is no longer needed." },
    });
  }
  if (open.some((t) => t.taskType === INTERPRETATION_TASK && t.status === "BLOCKED" && !gone.includes(t.id))) {
    await releaseAttachedInterpretations(projectId);
  }
  return created;
}
