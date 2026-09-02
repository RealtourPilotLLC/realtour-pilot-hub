"use server";

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { etDateTime } from "@/lib/datetime";
import { recordFeedback } from "@/lib/feedback";

export type FeedbackResult = { ok: boolean; message: string };

// ---------------------------------------------------------------------------
// The PUBLIC client feedback form. This is the one server action in the hub with
// no login behind it — middleware treats every /feedback/<one-segment> path as
// public so a client can tap the link in their delivery text. That makes it the
// single write path an outsider can reach, so it has to bound itself three ways:
//
//   1. TARGET comes from the ROUTE, never the form field. The action used to
//      trust a hidden `projectId` input, and a "use server" action can be POSTed
//      from ANY public path (/login, /portal/<token>, …) with a forged body — so
//      one leaked feedback link was a write primitive against all 1,542 project
//      rows. The project is now taken from the page the submit actually came
//      from, and a body field that disagrees is refused outright.
//   2. RATE: a project accepts MAX_PER_HOUR form submissions per rolling hour.
//      Anything past that is turned away with a way to still reach a human.
//   3. REPEATS FOLD, they don't multiply. Every NEGATIVE submission mints an
//      URGENT SmartTask in recordFeedback (dedupeKey is per feedback row, so it
//      is unique by construction). A second write-in now lands ON Kyle's open
//      task instead of stacking a second URGENT card on the same address.
//
// The bar the whole file is written to: stop an ATTACKER, never a CUSTOMER. A
// client who genuinely replies twice must still be heard — every path below
// either stores their words or tells them plainly what to do next. Nothing here
// drops feedback silently.
//
// ---------------------------------------------------------------------------
// WHAT IT ASKS, AND WHERE THE ANSWERS GO (Jordan, Sep 2 2026: "I want to know
// how their experience was with the assigned photographer. What they would like
// to see done differently, and ask about the quality of their content. Then I
// want to be able to view that data. Right now I don't even know where that
// data goes.")
//
// One Feedback row per response. The three answers are stored TWICE, on purpose:
//
//   • as COLUMNS, for anything that scores them —
//       photographerRating  1-5, belongs to Feedback.photographerId (their KPI)
//       photographerNote    their words about that person
//       improveNote         "what would you like to see done differently?"
//       contentRating       1-5, belongs to the WORK
//       contentNote         their words about the content
//       rating              the overall score (see effectiveOverall below)
//   • as `body`, one readable transcript — because /quality's row, the URGENT
//     "make it right" task and the notification bell all render body, and a
//     response nobody can read is a response nobody acts on.
//
// Every field is optional. A client who taps one star and sends still gets a
// row; forgiving beats complete when the alternative is a bounced form.
// ---------------------------------------------------------------------------

const MAX_PER_HOUR = 3;

// A resubmit of the SAME words within this window is a double-tap / retry, not a
// second reply — the client is told it landed (it did, the first time) and we
// don't file it twice. Deliberately short and exact-match so a client who writes
// in AGAIN with anything new is always recorded.
const DUPLICATE_WINDOW_MS = 10 * 60_000;

const OPEN_TASK = { notIn: ["COMPLETED", "CANCELLED"] };

// Sanity bound per stored answer on a public write path. Postgres text is
// unbounded; nobody types this much into a phone.
const MAX_ANSWER = 2000;

// How much of each answer is QUOTED into the readable transcript. Three answers
// at this length plus their labels always fit inside recordFeedback's 2000-char
// body cap, so no part of a long response can be pushed off the end of the row
// Kyle reads. The columns keep the full text either way.
const CLIP = 600;

// /feedback/<projectId> — and nothing else. A path with a second segment, a
// different route, or no match at all yields null and the submit is refused.
function idFromPath(pathname: string | null | undefined): string | null {
  const m = pathname?.match(/^\/feedback\/([^/?#]+)\/?$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
function idFromReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return idFromPath(new URL(referer).pathname);
  } catch {
    return null;
  }
}

// Next always sends `next-router-state-tree` on a server-action fetch (unlike
// `next-url`, which only rides along on intercepted routes). It is the rendered
// page's FlightRouterState, and a dynamic segment survives the strip pass as the
// tuple ["id", "<value>", "d", null] — so the concrete project id of the page
// the client is looking at is in there. Not subject to a browser's Referrer-
// Policy, which is why it's the first signal we try.
function idFromRouterTree(raw: string | null): string | null {
  if (!raw) return null;
  let tree: unknown;
  try {
    tree = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  let found: string | null = null;
  const walk = (node: unknown, parentSegment: string | null) => {
    if (found || !Array.isArray(node)) return;
    const seg = node[0];
    // A dynamic segment sitting directly under the literal "feedback" segment is
    // the [id] of /feedback/[id].
    if (parentSegment === "feedback" && Array.isArray(seg) && typeof seg[1] === "string") {
      found = seg[1];
      return;
    }
    const kids = node[1];
    if (kids && typeof kids === "object") {
      // A dynamic segment RESETS the parent, so only a direct child of the real
      // "feedback" segment can ever match.
      const next = typeof seg === "string" ? seg : null;
      for (const child of Object.values(kids as Record<string, unknown>)) walk(child, next);
    }
  };
  walk(tree, null);
  return found;
}

// Which project the page this submit came from is actually about. Both signals
// are client-supplied and a scripted attacker can forge either — the RATE CAP
// below is the bound that doesn't depend on trust. What this buys is the shape
// that matters: the action can no longer be pointed at an arbitrary project id
// from an arbitrary public route just by editing a hidden input.
async function projectIdFromPage(): Promise<string | null> {
  const h = await headers();
  return idFromRouterTree(h.get("next-router-state-tree")) ?? idFromReferer(h.get("referer"));
}

// ------------------------------ the answers --------------------------------

type Answers = {
  overall: number | null;
  photographerRating: number | null;
  photographerNote: string | null;
  improveNote: string | null;
  contentRating: number | null;
  contentNote: string | null;
  /** The retired one-box form's free-text field. Still accepted so a stale tab
      left open on someone's phone doesn't silently lose its words. */
  extra: string | null;
};

// 1-5, or nothing at all. Anything else — "9", "", NaN, a scripted junk value —
// means "they didn't answer this one", never a number nobody chose. (The old
// form tested the raw field and stored bodies reading "(null/5, no comment)".)
function star(v: FormDataEntryValue | null): number | null {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function words(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, MAX_ANSWER) : null;
}

function readAnswers(formData: FormData): Answers {
  return {
    overall: star(formData.get("rating")),
    photographerRating: star(formData.get("photographerRating")),
    photographerNote: words(formData.get("photographerNote")),
    improveNote: words(formData.get("improveNote")),
    contentRating: star(formData.get("contentRating")),
    contentNote: words(formData.get("contentNote")),
    extra: words(formData.get("body")),
  };
}

// The single overall score everything downstream reads: sentiment (→ the URGENT
// "make it right" task and who the bell reaches), the avg-rating tile, the
// photographer scorecards.
//
// If the client tapped Overall, that is the number. If they skipped it we take
// the LOWEST thing they did rate, not the average — a 5-star photographer with
// 1-star photos averages to a 3 and would sail past the unhappy path as
// "neutral": no task, no call, and a client who never writes in again.
// Understating a mixed job is the safe direction, and the true per-question
// averages live in their own columns for /quality to read.
function effectiveOverall(a: Answers): number | null {
  if (a.overall != null) return a.overall;
  const subs = [a.photographerRating, a.contentRating].filter((n): n is number => n != null);
  return subs.length > 0 ? Math.min(...subs) : null;
}

const quote = (s: string) => `“${s.length > CLIP ? `${s.slice(0, CLIP).trimEnd()}…` : s}”`;

// The response as a PERSON reads it. Lands in Feedback.body, which is what
// /quality's row, the URGENT task summary and the bell all render.
//
// Ordered the way the form asks, with the photographer first: the bell clips
// body to 140 characters for the photographer's own copy, and the half of the
// response that is legitimately about them is the half that should survive that
// clip.
function transcript(a: Answers, photographerName: string | null): string {
  const parts: string[] = [];
  const who = photographerName ? ` (${photographerName})` : "";
  if (a.photographerRating != null || a.photographerNote) {
    parts.push(
      `Photographer${who}: ${a.photographerRating != null ? `${a.photographerRating}/5` : "no rating"}` +
        (a.photographerNote ? `\n${quote(a.photographerNote)}` : ""),
    );
  }
  if (a.improveNote) parts.push(`Would like done differently:\n${quote(a.improveNote)}`);
  if (a.contentRating != null || a.contentNote) {
    parts.push(
      `Content quality: ${a.contentRating != null ? `${a.contentRating}/5` : "no rating"}` +
        (a.contentNote ? `\n${quote(a.contentNote)}` : ""),
    );
  }
  if (a.extra) parts.push(quote(a.extra));
  // Printed only when the client actually tapped it. A DERIVED overall is ours,
  // not theirs, and must never be quoted back as something they said.
  if (a.overall != null) parts.push(`Overall: ${a.overall}/5`);
  return parts.join("\n\n");
}

export async function submitFeedback(
  _prev: FeedbackResult | null,
  formData: FormData,
): Promise<FeedbackResult> {
  const claimedId = String(formData.get("projectId") || "");
  const a = readAnswers(formData);
  const authorName = String(formData.get("authorName") || "").trim() || null;

  // (1) Target = the route, not the field.
  const projectId = await projectIdFromPage();
  if (!projectId) {
    // Either the submit didn't come from a /feedback/<id> page at all (the
    // attack shape), or a browser stripped both signals (rare — the JS path
    // always sends the router state tree). Tell a real person how to recover.
    return {
      ok: false,
      message: "We couldn't tell which shoot this is about. Please reopen the link from your delivery text and send it again.",
    };
  }
  if (claimedId && claimedId !== projectId) {
    console.warn(`[feedback] refused submit: form field ${claimedId} != page route ${projectId}`);
    return { ok: false, message: "That link doesn't look right. Please reopen it from your delivery text." };
  }

  const rating = effectiveOverall(a);
  // Forgiving on purpose: ONE answer is a submit. Only a completely empty form
  // is turned back, and it's told exactly how little is enough.
  const answered = rating != null || !!(a.photographerNote || a.improveNote || a.contentNote || a.extra);
  if (!answered) return { ok: false, message: "Please answer at least one question — a star or a line is plenty." };

  // The photographer named in question 1, so the stored transcript says who the
  // client was actually talking about. Also the earliest point a real job can be
  // told from a made-up id, before anything is written.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { photographer: { select: { name: true } } },
  });
  if (!project) {
    return { ok: false, message: "We couldn't find that shoot. Please reopen the link from your delivery text." };
  }

  // Mirror exactly what recordFeedback will store, so the duplicate check below
  // compares like for like.
  const storedBody = transcript(a, project.photographer?.name ?? null).slice(0, 2000);

  // (2) Rate cap + (2b) double-tap fold. One query serves both: the newest few
  // form submissions on this project inside the last hour.
  const since = new Date(Date.now() - 60 * 60_000);
  const recent = await prisma.feedback.findMany({
    where: { projectId, source: "form", createdAt: { gte: since } },
    select: { body: true, rating: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_PER_HOUR + 1,
  });

  const dupeAfter = Date.now() - DUPLICATE_WINDOW_MS;
  if (recent.some((r) => r.body === storedBody && r.rating === rating && r.createdAt.getTime() >= dupeAfter)) {
    // Same words, same minute — their first send DID land. Show the thank-you
    // rather than a scary error, and don't file it twice.
    return { ok: true, message: "Thank you! Your feedback went straight to our team." };
  }

  if (recent.length >= MAX_PER_HOUR) {
    return {
      ok: false,
      message: "Thanks — we've already got your notes on this one and someone is on it. If there's more, just reply to our text and we'll pick it straight up.",
    };
  }

  // (3) Snapshot the open feedback loops on this project BEFORE recording, so a
  // repeat can be folded onto the one Kyle is already working instead of
  // stacking another URGENT card. Identifying "what this call minted" by ID
  // rather than by `createdAt > now` is deliberate: createdAt is the DATABASE
  // clock and this snapshot is the APP clock, and a Neon instance a second
  // behind the Vercel lambda would make a timestamp window silently miss the
  // new row — leaving the duplicate task this whole path exists to prevent.
  //
  // The feedback ids are snapshotted for the same reason: recordFeedback writes
  // the row but returns no id, and the per-question columns are stamped onto
  // whatever is NEW afterwards (stampAnswers).
  const [openBefore, feedbackBefore] = await Promise.all([
    prisma.smartTask
      .findMany({
        where: { projectId, taskType: "feedback_review", status: OPEN_TASK },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, description: true },
      })
      .catch(() => [] as { id: string; status: string; description: string | null }[]),
    prisma.feedback
      .findMany({ where: { projectId, source: "form" }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id))
      .catch(() => [] as string[]),
  ]);

  const r = await recordFeedback({
    projectId,
    rating,
    body: storedBody,
    authorName,
    source: "form",
  });
  if (!r.ok) return { ok: false, message: "We couldn't find that project." };

  await stampAnswers(projectId, feedbackBefore, storedBody, a);

  if (openBefore.length) await foldRepeatIntoOpenTask(projectId, openBefore);

  return { ok: true, message: "Thank you! Your feedback went straight to our team." };
}

// Put the three answers on the row recordFeedback just created.
//
// recordFeedback owns the write — it also files the project Activity, mints the
// URGENT task on unhappy feedback and rings the bell — but its signature
// predates the three questions and it returns no id. So the new row is found the
// same way the task fold below finds its own: by what is NEW since the snapshot,
// matched on the exact body we asked it to store. No timestamp window (Neon's
// clock is not the lambda's), no second create.
//
// Best-effort by design: if this can't find or write the row, every word the
// client typed is still in `body` and still renders everywhere. It shouts,
// because a silent failure here is a KPI that quietly reads zero.
async function stampAnswers(
  projectId: string,
  beforeIds: string[],
  body: string,
  a: Answers,
): Promise<void> {
  try {
    const fresh = await prisma.feedback.findMany({
      where: { projectId, source: "form", id: { notIn: beforeIds } },
      orderBy: { createdAt: "desc" },
      select: { id: true, body: true },
    });
    const row = fresh.find((f) => f.body === body);
    if (!row) {
      console.error(`[feedback] couldn't find the row just written for project ${projectId} — answers stayed in the body only`);
      return;
    }
    await prisma.feedback.update({
      where: { id: row.id },
      data: {
        photographerRating: a.photographerRating,
        photographerNote: a.photographerNote,
        improveNote: a.improveNote,
        contentRating: a.contentRating,
        contentNote: a.contentNote,
      },
    });
  } catch (e) {
    console.error("[feedback] couldn't stamp the per-question answers", e);
  }
}

// recordFeedback owns task creation and always mints a fresh URGENT row for
// NEGATIVE feedback (its dedupeKey is derived from the new Feedback id, so it
// can never collide by design). When an open feedback_review task already
// existed for this project, that new row is a DUPLICATE of a loop someone is
// already working: fold its words into the existing task and cancel the copy.
//
// The existing task is the one that survives, not the new one — it carries
// Kyle's status, owner and whatever he's already done. CANCELLED (not deleted):
// every queue in the hub filters CANCELLED out, and the Done ledger only shows
// COMPLETED, so the copy vanishes from view while the audit trail stays.
//
// Best-effort throughout — the Feedback row is already saved and is what
// matters. A failure here must never turn into a failed submit for the client.
async function foldRepeatIntoOpenTask(
  projectId: string,
  openBefore: { id: string; status: string; description: string | null }[],
): Promise<void> {
  const prior = openBefore[0]; // oldest still-open loop = the one being worked
  try {
    const minted = await prisma.smartTask.findMany({
      where: {
        projectId,
        taskType: "feedback_review",
        id: { notIn: openBefore.map((t) => t.id) },
        status: OPEN_TASK,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, summary: true, description: true },
    });
    if (!minted.length) return; // positive/neutral feedback mints nothing

    const newest = minted[0];
    const appended = [
      prior.description ?? "",
      `— They wrote in again ${etDateTime(new Date())} —`,
      newest.description ?? "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 8000);

    await prisma.smartTask.update({
      where: { id: prior.id },
      data: {
        summary: newest.summary,
        description: appended,
        priority: "URGENT",
        dueAt: new Date(),
        // A client who replies re-opens a loop that was parked waiting on them.
        status: prior.status.startsWith("WAITING") ? "OPEN" : prior.status,
      },
    });

    await prisma.smartTask.updateMany({
      where: { id: { in: minted.map((m) => m.id) } },
      data: { status: "CANCELLED", reasonCreated: "Repeat client feedback — folded into the open feedback task" },
    });
  } catch (e) {
    console.error("[feedback] couldn't fold repeat feedback into the open task", e);
  }
}
