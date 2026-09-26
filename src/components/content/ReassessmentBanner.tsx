import { AlertTriangle } from "lucide-react";

// ---------------------------------------------------------------------------
// A25 (Sep 25 2026): the sessions of this month the office has to reassess
// with the client — a call that moved, was cancelled or was a no-show, or
// answers sent again after the session was booked. Server component on the
// staff Sessions view. It says what changed and that nothing was moved; the
// desk task on Kyle's list carries the work, and closing it keeps the session.
// A read that fails shows nothing rather than an "all clear" nobody checked —
// the task list is the record either way.
// ---------------------------------------------------------------------------

const KIND_WORDS: Record<string, string> = {
  ANCHOR_MOVED: "Preparation time changed",
  ANCHOR_LOST: "Strategy call gone",
  CALL_BUFFER: "Call inside the buffer",
};

export async function ReassessmentBanner({ monthId }: { monthId: string }) {
  const rows = await import("@/lib/sessionReassess")
    .then(({ openReassessments }) => openReassessments([monthId]))
    .then((m) => m.get(monthId) ?? [])
    .catch(() => null);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-warning/50 bg-warning-soft/40 px-4 py-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="size-4 text-warning" />
        {rows.length === 1 ? "A filming session needs a second look" : `${rows.length} filming sessions need a second look`}
      </p>
      <ul className="mt-1.5 space-y-1">
        {rows.map((r) => (
          <li key={r.id}>
            <span className="font-medium">{KIND_WORDS[r.kind] ?? r.kind}:</span> {r.reason}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-muted">Nothing has been moved or cancelled and the client has not been messaged; their portal says Kyle will confirm their filming time. The task on Kyle&rsquo;s list closes itself when this clears, and closing it by hand keeps the session as it is.</p>
    </div>
  );
}
