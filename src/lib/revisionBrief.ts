import "server-only";
import { prisma } from "@/lib/prisma";
import { aiJson } from "@/lib/integrations/ai";
import { stripMoneySentences } from "@/lib/text";

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

export type RevisionItem = {
  id: string;
  area: string;
  ask: string; // imperative, concrete — the thing to do
  detail?: string | null; // the specifics that make it actionable
  quote?: string | null; // the client's own words, verbatim
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
        },
        required: ["area", "ask", "detail", "quote"],
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
9. Never mention prices, invoices, or payment. If the client discussed money, leave it out entirely.`;

// The client's ask can be long (a 20-minute call). Give the model plenty of
// room but keep a hard ceiling so one runaway transcript can't blow the request.
const MAX_INPUT = 24_000;

export async function analyzeRevisionText(opts: {
  text: string;
  twoSided: boolean;
  clientName?: string | null;
  propertyAddress?: string | null;
  deliverables?: string[];
}): Promise<RevisionAnalysis> {
  const context = [
    opts.clientName ? `Client: ${opts.clientName}` : null,
    opts.propertyAddress ? `Job: ${opts.propertyAddress}` : null,
    opts.deliverables?.length ? `What we made for them: ${opts.deliverables.join(" · ")}` : null,
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
    .map((i, n) => ({
      id: `i${n + 1}`,
      area: REVISION_AREAS.includes(i.area as (typeof REVISION_AREAS)[number]) ? i.area : "Other",
      ask: i.ask.trim(),
      detail: (i.detail ?? "").trim() || null,
      quote: (i.quote ?? "").trim() || null,
    }));

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
}): Promise<string | null> {
  const text = (opts.text ?? "").trim();
  if (!text) return null;
  // Don't spend a model call on "can you brighten the kitchen photo" — a short
  // ask is already a work order. The card renders it as one item.
  const worthAnalyzing = text.length >= 240;

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
      },
      select: { id: true },
    });
  } catch {
    return null; // never break a revision over its paperwork
  }

  if (!worthAnalyzing) return brief.id;
  await analyzeBrief(brief.id, opts);
  return brief.id;
}

/** Run (or re-run) the analysis for one brief. Never throws. */
export async function analyzeBrief(
  briefId: string,
  ctx?: { clientName?: string | null; propertyAddress?: string | null; deliverables?: string[] },
): Promise<boolean> {
  const brief = await prisma.revisionBrief.findUnique({
    where: { id: briefId },
    select: {
      id: true,
      originalText: true,
      twoSided: true,
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
  try {
    const analysis = await analyzeRevisionText({
      text: brief.originalText,
      twoSided: brief.twoSided,
      clientName: ctx?.clientName ?? brief.project?.client?.name ?? null,
      propertyAddress: ctx?.propertyAddress ?? brief.project?.title ?? null,
      deliverables:
        ctx?.deliverables ??
        (brief.project?.deliverables ?? []).map((d) => d.label || d.type).filter(Boolean),
    });
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
    return true;
  } catch (e) {
    await prisma.revisionBrief
      .update({
        where: { id: briefId },
        data: { analysisError: (e as Error).message.slice(0, 300) },
      })
      .catch(() => {});
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
    };
  });
}
