import { redirect } from "next/navigation";
import { CalendarClock, CalendarSync } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";
import { schedulingBoard } from "@/lib/clientAsks";
import { AskBoardRow } from "@/components/asks/AskBoard";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/scheduling: KYLE'S SCHEDULING (Oct 19 2026, lib/clientAsks). Jordan:
// "scheduling requests or rescheduling requests, follow up with that." Three
// kinds of follow-up, oldest first:
//   · a client asked by text or email to book, move or cancel a shoot (read
//     by the same Smart Brain call that files their reply task);
//   · a portal session request (book, move, cancel); it closes by itself when
//     Aryeo confirms or cancels the session;
//   · a move, postpone or cancel seen in Aryeo in the last 48 hours.
// Each closes with Done or Not needed. Due the day it arrives; behind after
// 24 hours open.
// ---------------------------------------------------------------------------

export default async function SchedulingPage() {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect(homeFor(me.role));

  const board = await schedulingBoard().catch((e) => {
    console.error("[client-asks] scheduling board failed", e);
    return null;
  });
  const c = board?.counts;
  const subtitle = c
    ? c.open
      ? `${c.open} to follow up${c.behind ? ` · ${c.behind} behind` : ""}. Booking, moving and cancelling shoots. Oldest first; times are Eastern.`
      : "Nothing to follow up. Scheduling asks show here by themselves."
    : "Booking, moving and cancelling shoots.";

  return (
    <div>
      <PageHeader eyebrow="Operations" title="Scheduling" subtitle={subtitle} />
      <div className="mx-auto max-w-5xl space-y-4 p-4 pb-16 sm:p-6">
        {!board ? (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">The scheduling list could not be read. Refresh to try again.</p>
        ) : (
          <>
            <Section icon={CalendarClock} title="Client scheduling asks" count={board.asks.length} flush>
              {board.asks.length ? (
                <ul className="divide-y divide-border">
                  {board.asks.map((a) => (
                    <AskBoardRow key={a.id} a={a} showJob />
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-4 text-sm text-muted">No client is waiting on a booking, a move or a cancel.</p>
              )}
            </Section>
            <Section icon={CalendarSync} title="Changed in Aryeo, last 48 hours" count={board.aryeo.length} flush>
              {board.aryeo.length ? (
                <ul className="divide-y divide-border">
                  {board.aryeo.map((a) => (
                    <AskBoardRow key={a.id} a={a} showJob />
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-4 text-sm text-muted">No shoot was moved, postponed or cancelled in Aryeo in the last 48 hours.</p>
              )}
            </Section>
            {board.closed.length > 0 && (
              <details className="rounded-2xl border border-border bg-surface px-4 py-1">
                <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
                  Closed in the last 3 days <span className="font-normal text-muted">{board.closed.length}</span>
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
