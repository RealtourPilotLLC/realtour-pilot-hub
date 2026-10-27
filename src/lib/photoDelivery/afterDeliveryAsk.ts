import "server-only";

import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { clip, scrubMoney } from "@/lib/text";
import { etDateTime } from "@/lib/datetime";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// NOT EVERY REQUEST AFTER DELIVERY IS A PHOTO FIX (Oct 27 2026).
//
// Jordan, on 913 Lakeview (Mike Flatley texted "Upload all 913 Lakeview
// deliverables to Showcase before tomorrow" and the delivered photo job
// reopened as "Client asked for changes after delivery"): "if it's in regard
// to something other than photos, then it should not be reopened here. it
// should be made a task on Kyle's dashboard" and "AI should pick up on that
// and not open this one".
//
// So a client's request that lands after the photos went out is read first:
//   1. plain words decide when they can (a photo number, crop, brighten,
//      remove, staging ... is a photo fix; upload, Showcase, Zillow, MLS, the
//      link, a floor plan, scheduling ... is office work; music, the reel ...
//      is the video's);
//   2. when the words say both or neither, the AI is asked;
//   3. when the AI is down or not sure: office work (Kyle's task), never a
//      reopen (a person can still reopen it by hand: Add a request, photos).
// Office work never touches the photo job: the request goes on Kyle's list as
// a task (one already open for the same words is used, never a second one),
// with Open the listing and Mark handled, and the message's photo request is
// closed with why (a video one is left to the video side).
// ---------------------------------------------------------------------------

export type AfterDeliveryKind = "photo" | "office" | "video";
export type AfterDeliveryJudgement = { kind: AfterDeliveryKind; why: string; by: "words" | "ai" | "fail-safe" };

const PHOTO_NUMBER = /\b(?:photos?|pics?|pictures?|images?|shots?)\s*(?:#|no\.?|number)?\s*\d+/i;
const PHOTO_FIX = /\b(?:crop(?:ped|ping)?|retouch\w*|photoshop\w*|brighten\w*|darken\w*|lighten\w*|lighter|darker|straighten\w*|re-?edit\w*|re-?stage\w*|virtual(?:ly)? stag\w*|stage[sd]?|staging|declutter\w*|blur(?:red)?|colou?r correct\w*|white balance|exposure|twilight|sky|skies|grass|lawn|lot lines?|lamps?|cars?|trash|garbage|bins?|hoses?|cords?|reflections?|tilt(?:ed)?|crooked|lean(?:s|ing)?|warp(?:ed)?|blurry)\b/i;
const EDIT_VERB = /\b(?:remove|take out|erase|fix|swap|replace|put back|add back|change|edit|clean up|touch up|move)\b/i;
const PHOTO_NOUN = /\b(?:photos?|pics?|pictures?|images?|shots?|the edits|edited ones)\b/i;
const OFFICE = /\b(?:upload\w*|post(?:ed|ing)? (?:them|it|the)|publish\w*|showcase|zillow|mls|realtor\.com|redfin|homes\.com|website|instagram|facebook|youtube|tiktok|deliverables|download\w*|(?:the|a|new) link|access|password|log ?in|resend|re-send|forward|share|schedul\w*|reschedul\w*|book(?:ed|ing)?|appointment|floor ?plans?|3d tour|matterport|virtual tour|brochure|flyer|print\w*|sign ?post|lockbox)\b/i;
const VIDEO = /\b(?:video|reel|music|song|soundtrack|voice ?over|captions?|subtitles?|footage|clip|drone video)\b/i;

/**
 * What plain words say a request after delivery is (pure): a photo fix, office
 * work or the video's, or null when they say both or neither (the AI is asked).
 */
export function afterDeliveryByWords(words: string): AfterDeliveryKind | null {
  const w = (words ?? "").replace(/\s+/g, " ").trim();
  if (!w) return null;
  const photo = PHOTO_NUMBER.test(w) || PHOTO_FIX.test(w) || (EDIT_VERB.test(w) && PHOTO_NOUN.test(w));
  const office = OFFICE.test(w);
  const video = VIDEO.test(w);
  if (photo && !office && !video) return "photo";
  if (!photo && office) return "office";
  if (!photo && !office && video) return "video";
  return null;
}

type AiAnswer = { kind?: unknown; sure?: unknown };
let judgeImpl: ((prompt: string) => Promise<AiAnswer>) | null = null;
/** Drills only. */
export function __setAfterDeliveryJudgeForTests(fn: typeof judgeImpl) {
  judgeImpl = fn;
}

const SYSTEM = "You sort a real estate client's request that came in after their listing photos were delivered. You output only JSON. No em dashes.";

async function askAi(words: string): Promise<AiAnswer> {
  const prompt = [
    "The listing photos were already delivered to this client. Their request:",
    `"${clip(words, 1200)}"`,
    "",
    "kind:",
    "- photo_edit: they want the delivered photos themselves changed (edit, crop, remove or add something, brighten, straighten, stage, swap a photo).",
    "- office: anything the office does, not an edit of the photos (upload or post them somewhere such as Showcase, Zillow or the MLS, send a link, a floor plan or 3D tour, billing, scheduling, a question).",
    "- video_edit: a change to the video only.",
    "When it asks for a photo edit AND something else, it is photo_edit.",
    "sure: true only when the request plainly says which.",
    'Answer {"kind":"photo_edit|office|video_edit","sure":true|false}.',
  ].join("\n");
  if (judgeImpl) return judgeImpl(prompt);
  const { aiJson } = await import("@/lib/integrations/ai");
  return aiJson<AiAnswer>({
    system: SYSTEM,
    prompt,
    schema: { type: "object", properties: { kind: { type: "string", enum: ["photo_edit", "office", "video_edit"] }, sure: { type: "boolean" } }, required: ["kind", "sure"] },
    maxTokens: 120,
    feature: "photo-after-delivery",
  });
}

/**
 * Is a request after delivery a photo fix? Plain words first, then the AI;
 * the AI down or unsure is office work (a Kyle task, never a reopen). Never
 * throws.
 */
export async function judgeAfterDeliveryAsk(words: string): Promise<AfterDeliveryJudgement> {
  const byWords = afterDeliveryByWords(words);
  if (byWords) return { kind: byWords, by: "words", why: byWords === "photo" ? "it asks for a change to the photos" : byWords === "video" ? "it is about the video" : "it is office work, not a change to the photos" };
  try {
    const a = await askAi(words);
    const kind = a?.kind === "photo_edit" ? "photo" : a?.kind === "video_edit" ? "video" : a?.kind === "office" ? "office" : null;
    if (kind === "photo" && a.sure === true) return { kind, by: "ai", why: "it asks for a change to the photos" };
    if (kind === "video" && a.sure === true) return { kind, by: "ai", why: "it is about the video" };
    if (kind === "office") return { kind, by: "ai", why: "it is office work, not a change to the photos" };
    return { kind: "office", by: "fail-safe", why: "it is not clear it asks for a change to the photos" };
  } catch {
    return { kind: "office", by: "fail-safe", why: "it could not be read as a change to the photos" };
  }
}

/** The job event a request that is not a photo fix writes (the photo job's activity). */
export const OFFICE_ASK_ACTION = "client request after delivery is not a photo fix: on Kyle's list";
/** Kyle's task for such a request (officeDesk: Handle request, Open the listing, Mark handled). */
export const OFFICE_TASK_KEY_PREFIX = "after-delivery-office:";

const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const STOP = new Set(["the", "and", "for", "all", "you", "can", "please", "our", "your", "with", "that", "this", "them", "are", "before", "after", "from", "will", "would", "could", "just", "also", "get", "out", "have", "has", "need", "needs"]);
const tokens = (s: string) => new Set(norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t)));

/** Do a task's words and a request's words name the same job of work (pure)? Three shared words and most of the shorter side. */
export function sameRequestWords(a: string, b: string): boolean {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared >= 3 && shared / Math.min(A.size, B.size) >= 0.6;
}

/**
 * A request after delivery that is not a photo fix: the photo job is left as
 * it is; the message's photo request is closed with why (or, when it names the
 * video, put on the video); office work goes on Kyle's list as a task, the
 * open one for the same words when there is one. Returns the task. Never throws.
 */
export async function routeOfficeAsk(input: {
  projectId: string; jobId: string; words: string; kind: "office" | "video"; why: string; askedBy?: string | null; clientId?: string | null; askKey?: string | null; by: string;
}): Promise<{ taskId: string | null; reused: boolean; closed: number }> {
  const out = { taskId: null as string | null, reused: false, closed: 0 };
  try {
    const words = clip(scrubMoney(input.words.replace(/\s+/g, " ").trim()), 400);
    const [project, job] = await Promise.all([
      prisma.project.findUnique({ where: { id: input.projectId }, select: { title: true, clientId: true } }),
      prisma.photoJob.findUnique({ where: { id: input.jobId }, select: { deliveredAt: true, stageChangedAt: true } }),
    ]);
    if (!project) return out;
    const street = (project.title ?? "").split(",")[0].trim() || "the job";
    // 1. The task (office work only): the open one for the same words, else a new one on Kyle's list.
    if (input.kind === "office") {
      const since = new Date(Date.now() - 14 * 86_400_000);
      const open = await prisma.smartTask.findMany({
        // The brain's own task for the message counts (it is usually a client_reply titled with the work, as
        // 913 Lakeview's "Upload 913 Lakeview assets to Showcase before tomorrow" was); a revision's to-do never does.
        where: { projectId: input.projectId, status: { notIn: ["COMPLETED", "CANCELLED"] }, createdAt: { gte: since }, taskType: { not: "revision" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, title: true, summary: true, description: true, ownerId: true, assignedKey: true, dedupeKey: true },
        take: 40,
      });
      const key = `${OFFICE_TASK_KEY_PREFIX}${input.projectId}:${sha(norm(words))}`;
      const same = open.find((t) => t.dedupeKey === key) ?? open.find((t) => sameRequestWords(`${t.title} ${t.summary ?? ""} ${t.description ?? ""}`, words));
      const { kyleDesk } = await import("@/lib/kyleNotice");
      const desk = await kyleDesk();
      if (same) {
        out.taskId = same.id;
        out.reused = true;
        if (!same.ownerId && !same.assignedKey && desk) await prisma.smartTask.update({ where: { id: same.id }, data: { ownerId: desk.id, assignedKey: desk.key } }).catch(() => {});
      } else {
        const who = input.askedBy?.trim() || "The client";
        const made = await prisma.smartTask
          .create({
            data: {
              taskType: "todo",
              title: clip(`${street}: ${words}`, 120),
              summary: clip(`${who} asked after the photos were delivered: "${words}". It is not a change to the photos, so the photo job stays delivered. Open the listing, do it, then mark it handled.`, 500),
              description: `${who} (${etDateTime(new Date())}): "${words}"`,
              reasonCreated: "Client request after the photos were delivered, not a photo fix",
              checklist: JSON.stringify(["Read the client's request", "Open the listing", "Do it", "Mark it handled"]),
              source: "system",
              sourceDetail: `/listings/${input.projectId}`,
              priority: "HIGH",
              dueAt: new Date(Date.now() + 2 * 3_600_000),
              clientId: input.clientId ?? project.clientId,
              projectId: input.projectId,
              propertyAddress: project.title,
              dedupeKey: key,
              ownerId: desk?.id ?? null,
              assignedKey: desk?.key ?? null,
            },
            select: { id: true },
          })
          .catch(async () => (await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } })) ?? null);
        out.taskId = made?.id ?? null;
      }
    }
    // 2. The message's request on the photo side: closed with why, or put on the video.
    const deliveredAt = job?.deliveredAt ?? job?.stageChangedAt ?? null;
    const asks = await prisma.clientAsk.findMany({
      where: { projectId: input.projectId, state: "OPEN", kind: "SPECIAL_REQUEST", OR: [{ medium: { in: ["photo", "both", "unclear"] } }, { medium: null }], ...(deliveredAt ? { askedAt: { gte: new Date(deliveredAt.getTime() - 60_000) } } : {}) },
      select: { id: true, text: true, medium: true, dedupeKey: true },
      take: 40,
    });
    const { closeAskWithReason, sameAskWords, setAskMedium } = await import("@/lib/clientAsks");
    const note = input.kind === "office" ? `Not a change to the photos: on Kyle's list as a task (${clip(words, 120)})` : "About the video, not the photos";
    for (const a of asks) {
      if (!((input.askKey && a.dedupeKey === input.askKey) || sameAskWords(a.text, input.words) || sameRequestWords(a.text, input.words))) continue;
      const toVideo = input.kind === "video" || (a.medium !== "photo" && VIDEO.test(a.text));
      const r = toVideo ? await setAskMedium(a.id, "video", input.by) : await closeAskWithReason(a.id, input.by, note);
      if (r.ok) out.closed++;
    }
    await logJobEvent(input.jobId, input.by, input.kind === "office" ? OFFICE_ASK_ACTION : "client request after delivery is about the video: photos left as delivered", { words, why: input.why, taskId: out.taskId, reused: out.reused, closed: out.closed });
    await prisma.activity
      .create({ data: { projectId: input.projectId, type: "SYSTEM", body: clip(input.kind === "office" ? `Not a photo fix, so the photos stay delivered (${input.why}): "${words}". ${out.reused ? "Already on Kyle's list as a task." : "On Kyle's list as a task."}` : `About the video, so the photos stay delivered: "${words}".`, 600) } })
      .catch(() => {});
    return out;
  } catch (e) {
    console.error("[photo-delivery] routing a request after delivery failed", input.projectId, e);
    return out;
  }
}
