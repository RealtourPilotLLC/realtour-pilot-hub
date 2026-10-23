// ---------------------------------------------------------------------------
// RUN TOPAZ AGAIN (Jordan, Oct 23 2026: "I want to be able to re run the
// videos through topaz if the topaz pass doesn't look good.")
//
// One rule, read by the engine (topazJobs.rerunTopazJobRefusal, the word that
// counts) and by the screens that draw the button (readyToSend's rows, Kyle's
// desk, the job page), so a button is never drawn on a video the server would
// refuse. Pure, with no server-only import: the client button imports the
// words from here too.
//
// WHO: the owner and the office (requireAdmin at the action), never the
// creative manager or an editor. WHAT: a video whose Topaz file is finished
// (done and filed, or held for a listen) and has NOT reached the client: not
// sent through Aryeo, not published to the portal, not on the Aryeo listing
// or on its way there. The same cut goes back through the pass with the
// CURRENT Settings, on the same TopazJob row (one render per cut), from the
// free price check, so every limit and cap applies. The previous render is
// moved to superseded/ and kept on the record; the new one becomes the file
// to send only once it is finished and checked. There are no per-video
// settings: Settings is where the settings live, and re-running is the
// per-video action.
// ---------------------------------------------------------------------------

/** The button. */
export const RERUN_LABEL = "Run Topaz again";
/** The second press (it spends credits, so it asks first). */
export const RERUN_CONFIRM = "Yes, run it again";

/** Every refusal, in the words the screen shows. */
export const RERUN_SAYS = {
  running: "The Topaz pass is already running on this video.",
  notFinished: "Only a finished Topaz file can be run again. Use Try again on this one.",
  notFiled: "This Topaz file isn't filed yet, so there's nothing to run again.",
  reopened: "This version was reopened for revisions, so its Topaz file isn't the one to send. The next approved version gets its own pass.",
  replaced: "A newer version replaced this one, so its Topaz file isn't the one to send.",
  sent: "This video was already sent to the client, so it can't be run through Topaz again.",
  published: "This video is already in the client's portal, so it can't be run through Topaz again.",
  onListing: "This Topaz file is already on the Aryeo listing, so it can't be run again.",
  goingUp: "This video is on its way to Aryeo right now, so it can't be run through Topaz again.",
} as const;

/** What a run of "Upload to Aryeo and send" tells this rule (videoAryeoPush's record, read as data). */
export type RerunPushFacts = {
  state: string;
  addSentAt?: string | null;
  mediaId?: string | null;
  hold?: { resume?: string | null } | null;
} | null;

export type RerunFacts = {
  /** the TopazJob's state */
  state: string;
  finalPath: string | null;
  savedAt: Date | string | null;
  heldPath: string | null;
  /** the job's own delivered stamp (Aryeo, the portal, a Dropbox link) */
  deliveredAt: Date | string | null;
  /** the cut's status (APPROVED for a video still to send) */
  cutStatus: string | null;
  /** the cut's own sent stamp: Aryeo delivered, or published to the portal */
  sentToClientAt: Date | string | null;
  /** a monthly program video (its "sent" is the portal) */
  monthly: boolean;
  /** a person or the listing check recorded THIS file on the Aryeo listing */
  onListing: boolean;
  push: RerunPushFacts;
};

const LIVE = ["queued", "estimated", "uploading", "processing", "saving"];

/** Why "Run Topaz again" is refused for this video, or null when it may run. */
export function rerunRefusal(f: RerunFacts): string | null {
  if (LIVE.includes(f.state)) return RERUN_SAYS.running;
  if (f.state !== "done" && f.state !== "held") return RERUN_SAYS.notFinished;
  if (f.state === "done" && (!f.finalPath || !f.savedAt)) return RERUN_SAYS.notFiled;
  if (f.state === "held" && !f.heldPath && !f.finalPath) return RERUN_SAYS.notFiled;
  if (f.deliveredAt || f.sentToClientAt) return f.monthly ? RERUN_SAYS.published : RERUN_SAYS.sent;
  if (f.cutStatus && f.cutStatus !== "APPROVED") return RERUN_SAYS.reopened;
  // A later round's file took its place (supersedePriorEnhanced moved it).
  if (f.state === "done" && f.finalPath?.includes("/superseded/")) return RERUN_SAYS.replaced;
  if (f.onListing) return RERUN_SAYS.onListing;
  const p = f.push;
  if (p && p.state !== "SHADOW") {
    if (p.state === "DONE") return RERUN_SAYS.sent;
    // Something reached the listing (or the add went to Aryeo): that file is
    // the old render, and swapping it underneath would leave the two apart.
    if (p.addSentAt || p.mediaId) return RERUN_SAYS.onListing;
    // A run that stopped before anything went up starts again from its own
    // first step (PREPARING reads the file fresh), so it is no reason to wait.
    const parked = p.state === "FAILED" || (p.state === "HELD" && (p.hold?.resume ?? "PREPARING") === "PREPARING");
    if (!parked) return RERUN_SAYS.goingUp;
  }
  return null;
}

/** What the button carries: the job and the credits it should cost with
 *  today's Settings (null = not known until the free price check). */
export type RerunOffer = { jobId: string; credits: number | null; limit: number | null };

/** The line under the button once it asks: the cost before anything is spent. */
export function rerunCostLine(o: Pick<RerunOffer, "credits" | "limit">): string {
  const keep = "The current Topaz file is kept in Dropbox (superseded/), and nothing goes to the client until the new one is finished and checked.";
  if (o.credits == null) return `It starts with the free price check, so every limit in Settings applies. ${keep}`;
  const n = Math.max(1, Math.round(o.credits));
  if (o.limit != null && n > o.limit) {
    return `About ${n} credits with today's Settings, which is over the ${o.limit}-credit limit per video, so the free price check will stop it. ${keep}`;
  }
  return `About ${n} credits with today's Settings. It starts with the free price check, so every limit in Settings still applies. ${keep}`;
}
