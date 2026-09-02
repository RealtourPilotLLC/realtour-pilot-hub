import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { createCommTask, mergeIntoExistingTask, closeObsoleteTasks } from "@/lib/tasks";
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
const NEGATIVE_RE =
  /\b(disappoint|unhappy|not happy|frustrat|upset|annoyed|let down|taking (too )?long|too long|been waiting|still waiting|where (is|are)|no one|nobody (got|called|responded)|ridiculous|unacceptable)\b/i;
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
export function isNegativeSentiment(text: string): boolean {
  const t = (text || "").trim();
  return NEGATIVE_RE.test(t) && !PRAISE_ONLY.test(t);
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
}): Promise<{ replyTask: boolean; revision: boolean }> {
  // A "Liked …" / emoji reaction needs no reply — log nothing, make no task.
  if (isReaction(opts.text)) return { replyTask: false, revision: false };

  const cls = classifyComm(opts.text);

  // Track client happiness: clear unhappiness → a NEGATIVE feedback entry on the
  // project (shows on the client + photographer scorecards), separate from a revision.
  if (opts.projectId && isNegativeSentiment(opts.text)) {
    await prisma.feedback.create({
      data: {
        projectId: opts.projectId,
        sentiment: "NEGATIVE",
        category: "communication",
        body: clip(opts.text, 300),
        authorName: opts.clientName,
        source: opts.kind === "email" ? "email" : "text",
      },
    }).catch(() => {});
  }

  // Route through the Smart Brain: it cross-checks the client's orders, the recent
  // conversation, and existing open to-dos, then creates OR merges the right task
  // on the right order with a context-aware title + priority. Falls back to the
  // single-message helper when the brain is unavailable.
  let replyTask = false;
  let effProjectId = opts.projectId ?? null;
  let effProjectStatus = opts.projectStatus ?? null;
  let effPropertyAddress = opts.propertyAddress ?? null;

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
  let revision = false;
  if (revisionSignal && effProjectId) {
    // A revision ask anchored to a PRE-delivery job is usually a mis-anchor,
    // not an in-flight special request: the relevance-based project pick
    // prefers the client's upcoming shoot, but "redo the kitchen photos" is
    // about their newest delivered/in-review job. Re-anchor before the gate
    // decides — without this the revision silently degrades to an activity
    // line on the wrong project (audit crack #33's silent-loss class). Two
    // anchors we TRUST and never override: the Smart Brain's explicit pick,
    // and a project whose street the client actually named in the message.
    let revProjectId = effProjectId;
    let revStatus = effProjectStatus;
    let revAddress = effPropertyAddress ?? null;
    const brainPicked = !!decision?.projectId && decision.projectId === effProjectId && decision.projectId !== opts.projectId;
    const streetNamed = (() => {
      const core = (revAddress ?? "").split(",")[0].trim().replace(/^\d+\s+/, "").replace(/\s+\S+$/, "");
      if (core.length < 5) return false;
      return new RegExp(`\\b${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(opts.text);
    })();
    if (!(revStatus && DELIVERED_ISH.has(revStatus)) && opts.clientId && !brainPicked && !streetNamed) {
      try {
        const { mostRecentDeliveredIsh } = await import("@/lib/contacts");
        const d = await mostRecentDeliveredIsh(opts.clientId);
        if (d) { revProjectId = d.id; revStatus = d.status; revAddress = d.title; }
      } catch { /* fall through to the in-flight branch */ }
    }
    if (revStatus && DELIVERED_ISH.has(revStatus)) {
      revision = await raiseRevision({
        projectId: revProjectId,
        clientId: opts.clientId,
        clientName: opts.clientName,
        propertyAddress: revAddress,
        note: opts.text,
        source: opts.source ?? "comms",
        threadRef: opts.threadRef,
        fullText: opts.fullText ?? null,
      });
    } else {
      // In-flight job: capture the ask as a special request, no status churn.
      await prisma.activity.create({
        data: {
          projectId: effProjectId,
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
    select: { id: true, status: true, title: true, clientId: true, revisionRequestedAt: true, editorManual: true, editor: { select: { name: true } }, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } }, client: { select: { socialClient: true } } },
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
  // "cut" only counts as a video word when it names a CUT (rough/final/new
  // cut, re-cut) — "cut out the trash can" is a photo retouch ask and bare
  // \bcut\b was misrouting those to the video editor on mixed jobs.
  const VIDEO_ASK = /\b(video|reel|clip|footage|(?:rough|final|first|new)\s+cut|re-?cut|music|audio|song|caption|subtitle|intro|outro|walk-?through|transition|b-?roll)\b/i;
  const primary = videoDeliv && (VIDEO_ASK.test(opts.note) || !hasNonVideo) ? videoDeliv : project.deliverables.find((d) => d.type !== "VIDEO" && d.type !== "SOCIAL_REEL") ?? project.deliverables[0];
  // PROJECT-level monthly test — a listing-shoot revision for a social-plan
  // client routes like any listing job, not to the monthly-content lane.
  const { editorRouting } = await import("@/lib/settings");
  // The owner's pinned editor (queue-row / project-page pick) made this cut —
  // a VIDEO revision goes back to them, not to whoever the rules route to
  // today. Photo/3D/floor-plan asks keep their Kyle lane regardless of pin.
  const { editorKeyForTeamName } = await import("@/lib/editors");
  const primaryIsVideo = primary?.type === "VIDEO" || primary?.type === "SOCIAL_REEL";
  const pinnedKey = primaryIsVideo && project.editorManual ? editorKeyForTeamName(project.editor?.name) : null;
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
  await prisma.project.update({
    where: { id: project.id },
    data: {
      revisionRequestedAt: new Date(),
      revisionNote: note,
      // Only a delivered job changes stage; REVIEW/REVISION keep their stage.
      ...(project.status === "DELIVERED" ? { status: "REVISION" } : {}),
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
  const key = dedupeKey([project.id, "revision"]);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  const data = {
    taskType: "revision",
    title: `Revision — ${project.title}`,
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
    priority: "URGENT" as const,
    dueAt: new Date(),
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
// a cut is sitting in the Review Room awaiting (or holding) a verdict, In
// Editing when the redo is still owed — never forward to Delivered.
type RevisionLanding = "DELIVERED" | "REVIEW" | "EDITING";

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
  return inReviewRoom > 0 ? "REVIEW" : "EDITING";
}

// Clear a revision once it's been handled: drop the flag, close the task, and
// return the job to whatever it genuinely was — Delivered only if it really had
// been delivered, otherwise back to Review / In Editing (see revisionLanding).
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
  const landing =
    project?.status === "REVISION"
      ? await revisionLanding(projectId, project.deliveredAt)
      : null;
  await prisma.project.update({
    where: { id: projectId },
    data: {
      revisionRequestedAt: null,
      revisionNote: null,
      ...(landing ? { status: landing } : {}),
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
