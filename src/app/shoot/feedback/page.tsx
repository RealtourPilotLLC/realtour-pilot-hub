import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Camera } from "lucide-react";
import { photographerMemberId, getShootPhotographer } from "@/lib/shoot";
import { getFeedbackHub, getFeedbackRoster } from "@/lib/photographerFeedback";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { FieldTabs } from "@/components/shoot/FieldTabs";
import { FeedbackHubView } from "@/components/shoot/FeedbackHub";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// QUALITY FEEDBACK — the photographer's dedicated cross-shoot feedback screen
// (the receiving end of the media/cut reviews, Frame.io-style, photos + video)
// with their KPIs. Photographers are scoped to themselves, fail-closed.
// Owner/admin without ?as= get the ROSTER: every photographer at a glance,
// drill into anyone's hub read-only. Same scoping pattern as /shoot.
// ---------------------------------------------------------------------------

export default async function QualityFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  const user = await getCurrentUser();
  // Fail CLOSED on a null user under enforcement: a stale JWT whose AppUser was
  // disabled/removed still passes the middleware (it only checks the token), but
  // getCurrentUser() re-reads the DB. Treating null as "not a photographer"
  // would hand them the whole roster + any ?as= hub.
  if (!user && authEnforced()) redirect("/login");
  const isPhotographer = user?.role === "PHOTOGRAPHER";
  const { as } = await searchParams;

  const viewAs = !isPhotographer && as ? await getShootPhotographer(as) : null;
  const scoped = isPhotographer
    ? ((await photographerMemberId(user)) ?? "__none__")
    : viewAs?.id ?? null;

  // A photographer login that isn't linked to a TeamMember can't have feedback.
  if (scoped === "__none__") {
    return (
      <div>
        <PageHeader eyebrow="Field" title="Quality feedback" />
        <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
          <FieldTabs active="feedback" />
          <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
            Your login isn&rsquo;t linked to a photographer profile yet — ask Jordan to connect it and your
            feedback will show up here.
          </p>
        </div>
      </div>
    );
  }

  // One photographer's hub — their own, or an owner/admin preview.
  if (scoped) {
    const hub = await getFeedbackHub(scoped);
    const readOnly = !isPhotographer || Boolean(user?.impersonating);
    return (
      <div>
        <PageHeader
          eyebrow="Field"
          title={viewAs ? `${viewAs.name.split(" ")[0]}’s quality feedback` : "Quality feedback"}
          subtitle={
            viewAs
              ? `Read-only — exactly what ${viewAs.name.split(" ")[0]} sees`
              : "Capture notes from your reviewed shoots, and how you're trending"
          }
        />
        <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
          <FieldTabs active="feedback" asId={viewAs?.id} feedbackCount={hub?.kpis.openFixes ?? 0} />
          {hub ? (
            <FeedbackHubView hub={hub} readOnly={readOnly} />
          ) : (
            <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
              That photographer profile doesn&rsquo;t exist anymore.
            </p>
          )}
        </div>
      </div>
    );
  }

  // Owner/admin roster — how every photographer is doing, at a glance.
  const roster = await getFeedbackRoster();
  return (
    <div>
      <PageHeader
        eyebrow="Quality desk"
        title="Photographer feedback"
        subtitle="Capture-quality scoreboard — open a photographer to see exactly what they see"
      />
      <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
        <FieldTabs active="feedback" />
        {roster.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
            No capture feedback yet. Leave photographer-lane notes from a project&rsquo;s media review (Review
            mode → pin a note) or a cut review, and the scoreboard builds itself.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {roster.map((r) => (
              <li key={r.memberId}>
                <Link
                  href={`/shoot/feedback?as=${r.memberId}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-surface p-3.5 hover:border-brand/40"
                >
                  <Camera className="size-5 shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm font-semibold">{r.name}</span>
                    <div className="text-xs text-muted">
                      {r.shoots90} shoot{r.shoots90 === 1 ? "" : "s"} in 90d · {r.totalNotes} note
                      {r.totalNotes === 1 ? "" : "s"} all-time
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium">
                    {r.openFixes > 0 && (
                      <span className="rounded-full bg-warning/10 px-2 py-0.5 text-warning">{r.openFixes} to fix</span>
                    )}
                    {r.awaitingReReview > 0 && (
                      <span className="rounded-full bg-success/10 px-2 py-0.5 text-success">{r.awaitingReReview} fixed</span>
                    )}
                    {r.openCoaching > 0 && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">{r.openCoaching} coaching</span>
                    )}
                    <ArrowRight className="size-3.5 text-muted-2" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
