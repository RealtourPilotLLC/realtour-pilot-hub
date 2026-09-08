import "server-only";
import crypto from "crypto";
import { appBase } from "@/lib/appUrl";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { ActivityType } from "@prisma/client";
import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// A photographer's field flag routes to the JOB — never to the product board.
//
// This used to mirror every field flag onto /feedback as a PlatformFeedback row
// (kind "field_issue"), so "the lockbox code was wrong" or "couldn't get the
// drone up" sat in Jordan's build-this-next queue beside "please add a dark
// mode" and read as a shippable update. Both rows ever filed were DECLINED —
// the board was simply the wrong inbox (Jordan, Sep 2 2026).
//
// A field flag is feedback about a SHOOT, so it goes where shoot work lives:
//   • THE JOB — the FLAG Activity on the project. That row is the record, and
//     it is what every shoot surface already reads (filtered by isFieldFlag):
//     the project timeline, the upload portal's flag list, the editor PDF
//     brief, Ops Day's QC cards, and the photographer-feedback surface.
//   • AN OPS LOOP — ONE internal_instruction SmartTask per job, owned by Kyle,
//     so a flag is something a human closes out instead of a line on a
//     timeline nobody opens. Surfaces in Ops Day / Dashboard "Open loops", on
//     /tasks and on Kyle's home under "Flagged by <name>". Without it the flag
//     would be a Slack ping and nothing else.
//   • THE ALERTING that already worked — the Slack ops ping + the bell — now
//     deep-linked to the job instead of /feedback, and pointed at ADMIN (Kyle,
//     James) as well as the owner.
//
// ONE LOOP PER JOB (Sep 8 audit, finding "one shoot problem mints two Shoot
// issue loops"): the "Flag a problem" box and the "had issues" debrief on the
// same shoot used to land as two cards — this file keyed the loop on a hash of
// the wording, and the debrief upserted its own `shoot-issue-<project>` row
// with no assignee. 1946 Rowan St: "Needs Kyle · Shoot issue — 1946 Rowan St"
// AND "Needs assigning · Shoot issue — 1946 Rowan St, Philadelphia…", both
// open four days on a job delivered Sep 4. Now every entry point appends to
// the job's one loop (key `field-flag-<projectId>`, assigned kyle on create):
// the second flag adds a line to the description and re-raises the alerts,
// but Kyle sees one card per job.
//
// Genuine hub bug reports from the field still reach the platform board, and
// the split is by WHERE it was submitted — never by reading the text:
//   • the floating Feedback widget (mounted on every page, /shoot included) and
//   • the upload portal's "How was this upload process?" note
// both call submitPlatformFeedback directly. Everything filed from a "Flag a
// problem" box or the shoot debrief comes through here and stays on the job.
//
// Best-effort by contract: an alerting or task hiccup must never break the
// photographer's submit — their words are already on the timeline by then.
// ---------------------------------------------------------------------------

/** The one ops loop a job's field flags share. */
export const fieldFlagLoopKey = (projectId: string) => `field-flag-${projectId}`;

// Rows minted before the one-loop rule that must be recognised as THE loop, so
// a fresh flag on such a job appends to what exists instead of opening a
// second card: the debrief's old `shoot-issue-<project>` key, and the old
// hashed-key rows (no recognisable key, but source "manual" and a sourceDetail
// that is the /upload or /shoot page they came from — no other engine writes
// that combination).
function legacyLoopWhere(projectId: string) {
  return [
    { dedupeKey: `shoot-issue-${projectId}` },
    {
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      source: "manual",
      OR: [{ sourceDetail: { startsWith: "/upload/" } }, { sourceDetail: { startsWith: "/shoot/" } }],
    },
  ];
}

export async function fileFieldIssue(opts: {
  projectId: string;
  note: string;
  /** Where it was flagged from — kept on the ops task for triage. */
  page: string;
  /** e.g. "Shoot issue" | "Shoot debrief" — titles the alerts and each entry
      appended to the loop. The loop itself is always "Shoot issue — <street>". */
  label: string;
  /** URGENT for a flag raised while the photographer is still on the property;
      HIGH once they're back and wrapping up. */
  priority?: "URGENT" | "HIGH";
  /** Alert only, no loop. Kept for callers that still pass it; since Sep 8 no
      caller files its own loop (the debrief used to, which is how one incident
      became two cards) — every field entry point lets this function keep the
      one loop per job. */
  opsTaskAlreadyFiled?: boolean;
}): Promise<void> {
  const note = opts.note.trim();
  if (!note) return;
  try {
    const project = await prisma.project.findUnique({
      where: { id: opts.projectId },
      select: { title: true, photographer: { select: { name: true } } },
    });
    const street = (project?.title || "a job").split(",")[0].trim();

    // WHO flagged it: the session identity (photographers are logged in), with
    // the job's photographer as the sessionless-local-dev fallback.
    let reportedBy: string | null = project?.photographer?.name ?? null;
    try {
      const { getCurrentUser } = await import("@/lib/auth/user");
      const u = await getCurrentUser();
      if (u) reportedBy = u.name ?? u.email;
    } catch { /* keep the fallback */ }

    // One key per (job, kind of flag, wording) for the BELL only — each new
    // flag rings once, a debrief card re-submitted on the next portal visit in
    // the same words does not ring again. The loop is keyed per job (below).
    const flagKey = crypto
      .createHash("sha1")
      .update([opts.projectId, opts.label, note].join("|"))
      .digest("hex")
      .slice(0, 24);

    // SAFETY NET, not the primary write: every caller writes the FLAG Activity
    // itself, immediately before calling in and OUTSIDE any catch, so a failure
    // there is loud. If a future caller forgets, the photographer's words must
    // still land on the job rather than evaporate into a Slack ping — so write
    // one when the project has no fresh flag.
    const justFlagged = await prisma.activity.count({
      where: {
        projectId: opts.projectId,
        type: ActivityType.FLAG,
        createdAt: { gte: new Date(Date.now() - 2 * 60_000) },
      },
    });
    if (justFlagged === 0) {
      await prisma.activity.create({
        data: { projectId: opts.projectId, type: ActivityType.FLAG, body: `${opts.label}: ${note}`.slice(0, 4000) },
      });
      console.warn("fileFieldIssue wrote the FLAG activity itself — caller didn't", opts.page);
    }

    if (!opts.opsTaskAlreadyFiled) {
      const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
      const priority = opts.priority ?? "HIGH";
      // On-site problems need an answer while the photographer is still there.
      const dueAt = new Date(Date.now() + (priority === "URGENT" ? 2 : 4) * 3600_000);
      const loopKey = fieldFlagLoopKey(opts.projectId);
      const now = new Date();

      // THE loop for this job: the per-job key first, then a pre-Sep-8 row
      // (oldest first, so two legacy rows on one job converge on the same one).
      const existing = await prisma.smartTask.findFirst({
        where: {
          projectId: opts.projectId,
          taskType: "internal_instruction",
          OR: [{ dedupeKey: loopKey }, ...legacyLoopWhere(opts.projectId)],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, description: true, status: true, priority: true, dueAt: true, assignedKey: true, dedupeKey: true },
      });

      // Fields both paths write. clientId stays NULL on purpose. This task is
      // the ONLY escalation a field flag gets (the platform-board row is
      // gone), and brain.ts lists internal_instruction in MERGEABLE_TYPES:
      // routeCommTask picks open tasks BY clientId as merge candidates, so the
      // client's next inbound text could retitle "Shoot issue — 5841 Montrose
      // St" into something about that text and the photographer's flag would
      // never be acted on. The job is already identified by projectId +
      // propertyAddress. Written as an explicit null, not omitted, so the
      // UPDATE path also clears it off any row that was filed with one.
      const shared = {
        reasonCreated: `Photographer flagged a problem from ${opts.page}.`,
        source: "manual",
        sourceDetail: opts.page.slice(0, 200),
        clientId: null,
        propertyAddress: project?.title ?? null,
        // reportedBy is resolved above from the session — so a flag Jordan
        // raises is stamped with his name and surfaces on Kyle's home under
        // "Flagged by Jordan", while a photographer's flag is stamped with
        // theirs. Stamped on both paths: a re-flag is a fresh flag.
        flaggedBy: reportedBy,
        flaggedAt: now,
        status: "OPEN",
        completedAt: null,
      };

      if (!existing) {
        await prisma.smartTask.create({
          data: {
            ...shared,
            taskType: "internal_instruction", // the type Open Loops + /tasks triage read
            title: `Shoot issue — ${street}`.slice(0, 120),
            summary: `${reportedBy ?? "The photographer"} flagged this on ${street}: “${note.slice(0, 200)}” — sort it out and close the loop.`.slice(0, 500),
            description: note.slice(0, 1200),
            priority,
            dueAt,
            ownerId: kyle?.id ?? null,
            projectId: opts.projectId,
            // A shoot problem is Kyle's ops routine, not "who does this?"
            // triage (isNeedsAssigning pins every unassigned
            // internal_instruction). Set on create only — a later human
            // reassignment survives the photographer flagging again.
            assignedKey: "kyle",
            dedupeKey: loopKey,
          },
        });
      } else {
        // Append, don't overwrite: the earlier flag's words are still the
        // record until Kyle closes the loop. A debrief re-submitted in the
        // same words adds nothing (but still reopens — re-flagged after
        // someone closed it means the problem came back, i.e. wasn't solved).
        const prior = (existing.description ?? "").trim();
        const already = prior.includes(note.slice(0, 200));
        const entry = `${opts.label} — ${reportedBy ?? "the photographer"}, ${etDateTime(now)}: ${note}`;
        const description = already
          ? prior
          : prior
            ? `${prior.startsWith("• ") ? prior : `• ${prior}`}\n• ${entry}`.slice(0, 2000)
            : note.slice(0, 1200);
        const entries = description.split("\n• ").length;
        const wasClosed = existing.status === "COMPLETED" || existing.status === "CANCELLED";
        await prisma.smartTask.update({
          where: { id: existing.id },
          data: {
            ...shared,
            // A closed loop reopens; one Kyle is mid-way through ("in progress",
            // "waiting photographer") keeps its state — the new line is enough.
            status: wasClosed ? "OPEN" : existing.status,
            summary: `${reportedBy ?? "The photographer"} flagged this on ${street}: “${note.slice(0, 200)}”${entries > 1 ? ` — ${entries} flags on this job, all listed below` : ""} — sort it out and close the loop.`.slice(0, 500),
            description,
            // Never let a second, calmer flag push the deadline out; a reopened
            // or on-site one gets a fresh clock.
            priority: priority === "URGENT" || wasClosed ? priority : existing.priority,
            dueAt: wasClosed || priority === "URGENT" || !existing.dueAt || existing.dueAt > dueAt ? dueAt : existing.dueAt,
            // The old debrief row was born unowned; give it Kyle. A human's
            // reassignment (anything already set) stands.
            assignedKey: existing.assignedKey ?? "kyle",
            ownerId: kyle?.id ?? null,
            projectId: opts.projectId,
            // Retire a legacy key onto the per-job one so the next lookup is
            // the cheap first branch — but only when the per-job key is free
            // (a job could carry both an old debrief row and an old hashed row;
            // the second one keeps its key and is found by the legacy branch).
            ...(existing.dedupeKey === loopKey ? {} : { dedupeKey: loopKey }),
          },
        }).catch(async (e) => {
          // The per-job key is taken by another legacy row on the same job —
          // re-run the write without the key swap rather than lose the flag.
          if ((e as { code?: string })?.code !== "P2002") throw e;
          await prisma.smartTask.update({
            where: { id: existing.id },
            data: { ...shared, status: wasClosed ? "OPEN" : existing.status, description, assignedKey: existing.assignedKey ?? "kyle" },
          });
        });
      }
    }

    // Same field-of-view pings as before, pointed at the JOB (best-effort).
    try {
      const { opsAlert, notifyInApp } = await import("@/lib/notify");
      const href = `/projects/${opts.projectId}`;
      await opsAlert(
        `🚩 ${opts.label}: “${note.slice(0, 140)}” — ${street}${reportedBy ? ` (from ${reportedBy})` : ""} → ${appBase()}${href}`,
      );
      await notifyInApp({
        kind: "system",
        title: `${opts.label} — ${street}`.slice(0, 90),
        href,
        // Kyle and James run the day; Jordan wants field problems in view too.
        targets: [{ roles: ["OWNER", "ADMIN"] }],
        // Keyed on the flag, not on a row id — the old key was the board row's
        // id, so a re-submitted debrief rang the bell all over again.
        dedupeKey: `fieldflag-${flagKey}`,
      });
    } catch { /* non-fatal */ }

    // The job's own pages are revalidated by the callers; these are the screens
    // the ops loop shows up on.
    revalidatePath("/ops");
    revalidatePath("/tasks");
    revalidatePath("/");
  } catch (e) {
    console.warn("fileFieldIssue failed (the flag itself is already on the job)", e);
  }
}
