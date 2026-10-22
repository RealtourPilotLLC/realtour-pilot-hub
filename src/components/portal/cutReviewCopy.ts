// ---------------------------------------------------------------------------
// THE WORDS ON A VIDEO'S APPROVE AND NOTE CONTROLS (Oct 22 2026). Pure, so the
// drill can read every string either viewer could ever be shown.
//
// Jordan: "When I view his portal it says record the client's approval. I
// don't want them to see that so make sure it just says approve for them."
// A client (signed in or on the shared link) only ever gets the client words.
// The on-behalf words exist only when `actingFor` is a name, and CutReview
// passes one only for STAFF through the owner iframe (never for a link
// visitor), from a server prop that is set for a STAFF actor alone.
// ---------------------------------------------------------------------------

export type ApprovalCopy = {
  /** The button that opens the approval. */
  button: string;
  /** The question at the top of the open approval. */
  title: string;
  /** Staff only: the one small line saying they act for the client. */
  onBehalf: string | null;
  /** What approving does. */
  body: string;
  /** The button that approves. */
  confirm: string;
};

export function approvalCopy(version: number, actingFor: string | null): ApprovalCopy {
  if (!actingFor) {
    return {
      button: "Approve this version",
      title: `Approve version ${version} as final?`,
      onBehalf: null,
      body: "This records your approval of exactly this version. If a newer version ever replaces it, that one will need its own approval.",
      confirm: "Yes, approve",
    };
  }
  return {
    button: `Approve for ${actingFor}`,
    title: `Approve version ${version} for ${actingFor}?`,
    onBehalf: `You're approving on ${actingFor}'s behalf.`,
    body: "Use this only when they approved outside the portal, by text, call or email. It's saved in your name with your note, in the audit log and on the job's timeline.",
    confirm: `Approve for ${actingFor}`,
  };
}

/** Phrases only the on-behalf copy may contain (the drill's blocklist for a
 *  client's page). */
export const STAFF_ONLY_PHRASES = ["Approve for ", "behalf", "Record the client", "Record approval", "How and when did they approve"] as const;

/** The note box's words. One place, so the page, the warning and the drill agree. */
export const NOTE_COPY = {
  send: "Send note",
  unsentWarning: "You have a note you haven't sent.",
  unsentHint: "Not sent yet. Press Send note so we get it.",
  restored: "You have a note you haven't sent. We kept it on this device.",
  leaveConfirm: "You have a note you haven't sent. Leave this page anyway? We'll keep it on this device for when you come back.",
  sendIt: "Send note",
  discardIt: "Discard it",
} as const;

/** A client's first name for "Approve for Mike". A team or company name
 *  ("The Smith Team") is used whole rather than cut to "The". */
export function clientFirstName(name: string | null | undefined): string {
  const n = (name ?? "").trim().replace(/\s+TEST$/i, "").trim();
  if (!n) return "the client";
  const first = n.split(/\s+/)[0];
  return /^(the|team)$/i.test(first) || /&|\band\b/i.test(n) ? n : first;
}

/** Where a note's draft waits on this device until it is sent (per cut). */
export const noteDraftKey = (submissionId: string) => `rtp_portal_note:${submissionId}`;
