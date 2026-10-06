// ---------------------------------------------------------------------------
// THE "WE'RE STILL MOVING THINGS OVER" NOTICE (Jordan, Oct 6 2026): "add a
// note to the client portal so each of them gets a notice that we are still
// migrating past scripts and videos to the platform and working through any
// remaining bugs or issues. Their feedback is valuable, so please let us know
// if they have any confusion or run into any issues."
//
// Shown on every portal page (PortalShell, under the header), to every client
// and to staff looking through the owner iframe. "Tell us" opens the portal's
// EXISTING conversation with the office (the Messages page, CP-13) with the
// box prefilled "Portal feedback: " so the team can tell what it is — the
// client still writes and sends it themselves; nothing new can send.
// "Got it" hides it for that browser (localStorage, PortalMigrationNotice);
// a small "Report a problem" link stays in the page footer while it is on.
//
// TO RETIRE IT: set `on` to false below. That one line removes the notice and
// the footer link everywhere; nothing is stored server-side. Changing `id`
// shows it again to everyone who dismissed it (a new notice, a new key).
//
// Pure (no server or client imports) so the page, the client component and
// the drill read the same words.
// ---------------------------------------------------------------------------

export const PORTAL_MIGRATION_NOTICE = {
  on: true,
  /** The per-browser "Got it" key. A new id = a new notice everyone sees again. */
  id: "rtp-portal-notice:migration-2026-10",
  title: "Welcome to your new content portal",
  body: "We're still moving your past scripts and videos over and smoothing out a few rough edges. Your feedback really helps — if anything looks off or is confusing, let us know.",
  cta: "Tell us",
  dismiss: "Got it",
  /** The footer link that stays after "Got it". */
  report: "Report a problem",
  /** What the message box starts with, so the office can tell it is portal feedback. */
  prefill: "Portal feedback: ",
} as const;

/** `?about=portal` on the Messages page = open the box prefilled as portal feedback. */
export const PORTAL_FEEDBACK_QUERY = "about=portal";
