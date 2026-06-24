"use server";

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
  const title = input.title.trim();
  if (!title) return { ok: false, message: "Add a short title." };
  const kind = ["feature", "bug", "feedback"].includes(input.kind) ? input.kind : "feature";

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
      submittedBy: input.submittedBy?.trim()?.slice(0, 120) || null,
      page: input.page?.slice(0, 200) || null,
      screenshot,
    },
  });

  const base = process.env.NEXT_PUBLIC_APP_URL || "https://realtour-pilot-hub.vercel.app";
  const label = kind === "bug" ? "🐞 Bug report" : kind === "feedback" ? "💬 Feedback" : "✨ Feature request";
  await notifyOwnerEmail(
    `${label}: ${title}`,
    [
      `${label} submitted to the RealTour hub${input.submittedBy ? ` by ${input.submittedBy}` : ""}.`,
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
  await prisma.platformFeedback.update({
    where: { id },
    data: {
      status,
      adminNote: adminNote?.trim()?.slice(0, 500) || undefined,
      decidedAt: status === "NEW" ? null : new Date(),
    },
  });
  revalidatePath("/feedback");
}
