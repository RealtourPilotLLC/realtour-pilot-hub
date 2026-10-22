"use client";

import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, CheckCircle2, ChevronRight, Lightbulb, Loader2, Plus, ScrollText, Sparkles, ThumbsDown, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalDeclineTopic, portalOpenInterview, portalRemoveSelection, portalSelectTopic, portalSuggestTopic, portalUndeclineTopic } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { ScriptView } from "@/components/script/ScriptView";
import { ScriptApprovalCard } from "@/components/portal/ScriptApprovalCard";
import { TopicQuestions } from "@/components/portal/TopicQuestions";
import { StatusChip } from "@/components/portal/ui";
import { awaitingScript, filmedScript, inBank } from "@/lib/portalHome";
import { CTA_WORDS, SCRIPT_WORDS, TOPIC_WORDS, answerCta, filmedWords, planStepWord } from "@/lib/portalWords";
import type { PortalTopic, PortalTopicMonth, PortalTopicState } from "@/lib/portal";
import { portalMonthHref } from "@/lib/portalScheduling";

// ---------------------------------------------------------------------------
// VIDEO TOPICS (spec §5): the client's bank by their pillars, in the
// presentation their strategist uses (pillar heading, purpose, numbered
// topics with a one-line concept, and — since Sep 18 — the SCRIPT itself once
// it is released). Filters: Suggested / Selected for a month
// / Preparing / Filmed (+ how many are archived, kept internally). Select for
// a NAMED month, remove an uncommitted selection, suggest an idea, discuss —
// each a server action that re-reads the page. Capacity is explained, never
// enforced by deleting: an extra becomes overflow that waits its turn.
//
// CP-07 (Sep 24 2026): "Scripted, not filmed" comes first — a carried-over
// script can be swapped for another topic (the script is kept), a parked one
// can be used for a month. "Not interested" (with an optional reason) sets a
// suggestion aside, with undo in the strip below the bank. Your own idea can
// go straight into a month and on to its questions.
//
// C14 (Oct 13 2026, Jordan: simplify the portal): the client sees "Choose
// this topic" and "Suggest an idea". The filter chips, "Discuss", "Not
// interested" (and its reason box), the "Scripted, not filmed" swap strip and
// each topic's "More about this topic" history are hidden — UI only: the
// server actions and the data behind them are unchanged, and a carried-over
// script now sits in its month's list like any other chosen topic.
//
// UI-01 (Sep 24 2026): `view` splits the one long page for Your Month —
// "month" is one month's selections (and what carried into it), "bank" is
// everything not on an open month's plan, filtered to Suggested by default.
// Both keep scripts folded unless a #topic-<id> link points at one, put each
// action's result INSIDE the topic card that produced it, and give phones
// 44px buttons. The old layout's one long page ("all") went with that layout
// (Oct 6 2026).
//
// Oct 20 2026 (Jordan: "10-15 video topics per content pillar ... Then, more
// ideas beneath it ... Add an 'I don't like this one'"): in the bank each
// pillar lists its first PER_PILLAR topics (the ones they can choose first)
// and folds the rest under "More ideas"; topics with no pillar sit at the
// bottom, folded the same way. "I don't like this one" is the CP-07 decline
// (portalDeclineTopic, no reason asked): the topic leaves their list, no
// refresh offers it again, and the card stays put with an Undo until they
// move on.
// ---------------------------------------------------------------------------

const subscribeHash = (cb: () => void) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); };
const readHash = () => window.location.hash;

const FILTERS: { key: PortalTopicState | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" }, { key: "SUGGESTED", label: "Suggested" }, { key: "SELECTED", label: "Selected for a month" }, { key: "PREPARING", label: "Preparing" }, { key: "FILMED", label: "Filmed" },
];
// The bank is everything NOT on an open month's plan, so "Selected for a
// month" and "Preparing" there were always 0 while the month held four — and
// tapping one told a client with four topics chosen that they had none
// (Sep 24). The bank offers what can be in it; the month view holds the rest.
const BANK_FILTER_KEYS: readonly (PortalTopicState | "ALL")[] = ["ALL", "SUGGESTED", "FILMED"];
/** How many topics a pillar lists in the bank before the rest fold under "More ideas". */
const PER_PILLAR = 15;
const monthLabel = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" }); };
const shortMonth = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short" }); };

export function TopicBank({ groups, months, total, canAct, readOnly, initialFilter, tabHref, view, initialMonthId = null, scriptsHref = null, staff = false, canApprove = false }: {
  groups: { pillarId: string | null; pillarName: string; purpose: string | null; topics: PortalTopic[] }[];
  months: PortalTopicMonth[];
  archivedCount: number;
  total: number;
  strategyLabel: string | null;
  canAct: boolean;
  readOnly: boolean;
  initialFilter: string | undefined;
  /** Base href of this tab (query-only), to which `&topic=` is appended for the interview. */
  tabHref: string;
  /** Your Month's subviews: one month's plan, or the bank. */
  view: "month" | "bank";
  /** The month the month view opens on (this ET month). */
  initialMonthId?: string | null;
  /** Your Month's Scripts view, where a script waiting on the client is read and answered. */
  scriptsHref?: string | null;
  /** Oct 15 2026: the Realtour Pilot team is viewing (they may ask for one topic in writing). */
  staff?: boolean;
  /** Oct 20 2026 (audit E1): may approve scripts (the account owner). */
  canApprove?: boolean;
}) {
  const router = useRouter();
  const [filter] = useState<PortalTopicState | "ALL">(FILTERS.some((f) => f.key === initialFilter) ? (initialFilter as PortalTopicState | "ALL") : "ALL");
  const [monthId, setMonthId] = useState<string | null>((initialMonthId && months.some((m) => m.id === initialMonthId) ? initialMonthId : null) ?? months.find((m) => m.selected < m.owed)?.id ?? months[0]?.id ?? null);
  const [suggesting, setSuggesting] = useState(false);
  const [idea, setIdea] = useState({ title: "", concept: "", pillarId: "" });
  /** The last result, and the topic whose card it belongs in. */
  const [msg, setMsg] = useState<{ ok: boolean; text: string; topicId?: string | null } | null>(null);
  /** The topic the running action belongs to — its card says "Saving…". */
  const [pending, setPending] = useState<string | null>(null);
  /** A #topic-<id> link names a topic: its script opens, and the bank shows it whatever the filter. */
  const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
  /** Their own idea goes straight into the month unless they untick it (on by default while the month has room). */
  const [useForMonth, setUseForMonth] = useState<boolean>(() => { const m = months.find((x) => x.selected < x.owed); return !!m; });
  const [justAdded, setJustAdded] = useState<{ topicId: string; monthId: string } | null>(null);
  /** 6.3: the recommendation strip's "Choose another topic" opens the alternatives. */
  const [showAlternatives, setShowAlternatives] = useState(false);
  /** The topic they just said "I don't like this one" to: its card stays, with Undo. */
  const [justDeclined, setJustDeclined] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const month = months.find((m) => m.id === monthId) ?? null;
  const done = (r: { ok: boolean; message: string }, topicId: string | null = null) => { setMsg({ ok: r.ok, text: r.message, topicId }); if (r.ok) router.refresh(); };
  const act = (topicId: string | null, fn: () => Promise<void>) => { setPending(topicId); start(fn); };
  const openIds = useMemo(() => new Set(months.map((m) => m.id)), [months]);
  const targetId = hash.startsWith("#topic-") ? hash.slice("#topic-".length) : null;

  // Topics they set aside live in their pillar's group flagged `declined`: the
  // bank and its counts leave them out; the strip below the bank lists them.
  const active = useMemo(() => groups.map((g) => ({ ...g, topics: g.topics.filter((t) => !t.declined || t.id === justDeclined) })), [groups, justDeclined]);
  const setAside = useMemo(() => groups.flatMap((g) => g.topics.filter((t) => t.declined && t.id !== justDeclined)), [groups, justDeclined]);
  // The bank view keeps a topic a #topic- link points at in view: the filter
  // steps back to All for it (C14: there are no chips to pick another).
  // An address asking the bank for a month-only filter (?filter=SELECTED) lands on All.
  const bankFilter: PortalTopicState | "ALL" = view === "bank" && !BANK_FILTER_KEYS.includes(filter) ? "ALL" : filter;
  const effFilter: PortalTopicState | "ALL" = view === "bank" && targetId && active.some((g) => g.topics.some((t) => t.id === targetId && !t.scriptedNotFilmed && !(bankFilter === "ALL" || (t.state === bankFilter && inBank(t, openIds))))) ? "ALL" : bankFilter;
  // KEEPS THE CARD THE CLIENT JUST ACTED ON (Sep 24): its "Selected for
  // September" / "Removed" line lives inside the card, and the refresh that
  // follows moves the topic out of the view it was in — so the card, and the
  // only confirmation, vanished. It stays until they change the month.
  const justActed = (t: PortalTopic) => !!msg?.topicId && msg.topicId === t.id;
  const shows = (t: PortalTopic) =>
    justActed(t) || (view === "month" ? !!month && t.selection?.monthId === month.id : (inBank(t, openIds) || t.id === targetId) && (effFilter === "ALL" || t.state === effFilter));
  const visible = active.map((g) => ({ ...g, topics: g.topics.filter(shows) })).filter((g) => g.topics.length > 0);
  // 6.3 RECOMMENDED FOR THIS MONTH (month view only): the ranking's picks for
  // the slots still open, each with the one line about why, then the
  // alternatives behind "Choose another topic". The server already cut them to
  // the open slots and to topics this client may see and could choose.
  const recsHere = useMemo(() => {
    if (view !== "month" || !month) return { top: [] as { t: PortalTopic; pillarName: string }[], alt: [] as { t: PortalTopic; pillarName: string }[] };
    const all = active.flatMap((g) => g.topics.filter((t) => t.recommended?.monthId === month.id && !t.selection).map((t) => ({ t, pillarName: g.pillarName })));
    const byRank = (a: { t: PortalTopic }, b: { t: PortalTopic }) => (a.t.recommended?.rank ?? 0) - (b.t.recommended?.rank ?? 0);
    return { top: all.filter((x) => x.t.recommended?.kind === "RECOMMENDED").sort(byRank), alt: all.filter((x) => x.t.recommended?.kind === "ALTERNATIVE").sort(byRank) };
  }, [active, view, month]);
  /** Carried-over scripts already using this month's videos (they count first). */
  const carriedHere = month ? active.reduce((n, g) => n + g.topics.filter((t) => !!t.carried && t.selection?.monthId === month.id).length, 0) : 0;
  /** The bank view's pointer to what is chosen: those topics live on the month view. */
  const chosenThisMonth = view === "bank" && month ? active.reduce((n, g) => n + g.topics.filter((t) => !t.scriptedNotFilmed && t.selection?.monthId === month.id).length, 0) : 0;

  const select = (topicId: string) => { if (!month) return; act(topicId, async () => done(await portalSelectTopic(portalAuthFromLocation(), topicId, month.id).catch(() => ({ ok: false, message: "That didn't save. Try again." })), topicId)); };
  const remove = (t: PortalTopic) => { if (!t.selection) return; act(t.id, async () => done(await portalRemoveSelection(portalAuthFromLocation(), t.id, t.selection!.monthId).catch(() => ({ ok: false, message: "That didn't save. Try again." })), t.id)); };
  const openQuestions = (t: PortalTopic) => {
    const mId = t.selection?.monthId ?? month?.id;
    if (!mId) return;
    act(t.id, async () => {
      const r = await portalOpenInterview(portalAuthFromLocation(), t.id, mId).catch(() => ({ ok: false, message: "Couldn't open the questions. Try again." }));
      if (r.ok && "id" in r && r.id) router.push(`${tabHref}&iv=${encodeURIComponent(r.id)}`);
      else setMsg({ ok: false, text: r.message, topicId: t.id });
    });
  };
  // R1 — the script decision lives in ScriptApprovalCard, which sends the
  // version THIS PAGE rendered; the bank only lends it its status line.
  const suggest = () => act(null, async () => {
    const r: { ok: boolean; message: string; id?: string; monthId?: string | null; selected?: boolean } = await portalSuggestTopic(portalAuthFromLocation(), { title: idea.title, concept: idea.concept, pillarId: idea.pillarId || null, monthId: useForMonth && month ? month.id : null }).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    if (r.ok) { setIdea({ title: "", concept: "", pillarId: "" }); setSuggesting(false); }
    setJustAdded(r.ok && r.selected && r.id && r.monthId ? { topicId: r.id, monthId: r.monthId } : null);
    done(r);
  });
  const answerJustAdded = () => {
    if (!justAdded) return;
    act(null, async () => {
      const r = await portalOpenInterview(portalAuthFromLocation(), justAdded.topicId, justAdded.monthId).catch(() => ({ ok: false, message: "Couldn't open the questions. Try again." }));
      if (r.ok && "id" in r && r.id) router.push(`${tabHref}&iv=${encodeURIComponent(r.id)}`);
      else setMsg({ ok: false, text: r.message });
    });
  };
  const undecline = (topicId: string) => act(null, async () => done(await portalUndeclineTopic(portalAuthFromLocation(), topicId).catch(() => ({ ok: false, message: "That didn't save. Try again." }))));
  const decline = (topicId: string) => act(topicId, async () => {
    const r = await portalDeclineTopic(portalAuthFromLocation(), topicId, null).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    // In the bank the card stays with its Undo; the month's recommendation
    // strip has no card left to hold it, so the line shows above and Undo
    // waits in the strip below.
    const inCard = view === "bank";
    if (r.ok && inCard) setJustDeclined(topicId);
    done(r, inCard ? topicId : null);
  });
  /** Undo from the card itself, right after "I don't like this one". */
  const undoDecline = (topicId: string) => act(topicId, async () => {
    const r = await portalUndeclineTopic(portalAuthFromLocation(), topicId).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    if (r.ok) setJustDeclined(null);
    done(r, topicId);
  });
  /** A topic they could still choose, and so could still turn down. */
  const canDecline = (t: PortalTopic) => canAct && !readOnly && !t.selection && !t.declined && t.state === "SUGGESTED";
  const dislikeButton = (t: PortalTopic) => (
    <button type="button" onClick={() => decline(t.id)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><ThumbsDown className="size-3" aria-hidden /> I don&rsquo;t like this one</button>
  );
  /** Bigger targets on a phone, the compact size from sm up. */
  const tap = "min-h-11 px-3 text-xs sm:min-h-0 sm:px-2 sm:text-[11px]";
  /** The result of an action on THIS topic, inside its card. */
  const cardStatus = (topicId: string) => (
    <>
      {busy && pending === topicId && <p role="status" className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted"><Loader2 className="size-3 animate-spin" /> Saving…</p>}
      {!busy && msg?.topicId === topicId && <p role="status" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </>
  );

  /** One topic in the bank (or the month's list), numbered within its pillar. */
  const topicCard = (t: PortalTopic, i: number) => {
    // Just turned down: the card stays where it was, with Undo, until they move on.
    if (t.declined) {
      return (
        <li key={t.id} id={`topic-${t.id}`} className="scroll-mt-20 rounded-xl border border-dashed border-border bg-surface/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 break-words text-sm text-muted line-through">{t.title}</span>
            {canAct && !readOnly && <button type="button" onClick={() => undoDecline(t.id)} disabled={busy} className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Undo2 className="size-3" /> Undo</button>}
          </div>
          {cardStatus(t.id)}
        </li>
      );
    }
    const selectedHere = t.selection && month && t.selection.monthId === month.id;
    const canSelect = canAct && !readOnly && !!month && !t.selection;
    return (
      // The id is the interview page's "Read my script" target:
      // that panel links to #topic-<id> rather than telling the
      // client to go and find it.
      <li key={t.id} id={`topic-${t.id}`} className="scroll-mt-20 rounded-xl border border-border bg-surface px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-muted-2 tabular-nums">{i + 1}.</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold">{t.title}</span>
              {/* R01 / §11: a topic on an open month reads its step in the month
                  ("We need one more answer", "Our team is reviewing") — the
                  server's, so it survives a refresh; the bank keeps its states. */}
              <StatusChip word={t.plan ? planStepWord(t.plan.step, t.plan.missing) : TOPIC_WORDS[t.state]} />
              {!t.plan && awaitingScript(t) && <StatusChip word={SCRIPT_WORDS.AWAITING} />}
              {/* Oct 22 2026: filmed before they approved it — said once, with the day when known. */}
              {filmedScript(t) && (t.plan ? t.plan.step !== "FILMED" : t.state !== "FILMED") && <StatusChip word={{ ...SCRIPT_WORDS.FILMED, label: filmedWords(t.script?.filmed?.atISO) }} />}
              {t.mine && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">your idea</span>}
              {t.selection && <span className="text-[11px] text-muted-2">{t.selection.status === "PROPOSED" ? "proposed on your call for" : "for"} {shortMonth(t.selection.monthKey)}{t.selection.overflow ? " (extra)" : ""}</span>}
            </div>
            {t.concept && <p className="mt-0.5 text-xs text-muted">{t.concept}</p>}
            {/* THE SCRIPT. The server sends words only when
                postingKit.scriptVisibility says this client may
                read them, so there is nothing to decide here — if
                it arrived, it is theirs. A released script opens on
                arrival (the client was sent here to read it); an
                import stays closed behind its own label, because an
                old script we hold is not this topic's script and
                must never be mistaken for one (Jordan's ruling). */}
            {t.scriptText && (
              <details className="mt-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2" open={targetId === t.id}>
                <summary className="cursor-pointer text-xs font-bold">
                  {t.scriptText.historical ? "An earlier script we have on file" : "Your script"}
                  <span className="ml-1 text-[10px] font-normal text-muted-2">
                    {t.scriptText.historical ? "history" : t.scriptText.versionLabel ? `script ${t.scriptText.versionLabel}` : "script"}
                  </span>
                </summary>
                {t.scriptText.historical && <p className="mt-1.5 text-[11px] text-muted">Kept as history. It&rsquo;s a script we already have for this topic, not the one we&rsquo;re writing for your next video.</p>}
                <ScriptView body={t.scriptText.body} parts={t.scriptText.parts ?? null} pillarName={t.scriptText.pillarName ?? null} size="xs" fileTitle={t.title} textDownload={t.scriptText.historical || !t.script?.shared} />
                {/* THE CLIENT'S OWN VERDICT (F09). Only on a script
                    that is genuinely shared with them — an import we
                    hold as history is not theirs to approve, and a
                    draft they cannot see has nothing to approve. */}
                {!t.scriptText.historical && t.script?.shared && canAct && !readOnly && (
                  <ScriptApprovalCard script={t.script} parts={t.scriptText.parts ?? null} onResult={(r) => done(r, t.id)} run={(fn) => act(t.id, fn)} busy={busy} large canApprove={canApprove} />
                )}
              </details>
            )}
            {/* Actions */}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {canSelect && <button type="button" onClick={() => select(t.id)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Plus className="size-3" /> {CTA_WORDS.CHOOSE}</button>}
              {canDecline(t) && dislikeButton(t)}
              {t.selection && t.selection.removable && canAct && !readOnly && <button type="button" onClick={() => remove(t)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-danger disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><X className="size-3" /> Remove from {shortMonth(t.selection.monthKey)}</button>}
              {t.selection && !t.selection.removable && t.state !== "FILMED" && <span className="inline-flex items-center gap-1 text-[11px] text-muted-2"><CheckCircle2 className="size-3" /> Locked in. Send us a message to change it.</span>}
              {/* R01: no questions offered for what nobody owes — an extra waiting
                  its turn, a topic the booked call covers, a call's proposal —
                  unless they already started them. */}
              {(t.selection || selectedHere) && t.state !== "FILMED" && canAct && !readOnly && (t.interview || !t.plan || !["EXTRA", "ON_CALL", "CONFIRMING"].includes(t.plan.step)) && (!t.questions || t.plan?.step === "NEEDS_MORE") && (
                <button type="button" onClick={() => openQuestions(t)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-brand/30 px-2 py-1 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}>
                  {t.plan?.step === "NEEDS_MORE" ? answerCta(t.plan.missing) : t.interview ? (t.interview.status === "SUBMITTED" ? "Your answers" : t.interview.answered > 0 ? "Continue answering" : CTA_WORDS.ANSWER) : CTA_WORDS.ANSWER} <ChevronRight className="size-3" />
                </button>
              )}
              {/* A script waiting on them is answered in Your Month › Scripts, with the words in front of them. */}
              {scriptsHref && awaitingScript(t) && canAct && !readOnly && <Link href={`${scriptsHref}#script-${t.id}`} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><ScrollText className="size-3" /> {CTA_WORDS.REVIEW}</Link>}
            </div>
            {/* Oct 15 2026: the questions open underneath the chosen topic. */}
            {view === "month" && t.selection && <TopicQuestions t={t} canAct={canAct} readOnly={readOnly} staff={staff} tabHref={tabHref} />}
            {cardStatus(t.id)}
          </div>
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      {/* Month + capacity, explained */}
      {months.length > 0 && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">{canAct && !readOnly ? "Selecting for" : "Planned for"}</div>
            {months.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Which month">
                {months.map((m) => (
                  <button key={m.id} type="button" role="tab" aria-selected={m.id === monthId} onClick={() => { setMonthId(m.id); setMsg(null); setJustDeclined(null); router.replace(portalMonthHref(tabHref, m.monthKey), { scroll: false }); }} className={cn("rounded-lg border px-2.5 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", m.id === monthId ? "border-brand bg-brand-action text-white" : "border-border bg-surface text-muted hover:text-foreground", "min-h-11 sm:min-h-0")}>{monthLabel(m.monthKey)}</button>
                ))}
              </div>
            )}
          </div>
          {month && (() => {
            // "4 of 2 chosen" is not a sentence anyone should read about their
            // own account. When more topics are selected than the month owes,
            // the surplus IS the overflow — derived here from the two numbers on
            // screen rather than from a per-row flag frozen at insert time,
            // which a package change leaves stale (review, Sep 17).
            const waiting = month.overflow;
            return (
              <p className="mt-1.5 text-sm">
                <span className="font-semibold">{monthLabel(month.monthKey)}</span>: {month.selected} of {month.owed} video{month.owed === 1 ? "" : "s"} chosen
                {carriedHere > 0 && <span className="text-muted"> · {carriedHere} carried over</span>}
                {waiting > 0 && <span className="text-muted"> · {waiting} more waiting (your package covers {month.owed} a month; extras stay in line, nothing is thrown away)</span>}
                {month.selected < month.owed && <span className="text-muted"> · pick {month.owed - month.selected} more</span>}
              </p>
            );
          })()}
        </div>
      )}
      {recsHere.top.length > 0 && month && (
        <section className="panel-shadow rounded-2xl border border-brand/30 bg-surface/70 p-4 backdrop-blur" aria-label={`Recommended for ${monthLabel(month.monthKey)}`}>
          <h2 className="flex items-center gap-1.5 text-base font-semibold"><Sparkles className="size-4 text-brand" aria-hidden /> Recommended for {monthLabel(month.monthKey)}</h2>
          <p className="text-xs text-muted">Picked from your topic bank for the {Math.max(0, month.owed - month.selected)} video{month.owed - month.selected === 1 ? "" : "s"} still open{carriedHere > 0 ? " (your carried-over scripts are counted first)" : ""}. Choose these, or choose another topic.</p>
          <ul className="mt-3 space-y-2">
            {recsHere.top.map(({ t, pillarName }) => (
              <li key={t.id} id={`topic-${t.id}`} className="scroll-mt-20 rounded-xl border border-border bg-surface px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-words text-sm font-semibold">{t.title}</span>
                  {t.pillarId && pillarName && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">{pillarName}</span>}
                </div>
                {t.concept && <p className="mt-0.5 text-xs text-muted">{t.concept}</p>}
                {t.recommended?.reason && <p className="mt-1 text-xs text-foreground/80"><span className="font-semibold">Why this one: </span>{t.recommended.reason}</p>}
                {canAct && !readOnly && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => select(t.id)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Plus className="size-3" /> Choose this topic</button>
                    {canDecline(t) && dislikeButton(t)}
                  </div>
                )}
                {cardStatus(t.id)}
              </li>
            ))}
          </ul>
          {canAct && !readOnly && (
            <div className="mt-2">
              <button type="button" onClick={() => setShowAlternatives((v) => !v)} aria-expanded={showAlternatives} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}>
                <ArrowLeftRight className="size-3" /> Choose another topic
              </button>
              {showAlternatives && (
                recsHere.alt.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {recsHere.alt.map(({ t }) => (
                      <li key={t.id} className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-surface px-2.5 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="break-words text-sm font-medium">{t.title}</div>
                          {t.recommended?.reason && <div className="text-[11px] text-muted">{t.recommended.reason}</div>}
                          {cardStatus(t.id)}
                        </div>
                        <button type="button" onClick={() => select(t.id)} disabled={busy} className={cn("shrink-0 rounded-md bg-brand-action px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}>Choose this topic</button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted">Any topic in your topic bank can be chosen instead, or suggest an idea of your own below.</p>
                )
              )}
            </div>
          )}
        </section>
      )}
      {months.length === 0 && <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Your next program month isn&rsquo;t open yet. You can still read your topics, and choosing opens when the month does.</p>}

      {chosenThisMonth > 0 && month && (
        <p className="text-xs text-muted">
          {chosenThisMonth} chosen for {monthLabel(month.monthKey)}.{" "}
          <Link href={tabHref} className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline">See them on this month <ChevronRight className="size-3" aria-hidden /></Link>
        </p>
      )}

      {/* Only results that have no topic card to sit in. */}
      {msg && !msg.topicId && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
      {justAdded && canAct && !readOnly && (
        <button type="button" onClick={answerJustAdded} disabled={busy} className={cn("inline-flex items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", "min-h-11")}>{CTA_WORDS.ANSWER} for it now <ChevronRight className="size-3.5" /></button>
      )}


      {/* The bank, by pillar */}
      {total === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/70 p-6 text-center text-sm text-muted">
          <Lightbulb className="mx-auto size-6 text-muted-2" />
          <p className="mt-2">Your topic bank is being built from your strategy. Meanwhile, add any idea you already have below.</p>
        </div>
      ) : visible.length === 0 ? (
        view === "month" ? (
          <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">{month ? <>No topics chosen for {monthLabel(month.monthKey)} yet.{canAct && !readOnly ? " Pick them from your topic bank, or suggest your own idea below." : ""}</> : "Your next program month isn’t open yet."}</p>
        ) : (
          <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">No new ideas in your topic bank right now.{canAct && !readOnly ? " Suggest one of your own below." : ""}</p>
        )
      ) : (
        visible.map((g) => {
          // The bank lists what they can choose first, PER_PILLAR to a pillar;
          // the rest (and everything with no pillar) folds under "More ideas".
          const choosable = (t: PortalTopic) => t.state === "SUGGESTED" && !t.selection;
          const ordered = view === "bank" ? [...g.topics.filter(choosable), ...g.topics.filter((t) => !choosable(t))] : g.topics;
          const cap = view === "bank" ? (g.pillarId ? PER_PILLAR : 0) : ordered.length;
          const shown = ordered.slice(0, cap);
          const more = ordered.slice(cap);
          return (
            <section key={g.pillarId ?? "none"} className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
              {g.pillarId || view !== "bank" ? (
                <>
                  <h2 className="text-base font-semibold">{g.pillarName}</h2>
                  {g.purpose && <p className="text-xs text-muted">Purpose: {g.purpose}</p>}
                  {shown.length > 0 && <ol className="mt-3 space-y-2">{shown.map((t, i) => topicCard(t, i))}</ol>}
                  {more.length > 0 && (
                    <details className="mt-3" open={!!targetId && more.some((t) => t.id === targetId)}>
                      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-muted hover:text-foreground sm:min-h-0">More ideas ({more.length})</summary>
                      <ol start={shown.length + 1} className="mt-2 space-y-2">{more.map((t, i) => topicCard(t, shown.length + i))}</ol>
                    </details>
                  )}
                </>
              ) : (
                <details open={!!targetId && more.some((t) => t.id === targetId)}>
                  <summary className="min-h-11 cursor-pointer text-base font-semibold sm:min-h-0">{g.pillarName} <span className="text-sm font-normal text-muted">({more.length})</span></summary>
                  <ol className="mt-3 space-y-2">{more.map((t, i) => topicCard(t, i))}</ol>
                </details>
              )}
            </section>
          );
        })
      )}

      {/* What they set aside — kept, with undo */}
      {setAside.length > 0 && (
        <details className="rounded-2xl border border-border bg-surface/70 p-4 text-sm">
          <summary className="cursor-pointer text-xs font-semibold text-muted">You turned down {setAside.length} topic{setAside.length === 1 ? "" : "s"}. We won&rsquo;t suggest {setAside.length === 1 ? "it" : "them"} again.</summary>
          <ul className="mt-2 space-y-1.5">
            {setAside.map((t) => (
              <li key={t.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{t.title}</div>
                  {t.declined?.reason && <div className="text-[11px] text-muted-2">&ldquo;{t.declined.reason}&rdquo;</div>}
                </div>
                {canAct && !readOnly && <button type="button" onClick={() => undecline(t.id)} disabled={busy} className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Undo2 className="size-3" /> Undo</button>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Suggest an idea */}
      {canAct && !readOnly && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          {!suggesting ? (
            <button type="button" onClick={() => setSuggesting(true)} className={cn("inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", "min-h-11")}><Lightbulb className="size-4" /> Suggest a video idea of your own</button>
          ) : (
            <div className="space-y-2">
              <div className="text-sm font-semibold">Your idea</div>
              <input value={idea.title} onChange={(e) => setIdea({ ...idea, title: e.target.value })} placeholder="Title, e.g. Why I tell sellers to skip the kitchen remodel" aria-label="Idea title" className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm" />
              <textarea value={idea.concept} onChange={(e) => setIdea({ ...idea, concept: e.target.value })} rows={2} placeholder="One line on the angle (optional)" aria-label="Idea concept" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm" />
              {groups.some((g) => g.pillarId) && (
                <select value={idea.pillarId} onChange={(e) => setIdea({ ...idea, pillarId: e.target.value })} aria-label="Topic area" className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm">
                  <option value="">Topic area (optional)</option>
                  {groups.filter((g) => g.pillarId).map((g) => <option key={g.pillarId!} value={g.pillarId!}>{g.pillarName}</option>)}
                </select>
              )}
              {month && (
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={useForMonth} onChange={(e) => setUseForMonth(e.target.checked)} className="size-3.5 accent-brand" />
                  Use it for {monthLabel(month.monthKey)}{month.selected >= month.owed ? " (as an extra, since that month is full)" : ""}
                </label>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={suggest} disabled={busy || idea.title.trim().length < 3} className={cn("inline-flex items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", "min-h-11")}>{busy && <Loader2 className="size-3.5 animate-spin" />} {useForMonth && month ? `Add it for ${shortMonth(month.monthKey)}` : "Add to my bank"}</button>
                <button type="button" onClick={() => setSuggesting(false)} className={cn("rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", "min-h-11")}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
