import { MessageSquarePlus, Inbox, CheckCircle2, Rocket, Archive } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { PlatformFeedbackForm } from "@/components/feedback/PlatformFeedbackForm";
import { PlatformFeedbackItem, type FeedbackRow } from "@/components/feedback/PlatformFeedbackItem";

export const dynamic = "force-dynamic";

export default async function FeedbackPage() {
  const all = await prisma.platformFeedback.findMany({ orderBy: { createdAt: "desc" } });
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
      <PageHeader title="Feedback & requests" subtitle="Tell us what to build or fix — Jordan reviews each one, and approved ideas get built." />
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
        <PlatformFeedbackForm />

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
                    <PlatformFeedbackItem key={r.id} row={r} />
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
