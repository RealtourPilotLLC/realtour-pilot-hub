import "server-only";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { isTestClientName } from "@/lib/testClients";
import { portalVideoList, type VideoListRow } from "@/lib/contentVideos";
import type { PortalViewer } from "@/lib/portal";
import type { PortalLayout } from "@/lib/portalNav";

// ---------------------------------------------------------------------------
// WHICH LAYOUT A PORTAL VISIT GETS (UI-01, Sep 24 2026).
//
// The new navigation is CLIENT-FACING, so it ships dark: a missing
// `portal_layout_v2` row is OFF (programAutomation's one rule), and nobody
// seeds it. Three ways in, and only three:
//
//   · TEST_CLIENT   — a synthetic client (testClients.isTestClientName) always
//                     gets v2, so the new pages are exercised on the TEST
//                     account long before a real client sees them;
//   · SWITCH_ON     — Jordan turns `portal_layout_v2` on: every client;
//   · STAFF_PREVIEW — staff looking through the owner iframe add ?layout=v2.
//                     A staff preview otherwise shows what the CLIENT sees,
//                     so staff and client never look at different screens by
//                     accident. A client typing ?layout=v2 gets nothing.
//
// Everyone else keeps today's page (v1), unchanged.
// ---------------------------------------------------------------------------

export const LAYOUT_SWITCH = "portal_layout_v2" as const;

export type LayoutReason = "TEST_CLIENT" | "SWITCH_ON" | "STAFF_PREVIEW" | "DEFAULT";

export async function portalLayoutDecision(viewer: PortalViewer, clientName: string | null | undefined, query: { layout?: string | null }): Promise<{ layout: PortalLayout; why: LayoutReason }> {
  if (isTestClientName(clientName ?? viewer.enrollment.clientName)) return { layout: "v2", why: "TEST_CLIENT" };
  // An unreadable switch is an off switch: the page a client has today.
  if (await isAutomationEnabled(LAYOUT_SWITCH).catch(() => false)) return { layout: "v2", why: "SWITCH_ON" };
  if (viewer.actor.kind === "STAFF" && query.layout === "v2") return { layout: "v2", why: "STAFF_PREVIEW" };
  return { layout: "v1", why: "DEFAULT" };
}

export async function portalLayoutFor(viewer: PortalViewer, clientName: string | null | undefined, query: { layout?: string | null }): Promise<PortalLayout> {
  return (await portalLayoutDecision(viewer, clientName, query)).layout;
}

// ---- the whole library, for review-first + search ------------------------------

/** Enough for any library on file (the largest is a few hundred rows). */
const LIBRARY_PAGE = 60;
const LIBRARY_MAX_PAGES = 25;

/**
 * Every row of the client's library, in portalVideoList's order, with the
 * state its one derivation gives each row. The v2 Library searches, filters
 * and pulls "needs your review" to the top over the WHOLE list — the v1 list
 * paged first, so a video waiting on page two was never surfaced. Read through
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
