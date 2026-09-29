import "server-only";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { isSyntheticClientRow } from "@/lib/testClients";
import { portalVideoList, type VideoListRow } from "@/lib/contentVideos";
import type { PortalViewer } from "@/lib/portal";
import type { PortalLayout } from "@/lib/portalNav";

// ---------------------------------------------------------------------------
// WHICH LAYOUT A PORTAL VISIT GETS (UI-01, Sep 24 2026; R04, Sep 28 2026).
//
// The new navigation is CLIENT-FACING, so it ships dark: a missing
// `portal_layout_v2` row is OFF (programAutomation's one rule), and nobody
// seeds it. Four ways in, checked in this order:
//
//   · TEST_CLIENT   — a synthetic client (testClients.isSyntheticClientRow: a
//                     TEST name AND an id that is not a real row renamed
//                     TEST) always gets v2, so the new pages are exercised on
//                     the TEST account long before a real client sees them;
//   · PILOT         — the switch is on AND the rollout scope admits this
//                     client for portal_layout_v2 as a named pilot client;
//   · SWITCH_ON     — the switch is on AND the rollout is set to every client;
//   · STAFF_PREVIEW — staff looking through the owner iframe add ?layout=v2.
//                     A staff preview otherwise shows what the CLIENT sees,
//                     so staff and client never look at different screens by
//                     accident. A client typing ?layout=v2 gets nothing.
//
// Everyone else keeps today's page (v1), unchanged.
//
// WHY THE SCOPE (R04, Sep 28 2026). The switch alone used to mean EVERY
// client, and the only other way in was a TEST name — so a pilot could only
// be run by renaming a real agent TEST, which the review rightly refused. The
// decision now reads the same rollout every other client-reaching feature
// reads (programRollout.programReach, op portal_layout_v2), so Stage C is
// "the switch on + the rollout set to a pilot with the layout ticked" and
// Stage D is "the rollout set to every client". It is keyed on the CLIENT,
// never on who is looking, so the shared link and a signed-in person see the
// same layout; taking a client out of the pilot gives them v1 on their next
// page load, and their old v2 addresses still land (portalNav.resolvePortalRoute
// maps v2 keys to v1 tabs). The TEST check is by id as well as name now: a
// real client's row renamed "… TEST" no longer gets the new layout.
//
// Navigation follows from this one decision (PortalPage builds every link
// from it). No portal server action or /api/portal route branches on layout:
// they authorise through resolvePortalViewer + can(), whose signed-in branch
// is filtered by the same rollout (portal.liveMemberships, op portal_sign_in).
// The one layout-dependent server read, callBooking.portalBookingLinks, is
// handed this decision's layout by the page; the booking write it leads to is
// authorised separately (callBookingScope, the program pilot's bookings).
//
// FAIL CLOSED: an unreadable switch is off and an unreadable scope refuses
// (programReach never throws — scope_unreadable), so a failure is v1, the
// page the client has today.
// ---------------------------------------------------------------------------

export const LAYOUT_SWITCH = "portal_layout_v2" as const;

export type LayoutReason = "TEST_CLIENT" | "SWITCH_ON" | "PILOT" | "STAFF_PREVIEW" | "DEFAULT";

/**
 * The part of the decision that does not depend on who is looking: what this
 * CLIENT gets. PortalPage (through portalLayoutDecision) and the Settings
 * audience preview both read it, so they cannot disagree.
 */
export async function layoutForClient(client: { id: string; name: string | null }): Promise<{ layout: PortalLayout; why: LayoutReason }> {
  if (isSyntheticClientRow({ id: client.id, name: client.name })) return { layout: "v2", why: "TEST_CLIENT" };
  // An unreadable switch is an off switch: the page a client has today.
  if (!(await isAutomationEnabled(LAYOUT_SWITCH).catch(() => false))) return { layout: "v1", why: "DEFAULT" };
  const { programReach } = await import("@/lib/programRollout");
  const d = await programReach("portal_layout_v2", client.id);
  if (!d.ok) return { layout: "v1", why: "DEFAULT" };
  return { layout: "v2", why: d.tier === "PILOT" ? "PILOT" : "SWITCH_ON" };
}

export async function portalLayoutDecision(viewer: PortalViewer, clientName: string | null | undefined, query: { layout?: string | null }): Promise<{ layout: PortalLayout; why: LayoutReason }> {
  const forClient = await layoutForClient({ id: viewer.enrollment.clientId, name: clientName ?? viewer.enrollment.clientName ?? null });
  if (forClient.layout === "v2") return forClient;
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
