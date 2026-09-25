import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting, reviewRoomRules } from "@/lib/settings";
import { firstName, slugForName } from "@/lib/assignees";
import type { NotifyTarget, Role } from "@/lib/notify";
import type {
  ReviewerCandidate,
  ReviewerSeat,
  ReviewerSlot,
  ReviewerStripData,
  ReviewerStripRow,
} from "@/components/review/reviewerTypes";

// ---------------------------------------------------------------------------
// ONE RESPONSIBLE REVIEWER PER CUT (unified handoff §8.1, Sep 25 2026).
//
// Jordan's settled rule (§3): "James, Creative Manager, owns routine internal
// video review. Kyle is first backup; Jordan is final fallback. One active
// owner, not three serial approvals." And: "Receiving a notification is not
// evidence a person accepted or completed the review. Keep queue state
// authoritative."
//
// What was there before this file: a NAME on the exceptions board
// (review_room.creativeApproverTeamMemberId, R08) and nothing else. Every cut
// went to every OWNER/ADMIN at once, so it was nobody's; the notification
// bridge skipped James entirely because his roster role is PHOTOGRAPHER
// (smsPrefs.officeTeamMemberIds); and the only authority to rule was the broad
// ADMIN role, which Kyle's own login lost once in August.
//
// So, four things, and the ROW is the referee for all of them:
//   · WHO — ReviewSubmission.reviewerTeamMemberId, set ONCE as the cut enters
//     review (ensureCutReviewer, called by the one announcer every door into
//     the Room goes through) and changed only by a compare-and-set that
//     writes a CutReviewerEvent in the same transaction. Two presses, two
//     lambdas, a sweep and a button can race; one of them wins and one event
//     is written.
//   · MAY THEY — canRuleOnCuts: owner and admin exactly as before, PLUS the
//     three named seats with an active login. Never the creative-manager flag
//     (it also sets a shoot-bonus basis — BonusTab), never "view as".
//   · WHO HEARS — the assignee gets "waiting on you", Jordan an oversight copy,
//     the rest of the chain an FYI; each on their OWN saved "video in review"
//     switch (review_ready). A bell row changes nothing about the cut.
//   · WHEN IT MOVES — only when a person moves it (take, cover, hand on, or
//     mark themselves away). The offer to Kyle after nine covered hours moves
//     nothing. The automatic move after N covered hours exists and is OFF
//     (review_room.coverTransferHours = null).
//
// Jordan, Sep 25 2026, in his words: "I want everyone Kyle, Me, and James to
// see the cuts. James role is to approve them or request revisions, Same with
// Kyle, but James first, then Kyle if James hasn't gotten to it. I also want
// to be able to approve cuts whenever I want and I want to be kept in the
// loop." So the name on the row says whose FIRST it is, never who may act:
// all three are rung, all three see every cut in the Room, and Kyle or Jordan
// rule directly — no "take it" first (recordRulingReviewer writes the cover).
// ---------------------------------------------------------------------------

export type ReviewerReason =
  | "SUBMITTED" // the cut entered review and the chain named its reviewer
  | "CLAIM" // a person took it ("I'll take it")
  | "COVER" // the backup took it, or somebody ruled on a cut that was not theirs
  | "MANUAL" // handed to a named person
  | "AWAY_TRANSFER" // its reviewer was marked away
  | "MOVED" // the cut itself moved jobs (kept for the move path)
  | "AUTO_TRANSFER"; // the covered-hours rule, only while it is switched on

const REASON_WORDS: Record<ReviewerReason, string> = {
  SUBMITTED: "assigned as it entered review",
  CLAIM: "taken",
  COVER: "covered",
  MANUAL: "handed on",
  AWAY_TRANSFER: "its reviewer is away",
  MOVED: "moved with the cut",
  AUTO_TRANSFER: "waited past the covered-hours rule",
};

/** Every login role, so a person-addressed row stays visible whatever their
 *  AppUser role is on the day (the creativeAlertTargets precedent, tasks.ts). */
const ANY_ROLE: Role[] = ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"];

export type Reviewer = {
  teamMemberId: string;
  name: string;
  slot: ReviewerSlot;
  appUserId: string | null;
  loginRole: string | null;
  /** active roster row + an ACTIVE login: the seat can actually press Approve */
  canRule: boolean;
  /** set while they are marked away */
  awayUntil: Date | null;
  isOwner: boolean;
};

export type ReviewerChain = {
  /** at least one seat is named — otherwise the Room runs exactly as before */
  configured: boolean;
  members: Reviewer[];
  primary: Reviewer | null;
  backup: Reviewer | null;
  fallback: Reviewer | null;
};

// ---- away -------------------------------------------------------------------

/** One AppSetting per person rather than a map inside review_room: the
 *  Settings card saves review_room WHOLE, so a stale tab would quietly undo
 *  somebody's "I'm away" — a per-person key cannot be overwritten that way. */
export const awayKey = (teamMemberId: string) => `review-away:${teamMemberId}`;
type AwayRow = { until: string | null; setBy: string | null; setAt: string | null };

export async function awayUntilOf(teamMemberId: string, at: Date = new Date()): Promise<Date | null> {
  const r = await getSetting<AwayRow>(awayKey(teamMemberId), { until: null, setBy: null, setAt: null });
  const until = r.until ? new Date(r.until) : null;
  return until && !Number.isNaN(until.getTime()) && until > at ? until : null;
}

// ---- the chain ----------------------------------------------------------------

export async function reviewerChain(at: Date = new Date()): Promise<ReviewerChain> {
  const rules = await reviewRoomRules();
  const seats: [ReviewerSlot, string | null][] = [
    ["PRIMARY", rules.creativeApproverTeamMemberId],
    ["BACKUP", rules.backupReviewerTeamMemberId],
    ["FALLBACK", rules.fallbackReviewerTeamMemberId],
  ];
  const named = seats.filter((s): s is [ReviewerSlot, string] => !!s[1]);
  const empty: ReviewerChain = { configured: false, members: [], primary: null, backup: null, fallback: null };
  if (named.length === 0) return empty;
  const ids = [...new Set(named.map(([, id]) => id))];
  const [tms, logins] = await Promise.all([
    prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true } }),
    prisma.appUser.findMany({
      where: { teamMemberId: { in: ids }, status: "ACTIVE" },
      select: { id: true, role: true, teamMemberId: true },
    }),
  ]);
  const rank = (role: string) => (role === "OWNER" ? 0 : role === "ADMIN" ? 1 : 2);
  const members: Reviewer[] = [];
  const seen = new Set<string>();
  for (const [slot, id] of named) {
    // One person in two seats holds the first one; the chain never lists them twice.
    if (seen.has(id)) continue;
    seen.add(id);
    const tm = tms.find((t) => t.id === id);
    if (!tm) continue; // a seat pointing at a deleted row is an empty seat
    const login = logins.filter((l) => l.teamMemberId === id).sort((a, b) => rank(a.role) - rank(b.role))[0] ?? null;
    members.push({
      teamMemberId: id,
      name: tm.name,
      slot,
      appUserId: login?.id ?? null,
      loginRole: login?.role ?? null,
      // An editor-only login can't rule (canRuleOnCuts), so a seat holding one
      // is skipped — the cut goes to the next seat, never to someone who can't act.
      canRule: tm.active && !!login && !SEAT_REFUSED_ROLES.has(login.role),
      awayUntil: await awayUntilOf(id, at),
      isOwner: login?.role === "OWNER",
    });
  }
  return {
    configured: members.length > 0,
    members,
    primary: members.find((m) => m.slot === "PRIMARY") ?? null,
    backup: members.find((m) => m.slot === "BACKUP") ?? null,
    fallback: members.find((m) => m.slot === "FALLBACK") ?? null,
  };
}

const present = (m: Reviewer) => m.canRule && !m.awayUntil;

/** The first seat, in order, that can act and is not away. Null = nobody:
 *  the cut stays unassigned, rings the office the old way and reads "the
 *  office" everywhere, so an empty chain is visible rather than silent. */
export async function resolveActiveReviewer(at: Date = new Date()): Promise<Reviewer | null> {
  const chain = await reviewerChain(at);
  return chain.members.find(present) ?? null;
}

// ---- authority ------------------------------------------------------------------

type AuthorityInput = {
  realRole: string;
  impersonating: boolean;
  teamMemberId: string | null;
  status?: string;
} | null | undefined;

export type RuleAuthority =
  | { ok: true; as: "OWNER" | "ADMIN" | "REVIEWER"; teamMemberId: string | null }
  | { ok: false; why: string };

/**
 * MAY THIS LOGIN RULE ON A CUT? The one answer for every verdict-shaped write
 * (approve, send back, reopen/resolve a note, office notes, take, hand on).
 *
 *   · owner / admin — exactly as before. §4 preserves existing authority; this
 *     never narrows anybody.
 *   · one of the three named review seats, with an active login — the scoped
 *     grant, so James's approval does not hang on the broad ADMIN role.
 *   · never "view as": a previewing owner is refused, as by every guard.
 *   · never TeamMember.creativeManager. That flag is a shoot-bonus basis and a
 *     chase-copy list; flipping it must not grant anything, and the drill
 *     proves it does not.
 */
export async function canRuleOnCuts(me: AuthorityInput): Promise<RuleAuthority> {
  if (!me) return { ok: false, why: "Please sign in to do that." };
  if (me.impersonating) return { ok: false, why: "You're previewing another user — exit the preview to make changes." };
  if (me.status && me.status !== "ACTIVE") return { ok: false, why: "You don't have access to do that." };
  if (me.realRole === "OWNER" || me.realRole === "ADMIN") {
    return { ok: true, as: me.realRole, teamMemberId: me.teamMemberId };
  }
  // An EDITOR login never holds the desk, seated or not (review fix, Sep 25):
  // a seat would let an editor approve their own cut and classify their own
  // issues. The seat is for a reviewer on a narrower login (James), not a way
  // to make an editor their own reviewer.
  if (me.teamMemberId && !SEAT_REFUSED_ROLES.has(me.realRole)) {
    const rules = await reviewRoomRules();
    const seats = [rules.creativeApproverTeamMemberId, rules.backupReviewerTeamMemberId, rules.fallbackReviewerTeamMemberId];
    if (seats.includes(me.teamMemberId)) {
      const tm = await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { active: true } });
      if (tm?.active) return { ok: true, as: "REVIEWER", teamMemberId: me.teamMemberId };
    }
  }
  return { ok: false, why: "You don't have access to do that." };
}

/** IS THIS VIEWER THE REVIEW DESK? The one question both Review Room pages ask
 *  before drawing the desk — the same answer approveCut and requestCutChanges
 *  give (canRuleOnCuts), so a seat on a narrower login (James as PHOTOGRAPHER)
 *  gets the desk where the server will accept the press, and nobody gets
 *  buttons the server refuses (review fix, Sep 25). No session: the desk only
 *  when auth is off (local dev), like every guard. */
export async function isReviewDesk(me: AuthorityInput, opts: { authEnforced: boolean }): Promise<boolean> {
  if (!me) return !opts.authEnforced;
  return (await canRuleOnCuts(me)).ok;
}

/** Logins that can never hold a review seat: an editor ruling on cuts would be
 *  ruling on their own work (§8.1 "keep authorization scoped"). */
export const SEAT_REFUSED_ROLES: ReadonlySet<string> = new Set(["EDITOR"]);

/**
 * A SEAT CHANGE, VALIDATED ON THE SERVER (review fix, Sep 25). Saving the
 * review_room rules is an owner/admin write, and it used to store whatever ids
 * arrived: an ADMIN could seat an editor — who could then approve their own
 * cut — which until this batch only the owner could grant (an ADMIN role on
 * the owner-only Logins tab). Now:
 *   · every named seat is an active roster row;
 *   · no seat whose logins are all EDITOR (or who has only an editor login);
 *   · seating someone whose best login is NOT owner/admin is the owner's call —
 *     it is a grant of approval power, the same as handing out ADMIN. An admin
 *     may still reorder or clear seats and seat any owner/admin.
 * Seats that did not change are not re-judged, so a save that only edits the
 * hours never trips over an existing seat.
 */
export async function validateReviewSeats(
  prev: { creativeApproverTeamMemberId: string | null; backupReviewerTeamMemberId: string | null; fallbackReviewerTeamMemberId: string | null },
  next: { creativeApproverTeamMemberId?: string | null; backupReviewerTeamMemberId?: string | null; fallbackReviewerTeamMemberId?: string | null },
  actorRole: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const keys = ["creativeApproverTeamMemberId", "backupReviewerTeamMemberId", "fallbackReviewerTeamMemberId"] as const;
  const before = new Set(keys.map((k) => prev[k]).filter((x): x is string => !!x));
  for (const k of keys) {
    const id = next[k];
    if (id == null || id === "") continue;
    if (typeof id !== "string") return { ok: false, message: "That seat isn't a person — reload and pick again." };
    const tm = await prisma.teamMember.findFirst({ where: { id, active: true }, select: { id: true, name: true } });
    if (!tm) return { ok: false, message: "That person isn't on the roster any more — reload and pick again." };
    if (before.has(id)) continue;
    const logins = await prisma.appUser.findMany({ where: { teamMemberId: id, status: "ACTIVE" }, select: { role: true } });
    const office = logins.some((l) => l.role === "OWNER" || l.role === "ADMIN");
    if (office) continue;
    if (logins.some((l) => SEAT_REFUSED_ROLES.has(l.role))) {
      return { ok: false, message: `${tm.name} signs in as an editor — an editor can't review cuts (they'd be ruling on their own work).` };
    }
    // actorRole null = sessionless local dev, which every guard lets through.
    if (actorRole !== null && actorRole !== "OWNER") {
      return { ok: false, message: `Seating ${tm.name} gives them the power to approve cuts — only Jordan can grant that.` };
    }
  }
  return { ok: true };
}

/**
 * NOBODY RULES ON THEIR OWN WORK (review fix, Sep 25). The verdict and the
 * cause classification both go through here: when the signed-in person IS the
 * editor who made the version (their editor key is its author), the answer is
 * a refusal in words. Owner and admin included — the check is about the work,
 * not the role. Null = go ahead. Sessionless local dev has no identity to
 * compare and goes ahead, like every guard.
 */
export function refuseOwnWork(
  me: { editorKey: string | null; realRole: string; name: string | null; impersonating: boolean } | null | undefined,
  authorEditorKey: string | null | undefined,
  what: "cut" | "issue",
): string | null {
  if (!authorEditorKey || !me || me.impersonating) return null;
  const mine = me.editorKey ?? (me.realRole === "EDITOR" && me.name ? slugForName(me.name) : null);
  if (!mine || mine !== authorEditorKey) return null;
  return what === "cut"
    ? "This is your own version — somebody else rules on it."
    : "This is on your own version — the reviewer classifies it.";
}

/** Could this roster row hold a cut? Owner/admin with an active login, or a
 *  named seat with any active login. What "hand it to" may choose from. */
export async function eligibleReviewer(teamMemberId: string): Promise<{ id: string; name: string } | null> {
  const tm = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { id: true, name: true, active: true } });
  if (!tm?.active) return null;
  const logins = await prisma.appUser.findMany({ where: { teamMemberId, status: "ACTIVE" }, select: { role: true } });
  if (logins.length === 0) return null;
  if (logins.some((l) => l.role === "OWNER" || l.role === "ADMIN")) return { id: tm.id, name: tm.name };
  if (logins.every((l) => SEAT_REFUSED_ROLES.has(l.role))) return null;
  const chain = await reviewerChain();
  return chain.members.some((m) => m.teamMemberId === teamMemberId) ? { id: tm.id, name: tm.name } : null;
}

// ---- the write ------------------------------------------------------------------

export type AssignResult =
  | { ok: true; changed: boolean; eventId: string | null; from: string | null; to: string }
  | { ok: false; message: string; current: string | null };

async function nameOf(teamMemberId: string | null): Promise<string | null> {
  if (!teamMemberId) return null;
  const tm = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true } }).catch(() => null);
  return tm?.name ?? null;
}

/** How the seat was taken, in ReviewSubmission.reviewerRole's words. */
async function roleFor(to: string, reason: ReviewerReason): Promise<string> {
  if (reason === "CLAIM" || reason === "MANUAL") return "MANUAL";
  if (reason === "COVER") return "COVER";
  const chain = await reviewerChain();
  return chain.members.find((m) => m.teamMemberId === to)?.slot ?? "MANUAL";
}

/**
 * Give a cut to ONE person, recording why. Compare-and-set on the reviewer
 * the caller read (expectFrom; read now when omitted): the update and its
 * CutReviewerEvent commit together or not at all, so two overlapping presses
 * leave one owner and one event, and the loser is told who has it.
 * Idempotent: giving a cut to the person who already holds it writes nothing.
 * `requirePending` (default) refuses a cut that already has a verdict — the
 * ruling-cover path passes false, because it records who ruled AFTER the
 * verdict's own compare-and-set has moved the status.
 */
export async function assignCutReviewer(
  submissionId: string,
  opts: {
    reason: ReviewerReason;
    toTeamMemberId: string;
    expectFrom?: string | null;
    actor: { name: string; userId?: string | null };
    note?: string | null;
    requirePending?: boolean;
    role?: string;
    at?: Date;
  },
): Promise<AssignResult> {
  const requirePending = opts.requirePending !== false;
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, projectId: true, round: true, status: true, reviewerTeamMemberId: true, selfCheckId: true, selfCheckedAt: true },
  });
  if (!sub) return { ok: false, message: "That cut no longer exists.", current: null };
  if (requirePending && sub.status !== "PENDING") {
    return { ok: false, message: "That version isn't waiting on a verdict any more — reload to see where it stands.", current: sub.reviewerTeamMemberId };
  }
  if (requirePending && sub.selfCheckId && !sub.selfCheckedAt) {
    return { ok: false, message: "That cut is still waiting on the editor's check — it gets its reviewer when it enters review.", current: sub.reviewerTeamMemberId };
  }
  const from = opts.expectFrom !== undefined ? opts.expectFrom : sub.reviewerTeamMemberId;
  const to = opts.toTeamMemberId;
  if (sub.reviewerTeamMemberId !== from) {
    return {
      ok: false,
      message: "Someone else changed who is reviewing this cut a moment ago — reload and try again.",
      current: sub.reviewerTeamMemberId,
    };
  }
  if (from === to) return { ok: true, changed: false, eventId: null, from, to };
  const role = opts.role ?? (await roleFor(to, opts.reason));
  const at = opts.at ?? new Date();
  const note = opts.note ? opts.note.trim().slice(0, 500) || null : null;
  const eventId = await prisma.$transaction(async (tx) => {
    const won = await tx.reviewSubmission.updateMany({
      where: { id: submissionId, reviewerTeamMemberId: from, ...(requirePending ? { status: "PENDING" } : {}) },
      data: { reviewerTeamMemberId: to, reviewerAssignedAt: at, reviewerAssignedBy: opts.actor.name.slice(0, 120), reviewerRole: role },
    });
    if (won.count === 0) return null;
    const ev = await tx.cutReviewerEvent.create({
      data: {
        submissionId,
        projectId: sub.projectId,
        fromTeamMemberId: from,
        toTeamMemberId: to,
        reason: opts.reason,
        actorName: opts.actor.name.slice(0, 120),
        actorUserId: opts.actor.userId ?? null,
        note,
        at,
      },
      select: { id: true },
    });
    return ev.id;
  });
  if (!eventId) {
    const now = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { reviewerTeamMemberId: true } });
    return {
      ok: false,
      message: "Someone else changed who is reviewing this cut a moment ago — reload and try again.",
      current: now?.reviewerTeamMemberId ?? null,
    };
  }
  // The job's timeline says it in words. Best-effort: the row and its event
  // are the record; a missing Activity line never undoes an assignment.
  const [toName, fromName] = await Promise.all([nameOf(to), nameOf(from)]);
  await prisma.activity
    .create({
      data: {
        projectId: sub.projectId,
        type: "SYSTEM",
        body: `Reviewer for version ${sub.round}: ${toName ?? "someone"}${fromName ? ` (was ${fromName})` : ""} — ${REASON_WORDS[opts.reason]}${
          opts.reason === "SUBMITTED" ? "" : ` by ${opts.actor.name}`
        }${note ? `: ${note}` : ""}.`,
      },
    })
    .catch(() => {});
  return { ok: true, changed: true, eventId, from, to };
}

/**
 * The cut's reviewer, assigning one if it has none. Called at the ONE moment a
 * cut enters review — inside announceCutInReview, which every door (upload,
 * Final-folder submit, sweep, move) goes through, and which a self-check hold
 * keeps closed until the editor's check is done. A cut that already has a
 * reviewer keeps them; a second announce of the same cut is a no-op; two
 * racing announces write one event (the loser reads the winner back).
 * Null = no chain configured, or nobody present: the office, the old way.
 */
export async function ensureCutReviewer(
  submissionId: string,
  opts: { at?: Date; actorName?: string } = {},
): Promise<{ teamMemberId: string; name: string } | null> {
  const at = opts.at ?? new Date();
  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: submissionId },
    select: { status: true, reviewerTeamMemberId: true },
  });
  if (!sub) return null;
  if (sub.reviewerTeamMemberId) {
    const name = await nameOf(sub.reviewerTeamMemberId);
    return name ? { teamMemberId: sub.reviewerTeamMemberId, name } : null;
  }
  if (sub.status !== "PENDING") return null;
  const r = await resolveActiveReviewer(at);
  if (!r) return null;
  const res = await assignCutReviewer(submissionId, {
    reason: "SUBMITTED",
    toTeamMemberId: r.teamMemberId,
    expectFrom: null,
    actor: { name: opts.actorName ?? "system" },
    role: r.slot,
    at,
  });
  if (res.ok) return { teamMemberId: r.teamMemberId, name: r.name };
  // Lost the race: whoever won is the answer.
  if (res.current) {
    const name = await nameOf(res.current);
    return name ? { teamMemberId: res.current, name } : null;
  }
  return null;
}

/**
 * WHOEVER RULED IS THE REVIEWER OF RECORD. Kyle approving a cut that was
 * James's is a cover, not a co-approval: the verdict's own compare-and-set has
 * already won (one call, APPROVED or CHANGES_REQUESTED), and this writes the
 * CutReviewerEvent that says who actually did it. Nothing when the reviewer
 * ruled on their own cut, or when the ruler has no roster row to name.
 * Best-effort by contract — a verdict never fails over its bookkeeping.
 */
export async function recordRulingReviewer(
  submissionId: string,
  input: {
    previous: string | null;
    verdict: "approved" | "sent back";
    /** who pressed it — the action's own session read, never re-derived here */
    ruler: { teamMemberId: string | null; name: string; userId: string | null } | null;
  },
): Promise<void> {
  try {
    const tmId = input.ruler?.teamMemberId ?? null;
    if (!input.ruler || !tmId || tmId === input.previous) return;
    await assignCutReviewer(submissionId, {
      reason: input.previous ? "COVER" : "CLAIM",
      toTeamMemberId: tmId,
      expectFrom: input.previous,
      actor: { name: input.ruler.name, userId: input.ruler.userId },
      note: input.previous ? `${input.verdict} it in their place` : `${input.verdict} an unassigned cut`,
      requirePending: false,
      role: input.previous ? "COVER" : "MANUAL",
    });
  } catch (e) {
    console.warn("recordRulingReviewer failed (verdict stands)", submissionId, e);
  }
}

// ---- who hears about it ---------------------------------------------------------

/**
 * The announcement's targets once a cut HAS a reviewer (announceCutInReview).
 * Null = no reviewer: the caller keeps the old OWNER+ADMIN broadcast, byte for
 * byte, so an unconfigured Room behaves exactly as it did.
 *
 *   1. the assignee — "Waiting on you", person-addressed, on THEIR review_ready
 *      switch (James's is bell-only by an earlier consent decision; nothing
 *      here flips it).
 *   2. Jordan — an OWNER row carrying the oversight sentence (who has it),
 *      through the same bridge and his same saved switch as before, with his
 *      own-upload carve-out kept. When the cut is HIS, it says so.
 *   3. the rest of the chain and the office (Kyle) — an FYI person row on their
 *      own switch, which keeps the Slack DM Kyle asked for on Sep 21.
 * The ADMIN role broadcast is dropped: the assignee must not get a second
 * bell for the same cut, and a bell that belongs to everybody is nobody's.
 */
export async function reviewAnnounceTargets(input: {
  reviewer: { teamMemberId: string; name: string } | null;
  street: string;
  editor: string;
  round: number;
  href: string;
  ownerActed?: boolean;
  at?: Date;
}): Promise<NotifyTarget[] | null> {
  if (!input.reviewer) return null;
  const { appBase } = await import("@/lib/appUrl");
  const { ownerTeamMemberIds, officeTeamMemberIds } = await import("@/lib/smsPrefs");
  const link = `${appBase()}${input.href}`;
  const who = firstName(input.reviewer.name);
  const what = `${input.street} (${input.editor}, v${input.round})`;
  const [owners, office, chain] = await Promise.all([
    ownerTeamMemberIds().catch(() => [] as string[]),
    officeTeamMemberIds().catch(() => [] as string[]),
    reviewerChain(input.at),
  ]);
  const reviewerIsOwner = owners.includes(input.reviewer.teamMemberId);
  const targets: NotifyTarget[] = [];
  if (!reviewerIsOwner) {
    targets.push({
      roles: ANY_ROLE,
      userKey: `tm:${input.reviewer.teamMemberId}`,
      slackDm: `🎬 Waiting on you — ${what}. ${link}`,
    });
  }
  targets.push({
    roles: ["OWNER"],
    ownerSms: reviewerIsOwner
      ? `Video in review — waiting on you: ${what}. ${link}`
      : `FYI video in review — ${what} · ${who} reviews it first; approve it any time. ${link}`,
    ...(input.ownerActed ? { ownerActed: true } : {}),
  });
  const away = new Set(chain.members.filter((m) => m.awayUntil).map((m) => m.teamMemberId));
  const fyi = [...new Set([...chain.members.filter((m) => m.canRule).map((m) => m.teamMemberId), ...office])].filter(
    (id) => id !== input.reviewer!.teamMemberId && !owners.includes(id) && !away.has(id),
  );
  // Kyle's copy says his part in it (Jordan: "Kyle should just know his role
  // and get notified as well as James").
  for (const id of fyi) {
    targets.push({
      roles: ANY_ROLE,
      userKey: `tm:${id}`,
      slackDm: `Video in review — ${what}. ${who} reviews it first; if ${who} hasn't got to it, approve it or send it back yourself. ${link}`,
    });
  }
  return targets;
}

/** A cut changed hands: tell the new owner (on their own switch) and give the
 *  old one an FYI bell. Nobody is told about their own press. Deduped on the
 *  event, so a retried action cannot ring twice. Best-effort. */
async function announceReviewerChange(input: {
  submissionId: string;
  eventId: string;
  from: string | null;
  to: string;
  actorTeamMemberId: string | null;
  why: string;
}): Promise<void> {
  try {
    const sub = await prisma.reviewSubmission.findUnique({
      where: { id: input.submissionId },
      select: { projectId: true, round: true, fileName: true, project: { select: { title: true } } },
    });
    if (!sub) return;
    const { notifyInApp } = await import("@/lib/notify");
    const { appBase } = await import("@/lib/appUrl");
    const street = (sub.project?.title || "a job").split(",")[0].trim();
    const href = `/review/${sub.projectId}?cut=${input.submissionId}`;
    const toName = await nameOf(input.to);
    if (input.to !== input.actorTeamMemberId) {
      // cut_ready: a cut is waiting on THIS person's verdict now, which is
      // exactly what their "video in review" switch is for — no new channel.
      await notifyInApp({
        kind: "cut_ready",
        title: `Cut now yours to review — ${street}`,
        href,
        targets: [{ roles: ANY_ROLE, userKey: `tm:${input.to}`, slackDm: `🎬 Now yours to review — ${street} (v${sub.round}), ${input.why}. ${appBase()}${href}` }],
        dedupeKey: `cut-reviewer-${input.submissionId}-${input.eventId}`,
      });
    }
    if (input.from && input.from !== input.actorTeamMemberId && input.from !== input.to) {
      await notifyInApp({
        kind: "review_reassigned",
        title: `${toName ? firstName(toName) : "Someone else"} has ${street} now`,
        body: `Version ${sub.round} — ${input.why}.`,
        href,
        targets: [{ roles: ANY_ROLE, userKey: `tm:${input.from}` }],
        dedupeKey: `cut-reviewer-fyi-${input.submissionId}-${input.eventId}`,
      });
    }
  } catch (e) {
    console.warn("reviewer change notice failed (assignment stands)", input.submissionId, e);
  }
}

// ---- the people's actions (server actions in app/review/actions.ts call these) ---

export type ReviewActor = { teamMemberId: string | null; name: string; userId: string | null };

/** "I'll take it" / "I'll cover it". Only a cut still waiting on a verdict. */
export async function takeCutReview(
  submissionId: string,
  actor: ReviewActor,
  opts: { cover?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  if (!actor.teamMemberId) return { ok: false, message: "Your login isn't linked to a roster row, so a cut can't be put on your name — ask Jordan to link it on People." };
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { reviewerTeamMemberId: true } });
  if (!sub) return { ok: false, message: "That cut no longer exists." };
  if (sub.reviewerTeamMemberId === actor.teamMemberId) return { ok: true, message: "It's already yours." };
  const reason: ReviewerReason = opts.cover && sub.reviewerTeamMemberId ? "COVER" : "CLAIM";
  const res = await assignCutReviewer(submissionId, {
    reason,
    toTeamMemberId: actor.teamMemberId,
    expectFrom: sub.reviewerTeamMemberId,
    actor: { name: actor.name, userId: actor.userId },
  });
  if (!res.ok) return { ok: false, message: res.message };
  if (res.changed && res.eventId) {
    await announceReviewerChange({
      submissionId, eventId: res.eventId, from: res.from, to: res.to, actorTeamMemberId: actor.teamMemberId,
      why: `${firstName(actor.name)} ${reason === "COVER" ? "is covering it" : "took it"}`,
    });
  }
  return { ok: true, message: reason === "COVER" ? "It's yours — you're covering this one." : "It's yours now." };
}

/** Hand a cut to a named person who can rule on it. */
export async function handCutReview(
  submissionId: string,
  toTeamMemberId: string,
  actor: ReviewActor,
  note?: string | null,
): Promise<{ ok: boolean; message: string }> {
  const target = await eligibleReviewer(toTeamMemberId);
  if (!target) return { ok: false, message: "That person can't rule on cuts — pick someone with an owner/admin login or a review seat." };
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { reviewerTeamMemberId: true } });
  if (!sub) return { ok: false, message: "That cut no longer exists." };
  if (sub.reviewerTeamMemberId === toTeamMemberId) return { ok: true, message: `It's already with ${firstName(target.name)}.` };
  const res = await assignCutReviewer(submissionId, {
    reason: "MANUAL",
    toTeamMemberId,
    expectFrom: sub.reviewerTeamMemberId,
    actor: { name: actor.name, userId: actor.userId },
    note,
  });
  if (!res.ok) return { ok: false, message: res.message };
  if (res.changed && res.eventId) {
    await announceReviewerChange({
      submissionId, eventId: res.eventId, from: res.from, to: res.to, actorTeamMemberId: actor.teamMemberId,
      why: `handed on by ${firstName(actor.name)}${note ? ` — “${note.trim().slice(0, 80)}”` : ""}`,
    });
  }
  return { ok: true, message: `Handed to ${firstName(target.name)}.` };
}

/**
 * Move every cut waiting on this person to the next seat that is present.
 * The one AUTOMATIC move there is, and it follows a person's own switch
 * ("I'm away"). Only PENDING cuts move; decided ones keep their record.
 * Nobody present = nothing moves and the exceptions board carries it.
 */
export async function transferAwayReviews(
  teamMemberId: string,
  actor: { name: string; userId?: string | null } = { name: "system: away" },
  at: Date = new Date(),
): Promise<{ moved: number; to: { id: string; name: string } | null }> {
  const chain = await reviewerChain(at);
  const next = chain.members.find((m) => m.teamMemberId !== teamMemberId && present(m)) ?? null;
  if (!next) return { moved: 0, to: null };
  const mine = await prisma.reviewSubmission.findMany({
    where: { status: "PENDING", reviewerTeamMemberId: teamMemberId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const awayName = firstName((await nameOf(teamMemberId)) ?? "They");
  const until = await awayUntilOf(teamMemberId, at);
  let moved = 0;
  for (const s of mine) {
    const res = await assignCutReviewer(s.id, {
      reason: "AWAY_TRANSFER",
      toTeamMemberId: next.teamMemberId,
      expectFrom: teamMemberId,
      actor,
      note: until ? `${awayName} is away until ${until.toISOString().slice(0, 10)}` : `${awayName} is away`,
      at,
    });
    if (res.ok && res.changed && res.eventId) {
      moved++;
      await announceReviewerChange({
        submissionId: s.id, eventId: res.eventId, from: res.from, to: res.to, actorTeamMemberId: null,
        why: `${awayName} is away`,
      });
    }
  }
  return { moved, to: { id: next.teamMemberId, name: next.name } };
}

/** Mark a review seat away until a date (or back, with null). Away moves that
 *  person's waiting cuts on at once; coming back moves nothing back — a cut
 *  somebody is already watching stays with them. */
export async function markReviewerAway(
  teamMemberId: string,
  until: Date | null,
  actor: ReviewActor,
  at: Date = new Date(),
): Promise<{ ok: boolean; message: string }> {
  const chain = await reviewerChain(at);
  const seat = chain.members.find((m) => m.teamMemberId === teamMemberId);
  if (!seat) return { ok: false, message: "Only the three review seats can be marked away." };
  if (until && (Number.isNaN(until.getTime()) || until <= at)) return { ok: false, message: "Pick a date in the future." };
  if (until && until.getTime() - at.getTime() > 60 * 86_400_000) return { ok: false, message: "Away is capped at 60 days — set it again when it runs out." };
  await putSetting<AwayRow>(awayKey(teamMemberId), { until: until ? until.toISOString() : null, setBy: actor.name, setAt: at.toISOString() }, actor.name);
  const who = firstName(seat.name);
  if (!until) return { ok: true, message: `${who} is back — new cuts go to them again.` };
  const r = await transferAwayReviews(teamMemberId, { name: actor.name, userId: actor.userId }, at);
  return {
    ok: true,
    message: r.to
      ? `${who} is away until ${until.toISOString().slice(0, 10)}. ${r.moved} waiting cut${r.moved === 1 ? "" : "s"} moved to ${firstName(r.to.name)}; new cuts go to ${firstName(r.to.name)} too.`
      : `${who} is away until ${until.toISOString().slice(0, 10)} — but nobody else in the chain is available, so their cuts stay put and show on the exceptions board.`,
  };
}

// ---- the hourly pass ------------------------------------------------------------

/** In review for real: the editor's check is done, or the row predates the
 *  gate (§8.2 — the same test as selfCheck.awaitingReviewWhere, written on the
 *  columns so this file does not lean on that module's shape). A cut still
 *  waiting on its check has no reviewer to take, cover or label: it gets one
 *  when it ENTERS review, and not before. */
const IN_REVIEW: Prisma.ReviewSubmissionWhereInput = { OR: [{ selfCheckedAt: { not: null } }, { selfCheckId: null }] };

/** A delivered, cancelled or parked job's pending cut is not a work list —
 *  the same carve-out the Review Room and the exceptions board make. */
const LIVE_JOB: Prisma.ProjectWhereInput = { status: { notIn: ["DELIVERED", "CANCELLED", "ON_HOLD"] } };

/**
 * Once an hour, from the status sweep (projectStatus.syncProjectStatuses).
 *   1. AWAY — re-run the away move for anyone marked away (idempotent; catches
 *      a cut that landed on them in the second before the switch was saved).
 *   2. LABEL — a cut that was ANNOUNCED in review with nobody to give it to
 *      (before this shipped, or while the whole chain was away) gets the
 *      present reviewer, silently: it already rang the office once. A row that
 *      was never announced is not touched — it is still waiting on something
 *      (the editor's self-check), and assignment is never the way in.
 *   3. OFFER — a cut the PRIMARY has held past coverOfferHours covered hours
 *      is offered to the backup: one bell row, once per cut. Nothing moves.
 *   4. MOVE — only when review_room.coverTransferHours is set (null today):
 *      a cut held past that many covered hours moves to the next present seat.
 *      A cut somebody chose by hand (MANUAL) is never moved by the rule.
 * `now` is a parameter so a drill can run a Friday-5pm cut across a weekend.
 */
export async function reviewCoverSweep(opts: { now?: Date } = {}): Promise<{
  configured: boolean;
  awayMoved: number;
  labelled: number;
  offered: number;
  autoMoved: number;
}> {
  const at = opts.now ?? new Date();
  const out = { configured: false, awayMoved: 0, labelled: 0, offered: 0, autoMoved: 0 };
  const chain = await reviewerChain(at);
  if (!chain.configured) return out;
  out.configured = true;
  const rules = await reviewRoomRules();
  const { coverageRules, coveredHoursBetween } = await import("@/lib/coverage");
  const cov = await coverageRules();

  // 1 · away
  for (const m of chain.members.filter((x) => x.awayUntil)) {
    out.awayMoved += (await transferAwayReviews(m.teamMemberId, { name: "system: away" }, at)).moved;
  }

  // 2 · label announced-but-unassigned cuts
  const unassigned = await prisma.reviewSubmission.findMany({
    where: { status: "PENDING", reviewerTeamMemberId: null, project: LIVE_JOB, AND: [IN_REVIEW] },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  if (unassigned.length) {
    const rung = await prisma.notification.findMany({
      where: { OR: unassigned.map((u) => ({ dedupeKey: { startsWith: `cut-in-review-${u.id}-` } })) },
      select: { dedupeKey: true },
    });
    const announced = new Set(
      unassigned.filter((u) => rung.some((n) => n.dedupeKey?.startsWith(`cut-in-review-${u.id}-`))).map((u) => u.id),
    );
    for (const id of announced) {
      if (await ensureCutReviewer(id, { at, actorName: "system: backfill" })) out.labelled++;
    }
  }

  // 3 · offer the primary's long-held cuts to the backup
  const backup = chain.backup;
  if (chain.primary && backup && present(backup) && backup.teamMemberId !== chain.primary.teamMemberId) {
    const held = await prisma.reviewSubmission.findMany({
      where: { status: "PENDING", reviewerTeamMemberId: chain.primary.teamMemberId, project: LIVE_JOB, AND: [IN_REVIEW] },
      select: { id: true, projectId: true, round: true, createdAt: true, reviewerAssignedAt: true, project: { select: { title: true } } },
      take: 200,
    });
    const { notifyInApp } = await import("@/lib/notify");
    for (const s of held) {
      const hours = coveredHoursBetween(s.reviewerAssignedAt ?? s.createdAt, at, cov);
      if (hours < rules.coverOfferHours) continue;
      const street = (s.project?.title || "a job").split(",")[0].trim();
      const before = await prisma.notification.count({ where: { dedupeKey: `review-cover-offer-${s.id}-0` } });
      if (before > 0) continue;
      await notifyInApp({
        kind: "review_cover_offer",
        // The instruction is in the TITLE: an any-role row loses its body to
        // the money clamp (notify.ts), so a body would never reach Kyle.
        title: `${firstName(chain.primary.name)} hasn't got to ${street} (v${s.round}) — approve it or send it back yourself`,
        body: `Waiting ${Math.floor(hours)} covered hours. You don't need to take it first.`,
        href: `/review/${s.projectId}?cut=${s.id}`,
        targets: [{ roles: ANY_ROLE, userKey: `tm:${backup.teamMemberId}` }],
        dedupeKey: `review-cover-offer-${s.id}`,
      });
      out.offered++;
    }
  }

  // 4 · the automatic move — OFF unless Jordan sets a number
  if (rules.coverTransferHours != null) {
    const waiting = await prisma.reviewSubmission.findMany({
      where: {
        status: "PENDING",
        reviewerTeamMemberId: { not: null },
        OR: [{ reviewerRole: null }, { reviewerRole: { not: "MANUAL" } }],
        AND: [IN_REVIEW],
        project: LIVE_JOB,
      },
      select: { id: true, reviewerTeamMemberId: true, reviewerAssignedAt: true, createdAt: true },
      take: 200,
    });
    for (const s of waiting) {
      const idx = chain.members.findIndex((m) => m.teamMemberId === s.reviewerTeamMemberId);
      if (idx === -1) continue; // held by somebody outside the chain — theirs
      const hours = coveredHoursBetween(s.reviewerAssignedAt ?? s.createdAt, at, cov);
      if (hours < rules.coverTransferHours) continue;
      const next = chain.members.slice(idx + 1).find(present);
      if (!next) continue;
      const res = await assignCutReviewer(s.id, {
        reason: "AUTO_TRANSFER",
        toTeamMemberId: next.teamMemberId,
        expectFrom: s.reviewerTeamMemberId,
        actor: { name: "system: covered-hours rule" },
        note: `waited ${Math.floor(hours)} covered hours`,
        role: next.slot,
        at,
      });
      if (res.ok && res.changed && res.eventId) {
        out.autoMoved++;
        await announceReviewerChange({
          submissionId: s.id, eventId: res.eventId, from: res.from, to: res.to, actorTeamMemberId: null,
          why: `it waited ${Math.floor(hours)} covered hours`,
        });
      }
    }
  }
  return out;
}

// ---- reads for the screens ------------------------------------------------------

/** Reviewer names for a set of cuts, for boards that list many. */
export async function reviewerNamesFor(teamMemberIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(teamMemberIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Everybody a cut could be handed to: the seats, then every other owner/admin. */
export async function reviewerCandidates(at: Date = new Date()): Promise<ReviewerCandidate[]> {
  const chain = await reviewerChain(at);
  const office = await prisma.appUser.findMany({
    where: { role: { in: ["OWNER", "ADMIN"] }, status: "ACTIVE", teamMemberId: { not: null } },
    select: { teamMemberId: true },
  });
  const officeIds = [...new Set(office.map((o) => o.teamMemberId!))].filter((id) => !chain.members.some((m) => m.teamMemberId === id));
  const tms = officeIds.length
    ? await prisma.teamMember.findMany({ where: { id: { in: officeIds }, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  return [
    ...chain.members.map((m) => ({
      id: m.teamMemberId, name: m.name, slot: m.slot, awayUntil: m.awayUntil?.toISOString() ?? null, canRule: m.canRule,
    })),
    ...(await Promise.all(
      tms.map(async (t) => ({ id: t.id, name: t.name, slot: null, awayUntil: (await awayUntilOf(t.id, at))?.toISOString() ?? null, canRule: true })),
    )),
  ];
}

/** The Settings card: every active roster row, whether they could hold a
 *  seat, and what their own "video in review" switch says — so naming James
 *  shows, in the same place, that his notices are bell-only today. */
export async function reviewerSeats(at: Date = new Date()): Promise<ReviewerSeat[]> {
  const [roster, logins] = await Promise.all([
    prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    prisma.appUser.findMany({ where: { status: "ACTIVE", teamMemberId: { not: null } }, select: { teamMemberId: true, role: true } }),
  ]);
  const { notifyPrefsFor } = await import("@/lib/notifyPrefs");
  const rank = (role: string) => (role === "OWNER" ? 0 : role === "ADMIN" ? 1 : 2);
  return Promise.all(
    roster.map(async (r) => {
      const login = logins.filter((l) => l.teamMemberId === r.id).sort((a, b) => rank(a.role) - rank(b.role))[0] ?? null;
      const prefs = await notifyPrefsFor(r.id).catch(() => null);
      return {
        id: r.id,
        name: r.name,
        role: String(r.role),
        hasLogin: !!login,
        loginRole: login?.role ?? null,
        // An editor login can't hold the desk (canRuleOnCuts); anyone else
        // who isn't owner/admin needs Jordan to seat them (validateReviewSeats).
        canRuleIfDesignated: !!login && !SEAT_REFUSED_ROLES.has(login.role),
        reviewReady: { slack: !!prefs?.review_ready.slack, sms: !!prefs?.review_ready.sms },
        awayUntil: (await awayUntilOf(r.id, at))?.toISOString() ?? null,
      };
    }),
  );
}

/** What /edit/<id> shows about who holds each waiting cut on this job. */
export async function reviewerStripFor(
  projectId: string,
  viewer: AuthorityInput | undefined,
  opts: { now?: Date; authEnforced?: boolean } = {},
): Promise<ReviewerStripData> {
  const at = opts.now ?? new Date();
  const [subs, chain, rules] = await Promise.all([
    prisma.reviewSubmission.findMany({
      where: { projectId, status: "PENDING", AND: [IN_REVIEW] },
      orderBy: [{ round: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, round: true, fileName: true, deliverableId: true, slot: true, createdAt: true,
        reviewerTeamMemberId: true, reviewerAssignedAt: true, reviewerRole: true,
      },
    }),
    reviewerChain(at),
    reviewRoomRules(),
  ]);
  const authority = viewer ? await canRuleOnCuts(viewer) : null;
  // Local dev with auth off acts as the desk, like every guard.
  const canRule = authority ? authority.ok : opts.authEnforced === false;
  const viewerTeamMemberId = viewer && !viewer.impersonating ? viewer.teamMemberId : null;
  const names = await reviewerNamesFor(subs.map((s) => s.reviewerTeamMemberId));
  const { cutSlots } = await import("@/lib/reviewCuts");
  const slots = await cutSlots(projectId).catch(() => []);
  const { coverageRules, coveredHoursBetween } = await import("@/lib/coverage");
  const cov = await coverageRules();
  const backupPresent = !!chain.backup && present(chain.backup) && chain.backup.teamMemberId !== chain.primary?.teamMemberId;
  const rows: ReviewerStripRow[] = subs.map((s) => {
    const since = s.reviewerAssignedAt ?? s.createdAt;
    const coveredHours = Math.floor(coveredHoursBetween(since, at, cov) * 10) / 10;
    const label =
      slots.find((sl) => sl.deliverableId === s.deliverableId && sl.slot === s.slot)?.label ?? s.fileName ?? "Video";
    return {
      submissionId: s.id,
      label,
      round: s.round,
      reviewer: s.reviewerTeamMemberId ? { id: s.reviewerTeamMemberId, name: names.get(s.reviewerTeamMemberId) ?? "someone" } : null,
      sinceISO: s.reviewerAssignedAt?.toISOString() ?? null,
      role: s.reviewerRole,
      coveredHours,
      coverOffered:
        backupPresent && !!chain.primary && s.reviewerTeamMemberId === chain.primary.teamMemberId && coveredHours >= rules.coverOfferHours,
      mine: !!viewerTeamMemberId && s.reviewerTeamMemberId === viewerTeamMemberId,
    };
  });
  return {
    rows,
    canRule,
    viewerTeamMemberId,
    candidates: canRule ? await reviewerCandidates(at) : [],
    backupName: chain.backup ? firstName(chain.backup.name) : null,
    coverOfferHours: rules.coverOfferHours,
  };
}
