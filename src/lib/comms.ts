import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { createCommTask, mergeIntoExistingTask, closeObsoleteTasks, revisionPriority } from "@/lib/tasks";
import { routeCommTask } from "@/lib/brain";
import type { NotifyTarget } from "@/lib/notify";
import { clip } from "@/lib/text";
import { REVISION_FLAG_PREFIX } from "@/lib/debrief";

// ---------------------------------------------------------------------------
// Communications cross-check for the smart-status engine.
//
// Clients often ask for changes AFTER we've delivered ("can you brighten the
// kitchen", "the video is missing the backyard", "swap the cover photo"). Aryeo
// still shows the order fulfilled, so without watching comms a revision request
// silently falls through. This layer classifies every inbound client message
// and, when it reads as a change/revision request on a delivered-ish job, kicks
// the project into REVISION with an urgent task.
//
// Source-agnostic on purpose: OpenPhone calls it today; Gmail / Facebook
// Messenger / web form listeners call the SAME entry point as they come online.
// ---------------------------------------------------------------------------

// Phrases that signal the client wants something changed/added/fixed. Kept
// deliberately broad — a false positive just shows up as a dismissible REVISION
// flag with the triggering message, which is far cheaper than missing a real one.
const REVISION_PATTERNS: RegExp[] = [
  /\brevis(e|ion|ions)\b/i,
  /\bre-?(do|edit|shoot|take|deliver)\b/i,
  /\bredo\b/i,
  /\bedit (it|them|again|the)\b/i,
  /\bchange[sd]?\b/i,
  /\badjust(ed|ment)?\b/i,
  /\b(can|could|would|please|pls|plz) (you )?(also )?(add|change|fix|redo|adjust|edit|update|remove|replace|swap|retouch|brighten|darken|crop)\b/i,
  /\bfix(ed|ing)?\b/i,
  /\bcorrect(ed|ion)?\b/i,
  /\breplace\b/i,
  /\bswap\b/i,
  /\bretouch\b/i,
  /\bremove\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\b(too )?(dark|bright|blurry|grainy|crooked|tilted)\b/i,
  /\b(not|isn'?t|doesn'?t look) (right|good|happy)\b/i,
  /\b(missing|forgot|left out|didn'?t (get|include|send))\b/i,
  /\b(issue|problem|mistake|wrong|error)\b/i,
  /\bre-?send\b/i,
  /\bdifferent (photo|image|angle|shot|version)\b/i,
];

// Exported because the reply walk (src/lib/replyQueue.ts) needs the SAME test
// for "this closes a thread, it doesn't open one". It used to be copied there
// under a comment reading "keep the two in sync", which is a promise no comment
// can keep — the copies had already drifted.
export const PRAISE_ONLY = /\b(thank|thanks|thx|love|great|perfect|awesome|amazing|looks good|beautiful|gorgeous)\b/i;

// A clear edit ask — these still count as a revision even amid scheduling talk.
const STRONG_REVISION =
  /\b(revis(e|ion|ions)|re-?(do|edit|shoot|take)|reshoot|brighten|darken|retouch|too (dark|bright|blurry|grainy|crooked|tilted)|different (photo|image|angle|shot|version)|virtual stag|swap|replace)\b/i;
// Scheduling / availability / booking talk — NOT a revision (e.g. "Thursday works,
// that's the soonest you have"). This is the #1 false-positive source.
const SCHEDULING_RE =
  /\b(re-?schedul|booking|book (a|the|us|me|it|an)|appointment|availab|what time|when can|come (out|back)|next (week|month)|this (week|coming)|push (it|the)|move the (shoot|appointment|date)|soonest|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
// Client unhappiness — log for happiness/issue tracking even if not a revision.
//
// Sep 16 (Kyle call, item 10): the one row this ever filed was Jamie's "We're
// still waiting on 2844 Edgemont Dr, but I'll let you know when we hear back!"
// — a seller-confirmation FYI that sat on /quality as "Unhappy" for eleven
// weeks. Replaying the old regex over ~120 days of inbound comms found five
// hits and zero real complaints. So the terms are split in two: STRONG words
// are a complaint on their own; the WEAK "waiting / where is" words only count
// when the same message names something we deliver ("still waiting on the
// photos" yes, "still waiting on 2844 Edgemont Dr" no).
// (\w* on the stems: the old `\b(disappoint|frustrat)\b` could never match
// "disappointed" or "frustrating" — the boundary sat inside the word.)
const NEGATIVE_STRONG_RE =
  /\b(disappoint\w*|unhappy|not happy|frustrat\w*|upset|annoyed|let down|nobody (got|called|responded)|ridiculous|unacceptable)\b/i;
const NEGATIVE_WEAK_RE = /\b(taking (too )?long|too long|been waiting|still waiting|where (is|are)|no one)\b/i;
const DELIVERABLE_RE =
  /\b(photos?|pictures?|pics?|images?|videos?|reels?|gallery|links?|edits?|floor ?plans?|delivery|deliver(ed)?|invoice|files?|download|tour|zillow|matterport|drone|twilight|headshots?)\b/i;
// A message that laughs at itself is not a complaint ("you'll know if I'm
// unhappy lol" was one of the five).
const JOKING_RE = /\b(lol|lmao|haha+|jk|just kidding|kidding)\b|😂|🤣|😅/i;
// Scheduling talk the ORIGINAL regex above does not name, learned from the
// five false positives: a seller/listing we are waiting to hear back on, and a
// client narrating their arrival ("I'm here at the office … a little early …
// I see no one is here"). Kept apart from SCHEDULING_RE so the revision veto
// in classifyComm keeps its exact, older behaviour.
const SCHEDULING_EXTRA_RE =
  /\b(hear back|let you know|keep you posted|waiting (on|for) (the |a |an |our )?(seller|owner|agent|client|buyer|listing|confirmation|approval|go-?ahead|closing)|waiting on \d+\s+\S+\s+(dr|drive|st|street|rd|road|ln|lane|ave|avenue|ct|court|blvd|way|pl|place|cir|circle|ter|terrace|trail|pike|hwy)\b|i'?m (here|at the|early|late|outside)|running (late|behind)|on (my|our) way|a (little|bit) early|be there|arriv(ed|ing)|content session)\b/i;
// Bulk mail that happens to say "unhappy" (an "owners spend hours a day in
// email" newsletter was one of the five).
const BULK_MAIL_RE = /\bunsubscribe\b|view (this|it) in (your )?browser|manage (your )?(email )?preferences/i;
// iMessage/SMS reactions ("Liked …", emoji-only) — no reply needed.
const REACTION_RE = /^(liked|loved|disliked|laughed at|emphasi[sz]ed|questioned|reacted (to|with))\b|^reacted\b/i;

export function isReaction(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;
  if (REACTION_RE.test(t)) return true;
  // Emoji-only / punctuation-only (no letters or digits) and short.
  if (t.length <= 8 && !/[a-z0-9]/i.test(t)) return true;
  return false;
}
/** A complaint in its own right — "unacceptable", "really disappointed", "upset". */
export function hasStrongComplaint(text: string): boolean {
  return NEGATIVE_STRONG_RE.test((text || "").trim());
}

export function isNegativeSentiment(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  // A STRONG term stands on its own. The courtesy and joke vetoes only disarm
  // the WEAK "waiting / where is" terms (Sep 16 review): most complaint emails
  // open with "Thanks for getting back to me, but honestly I'm very
  // disappointed…", and "lol this is unacceptable" is still unacceptable —
  // under the old order a single "thanks" or "lol" anywhere in the message
  // meant the hub read it as not a complaint at all.
  if (hasStrongComplaint(t)) return true;
  if (PRAISE_ONLY.test(t) || JOKING_RE.test(t)) return false;
  return NEGATIVE_WEAK_RE.test(t) && DELIVERABLE_RE.test(t);
}
/** Booking / availability / arrival talk — the message is about WHEN, not about the work. */
export function isSchedulingTalk(text: string): boolean {
  const t = (text || "").trim();
  return SCHEDULING_RE.test(t) || SCHEDULING_EXTRA_RE.test(t);
}

export type CommClassification = { isRevision: boolean; matched: string[] };

export function classifyComm(text: string): CommClassification {
  const t = (text || "").trim();
  if (!t) return { isRevision: false, matched: [] };
  const matched: string[] = [];
  for (const re of REVISION_PATTERNS) {
    const m = t.match(re);
    if (m) matched.push(m[0].toLowerCase());
  }
  let isRevision = matched.length > 0;
  // A scheduling/booking/availability message isn't a revision unless there's a
  // clear edit ask (redo/reshoot/brighten/retouch/replace/etc).
  if (isRevision && SCHEDULING_RE.test(t) && !STRONG_REVISION.test(t)) isRevision = false;
  return { isRevision, matched };
}

function dedupeKey(parts: (string | null | undefined)[]): string {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

// Statuses where a "change" message means a real REVISION (work was delivered or
// is in final QC). On earlier stages the same message is just a special request.
const DELIVERED_ISH = new Set(["DELIVERED", "REVISION", "REVIEW"]);

// ---------------------------------------------------------------------------
// WHEN A TEXT OR EMAIL BECOMES AN "UNHAPPY" FEEDBACK ROW (Sep 16, Kyle call,
// item 10). One pure rule, shared by recordClientCommunication and the
// read-only replay probe, so what the hub files and what the probe predicts
// can never drift. A NEGATIVE row is filed only when ALL of these hold:
//   1. the words read as a complaint (isNegativeSentiment — strong term, or a
//      weak "waiting" term that names a deliverable; never a joke or praise);
//   2. it is not bulk mail;
//   3. the job it lands on is DELIVERED / REVISION / REVIEW — before delivery
//      there is nothing to be unhappy about yet, only something to schedule;
//   4. it is not scheduling talk (SCHEDULING_RE + the learned extras);
//   5. the Smart Brain judged the message actionable — its own "no action
//      needed — purely informational FYI" used to be logged three seconds AFTER
//      the feedback row was already written.
// Everything else stays exactly where it was: the reply task, the revision
// gate, the client's timeline line.
// ---------------------------------------------------------------------------
export type NegativeFeedbackGate = { file: boolean; reason: string };

export function negativeFeedbackGate(input: {
  text: string;
  projectStatus: string | null | undefined;
  /** The brain's call; null when no brain/AI was available (treated as actionable). */
  actionable: boolean | null;
}): NegativeFeedbackGate {
  const t = (input.text || "").trim();
  if (!isNegativeSentiment(t)) return { file: false, reason: "no complaint term (weak term without a deliverable, praise, or a joke)" };
  if (BULK_MAIL_RE.test(t)) return { file: false, reason: "bulk mail" };
  if (!input.projectStatus) return { file: false, reason: "no job attached" };
  if (!DELIVERED_ISH.has(input.projectStatus)) return { file: false, reason: `job not delivered yet (${input.projectStatus})` };
  // The scheduling veto exists to disarm the WEAK "still waiting / where is"
  // terms, so it must not swallow a STRONG complaint (Sep 16 review): a client
  // chasing a late delivery almost always names a day — "You told me Friday
  // and the photos still are not here. This is unacceptable." was reading as
  // scheduling talk and filing nothing at all.
  if (!hasStrongComplaint(t) && isSchedulingTalk(t)) return { file: false, reason: "scheduling talk" };
  if (input.actionable === false) return { file: false, reason: "Smart Brain: no action needed" };
  return { file: true, reason: "complaint on a delivered job" };
}

// The CommLog row this message was logged as — logComm runs just before
// recordClientCommunication in every caller, so the newest inbound row for the
// client in the last few minutes is it. Callers that have the id pass it
// (opts.commLogId) and skip the lookup. Best-effort: a null just means the
// /quality row has no "Open the conversation" link.
async function findSourceCommLog(opts: { clientId: string; text: string }): Promise<string | null> {
  try {
    const since = new Date(Date.now() - 10 * 60_000);
    const rows = await prisma.commLog.findMany({
      where: { clientId: opts.clientId, direction: "in", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, body: true },
    });
    const head = opts.text.trim().slice(0, 80);
    const exact = head ? rows.find((r) => r.body.includes(head)) : undefined;
    // Only an actual body match. The old "…else the newest inbound row" guess
    // stamped sourceRef with a DIFFERENT message's id, and /quality reads that
    // id for the channel label on "Open the conversation" — a provenance
    // column that can name the wrong message is worse than an empty one
    // (Sep 16 review). With null the link still resolves via the job's client.
    return exact?.id ?? null;
  } catch {
    return null;
  }
}

// Single entry point for an inbound client communication from ANY source.
// Creates the reply task and, when warranted, raises a revision.
export async function recordClientCommunication(opts: {
  clientId: string;
  clientName: string;
  projectId?: string | null;
  projectStatus?: string | null;
  propertyAddress?: string | null;
  text: string;
  kind: "text" | "missed_call" | "voicemail" | "email";
  source?: string; // openphone | gmail | facebook | form | ...
  threadRef?: string | null; // e.g. "gmail-thread:hello@…:<threadId>"
  // The WHOLE conversation this ask came out of, when `text` is only one side
  // of it (a call transcript). The revision brief reads this instead: our own
  // questions ("what kind of colours?") are what make the client's answers
  // ("big chunky glitter") legible as instructions.
  fullText?: string | null;
  // The real human who sent this, when different from the folded account client
  // (e.g. an assistant emailing on the agent's behalf). Shown as the task person.
  contactName?: string | null;
  // The CommLog row this message was logged as, when the caller has it — the
  // "Open the conversation" link on a /quality row (Feedback.sourceRef).
  // Resolved by lookup when absent (see findSourceCommLog).
  commLogId?: string | null;
}): Promise<{ replyTask: boolean; revision: boolean }> {
  // A "Liked …" / emoji reaction needs no reply — log nothing, make no task.
  if (isReaction(opts.text)) return { replyTask: false, revision: false };

  const cls = classifyComm(opts.text);

  // (The NEGATIVE feedback row used to be written HERE, before the brain ran,
  // on the pre-brain project guess. Since Sep 16 it is filed below, after the
  // decision — see negativeFeedbackGate.)

  // Route through the Smart Brain: it cross-checks the client's orders, the recent
  // conversation, and existing open to-dos, then creates OR merges the right task
  // on the right order with a context-aware title + priority. Falls back to the
  // single-message helper when the brain is unavailable.
  let replyTask = false;
  let effProjectId = opts.projectId ?? null;
  let effProjectStatus = opts.projectStatus ?? null;
  let effPropertyAddress = opts.propertyAddress ?? null;
  // The fallback helper's own "no action needed" — the brain gate below reads
  // it when the brain itself was unavailable.
  let fallbackNoAction = false;

  const decision = opts.clientId
    ? await routeCommTask({
        channel: opts.kind === "email" ? "email" : opts.kind === "text" ? "text" : "call",
        message: opts.text,
        clientId: opts.clientId,
        clientName: opts.clientName,
        senderIsClient: true,
      })
    : null;

  if (decision) {
    // The brain may correct which order this is about — refresh the project context.
    if (decision.projectId && decision.projectId !== opts.projectId) {
      const p = await prisma.project.findUnique({ where: { id: decision.projectId }, select: { status: true, title: true } });
      if (p) { effProjectId = decision.projectId; effProjectStatus = p.status; effPropertyAddress = p.title; }
    }
    if (decision.actionable) {
      if (decision.mergeIntoTaskId) {
        replyTask = await mergeIntoExistingTask(decision.mergeIntoTaskId, {
          title: decision.title, detail: decision.detail, priority: decision.priority,
          projectId: effProjectId, propertyAddress: effPropertyAddress, snippet: opts.text,
          clientName: opts.clientName, contactName: opts.contactName ?? null,
        });
      }
      // No merge target (or the merge was refused, e.g. it pointed at a production
      // task) → create a fresh reply task so the message is still tracked.
      if (!replyTask) {
        replyTask = await createCommTask({
          clientId: opts.clientId, clientName: opts.clientName, contactName: opts.contactName ?? null,
          projectId: effProjectId, propertyAddress: effPropertyAddress,
          kind: opts.kind === "email" ? "text" : opts.kind,
          snippet: opts.text, source: opts.source,
          aiTitle: decision.title, aiDetail: decision.detail, priority: decision.priority,
          threadRef: opts.threadRef ?? null,
          taskType: decision.taskType,
        });
      }
    }
    // Observability: record what the brain did + any flags, on the chosen order.
    if (effProjectId) {
      const what = !decision.actionable ? "no action needed" : decision.mergeIntoTaskId ? "merged into an open to-do" : "created a to-do";
      const note = `Smart Brain: ${what} — ${decision.reason}${decision.flags.length ? ` [${decision.flags.join("; ")}]` : ""}`;
      await prisma.activity.create({ data: { projectId: effProjectId, type: "SYSTEM", body: note.slice(0, 300) } }).catch(() => {});
    }
  } else {
    // FALLBACK (brain unavailable): single-message to-do, as before.
    let aiTitle: string | null = null;
    let aiDetail: string | null = null;
    try {
      const { getSecret } = await import("@/lib/integrations/connections");
      if (await getSecret("ai")) {
        const { messageToTodo } = await import("@/lib/integrations/ai");
        const todo = await messageToTodo({
          channel: opts.kind === "email" ? "email" : opts.kind === "text" ? "text" : "call",
          clientName: opts.clientName,
          propertyAddress: opts.propertyAddress,
          message: opts.text,
        });
        if (todo) { aiTitle = todo.title; aiDetail = todo.detail; }
      }
    } catch {
      /* fall back to the generic task */
    }
    const noAction = aiTitle != null && /no action needed/i.test(aiTitle);
    fallbackNoAction = noAction;
    replyTask = noAction
      ? false
      : await createCommTask({
          clientId: opts.clientId,
          clientName: opts.clientName,
          contactName: opts.contactName ?? null,
          projectId: opts.projectId ?? null,
          propertyAddress: opts.propertyAddress ?? null,
          kind: opts.kind === "email" ? "text" : opts.kind,
          snippet: opts.text,
          source: opts.source,
          aiTitle,
          aiDetail,
          threadRef: opts.threadRef ?? null,
        });
  }

  // Whether this is a real revision request: trust the Smart Brain (it can tell a
  // booking/scheduling/pricing message from an actual "redo the delivered work"
  // ask); fall back to the keyword classifier only when the brain is unavailable.
  const revisionSignal = decision ? decision.isRevisionRequest : cls.isRevision;
  const negativeWords = !!effProjectId && isNegativeSentiment(opts.text);

  // ONE re-anchor, read by BOTH gates below. A client message anchored to a
  // PRE-delivery job is usually a mis-anchor, not an in-flight special
  // request: the relevance-based project pick prefers the client's upcoming
  // shoot, but "redo the kitchen photos" — and "these photos are
  // unacceptable" — are about their newest delivered/in-review job. Without
  // it the revision degrades to an activity line on the wrong project (audit
  // crack #33's silent-loss class) and the complaint is dropped as "job not
  // delivered yet" (Sep 16 review — the feedback gate used to read the raw
  // pick while the revision gate re-anchored, for exactly this reason).
  // Two anchors we TRUST and never override: the Smart Brain's explicit pick,
  // and a project whose street the client actually named in the message.
  // Only computed when something downstream needs it, so a plain "sounds
  // good" still costs no extra query.
  let anchorProjectId = effProjectId;
  let anchorStatus = effProjectStatus;
  let anchorAddress = effPropertyAddress ?? null;
  if (effProjectId && (revisionSignal || negativeWords)) {
    // Callers usually pass the status; look it up when they didn't, so a job
    // that IS delivered keeps the message rather than being re-anchored off it.
    if (!anchorStatus) {
      const p = await prisma.project.findUnique({ where: { id: effProjectId }, select: { status: true } }).catch(() => null);
      anchorStatus = p?.status ?? null;
    }
    const brainPicked = !!decision?.projectId && decision.projectId === effProjectId && decision.projectId !== opts.projectId;
    const streetNamed = (() => {
      const core = (anchorAddress ?? "").split(",")[0].trim().replace(/^\d+\s+/, "").replace(/\s+\S+$/, "");
      if (core.length < 5) return false;
      return new RegExp(`\\b${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(opts.text);
    })();
    if (!(anchorStatus && DELIVERED_ISH.has(anchorStatus)) && opts.clientId && !brainPicked && !streetNamed) {
      try {
        const { mostRecentDeliveredIsh } = await import("@/lib/contacts");
        const d = await mostRecentDeliveredIsh(opts.clientId);
        if (d) { anchorProjectId = d.id; anchorStatus = d.status; anchorAddress = d.title; }
      } catch { /* fall through to the in-flight branch */ }
    }
  }

  // Track client happiness: a real complaint on a DELIVERED job → a NEGATIVE
  // feedback row on the job this landed on (shows on /quality and the client
  // timeline), separate from a revision. Filed AFTER the brain so its "no
  // action needed" can veto it, and stamped with the CommLog it came from so
  // /quality can open the conversation. See negativeFeedbackGate (Sep 16).
  if (anchorProjectId && negativeWords) {
    const gate = negativeFeedbackGate({
      text: opts.text,
      projectStatus: anchorStatus,
      actionable: decision ? decision.actionable : fallbackNoAction ? false : null,
    });
    if (gate.file) {
      const sourceRef = opts.commLogId ?? (await findSourceCommLog({ clientId: opts.clientId, text: opts.text }));
      await prisma.feedback.create({
        data: {
          projectId: anchorProjectId,
          sentiment: "NEGATIVE",
          // What the hub decided, kept even after an owner re-reads the row.
          sentimentAuto: "NEGATIVE",
          category: "communication",
          body: clip(opts.text, 300),
          authorName: opts.clientName,
          source: opts.kind === "email" ? "email" : "text",
          sourceRef,
        },
      }).catch(() => {});
    }
  }

  let revision = false;
  if (revisionSignal && anchorProjectId) {
    if (anchorStatus && DELIVERED_ISH.has(anchorStatus)) {
      revision = await raiseRevision({
        projectId: anchorProjectId,
        clientId: opts.clientId,
        clientName: opts.clientName,
        propertyAddress: anchorAddress,
        note: opts.text,
        source: opts.source ?? "comms",
        threadRef: opts.threadRef,
        fullText: opts.fullText ?? null,
      });
    } else {
      // In-flight job: capture the ask as a special request, no status churn.
      // (Same job the brain chose — the re-anchor above only ever swaps in a
      // delivered-ish job, which takes the branch above.)
      await prisma.activity.create({
        data: {
          projectId: anchorProjectId,
          type: "SPECIAL_REQUEST",
          body: `Client request (${opts.source ?? "comms"}): ${clip(opts.text, 280)}`,
        },
      });
    }
  }

  return { replyTask, revision };
}

// Reopen a delivered job for changes: flag it, move DELIVERED → REVISION, and
// raise an urgent revision task (deduped to one open revision per project).
// WHICH MEDIUM the client is asking about — read from the ASK, not the whole
// message. Gary Mercer's "1956 Wetherhill Dr Photos" email opened by describing
// his shoot ("a 2nd full set with Zillow showcase and agent reel") and then
// asked "are you able to edit these 2 photos"; testing the whole note for video
// words found "reel" in the background sentence and sent a photo retouch to the
// video editor's board (Jordan, Sep 7).
//
// So: isolate the sentences that actually carry a request, weigh photo words
// against video words in those, and let the subject line count double — a
// client who titles the thread "… Photos" has already said what it is about.
// A tie is "unclear", which keeps the job with Kyle to triage rather than
// guessing. "cut" only counts as a video word when it names a CUT (rough/final/
// new cut, re-cut): "cut out the trash can" is a photo retouch.
const VIDEO_WORDS = /\b(video|reel|clip|footage|(?:rough|final|first|new)\s+cut|re-?cut|music|audio|song|caption|subtitle|intro|outro|walk-?through|transition|b-?roll)\b/gi;
const PHOTO_WORDS = /\b(photos?|pictures?|pics?|images?|shots?|stills?|headshots?|retouch\w*|edit(?:ed|ing)? (?:this|these|the)? ?(?:photo|picture|pic|image|shot)s?|twilight|floor ?plan|virtual(?:ly)? stag\w*)\b/gi;
const REQUEST_SENTENCE = /\b(can|could|would|will|are you able|is it possible|possible to|any chance|please|need|want|send me|resend|swap|replace|remove|add)\b|\?/i;

export type AskMedium = "video" | "photo" | "unclear";

export function askMedium(note: string): AskMedium {
  const text = (note ?? "").trim();
  if (!text) return "unclear";
  const count = (re: RegExp, s: string) => (s.match(new RegExp(re.source, "gi")) ?? []).length;
  // The first line of a forwarded client email is the subject we prefixed —
  // "1956 Wetherhill Dr Photos — Hi Team…" — and it is the strongest single
  // signal about the subject matter, so it counts twice.
  const firstLine = text.split(/\n|—/)[0] ?? "";
  const sentences = text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const asks = sentences.filter((x) => REQUEST_SENTENCE.test(x));
  const scope = asks.length > 0 ? asks.join(" ") : text;
  const video = count(VIDEO_WORDS, scope) + count(VIDEO_WORDS, firstLine);
  const photo = count(PHOTO_WORDS, scope) + count(PHOTO_WORDS, firstLine);
  if (video > photo) return "video";
  if (photo > video) return "photo";
  return "unclear";
}

export async function raiseRevision(opts: {
  projectId: string;
  clientId?: string | null;
  clientName?: string | null;
  propertyAddress?: string | null;
  note: string;
  source: string;
  /** Where the request came from (e.g. "gmail-thread:<mailbox>:<threadId>") — lets the task full-view pull the real conversation. */
  threadRef?: string | null;
  /** The whole conversation, when `note` is only the client's half of it. */
  fullText?: string | null;
  qcCategories?: string[]; // QC labels to reopen for re-QC, e.g. ["Reel"]
}): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: opts.projectId },
    select: { id: true, status: true, title: true, clientId: true, revisionRequestedAt: true, statusPinnedAt: true, editorManual: true, editorVendorKey: true, editor: { select: { name: true } }, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } }, client: { select: { socialClient: true, segment: true } } },
  });
  if (!project) return false;

  // Delegate the revision to the editor who actually MADE that deliverable —
  // deterministic (from the real deliverable), not guessed from the request
  // wording. A video/reel revision → its editor (Remar standard · Kim monthly ·
  // Luma premium); photos/3D/floorplan → Kyle. If it's not clearly a video job it
  // stays with Kyle to triage.
  const { editorForDeliverable } = await import("@/lib/editors");
  const { isMonthlyContentJob } = await import("@/lib/pipeline");
  const videoDeliv = project.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const hasNonVideo = project.deliverables.some((d) => d.type !== "VIDEO" && d.type !== "SOCIAL_REEL");
  // Route by WHAT THE CLIENT ASKED, not just what the job contains: "fix the
  // front-lawn photo" on a photos+reel job went to the video editor (audit).
  // Video terms in the ask (or a video-only job) → the video lane; otherwise
  // Kyle triages it like any photo/3D/floor-plan revision.
  const medium = askMedium(opts.note);
  // A clearly-photo ask never goes to the video lane on a mixed job, and a
  // video-only job still routes to video when the wording is neutral.
  const primary =
    videoDeliv && (medium === "video" || (!hasNonVideo && medium !== "photo"))
      ? videoDeliv
      : project.deliverables.find((d) => d.type !== "VIDEO" && d.type !== "SOCIAL_REEL") ?? project.deliverables[0];
  // PROJECT-level monthly test — a listing-shoot revision for a social-plan
  // client routes like any listing job, not to the monthly-content lane.
  const { editorRouting } = await import("@/lib/settings");
  // The owner's pinned editor (queue-row / project-page pick) made this cut —
  // a VIDEO revision goes back to them, not to whoever the rules route to
  // today. Photo/3D/floor-plan asks keep their Kyle lane regardless of pin.
  const { pinnedEditorFor } = await import("@/lib/editors");
  const primaryIsVideo = primary?.type === "VIDEO" || primary?.type === "SOCIAL_REEL";
  // The work this ask actually IS — used for the per-medium work order below.
  const primaryIsVideoWork = primaryIsVideo;
  // A job pinned to nobody or to the outside shop must not bounce a revision
  // back onto John's or Kim's board — Kyle relays it (review, Sep 7).
  const pin = primaryIsVideo ? pinnedEditorFor(project) : { pinned: false, key: null };
  const pinnedKey = pin.pinned ? (pin.key === "kim" || pin.key === "john" || pin.key === "remar" ? pin.key : "kyle") : null;
  const assignedKey = pinnedKey ?? editorForDeliverable(
    primary?.type,
    primary?.label,
    isMonthlyContentJob(project.deliverables),
    await editorRouting(),
  );

  // The client's request IS the work order — keep it whole (word-boundary clip,
  // generous cap) so the editor isn't guessing past "can we make a few cha…".
  const note = clip(opts.note, 1500);
  // The task lands on an EDITOR's board when it's their deliverable — creatives
  // never see pricing, so money talk is dropped from THEIR copy (the full note
  // stays on revisionNote/activity, which are admin surfaces).
  const { stripMoneySentences } = await import("@/lib/text");
  const taskNote = (assignedKey && assignedKey !== "kyle" ? stripMoneySentences(note) : note) || clip(note, 240);
  // A client asking for changes outranks the office's status pin (Sep 13,
  // editOverrides.ts): the pin is the office's word over the hub's guesses,
  // not over the client. The ask clears it and, on a job the office had
  // pinned somewhere else, moves the job to Revisions now rather than an hour
  // later when the sweep (which the pin was holding off) would have — so the
  // queue row and the timeline agree the moment the ask lands.
  const pinned = !!project.statusPinnedAt;
  await prisma.project.update({
    where: { id: project.id },
    data: {
      revisionRequestedAt: new Date(),
      revisionNote: note,
      statusPinnedAt: null,
      // Only a delivered (or pinned) job changes stage; REVIEW/REVISION keep
      // their stage.
      ...(project.status === "DELIVERED" || (pinned && project.status !== "REVISION") ? { status: "REVISION" } : {}),
    },
  });

  await prisma.activity.create({
    data: {
      projectId: project.id,
      type: "FLAG",
      body: `${REVISION_FLAG_PREFIX}${opts.source}): ${note}`,
    },
  });

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  // ONE WORK ORDER PER MEDIUM, not per job. Two asks about the same video are
  // the same job of work and belong on one card; a photo ask that arrives while
  // a video revision is open is different work for a different person, and
  // merging them put Gary Mercer's closet-photo request onto the video editor's
  // board underneath "remove the walk-out basement clip" (Jordan, Sep 7).
  // Unclear asks keep the job's original single key so nothing splits on a
  // vague follow-up.
  // Only the PHOTO lane takes a new key. Video and unclear asks keep the
  // original one so every revision task already open in production still
  // matches and gets appended to, instead of every job growing a duplicate.
  const photoLane = !primaryIsVideoWork && medium === "photo";
  const key = dedupeKey(photoLane ? [project.id, "revision", "photo"] : [project.id, "revision"]);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  const data = {
    taskType: "revision",
    title: `${photoLane ? "Photo revision" : primaryIsVideoWork ? "Video revision" : "Revision"} — ${project.title}`,
    summary: `Client asked for changes after delivery: “${clip(taskNote, 240)}” — confirm exactly what needs to change, make the edits/reshoot, then re-upload to Aryeo and re-deliver.`,
    description: taskNote,
    reasonCreated: `Client requested changes via ${opts.source} after delivery`,
    checklist: JSON.stringify([
      // "…in Communications" pointed editors at a page their role can't open
      // (audit crack #38) — the request is right on the card.
      "Read the client's request below",
      "Confirm exactly what needs to change",
      "Make the edits / reshoot if needed",
      "Re-upload to Aryeo + re-deliver to client",
      "Mark the revision resolved",
    ]),
    source: opts.source,
    sourceDetail: opts.threadRef ?? null,
    // No due date and HIGH, not due-now URGENT (Jordan, Sep 8: "Revisions dont
    // promise anything"; due-fuses audit: every revision read overdue from the
    // minute it arrived). URGENT only for a VIP/heavy client or an ask that
    // says the client is unhappy — see revisionPriority. Age comes from
    // createdAt on every card ("requested 3 days ago").
    priority: revisionPriority({ segment: project.client?.segment, ask: opts.note }),
    dueAt: null,
    clientId: opts.clientId ?? project.clientId,
    projectId: project.id,
    propertyAddress: opts.propertyAddress ?? project.title,
    ownerId: kyle?.id ?? null,
    assignedKey,
    dedupeKey: key,
  };
  const wasAlreadyOpen = !!existing && existing.status !== "COMPLETED" && existing.status !== "CANCELLED";
  let taskId: string;
  if (existing) {
    // A second ask must ADD to the work order, not replace it — overwriting
    // description with only the newest message made earlier asks vanish from
    // every editor-visible surface (audit). Append while the round is open;
    // a task re-raised after completion starts a fresh list.
    let description = data.description;
    if (wasAlreadyOpen && existing.description && !existing.description.includes(taskNote)) {
      description = `${existing.description}\n\nNew request: ${taskNote}`;
      if (description.length > 4000) description = "…" + description.slice(-4000);
    }
    await prisma.smartTask.update({
      where: { id: existing.id },
      // A hand-picked editor (owner reassign / manual queue-add) survives a
      // re-raise — only the automatic routing suggestion gets overwritten.
      data: { ...data, description, ...(existing.assignedManually ? { assignedKey: existing.assignedKey } : {}), status: "OPEN", completedAt: null },
    });
    taskId = existing.id;
  } else {
    const created = await prisma.smartTask.create({ data });
    taskId = created.id;
  }

  // THE WORK ORDER. The task description above is a clipped paragraph by
  // necessity (it has to fit a task card); the brief keeps the client's ask
  // WHOLE and splits it into items the editor can actually work through. When
  // the ask came out of a call we hand the analyser the two-sided transcript —
  // our own questions are what make the client's answers legible. Best-effort:
  // a brief that fails to write or analyse never blocks the revision.
  try {
    const { createRevisionBrief } = await import("@/lib/revisionBrief");
    const dialogue = (opts.fullText ?? "").trim();
    // Only prefer the dialogue when it genuinely contains the client's half —
    // a transcript that dropped their side would otherwise brief the editor on
    // our own words.
    const useDialogue = dialogue.length > opts.note.trim().length;
    await createRevisionBrief({
      projectId: project.id,
      taskId,
      source: opts.source,
      sourceDetail: opts.threadRef ?? null,
      text: useDialogue ? dialogue : opts.note,
      twoSided: useDialogue,
      clientName: opts.clientName ?? null,
      propertyAddress: opts.propertyAddress ?? project.title,
      deliverables: project.deliverables.map((d) => d.label || d.type).filter(Boolean),
    });
  } catch { /* the revision itself already landed */ }

  // A revision request shouldn't wait for someone to open the hub — Slack-ping
  // when the task is NEWLY raised (a repeat text about an already-open revision
  // stays quiet), mirrored to the in-app bell for ops + the editor it's delegated
  // to. Best-effort: never breaks the revision itself.
  if (!wasAlreadyOpen) {
    try {
      const { notifyUrgent, notifyInApp } = await import("@/lib/notify");
      await notifyUrgent(`${data.title}: “${clip(note, 140)}”`);
      const targets: NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
      // Editor row: ONLY in-house editors (kim/remar) have a channel + login,
      // and their href must be the editor workspace — /projects bounces the
      // EDITOR role, and the Slack/SMS bridge ships whatever href this row has.
      {
        const { TEAM_MEMBER_EDITOR_KEYS } = await import("@/lib/editors");
        if (assignedKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(assignedKey)) {
          targets.push({ roles: ["EDITOR"], userKey: `editor:${assignedKey}`, href: `/edit/${project.id}` });
        }
      }
      await notifyInApp({
        kind: "revision_raised",
        title: `Revision — ${project.title.split(",")[0].trim()}`,
        body: clip(taskNote, 140),
        href: `/projects/${project.id}`,
        targets,
        // Day-suffixed: the revision TASK id is stable per project (deduped),
        // so a SECOND round's ping collided with the first and was silently
        // swallowed (audit). Same-day repeats stay quiet via wasAlreadyOpen.
        dedupeKey: `rev-${taskId}-${new Date().toISOString().slice(0, 10)}`,
      });
    } catch { /* non-fatal */ }
  }

  // Reflect the revision in the project's QC task: reopen it and mark the revised
  // deliverable(s) as needing a re-QC (the Luma reel, a client-flagged category,
  // or a generic "re-QC after revision").
  try {
    const { reflectRevisionInQc } = await import("@/lib/tasks");
    // Pass the revision note as the reason so the project's latest QcRecord gets
    // stamped reopenedByRevisionAt + revisionReason — that bounce IS the QC-miss
    // event the owner dial reads.
    await reflectRevisionInQc(project.id, opts.qcCategories ?? [], note);
  } catch { /* QC reflection is best-effort */ }

  return true;
}

// Where a resolved revision GENUINELY puts the job back.
//
// A revision reaches REVISION two very different ways, and only one of them
// means the client has ever seen the work:
//   • the client asked for changes AFTER delivery (raiseRevision — it only
//     flips a DELIVERED job), so resolving it returns the job to Delivered; and
//   • the owner bounced a cut in the Review Room (Jordan, Aug 27), which flips
//     a REVIEW/EDITING job that has NEVER been sent to anyone.
// Resolving used to answer "DELIVERED + deliveredAt = now" for both (audit
// fault #6). On a bounced job that lied twice over: it told the pipeline a job
// was delivered that nobody had ever received, and — because the delivery-text
// sweep gates on `status === "DELIVERED"` (clientTextSweeps.ts) — it armed an
// automatic "Everything for <address> has been delivered, how did we do?" text
// to a client who has never seen the video. On a genuinely delivered job it
// still overwrote the REAL delivery date with the resolve timestamp, which is
// what the on-time % (queries.ts) and the creative bonus (bonus.ts) measure
// against deliveryDue.
//
// `deliveredAt` is the delivery signal, exactly as the Review Room's two
// return paths already read it (review/actions.ts + reviewCuts.ts): every path
// that writes DELIVERED stamps it, so no date means no delivery. A
// never-delivered job goes back to where its work actually stands — Review when
// a cut is sitting in the Review Room awaiting (or holding) a verdict, Ready
// for editing (SHOT) when the redo is still owed — never forward to Delivered.
// Sep 10 (Jordan: "the video projects should not automatically be in
// editing"): this used to land on EDITING; now only the editor's own click on
// the queue pill writes that, so the redo waits as Ready for editing until
// they pick it up.
type RevisionLanding = "DELIVERED" | "REVIEW" | "SHOT";

async function revisionLanding(
  projectId: string,
  deliveredAt: Date | null,
): Promise<RevisionLanding> {
  // Delivered once = delivered still. The original date stands untouched below.
  if (deliveredAt) return "DELIVERED";
  // A cut awaiting a verdict (PENDING) or already passed (APPROVED) IS the job
  // sitting in the Review Room. CHANGES_REQUESTED / UPLOADING / SUPERSEDED are
  // not — those mean the editor still owes the redo.
  const inReviewRoom = await prisma.reviewSubmission.count({
    where: { projectId, status: { in: ["PENDING", "APPROVED"] } },
  });
  return inReviewRoom > 0 ? "REVIEW" : "SHOT";
}

// Clear a revision once it's been handled: drop the flag, close the task, and
// return the job to whatever it genuinely was — Delivered only if it really had
// been delivered, otherwise back to Review / Ready for editing (see revisionLanding).
// A REVIEW job that merely carried a revision note keeps its stage.
export async function resolveRevision(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, title: true, deliveredAt: true },
  });
  // Who the revision was delegated to — read BEFORE the close below wipes the
  // open task, so the bell can tell that editor their revision cleared.
  const revTask = await prisma.smartTask.findFirst({
    where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { assignedKey: true },
  });
  // Sep 8 (revision lifecycle): a DELIVERED job whose corrected cut went
  // through the Review Room can be sitting in REVIEW when the approval
  // resolves the ask (reviewCuts.correctedCutSubmitted / correctedCutApproved).
  // Delivered once = delivered still, so it lands back on Delivered with the
  // same close-out and bells a REVISION job gets — but ONLY when no cut is
  // still waiting on a verdict: this function also runs from the hand paths
  // (the task's Complete button, the last checklist tick, the project-page
  // button), and a delivered job re-queued through the fresh rail with a
  // PENDING cut must not be flipped DELIVERED — edit card closed, "Delivered
  // ✓" rung, delivery text minted — off an unreviewed cut (Sep 8 review).
  // A never-delivered REVIEW job keeps its stage, exactly as before — "a
  // REVIEW job that merely carried a revision note keeps its stage".
  const cutWaiting =
    project?.status === "REVIEW" && project.deliveredAt
      ? (await prisma.reviewSubmission.count({ where: { projectId, status: "PENDING" } })) > 0
      : false;
  const landing =
    project?.status === "REVISION"
      ? await revisionLanding(projectId, project.deliveredAt)
      : project?.status === "REVIEW" && project.deliveredAt && !cutWaiting
        ? ("DELIVERED" as RevisionLanding)
        : null;
  await prisma.project.update({
    where: { id: projectId },
    data: {
      revisionRequestedAt: null,
      revisionNote: null,
      // The landing is a human status write (the approval, the task's
      // Complete, the project-page button), and a human write ends the
      // office's status pin (Sep 13, editOverrides.ts).
      ...(landing ? { status: landing, statusPinnedAt: null } : {}),
      // deliveredAt is NEVER written here. Resolving a revision is not a
      // delivery: a job that was delivered keeps the date it actually shipped
      // on, and a job that never shipped must not acquire one. The real stamp
      // happens where delivery happens (the status sweep's first arrival at
      // DELIVERED, the pipeline board, the editor queue).
    },
  });
  await prisma.smartTask.updateMany({
    where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  // The job is delivered again → its re-QC / delivery tasks are done too. The
  // revision flow reopened the QC task (reflectRevisionInQc), but nothing could
  // ever close it: the task sync skips REVISION jobs and this function only
  // closed the revision task — every revision left a permanently-overdue QC in
  // Kyle's list (audit crack #22). A REVIEW job that merely carried a revision
  // note keeps its stage AND its open QC work.
  //
  // ONLY a job that genuinely lands on Delivered retires that work. Running the
  // delivered close-out on a bounced job also completed the editor's open
  // edit_video and Kyle's media_qa, and rang that editor's bell with
  // "Delivered ✓" for a cut he had just been asked to redo (38 E Gay St, live
  // on Sep 2). A never-delivered job keeps its QC and edit cards open — they
  // are real, owed work, and the hourly sweep closes them the moment the job
  // actually reaches DELIVERED (projectStatus.ts).
  if (landing === "DELIVERED" || (!landing && project?.status === "DELIVERED")) {
    await closeObsoleteTasks(projectId, "DELIVERED");
  }
  // Say what actually happened — the timeline used to read "back to Delivered"
  // on jobs that were never delivered.
  const { stageMeta } = await import("@/lib/pipeline");
  await prisma.activity.create({
    data: {
      projectId,
      type: "STATUS_CHANGE",
      body: landing
        ? `Revision marked resolved — back to ${stageMeta(landing).short}.`
        : "Revision marked resolved — flag cleared, stage unchanged.",
    },
  });
  // Bell: ops broadcast + the editor who worked it (best-effort, never breaks
  // the resolve). Day-bucketed key so a same-day re-resolve stays quiet.
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const targets: NotifyTarget[] = [{ roles: ["OWNER", "ADMIN"] }];
    {
      const { TEAM_MEMBER_EDITOR_KEYS } = await import("@/lib/editors");
      if (revTask?.assignedKey && (TEAM_MEMBER_EDITOR_KEYS as readonly string[]).includes(revTask.assignedKey)) {
        targets.push({ roles: ["EDITOR"], userKey: `editor:${revTask.assignedKey}`, href: `/edit/${projectId}` });
      }
    }
    await notifyInApp({
      kind: "revision_resolved",
      title: `Revision resolved — ${(project?.title || "this job").split(",")[0].trim()}`,
      href: `/projects/${projectId}`,
      targets,
      dedupeKey: `revres-${projectId}-${new Date().toISOString().slice(0, 10)}`,
    });
  } catch { /* non-fatal */ }
}

// Backfill / sweep: scan a project's recent inbound-text activities for a
// revision request it may have missed (e.g. comms that arrived before this
// feature existed). Used by the status sync so "Recheck statuses" catches them.
export async function scanProjectCommsForRevision(projectId: string): Promise<boolean> {
  const acts = await prisma.activity.findMany({
    where: { projectId, type: "SYSTEM", body: { contains: "text:" } },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { body: true },
  });
  for (const a of acts) {
    // Only client→us texts ("in text"), not our outbound replies.
    if (!/\bin(coming)?\b.*text:/i.test(a.body) && !/openphone in/i.test(a.body)) continue;
    const msg = a.body.split("text:").slice(1).join("text:").trim();
    if (classifyComm(msg).isRevision) {
      await raiseRevision({ projectId, note: msg, source: "openphone" });
      return true;
    }
  }
  return false;
}
