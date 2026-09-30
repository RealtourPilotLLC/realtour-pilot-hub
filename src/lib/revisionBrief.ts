import "server-only";
import { prisma } from "@/lib/prisma";
import { aiJson } from "@/lib/integrations/ai";
import { stripMoneySentences } from "@/lib/text";
import { cutSlots, slotKeyOf } from "@/lib/reviewCuts";
import { etDateTime } from "@/lib/datetime";
import { lockAdvisory } from "@/lib/dbLocks";
// Types only — the reopened-clock READER is deliveryBoard.ts, loaded
// dynamically below so this module's import graph does not change.
import type { DueSource, ReopenedClock } from "@/lib/deliveryBoard";
import { isRequesterKind, type Requester } from "@/lib/reviewAttribution";

// ---------------------------------------------------------------------------
// THE REVISION WORK ORDER.
//
// A client's change request arrives as whatever they actually said — a
// 21-minute phone call, a forwarded email chain, a text. Until now that raw
// text was clipped to 1500 characters and handed to the editor as one
// paragraph: Marcee's Aug 27 call reached Kim as her own half of a dialogue,
// cut off mid-sentence, with at least eight separate asks buried in it
// (Jordan: "This should be analyzed and put into actionable items… right now
// it just shows a big paragraph and not even the full transcript").
//
// So: keep the ask WHOLE, and split it into work.
//   · `originalText` is never clipped — it's the record of what they said.
//   · The AI pass turns it into discrete, area-tagged items in the imperative,
//     each carrying the client's own words as the receipt.
//   · It also separates the three things a paragraph hides: what to LEAVE
//     ALONE, what the client is SENDING, and what's too vague to start on.
//
// Rules the prompt enforces, because an editor acts on this unsupervised:
//   · Never invent an instruction. Every item traces to something they said.
//   · Split compound asks ("the music is weird and the background is weird").
//   · Keep vague-but-real feelings as items ("doesn't feel polished") rather
//     than dropping them — with the client's wording, so the editor can judge.
//   · A question the client asked, or a thing they merely mentioned, is not a
//     change request.
//   · Never state a property fact — lot lines, boundaries, acreage — except
//     from a plat or survey the client supplies (§10 J3, Sep 26 2026; the
//     file itself is a dependency task, lib/assetDependencies).
// ---------------------------------------------------------------------------

export const REVISION_AREAS = [
  "Music & sound",
  "On-screen text",
  "Graphics & effects",
  "Background & set",
  "Pacing & movement",
  "Color & styling",
  "Cuts & content",
  "Overall direction",
  "Other",
] as const;

/** WHICH VIDEO an item is about (audit WF-03, Sep 18 — Jordan: "Link requests
 *  to the affected videos. Fixing video 1 must not close an untouched request
 *  for video 3.").
 *   · `named`   — the client named the video(s); `cuts` holds their slot keys.
 *   · `all`     — it applies to every video on the job ("they all need music").
 *   · `unknown` — nothing in what they said says which, so nothing may assume.
 *  Every row written before this existed parses as undefined, which reads as
 *  `unknown` — itemsJson is free-form JSON, so no migration and no backfill. */
export type ItemScope = "named" | "all" | "unknown";

export type RevisionItem = {
  id: string;
  area: string;
  ask: string; // imperative, concrete — the thing to do
  detail?: string | null; // the specifics that make it actionable
  quote?: string | null; // the client's own words, verbatim
  /** reviewCuts.slotKeyOf strings ("<deliverableId>:<slot>") — the SAME
   *  identity the cut, its notes and its verdicts already use. */
  cuts?: string[] | null;
  scope?: ItemScope;
};

export type RevisionAnalysis = {
  headline: string;
  items: RevisionItem[];
  keep: string[]; // what they liked / must not change
  references: { what: string; where: string }[]; // things they're sending
  questions: string[]; // confirm before starting
};

const SCHEMA = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description: "One plain line naming what this round is about, e.g. \"Reels need a new look: neutral background, chunky colourful glitter, more movement\". No preamble.",
    },
    items: {
      type: "array",
      description: "Every distinct change the client asked for, in the order they raised them. Split compound sentences into separate items.",
      items: {
        type: "object",
        properties: {
          area: { type: "string", enum: [...REVISION_AREAS] },
          ask: { type: "string", description: "The instruction, imperative and specific, as an editor would read it off a work order. Max ~90 chars." },
          detail: { type: "string", description: "The specifics that make it doable — colours, wording, timestamps, which video. Empty string if there are none." },
          quote: { type: "string", description: "The client's own words this came from, verbatim, trimmed to the relevant sentence(s)." },
          scope: {
            type: "string",
            enum: ["named", "all", "unknown"],
            description: "Which of the job's videos this change is about. \"named\" when the client identified one or more of the videos listed under VIDEOS ON THIS JOB; \"all\" when they clearly meant every one of them; \"unknown\" when nothing they said says which. Never guess — \"unknown\" is a correct answer and the safe one.",
          },
          videos: {
            type: "array",
            description: "When scope is \"named\": the reference codes (V1, V2, …) of the videos this item is about, exactly as they appear under VIDEOS ON THIS JOB. Empty otherwise.",
            items: { type: "string" },
          },
        },
        required: ["area", "ask", "detail", "quote", "scope", "videos"],
      },
    },
    keep: {
      type: "array",
      description: "Things the client explicitly liked or said to leave alone. Empty if none.",
      items: { type: "string" },
    },
    references: {
      type: "array",
      description: "Material the client is sending or pointing at (a reference video, a screenshot, an example account). Empty if none.",
      items: {
        type: "object",
        properties: {
          what: { type: "string" },
          where: { type: "string", description: "How it's arriving — e.g. \"emailed to info@realtourpilot.com\"." },
        },
        required: ["what", "where"],
      },
    },
    questions: {
      type: "array",
      description: "Anything too vague to start on that the editor should get answered first. Empty if the ask is clear.",
      items: { type: "string" },
    },
  },
  required: ["headline", "items", "keep", "references", "questions"],
} as const;

const SYSTEM = `You turn a real-estate media client's change request into a work order for the video editor who has to act on it.

The editor was not on the call and cannot ask the client anything. Your output IS their instructions.

RULES
1. Never invent an instruction. Every item must trace to something the client actually said.
2. Split compound asks. "The music is weird and the background is weird" is TWO items.
3. Keep vague feelings as items — do not drop them and do not sharpen them into something they didn't say. "I don't love them, they don't look polished" is a real item under Overall direction, with their wording in the quote.
4. Attribute correctly. In a two-sided call transcript, only the CLIENT's asks count. Something our own staff proposed is only an item if the client agreed to it — and then it's phrased as the change, not as our suggestion.
5. A question, an aside, or small talk is not a change request.
6. If the client reverses an earlier instruction ("I said less polished, but now I want more"), the item is the NEW direction, and say so in the detail.
7. Preserve exact specifics — colour names, capitalisation they asked for, wording, timestamps, which video. These are the difference between a usable item and a useless one.
8. Write asks in the imperative: "Replace the gold glitter with big chunky colourful glitter."
9. Never mention prices, invoices, or payment. If the client discussed money, leave it out entirely.
10. SAY WHICH VIDEO. When the job has more than one video you are given the list, each with a reference code and its current file name. Match each item to the video(s) the client was talking about and put those codes in "videos" with scope "named". Use "all" only when they plainly meant every one of them. If they never said, scope is "unknown" — an item on the wrong video is worse than one nobody has placed.
11. NEVER STATE PROPERTY FACTS. Lot lines, property or boundary lines, acreage, easements and survey measurements come only from a recorded plat or survey the client supplies. Never state, estimate or describe where a boundary runs. If the client asks for lot lines or a boundary drawn, the item says to draw them from the plat or survey they send, and that document goes under what the client is sending.`;

// The client's ask can be long (a 20-minute call). Give the model plenty of
// room but keep a hard ceiling so one runaway transcript can't blow the request.
const MAX_INPUT = 24_000;

/** One owed video, as the analyser is shown it. `key` is reviewCuts.slotKeyOf;
 *  `ref` is the short code the model answers with (V1, V2 …) because a cuid is
 *  not something a language model copies reliably — the mapping back is done
 *  here, in code. */
export type BriefCut = { key: string; label: string; slot: number; fileName?: string | null };

export async function analyzeRevisionText(opts: {
  text: string;
  twoSided: boolean;
  clientName?: string | null;
  propertyAddress?: string | null;
  deliverables?: string[];
  /** The job's actual cut slots. Until this existed the model was handed the
   *  deliverable LABELS — one line for four videos — so it could not have said
   *  which video an ask was about even when the client did (WF-03). */
  cuts?: BriefCut[];
}): Promise<RevisionAnalysis> {
  const cuts = opts.cuts ?? [];
  const refOf = (i: number) => `V${i + 1}`;
  const byRef = new Map(cuts.map((c, i) => [refOf(i), c.key]));
  const cutList = cuts.length
    ? `VIDEOS ON THIS JOB (${cuts.length}):\n` +
      cuts.map((c, i) => `  ${refOf(i)} — ${c.label}${c.fileName ? ` (current file: ${c.fileName})` : " (nothing uploaded yet)"}`).join("\n")
    : null;
  const context = [
    opts.clientName ? `Client: ${opts.clientName}` : null,
    opts.propertyAddress ? `Job: ${opts.propertyAddress}` : null,
    opts.deliverables?.length ? `What we made for them: ${opts.deliverables.join(" · ")}` : null,
    cutList,
    opts.twoSided
      ? "The text below is a TWO-SIDED phone call transcript — our staff and the client both speak, and the transcription is rough (repeated words, no speaker labels). Work out who is speaking from context and take only the client's asks."
      : "The text below is the client's own message.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await aiJson<RevisionAnalysis>({
    system: SYSTEM,
    prompt: `${context}\n\n--- WHAT THE CLIENT SAID ---\n${opts.text.slice(0, MAX_INPUT)}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4000,
  });

  // Normalise: the model can return empty strings for optional fields, and we
  // own the ids (the editor's tick-offs are stored against them).
  const items: RevisionItem[] = (Array.isArray(raw.items) ? raw.items : [])
    .filter((i) => i && typeof i.ask === "string" && i.ask.trim())
    .map((i, n) => {
      const named = (Array.isArray((i as { videos?: unknown }).videos) ? ((i as { videos?: unknown[] }).videos as unknown[]) : [])
        .map((v) => byRef.get(String(v).trim().toUpperCase()))
        .filter((k): k is string => !!k);
      // One owed video means every ask is about that video — a fact, not a
      // reading of the text, so the model never gets to be wrong about it. With
      // no cut list at all (a job with no video slots yet) scope stays unknown,
      // which holds the revision open rather than closing it on a guess.
      const scope: ItemScope =
        cuts.length === 1 ? "all" : named.length > 0 ? "named" : (i as { scope?: string }).scope === "all" && cuts.length > 0 ? "all" : "unknown";
      return {
        id: `i${n + 1}`,
        area: REVISION_AREAS.includes(i.area as (typeof REVISION_AREAS)[number]) ? i.area : "Other",
        ask: i.ask.trim(),
        detail: (i.detail ?? "").trim() || null,
        quote: (i.quote ?? "").trim() || null,
        cuts: scope === "named" ? [...new Set(named)] : scope === "all" && cuts.length === 1 ? [cuts[0].key] : null,
        scope,
      };
    });

  return {
    headline: (raw.headline ?? "").trim() || "Client asked for changes",
    items,
    keep: (Array.isArray(raw.keep) ? raw.keep : []).map((s) => String(s).trim()).filter(Boolean),
    references: (Array.isArray(raw.references) ? raw.references : [])
      .filter((r) => r && r.what)
      .map((r) => ({ what: String(r.what).trim(), where: String(r.where ?? "").trim() })),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).map((s) => String(s).trim()).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// WHAT AN APPROVAL ACTUALLY ANSWERS (audit WF-03, Sep 18).
//
// Jordan, on the guard that shipped the day before: "checking whether another
// correction was uploaded or a checklist was partly ticked does not establish
// that every requested change is done. Link requests to the affected videos.
// Fixing video 1 must not close an untouched request for video 3."
//
// So the question stops being "does anything look unfinished on this job" and
// becomes, per item, "is the video this item is about one we have accepted
// since the client asked". Two things can answer it, and both are somebody's
// word rather than an inference:
//   · the item was TICKED on the work order — a person saying this one is done;
//   · every video in the item's scope has an approved round dated after the ask.
// An item scoped to a video nobody has re-cut stays outstanding. An item nobody
// could place (`unknown`, which is every row written before scopes existed) is
// treated as "all" — it is only answered when the whole job has come back
// through the Room, which is the conservative reading and the one a person can
// always override with the Complete button.
// ---------------------------------------------------------------------------

/** The part of an item this rule reads. Narrow on purpose: reviewCuts parses
 *  itemsJson itself and must not have to reconstruct a whole RevisionItem (nor
 *  import the analyser, which drags in the AI client) to ask the question. */
export type ScopedItem = { id: string; ask: string; cuts?: string[] | null; scope?: ItemScope };

/** Pure, so the rule can be exercised without a database (and is, in
 *  scripts/_agent/A-units). `approvedKeys` are the slots with an approved round
 *  since the ask; `owedKeys` is what the job owes now. */
export function outstandingItems<T extends ScopedItem>(opts: {
  items: T[];
  done: string[];
  approvedKeys: Set<string>;
  owedKeys: string[];
}): T[] {
  const ticked = new Set(opts.done);
  // "Nothing is left untouched." A job that owes no video at all answers this
  // vacuously: there is no video left that could be carrying an unfinished
  // change, so an ask must not be held open for one (the same reasoning as the
  // named-item-on-a-removed-video case below — an obligation that cannot be
  // worked on is not an obligation).
  const everythingBack = opts.owedKeys.every((k) => opts.approvedKeys.has(k));
  return opts.items.filter((it) => {
    if (ticked.has(it.id)) return false;
    const scope: ItemScope = it.scope ?? "unknown";
    if (scope === "named") {
      const keys = (it.cuts ?? []).filter(Boolean);
      // A named video that is no longer one of the job's slots cannot be worked
      // on and must not hold the ask open for ever.
      const live = keys.filter((k) => opts.owedKeys.includes(k));
      if (live.length === 0) return false;
      return !live.every((k) => opts.approvedKeys.has(k));
    }
    return !everythingBack;
  });
}

/** The line the timeline prints when an approval does NOT close the ask. */
export function outstandingReason(items: ScopedItem[], total: number): string {
  const first = items[0];
  const named = items.filter((i) => (i.scope ?? "unknown") === "named").length;
  const lead =
    items.length === 1
      ? `1 of the ${total} things the client asked for is still open`
      : `${items.length} of the ${total} things the client asked for are still open`;
  const which = named > 0 ? " on videos this approval did not touch" : "";
  return `${lead}${which} — “${(first?.ask ?? "").slice(0, 90)}”.`;
}

/**
 * Record a client's change request as a brief and analyse it. Best-effort by
 * contract: a failed AI call still leaves the FULL text on the row (which is
 * already better than the clipped paragraph it replaces) and stamps the error
 * so the card can offer a retry.
 */
// A message that turned out to need no edits: give the job its stage back and
// turn the URGENT revision into what it actually is — a client question for
// Kyle. The brief stays: the analyser's reading is the audit trail, and the
// client's words are still on the job.
async function standDownNonRevision(briefId: string): Promise<void> {
  try {
    const brief = await prisma.revisionBrief.findUnique({
      where: { id: briefId },
      select: { taskId: true, projectId: true, headline: true, originalText: true },
    });
    if (!brief?.taskId) return;
    const task = await prisma.smartTask.findUnique({
      where: { id: brief.taskId },
      select: { id: true, taskType: true, status: true, title: true, projectId: true },
    });
    if (!task || task.taskType !== "revision" || task.status === "COMPLETED" || task.status === "CANCELLED") return;

    const project = await prisma.project.findUnique({
      where: { id: brief.projectId },
      select: { status: true, deliveredAt: true, title: true, statusPinnedAt: true },
    });
    const street = (project?.title ?? "this job").split(",")[0];

    // The work becomes a reply, not an edit: same row (so nothing is lost from
    // anyone's board), new type, normal priority, due like any other reply.
    await prisma.smartTask.update({
      where: { id: task.id },
      data: {
        taskType: "client_reply",
        title: `Client question — ${street}`.slice(0, 120),
        summary: `${brief.headline ?? "The client asked a question rather than requesting changes"} — answer them; there is nothing to re-edit.`.slice(0, 500),
        priority: "HIGH",
        assignedKey: "kyle",
        reasonCreated: "Read as a revision, but the request contains no edits — re-filed as a client question",
      },
    });
    // The card just left the editor for Kyle's desk, so an editor who held the
    // job only through this ask — and had pressed Start — is not on it any
    // more (review fix, Sep 28 2026). Only the Delivered branch below used to
    // close work (through closeObsoleteTasks); on every other branch she stayed
    // ACTIVE on a job that was no longer hers until the hourly ghost sweep,
    // her one active slot taken by it. After the write; recomputed under the
    // desk lock, so the edit card's editor keeps theirs. Never throws.
    {
      const { closeGhostWork } = await import("@/lib/editorWork");
      await closeGhostWork(brief.projectId, { reason: "UNASSIGNED", detail: "the revision was re-filed as a client question" });
    }

    // A job only went to REVISION because of this message — put it back.
    // Not while the office has pinned the status (Sep 13, editOverrides.ts):
    // this is an engine write, and the pin is the office's word over every
    // engine — a human unpins it.
    if (project?.status === "REVISION" && project.deliveredAt && !project.statusPinnedAt) {
      await prisma.project.update({
        where: { id: brief.projectId },
        data: { status: "DELIVERED", revisionRequestedAt: null },
      });
      await prisma.activity.create({
        data: {
          projectId: brief.projectId,
          type: "SYSTEM",
          body: "Client message contained no edit requests — job returned to Delivered and the message re-filed as a question to answer.",
        },
      }).catch(() => {});
      // Run the same close sweep a real DELIVERED transition runs, or the QC
      // card the revision reopened stays open and overdue on a finished job —
      // which is exactly how 33 Mill Race came to read "overdue" beside "Still
      // owed: nothing".
      try {
        const { closeObsoleteTasks } = await import("@/lib/tasks");
        await closeObsoleteTasks(brief.projectId, "DELIVERED");
      } catch { /* the hourly sweep will catch it */ }
    }
  } catch { /* the brief and the client's words are already saved */ }
}

/** The exact cut a portal ask is about (comms.RevisionPin, minus the bell's
 *  needs). `cutKey` is slotKeyOf(deliverableId, slot), or null for a legacy
 *  folder cut — which keeps the job-level brief it always had. */
export type BriefPin = { submissionId: string; outputId: string | null; cutKey: string | null; decisionId: string | null; roundId: string | null; label?: string | null };

/**
 * PINNED ITEMS, WITH NO MODEL (CP-03). The portal knows the cut, so every note
 * line becomes an item scoped to it — `named`, `cuts: [cutKey]`. Under 240
 * characters the brief used to carry NO items at all, and with no items the
 * approval rule fell back to "any corrected cut since the ask", which let the
 * fix for video B close video A's ask. Pure.
 */
export function pinnedItems(text: string, cutKey: string): RevisionItem[] {
  const bullets = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("•")).map((l) => l.replace(/^•\s*/, "").trim()).filter(Boolean);
  const lines = bullets.length ? bullets : [text.trim()];
  return lines.map((ask, i) => ({ id: `i${i + 1}`, area: "Other", ask: ask.slice(0, 1000), detail: null, quote: null, scope: "named" as const, cuts: [cutKey] }));
}

export async function createRevisionBrief(opts: {
  projectId: string;
  taskId?: string | null;
  source: string;
  sourceDetail?: string | null;
  text: string;
  twoSided?: boolean;
  clientName?: string | null;
  propertyAddress?: string | null;
  deliverables?: string[];
  pin?: BriefPin;
  /** Staff-supplied files or references for a pinned request. Kept separate
   *  from originalText so the client's words stay byte-for-byte intact. */
  references?: { what: string; where: string }[];
  /** No model call: a portal ADDENDUM joins a request the editor already has,
   *  its pinned items are the work order, and a client re-sending notes must
   *  not be able to buy a model call per submit. */
  skipAnalysis?: boolean;
  /** WHO ASKED (Sep 28): the portal person (or staff on their behalf), the
   *  email / text sender, the caller — written on the row so every surface
   *  that shows the work order can say whose it is. */
  requestedBy?: Requester | null;
}): Promise<string | null> {
  // A staff conversion from team chat is a receipt of the stored message.
  // Keep its whitespace too; the work items may trim for display separately.
  const text = opts.source === "review_room_staff" ? (opts.text ?? "") : (opts.text ?? "").trim();
  if (!text.trim()) return null;
  // Don't spend a model call on "can you brighten the kitchen photo" — a short
  // ask is already a work order. The card renders it as one item.
  const worthAnalyzing = text.length >= 240 && !opts.skipAnalysis && !opts.pin;
  const pin = opts.pin;
  const items = pin?.cutKey ? pinnedItems(text, pin.cutKey) : null;
  // THE ROUND'S CLOCK (A52, §3): written once, here, and never by a re-read.
  // The row's createdAt is the same instant the clock starts from, so the
  // reader's "created since the last settle" and the clock agree to the ms.
  const at = new Date();
  const clock = await clientRoundClockFor(opts, at);

  let brief;
  try {
    brief = await prisma.revisionBrief.create({
      data: {
        projectId: opts.projectId,
        taskId: opts.taskId ?? null,
        source: opts.source,
        sourceDetail: opts.sourceDetail ?? null,
        originalText: text,
        twoSided: !!opts.twoSided,
        createdAt: at,
        ...requesterColumns(opts.requestedBy),
        ...(clock ?? {}),
        ...(pin
          ? {
              submissionId: pin.submissionId, decisionId: pin.decisionId, roundId: pin.roundId,
              ...(pin.cutKey ? { outputId: pin.outputId } : {}),
              ...(items ? { headline: `Changes on ${pin.label ?? "this video"}`.slice(0, 300), itemsJson: JSON.stringify({ items, keep: [], references: opts.references ?? [], questions: [] }), analyzedAt: new Date() } : {}),
            }
          : {}),
      },
      select: { id: true },
    });
  } catch {
    return null; // never break a revision over its paperwork
  }
  // The revision card carries the same date the job does (§3 replaces the Sep
  // 8 "revisions promise nothing" rule). Best-effort; never throws.
  if (clock) await mirrorClockToTasks(opts.projectId);

  if (!worthAnalyzing) {
    // Already a work order (a short ask, or a portal pin) — its items are the
    // editor's issues now (§8.3). A model run ingests at its own end.
    await ingestBriefIssues(brief.id);
    return brief.id;
  }
  await analyzeBrief(brief.id, { ...opts, pin });
  return brief.id;
}

/** The three requester columns, from a Requester (or nothing on a row written
 *  by a caller that does not know). A kind this build does not know is not
 *  written — the column is a vocabulary, not free text. */
function requesterColumns(r: Requester | null | undefined): { requestedBy?: string | null; requestedByKind?: string; requestedByUserId?: string | null } {
  if (!r || !isRequesterKind(r.kind)) return {};
  return { requestedBy: r.name?.trim().slice(0, 200) || null, requestedByKind: r.kind, requestedByUserId: r.userId ?? null };
}

/** The work order's items as revision issues (§8.3) — one per item × video it
 *  names, idempotent on that source, reconciling after a re-read. Dynamic
 *  import: revisionIssues reads this module's slot helpers' home (reviewCuts)
 *  and must stay out of the analyser's import graph. Never throws. */
async function ingestBriefIssues(briefId: string): Promise<void> {
  try {
    const { ingestBriefItems } = await import("@/lib/revisionIssues");
    await ingestBriefItems(briefId);
  } catch { /* the brief and the client's words are already saved */ }
}

/**
 * The job's owed videos as the analyser needs to see them: the Review Room's
 * own name for each slot, and the file currently sitting on it. Same slot list
 * the Room, the edit card and the QC card read (cutSlots), so an item that says
 * "video 2 of 4" means the same video on every screen.
 */
export async function briefCutsFor(projectId: string): Promise<BriefCut[]> {
  const slots = await cutSlots(projectId).catch(() => []);
  if (slots.length === 0) return [];
  const rounds = await prisma.reviewSubmission
    .findMany({
      where: { projectId, deliverableId: { not: null }, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
      orderBy: { round: "asc" },
      select: { deliverableId: true, slot: true, fileName: true },
    })
    .catch(() => []);
  const fileByKey = new Map<string, string | null>();
  for (const r of rounds) fileByKey.set(slotKeyOf(r.deliverableId!, r.slot), r.fileName);
  return slots.map((s) => {
    const key = slotKeyOf(s.deliverableId, s.slot);
    return { key, label: s.label, slot: s.slot, fileName: fileByKey.get(key) ?? null };
  });
}

/** The slot key of a pinned brief's output, for a re-analysis that was not
 *  handed the pin (the card's retry button). */
async function pinnedKeyOf(outputId: string): Promise<string | null> {
  const o = await prisma.deliverableOutput.findUnique({ where: { id: outputId }, select: { deliverableId: true, slot: true } }).catch(() => null);
  return o ? slotKeyOf(o.deliverableId, o.slot) : null;
}

/** Run (or re-run) the analysis for one brief. Never throws. */
export async function analyzeBrief(
  briefId: string,
  ctx?: { clientName?: string | null; propertyAddress?: string | null; deliverables?: string[]; pin?: BriefPin },
): Promise<boolean> {
  const brief = await prisma.revisionBrief.findUnique({
    where: { id: briefId },
    select: {
      id: true,
      projectId: true,
      originalText: true,
      twoSided: true,
      // A pinned brief (CP-03) keeps its cut through a re-analysis too.
      submissionId: true,
      outputId: true,
      itemsJson: true,
      project: {
        select: {
          title: true,
          client: { select: { name: true } },
          deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
        },
      },
    },
  });
  if (!brief) return false;
  // A RE-READ MUST NOT RENUMBER WORK A PERSON HAS ACTED ON (§8.3). Once any of
  // this request's issues is classified, fixed, verified or merged, a fresh
  // split would orphan those decisions — refused, with the reason on the card.
  // A first analysis has no issues yet and is never refused.
  {
    const { briefIssuesLocked } = await import("@/lib/revisionIssues");
    if (await briefIssuesLocked(briefId).catch(() => false)) {
      await prisma.revisionBrief
        .update({ where: { id: briefId }, data: { analysisError: "Not re-read: its items are already being worked (classified, fixed or verified) — re-reading would renumber them." } })
        .catch(() => {});
      return false;
    }
  }
  try {
    // The cut list is what lets an item say WHICH video (WF-03). A job with no
    // video slots simply gets none, and every item stays unplaced.
    const cuts = await briefCutsFor(brief.projectId).catch(() => [] as BriefCut[]);
    const analysis = await analyzeRevisionText({
      text: brief.originalText,
      twoSided: brief.twoSided,
      clientName: ctx?.clientName ?? brief.project?.client?.name ?? null,
      propertyAddress: ctx?.propertyAddress ?? brief.project?.title ?? null,
      deliverables:
        ctx?.deliverables ??
        (brief.project?.deliverables ?? []).map((d) => d.label || d.type).filter(Boolean),
      cuts,
    });
    // PINNED: the portal already said which video. Every item the model found
    // is scoped to it — the model never gets to move an ask to another video —
    // and if it found none, the deterministic items stay: a client who pressed
    // "Submit change request" asked for a change, whatever the model thinks.
    const pinKey = ctx?.pin?.cutKey ?? (brief.submissionId && brief.outputId ? await pinnedKeyOf(brief.outputId) : null);
    if (pinKey) {
      let kept: RevisionItem[] = [];
      try { kept = brief.itemsJson ? ((JSON.parse(brief.itemsJson) as { items?: RevisionItem[] }).items ?? []) : []; } catch { /* rebuilt below */ }
      const items = analysis.items.length
        ? analysis.items.map((i) => ({ ...i, scope: "named" as const, cuts: [pinKey] }))
        : kept.length ? kept : pinnedItems(brief.originalText, pinKey);
      await prisma.revisionBrief.update({
        where: { id: briefId },
        data: {
          headline: analysis.items.length ? analysis.headline.slice(0, 300) : undefined,
          itemsJson: JSON.stringify({ items, keep: analysis.keep, references: analysis.references, questions: analysis.questions }),
          analyzedAt: new Date(),
          analysisError: null,
        },
      });
      await ingestBriefIssues(briefId);
      return true;
    }
    // When every item lands on the SAME one video, the brief itself is about
    // that video — the pointer the edit card follows to open the right cut
    // (Jordan, Sep 16: "When I click the revisions… It should go directly to
    // the cut that needs a revision"). Mixed or unplaced asks leave it null:
    // a brief is not about a video the hub had to guess at.
    const placed = [...new Set(analysis.items.flatMap((i) => (i.scope === "named" || i.scope === "all" ? i.cuts ?? [] : [])))];
    const everyItemPlaced = analysis.items.length > 0 && analysis.items.every((i) => (i.cuts ?? []).length > 0);
    const outputId =
      everyItemPlaced && placed.length === 1
        ? (
            await prisma.deliverableOutput
              .findFirst({
                where: { projectId: brief.projectId, deliverableId: placed[0].split(":")[0], slot: Number(placed[0].split(":")[1]) || 1 },
                select: { id: true },
              })
              .catch(() => null)
          )?.id ?? null
        : null;
    await prisma.revisionBrief.update({
      where: { id: briefId },
      data: {
        headline: analysis.headline.slice(0, 300),
        itemsJson: JSON.stringify({
          items: analysis.items,
          keep: analysis.keep,
          references: analysis.references,
          questions: analysis.questions,
        }),
        analyzedAt: new Date(),
        analysisError: null,
        ...(outputId ? { outputId } : {}),
      },
    });
    // NOT EVERY MESSAGE IS A REVISION. The analyser reads the client's words
    // and returns ZERO items when there is nothing to change — 33 Mill Race's
    // "revision" was a portal permissions question ("I can only see it under
    // Orders… Forbidden"), and its own headline said so: "No edit requests —
    // client message is a technical/account support issue only". Nothing acted
    // on that verdict, so a delivered job sat in REVISION with an URGENT
    // overdue task and a card reading "Still owed: nothing" (Jordan, Sep 7).
    if (analysis.items.length === 0) await standDownNonRevision(briefId);
    await ingestBriefIssues(briefId);
    return true;
  } catch (e) {
    await prisma.revisionBrief
      .update({
        where: { id: briefId },
        data: { analysisError: (e as Error).message.slice(0, 300) },
      })
      .catch(() => {});
    // The model failed; the client's whole text is still one ask to act on.
    await ingestBriefIssues(briefId);
    return false;
  }
}

export type BriefView = {
  id: string;
  source: string;
  sourceDetail: string | null;
  createdAtISO: string;
  originalText: string;
  twoSided: boolean;
  headline: string | null;
  analyzed: boolean;
  analysisError: string | null;
  items: RevisionItem[];
  keep: string[];
  references: { what: string; where: string }[];
  questions: string[];
  done: string[];
  /** slot key → the video's name, so an item scoped to a cut can print
   *  "Video 2 of 4" instead of a cuid the editor has never seen. */
  cutNames: Record<string, string>;
  /** Who asked, and how (Sep 28) — null on rows from before anyone was recorded. */
  requestedBy: string | null;
  requestedByKind: string | null;
};

/**
 * The briefs on a job, newest last (asks accumulate into rounds).
 * `scrub` strips money talk — creatives never see pricing, and this text comes
 * straight from a client who may well have discussed it.
 */
export async function getRevisionBriefs(projectId: string, scrub: boolean): Promise<BriefView[]> {
  const rows = await prisma.revisionBrief.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return [];
  const cutNames: Record<string, string> = {};
  for (const c of await briefCutsFor(projectId).catch(() => [] as BriefCut[])) cutNames[c.key] = c.label;
  const clean = (s: string | null | undefined): string | null => {
    const t = (s ?? "").trim();
    if (!t) return null;
    if (!scrub) return t;
    return stripMoneySentences(t) || null;
  };
  return rows.map((r) => {
    let parsed: Omit<RevisionAnalysis, "headline"> = { items: [], keep: [], references: [], questions: [] };
    try {
      if (r.itemsJson) parsed = { ...parsed, ...(JSON.parse(r.itemsJson) as typeof parsed) };
    } catch { /* unreadable analysis → the original text still renders */ }
    let done: string[] = [];
    try {
      if (r.doneJson) done = JSON.parse(r.doneJson) as string[];
    } catch { /* ticks are best-effort */ }
    return {
      id: r.id,
      source: r.source,
      sourceDetail: r.sourceDetail,
      createdAtISO: r.createdAt.toISOString(),
      // The full ask, money-scrubbed for creatives. A scrub that empties it
      // leaves a placeholder rather than an empty panel.
      originalText:
        (scrub ? stripMoneySentences(r.originalText) : r.originalText) ||
        "(this request mentioned pricing — ask Jordan for the details)",
      twoSided: r.twoSided,
      headline: clean(r.headline),
      analyzed: !!r.analyzedAt,
      analysisError: r.analysisError,
      items: (parsed.items ?? [])
        .map((i) => ({ ...i, ask: clean(i.ask) ?? "", detail: clean(i.detail), quote: clean(i.quote) }))
        .filter((i) => i.ask),
      keep: (parsed.keep ?? []).map((s) => clean(s)).filter((s): s is string => !!s),
      references: (parsed.references ?? [])
        .map((r2) => ({ what: clean(r2.what) ?? "", where: clean(r2.where) ?? "" }))
        .filter((r2) => r2.what),
      questions: (parsed.questions ?? []).map((s) => clean(s)).filter((s): s is string => !!s),
      done,
      cutNames,
      requestedBy: r.requestedBy ?? null,
      requestedByKind: r.requestedByKind ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// THE REOPENED CLOCK — WRITE SIDE (A52, Jordan, Sep 25 2026).
//
// deliveryBoard.ts explains the rule and READS it; this is where it is
// written. Three writers, one column set (targetAt/dueAt/dueSource/dueSetBy/
// dueSetAt), each stamped once:
//
//   CLIENT_ROUND       createRevisionBrief — every client ask (comms,
//                      portal, email) comes through it. Target 24, due 48
//                      hours of weekday time after the ask (§3). A portal
//                      ADDENDUM joins the round it adds to and keeps that
//                      round's clock.
//   REOPENED_SAME_DAY  stampReopenedClock — the office puts a finished job
//                      back (queue-add of a new cut, Revisions on the pill, a
//                      board move off Delivered), or it comes back for a
//                      reshoot with no extra-shoot upload. Due 6 PM ET that
//                      business day. The job has no client words to carry, so
//                      the row is the OFFICE's: source "office", no items, no
//                      model call, no revision issues — an office note is not
//                      a client ask and must not count as one (the
//                      photographer KPI excludes it; see kpi.ts).
//   MANUAL             moveReopenedDue — a person moves it; who and when on
//                      the row, what it was on the timeline.
//
// settleReopenedClocks closes them when the job settles (closeObsoleteTasks),
// and reconcileReopenedClocks is the hourly net for every path that did not
// come through a writer above.
// ---------------------------------------------------------------------------

type ClockFields = {
  targetAt: Date | null;
  dueAt: Date;
  dueSource: DueSource;
  dueSetBy: string | null;
  dueSetAt: Date;
};

/** "hub" — the automatic clocks' author, so a MANUAL row always names a person. */
const HUB = "hub";

/** The clock a new client-ask brief is born with. Null only if the arithmetic
 *  itself failed — the brief is still written, just undated. */
async function clientRoundClockFor(opts: { sourceDetail?: string | null; pin?: BriefPin; skipAnalysis?: boolean }, at: Date): Promise<ClockFields | null> {
  try {
    // An addendum is more notes on the SAME round (clientDecisions: the first
    // ask is `decision:<id>`, each addition `decision:<id>:addendum:<n>`).
    // Another clock would make adding a note move the round's date.
    if (opts.pin && /:addendum:/.test(opts.sourceDetail ?? "")) {
      const first = await prisma.revisionBrief.findFirst({
        where: { decisionId: opts.pin.decisionId, sourceDetail: `decision:${opts.pin.decisionId}`, dueAt: { not: null } },
        select: { targetAt: true, dueAt: true, dueSource: true, dueSetBy: true, dueSetAt: true },
      });
      if (first?.dueAt) {
        return {
          targetAt: first.targetAt,
          dueAt: first.dueAt,
          dueSource: (first.dueSource as DueSource | null) ?? "CLIENT_ROUND",
          dueSetBy: first.dueSetBy,
          dueSetAt: first.dueSetAt ?? at,
        };
      }
    }
    const { clientRoundClock } = await import("@/lib/deliveryBoard");
    const c = clientRoundClock(at);
    return { targetAt: c.targetAt, dueAt: c.dueAt, dueSource: "CLIENT_ROUND", dueSetBy: HUB, dueSetAt: at };
  } catch {
    return null;
  }
}

/**
 * The job's revision cards carry the job's reopened date. Only a card with NO
 * date, or the date this job was last read at (`previous`), is written — a due
 * somebody typed onto a card by hand is theirs. Never throws.
 */
export async function mirrorClockToTasks(projectId: string, opts: { previous?: Date | null } = {}): Promise<number> {
  try {
    const { reopenedClocksFor } = await import("@/lib/deliveryBoard");
    const clock = (await reopenedClocksFor([projectId])).get(projectId);
    if (!clock) return 0;
    const r = await prisma.smartTask.updateMany({
      where: {
        projectId,
        taskType: "revision",
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        // (No `NOT: { dueAt: clock.at }` guard: in SQL that is NULL for an
        // undated card and would skip exactly the cards this is for.)
        OR: [{ dueAt: null }, ...(opts.previous && opts.previous.getTime() !== clock.at.getTime() ? [{ dueAt: opts.previous }] : [])],
      },
      data: { dueAt: clock.at },
    });
    return r.count;
  } catch {
    return 0;
  }
}

/** Is this job reopened work right now: delivered once, and owed again. */
function isReopened(p: { status: string; deliveredAt: Date | null; revisionRequestedAt: Date | null }): boolean {
  if (!p.deliveredAt) return false;
  if (p.status === "CANCELLED" || p.status === "ON_HOLD") return false;
  if (p.status !== "DELIVERED") return true;
  return !!p.revisionRequestedAt && p.revisionRequestedAt > p.deliveredAt;
}

/** When the job last settled, per the marker (deliveryBoard.reopenSettledKey). */
async function settledMarkerAt(projectId: string): Promise<Date | null> {
  const { reopenSettledKey } = await import("@/lib/deliveryBoard");
  const row = await prisma.appSetting.findUnique({ where: { key: reopenSettledKey(projectId) }, select: { value: true, updatedAt: true } }).catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as { at?: string };
    const t = v.at ? new Date(v.at) : null;
    if (t && Number.isFinite(t.getTime())) return t;
  } catch { /* the row's own timestamp stands in */ }
  return row.updatedAt;
}

export type StampResult = { stamped: boolean; reason: string; briefId?: string; dueAt?: Date };

/**
 * REOPENED WITHOUT A CLIENT ROUND → DUE THE SAME BUSINESS DAY. Called by the
 * minters that put a finished job back (tasks.reflectRevisionInQc,
 * tasks.addRoundToEditCard) and by the hourly net. A no-op unless the job is
 * reopened AND nothing dates it yet — a client round, an extra shoot's own
 * promise, an earlier stamp or a person's move all win, so calling it twice,
 * or from two places at once, writes one row (advisory lock per job).
 */
export async function stampReopenedClock(
  projectId: string,
  // `by` is a PERSON's display name when a person put the work back (the
  // queue-add, a Review Room send-back, the Revisions pill) — the row then
  // names them as its requester (OFFICE) and the words say "Reopened by
  // Kyle"; absent or "hub", it is the hub's own (SYSTEM). Sep 28.
  opts: { at?: Date; why: string; by?: string | null; byUserId?: string | null },
): Promise<StampResult> {
  const at = opts.at ?? new Date();
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { status: true, deliveredAt: true, revisionRequestedAt: true, dueOverrideAt: true, overrideAt: true },
    });
    if (!p) return { stamped: false, reason: "no such job" };
    if (!isReopened(p)) return { stamped: false, reason: "not reopened work" };
    // The office dated THIS reopen by hand already — a due saved at or after
    // the reopen (or one with no save time to judge by, which the reader lets
    // stand too) — and its word stands. One saved before it was a date for
    // earlier work, and the reopen gets its own clock.
    //
    // Two corrections (A52 review, Sep 25): the save time is the DUE's own
    // (dueSetTimesFor), not overrideAt, which a priority bump moves; and it is
    // compared with when the job was actually reopened, not with this call.
    // The live minters (the Revisions pill, a Review Room bounce) call with
    // `at` = now on a job that may have been reopened an hour earlier, so a
    // date the office set in between read as "before the reopen" and was
    // overruled by a same-day clock.
    const { openReopenClocksFor, sameDayDue, dueSetTimesFor } = await import("@/lib/deliveryBoard");
    if (p.dueOverrideAt) {
      const setAt = (await dueSetTimesFor([projectId])).get(projectId) ?? p.overrideAt;
      const settled = await settledMarkerAt(projectId);
      const floor = new Date(Math.max(p.deliveredAt!.getTime(), settled?.getTime() ?? 0));
      const reopenedAt = (await reopenMomentOf(projectId, p.deliveredAt!)) ?? floor;
      const since = new Date(Math.min(reopenedAt.getTime(), at.getTime()));
      if (!setAt || setAt.getTime() >= since.getTime()) return { stamped: false, reason: "the office set a date" };
    }
    return await prisma.$transaction(async (tx) => {
      await lockAdvisory(tx, `reopen-clock:${projectId}`);
      const open = (await openReopenClocksFor([projectId], tx)).get(projectId) ?? [];
      if (open.length > 0) return { stamped: false, reason: "already dated" };
      const dueAt = sameDayDue(at);
      const why = opts.why.trim().replace(/\.$/, "") || "reopened";
      const person = opts.by?.trim() && opts.by.trim() !== HUB ? opts.by.trim() : null;
      const row = await tx.revisionBrief.create({
        data: {
          projectId,
          // The clock starts at the reopen, so the row is dated there too (the
          // net may write it up to an hour later) — the reader's settle and
          // "office date saved for this reopen" tests compare against it.
          createdAt: at,
          source: "office",
          sourceDetail: `reopen:${at.toISOString()}`,
          // Said as the office's, in words a client-profile reader cannot
          // mistake for the client's own — and, since Sep 28, naming the
          // person who did it when a person did.
          originalText: `Reopened by ${person ?? "the office"}, not a client request: ${why}.`,
          headline: `Reopened work, due ${etDateTime(dueAt)}`,
          analyzedAt: at,
          targetAt: null,
          dueAt,
          dueSource: "REOPENED_SAME_DAY",
          dueSetBy: opts.by?.trim() || HUB,
          dueSetAt: at,
          ...requesterColumns(person ? { name: person, kind: "OFFICE", userId: opts.byUserId ?? null } : { name: null, kind: "SYSTEM" }),
        },
        select: { id: true },
      });
      await tx.activity.create({
        data: {
          projectId,
          type: "SYSTEM",
          body: `Reopened work is due ${etDateTime(dueAt)}, the same business day (${why}). A person can move it on the job's edit page.`.slice(0, 1000),
        },
      });
      return { stamped: true, reason: "stamped", briefId: row.id, dueAt };
    }).then(async (r) => {
      if (r.stamped) await mirrorClockToTasks(projectId);
      return r;
    });
  } catch (e) {
    return { stamped: false, reason: `could not stamp: ${(e as Error).message.slice(0, 120)}` };
  }
}

/**
 * THE JOB SETTLED → ITS CLOCKS ARE MET. Writes the settle marker the reader
 * filters on, but only when there is an open brief clock to close (so the
 * hourly delivered sweep does not rewrite it every pass) and only when the job
 * really is settled right now. An extra shoot's promise is closed by its own
 * approval, not by this. Never throws.
 */
export async function settleReopenedClocks(projectId: string, at: Date = new Date()): Promise<boolean> {
  try {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true, deliveredAt: true, revisionRequestedAt: true } });
    if (!p) return false;
    const terminal = p.status === "DELIVERED" || p.status === "CANCELLED";
    const openAsk = p.status === "REVISION" || (!!p.revisionRequestedAt && (!p.deliveredAt || p.revisionRequestedAt > p.deliveredAt));
    if (!terminal || openAsk) return false;
    const { openReopenClocksFor, reopenSettledKey } = await import("@/lib/deliveryBoard");
    const open = (await openReopenClocksFor([projectId])).get(projectId) ?? [];
    if (!open.some((c) => c.briefId)) return false;
    const key = reopenSettledKey(projectId);
    const value = JSON.stringify({ at: at.toISOString(), status: p.status });
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    return true;
  } catch {
    return false;
  }
}

/**
 * A PERSON MOVES THE REOPENED DUE (MANUAL). The clock the job is read by is
 * moved in place — dueSource MANUAL, who and when on the row — and the
 * timeline keeps what it was, so the history the row gives up is still on the
 * job. With no clock at all (an extra shoot, or nothing) the office's own row
 * is written. Reopened work only: the date of a job's first delivery is the
 * office override's (the Editing Room's override dialog), not this.
 */
export async function moveReopenedDue(opts: { projectId: string; dueAt: Date; by: string; now?: Date }): Promise<{ ok: boolean; message: string }> {
  const now = opts.now ?? new Date();
  const by = opts.by.trim().slice(0, 120) || "The office";
  if (!Number.isFinite(opts.dueAt.getTime())) return { ok: false, message: "That isn't a date." };
  if (opts.dueAt.getTime() < now.getTime() - 5 * 60_000) return { ok: false, message: "Pick a time that hasn't passed yet." };
  if (opts.dueAt.getTime() > now.getTime() + 60 * 86_400_000) return { ok: false, message: "That's more than 60 days out. Pick a nearer date." };
  const p = await prisma.project.findUnique({ where: { id: opts.projectId }, select: { status: true, deliveredAt: true, revisionRequestedAt: true } });
  if (!p) return { ok: false, message: "That job no longer exists." };
  if (!isReopened(p)) return { ok: false, message: "This job isn't reopened work, so its date is the delivery promise." };
  const { openReopenClocksFor, resolveReopenedClock } = await import("@/lib/deliveryBoard");
  let before: ReopenedClock | null = null;
  await prisma.$transaction(async (tx) => {
    await lockAdvisory(tx, `reopen-clock:${opts.projectId}`);
    before = resolveReopenedClock((await openReopenClocksFor([opts.projectId], tx)).get(opts.projectId));
    const moved = { targetAt: null, dueAt: opts.dueAt, dueSource: "MANUAL" as const, dueSetBy: by, dueSetAt: now };
    if (before?.briefId) {
      await tx.revisionBrief.update({ where: { id: before.briefId }, data: moved });
    } else {
      await tx.revisionBrief.create({
        data: {
          projectId: opts.projectId,
          createdAt: now,
          source: "office",
          sourceDetail: `reopen-due:${now.toISOString()}`,
          originalText: `Reopened by the office, not a client request: due date set by ${by}.`,
          headline: `Reopened work, due ${etDateTime(opts.dueAt)}`,
          analyzedAt: now,
          // NO REQUESTER (review, Sep 28): the person here only DATED the
          // work — dueSetBy says so — and someone else reopened it. Named as
          // the requester, the card read "Put back by <the dater>".
          ...moved,
        },
      });
    }
    const was: ReopenedClock | null = before;
    await tx.activity.create({
      data: {
        projectId: opts.projectId,
        type: "SYSTEM",
        body: `Due date for the reopened work moved to ${etDateTime(opts.dueAt)} by ${by}${was ? ` (was ${etDateTime(was.at)}, ${was.words})` : " (it had none)"}.`.slice(0, 1000),
      },
    });
  });
  const was = before as ReopenedClock | null;
  await mirrorClockToTasks(opts.projectId, { previous: was?.at ?? null });
  return { ok: true, message: `Due ${etDateTime(opts.dueAt)}.` };
}

/** How long after a reopen the hourly net will still date it by itself. A
 *  reopen older than this (history at deploy, or a sweep that was down) is
 *  NOT back-dated into an instant "late": it waits on Kyle's exceptions for a
 *  person to set it. */
export const REOPEN_NET_WINDOW_MS = 26 * 3_600_000;

/**
 * THE HOURLY NET. Every path that reopens a job without going through a
 * writer above — a board move off Delivered, a pill, a status sweep — lands
 * here within the hour:
 *   1. a settled job still carrying open clocks is settled (a delivery path
 *      that closed tasks before it wrote the status);
 *   2. a reopened job with no date is stamped same-day FROM THE MOMENT IT WAS
 *      REOPENED, when that moment is on the record (the ask stamp, or the
 *      board's "Moved from Delivered to …" line) and recent — never from now;
 *   3. revision cards with no date take the job's.
 * Read-heavy, write-light, idempotent. Never throws per job.
 */
export async function reconcileReopenedClocks(opts: { now?: Date } = {}): Promise<{ settled: number; stamped: number; undated: number; mirrored: number }> {
  const now = opts.now ?? new Date();
  const out = { settled: 0, stamped: 0, undated: 0, mirrored: 0 };
  // 1. Settled jobs whose clocks nobody closed.
  const toSettle = await prisma.revisionBrief.findMany({
    where: { dueAt: { not: null }, createdAt: { gte: new Date(now.getTime() - 90 * 86_400_000) }, project: { status: { in: ["DELIVERED", "CANCELLED"] } } },
    select: { projectId: true },
    distinct: ["projectId"],
    take: 200,
  });
  for (const r of toSettle) if (await settleReopenedClocks(r.projectId, now)) out.settled++;
  // 2 + 3. Reopened work.
  const { reopenedWork } = await import("@/lib/deliveryBoard");
  for (const r of await reopenedWork({ now })) {
    try {
      if (r.due.undated) {
        const at = await reopenMomentOf(r.projectId, r.deliveredAt);
        if (!at || now.getTime() - at.getTime() > REOPEN_NET_WINDOW_MS) {
          out.undated++;
          continue;
        }
        const s = await stampReopenedClock(r.projectId, { at, why: "put back after delivery", by: HUB });
        if (s.stamped) out.stamped++;
        else out.undated++;
      } else if (r.due.source !== "OFFICE_OVERRIDE") {
        out.mirrored += await mirrorClockToTasks(r.projectId);
      }
    } catch { /* one job never stops the rest */ }
  }
  return out;
}

/** When this reopen happened, from the record — or null when nothing says. */
async function reopenMomentOf(projectId: string, deliveredAt: Date): Promise<Date | null> {
  const settled = await settledMarkerAt(projectId);
  const floor = new Date(Math.max(deliveredAt.getTime(), settled?.getTime() ?? 0));
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { revisionRequestedAt: true } });
  const asked = p?.revisionRequestedAt && p.revisionRequestedAt > floor ? p.revisionRequestedAt : null;
  // moveProjectStatus's own timeline line (app/actions.ts): the board move.
  const moved = await prisma.activity.findFirst({
    where: { projectId, createdAt: { gt: floor }, body: { startsWith: "Moved from Delivered to " } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const candidates = [asked, moved?.createdAt ?? null].filter((d): d is Date => !!d);
  return candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
}
