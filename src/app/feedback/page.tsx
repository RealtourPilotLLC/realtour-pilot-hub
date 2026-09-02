import Link from "next/link";
import { requirePageAccess } from "@/lib/auth/guards";
import { MessageSquarePlus, Inbox, CheckCircle2, Rocket, Archive, MessageSquareHeart } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { PlatformFeedbackForm } from "@/components/feedback/PlatformFeedbackForm";
import { PlatformFeedbackItem, type FeedbackRow } from "@/components/feedback/PlatformFeedbackItem";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE PLATFORM board: feedback about the HUB — features to build, bugs to fix.
// Nothing else belongs here. Feedback about the WORK (what clients said, how a
// photographer is shooting) lives on /quality, and the field flags that used to
// share this board moved there too: a "the sprinklers were on at 3188
// Thornapple" flag is a job problem, not a hub problem, and mixing the two made
// this list unreadable as a build queue. They keep the identical review
// workflow over there (same PlatformFeedbackItem, same owner-only decisions).
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
  const all = await prisma.platformFeedback.findMany({
    where: { kind: { not: "field_issue" } },
    orderBy: { createdAt: "desc" },
  });
  // Only owner/admin can open /quality, so only they get the pointer to it.
  const showQualityLink = !viewer || viewer.role === "OWNER" || viewer.role === "ADMIN";
  const rows: FeedbackRow[] = all.map((f) => ({
    id: f.id,
    kind: f.kind,
    title: f.title,
    body: f.body,
    submittedBy: f.submittedBy,
    status: f.status,
    createdAt: f.createdAt.toISOString(),
    screenshot: f.screenshot,
    page: f.page,
  }));
  const by = (s: string) => rows.filter((r) => r.status === s);
  const groups = [
    { key: "NEW", label: "Needs review", icon: Inbox, rows: by("NEW") },
    { key: "APPROVED", label: "Approved — building", icon: Rocket, rows: by("APPROVED") },
    { key: "DONE", label: "Shipped", icon: CheckCircle2, rows: by("DONE") },
    { key: "DECLINED", label: "Declined", icon: Archive, rows: by("DECLINED") },
  ];

  return (
    <div>
      <PageHeader
        title="Feedback & requests"
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

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted">
            <MessageSquarePlus className="mx-auto mb-2 size-6 text-muted-2" />
            No requests yet. Be the first — what would make the hub better?
          </div>
        ) : (
          groups.map((g) =>
            g.rows.length === 0 ? null : (
              <section key={g.key}>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <g.icon className="size-4 text-muted" /> {g.label}
                  <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{g.rows.length}</span>
                </h2>
                <div className="space-y-2">
                  {g.rows.map((r) => (
                    <PlatformFeedbackItem key={r.id} row={r} canModerate={canModerate} pingTargets={pingTargets} />
                  ))}
                </div>
              </section>
            ),
          )
        )}
      </div>
    </div>
  );
}
