// ---------------------------------------------------------------------------
// ONE VIDEO'S TIMELINE, AT THE TOP OF ITS BRIEF (Jordan, Oct 27 2026: "I do
// wish we still had that timeline here. So, a timeline of shot, in-editing,
// in-review, in-revision, in-review, delivered").
//
// The brief had a stage row until Oct 15 2026 (EditTracker's StageDots, moved
// into the folded History by the brief audit, bb7cb21a). That row drew the
// job's stage on a fixed ladder. This one is the selected video's OWN history,
// read from hard state: when it was shot, the editor's first Start, every
// version sent for review and every time one came back, and the delivery. A
// video that went round twice shows both rounds, so the strip says how it
// actually went, and the step it is on now is marked.
//
// Pure and client-safe: the page passes in what it has already read.
// ---------------------------------------------------------------------------

export type TimelineStepKey = "shot" | "editing" | "review" | "revision" | "delivered";
export type TimelineStep = {
  key: TimelineStepKey;
  label: string;
  /** when the step began (null = reached, time not recorded, or not reached yet) */
  atISO: string | null;
  state: "done" | "current" | "next";
};

export type TimelineRound = {
  round: number;
  status: string;
  createdAt: Date | string;
  decidedAt?: Date | string | null;
  /** a client's send-back on an APPROVED version (Sep 28, gap 1) */
  clientRequestedAt?: Date | string | null;
};

const LABEL: Record<TimelineStepKey, string> = {
  shot: "Shot",
  editing: "In editing",
  review: "In review",
  revision: "In revision",
  delivered: "Delivered",
};

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const ms = (d: Date | string | null | undefined): number | null => {
  const s = iso(d);
  return s ? new Date(s).getTime() : null;
};

/** Rounds that were never a version in front of a reviewer (an upload that
 *  failed or was taken back, or one replaced before anyone looked). */
const NOT_A_ROUND = new Set(["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN", "SUPERSEDED"]);

export function videoTimeline(input: {
  /** when it was filmed (null = not filmed yet, or not recorded) */
  shotAt?: Date | string | null;
  /** the editor's first Start on it */
  startedAt?: Date | string | null;
  /** being edited with no Start on record (an outside shop never presses Start) */
  inEditing?: boolean;
  /** this video's versions, any order */
  rounds: TimelineRound[];
  /** when it reached the client */
  deliveredAt?: Date | string | null;
  /** an ask is open on it with no newer version in yet (a client's change after approval, an office reopen) */
  reopenedAt?: Date | string | null;
  now?: Date;
}): TimelineStep[] {
  const now = (input.now ?? new Date()).getTime();
  const reached: { key: TimelineStepKey; atISO: string | null; label?: string }[] = [];
  const shotMs = ms(input.shotAt);
  const rounds = input.rounds
    .filter((r) => !NOT_A_ROUND.has(r.status))
    .sort((a, b) => a.round - b.round || (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0));
  const started = !!input.startedAt || rounds.length > 0 || !!input.inEditing;
  if ((shotMs !== null && shotMs <= now) || started) reached.push({ key: "shot", atISO: shotMs !== null && shotMs <= now ? iso(input.shotAt) : null });
  if (started) reached.push({ key: "editing", atISO: iso(input.startedAt) });
  let approved = false;
  for (const r of rounds) {
    approved = false;
    reached.push({ key: "review", atISO: iso(r.createdAt) });
    if (r.status === "CHANGES_REQUESTED") reached.push({ key: "revision", atISO: iso(r.decidedAt) });
    else if (r.status === "APPROVED") {
      reached[reached.length - 1].label = "Approved";
      approved = true;
      // Approved, then the client asked again about this video.
      const asked = ms(r.clientRequestedAt);
      const decided = ms(r.decidedAt);
      if (asked !== null && (decided === null || asked > decided)) {
        reached.push({ key: "revision", atISO: iso(r.clientRequestedAt) });
        approved = false;
      }
    }
  }
  const deliveredMs = ms(input.deliveredAt);
  const lastApproval = rounds.length ? ms(rounds[rounds.length - 1].decidedAt) : null;
  const delivered = approved && deliveredMs !== null && (lastApproval === null || deliveredMs >= lastApproval - 60_000);
  if (delivered) reached.push({ key: "delivered", atISO: iso(input.deliveredAt) });
  // Reopened after approval or delivery, no newer version in yet.
  const reopenMs = ms(input.reopenedAt);
  const lastAt = reached.length ? ms(reached[reached.length - 1].atISO) : null;
  if (reopenMs !== null && (approved || delivered) && (lastAt === null || reopenMs > lastAt)) {
    reached.push({ key: "revision", atISO: iso(input.reopenedAt) });
  }

  const last = reached[reached.length - 1]?.key ?? null;
  const ahead: TimelineStepKey[] =
    last === null ? ["shot", "editing", "review", "delivered"]
    : last === "shot" ? ["editing", "review", "delivered"]
    : last === "editing" ? ["review", "delivered"]
    : last === "revision" ? ["review", "delivered"]
    : last === "review" ? ["delivered"]
    : [];
  const finished = last === "delivered";
  return [
    ...reached.map((s, i): TimelineStep => ({
      key: s.key,
      label: s.label ?? LABEL[s.key],
      atISO: s.atISO,
      state: i === reached.length - 1 && !finished ? "current" : "done",
    })),
    ...ahead.map((k): TimelineStep => ({ key: k, label: LABEL[k], atISO: null, state: "next" })),
  ];
}
