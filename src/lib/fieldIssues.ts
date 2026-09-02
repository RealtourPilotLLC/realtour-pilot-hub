import "server-only";
import crypto from "crypto";
import { appBase } from "@/lib/appUrl";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { ActivityType } from "@prisma/client";

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
//   • AN OPS LOOP — one internal_instruction SmartTask owned by Kyle, so a flag
//     is something a human closes out instead of a line on a timeline nobody
//     opens. Surfaces in Ops Day / Dashboard "Open loops" and on /tasks. This
//     replaces the board row as the thing that gets ACTED on; without it the
//     flag would be a Slack ping and nothing else.
//   • THE ALERTING that already worked — the Slack ops ping + the bell — now
//     deep-linked to the job instead of /feedback, and pointed at ADMIN (Kyle,
//     James) as well as the owner.
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

export async function fileFieldIssue(opts: {
  projectId: string;
  note: string;
  /** Where it was flagged from — kept on the ops task for triage. */
  page: string;
  /** e.g. "Shoot issue" | "Shoot debrief" — titles the ops loop and the alerts. */
  label: string;
  /** URGENT for a flag raised while the photographer is still on the property;
      HIGH once they're back and wrapping up. */
  priority?: "URGENT" | "HIGH";
  /** The caller already filed its own ops task (the debrief mints Kyle's
      "Shoot issue — …" task itself, keyed shoot-issue-<projectId>). Alert only
      — two loops for one incident is how a board becomes noise. */
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

    // One stable key per (job, kind of flag, wording) — the ops loop and the
    // bell share it, so a debrief card re-submitted on the next portal visit
    // refreshes the one loop instead of stacking a second.
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

    const summary = `${reportedBy ?? "The photographer"} flagged this on ${street}: “${note.slice(0, 200)}” — sort it out and close the loop.`.slice(0, 500);

    if (!opts.opsTaskAlreadyFiled) {
      const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
      const priority = opts.priority ?? "HIGH";
      // On-site problems need an answer while the photographer is still there.
      const dueAt = new Date(Date.now() + (priority === "URGENT" ? 2 : 4) * 3600_000);
      const data = {
        taskType: "internal_instruction", // the type Open Loops + /tasks triage read
        title: `${opts.label} — ${street}`.slice(0, 120),
        summary,
        description: note.slice(0, 1200),
        reasonCreated: `Photographer flagged a problem from ${opts.page}.`,
        source: "manual",
        sourceDetail: opts.page.slice(0, 200),
        priority,
        dueAt,
        ownerId: kyle?.id ?? null,
        projectId: opts.projectId,
        // clientId stays NULL on purpose. This task is now the ONLY escalation a
        // field flag gets (the platform-board row is gone), and brain.ts lists
        // internal_instruction in MERGEABLE_TYPES: routeCommTask picks open tasks
        // BY clientId as merge candidates, so the client's next inbound text
        // could retitle "Shoot issue — 5841 Montrose St" into something about
        // that text and the photographer's flag would never be acted on. The job
        // is already identified by projectId + propertyAddress. Written as an
        // explicit null, not omitted, so the upsert's UPDATE path also clears it
        // off any row that was filed with one.
        clientId: null,
        propertyAddress: project?.title ?? null,
      };
      await prisma.smartTask.upsert({
        where: { dedupeKey: flagKey },
        // assignedKey on CREATE only: a shoot problem is Kyle's ops routine, not
        // "who does this?" triage (isNeedsAssigning pins every unassigned
        // internal_instruction), and a later human reassignment must survive the
        // photographer re-flagging the same thing.
        create: { ...data, assignedKey: "kyle", dedupeKey: flagKey },
        // Re-flagged in the same words after someone closed it: reopen. A
        // problem that comes back is a problem that wasn't solved.
        update: { ...data, status: "OPEN", completedAt: null },
      });
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
    // the NEW ops loop shows up on.
    revalidatePath("/ops");
    revalidatePath("/tasks");
    revalidatePath("/");
  } catch (e) {
    console.warn("fileFieldIssue failed (the flag itself is already on the job)", e);
  }
}
