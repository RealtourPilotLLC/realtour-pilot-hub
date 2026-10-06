import "server-only";
import { portalVideoList, type VideoListRow } from "@/lib/contentVideos";
import type { PortalViewer } from "@/lib/portal";

// ---------------------------------------------------------------------------
// ONE PORTAL LAYOUT (Jordan, Oct 6 2026: "I want to just be fully
// transitioned to the new layout").
//
// This file used to decide WHICH layout a portal visit got (UI-01, Sep 24;
// R04, Sep 28): today's six tabs ("v1") for everyone, the new navigation
// ("v2" — Home · Your Month · Content Library · Schedule · More, in
// PortalShell) for TEST clients, rollout pilots with the layout ticked while
// the `portal_layout_v2` switch was on, and staff who added ?layout=v2. That
// decision is gone: every client, every signed-in person and every staff
// look through the owner iframe gets the one layout. The switch, the
// rollout's "layout" tick, the onboarding toggle and the staff preview link
// went with it. An old address still lands — `?layout=v2` is ignored, and
// every ?tab= key ever sent in an email resolves to its page
// (portalNav.resolvePortalRoute). An old stored rollout that lists the
// portal_layout_v2 op still reads: the parser drops ops it no longer knows.
//
// What is left here are the Content Library's whole-library reads.
// ---------------------------------------------------------------------------

// ---- the whole library, for review-first + search ------------------------------

/** Enough for any library on file (the largest is a few hundred rows). */
const LIBRARY_PAGE = 60;
const LIBRARY_MAX_PAGES = 25;

/**
 * Every row of the client's library, in portalVideoList's order, with the
 * state its one derivation gives each row. The Library searches, filters
 * and pulls "needs your review" to the top over the WHOLE list — the old
 * (pre-Oct 6) list paged first, so a video waiting on page two was never
 * surfaced. Read through
 * portalVideoList page by page rather than a second query, so the scoping
 * (enrollment AND client), the state rule and the Previous-content split stay
 * in exactly one place. O(videos) per visit; a library is small.
 */
export async function libraryRows(enrollment: { id: string; clientId: string }): Promise<{ rows: VideoListRow[]; total: number; complete: boolean }> {
  const first = await portalVideoList(enrollment, { page: 1, perPage: LIBRARY_PAGE });
  const rows = [...first.rows];
  const last = Math.min(first.pages, LIBRARY_MAX_PAGES);
  for (let p = 2; p <= last; p++) rows.push(...(await portalVideoList(enrollment, { page: p, perPage: LIBRARY_PAGE })).rows);
  return { rows, total: first.total, complete: first.pages <= LIBRARY_MAX_PAGES };
}

/**
 * The CP-02 review deadline for each video waiting on the client — from
 * reviewWindows.reviewPanelFor, the same row enforcement reads. Empty while
 * `revision_policy` is off (the panel is null), so nothing is promised that
 * the server would not hold them to.
 */
export async function reviewDeadlines(viewer: PortalViewer, rows: VideoListRow[]): Promise<Map<string, { iso: string; label: string }>> {
  const out = new Map<string, { iso: string; label: string }>();
  const waiting = rows.filter((r) => r.state === "FOR_REVIEW" && r.currentSubmissionId).slice(0, 12);
  if (!waiting.length) return out;
  const { reviewPanelFor } = await import("@/lib/reviewWindows");
  await Promise.all(waiting.map(async (r) => {
    const p = await reviewPanelFor(viewer, r.currentSubmissionId!).catch(() => null);
    if (p?.deadlineISO && p.deadlineLabel && !p.closed) out.set(r.id, { iso: p.deadlineISO, label: p.deadlineLabel });
  }));
  return out;
}
