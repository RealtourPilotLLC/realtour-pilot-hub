"use server";

import { requireOwner, requireRole } from "@/lib/auth/guards";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { notifyOwnerEmail } from "@/lib/integrations/google";

// A platform user submits feedback / a feature request / a bug. We record it and
// best-effort email Jordan so he can approve it (in-app). Never throws on the
// notify step — the record is what matters.
export async function submitPlatformFeedback(input: {
  kind: string; // feature | bug | feedback
  title: string;
  body?: string;
  submittedBy?: string;
  page?: string;
  screenshot?: string; // data URL (image/jpeg|png)
}): Promise<{ ok: boolean; message: string }> {
  // Any signed-in staff member may file platform feedback (this was the one
  // staff-facing write with no login check). NOTE: the PUBLIC client feedback
  // form is a different action (/feedback/[id] → submitFeedback) and stays
  // unauthenticated. Returned as {ok:false} so the widget shows it inline.
  try {
    await requireRole(["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"]);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Please sign in to do that." };
  }
  const title = input.title.trim();
  if (!title) return { ok: false, message: "Add a short title." };
  const kind = ["feature", "bug", "feedback"].includes(input.kind) ? input.kind : "feature";

  // WHO filed it — everyone is logged in now, so stamp the SESSION identity
  // instead of trusting the widget's optional free-text name (which was left
  // blank; Jordan couldn't tell who asked for what). The typed name survives
  // as a fallback for local dev with enforcement off.
  let submittedBy = input.submittedBy?.trim()?.slice(0, 120) || null;
  try {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const u = await getCurrentUser();
    if (u) submittedBy = u.name ?? u.email;
  } catch { /* sessionless local dev — keep the typed name */ }

  // Only keep a reasonable image (cap ~3MB of data URL) so the row stays sane.
  const screenshot =
    input.screenshot && /^data:image\/(png|jpeg);base64,/.test(input.screenshot) && input.screenshot.length < 3_500_000
      ? input.screenshot
      : null;

  const fb = await prisma.platformFeedback.create({
    data: {
      kind,
      title: title.slice(0, 200),
      body: input.body?.trim()?.slice(0, 4000) || null,
      submittedBy,
      page: input.page?.slice(0, 200) || null,
      screenshot,
    },
  });

  const base = process.env.NEXT_PUBLIC_APP_URL || "https://realtour-pilot-hub.vercel.app";
  const label = kind === "bug" ? "🐞 Bug report" : kind === "feedback" ? "💬 Feedback" : "✨ Feature request";
  const emailed = await notifyOwnerEmail(
    `${label}: ${title}`,
    [
      `${label} submitted to the RealTour hub${submittedBy ? ` by ${submittedBy}` : ""}.`,
      "",
      `Title: ${title}`,
      input.body ? `\nDetails:\n${input.body}` : "",
      input.page ? `\nWhere: ${input.page}` : "",
      screenshot ? "\n📎 Screenshot attached — view it on the board." : "",
      "",
      `Review & approve here: ${base}/feedback`,
      "",
      "Approve it there and it goes into the build queue.",
    ].join("\n"),
  );

  // The email notify fails SILENTLY today (Gmail send scope isn't connected), so
  // a bug filed from a phone reached nobody — the board was a black hole (audit
  // crack #36). Slack is the reliable channel: always ping ops, and say so when
  // the email didn't go out. Best-effort, never blocks the submission.
  try {
    const { opsAlert, notifyInApp } = await import("@/lib/notify");
    await opsAlert(
      `${label}: “${title}”${fb.submittedBy ? ` — from ${fb.submittedBy}` : ""}${emailed ? "" : " (owner email failed — Gmail send not connected)"} → ${base}/feedback`,
    );
    // Bell: put the submission in Jordan's in-app field of view too (the email
    // path is still broken separately — Gmail send scope isn't connected).
    await notifyInApp({
      kind: "system",
      title: `Platform feedback — ${title.slice(0, 60)}`,
      href: "/feedback",
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `pf-${fb.id}`,
    });
  } catch { /* non-fatal */ }

  revalidatePath("/feedback");
  return { ok: true, message: "Thanks! Sent to Jordan for review." };
}

// Jordan approves / declines / marks done — in-app. Approved items are the queue
// Claude implements from.
export async function decidePlatformFeedback(
  id: string,
  status: "APPROVED" | "DECLINED" | "DONE" | "NEW",
  adminNote?: string,
): Promise<void> {
  await requireOwner();
  const fb = await prisma.platformFeedback.update({
    where: { id },
    data: {
      status,
      adminNote: adminNote?.trim()?.slice(0, 500) || undefined,
      decidedAt: status === "NEW" ? null : new Date(),
    },
  });
  // A decision used to go nowhere beyond the row flip (audit crack #36) — ping
  // ops so an APPROVED item actually enters someone's field of view. The board
  // itself already shows the new status (grouped sections). Best-effort.
  if (status !== "NEW") {
    try {
      const { opsAlert } = await import("@/lib/notify");
      const base = process.env.NEXT_PUBLIC_APP_URL || "https://realtour-pilot-hub.vercel.app";
      const verb = status === "APPROVED" ? "✅ approved — into the build queue" : status === "DONE" ? "🚀 marked shipped" : "🗄 declined";
      await opsAlert(`Feedback “${fb.title}” ${verb}${fb.submittedBy ? ` (filed by ${fb.submittedBy})` : ""} → ${base}/feedback`);
    } catch { /* non-fatal */ }
  }
  revalidatePath("/feedback");
}
