import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced, requirePageAccess } from "@/lib/auth/guards";
import { strategyCallDesk } from "@/lib/strategyCallDesk";
import { listCallRecords, callReviewQueue } from "@/lib/contentCallRecords";
import { prisma } from "@/lib/prisma";
import { StrategyCallsDesk } from "@/components/content/StrategyCallsDesk";
import { CallReviewQueue } from "@/components/content/CallReviewQueue";

export const dynamic = "force-dynamic";
// "Analyze the call" runs its AI in after() under this page's ceiling (Oct 12 2026).
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// STRATEGY CALLS · LAST 30 DAYS (Oct 6 2026). Jordan: "Maybe having an option
// to look through the strategy calls over the past 30 days to manually assign
// to a client's month would be great." Owner or admin only — assigning files a
// call on a client's month and moves the month to the call route.
//
// THE ONE CALL QUEUE (Jordan, Oct 21 2026; audit D12). Monitoring had a second
// queue that filed calls on clients by other rules. Below the desk now: the
// questions the desk does not cover (a call the matcher could not place that
// is not on the desk, a discovery call among them; a transcript that needs a
// person; an email address proposed as a client's). A call the desk already
// shows is not listed twice, unless its transcript needs a person.
// ---------------------------------------------------------------------------
export default async function StrategyCallsPage() {
  await requirePageAccess("content");
  const me = await getCurrentUser().catch(() => null);
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect("/content");
  const ownerEyes = me ? me.role === "OWNER" : !authEnforced();
  const [data, calls, queue, months] = await Promise.all([
    // A failed desk read is said out loud below; it no longer takes the review section down with it.
    strategyCallDesk().catch(() => null),
    listCallRecords({ onlyReview: true, limit: 40 }).catch(() => null),
    callReviewQueue().catch(() => null),
    prisma.contentMonth.findMany({ select: { monthKey: true }, distinct: ["monthKey"], orderBy: { monthKey: "desc" }, take: 18 }).catch(() => null),
  ]);
  // ContentEnrollment.clientId is a plain ref, so the enrolled clients are
  // resolved in two steps rather than through a relation filter.
  const enrolled = await prisma.contentEnrollment.findMany({ select: { clientId: true } }).catch(() => null);
  const clientList = enrolled === null ? null : enrolled.length
    ? await prisma.client.findMany({ where: { id: { in: enrolled.map((e) => e.clientId) } }, select: { id: true, name: true }, orderBy: { name: "asc" } }).catch(() => null)
    : [];
  const onDesk = new Set(data?.rows.map((r) => r.id) ?? []);
  const reviewCalls = calls?.filter((c) => !onDesk.has(c.id) || c.transcriptState === "CANDIDATES" || c.transcriptState === "NEEDS_REVIEW") ?? null;
  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/content" label="Content Program" />
      </div>
      <PageHeader eyebrow="Content program" title="Strategy calls" subtitle="last 30 days and the next 14 · file each call on a client's month" />
      <div className="mx-auto max-w-5xl space-y-8 p-4 pb-16 sm:p-6">
        {data
          ? <StrategyCallsDesk data={JSON.parse(JSON.stringify(data))} />
          : <p role="alert" className="rounded-xl border border-danger/30 p-4 text-sm text-danger">The strategy calls could not be read just now. Reload the page to try again.</p>}
        <section id="review" aria-labelledby="call-review-title" className="scroll-mt-20 space-y-3">
          <div>
            <h2 id="call-review-title" className="text-xs font-semibold uppercase tracking-wide text-muted-2">Also needs a person</h2>
            <p className="mt-1 text-sm text-muted">Calls the matcher could not place that are not in the list above, transcripts that need a person, and email addresses proposed as a client&rsquo;s.</p>
          </div>
          <CallReviewQueue
            calls={reviewCalls?.map((c) => ({
              id: c.id, callType: c.callType, status: c.status, matchState: c.matchState, matchNote: c.matchNote,
              transcriptState: c.transcriptState, scheduledStartISO: c.scheduledStart?.toISOString() ?? null,
              clientName: c.client?.name ?? null, inviteeEmail: c.inviteeEmail, inviteeName: c.inviteeName,
              eventTypeName: c.eventTypeName, targetMonthKey: c.targetMonthKey, lastError: c.lastError,
              candidates: c.candidates, jobs: c.jobs,
              transcripts: c.transcripts.map((t) => ({ id: t.id, title: t.title, sourceUrl: t.sourceUrl, matchState: t.matchState, recordedAtISO: t.recordedAt?.toISOString() ?? null })),
            })) ?? null}
            aliases={queue?.aliases.map((a) => ({ id: a.id, clientName: a.clientName, email: a.email, source: a.source, createdAtISO: a.createdAt.toISOString() })) ?? null}
            unlinked={queue?.unlinkedTranscripts.map((u) => ({ id: u.id, title: u.title, sourceUrl: u.sourceUrl, recordedAtISO: u.recordedAt?.toISOString() ?? null, legacyMonthId: u.legacyMonthId, candidates: u.candidates })) ?? null}
            clients={clientList}
            monthKeys={months?.map((m) => m.monthKey) ?? null}
            isOwner={ownerEyes}
          />
        </section>
      </div>
    </div>
  );
}
