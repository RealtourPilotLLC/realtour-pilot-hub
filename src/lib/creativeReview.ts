import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CREATIVE_AREAS, REASON_WORDS, changeLines, creativeReviewOf, isItemKind, kindOf, soundsUnclear,
  type CreativeReviewReason, type CreativeReviewState, type ItemKind,
} from "@/lib/creativeReviewCore";

// ---------------------------------------------------------------------------
// THE CREATIVE REVIEW LANE, SERVER HALF (Oct 15 2026). The vocabulary and the
// rules are in creativeReviewCore.ts; this file reads a work order, decides
// whether it needs creative review, and records the decision.
//
// WHAT HAPPENS when a client's ask needs it (routeCreativeReview):
//   · the vague items are HELD inside the work order (itemsJson: `held: true`)
//     and never become editor issues, so the editor's issue list, self-check
//     and the approval gate never see a feeling as a task;
//   · ONE "Creative review" task opens for Jordan, or James when he is the
//     cut's reviewer in the creative-approver seat, with the client's exact
//     words, and their bell rings;
//   · when nothing concrete is left for the editor, their revision card waits
//     (WAITING_JORDAN, or BLOCKED with the reason when it is James) and the
//     editor is not rung for it (comms.ts reads editorHeldFor).
// WHAT RESOLVES IT (resolveCreativeReview, from the Review Room):
//   · CHANGES — the reviewer types the concrete changes; they replace the held
//     items, keep the client's words as the receipt, and reach the editor;
//   · AS_IS   — the held items go to the editor with the reviewer's reading
//     attached (a note is required);
//   · NOT_NEEDED — nothing to change (settled on a call); a note is required.
// Nothing here messages a client.
// ---------------------------------------------------------------------------

const ANY_ROLE = ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"] as const;
const HELD_PREFIX = "Creative review: ";
const OPEN_TASK = { notIn: ["COMPLETED", "CANCELLED"] };
/** Sources that are the office's own words, never a client's feeling. */
const STAFF_SOURCES = new Set(["review_room_staff", "office"]);

type BriefItem = {
  id: string; area: string; ask: string; detail?: string | null; quote?: string | null;
  cuts?: string[] | null; scope?: string; kind?: ItemKind; held?: boolean;
  interpretation?: string | null; fromReview?: { by: string; at: string } | null;
};
type ItemsDoc = { items?: BriefItem[]; keep?: string[]; references?: unknown[]; questions?: string[]; creativeReview?: CreativeReviewState; [k: string]: unknown };

const parseDoc = (s: string | null | undefined): ItemsDoc => {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? (v as ItemsDoc) : {}; } catch { return {}; }
};
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

export type CreativeReviewer = { key: string; name: string; teamMemberId: string | null; isOwner: boolean };

/**
 * WHO DOES THE CREATIVE REVIEW. James when he is the cut's reviewer AND sits in
 * the creative-approver seat; otherwise Jordan. Never Kyle: creative direction
 * is not the office's call.
 */
export async function creativeReviewerFor(projectId: string, submissionId: string | null): Promise<CreativeReviewer> {
  const owner = await prisma.teamMember.findFirst({ where: { name: { startsWith: "Jordan" } }, select: { id: true, name: true } }).catch(() => null);
  const jordan: CreativeReviewer = { key: "jordan", name: owner?.name ?? "Jordan", teamMemberId: owner?.id ?? null, isOwner: true };
  const sub = submissionId
    ? await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { reviewerTeamMemberId: true } }).catch(() => null)
    : await prisma.reviewSubmission.findFirst({ where: { projectId, reviewerTeamMemberId: { not: null } }, orderBy: { createdAt: "desc" }, select: { reviewerTeamMemberId: true } }).catch(() => null);
  if (!sub?.reviewerTeamMemberId) return jordan;
  const { reviewRoomRules } = await import("@/lib/settings");
  const rules = await reviewRoomRules().catch(() => null);
  if (!rules || rules.creativeApproverTeamMemberId !== sub.reviewerTeamMemberId) return jordan;
  const tm = await prisma.teamMember.findUnique({ where: { id: sub.reviewerTeamMemberId }, select: { id: true, name: true, active: true } }).catch(() => null);
  if (!tm?.active || /^jordan\b/i.test(tm.name)) return jordan;
  const { slugForName } = await import("@/lib/assignees");
  return { key: slugForName(tm.name), name: tm.name, teamMemberId: tm.id, isOwner: false };
}

/** The video keys an item is about, for comparing with earlier asks. */
async function owedKeysOf(projectId: string): Promise<string[]> {
  const { cutSlots, slotKeyOf } = await import("@/lib/reviewCuts");
  return (await cutSlots(projectId).catch(() => [])).map((s) => slotKeyOf(s.deliverableId, s.slot));
}

function itemKeys(it: BriefItem, owed: string[]): string[] {
  const keys = (it.cuts ?? []).filter(Boolean);
  if (keys.length) return keys;
  // "Every video" is every owed video; one owed video is that video.
  if (it.scope === "all") return owed;
  return owed.length === 1 ? [owed[0]] : [];
}

/**
 * Read one work order and decide whether it needs creative review. Writes the
 * item kinds back every time (so the ledger and the card can show them), and
 * holds items only when a reason applies. Never throws; returns the state.
 */
export async function routeCreativeReview(briefId: string, opts: { now?: Date } = {}): Promise<CreativeReviewState | null> {
  try {
    return await route(briefId, opts.now ?? new Date());
  } catch (e) {
    console.error("[creative review] routing failed", briefId, e);
    return null;
  }
}

async function route(briefId: string, now: Date): Promise<CreativeReviewState | null> {
  const brief = await prisma.revisionBrief.findUnique({
    where: { id: briefId },
    select: { id: true, projectId: true, taskId: true, source: true, itemsJson: true, originalText: true, createdAt: true, submissionId: true, outputId: true, roundId: true, analyzedAt: true, requestedBy: true,
      project: { select: { title: true, clientId: true, client: { select: { name: true } } } } },
  });
  if (!brief || STAFF_SOURCES.has(brief.source)) return null;
  const doc = parseDoc(brief.itemsJson);
  // Resolved once is resolved: a re-read never re-holds what a person released.
  if (doc.creativeReview?.state === "RESOLVED") return doc.creativeReview;
  let items: BriefItem[] = Array.isArray(doc.items) ? doc.items : [];
  // Never analysed (a short ask with no model): the whole text is the one ask —
  // and when it is a feeling, it is held like any other.
  if (items.length === 0 && !brief.itemsJson && soundsUnclear(brief.originalText)) {
    items = [{ id: "i1", area: "Overall direction", ask: clip(brief.originalText, 1000), quote: clip(brief.originalText, 1000), detail: null, cuts: null, scope: "unknown" }];
  }
  if (items.length === 0 && !(doc.questions ?? []).length) return null;

  const owed = await owedKeysOf(brief.projectId);
  const reasons = new Set<CreativeReviewReason>();
  const held = new Set<string>();
  for (const it of items) {
    it.kind = kindOf(it);
    if (it.kind === "DIRECTION_UNCLEAR") { held.add(it.id); reasons.add("UNCLEAR"); }
  }
  const questions = (doc.questions ?? []).map((q) => String(q).trim()).filter(Boolean);
  if (questions.length) reasons.add("QUESTIONS");

  // THE SAME PART OF THE SAME VIDEO, AGAIN. An earlier client ask in this area
  // on this video was already changed (addressed, verified, or reopened) and
  // the client is back on it: a creative problem, not an editing one.
  const repeatCandidates = items.filter((it) => !held.has(it.id) && CREATIVE_AREAS.includes(it.area) && it.kind !== "CORRECTION" && it.kind !== "SCOPE");
  if (repeatCandidates.length) {
    const prior = await prisma.revisionIssue.findMany({
      where: {
        projectId: brief.projectId, sourceKind: "BRIEF_ITEM", NOT: { sourceId: { startsWith: `${brief.id}:` } },
        category: { in: [...new Set(repeatCandidates.map((i) => i.area))] }, state: { in: ["ADDRESSED", "VERIFIED", "REOPENED"] },
        createdAt: { lt: brief.createdAt },
      },
      select: { category: true, deliverableId: true, slot: true },
    });
    for (const it of repeatCandidates) {
      const keys = itemKeys(it, owed);
      const hit = prior.some((p) => p.category === it.area && (keys.length === 0 ? owed.length <= 1 : !!p.deliverableId && keys.includes(`${p.deliverableId}:${p.slot ?? 1}`)));
      if (hit) { held.add(it.id); reasons.add("REPEAT_AREA"); }
    }
  }

  // ROUND TWO WANTS A NEW DIRECTION. An "Overall direction" item on a video
  // the client has already asked to change once.
  const direction = items.filter((it) => !held.has(it.id) && it.area === "Overall direction");
  if (direction.length) {
    const round = brief.roundId ? await prisma.contentRevisionRound.findUnique({ where: { id: brief.roundId }, select: { ordinal: true } }).catch(() => null) : null;
    const earlier = await prisma.revisionBrief.findMany({
      where: { projectId: brief.projectId, id: { not: brief.id }, createdAt: { lt: brief.createdAt }, source: { notIn: [...STAFF_SOURCES] } },
      select: { outputId: true, itemsJson: true },
    });
    for (const it of direction) {
      const keys = itemKeys(it, owed);
      const again = (round?.ordinal ?? 0) >= 2 || earlier.some((e) => {
        if (brief.outputId && e.outputId === brief.outputId) return true;
        const theirs = (parseDoc(e.itemsJson).items ?? []).flatMap((x) => itemKeys(x as BriefItem, owed));
        if (keys.length === 0) return owed.length <= 1;
        return theirs.some((k) => keys.includes(k)) || (theirs.length === 0 && owed.length <= 1);
      });
      if (again) { held.add(it.id); reasons.add("ROUND_TWO_DIRECTION"); }
    }
  }

  for (const it of items) it.held = held.has(it.id) ? true : undefined;
  if (reasons.size === 0) {
    // Kinds only. A brief that was held before and no longer needs it (a
    // re-read) gives the editor their card back.
    const wasOpen = doc.creativeReview?.state === "OPEN" ? doc.creativeReview : null;
    const next: ItemsDoc = { ...doc, items };
    delete next.creativeReview;
    await prisma.revisionBrief.update({ where: { id: brief.id }, data: { itemsJson: JSON.stringify(next) } });
    if (wasOpen) await releaseHold(brief.taskId);
    if (wasOpen?.taskId) await prisma.smartTask.updateMany({ where: { id: wasOpen.taskId, status: OPEN_TASK }, data: { status: "CANCELLED", completedAt: now } });
    return null;
  }

  const reviewer = await creativeReviewerFor(brief.projectId, brief.submissionId);
  const unheld = items.filter((it) => !it.held).length;
  const taskHeld = unheld === 0;
  const clientName = brief.project?.client?.name ?? "the client";
  const street = (brief.project?.title ?? "the job").split(",")[0].trim();
  const heldItems = items.filter((it) => it.held);
  const words = [
    ...heldItems.map((it) => `• ${it.quote || it.ask}`),
    ...questions.map((q) => `• Open question: ${q}`),
  ].join("\n");
  const why = [...reasons].map((r) => REASON_WORDS[r]).join("; ");
  const dedupeKey = `creative-review:${brief.id}`;
  const taskData = {
    taskType: "creative_review",
    title: `Creative review — ${street} · ${first(clientName)}`.slice(0, 200),
    summary: clip(`${brief.requestedBy ?? clientName} said: ${heldItems[0]?.quote || heldItems[0]?.ask || questions[0] || ""}`, 300),
    description: [
      `Why this came to you: ${why}.`,
      "",
      "The client's words:",
      words || clip(brief.originalText, 1500),
      "",
      taskHeld
        ? "The editor is waiting: nothing concrete was left for them in this ask. Turn it into changes in the Review Room."
        : `The editor is working the other ${unheld} change${unheld === 1 ? "" : "s"} on this ask meanwhile.`,
    ].join("\n").slice(0, 4000),
    reasonCreated: "A client's feedback needs creative direction before an editor acts on it",
    source: "creative_review",
    priority: "HIGH",
    assignedKey: reviewer.key,
    projectId: brief.projectId,
    clientId: brief.project?.clientId ?? null,
    propertyAddress: brief.project?.title ?? null,
    dueAt: new Date(now.getTime() + 24 * 3_600_000),
    dedupeKey,
  } satisfies Prisma.SmartTaskUncheckedCreateInput;
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
  let taskId: string;
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...taskData, dueAt: undefined, status: ["COMPLETED", "CANCELLED"].includes(existing.status) ? "OPEN" : undefined, completedAt: null } });
    taskId = existing.id;
  } else {
    taskId = (await prisma.smartTask.create({ data: { ...taskData, status: "OPEN" }, select: { id: true } })).id;
  }

  const state: CreativeReviewState = {
    state: "OPEN", taskId, reviewerKey: reviewer.key, reviewerName: reviewer.name, reasons: [...reasons],
    heldItemIds: [...held], questions, taskHeld, openedAt: doc.creativeReview?.openedAt ?? now.toISOString(),
  };
  await prisma.revisionBrief.update({ where: { id: brief.id }, data: { itemsJson: JSON.stringify({ ...doc, items, creativeReview: state }) } });

  // The editor's revision card waits only when there is nothing else on it.
  if (taskHeld && brief.taskId) {
    await prisma.smartTask.updateMany({
      where: { id: brief.taskId, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_EDITOR"] } },
      data: { status: reviewer.isOwner ? "WAITING_JORDAN" : "BLOCKED", blockedReason: `${HELD_PREFIX}${first(reviewer.name)} is turning the client's feedback into concrete changes.` },
    });
  }

  if (!existing) {
    await prisma.activity.create({ data: { projectId: brief.projectId, type: "SYSTEM", body: `Sent to creative review (${first(reviewer.name)}): ${why}.`.slice(0, 500) } }).catch(() => {});
    try {
      const { notifyInApp } = await import("@/lib/notify");
      const href = `/review/${brief.projectId}#creative-review`;
      const targets = reviewer.isOwner || !reviewer.teamMemberId
        ? [{ roles: ["OWNER" as const], href }]
        : [{ roles: [...ANY_ROLE], userKey: `tm:${reviewer.teamMemberId}`, href }, { roles: ["OWNER" as const], href }];
      await notifyInApp({
        kind: "creative_review",
        title: `Creative review — ${street}`,
        body: clip(`${clientName}: ${heldItems[0]?.quote || heldItems[0]?.ask || questions[0] || ""}`, 140),
        href,
        targets,
        dedupeKey: `creative-review-${brief.id}`,
      });
    } catch { /* the task is the durable part */ }
  }
  return state;
}

/** Is the editor's card for this ask waiting on creative review? (comms.ts uses it to keep the editor's bell quiet.) */
export async function editorHeldFor(briefId: string | null | undefined): Promise<boolean> {
  if (!briefId) return false;
  const b = await prisma.revisionBrief.findUnique({ where: { id: briefId }, select: { itemsJson: true } }).catch(() => null);
  const cr = creativeReviewOf(b?.itemsJson);
  return cr?.state === "OPEN" && cr.taskHeld;
}

/** Give the editor's revision card back, but only when this lane is what held it. */
async function releaseHold(revisionTaskId: string | null): Promise<void> {
  if (!revisionTaskId) return;
  await prisma.smartTask.updateMany({
    where: { id: revisionTaskId, status: { in: ["WAITING_JORDAN", "BLOCKED"] }, blockedReason: { startsWith: HELD_PREFIX } },
    data: { status: "OPEN", blockedReason: null },
  });
}

export type ResolveMode = "CHANGES" | "AS_IS" | "NOT_NEEDED";

/**
 * The reviewer's answer. Who may: whoever canRuleOnCuts allows (the caller
 * checks). Returns plain words for the screen.
 */
export async function resolveCreativeReview(input: { briefId: string; mode: ResolveMode; changes?: string | null; note?: string | null; actor: { name: string; userId?: string | null }; now?: Date }): Promise<{ ok: boolean; message: string }> {
  const now = input.now ?? new Date();
  const brief = await prisma.revisionBrief.findUnique({ where: { id: input.briefId }, select: { id: true, projectId: true, taskId: true, itemsJson: true, submissionId: true } });
  if (!brief) return { ok: false, message: "That request no longer exists." };
  const doc = parseDoc(brief.itemsJson);
  const cr = doc.creativeReview;
  if (!cr || cr.state !== "OPEN") return { ok: false, message: "This one isn't waiting on creative review any more." };
  const note = clip(input.note, 1500) || null;
  const lines = input.mode === "CHANGES" ? changeLines(input.changes ?? "") : [];
  if (input.mode === "CHANGES" && lines.length === 0) return { ok: false, message: "Write at least one change for the editor, one per line." };
  if (input.mode !== "CHANGES" && !note) return { ok: false, message: input.mode === "AS_IS" ? "Add your reading of what the client means, so the editor isn't guessing." : "Say why no change is needed, for the record." };

  const items: BriefItem[] = Array.isArray(doc.items) ? doc.items : [];
  const heldItems = items.filter((it) => it.held);
  const kept = items.filter((it) => !it.held);
  const archived = heldItems.map((it) => ({ id: it.id, area: it.area, ask: it.ask, quote: it.quote ?? null, detail: it.detail ?? null }));
  const stamp = { by: input.actor.name.slice(0, 120), at: now.toISOString() };
  // The new items cover the same videos the held ones did.
  const cuts = [...new Set(heldItems.flatMap((it) => it.cuts ?? []))];
  const scope = cuts.length ? "named" : heldItems.find((it) => it.scope === "all") ? "all" : (heldItems[0]?.scope ?? "unknown");
  const quote = heldItems.map((it) => it.quote || it.ask).filter(Boolean).join(" / ").slice(0, 1000) || null;
  let added: BriefItem[] = [];
  if (input.mode === "CHANGES") {
    const used = new Set(items.map((it) => it.id));
    let n = 1;
    added = lines.map((ask) => {
      while (used.has(`cr${n}`)) n++;
      const id = `cr${n}`; used.add(id);
      return { id, area: heldItems[0]?.area ?? "Overall direction", ask: ask.slice(0, 300), detail: note, quote, cuts: cuts.length ? cuts : null, scope, kind: "REFINEMENT" as ItemKind, fromReview: stamp };
    });
  } else if (input.mode === "AS_IS") {
    added = heldItems.map((it) => ({ ...it, held: undefined, kind: isItemKind(it.kind) ? it.kind : "DIRECTION_UNCLEAR", interpretation: note, fromReview: stamp }));
  }
  const nextState: CreativeReviewState = { ...cr, state: "RESOLVED", resolvedAt: now.toISOString(), resolvedBy: stamp.by, mode: input.mode, note, archived, heldItemIds: [] };
  // AS_IS keeps the same ids (the issues are new rows either way: held items
  // were never ingested).
  const nextItems = [...kept, ...added];
  await prisma.revisionBrief.update({ where: { id: brief.id }, data: { itemsJson: JSON.stringify({ ...doc, items: nextItems, questions: [], answeredQuestions: cr.questions, creativeReview: nextState }) } });

  await releaseHold(brief.taskId);
  if (cr.taskId) await prisma.smartTask.updateMany({ where: { id: cr.taskId, status: OPEN_TASK }, data: { status: "COMPLETED", completedAt: now } });
  try {
    const { ingestBriefItems } = await import("@/lib/revisionIssues");
    await ingestBriefItems(brief.id);
  } catch { /* the work order already says it; the hourly paths repair issues */ }

  const what = input.mode === "CHANGES" ? `${added.length} concrete change${added.length === 1 ? "" : "s"} for the editor` : input.mode === "AS_IS" ? "sent to the editor with the reviewer's reading" : "no change needed";
  await prisma.activity.create({ data: { projectId: brief.projectId, type: "SYSTEM", body: `Creative review done by ${stamp.by}: ${what}.${note ? ` ${note}` : ""}`.slice(0, 500) } }).catch(() => {});

  // The editor hears about it only when there is work for them.
  if (input.mode !== "NOT_NEEDED" && brief.taskId) {
    try {
      const task = await prisma.smartTask.findUnique({ where: { id: brief.taskId }, select: { assignedKey: true, project: { select: { title: true } } } });
      const { TEAM_MEMBER_EDITOR_KEYS } = await import("@/lib/editors");
      if (task?.assignedKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(task.assignedKey)) {
        const { notifyInApp } = await import("@/lib/notify");
        await notifyInApp({
          kind: "revision_raised",
          title: `Ready to work — ${(task.project?.title ?? "the job").split(",")[0].trim()}`,
          body: input.mode === "CHANGES" ? clip(added.map((a) => a.ask).join(" · "), 140) : clip(`${first(stamp.by)}'s reading: ${note}`, 140),
          href: `/edit/${brief.projectId}`,
          targets: [{ roles: ["EDITOR"], userKey: `editor:${task.assignedKey}`, href: `/edit/${brief.projectId}` }],
          dedupeKey: `creative-review-done-${brief.id}`,
        });
      }
    } catch { /* non-fatal */ }
  }
  // A NOT_NEEDED with nothing else open on the ask lets the card close itself
  // through the normal evidence paths; the revision task is not touched here.
  return { ok: true, message: input.mode === "CHANGES" ? `Sent ${added.length} change${added.length === 1 ? "" : "s"} to the editor.` : input.mode === "AS_IS" ? "Sent to the editor with your reading attached." : "Recorded: no change needed." };
}

export type CreativeReviewView = {
  briefId: string;
  createdAtISO: string;
  requestedBy: string | null;
  reviewerName: string;
  reasons: string[];
  taskHeld: boolean;
  held: { id: string; area: string; ask: string; quote: string | null; videos: string[] }[];
  questions: string[];
  originalText: string;
};

/** The OPEN creative reviews on a job, for the Review Room panel. */
export async function openCreativeReviews(projectId: string): Promise<CreativeReviewView[]> {
  const rows = await prisma.revisionBrief.findMany({ where: { projectId, itemsJson: { contains: "\"creativeReview\"" } }, orderBy: { createdAt: "asc" } });
  const out: CreativeReviewView[] = [];
  let names: Record<string, string> | null = null;
  for (const r of rows) {
    const doc = parseDoc(r.itemsJson);
    const cr = doc.creativeReview;
    if (!cr || cr.state !== "OPEN") continue;
    if (!names) {
      names = {};
      const { briefCutsFor } = await import("@/lib/revisionBrief");
      for (const c of await briefCutsFor(projectId).catch(() => [])) names[c.key] = c.label;
    }
    out.push({
      briefId: r.id,
      createdAtISO: r.createdAt.toISOString(),
      requestedBy: r.requestedBy ?? null,
      reviewerName: cr.reviewerName,
      reasons: cr.reasons.map((x) => REASON_WORDS[x] ?? x),
      taskHeld: cr.taskHeld,
      held: (doc.items ?? []).filter((it) => it.held).map((it) => ({ id: it.id, area: it.area, ask: it.ask, quote: it.quote ?? null, videos: (it.cuts ?? []).map((k) => names![k]).filter(Boolean) })),
      questions: cr.questions,
      originalText: r.originalText.slice(0, 3000),
    });
  }
  return out;
}

/**
 * A reviewer reopened a client's creative ask that a version had already
 * claimed fixed: open a creative review so the direction gets looked at
 * instead of the editor guessing a second time. The issue itself is back with
 * the editor as before; this only adds the task. Never throws.
 */
export async function creativeReviewForReopenedIssue(issueId: string): Promise<boolean> {
  try {
    const issue = await prisma.revisionIssue.findUnique({ where: { id: issueId }, select: { id: true, projectId: true, category: true, sourceKind: true, originalText: true, raisedOnSubmissionId: true } });
    const project = issue ? await prisma.project.findUnique({ where: { id: issue.projectId }, select: { title: true, clientId: true } }) : null;
    if (!issue || issue.sourceKind !== "BRIEF_ITEM" || !CREATIVE_AREAS.includes(issue.category)) return false;
    const reviewer = await creativeReviewerFor(issue.projectId, issue.raisedOnSubmissionId);
    const dedupeKey = `creative-review:issue:${issue.id}`;
    const exists = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (exists) return false;
    const street = (project?.title ?? "the job").split(",")[0].trim();
    await prisma.smartTask.create({
      data: {
        taskType: "creative_review", status: "OPEN", priority: "HIGH", source: "creative_review",
        title: `Creative review — ${street} · same ask came back`.slice(0, 200),
        summary: clip(`"${issue.originalText}" was changed once and is still not right.`, 300),
        description: `A ${issue.category.toLowerCase()} change the client asked for was reopened after a version said it was fixed. Look at the direction before the editor tries again.\n\nThe client's words: "${clip(issue.originalText, 1500)}"`,
        reasonCreated: "A creative ask reopened after a fix",
        assignedKey: reviewer.key, projectId: issue.projectId, clientId: project?.clientId ?? null, propertyAddress: project?.title ?? null,
        dueAt: new Date(Date.now() + 24 * 3_600_000), dedupeKey,
      },
    });
    return true;
  } catch (e) {
    console.error("[creative review] reopened issue", issueId, e);
    return false;
  }
}
