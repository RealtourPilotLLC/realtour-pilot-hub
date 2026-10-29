import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CREATIVE_AREAS, REASON_WORDS, changeLines, creativeReviewOf, isItemKind, kindOf, soundsUnclear, splitEditorCalls,
  type CreativeReviewReason, type CreativeReviewState, type ItemKind,
} from "@/lib/creativeReviewCore";
import { isPhotoOnly, itemMediumOf, mediumLabel, mediumOfItem } from "@/lib/itemMedium";
import { dismissedReason, isDismissedSummary } from "@/lib/triage";

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
  /** Oct 22 2026 (lib/itemMedium): a photo item is the photo job's, never held here. */
  medium?: string;
};
type ItemsDoc = { items?: BriefItem[]; keep?: string[]; references?: unknown[]; questions?: string[]; photoQuestions?: string[]; editorCalls?: string[]; creativeReview?: CreativeReviewState; [k: string]: unknown };

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
  // THE VIDEO SIDE ONLY (Oct 22 2026, lib/itemMedium). An item about the
  // photos is the photo job's client ask (lib/briefPhotoAsks), and so is an
  // open question about the photos: neither is ever held here, so neither
  // opens a card in the Video Review Room (Joe Sutow's "virtually stage the
  // upper patio, pic 38" did). Both / unclear items stay, labelled.
  const videoItems = items.filter((it) => !isPhotoOnly(it));
  const asked = (doc.questions ?? []).map((q) => String(q).trim()).filter(Boolean);
  if (videoItems.length === 0 && asked.length === 0 && doc.creativeReview?.state !== "OPEN") return null;
  // THE EDITOR'S CALL (Jordan, Oct 29 2026: "I shouldn't have to choose the
  // music or dictate the flow"; creativeReviewCore.editorsCall). A question
  // about a choice that is the editor's craft goes on the work order as theirs
  // and never opens creative review; only the rest wait on the reviewer.
  const split = splitEditorCalls(asked);
  const questions = split.needAnswer;
  const editorCalls = [...new Set([...(doc.editorCalls ?? []), ...split.editorCalls])];
  const callsDoc = editorCalls.length ? { questions, editorCalls } : { questions };

  const owed = await owedKeysOf(brief.projectId);
  // NO VIDEO, NO CREATIVE REVIEW (Oct 29 2026, 4008 Oakland Rd; Jordan: "Why
  // is this coming up? I don't think it's needed"). A job that owes no video
  // has nothing for a creative reviewer to direct: a photos-only job's
  // questions ("a reel was not part of this job. Is this a new order?") are
  // the office's, and its "Overall direction" is never a second round. The
  // kinds are still written; nothing is held and no card opens.
  const noVideo = owed.length === 0;
  const reasons = new Set<CreativeReviewReason>();
  const held = new Set<string>();
  for (const it of items) {
    it.kind = kindOf(it);
    if (!noVideo && it.kind === "DIRECTION_UNCLEAR" && !isPhotoOnly(it)) { held.add(it.id); reasons.add("UNCLEAR"); }
  }
  if (questions.length && !noVideo) reasons.add("QUESTIONS");

  // THE SAME PART OF THE SAME VIDEO, AGAIN. An earlier client ask in this area
  // on this video was already changed (addressed, verified, or reopened) and
  // the client is back on it: a creative problem, not an editing one.
  const repeatCandidates = noVideo ? [] : videoItems.filter((it) => !held.has(it.id) && CREATIVE_AREAS.includes(it.area) && it.kind !== "CORRECTION" && it.kind !== "SCOPE");
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
  const direction = noVideo ? [] : videoItems.filter((it) => !held.has(it.id) && it.area === "Overall direction");
  if (direction.length) {
    const round = brief.roundId ? await prisma.contentRevisionRound.findUnique({ where: { id: brief.roundId }, select: { ordinal: true } }).catch(() => null) : null;
    const earlier = await prisma.revisionBrief.findMany({
      where: { projectId: brief.projectId, id: { not: brief.id }, createdAt: { lt: brief.createdAt }, source: { notIn: [...STAFF_SOURCES] } },
      select: { outputId: true, itemsJson: true },
    });
    // A SECOND ROUND NEEDS A FIRST VERSION (Oct 29 2026, 4008 Oakland Rd): an
    // earlier ask on the job is not a round on a video nobody has made yet.
    // The video must have had a version before this ask (any cut but an
    // upload in progress or withdrawn); a portal round 2 always has.
    const { NOT_A_CUT, slotKeyOf } = await import("@/lib/reviewCuts");
    const priorCuts = await prisma.reviewSubmission.findMany({
      where: { projectId: brief.projectId, createdAt: { lt: brief.createdAt }, status: { notIn: [...NOT_A_CUT] } },
      select: { deliverableId: true, slot: true },
    });
    const cutKeys = new Set(priorCuts.filter((c) => c.deliverableId).map((c) => slotKeyOf(c.deliverableId!, c.slot)));
    const legacyCut = priorCuts.some((c) => !c.deliverableId);
    for (const it of direction) {
      const keys = itemKeys(it, owed);
      const hadVersion = keys.length ? keys.some((k) => cutKeys.has(k)) || (legacyCut && owed.length <= 1) : priorCuts.length > 0;
      const again = (round?.ordinal ?? 0) >= 2 || (hadVersion && earlier.some((e) => {
        if (brief.outputId && e.outputId === brief.outputId) return true;
        const theirs = (parseDoc(e.itemsJson).items ?? []).flatMap((x) => itemKeys(x as BriefItem, owed));
        if (keys.length === 0) return owed.length <= 1;
        return theirs.some((k) => keys.includes(k)) || (theirs.length === 0 && owed.length <= 1);
      }));
      if (again) { held.add(it.id); reasons.add("ROUND_TWO_DIRECTION"); }
    }
  }

  for (const it of items) it.held = held.has(it.id) ? true : undefined;
  if (reasons.size === 0) {
    // Kinds only. A brief that was held before and no longer needs it (a
    // re-read) gives the editor their card back.
    const wasOpen = doc.creativeReview?.state === "OPEN" ? doc.creativeReview : null;
    const next: ItemsDoc = { ...doc, items, ...callsDoc };
    delete next.creativeReview;
    await prisma.revisionBrief.update({ where: { id: brief.id }, data: { itemsJson: JSON.stringify(next) } });
    if (wasOpen) await releaseHold(brief.taskId);
    if (wasOpen?.taskId) await prisma.smartTask.updateMany({ where: { id: wasOpen.taskId, status: OPEN_TASK }, data: { status: "CANCELLED", completedAt: now } });
    return null;
  }

  const reviewer = await creativeReviewerFor(brief.projectId, brief.submissionId);
  // Only the video side counts: an ask whose items were all about the photos
  // has nothing of the editor's to hold.
  const unheld = videoItems.filter((it) => !it.held).length;
  const taskHeld = !(items.length > 0 && videoItems.length === 0) && unheld === 0;
  const clientName = brief.project?.client?.name ?? "the client";
  const street = (brief.project?.title ?? "the job").split(",")[0].trim();
  const heldItems = items.filter((it) => it.held);
  // THE CLIENT'S WORDS AND THE OPEN QUESTIONS, KEPT APART (audit Oct 25 2026).
  // The open questions are the work order's (the analyser's), not the
  // client's: on 615 Cliff Ln the card read "Alex Stackhouse said: V1: No
  // footage has been uploaded yet…", a sentence she never wrote, and her real
  // words were not on the card at all.
  const words = heldItems.map((it) => `• ${it.quote || it.ask}`).join("\n");
  const openQuestions = questions.map((q) => `• ${q}`).join("\n");
  const who = brief.requestedBy ?? clientName;
  const why = [...reasons].map((r) => REASON_WORDS[r]).join("; ");
  const dedupeKey = `creative-review:${brief.id}`;
  const taskData = {
    taskType: "creative_review",
    title: `Creative review — ${street} · ${first(clientName)}`.slice(0, 200),
    summary: clip(
      heldItems.length
        ? `${who} said: ${heldItems[0].quote || heldItems[0].ask}`
        : questions.length
          ? `Open question on ${who}'s ask: ${questions[0]}`
          : `${who} said: ${brief.originalText}`,
      300,
    ),
    description: [
      `Why this came to you: ${why}.`,
      "",
      "The client's words:",
      words || clip(brief.originalText, 1500),
      ...(openQuestions ? ["", "Open questions:", openQuestions] : []),
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
  await prisma.revisionBrief.update({ where: { id: brief.id }, data: { itemsJson: JSON.stringify({ ...doc, items, ...callsDoc, creativeReview: state }) } });

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

// ---------------------------------------------------------------------------
// A CREATIVE REVIEW THE WORK HAS ALREADY ANSWERED CLOSES ITSELF (audit M1,
// Oct 22 2026). Nine "Creative review" tasks sat open on delivered jobs whose
// revisions were finished: nothing ever closed one except a person pressing
// its buttons, so they piled up on Jordan's and James's lists after the video
// had gone back to the client. One closes on its own when either:
//   · the revision card it was filed on (the brief's video-lane revision task)
//     is COMPLETED; or
//   · a NEWER version of the video it is about was approved: the brief's cut
//     (a later round on the same video), else its per-video row (approved
//     after the ask), else, on a job owing one video, that video (approved
//     after the ask). A "same ask came back" review (keyed by issue) closes
//     when its issue is verified or a later version of its video is approved.
// Closing records RESOLVED / NOT_NEEDED with the reason, archives the held
// items as resolveCreativeReview does (the client's words stay), gives the
// editor's card back if this held it, completes the task and says so on the
// timeline. Runs on every approval (review/actions approveCut) and hourly (the
// sync cron), so a revision finished any other way closes within the hour.
// ---------------------------------------------------------------------------

export type SettledCreativeReview = { taskId: string; projectId: string | null; street: string; briefId: string | null; why: string };

async function newerApprovedSince(projectId: string, slot: { deliverableId: string; slot: number; round?: number; since?: Date }): Promise<{ round: number } | null> {
  return prisma.reviewSubmission.findFirst({
    where: {
      projectId, deliverableId: slot.deliverableId, slot: slot.slot, status: "APPROVED",
      ...(slot.round !== undefined ? { round: { gt: slot.round } } : {}),
      ...(slot.since ? { decidedAt: { gt: slot.since } } : {}),
    },
    orderBy: { round: "desc" },
    select: { round: true },
  });
}

/** Why this open creative review is already answered by the work, or null (reads only). */
async function settledWhy(task: { id: string; dedupeKey: string | null; projectId: string | null }): Promise<{ why: string; briefId: string | null } | null> {
  if (!task.projectId || !task.dedupeKey?.startsWith("creative-review:")) return null;
  if (task.dedupeKey.startsWith("creative-review:issue:")) {
    const issue = await prisma.revisionIssue.findUnique({ where: { id: task.dedupeKey.slice("creative-review:issue:".length) }, select: { state: true, deliverableId: true, slot: true, raisedOnSubmissionId: true } });
    if (!issue) return null;
    if (issue.state === "VERIFIED") return { why: "the change was checked as fixed on a later version", briefId: null };
    const on = issue.raisedOnSubmissionId ? await prisma.reviewSubmission.findUnique({ where: { id: issue.raisedOnSubmissionId }, select: { deliverableId: true, slot: true, round: true } }) : null;
    const newer = on?.deliverableId ? await newerApprovedSince(task.projectId, { deliverableId: on.deliverableId, slot: on.slot ?? 1, round: on.round }) : null;
    return newer ? { why: `a newer version of the video (version ${newer.round}) was approved`, briefId: null } : null;
  }
  const briefId = task.dedupeKey.slice("creative-review:".length);
  const brief = await prisma.revisionBrief.findUnique({ where: { id: briefId }, select: { id: true, projectId: true, taskId: true, submissionId: true, outputId: true, createdAt: true, itemsJson: true } });
  if (!brief || creativeReviewOf(brief.itemsJson)?.state !== "OPEN") return null;
  if (brief.taskId) {
    const rev = await prisma.smartTask.findUnique({ where: { id: brief.taskId }, select: { taskType: true, status: true, summary: true } });
    if (rev?.taskType === "revision" && rev.status === "COMPLETED") return { why: "its revision was completed", briefId };
    // Oct 29 2026 (4008 Oakland Rd): Kyle dismissed the revision as not needed
    // and both creative reviews filed on it stayed open on Jordan's list. Only
    // a person's dismissal counts: a card the lane merged into another one is
    // CANCELLED too, and its ask lives on in that card.
    if (rev?.taskType === "revision" && rev.status === "CANCELLED" && isDismissedSummary(rev.summary)) {
      const reason = dismissedReason(rev.summary);
      return { why: `its revision was dismissed${reason ? ` (${reason})` : ""}`, briefId };
    }
  }
  let newer: { round: number } | null = null;
  if (brief.submissionId) {
    const sub = await prisma.reviewSubmission.findUnique({ where: { id: brief.submissionId }, select: { deliverableId: true, slot: true, round: true } });
    if (sub?.deliverableId) newer = await newerApprovedSince(brief.projectId, { deliverableId: sub.deliverableId, slot: sub.slot ?? 1, round: sub.round });
  } else if (brief.outputId) {
    const out = await prisma.deliverableOutput.findUnique({ where: { id: brief.outputId }, select: { deliverableId: true, slot: true } });
    if (out) newer = await newerApprovedSince(brief.projectId, { deliverableId: out.deliverableId, slot: out.slot, since: brief.createdAt });
  } else {
    const { cutSlots } = await import("@/lib/reviewCuts");
    const owed = await cutSlots(brief.projectId).catch(() => []);
    if (owed.length === 1) newer = await newerApprovedSince(brief.projectId, { deliverableId: owed[0].deliverableId, slot: owed[0].slot, since: brief.createdAt });
  }
  return newer ? { why: `a newer version of the video (version ${newer.round}) was approved after the ask`, briefId } : null;
}

/**
 * Close every open creative review the work has already answered (on one job,
 * or everywhere). `dryRun` reads and lists only; `exclude` leaves named tasks
 * alone. Never throws for one task's failure.
 */
export async function closeSettledCreativeReviews(opts: {
  projectId?: string; now?: Date; dryRun?: boolean; exclude?: string[]; taskIds?: string[]; max?: number;
  /** a one-off clean-up's own reason for a task the rule above does not reach (task id → why) */
  alsoClose?: Record<string, string>;
} = {}): Promise<{ closed: SettledCreativeReview[]; open: number }> {
  const now = opts.now ?? new Date();
  const tasks = await prisma.smartTask.findMany({
    where: {
      taskType: "creative_review", status: OPEN_TASK,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.taskIds ? { id: { in: opts.taskIds } } : {}),
      ...(opts.exclude?.length ? { id: { notIn: opts.exclude } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: opts.max ?? 200,
    select: { id: true, dedupeKey: true, projectId: true, propertyAddress: true, project: { select: { title: true } } },
  });
  const closed: SettledCreativeReview[] = [];
  for (const t of tasks) {
    try {
      const ruled = await settledWhy(t);
      const extra = opts.alsoClose?.[t.id];
      const settled = ruled ?? (extra ? { why: extra, briefId: t.dedupeKey?.startsWith("creative-review:") && !t.dedupeKey.startsWith("creative-review:issue:") ? t.dedupeKey.slice("creative-review:".length) : null } : null);
      if (!settled) continue;
      const street = (t.project?.title ?? t.propertyAddress ?? "the job").split(",")[0].trim();
      const row: SettledCreativeReview = { taskId: t.id, projectId: t.projectId, street, briefId: settled.briefId, why: settled.why };
      if (opts.dryRun) { closed.push(row); continue; }
      if (settled.briefId) {
        const brief = await prisma.revisionBrief.findUnique({ where: { id: settled.briefId }, select: { id: true, taskId: true, itemsJson: true } });
        const doc = parseDoc(brief?.itemsJson);
        const cr = doc.creativeReview;
        if (brief && cr?.state === "OPEN") {
          const items: BriefItem[] = Array.isArray(doc.items) ? doc.items : [];
          const held = items.filter((it) => it.held);
          const archived = held.map((it) => ({ id: it.id, area: it.area, ask: it.ask, quote: it.quote ?? null, detail: it.detail ?? null }));
          const note = `Closed on its own: ${settled.why}.`;
          const next: CreativeReviewState = { ...cr, state: "RESOLVED", resolvedAt: now.toISOString(), resolvedBy: "the hub", mode: "NOT_NEEDED", note, archived, heldItemIds: [] };
          // Compare-and-set on the words read: a person resolving it this very
          // moment wins, and this pass leaves it.
          const won = await prisma.revisionBrief.updateMany({
            where: { id: brief.id, itemsJson: brief.itemsJson },
            data: { itemsJson: JSON.stringify({ ...doc, items: items.filter((it) => !it.held), questions: [], answeredQuestions: cr.questions, creativeReview: next }) },
          });
          if (!won.count) continue;
          await releaseHold(brief.taskId);
        }
      }
      const done = await prisma.smartTask.updateMany({ where: { id: t.id, status: OPEN_TASK }, data: { status: "COMPLETED", completedAt: now } });
      if (!done.count) continue;
      if (t.projectId) {
        await prisma.activity.create({ data: { projectId: t.projectId, type: "SYSTEM", body: `Creative review closed on its own: ${settled.why}. The client's words stay on the request.`.slice(0, 500) } }).catch(() => {});
      }
      closed.push(row);
    } catch (e) {
      console.warn("[creative review] auto-close failed", t.id, e);
    }
  }
  return { closed, open: tasks.length };
}

export type CreativeReviewView = {
  briefId: string;
  createdAtISO: string;
  requestedBy: string | null;
  reviewerName: string;
  reasons: string[];
  taskHeld: boolean;
  /** `label`: "Photos and video" / "Photos or video? Not clear" on a both / unclear item (Oct 22 2026). */
  held: { id: string; area: string; ask: string; quote: string | null; videos: string[]; label: string | null }[];
  questions: string[];
  /** The label per question, the same words as an item's (null: the video's). */
  questionLabels: (string | null)[];
  originalText: string;
  /** "The photo part (2) went to the photo job." when this message was about the photos too. */
  photoNote: string | null;
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
      held: (doc.items ?? []).filter((it) => it.held && !isPhotoOnly(it)).map((it) => ({ id: it.id, area: it.area, ask: it.ask, quote: it.quote ?? null, videos: (it.cuts ?? []).map((k) => names![k]).filter(Boolean), label: mediumLabel(mediumOfItem(it)) })),
      questions: cr.questions,
      questionLabels: cr.questions.map((q) => mediumLabel(itemMediumOf(q))),
      originalText: r.originalText.slice(0, 3000),
      photoNote: (() => {
        const n = (doc.items ?? []).filter((it) => isPhotoOnly(it)).length + (doc.photoQuestions ?? []).length;
        return n > 0 ? `The part about the photos (${n}) went to the photo job, not here.` : null;
      })(),
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
