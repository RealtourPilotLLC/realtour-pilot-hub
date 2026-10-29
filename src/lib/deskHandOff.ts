// ---------------------------------------------------------------------------
// A DESK ROW HANDED ON LEAVES THE DESK (Kyle, Oct 29 2026, 5:02 PM: "I
// delegated this task to Jordan but it's still showing up": Sharra Mercer's
// booking request, Email · 3 business hours, Answer).
//
// A desk row with no task of its own (a booking request, a waiting email, a
// special request, a missing-details reminder) is handed on through
// assignTask with the row's page as sourceHref. The new task went to Jordan,
// but the row is built from the ask or the message, not from that task, so
// nothing told it the work had moved. Now:
//   · Hand it on stamps the row's id on the link ("?desk=booking:<id>"), so
//     the hand-off names exactly one row (two rows on the same job page no
//     longer share one task either: the dedupe key is the link);
//   · the desk reads what its person handed on (tasksDelegatedByAny) and a
//     row that went is "waiting on others", saying to whom and where it
//     stands, out of the count. It stays on the assignee's list and in the
//     delegator's own fold. Cancelled, it is the desk's again.
//   · a hand-off made before the stamp (Kyle's two to Jordan on Oct 28-29)
//     matches by the exact page, only when it came after the row did.
// Pure: the client's Hand it on and the server's desk both use it.
// ---------------------------------------------------------------------------

const PARAM = "desk";
const MAX_HREF = 300; // lib/delegation safeHref

/** The row's page with its id stamped on (before any #hash); the plain page when that would be too long. */
export function deskRowHref(href: string, rowId: string): string {
  const at = href.indexOf("#");
  const base = at < 0 ? href : href.slice(0, at);
  const hash = at < 0 ? "" : href.slice(at);
  const out = `${base}${base.includes("?") ? "&" : "?"}${PARAM}=${encodeURIComponent(rowId)}${hash}`;
  return out.length <= MAX_HREF ? out : href;
}

/** The desk row a hand-off link names, or null (a link from anywhere else). */
export function deskRowOf(href: string | null | undefined): string | null {
  if (!href) return null;
  const q = href.split("#")[0];
  const at = q.indexOf("?");
  if (at < 0) return null;
  return new URLSearchParams(q.slice(at + 1)).get(PARAM) || null;
}

/** Rows that carry their own task are moved by reassigning that task, never matched here. */
const OWN_TASK = /^(?:task|rev|lead):/;

export type HandOff = { taskId: string; sourceHref: string | null; assignedAt: string | null; state: string };

/**
 * The hand-off that took this row off the desk, or null. Open ones and
 * completed ones count (completed: it was done there; the row waits in the
 * fold rather than coming back); a cancelled one gives the row back.
 */
export function handOffFor<H extends HandOff>(row: { id: string; href: string | null; sinceISO: string | null }, handed: H[]): H | null {
  if (OWN_TASK.test(row.id)) return null;
  const live = handed.filter((h) => h.state !== "CANCELLED" && !!h.sourceHref);
  const stamped = live.find((h) => deskRowOf(h.sourceHref) === row.id);
  if (stamped) return stamped;
  if (!row.href || !row.sinceISO) return null;
  return live.find((h) => !deskRowOf(h.sourceHref) && h.sourceHref === row.href && !!h.assignedAt && h.assignedAt >= row.sinceISO!) ?? null;
}
