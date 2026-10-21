import type { PortalTopic, PortalTopicsData, PortalTopicMonth } from "@/lib/portal";
import type { ClientVideoState, VideoListRow } from "@/lib/contentVideos";
import { portalHref, type PortalDest } from "@/lib/portalNav";
import { CTA_WORDS, LIBRARY_FILTERS, TEXT_KYLE, answerCta, type LibraryFilterKey } from "@/lib/portalWords";

// ---------------------------------------------------------------------------
// WHAT THE v2 PORTAL PUTS IN FRONT OF THE CLIENT (UI-01, Sep 24 2026) — pure.
//
// Every function here partitions data the page ALREADY loaded through the
// shipped readers (portalTopics, portalVideoList, monthProgress, the setup
// checklist, the review window). None of them decides a business fact:
// which cut may be downloaded is cutEntitlement's, a video's state is
// contentVideos.stateOf's, what a script visibility is postingKit's. This file
// only answers "which of those does the client act on first, and where".
// ---------------------------------------------------------------------------

// ---- scripts and topics --------------------------------------------------------

/**
 * A script waiting on the client's read: shared with them, words they may
 * actually see (not an import we hold as history), and no verdict of theirs on
 * THIS version. It must carry the shared version's id — R1: the decision is
 * recorded against the version the page rendered, and a card that could not
 * send it would approve words nobody read.
 */
export function awaitingScript(t: PortalTopic): boolean {
  return !t.declined && !!t.script?.shared && !t.script.decision && !!t.script.sharedVersionId && !!t.scriptText && !t.scriptText.historical;
}

/** On the bank rather than on a month's plan: no selection in any month still open. */
export function inBank(t: PortalTopic, openMonthIds: ReadonlySet<string>): boolean {
  return !t.selection || !openMonthIds.has(t.selection.monthId);
}

export type PlanModel = {
  /** The month My Plan opens on: this ET month, else the first open one. */
  month: PortalTopicMonth | null;
  /** That month's selections, in bank order. */
  monthTopics: PortalTopic[];
  /**
   * The month's allowance topics whose answers the client still owes — the
   * planning reader's NEEDS_ANSWERS / NEEDS_MORE steps (R01). It used to be
   * "selected, unfilmed, no submitted interview", which counted a call-drafted
   * script in review, an approved carryover and every extra: the TEST portal
   * read "2 chosen" above "3 need your answers".
   */
  toAnswer: PortalTopic[];
  /** Shared, undecided, readable — see awaitingScript. */
  scripts: PortalTopic[];
  /** Scripts they already answered (approved or asked to change), for reference. */
  decidedScripts: PortalTopic[];
  /**
   * Of those, the ones answered in the last few minutes. The Scripts view keeps
   * each as a card (Sep 24): answering a script used to drop it from `scripts`
   * on the refresh, and its "You signed off on this one" line went with it.
   */
  justDecided: PortalTopic[];
  /** Not on any open month's plan. */
  bank: PortalTopic[];
};

/** How long a just-answered script stays a card on the Scripts view. */
export const JUST_DECIDED_MS = 10 * 60_000;

export function planModel(t: PortalTopicsData, monthKey: string, now: Date = new Date()): PlanModel {
  const active = t.groups.flatMap((g) => g.topics).filter((x) => !x.declined);
  const open = new Set(t.months.map((m) => m.id));
  const month = t.months.find((m) => m.monthKey === monthKey) ?? t.months[0] ?? null;
  const monthTopics = month ? active.filter((x) => x.selection?.monthId === month.id) : [];
  const decidedScripts = active.filter((x) => !!x.script?.shared && !!x.script.decision && !!x.scriptText && !x.scriptText.historical);
  return {
    month,
    monthTopics,
    // No plan step (the reader could not be read) is unknown, not "owes answers".
    toAnswer: monthTopics.filter((x) => x.plan?.step === "NEEDS_ANSWERS" || x.plan?.step === "NEEDS_MORE"),
    scripts: active.filter(awaitingScript),
    decidedScripts,
    justDecided: decidedScripts.filter((x) => !!x.script?.decidedAtISO && now.getTime() - Date.parse(x.script.decidedAtISO) < JUST_DECIDED_MS),
    bank: active.filter((x) => inBank(x, open)),
  };
}

// ---- Home: one primary action ---------------------------------------------------

export type HomeActionKind =
  | "REVIEW_VIDEOS" | "APPROVE_SCRIPTS" | "READ_REPLY" | "ANSWER_QUESTIONS" | "CHOOSE_ROUTE" | "BOOK_CALL"
  | "PICK_TOPICS" | "BOOK_SESSION" | "COMPLETE_ADDRESS" | "FINISH_SETUP" | "DOWNLOAD" | "ADD_BRIEF"
  // Oct 15 2026: a bulk plan's next session's scripts (bulkPlan.ts).
  | "READ_SESSION";

/**
 * The order a client should do things in. Reviews first — a video waiting on
 * them is the only item with a clock (CP-02) and the one that holds up
 * delivery; then the script decision that gates filming; then a reply from
 * the office; then the month's planning steps in the order the month runs.
 * CHOOSE_ROUTE (§6.4, Sep 25 2026) is the call step's place when the month
 * may be planned either way — the order of every other kind is unchanged.
 */
export const HOME_PRIORITY: readonly HomeActionKind[] = [
  "REVIEW_VIDEOS", "APPROVE_SCRIPTS", "READ_REPLY", "READ_SESSION", "ANSWER_QUESTIONS", "CHOOSE_ROUTE", "BOOK_CALL",
  "PICK_TOPICS", "BOOK_SESSION", "COMPLETE_ADDRESS", "FINISH_SETUP", "DOWNLOAD", "ADD_BRIEF",
];

export type HomeAction = {
  kind: HomeActionKind;
  count: number;
  title: string;
  /** A second line: the review deadline, the month, why it matters. */
  detail: string | null;
  cta: string;
  href: string;
  dest: PortalDest;
};

export type HomeActionsInput = {
  /** ACTIVE | PAUSED | ENDED */
  status: string;
  readOnly: boolean;
  perms: { session: boolean; suggest: boolean; request: boolean; approve: boolean; profile: boolean };
  /** Videos waiting on the client's review, library-wide. `single` when there is exactly one. */
  review: { count: number; single: { id: string; title: string } | null; soonestDeadlineLabel: string | null };
  scripts: { topicId: string; title: string }[];
  unread: number;
  /** `noCallEligible`: the month may be planned in writing or on a call — an undecided month is asked which (§6.4). */
  planning: { planningMode: string; callStatus: string; noCallEligible?: boolean } | null;
  month: { monthKey: string; label: string; owed: number; selected: number } | null;
  /** Downstream filming is evidence this month began, even if a legacy planning row is missing. */
  filmingStarted?: boolean;
  /** Oct 8 2026: the client plans their own content — no topics, answers, scripts or route to choose; their brief is optional. */
  clientPlanned?: { briefIn: boolean; monthLabel: string } | null;
  /** Oct 15 2026: a bulk plan — the office plans and books it; the client reads ahead by session. */
  bulk?: { focusSessionNo: number | null; scripts: number; dateLabel: string | null } | null;
  /** Staff must connect historical topic rows before the client is asked to select them again. */
  topicHistoryNeedsReview?: boolean;
  /** The planning reader's owed answers (planModel.toAnswer): never an extra, never a topic the call covered. `missing` = its known gaps. */
  toAnswer: { title: string; missing?: number }[];
  /** `deferred` (A21): the client chose "Schedule later" for the session still to book — the action stays, and says so.
   *  `earliestLabel` (A20): when that session may start ("Thursday, October 1"), from the gate. */
  session: { offerBooking: boolean; required: number; missing: number; deferred?: boolean; earliestLabel?: string | null };
  /** Booked sessions still missing an exact filming address (CP-05). */
  addressNeeded: number;
  /** Oct 12 2026: an over month's session to book this month too (lateSession.ts) — offered once its scripts are ready. */
  lateSession?: { label: string; open: boolean; /** Oct 13 2026: one session films both months; it is THIS month's filming action, not a second one. */ combined?: boolean } | null;
  setup: { complete: boolean; remaining: number } | null;
  ready: { count: number; withFile: boolean; single: { id: string; title: string } | null };
  /**
   * Oct 13 2026 (A1): the plain shared link carries no person, so it can never
   * approve (portalAccess.LEGACY_TOKEN). Its review step asks them to sign in
   * instead of telling them to approve. `signInHref` is the sign-in page when
   * email sign-in is live for this client, else null (they sign in from their
   * invitation email).
   */
  linkVisitor?: { signInHref: string | null; /** Oct 20 2026 (audit E2): anyone holds a seat; none = the office sets one up. */ hasSeat?: boolean } | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Everything waiting on the client, most important first, as ONE primary
 * action and the rest. A paused or ended program starts nothing new, so it
 * gets no action but a reply to read.
 */
export function homeActions(i: HomeActionsInput, base = ""): { primary: HomeAction | null; more: HomeAction[] } {
  const out: HomeAction[] = [];
  // `step`: the Your Month step the action lands on (#step-<key>) — Home's next
  // step opens the guided plan where that step is, not a separate page.
  const add = (a: Omit<HomeAction, "href"> & { extra?: string; step?: string; href?: string }) => out.push({ kind: a.kind, count: a.count, title: a.title, detail: a.detail, cta: a.cta, dest: a.dest, href: a.href ?? `${portalHref(base, a.dest, a.extra)}${a.step ? `#step-${a.step}` : ""}` });

  // A reply is something to read, not something to start: it reaches a paused account too.
  if (i.unread > 0) add({ kind: "READ_REPLY", count: i.unread, title: i.unread === 1 ? "A new reply from the team" : `${i.unread} new replies from the team`, detail: null, cta: "Read it", dest: "messages" });
  if (!i.readOnly && i.status === "ACTIVE") {
    if (i.review.count > 0 && i.linkVisitor) {
      // A1: the link can watch, not decide. Say so, and point at the sign-in.
      const one = i.review.single;
      add({
        kind: "REVIEW_VIDEOS", count: i.review.count,
        title: one ? `“${one.title}” is ready for your review` : `${plural(i.review.count, "video")} ready for your review`,
        detail: i.linkVisitor.signInHref ? "Sign in to approve or request changes."
          : i.linkVisitor.hasSeat === false ? `To approve or request changes, ${TEXT_KYLE} and we'll set up your sign-in.`
          : "Sign in from your invitation email to approve or request changes.",
        cta: i.linkVisitor.signInHref ? "Sign in" : one ? "Watch it" : "Watch them", dest: "library",
        extra: one ? `v=${one.id}` : "st=review",
        ...(i.linkVisitor.signInHref ? { href: i.linkVisitor.signInHref } : {}),
      });
    } else if (i.review.count > 0 && (i.perms.approve || i.perms.request)) {
      add({
        kind: "REVIEW_VIDEOS", count: i.review.count,
        title: i.review.single ? `Review “${i.review.single.title}”` : `Review ${plural(i.review.count, "video")} waiting on you`,
        detail: i.review.soonestDeadlineLabel ? `Review by ${i.review.soonestDeadlineLabel}` : "Watch it, leave notes where you'd change something, or approve it.",
        cta: i.review.single ? "Review it" : "Review now", dest: "library", extra: i.review.single ? `v=${i.review.single.id}` : undefined,
      });
    }
    const cp = i.clientPlanned ?? null;
    const bulk = i.bulk ?? null;
    if (bulk && bulk.focusSessionNo && bulk.scripts > 0) {
      add({
        kind: "READ_SESSION", count: bulk.scripts,
        title: `Read your scripts for session ${bulk.focusSessionNo}`,
        detail: `${plural(bulk.scripts, "script")}${bulk.dateLabel ? ` · ${bulk.dateLabel}` : ""}. Every later session is there to read ahead too.`,
        cta: "Read the scripts", dest: "plan", href: `${portalHref(base, "plan")}#session-${bulk.focusSessionNo}`,
      });
    }
    if (i.scripts.length > 0 && i.perms.suggest && !cp && !bulk) {
      add({
        kind: "APPROVE_SCRIPTS", count: i.scripts.length,
        title: i.scripts.length === 1 ? `Read your script for “${i.scripts[0].title}”` : `Read ${plural(i.scripts.length, "script")} before we film`,
        // Audit E1: only the account owner approves; everyone else may suggest.
        detail: i.perms.approve ? "Approve it as written, or tell us what to change." : "Read it and tell us what to change. The account owner approves it.", cta: i.scripts.length === 1 ? "Read the script" : "Read the scripts", dest: "plan", extra: "pv=scripts",
      });
    }
    // R01: keyed on what is OWED, on either route — a call-route gap after the
    // call is asked too, and a topic the call covered, a script in review or an
    // extra never is. (It used to need planningMode WRITTEN and counted all three.)
    if (i.toAnswer.length > 0 && i.perms.suggest && !cp && !bulk) {
      const one = i.toAnswer.length === 1 ? i.toAnswer[0] : null;
      add({
        kind: "ANSWER_QUESTIONS", count: i.toAnswer.length,
        title: one ? (one.missing === 1 ? `One more question on “${one.title}”` : `Answer the questions for “${one.title}”`) : `Answer the questions for ${plural(i.toAnswer.length, "topic")}`,
        // The call route has no answers step: its gaps are asked in the call step (yourMonth).
        detail: "We write each script from your answers.", cta: one ? answerCta(one.missing ?? 0) : CTA_WORDS.ANSWER, dest: "plan", step: i.planning?.planningMode === "CALL" ? "call" : "answers",
      });
    }
    const undecided = !!i.planning && i.planning.planningMode === "UNDECIDED" && i.planning.noCallEligible === true;
    if (undecided && !cp && !bulk && i.planning!.callStatus === "NOT_SCHEDULED" && i.perms.session && !i.filmingStarted) {
      add({ kind: "CHOOSE_ROUTE", count: 1, title: `How would you like to plan ${i.month?.label ?? "this month"}?`, detail: "Choose your topics here, or talk them through on a call.", cta: "Choose", dest: "plan", step: "route" });
    } else if (i.planning && i.planning.planningMode !== "WRITTEN" && !cp && !bulk && i.planning.callStatus === "NOT_SCHEDULED" && i.perms.session && !i.filmingStarted) {
      // A3 (Oct 13 2026): a client who plans their own content is never asked to book a strategy call.
      add({ kind: "BOOK_CALL", count: 1, title: "Book your strategy call", detail: "We plan the month on it.", cta: "Book the call", dest: "plan", step: "call" });
    }
    // On the call route the topics are chosen together on the call — browsing
    // first is optional (§6.4), so it is not a to-do for the client.
    if (i.month && i.month.selected < i.month.owed && i.perms.suggest && i.planning?.planningMode !== "CALL" && !i.topicHistoryNeedsReview && !cp && !bulk) {
      const n = i.month.owed - i.month.selected;
      add({ kind: "PICK_TOPICS", count: n, title: `Choose ${plural(n, "more topic")} for ${i.month.label}`, detail: `${i.month.selected} of ${i.month.owed} chosen.`, cta: "Choose topics", dest: "plan", extra: "pv=bank" });
    }
    // Oct 13 2026: an over month's late session and this month's own are
    // booked from ONE card in Your Month, so they are ONE action here — two
    // used to sit side by side (and shared a React key).
    const lateOpen = !!i.lateSession?.open && i.perms.session && !i.lateSession.combined;
    if (i.session.offerBooking && i.perms.session && !bulk) {
      const booked = i.session.required - i.session.missing;
      // "Schedule later" keeps the booking visibly outstanding (§6.7) — the
      // same action, saying the client chose it, never a second one.
      const detail = lateOpen
        ? `Your ${i.lateSession!.label} session and this month's are both ready to book.`
        : i.session.deferred ? "You chose to schedule later. Book any time." : i.session.earliestLabel ? `Sessions can start from ${i.session.earliestLabel}.` : null;
      add({ kind: "BOOK_SESSION", count: i.session.missing + (lateOpen ? 1 : 0), title: lateOpen ? "Book your filming sessions" : i.session.required > 1 && booked > 0 ? `Book your next filming session (${booked} of ${i.session.required} booked)` : "Book your filming session", detail, cta: CTA_WORDS.BOOK, dest: "plan", step: lateOpen ? "late" : "filming" });
    } else if (lateOpen) {
      add({ kind: "BOOK_SESSION", count: 1, title: `Book your ${i.lateSession!.label} session`, detail: `Your ${i.lateSession!.label} scripts are ready. It's filmed this month, beside this month's own session.`, cta: CTA_WORDS.BOOK, dest: "plan", step: "late" });
    }
    if (i.addressNeeded > 0 && i.perms.session) {
      add({ kind: "COMPLETE_ADDRESS", count: i.addressNeeded, title: i.addressNeeded === 1 ? "Add the exact address for your session" : `Add the exact address for ${plural(i.addressNeeded, "session")}`, detail: "So our team arrives at the right door for your filming.", cta: "Add the address", dest: "plan", step: "filming" });
    }
    if (i.setup && !i.setup.complete && i.setup.remaining > 0 && i.perms.profile) {
      add({ kind: "FINISH_SETUP", count: i.setup.remaining, title: `Finish setting up your account (${plural(i.setup.remaining, "step")} left)`, detail: "Your editor uses these on every video.", cta: "Continue setup", dest: "brand" });
    }
    // Optional, so it is the last thing on the list — never ahead of booking filming.
    if (cp && !cp.briefIn && i.perms.suggest) {
      add({ kind: "ADD_BRIEF", count: 1, title: `Add your creative brief for ${cp.monthLabel}`, detail: "Optional: upload your plan or paste notes for your crew.", cta: "Add your brief", dest: "plan", step: "brief" });
    }
    if (i.ready.count > 0 && i.ready.withFile) {
      add({
        kind: "DOWNLOAD", count: i.ready.count,
        title: i.ready.single ? `Download and post “${i.ready.single.title}”` : `Download and post ${plural(i.ready.count, "finished video")}`,
        detail: null, cta: "Download", dest: "library", extra: i.ready.single ? `v=${i.ready.single.id}` : "st=approved",
      });
    }
  }
  const rank = (k: HomeActionKind) => HOME_PRIORITY.indexOf(k);
  out.sort((a, b) => rank(a.kind) - rank(b.kind));
  return { primary: out[0] ?? null, more: out.slice(1) };
}

// ---- Content Library ------------------------------------------------------------

export type LibraryView = {
  q: string;
  st: LibraryFilterKey;
  /** Waiting on the client — every one of them, never page-bound. */
  review: VideoListRow[];
  /** Everything else that matches, this page of it, in the library's own order. */
  rows: VideoListRow[];
  counts: Record<LibraryFilterKey, number>;
  page: number;
  pages: number;
  /** How many matched before paging (review + rows across pages). */
  matched: number;
};

const statesOf = (k: LibraryFilterKey): readonly ClientVideoState[] | null => LIBRARY_FILTERS.find((f) => f.key === k)?.states ?? null;

/**
 * Search and filter over the WHOLE library (the rows arrive complete and in
 * portalVideoList's order), then page what is left. Review-first: a video
 * waiting on the client is pulled to the top whatever page they are on — the
 * old list paged first, so one on page two was invisible.
 */
export function libraryView(all: VideoListRow[], opts: { q?: string | null; st?: LibraryFilterKey | null; page?: number | null; perPage?: number } = {}): LibraryView {
  // Belt and braces: a repeated ?q= arrives as string[] (PortalPage passes
  // the address through firstQueryValues, but this is a library function).
  const rawQ: unknown = opts.q;
  const q = (typeof rawQ === "string" ? rawQ : Array.isArray(rawQ) && typeof rawQ[0] === "string" ? rawQ[0] : "").trim().slice(0, 80);
  const needle = q.toLowerCase();
  const st: LibraryFilterKey = opts.st ?? "all";
  const perPage = Math.max(1, opts.perPage ?? 24);
  const matching = needle ? all.filter((r) => r.title.toLowerCase().includes(needle)) : all;
  const counts = Object.fromEntries(LIBRARY_FILTERS.map((f) => [f.key, f.states ? matching.filter((r) => (f.states as readonly string[]).includes(r.state)).length : matching.length])) as Record<LibraryFilterKey, number>;
  const keep = statesOf(st);
  const review = st === "all" || st === "review" ? matching.filter((r) => r.state === "FOR_REVIEW") : [];
  const rest = matching.filter((r) => r.state !== "FOR_REVIEW" && (!keep || keep.includes(r.state)));
  const pages = Math.max(1, Math.ceil(rest.length / perPage));
  const page = Math.min(Math.max(opts.page ?? 1, 1), pages);
  return { q, st, review, rows: rest.slice((page - 1) * perPage, page * perPage), counts, page, pages, matched: review.length + rest.length };
}
