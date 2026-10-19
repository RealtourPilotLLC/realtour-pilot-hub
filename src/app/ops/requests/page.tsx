import { redirect } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";
import { specialRequestsBoard } from "@/lib/clientAsks";
import { AddAskForm } from "@/components/asks/AddAskForm";
import { AskBoardRow, RequestGroupCard } from "@/components/asks/AskBoard";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/requests: KYLE'S SPECIAL REQUESTS (Oct 19 2026, lib/clientAsks).
// Jordan: "special requests that we have from clients, make sure that these
// are correct." Every open ask on work not yet delivered, grouped by job,
// oldest first: a text or email ask (holds that job's delivery until it is
// confirmed), an Aryeo order note or an add-on to check (never holds). Each
// closes with Confirmed (checked on the finished work), Done or Not needed;
// our reply to the client never closes one. Behind = past the job's delivery
// promise, or open 48 hours.
// ---------------------------------------------------------------------------

export default async function SpecialRequestsPage() {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect(homeFor(me.role));

  const board = await specialRequestsBoard().catch((e) => {
    console.error("[client-asks] special requests board failed", e);
    return null;
  });
  const c = board?.counts;
  const subtitle = c
    ? c.open
      ? `${c.open} open${c.behind ? ` · ${c.behind} behind` : ""}${c.dueToday ? ` · ${c.dueToday} due today` : ""}. What clients asked us to get right before delivery. Oldest first; times are Eastern.`
      : "Nothing open. What clients ask us to get right shows here by itself."
    : "What clients asked us to get right before delivery.";

  return (
    <div>
      <PageHeader eyebrow="Operations" title="Special requests" subtitle={subtitle} />
      <div className="mx-auto max-w-5xl space-y-4 p-4 pb-16 sm:p-6">
        {!board ? (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">The requests could not be read. Refresh to try again.</p>
        ) : (
          <>
            {board.groups.length === 0 ? (
              <div className="panel-shadow rounded-2xl border border-border bg-surface p-8 text-center">
                <ClipboardCheck aria-hidden className="mx-auto size-8 text-brand" />
                <p className="mt-2 font-semibold">No open special requests</p>
                <p className="mx-auto mt-1 max-w-xl text-sm text-muted">
                  When a client texts or emails what a job must have (lot lines, a song, a shot), or the order carries a note or an add-on to check, it lands here
                  until someone confirms it.
                </p>
              </div>
            ) : (
              board.groups.map((g) => <RequestGroupCard key={g.key} g={g} jobs={board.jobs} />)
            )}
            <AddAskForm jobs={board.jobs.map((j) => ({ id: j.id, label: j.label }))} />
            {board.closed.length > 0 && (
              <details className="rounded-2xl border border-border bg-surface px-4 py-1">
                <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
                  Closed in the last 7 days <span className="font-normal text-muted">{board.closed.length}</span>
                </summary>
                <ul className="-mx-4 divide-y divide-border border-t">
                  {board.closed.map((a) => (
                    <AskBoardRow key={a.id} a={a} showJob />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
