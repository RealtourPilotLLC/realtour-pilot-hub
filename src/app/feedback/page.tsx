import Link from "next/link";
import { requirePageAccess } from "@/lib/auth/guards";
import { MessageSquareHeart } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { PlatformFeedbackForm } from "@/components/feedback/PlatformFeedbackForm";
import { FeedbackBoard } from "@/components/feedback/FeedbackBoard";
import type { FeedbackRow } from "@/components/feedback/PlatformFeedbackItem";
import { feedbackScreenshotHref } from "@/lib/feedbackScreenshot";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE PLATFORM board: feedback about the HUB — features to build, bugs to fix.
// Nothing else belongs here. Feedback about the WORK (what clients said, how a
// photographer is shooting) lives on /quality, and the field flags that used to
// share this board moved there too: a "the sprinklers were on at 3188
// Thornapple" flag is a job problem, not a hub problem, and mixing the two made
// this list unreadable as a build queue. They keep the identical review
// workflow over there (same PlatformFeedbackItem, same owner-only decisions).
//
// Screenshots (Oct 12): the page no longer ships the stored data: URLs — a
// browser won't open one in a new tab, and they bloated every render. Each
// card points at /api/feedback/<id>/screenshot, which serves the image.
// ---------------------------------------------------------------------------

export default async function FeedbackPage() {
  await requirePageAccess("feedback");
  // Approve/Decline are OWNER decisions (the actions enforce it) — don't render
  // buttons that silently fail for ADMIN (audit).
  const { getCurrentUser } = await import("@/lib/auth/user");
  const viewer = await getCurrentUser().catch(() => null);
  const canModerate = !viewer || viewer.role === "OWNER";
  const pingTargets = canModerate
    ? await prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  // Field flags (kind "field_issue") are excluded — they're on /quality now.
  const where = { kind: { not: "field_issue" } };
  const [all, withShot] = await Promise.all([
    prisma.platformFeedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: { id: true, kind: true, title: true, body: true, submittedBy: true, status: true, createdAt: true, page: true },
    }),
    prisma.platformFeedback.findMany({ where: { ...where, screenshot: { not: null } }, select: { id: true } }),
  ]);
  const shots = new Set(withShot.map((r) => r.id));
  // Only owner/admin can open /quality, so only they get the pointer to it.
  const showQualityLink = !viewer || viewer.role === "OWNER" || viewer.role === "ADMIN" || viewer.role === "CREATIVE_MANAGER";
  const rows: FeedbackRow[] = all.map((f) => ({
    id: f.id,
    kind: f.kind,
    title: f.title,
    body: f.body,
    submittedBy: f.submittedBy,
    status: f.status,
    createdAt: f.createdAt.toISOString(),
    screenshot: shots.has(f.id) ? feedbackScreenshotHref(f.id) : null,
    page: f.page,
  }));
  // The board keeps decisions in its own state; fresh server rows (a new
  // submission, a reload) start it over.
  const boardKey = rows.map((r) => `${r.id}:${r.status}`).join("|");

  return (
    <div>
      <PageHeader
        title="Report a hub problem"
        subtitle="About the hub itself — what to build or fix. Jordan reviews each one, and approved ideas get built."
      />
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
        <PlatformFeedbackForm />

        {showQualityLink && (
          <Link
            href="/quality"
            className="flex items-center gap-2.5 rounded-2xl border border-border bg-surface px-4 py-3 text-sm hover:border-brand/40"
          >
            <MessageSquareHeart className="size-4 shrink-0 text-brand" />
            <span className="text-muted">
              Looking for what <span className="font-medium text-foreground">clients</span> said, or how a{" "}
              <span className="font-medium text-foreground">photographer</span> is doing? That&rsquo;s on Client &amp;
              team feedback — field flags from shoots live there too.
            </span>
          </Link>
        )}

        <FeedbackBoard key={boardKey} rows={rows} canModerate={canModerate} pingTargets={pingTargets} />
      </div>
    </div>
  );
}
