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
// ---------------------------------------------------------------------------

const MAX_PER_HOUR = 3;

// A resubmit of the SAME words within this window is a double-tap / retry, not a
// second reply — the client is told it landed (it did, the first time) and we
// don't file it twice. Deliberately short and exact-match so a client who writes
// in AGAIN with anything new is always recorded.
const DUPLICATE_WINDOW_MS = 10 * 60_000;

const OPEN_TASK = { notIn: ["COMPLETED", "CANCELLED"] };

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

export async function submitFeedback(
  _prev: FeedbackResult | null,
  formData: FormData,
): Promise<FeedbackResult> {
  const claimedId = String(formData.get("projectId") || "");
  const body = String(formData.get("body") || "").trim();
  const ratingRaw = String(formData.get("rating") || "");
  const ratingIn = ratingRaw ? Number(ratingRaw) : null;
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
  // Validate the rating BEFORE the "is this empty?" check. Testing the raw
  // field instead let a junk rating (`?rating=9`, NaN, anything out of 1-5)
  // through with no comment, and the body we stored read "(null/5, no comment)".
  const rating = ratingIn && ratingIn >= 1 && ratingIn <= 5 ? ratingIn : null;
  if (!body && !rating) return { ok: false, message: "Please add a rating or a comment." };

  // Mirror exactly what recordFeedback will store, so the duplicate check below
  // compares like for like.
  const storedBody = (body || `(${rating}/5, no comment)`).slice(0, 2000);

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
  const openBefore = await prisma.smartTask
    .findMany({
      where: { projectId, taskType: "feedback_review", status: OPEN_TASK },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, description: true },
    })
    .catch(() => [] as { id: string; status: string; description: string | null }[]);

  const r = await recordFeedback({
    projectId,
    rating,
    body: storedBody,
    authorName,
    source: "form",
  });
  if (!r.ok) return { ok: false, message: "We couldn't find that project." };

  if (openBefore.length) await foldRepeatIntoOpenTask(projectId, openBefore);

  return { ok: true, message: "Thank you! Your feedback went straight to our team." };
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
