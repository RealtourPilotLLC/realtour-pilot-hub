import type { PortalTopic, PortalTopicsData, PortalTopicMonth } from "@/lib/portal";
import type { ClientVideoState, VideoListRow } from "@/lib/contentVideos";
import { portalHref, type PortalDest } from "@/lib/portalNav";
import { LIBRARY_FILTERS, type LibraryFilterKey } from "@/lib/portalWords";

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
  /** Selected this month and still missing answers (the v1 Home rule). */
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
    toAnswer: monthTopics.filter((x) => x.state !== "FILMED" && (!x.interview || x.interview.status !== "SUBMITTED")),
    scripts: active.filter(awaitingScript),
    decidedScripts,
    justDecided: decidedScripts.filter((x) => !!x.script?.decidedAtISO && now.getTime() - Date.parse(x.script.decidedAtISO) < JUST_DECIDED_MS),
    bank: active.filter((x) => inBank(x, open)),
  };
}

// ---- Home: one primary action ---------------------------------------------------

export type HomeActionKind =
  | "REVIEW_VIDEOS" | "APPROVE_SCRIPTS" | "READ_REPLY" | "ANSWER_QUESTIONS" | "BOOK_CALL"
  | "PICK_TOPICS" | "BOOK_SESSION" | "COMPLETE_ADDRESS" | "FINISH_SETUP" | "DOWNLOAD";

/**
 * The order a client should do things in. Reviews first — a video waiting on
 * them is the only item with a clock (CP-02) and the one that holds up
 * delivery; then the script decision that gates filming; then a reply from
 * the office; then the month's planning steps in the order the month runs.
 */
export const HOME_PRIORITY: readonly HomeActionKind[] = [
  "REVIEW_VIDEOS", "APPROVE_SCRIPTS", "READ_REPLY", "ANSWER_QUESTIONS", "BOOK_CALL",
  "PICK_TOPICS", "BOOK_SESSION", "COMPLETE_ADDRESS", "FINISH_SETUP", "DOWNLOAD",
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
  planning: { planningMode: string; callStatus: string } | null;
  month: { monthKey: string; label: string; owed: number; selected: number } | null;
  toAnswer: { title: string }[];
  session: { offerBooking: boolean; required: number; missing: number };
  /** Booked sessions still missing an exact filming address (CP-05). */
  addressNeeded: number;
  setup: { complete: boolean; remaining: number } | null;
  ready: { count: number; withFile: boolean; single: { id: string; title: string } | null };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Everything waiting on the client, most important first, as ONE primary
 * action and the rest. A paused or ended program starts nothing new, so it
 * gets no action but a reply to read.
 */
export function homeActions(i: HomeActionsInput, base = ""): { primary: HomeAction | null; more: HomeAction[] } {
  const out: HomeAction[] = [];
  const add = (a: Omit<HomeAction, "href"> & { extra?: string }) => out.push({ kind: a.kind, count: a.count, title: a.title, detail: a.detail, cta: a.cta, dest: a.dest, href: portalHref(base, a.dest, a.extra) });

  // A reply is something to read, not something to start: it reaches a paused account too.
  if (i.unread > 0) add({ kind: "READ_REPLY", count: i.unread, title: i.unread === 1 ? "A new reply from the team" : `${i.unread} new replies from the team`, detail: null, cta: "Read it", dest: "messages" });
  if (!i.readOnly && i.status === "ACTIVE") {
    if (i.review.count > 0 && (i.perms.approve || i.perms.request)) {
      add({
        kind: "REVIEW_VIDEOS", count: i.review.count,
        title: i.review.single ? `Review “${i.review.single.title}”` : `Review ${plural(i.review.count, "video")} waiting on you`,
        detail: i.review.soonestDeadlineLabel ? `Review by ${i.review.soonestDeadlineLabel}` : "Watch it, leave notes where you'd change something, or approve it.",
        cta: i.review.single ? "Review it" : "Review now", dest: "library", extra: i.review.single ? `v=${i.review.single.id}` : undefined,
      });
    }
    if (i.scripts.length > 0 && i.perms.suggest) {
      add({
        kind: "APPROVE_SCRIPTS", count: i.scripts.length,
        title: i.scripts.length === 1 ? `Read your script for “${i.scripts[0].title}”` : `Read ${plural(i.scripts.length, "script")} before we film`,
        detail: "Approve it as written, or tell us what to change.", cta: i.scripts.length === 1 ? "Read the script" : "Read the scripts", dest: "plan", extra: "pv=scripts",
      });
    }
    if (i.planning?.planningMode === "WRITTEN" && i.toAnswer.length > 0 && i.perms.suggest) {
      add({
        kind: "ANSWER_QUESTIONS", count: i.toAnswer.length,
        title: i.toAnswer.length === 1 ? `Answer the questions for “${i.toAnswer[0].title}”` : `Answer the questions for ${plural(i.toAnswer.length, "topic")}`,
        detail: "We write each script from your answers.", cta: "Answer now", dest: "plan",
      });
    }
    if (i.planning && i.planning.planningMode !== "WRITTEN" && i.planning.callStatus === "NOT_SCHEDULED" && i.perms.session) {
      add({ kind: "BOOK_CALL", count: 1, title: "Book your strategy call", detail: "We plan the month on it.", cta: "Book the call", dest: "schedule" });
    }
    if (i.month && i.month.selected < i.month.owed && i.perms.suggest) {
      const n = i.month.owed - i.month.selected;
      add({ kind: "PICK_TOPICS", count: n, title: `Pick ${plural(n, "more topic")} for ${i.month.label}`, detail: `${i.month.selected} of ${i.month.owed} chosen.`, cta: "Pick topics", dest: "plan", extra: "pv=bank" });
    }
    if (i.session.offerBooking && i.perms.session) {
      const booked = i.session.required - i.session.missing;
      add({ kind: "BOOK_SESSION", count: i.session.missing, title: i.session.required > 1 && booked > 0 ? `Book your next filming session (${booked} of ${i.session.required} booked)` : "Book your filming session", detail: null, cta: "Book a session", dest: "schedule" });
    }
    if (i.addressNeeded > 0 && i.perms.session) {
      add({ kind: "COMPLETE_ADDRESS", count: i.addressNeeded, title: i.addressNeeded === 1 ? "Add the exact address for your session" : `Add the exact address for ${plural(i.addressNeeded, "session")}`, detail: "So your photographer arrives at the right door.", cta: "Add the address", dest: "schedule" });
    }
    if (i.setup && !i.setup.complete && i.setup.remaining > 0 && i.perms.profile) {
      add({ kind: "FINISH_SETUP", count: i.setup.remaining, title: `Finish setting up your account (${plural(i.setup.remaining, "step")} left)`, detail: "Your editor uses these on every video.", cta: "Continue setup", dest: "brand" });
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
