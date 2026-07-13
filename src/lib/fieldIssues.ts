import "server-only";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

// ---------------------------------------------------------------------------
// Field flags → the Feedback & requests board. A photographer flagging a
// problem from the shoot screen, the upload portal, or the debrief used to
// land ONLY on the project timeline — Jordan reviews /feedback, so flags died
// unseen unless someone happened to open the job. This mirrors every field
// flag into a PlatformFeedback row (kind "field_issue") with the same
// review/approve/done workflow + owner bell the rest of the board gets.
// Best-effort by contract: a board hiccup must never break the flag itself.
// ---------------------------------------------------------------------------

export async function fileFieldIssue(opts: {
  projectId: string;
  note: string;
  /** Where it was flagged from — becomes the row's page link. */
  page: string;
  /** e.g. "Shoot issue" | "Upload issue" | "Shoot debrief" */
  label: string;
  /** Re-reports of the SAME incident (the debrief card re-renders on every
      portal visit) refresh the one open row instead of stacking duplicates.
      Leave off for the flag inputs — each typed flag is a distinct issue. */
  dedupe?: boolean;
}): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: opts.projectId },
      select: { title: true, photographer: { select: { name: true } } },
    });
    const street = (project?.title || "a job").split(",")[0].trim();
    const title = `${opts.label} — ${street}`.slice(0, 200);
    const body = `${opts.note.trim()}${project?.title ? `\n\nJob: ${project.title}` : ""}`.slice(0, 4000);

    // WHO flagged it: the session identity (photographers are logged in), with
    // the job's photographer as the sessionless-local-dev fallback.
    let submittedBy: string | null = project?.photographer?.name ?? null;
    try {
      const { getCurrentUser } = await import("@/lib/auth/user");
      const u = await getCurrentUser();
      if (u) submittedBy = u.name ?? u.email;
    } catch { /* keep the fallback */ }

    if (opts.dedupe) {
      const existing = await prisma.platformFeedback.findFirst({
        where: { kind: "field_issue", title, status: "NEW" },
        select: { id: true },
      });
      if (existing) {
        // Same incident, newer wording — refresh in place, no second bell.
        await prisma.platformFeedback.update({ where: { id: existing.id }, data: { body, submittedBy } });
        revalidatePath("/feedback");
        return;
      }
    }

    const fb = await prisma.platformFeedback.create({
      data: {
        kind: "field_issue",
        title,
        body,
        submittedBy,
        page: opts.page.slice(0, 200),
      },
    });

    // Same field-of-view pings the rest of the board gets (best-effort).
    try {
      const { opsAlert, notifyInApp } = await import("@/lib/notify");
      const base = process.env.NEXT_PUBLIC_APP_URL || "https://realtour-pilot-hub.vercel.app";
      await opsAlert(`🚩 ${opts.label}: “${opts.note.trim().slice(0, 140)}” — ${street}${submittedBy ? ` (from ${submittedBy})` : ""} → ${base}/feedback`);
      await notifyInApp({
        kind: "system",
        title: `${opts.label} — ${street}`.slice(0, 90),
        href: "/feedback",
        targets: [{ roles: ["OWNER"] }],
        dedupeKey: `pf-${fb.id}`,
      });
    } catch { /* non-fatal */ }

    revalidatePath("/feedback");
  } catch (e) {
    console.warn("fileFieldIssue failed (flag itself already saved)", e);
  }
}
