"use client";

import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Ban, CheckCircle2, ChevronRight, Lightbulb, Loader2, MessageSquare, Plus, ScrollText, Sparkles, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalDeclineTopic, portalDiscussTopic, portalOpenInterview, portalRemoveSelection, portalSelectTopic, portalSuggestTopic, portalSwapCarriedTopic, portalUndeclineTopic } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { ScriptView } from "@/components/script/ScriptView";
import { ScriptApprovalCard } from "@/components/portal/ScriptApprovalCard";
import { StatusChip } from "@/components/portal/ui";
import { awaitingScript, inBank } from "@/lib/portalHome";
import { CTA_WORDS, SCRIPT_WORDS, TEXT_KYLE, TOPIC_WORDS, answerCta, planStepWord } from "@/lib/portalWords";
import type { PortalTopic, PortalTopicMonth, PortalTopicState } from "@/lib/portal";

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
// UI-01 (Sep 24 2026): `view` splits the one long page for the v2 layout's
// My Plan — "month" is one month's selections (and what carried into it),
// "bank" is everything not on an open month's plan, filtered to Suggested
// by default. Both keep scripts folded unless a #topic-<id> link points at
// one, put each action's result INSIDE the topic card that produced it, and
// give phones 44px buttons. "all" (the default) is today's page, unchanged.
// ---------------------------------------------------------------------------

const subscribeHash = (cb: () => void) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); };
const readHash = () => window.location.hash;

const FILTERS: { key: PortalTopicState | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" }, { key: "SUGGESTED", label: "Suggested" }, { key: "SELECTED", label: "Selected for a month" }, { key: "PREPARING", label: "Preparing" }, { key: "FILMED", label: "Filmed" },
];
// The v2 bank is everything NOT on an open month's plan, so "Selected for a
// month" and "Preparing" there were always 0 while the month held four — and
// tapping one told a client with four topics chosen that they had none
// (Sep 24). The bank offers what can be in it; the month view holds the rest.
const BANK_FILTER_KEYS: readonly (PortalTopicState | "ALL")[] = ["ALL", "SUGGESTED", "FILMED"];
const monthLabel = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" }); };
const shortMonth = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short" }); };
const STATE_CHIP: Record<PortalTopicState, { label: string; cls: string }> = {
  SUGGESTED: { label: "Suggested", cls: "bg-surface-2 text-muted" },
  SELECTED: { label: "Selected", cls: "bg-brand-soft text-brand" },
  PREPARING: { label: "Preparing", cls: "bg-warning-soft text-warning" },
  FILMED: { label: "Filmed", cls: "bg-success-soft text-success" },
};

export function TopicBank({ groups, months, archivedCount, total, strategyLabel, canAct, readOnly, initialFilter, tabHref, view = "all", initialMonthId = null, scriptsHref = null }: {
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
  /** "all" = the v1 page; "month" / "bank" = My Plan's subviews (v2). */
  view?: "all" | "month" | "bank";
  /** The month the month view opens on (v2: this ET month). */
  initialMonthId?: string | null;
  /** My Plan's Scripts view, where a script waiting on the client is read and answered (v2). */
  scriptsHref?: string | null;
}) {
  const router = useRouter();
  const v2 = view !== "all";
  const [filter, setFilter] = useState<PortalTopicState | "ALL">(FILTERS.some((f) => f.key === initialFilter) ? (initialFilter as PortalTopicState | "ALL") : "ALL");
  const [monthId, setMonthId] = useState<string | null>((initialMonthId && months.some((m) => m.id === initialMonthId) ? initialMonthId : null) ?? months.find((m) => m.selected < m.owed)?.id ?? months[0]?.id ?? null);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [idea, setIdea] = useState({ title: "", concept: "", pillarId: "" });
  /** The last result, and (v2) the topic whose card it belongs in. */
  const [msg, setMsg] = useState<{ ok: boolean; text: string; topicId?: string | null } | null>(null);
  /** The topic the running action belongs to — its card says "Saving…". */
  const [pending, setPending] = useState<string | null>(null);
  /** A #topic-<id> link names a topic: its script opens, and the bank shows it whatever the filter. */
  const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
  const [filterTouched, setFilterTouched] = useState(false);
  /** Which suggestion's "not interested" box is open, and the optional reason. */
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  /** Which carried selection is being swapped, and for which topic. */
  const [swapping, setSwapping] = useState<string | null>(null);
  const [swapTo, setSwapTo] = useState("");
  /** Their own idea goes straight into the month unless they untick it (on by default while the month has room). */
  const [useForMonth, setUseForMonth] = useState<boolean>(() => { const m = months.find((x) => x.selected < x.owed); return !!m; });
  const [justAdded, setJustAdded] = useState<{ topicId: string; monthId: string } | null>(null);
  /** 6.3: the recommendation strip's "Choose another topic" opens the alternatives. */
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [busy, start] = useTransition();
  const month = months.find((m) => m.id === monthId) ?? null;
  const done = (r: { ok: boolean; message: string }, topicId: string | null = null) => { setMsg({ ok: r.ok, text: r.message, topicId }); if (r.ok) router.refresh(); };
  const act = (topicId: string | null, fn: () => Promise<void>) => { setPending(topicId); start(fn); };
  const openIds = useMemo(() => new Set(months.map((m) => m.id)), [months]);
  const targetId = v2 && hash.startsWith("#topic-") ? hash.slice("#topic-".length) : null;

  // Topics they set aside live in their pillar's group flagged `declined`: the
  // bank and its counts leave them out; the strip below the bank lists them.
  const active = useMemo(() => groups.map((g) => ({ ...g, topics: g.topics.filter((t) => !t.declined) })), [groups]);
  const setAside = useMemo(() => groups.flatMap((g) => g.topics.filter((t) => t.declined)), [groups]);
  // Which "Scripted, not filmed" rows this view shows: the month view the ones
  // carried into its month, the bank the ones not on any open month.
  const scriptedNotFilmed = useMemo(() => active.flatMap((g) => g.topics.filter((t) => t.scriptedNotFilmed && (view === "all" || (view === "month" ? t.selection?.monthId === monthId : inBank(t, openIds))))), [active, view, monthId, openIds]);
  /** What a carried script can be swapped for: unplanned topics still in the bank. */
  const swapOptions = useMemo(() => active.flatMap((g) => g.topics.filter((t) => !t.selection && !t.scriptedNotFilmed && t.state !== "FILMED")), [active]);
  // The bank view keeps a topic a #topic- link points at in view: the filter
  // steps back to All until the client picks one themselves.
  const filters = view === "bank" ? FILTERS.filter((f) => BANK_FILTER_KEYS.includes(f.key)) : FILTERS;
  // An address asking the bank for a month-only filter (?filter=SELECTED) lands on All.
  const bankFilter: PortalTopicState | "ALL" = view === "bank" && !BANK_FILTER_KEYS.includes(filter) ? "ALL" : filter;
  const effFilter: PortalTopicState | "ALL" = view === "bank" && !filterTouched && targetId && active.some((g) => g.topics.some((t) => t.id === targetId && !t.scriptedNotFilmed && !(bankFilter === "ALL" || (t.state === bankFilter && inBank(t, openIds))))) ? "ALL" : bankFilter;
  // v2 KEEPS THE CARD THE CLIENT JUST ACTED ON (Sep 24): its "Selected for
  // September" / "Removed" line lives inside the card, and the refresh that
  // follows moves the topic out of the view it was in — so the card, and the
  // only confirmation, vanished. It stays until they change the filter or month.
  const justActed = (t: PortalTopic) => v2 && !!msg?.topicId && msg.topicId === t.id;
  const shows = (t: PortalTopic) =>
    !t.scriptedNotFilmed && (justActed(t) || (view === "month" ? !!month && t.selection?.monthId === month.id : view === "bank" ? (inBank(t, openIds) || t.id === targetId) && (effFilter === "ALL" || t.state === effFilter) : filter === "ALL" || t.state === filter));
  const visible = active.map((g) => ({ ...g, topics: g.topics.filter(shows) })).filter((g) => g.topics.length > 0);
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: 0 };
    for (const g of active) for (const t of g.topics) {
      // The bank counts only what is IN the bank, so its chips add up.
      if (view === "bank" && (t.scriptedNotFilmed || !inBank(t, openIds))) continue;
      c.ALL++; c[t.state] = (c[t.state] ?? 0) + 1;
    }
    return c;
  }, [active, view, openIds]);
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

  const select = (topicId: string) => { if (!month) return; act(topicId, async () => done(await portalSelectTopic(portalAuthFromLocation(), topicId, month.id).catch(() => ({ ok: false, message: "That didn't save — try again." })), topicId)); };
  const remove = (t: PortalTopic) => { if (!t.selection) return; act(t.id, async () => done(await portalRemoveSelection(portalAuthFromLocation(), t.id, t.selection!.monthId).catch(() => ({ ok: false, message: "That didn't save — try again." })), t.id)); };
  const discuss = (topicId: string) => act(topicId, async () => { const r = await portalDiscussTopic(portalAuthFromLocation(), topicId, note).catch(() => ({ ok: false, message: "That didn't send — try again." })); if (r.ok) { setNote(""); setOpenTopic(null); } done(r, topicId); });
  const openQuestions = (t: PortalTopic) => {
    const mId = t.selection?.monthId ?? month?.id;
    if (!mId) return;
    act(t.id, async () => {
      const r = await portalOpenInterview(portalAuthFromLocation(), t.id, mId).catch(() => ({ ok: false, message: "Couldn't open the questions — try again." }));
      if (r.ok && "id" in r && r.id) router.push(`${tabHref}&iv=${encodeURIComponent(r.id)}`);
      else setMsg({ ok: false, text: r.message, topicId: t.id });
    });
  };
  // R1 — the script decision lives in ScriptApprovalCard, which sends the
  // version THIS PAGE rendered; the bank only lends it its status line.
  const suggest = () => act(null, async () => {
    const r: { ok: boolean; message: string; id?: string; monthId?: string | null; selected?: boolean } = await portalSuggestTopic(portalAuthFromLocation(), { title: idea.title, concept: idea.concept, pillarId: idea.pillarId || null, monthId: useForMonth && month ? month.id : null }).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) { setIdea({ title: "", concept: "", pillarId: "" }); setSuggesting(false); }
    setJustAdded(r.ok && r.selected && r.id && r.monthId ? { topicId: r.id, monthId: r.monthId } : null);
    done(r);
  });
  const answerJustAdded = () => {
    if (!justAdded) return;
    act(null, async () => {
      const r = await portalOpenInterview(portalAuthFromLocation(), justAdded.topicId, justAdded.monthId).catch(() => ({ ok: false, message: "Couldn't open the questions — try again." }));
      if (r.ok && "id" in r && r.id) router.push(`${tabHref}&iv=${encodeURIComponent(r.id)}`);
      else setMsg({ ok: false, text: r.message });
    });
  };
  const decline = (topicId: string) => act(topicId, async () => {
    const r = await portalDeclineTopic(portalAuthFromLocation(), topicId, declineReason).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) { setDeclining(null); setDeclineReason(""); }
    // A topic set aside leaves the list, so its result has no card to sit in.
    done(r, r.ok ? null : topicId);
  });
  const undecline = (topicId: string) => act(null, async () => done(await portalUndeclineTopic(portalAuthFromLocation(), topicId).catch(() => ({ ok: false, message: "That didn't save — try again." }))));
  const swap = (selectionId: string, topicId: string) => act(topicId, async () => {
    const r = await portalSwapCarriedTopic(portalAuthFromLocation(), selectionId, swapTo).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) { setSwapping(null); setSwapTo(""); }
    done(r, r.ok ? null : topicId);
  });
  /** v2: bigger targets on a phone, today's size from sm up. */
  const tap = v2 ? "min-h-11 px-3 text-xs sm:min-h-0 sm:px-2 sm:text-[11px]" : "";
  /** v2: the result of an action on THIS topic, inside its card. */
  const cardStatus = (topicId: string) => v2 && (
    <>
      {busy && pending === topicId && <p role="status" className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted"><Loader2 className="size-3 animate-spin" /> Saving…</p>}
      {!busy && msg?.topicId === topicId && <p role="status" className={cn("mt-1.5 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </>
  );

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
                  <button key={m.id} type="button" role="tab" aria-selected={m.id === monthId} onClick={() => { setMonthId(m.id); setMsg(null); }} className={cn("rounded-lg border px-2.5 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", m.id === monthId ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground", v2 && "min-h-11 sm:min-h-0")}>{monthLabel(m.monthKey)}</button>
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
                <span className="font-semibold">{monthLabel(month.monthKey)}</span> — {month.selected} of {month.owed} video{month.owed === 1 ? "" : "s"} chosen
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
                    <button type="button" onClick={() => select(t.id)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Plus className="size-3" /> Choose this topic</button>
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
                        <button type="button" onClick={() => select(t.id)} disabled={busy} className={cn("shrink-0 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}>Choose this topic</button>
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
      {months.length === 0 && <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Your next program month isn&rsquo;t open yet — you can still read and discuss your topics; selecting opens when the month does.</p>}

      {/* Filters (the month view is one month's plan: nothing to filter) */}
      {view !== "month" && (
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter topics">
        {filters.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={effFilter === f.key} onClick={() => { setFilter(f.key); setFilterTouched(true); setMsg(null); }} className={cn("rounded-full border px-3 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", effFilter === f.key ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground", v2 && "min-h-11 sm:min-h-0")}>
            {/* Every chip carries its count, zero included — one chip without
                a number beside five with one reads as "unknown", not "none". */}
            {f.label} · {counts[f.key] ?? 0}
          </button>
        ))}
        {archivedCount > 0 && <span className="self-center text-[11px] text-muted-2">{archivedCount} set aside — we keep those so we never re-suggest them</span>}
      </div>
      )}
      {chosenThisMonth > 0 && month && (
        <p className="text-xs text-muted">
          {chosenThisMonth} chosen for {monthLabel(month.monthKey)} —{" "}
          <Link href={tabHref} className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline">see them on this month <ChevronRight className="size-3" aria-hidden /></Link>
        </p>
      )}

      {/* v1: every result here. v2: only results that have no topic card to sit in. */}
      {msg && (!v2 || !msg.topicId) && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
      {justAdded && canAct && !readOnly && (
        <button type="button" onClick={answerJustAdded} disabled={busy} className={cn("inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", v2 && "min-h-11")}>{CTA_WORDS.ANSWER} for it now <ChevronRight className="size-3.5" /></button>
      )}

      {/* SCRIPTED, NOT FILMED — first, because each one is a decision: film it
          (it is already on a month), swap it for another topic (the script is
          kept), or use a parked one for a month. */}
      {scriptedNotFilmed.length > 0 && (
        <section className="panel-shadow rounded-2xl border border-warning/30 bg-surface/70 p-4 backdrop-blur" aria-label="Scripted, not filmed">
          <h2 className="text-base font-semibold">Scripted, not filmed</h2>
          <p className="text-xs text-muted">Scripts we wrote that weren&rsquo;t filmed yet. A carried-over one uses one of that month&rsquo;s videos; swap it for another topic and we keep the script for later.</p>
          <ul className="mt-3 space-y-2">
            {scriptedNotFilmed.map((t) => (
              <li key={t.id} id={`topic-${t.id}`} className="scroll-mt-20 rounded-xl border border-border bg-surface px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold">{t.title}</span>
                  {t.carried && t.selection ? (
                    <span className="rounded-md bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">carried{t.carried.fromMonthKey ? ` from ${shortMonth(t.carried.fromMonthKey)}` : ""} into {shortMonth(t.selection.monthKey)}</span>
                  ) : (
                    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">not on a month</span>
                  )}
                </div>
                {t.concept && <p className="mt-0.5 text-xs text-muted">{t.concept}</p>}
                {canAct && !readOnly && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {t.swappable && (swapping === t.swappable ? (
                      <>
                        <select value={swapTo} onChange={(e) => setSwapTo(e.target.value)} aria-label="Swap it for" className={cn("min-w-0 max-w-full rounded-md border border-border bg-surface px-2 py-1 text-[11px] outline-none focus:border-brand", v2 && "min-h-11 sm:min-h-0")}>
                          <option value="">Swap it for…</option>
                          {swapOptions.map((o) => <option key={o.id} value={o.id}>{o.title}{o.mine ? " (your idea)" : ""}</option>)}
                        </select>
                        <button type="button" onClick={() => swap(t.swappable!, t.id)} disabled={busy || !swapTo} className={cn("rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}>Swap</button>
                        <button type="button" onClick={() => { setSwapping(null); setSwapTo(""); }} className={cn("rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => { setSwapping(t.swappable); setSwapTo(""); }} disabled={busy || swapOptions.length === 0} className={cn("inline-flex items-center gap-1 rounded-md border border-brand/30 px-2 py-1 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><ArrowLeftRight className="size-3" /> {CTA_WORDS.SWAP}</button>
                    ))}
                    {!t.carried && month && <button type="button" onClick={() => select(t.id)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Plus className="size-3" /> {CTA_WORDS.CHOOSE}</button>}
                  </div>
                )}
                {cardStatus(t.id)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The bank, by pillar */}
      {total === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/70 p-6 text-center text-sm text-muted">
          <Lightbulb className="mx-auto size-6 text-muted-2" />
          <p className="mt-2">Your topic bank is being built from your strategy. Meanwhile, add any idea you already have below.</p>
        </div>
      ) : visible.length === 0 ? (
        view === "month" ? (
          <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">{month ? <>No topics chosen for {monthLabel(month.monthKey)} yet{canAct && !readOnly ? " — pick them from your topic bank, or suggest your own idea below." : "."}</> : "Your next program month isn’t open yet."}</p>
        ) : (
          <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Nothing under &ldquo;{filters.find((f) => f.key === effFilter)?.label}&rdquo; yet{v2 && effFilter !== "ALL" ? " — try All, or suggest an idea of your own below." : "."}</p>
        )
      ) : (
        visible.map((g) => (
          <section key={g.pillarId ?? "none"} className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
            <h2 className="text-base font-semibold">{g.pillarName}</h2>
            {g.purpose && <p className="text-xs text-muted">Purpose: {g.purpose}</p>}
            <ol className="mt-3 space-y-2">
              {g.topics.map((t, i) => {
                const chip = STATE_CHIP[t.state];
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
                          {v2 ? <StatusChip word={t.plan ? planStepWord(t.plan.step, t.plan.missing) : TOPIC_WORDS[t.state]} /> : <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", chip.cls)}>{t.plan ? planStepWord(t.plan.step, t.plan.missing).label : chip.label}</span>}
                          {v2 && !t.plan && awaitingScript(t) && <StatusChip word={SCRIPT_WORDS.AWAITING} />}
                          {t.mine && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">your idea</span>}
                          {t.selection && <span className="text-[11px] text-muted-2">{t.selection.status === "PROPOSED" ? "proposed on your call for" : "for"} {shortMonth(t.selection.monthKey)}{t.selection.overflow ? " (extra)" : ""}</span>}
                        </div>
                        {t.concept && <p className="mt-0.5 text-xs text-muted">{t.concept}</p>}
                        {(t.audienceNeed || t.intendedMessage) && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-[11px] text-muted-2 hover:text-foreground">More about this topic</summary>
                            <dl className="mt-1 space-y-0.5 text-xs text-muted">
                              {t.audienceNeed && <div><dt className="inline font-semibold text-foreground/80">Who it&rsquo;s for: </dt><dd className="inline">{t.audienceNeed}</dd></div>}
                              {t.businessGoal && <div><dt className="inline font-semibold text-foreground/80">Goal: </dt><dd className="inline">{t.businessGoal}</dd></div>}
                              {t.intendedMessage && <div><dt className="inline font-semibold text-foreground/80">Takeaway: </dt><dd className="inline">{t.intendedMessage}</dd></div>}
                              {(t.strategyLabel || t.script?.strategyLabel) && <div><dt className="inline font-semibold text-foreground/80">Strategy: </dt><dd className="inline">version {t.script?.strategyLabel ?? t.strategyLabel}{t.script?.versionLabel ? ` · script ${t.script.versionLabel}${t.script.shared ? " (shared with you)" : " (with our creative team)"}` : ""}</dd></div>}
                            </dl>
                            {t.history.length > 0 && (
                              <ul className="mt-1 space-y-0.5 text-[11px] text-muted-2">
                                {t.history.map((h, j) => <li key={j}>{h.kind.toLowerCase()}{h.monthKey ? ` · ${shortMonth(h.monthKey)}` : ""} · {new Date(h.atISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}{h.note ? ` — ${h.note}` : ""}</li>)}
                              </ul>
                            )}
                          </details>
                        )}
                        {/* THE SCRIPT. The server sends words only when
                            postingKit.scriptVisibility says this client may
                            read them, so there is nothing to decide here — if
                            it arrived, it is theirs. A released script opens on
                            arrival (the client was sent here to read it); an
                            import stays closed behind its own label, because an
                            old script we hold is not this topic's script and
                            must never be mistaken for one (Jordan's ruling). */}
                        {t.scriptText && (
                          <details className="mt-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2" open={v2 ? targetId === t.id : !t.scriptText.historical}>
                            <summary className="cursor-pointer text-xs font-bold">
                              {t.scriptText.historical ? "An earlier script we have on file" : "Your script"}
                              <span className="ml-1 text-[10px] font-normal text-muted-2">
                                {t.scriptText.historical ? "history" : t.scriptText.versionLabel ? `script ${t.scriptText.versionLabel}` : "script"}
                                {t.scriptText.strategyLabel ? ` · strategy ${t.scriptText.strategyLabel}` : ""}
                              </span>
                            </summary>
                            {t.scriptText.historical && <p className="mt-1.5 text-[11px] text-muted">Kept as history — a script we already have for this topic, not the one we&rsquo;re writing for your next video.</p>}
                            <ScriptView body={t.scriptText.body} parts={t.scriptText.parts ?? null} pillarName={t.scriptText.pillarName ?? null} size="xs" fileTitle={t.title} />
                            {/* THE CLIENT'S OWN VERDICT (F09). Only on a script
                                that is genuinely shared with them — an import we
                                hold as history is not theirs to approve, and a
                                draft they cannot see has nothing to approve. */}
                            {!t.scriptText.historical && t.script?.shared && canAct && !readOnly && (
                              <ScriptApprovalCard script={t.script} onResult={(r) => done(r, t.id)} run={(fn) => act(t.id, fn)} busy={busy} large={v2} />
                            )}
                          </details>
                        )}
                        {/* Actions */}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {canSelect && <button type="button" onClick={() => select(t.id)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Plus className="size-3" /> {CTA_WORDS.CHOOSE}</button>}
                          {t.selection && t.selection.removable && canAct && !readOnly && <button type="button" onClick={() => remove(t)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-danger disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><X className="size-3" /> Remove from {shortMonth(t.selection.monthKey)}</button>}
                          {t.selection && !t.selection.removable && t.state !== "FILMED" && <span className="inline-flex items-center gap-1 text-[11px] text-muted-2"><CheckCircle2 className="size-3" /> {v2 ? "committed — send us a message to change it" : `committed — ${TEXT_KYLE} to change it`}</span>}
                          {/* R01: no questions offered for what nobody owes — an extra waiting
                              its turn, a topic the booked call covers, a call's proposal —
                              unless they already started them. */}
                          {(t.selection || selectedHere) && t.state !== "FILMED" && canAct && !readOnly && (t.interview || !t.plan || !["EXTRA", "ON_CALL", "CONFIRMING"].includes(t.plan.step)) && (
                            <button type="button" onClick={() => openQuestions(t)} disabled={busy} className={cn("inline-flex items-center gap-1 rounded-md border border-brand/30 px-2 py-1 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}>
                              {t.plan?.step === "NEEDS_MORE" ? answerCta(t.plan.missing) : t.interview ? (t.interview.status === "SUBMITTED" ? "Your answers" : t.interview.answered > 0 ? "Continue answering" : CTA_WORDS.ANSWER) : CTA_WORDS.ANSWER} <ChevronRight className="size-3" />
                            </button>
                          )}
                          {canAct && !readOnly && <button type="button" onClick={() => { setOpenTopic(openTopic === t.id ? null : t.id); setNote(""); }} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><MessageSquare className="size-3" /> Discuss</button>}
                          {canAct && !readOnly && t.state === "SUGGESTED" && !t.selection && <button type="button" onClick={() => { setDeclining(declining === t.id ? null : t.id); setDeclineReason(""); }} className={cn("inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><Ban className="size-3" /> Not interested</button>}
                          {/* v2: a script waiting on them is answered in My Plan › Scripts, with the words in front of them. */}
                          {v2 && scriptsHref && awaitingScript(t) && canAct && !readOnly && <Link href={`${scriptsHref}#script-${t.id}`} className={cn("inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", tap)}><ScrollText className="size-3" /> {CTA_WORDS.REVIEW}</Link>}
                        </div>
                        {cardStatus(t.id)}
                        {declining === t.id && (
                          <div className="mt-1.5 flex items-start gap-2">
                            <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Why not? (optional — it helps us suggest better)" aria-label="Why this topic isn't for you (optional)" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
                            <button type="button" onClick={() => decline(t.id)} disabled={busy} className={cn("shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", v2 && "min-h-11 sm:min-h-0")}>Set aside</button>
                          </div>
                        )}
                        {openTopic === t.id && (
                          <div className="mt-1.5 flex items-start gap-2">
                            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="A thought on this topic — an angle, a story, a doubt…" aria-label="Note on this topic" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
                            <button type="button" onClick={() => discuss(t.id)} disabled={busy || note.trim().length < 2} className={cn("shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", v2 && "min-h-11 sm:min-h-0")}>Send</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}

      {/* What they set aside — kept, with undo */}
      {setAside.length > 0 && (
        <details className="rounded-2xl border border-border bg-surface/70 p-4 text-sm">
          <summary className="cursor-pointer text-xs font-semibold text-muted">You set aside {setAside.length} topic{setAside.length === 1 ? "" : "s"} — we won&rsquo;t suggest {setAside.length === 1 ? "it" : "them"} again</summary>
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
            <button type="button" onClick={() => setSuggesting(true)} className={cn("inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", v2 && "min-h-11")}><Lightbulb className="size-4" /> Suggest a video idea of your own</button>
          ) : (
            <div className="space-y-2">
              <div className="text-sm font-semibold">Your idea</div>
              <input value={idea.title} onChange={(e) => setIdea({ ...idea, title: e.target.value })} placeholder="Title — e.g. Why I tell sellers to skip the kitchen remodel" aria-label="Idea title" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
              <textarea value={idea.concept} onChange={(e) => setIdea({ ...idea, concept: e.target.value })} rows={2} placeholder="One line on the angle (optional)" aria-label="Idea concept" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
              {groups.some((g) => g.pillarId) && (
                <select value={idea.pillarId} onChange={(e) => setIdea({ ...idea, pillarId: e.target.value })} aria-label="Pillar" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand">
                  <option value="">Which pillar? (optional)</option>
                  {groups.filter((g) => g.pillarId).map((g) => <option key={g.pillarId!} value={g.pillarId!}>{g.pillarName}</option>)}
                </select>
              )}
              {month && (
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={useForMonth} onChange={(e) => setUseForMonth(e.target.checked)} className="size-3.5 accent-brand" />
                  Use it for {monthLabel(month.monthKey)}{month.selected >= month.owed ? " (as an extra — that month is full)" : ""}
                </label>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={suggest} disabled={busy || idea.title.trim().length < 3} className={cn("inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", v2 && "min-h-11")}>{busy && <Loader2 className="size-3.5 animate-spin" />} {useForMonth && month ? `Add it for ${shortMonth(month.monthKey)}` : "Add to my bank"}</button>
                <button type="button" onClick={() => setSuggesting(false)} className={cn("rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", v2 && "min-h-11")}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {strategyLabel && <p className="text-center text-[11px] text-muted-2">Topics are shaped by your strategy, version {strategyLabel}.</p>}
    </div>
  );
}
