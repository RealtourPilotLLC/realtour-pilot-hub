import "server-only";
import { prisma } from "@/lib/prisma";
import { clip } from "@/lib/text";
import { stagedPhotosOrdered } from "@/lib/stagingCount";
import { photoNumbers } from "@/lib/photoDelivery/careRules";
import { PHOTO_OFFICE_KEY_PREFIX, PHOTO_SHARED_KEY_PREFIX, isEcho, isOfficeQuestion, isPhotoOnly, itemMediumOf, itemPhotoNumbers, mediumOfItem, type ItemMedium } from "@/lib/itemMedium";

// ---------------------------------------------------------------------------
// THE PHOTO PART OF A CLIENT'S MESSAGE (Oct 22 2026, 859 N Lawrence St).
//
// Jordan: "Joe Sutow texted about a video revision, then texted about virtual
// staging in photos. The photo staging issue is showing up on the video
// review room. It should not be." A client's text on a delivered job becomes
// a work order (lib/revisionBrief) and each item says what it is about
// (lib/itemMedium). This file takes the photo part to where photo work is
// handled: the photo job's client asks (lib/clientAsks, shown on the photo
// job's "What's holding this" and Kyle's boards), never the editor or the
// Video Review Room.
//
//   · CHANGES   items about the photos ("restage pic 11 with a dining table"):
//               one ask per message, under the same key the message's own
//               photo ask uses (comms.ts files one when the photos were
//               already out), so the message is filed once whichever comes
//               first;
//   · OFFICE    new work that was not ordered (the model's SCOPE, or virtual
//               staging on an order with none) and the open questions about
//               the photos: a question for Jordan or Kyle (scope or price),
//               one per job and photo, a later message about the same photo
//               added to it while it is open;
//   · SHARED    items about both, or that nobody can tell: an ask labelled
//               so, on the photo side too (they also stay on the video side).
// Every one carries the client's full words ("Everything they said"). An item
// the model lifted from an earlier message in the conversation (its quote is
// not in this message) is not filed again. Delivered photos reopen for it
// (photoDelivery/clientAsked.photoAskAfterDelivery), on the delivery owner's
// list. Nothing here messages a client.
// ---------------------------------------------------------------------------

/** Requests that are a video's by construction (a portal pin, staff in the Review Room, the office's own reopen). */
const VIDEO_ONLY_SOURCES = new Set(["portal", "review_room_staff", "office"]);

type Item = { id: string; area?: string; ask: string; detail?: string | null; quote?: string | null; kind?: string; medium?: string; held?: boolean };
type Doc = { items?: Item[]; questions?: string[]; photoQuestions?: string[]; photoAsks?: { at: string; ids: string[] }; [k: string]: unknown };

export type PhotoPartStep = {
  what: "changes" | "office" | "shared";
  key: string;
  medium: ItemMedium;
  summary: string;
  /** create a new ask · exists (filed already, left as it is) · append (an open office question about the same photo gets this message too) */
  action: "create" | "exists" | "append";
  askId: string | null;
  items: string[];
  questions: string[];
  /** What this message adds, without the office's wording (an append adds only this). */
  core: string;
};
export type PhotoPartPlan = { briefId: string; projectId: string; steps: PhotoPartStep[]; echoes: string[]; reopened: boolean; dryRun: boolean };

const parse = (s: string | null | undefined): Doc => {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {}; } catch { return {}; }
};

/** The channel a brief's source names (comms.channelOfSource's rule, without its import graph). */
function channelOf(source: string): "text" | "email" | "call" {
  const s = (source || "").toLowerCase();
  if (s === "phone" || /\bcall\b|-call\b|voicemail|missed_call/.test(s)) return "call";
  if (s.includes("gmail") || s.includes("email")) return "email";
  return "text";
}

type HistoryLine = { at: string; by: string; what: string };
function pushHistory(json: string | null | undefined, line: HistoryLine): string {
  let arr: HistoryLine[] = [];
  try { arr = json ? (JSON.parse(json) as HistoryLine[]) : []; } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr.push(line);
  return JSON.stringify(arr.slice(-30));
}

const sentence = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.;:,]+$/, "");

export type LabelResult = { briefId: string; changed: boolean; itemsJson: string; items: { id: string; ask: string; medium: ItemMedium; was: string | null }[]; questions: string[]; photoQuestions: string[] };

/**
 * Label a work order written before items said what they are about (or read
 * one again): each item gets its medium (lib/itemMedium's rule, the model's
 * label kept where there is one), a photo item leaves the video it was put
 * on, and the open questions about the photos move to `photoQuestions`.
 * Everything else on the row (the creative review, ticks, references) stays.
 * `dryRun`: return the new row, write nothing. Then run
 * creativeReview.routeCreativeReview and routeBriefPhotoAsks on it.
 */
export async function labelBriefMedia(briefId: string, opts: { dryRun?: boolean } = {}): Promise<LabelResult | null> {
  const brief = await prisma.revisionBrief.findUnique({
    where: { id: briefId },
    select: { id: true, source: true, decisionId: true, itemsJson: true, project: { select: { deliverables: { where: { removedFromOrderAt: null }, select: { type: true } } } } },
  });
  if (!brief?.itemsJson) return null;
  const doc = parse(brief.itemsJson);
  const items = Array.isArray(doc.items) ? doc.items : [];
  // The analyser's rule: a pinned request, or a job with no photo work, is the video's.
  const photoWork = (brief.project?.deliverables ?? []).some((d) => d.type !== "VIDEO" && d.type !== "SOCIAL_REEL");
  const videoOnly = VIDEO_ONLY_SOURCES.has(brief.source) || !!brief.decisionId || !photoWork;
  const { labelWorkOrder } = await import("@/lib/itemMedium");
  const l = labelWorkOrder({ items, questions: doc.questions ?? [], photoQuestions: doc.photoQuestions ?? [] }, { videoOnly });
  const nextItems = l.items.map((it) => (isPhotoOnly(it) ? { ...it, held: undefined, scope: "unknown", cuts: null } : it));
  const next = { ...doc, items: nextItems, questions: l.questions, photoQuestions: l.photoQuestions };
  const itemsJson = JSON.stringify(next);
  const changed = itemsJson !== JSON.stringify(doc);
  if (changed && !opts.dryRun) await prisma.revisionBrief.update({ where: { id: briefId }, data: { itemsJson } });
  return {
    briefId, changed, itemsJson,
    items: l.items.map((it) => ({ id: it.id, ask: it.ask, medium: it.medium, was: typeof (items.find((x) => x.id === it.id)?.medium) === "string" ? (items.find((x) => x.id === it.id)!.medium as string) : null })),
    questions: l.questions, photoQuestions: l.photoQuestions,
  };
}

/**
 * File the photo part of one work order. `dryRun`: say what would be filed,
 * write nothing (`itemsJson`: read this row instead of the stored one, for a
 * dry run after labelBriefMedia's). `afterDelivery: false`: file the asks but
 * leave the photo job and its task as they are (a clean-up on a job already
 * reopened). Idempotent: every ask is keyed, so a second run files nothing
 * new. Never throws; null when the brief is not a client's message.
 */
export async function routeBriefPhotoAsks(briefId: string, opts: { dryRun?: boolean; now?: Date; itemsJson?: string; afterDelivery?: boolean } = {}): Promise<PhotoPartPlan | null> {
  try {
    return await route(briefId, !!opts.dryRun, opts.now ?? new Date(), opts.itemsJson ?? null, opts.afterDelivery !== false);
  } catch (e) {
    console.error("[photo part] routing failed", briefId, e);
    return null;
  }
}

async function route(briefId: string, dryRun: boolean, now: Date, itemsJsonOverride: string | null, afterDelivery: boolean): Promise<PhotoPartPlan | null> {
  const brief = await prisma.revisionBrief.findUnique({
    where: { id: briefId },
    select: {
      id: true, projectId: true, source: true, originalText: true, itemsJson: true, createdAt: true, requestedBy: true, decisionId: true,
      project: {
        select: {
          title: true, clientId: true, client: { select: { name: true } },
          orderItems: { select: { title: true, quantity: true, isCanceled: true } },
          deliverables: { select: { type: true, quantity: true, productTitle: true, label: true, removedFromOrderAt: true, waivedAt: true } },
        },
      },
    },
  });
  if (!brief?.project?.clientId || VIDEO_ONLY_SOURCES.has(brief.source) || brief.decisionId) return null;
  // A job with no photo work has no photo side to send anything to.
  if (!brief.project.deliverables.some((d) => !d.removedFromOrderAt && d.type !== "VIDEO" && d.type !== "SOCIAL_REEL")) return null;
  const clientId = brief.project.clientId;
  const doc = parse(itemsJsonOverride ?? brief.itemsJson);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const words = brief.originalText;
  const plan: PhotoPartPlan = { briefId, projectId: brief.projectId, steps: [], echoes: [], reopened: false, dryRun };
  // Oct 23 2026 (Jordan): staged photos ordered = the staging line's quantity,
  // or the number a custom line's title states; not known otherwise (stagingCount.ts).
  const staging = stagedPhotosOrdered(brief.project.orderItems, brief.project.deliverables);
  const stagingOrdered = staging.ordered;

  const fresh = (it: Item) => {
    if (isEcho(it.quote, words)) { plan.echoes.push(it.ask); return false; }
    return true;
  };
  const photoItems = items.filter((it) => isPhotoOnly(it) && fresh(it));
  const office = photoItems.filter((it) => isOfficeQuestion(it, { stagingOrdered }));
  const changes = photoItems.filter((it) => !office.includes(it));
  const shared = items.filter((it) => !isPhotoOnly(it) && mediumOfItem(it) !== "video" && fresh(it));
  const officeQs = (doc.photoQuestions ?? []).map(sentence).filter(Boolean);
  const sharedQs = (doc.questions ?? []).filter((q) => itemMediumOf(q) === "both").map(sentence);
  if (!changes.length && !office.length && !officeQs.length && !shared.length && !sharedQs.length) return plan;

  const { messageAskKey } = await import("@/lib/clientAsks");
  if (changes.length) {
    const core = clip(changes.map((it) => sentence(it.ask)).join("; "), 240);
    plan.steps.push({
      what: "changes", key: messageAskKey(clientId, brief.projectId, "SPECIAL_REQUEST", words), medium: "photo",
      summary: core, core, action: "create", askId: null,
      items: changes.map((it) => it.ask), questions: [],
    });
  }
  if (office.length || officeQs.length) {
    const nums = [...new Set([...office.map((it) => itemPhotoNumbers(it)), ...officeQs.map((q) => photoNumbers(q))].filter((x): x is string => !!x))].join(", ");
    const asks = office.map((it) => sentence(it.ask)).join("; ");
    // The work, then what the office has to settle. The model's own questions
    // are the line only when there is no work named (the line IS the question
    // then); the client's words are on the ask either way.
    const qs = officeQs.map((q) => (/[?!]$/.test(q) ? q : `${q}.`)).join(" ");
    // Oct 22 2026 (photo audit M11, 859 N Lawrence St): staging IS on that
    // order; only the count ordered was exceeded. Said so (officeWhy). Oct 23:
    // the count is the order's own (no "3 per line"), or not known.
    const stagedOrdered = staging.ordered ? staging.count : 0;
    const summary = clip(asks ? `${asks}. ${officeWhy(office.map((it) => `${it.ask ?? ""} ${it.detail ?? ""} ${it.quote ?? ""}`), stagedOrdered)}` : qs, 240);
    plan.steps.push({ what: "office", key: `${PHOTO_OFFICE_KEY_PREFIX}${brief.projectId}:${nums || "job"}`, medium: "photo", summary, core: clip(asks || qs, 200), action: "create", askId: null, items: office.map((it) => it.ask), questions: officeQs });
  }
  if (shared.length || sharedQs.length) {
    const medium: ItemMedium = shared.some((it) => mediumOfItem(it) === "unclear") ? "unclear" : "both";
    const core = clip([...shared.map((it) => sentence(it.ask)), ...sharedQs].join("; "), 240);
    plan.steps.push({
      what: "shared", key: `${PHOTO_SHARED_KEY_PREFIX}${briefId}`, medium,
      summary: core, core, action: "create", askId: null,
      items: shared.map((it) => it.ask), questions: sharedQs,
    });
  }

  // What is already filed under each key.
  for (const s of plan.steps) {
    const prior = await prisma.clientAsk.findUnique({ where: { dedupeKey: s.key }, select: { id: true, state: true, text: true, summary: true } });
    if (!prior) continue;
    if (s.what !== "office") { s.action = "exists"; s.askId = prior.id; continue; }
    if (prior.state === "OPEN") {
      s.askId = prior.id;
      s.action = prior.text.includes(words.trim()) ? "exists" : "append";
    } else {
      // Settled already: a new question about the same photo is a new ask.
      s.key = `${s.key}:${briefId}`;
      const again = await prisma.clientAsk.findUnique({ where: { dedupeKey: s.key }, select: { id: true } });
      if (again) { s.action = "exists"; s.askId = again.id; }
    }
  }
  if (dryRun) return plan;

  const { createAsk } = await import("@/lib/clientAsks");
  const who = brief.requestedBy?.trim() || brief.project.client?.name?.trim() || null;
  const by = "hub (the photo part of a client's message)";
  for (const s of plan.steps) {
    if (s.action === "create") {
      const r = await createAsk({
        clientId, projectId: brief.projectId, kind: "SPECIAL_REQUEST", medium: s.medium,
        text: clip(words, 4000), summary: s.summary, source: channelOf(brief.source),
        askedBy: who, askedAt: brief.createdAt, holdsDelivery: true, dedupeKey: s.key, by,
      });
      s.askId = r?.id ?? null;
      if (r && !r.created) s.action = "exists";
    } else if (s.action === "append" && s.askId) {
      const row = await prisma.clientAsk.findUnique({ where: { id: s.askId }, select: { text: true, summary: true, historyJson: true, state: true } });
      if (row?.state !== "OPEN") continue;
      const add = s.core && !(row.summary ?? "").includes(s.core.slice(0, 60)) ? s.core : null;
      await prisma.clientAsk.update({
        where: { id: s.askId },
        data: {
          text: clip(`${row.text}\n\n${words}`, 4000),
          summary: add ? clip(`${row.summary ? `${/[.?!]$/.test(row.summary.trim()) ? row.summary.trim() : `${sentence(row.summary)}.`} Then they asked: ` : ""}${add}`, 240) : undefined,
          historyJson: pushHistory(row.historyJson, { at: now.toISOString(), by, what: "the client's next message about the same photo" }),
        },
      });
    }
  }
  const ids = plan.steps.map((s) => s.askId).filter((x): x is string => !!x);
  // The marker comms.ts reads (photoPartRoutedFor): this message's photo part is filed.
  const latest = await prisma.revisionBrief.findUnique({ where: { id: briefId }, select: { itemsJson: true } });
  await prisma.revisionBrief.update({ where: { id: briefId }, data: { itemsJson: JSON.stringify({ ...parse(latest?.itemsJson), photoAsks: { at: now.toISOString(), ids } }) } });
  if (plan.steps.every((s) => s.action === "exists")) return plan;
  const n = plan.steps.length;
  await prisma.activity
    .create({ data: { projectId: brief.projectId, type: "SYSTEM", body: clip(`The part of ${who ?? "the client"}'s message about the photos went to the photo job (${n === 1 ? "1 request" : `${n} requests`}), not to the video editor.`, 300) } })
    .catch(() => {});
  if (!afterDelivery) return plan;
  // Photos already out: the photo job reopens for it, on the delivery owner's list.
  const { photoAskAfterDelivery } = await import("@/lib/photoDelivery/clientAsked");
  const r = await photoAskAfterDelivery({
    projectId: brief.projectId,
    words: plan.steps.map((s) => s.summary).join(". "),
    by: who ?? "client",
    askedBy: who,
    clientId,
  });
  plan.reopened = r.reopened;
  return plan;
}

/**
 * Why an office question is the office's (pure; photo audit M11). Staging
 * asked for on an order that has staging is more than was ordered, never "not
 * on the order": "More than the 1 staged photo ordered: confirm …".
 * `stagedOrdered`: the staged photos the order buys (stagingCount.ts), 0 when
 * it has no staging, null when staging is on it but no line says how many
 * (Oct 23 2026: never a guess; the office is asked the count too).
 */
export function officeWhy(itemWords: string[], stagedOrdered: number | null): string {
  const tail = "confirm the scope or price with the client first.";
  const staging = itemWords.some((w) => /\bstag(?:e|ed|ing)\b/i.test(w));
  if (staging && stagedOrdered == null) return "Virtual staging is on the order, but not how many photos: confirm the count, scope or price with the client first.";
  if (staging && stagedOrdered != null && stagedOrdered > 0) return `More than the ${stagedOrdered} staged photo${stagedOrdered === 1 ? "" : "s"} ordered: ${tail}`;
  return `Not on the order: ${tail}`;
}

/**
 * Was this message's photo part already filed by its work order? comms.ts
 * asks before filing the message as one photo ask, so the same words never
 * reach the photo job twice (once as a whole, once split). Never throws.
 */
export async function photoPartRoutedFor(projectId: string, text: string, now: Date = new Date()): Promise<boolean> {
  try {
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const want = norm(text);
    if (!want) return false;
    const rows = await prisma.revisionBrief.findMany({
      where: { projectId, createdAt: { gte: new Date(now.getTime() - 30 * 60_000) }, itemsJson: { contains: "\"photoAsks\"" } },
      select: { originalText: true, itemsJson: true },
      take: 10,
    });
    return rows.some((r) => norm(r.originalText) === want && (parse(r.itemsJson).photoAsks?.ids ?? []).length > 0);
  } catch {
    return false;
  }
}
