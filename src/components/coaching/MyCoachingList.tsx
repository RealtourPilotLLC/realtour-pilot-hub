import { GraduationCap } from "lucide-react";
import { etDate, etFullDate } from "@/lib/datetime";
import type { MyCoachingItem } from "@/lib/myCoaching";

// ---------------------------------------------------------------------------
// The person's own coaching (Oct 29 2026, lib/myCoaching): what James or
// Jordan recorded for them, newest note first, with the standard and the next
// step. On "My quality notes" for field creatives and /my-coaching for
// everyone else; the coaching text links here (#coaching). Read only.
// ---------------------------------------------------------------------------

export function MyCoachingList({ items, whose, empty = true }: { items: MyCoachingItem[]; whose: "your" | string; empty?: boolean }) {
  if (!items.length && !empty) return null;
  return (
    <section id="coaching" data-my-coaching className="scroll-mt-20 rounded-2xl border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <GraduationCap aria-hidden className="size-4 text-sky-400 light:text-sky-600" /> Coaching
      </h2>
      {!items.length ? (
        <p className="mt-2 text-sm text-muted">No coaching recorded for {whose === "your" ? "you" : whose} right now. When James or Jordan records feedback, it shows here and you get a link.</p>
      ) : (
        <ul className="mt-3 space-y-4">
          {items.map((i) => (
            <li key={i.id} data-coaching-item={i.id} data-status={i.status} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="min-w-0 flex-1 basis-48 text-sm font-semibold [overflow-wrap:anywhere]">{i.skill}</h3>
                <span className={i.status === "OPEN" ? "rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning" : "rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"}>{i.statusWords}</span>
              </div>
              <dl className="mt-1.5 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-[13px]">
                {i.standard && (<><dt className="text-muted">What good looks like</dt><dd className="[overflow-wrap:anywhere]">{i.standard}</dd></>)}
                {i.nextAction && (<><dt className="text-muted">Next step</dt><dd className="[overflow-wrap:anywhere]">{i.nextAction}</dd></>)}
                {i.practice && (<><dt className="text-muted">Practice</dt><dd className="[overflow-wrap:anywhere]">{i.practice}{i.practiceDueISO ? ` (by ${etDate(i.practiceDueISO)})` : ""}</dd></>)}
                {i.followUpISO && (<><dt className="text-muted">Follow-up</dt><dd>{etDate(i.followUpISO)}</dd></>)}
              </dl>
              {i.notes.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {i.notes.map((n, k) => (
                    <li key={k} className="text-sm leading-snug">
                      <p className="text-[11px] text-muted-2">{n.what} · {n.by} · {etFullDate(n.atISO)}</p>
                      <p className="mt-0.5 whitespace-pre-line text-foreground/90 [overflow-wrap:anywhere]">{n.note}</p>
                    </li>
                  ))}
                </ul>
              )}
              {i.examples.length > 0 && (
                <details className="mt-2 text-[13px]">
                  <summary className="cursor-pointer text-muted">Examples ({i.examples.length})</summary>
                  <ul className="mt-1 space-y-0.5 text-muted">
                    {i.examples.map((e, k) => <li key={k} className="[overflow-wrap:anywhere]">· {e.label}{e.atISO ? `, ${etDate(e.atISO)}` : ""}</li>)}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
