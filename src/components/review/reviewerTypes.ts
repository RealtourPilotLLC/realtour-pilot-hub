// ---------------------------------------------------------------------------
// The shapes the "who is reviewing this cut" strip renders (unified handoff
// §8.1). Plain data, no imports: the server read layer (lib/reviewerAssignment)
// builds them and a client component draws them, and a client file must never
// import a server-only module to learn a type.
// ---------------------------------------------------------------------------

export type ReviewerSlot = "PRIMARY" | "BACKUP" | "FALLBACK";

/** One cut waiting on a verdict, and the ONE person it is waiting on. */
export type ReviewerStripRow = {
  submissionId: string;
  label: string;
  round: number;
  reviewer: { id: string; name: string } | null;
  /** when it became theirs (reviewerAssignedAt), ISO */
  sinceISO: string | null;
  /** PRIMARY | BACKUP | FALLBACK | MANUAL | COVER — how it became theirs */
  role: string | null;
  /** covered hours (Mon–Fri 9–6 ET) it has waited on them */
  coveredHours: number;
  /** the primary has had it past the offer threshold — the backup may cover it */
  coverOffered: boolean;
  /** the viewer is the one it is waiting on */
  mine: boolean;
};

export type ReviewerCandidate = {
  id: string;
  name: string;
  slot: ReviewerSlot | null;
  /** ISO while marked away, else null */
  awayUntil: string | null;
  /** has a login that can press Approve (OWNER/ADMIN, or designated and active) */
  canRule: boolean;
};

export type ReviewerStripData = {
  rows: ReviewerStripRow[];
  /** may the viewer take, cover or hand these on (server re-checks every press) */
  canRule: boolean;
  viewerTeamMemberId: string | null;
  /** who a cut can be handed to — empty for a viewer who cannot rule */
  candidates: ReviewerCandidate[];
  /** the backup's first name, for the "I'll cover it" wording */
  backupName: string | null;
  coverOfferHours: number;
};

/** The Settings card's view of one reviewer seat. */
export type ReviewerSeat = {
  id: string;
  name: string;
  role: string;
  /** an ACTIVE login is linked to this roster row */
  hasLogin: boolean;
  loginRole: string | null;
  /** could press Approve if they held this seat (active login; owner/admin or designated) */
  canRuleIfDesignated: boolean;
  /** their own "video in review" switch: bell only, or which channels */
  reviewReady: { slack: boolean; sms: boolean };
  awayUntil: string | null;
};
