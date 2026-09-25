"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Ban, CheckCircle2, CheckCheck, ChevronRight, Lightbulb, Loader2, MessageSquare, PencilLine, Plus, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalApproveScript, portalDeclineTopic, portalDiscussTopic, portalOpenInterview, portalRemoveSelection, portalRequestScriptChanges, portalSelectTopic, portalSuggestTopic, portalSwapCarriedTopic, portalUndeclineTopic } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { ScriptBody } from "@/components/portal/ScriptBody";
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
// ---------------------------------------------------------------------------

const FILTERS: { key: PortalTopicState | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" }, { key: "SUGGESTED", label: "Suggested" }, { key: "SELECTED", label: "Selected for a month" }, { key: "PREPARING", label: "Preparing" }, { key: "FILMED", label: "Filmed" },
];
const monthLabel = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" }); };
const shortMonth = (monthKey: string) => { const [y, m] = monthKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short" }); };
const STATE_CHIP: Record<PortalTopicState, { label: string; cls: string }> = {
  SUGGESTED: { label: "Suggested", cls: "bg-surface-2 text-muted" },
  SELECTED: { label: "Selected", cls: "bg-brand-soft text-brand" },
  PREPARING: { label: "Preparing", cls: "bg-warning-soft text-warning" },
  FILMED: { label: "Filmed", cls: "bg-success-soft text-success" },
};

export function TopicBank({ groups, months, archivedCount, total, strategyLabel, canAct, readOnly, initialFilter, tabHref }: {
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
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<PortalTopicState | "ALL">(FILTERS.some((f) => f.key === initialFilter) ? (initialFilter as PortalTopicState | "ALL") : "ALL");
  const [monthId, setMonthId] = useState<string | null>(months.find((m) => m.selected < m.owed)?.id ?? months[0]?.id ?? null);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [idea, setIdea] = useState({ title: "", concept: "", pillarId: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** Which script's "what should change?" box is open, and what is in it. */
  const [changing, setChanging] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState("");
  /** Which suggestion's "not interested" box is open, and the optional reason. */
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  /** Which carried selection is being swapped, and for which topic. */
  const [swapping, setSwapping] = useState<string | null>(null);
  const [swapTo, setSwapTo] = useState("");
  /** Their own idea goes straight into the month unless they untick it (on by default while the month has room). */
  const [useForMonth, setUseForMonth] = useState<boolean>(() => { const m = months.find((x) => x.selected < x.owed); return !!m; });
  const [justAdded, setJustAdded] = useState<{ topicId: string; monthId: string } | null>(null);
  const [busy, start] = useTransition();
  const month = months.find((m) => m.id === monthId) ?? null;
  const done = (r: { ok: boolean; message: string }) => { setMsg({ ok: r.ok, text: r.message }); if (r.ok) router.refresh(); };

  // Topics they set aside live in their pillar's group flagged `declined`: the
  // bank and its counts leave them out; the strip below the bank lists them.
  const active = useMemo(() => groups.map((g) => ({ ...g, topics: g.topics.filter((t) => !t.declined) })), [groups]);
  const setAside = useMemo(() => groups.flatMap((g) => g.topics.filter((t) => t.declined)), [groups]);
  const scriptedNotFilmed = useMemo(() => active.flatMap((g) => g.topics.filter((t) => t.scriptedNotFilmed)), [active]);
  /** What a carried script can be swapped for: unplanned topics still in the bank. */
  const swapOptions = useMemo(() => active.flatMap((g) => g.topics.filter((t) => !t.selection && !t.scriptedNotFilmed && t.state !== "FILMED")), [active]);
  const visible = useMemo(() => active.map((g) => ({ ...g, topics: g.topics.filter((t) => !t.scriptedNotFilmed && (filter === "ALL" || t.state === filter)) })).filter((g) => g.topics.length > 0), [active, filter]);
  const counts = useMemo(() => { const c: Record<string, number> = { ALL: 0 }; for (const g of active) for (const t of g.topics) { c.ALL++; c[t.state] = (c[t.state] ?? 0) + 1; } return c; }, [active]);

  const select = (topicId: string) => { if (!month) return; start(async () => done(await portalSelectTopic(portalAuthFromLocation(), topicId, month.id).catch(() => ({ ok: false, message: "That didn't save — try again." })))); };
  const remove = (t: PortalTopic) => { if (!t.selection) return; start(async () => done(await portalRemoveSelection(portalAuthFromLocation(), t.id, t.selection!.monthId).catch(() => ({ ok: false, message: "That didn't save — try again." })))); };
  const discuss = (topicId: string) => start(async () => { const r = await portalDiscussTopic(portalAuthFromLocation(), topicId, note).catch(() => ({ ok: false, message: "That didn't send — try again." })); if (r.ok) { setNote(""); setOpenTopic(null); } done(r); });
  const openQuestions = (t: PortalTopic) => {
    const mId = t.selection?.monthId ?? month?.id;
    if (!mId) return;
    start(async () => {
      const r = await portalOpenInterview(portalAuthFromLocation(), t.id, mId).catch(() => ({ ok: false, message: "Couldn't open the questions — try again." }));
      if (r.ok && "id" in r && r.id) router.push(`${tabHref}&iv=${encodeURIComponent(r.id)}`);
      else setMsg({ ok: false, text: r.message });
    });
  };
  // R1 — the decision carries the version THIS PAGE rendered. If a newer one
  // has been released since, the server refuses and `done` refreshes, so the
  // client lands on the words we would actually film instead of approving
  // something they have not read.
  const approveScript = (scriptId: string, versionId: string | null) =>
    start(async () =>
      done(
        await portalApproveScript(portalAuthFromLocation(), scriptId, versionId ?? "").catch(() => ({ ok: false, message: "That didn't save — try again." })),
      ),
    );
  const sendChanges = (scriptId: string, versionId: string | null) => start(async () => {
    const r = await portalRequestScriptChanges(portalAuthFromLocation(), scriptId, changeNote, versionId ?? "").catch(() => ({ ok: false, message: "That didn't send — try again." }));
    // A stale refusal keeps their words in the box: they are about to read a
    // new version and may well want to say the same thing about it.
    if (r.ok) { setChangeNote(""); setChanging(null); }
    done(r);
  });
  const suggest = () => start(async () => {
    const r: { ok: boolean; message: string; id?: string; monthId?: string | null; selected?: boolean } = await portalSuggestTopic(portalAuthFromLocation(), { title: idea.title, concept: idea.concept, pillarId: idea.pillarId || null, monthId: useForMonth && month ? month.id : null }).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) { setIdea({ title: "", concept: "", pillarId: "" }); setSuggesting(false); }
    setJustAdded(r.ok && r.selected && r.id && r.monthId ? { topicId: r.id, monthId: r.monthId } : null);
    done(r);
  });
  const answerJustAdded = () => {
    if (!justAdded) return;
    start(async () => {
      const r = await portalOpenInterview(portalAuthFromLocation(), justAdded.topicId, justAdded.monthId).catch(() => ({ ok: false, message: "Couldn't open the questions — try again." }));
      if (r.ok && "id" in r && r.id) router.push(`${tabHref}&iv=${encodeURIComponent(r.id)}`);
      else setMsg({ ok: false, text: r.message });
    });
  };
  const decline = (topicId: string) => start(async () => {
    const r = await portalDeclineTopic(portalAuthFromLocation(), topicId, declineReason).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) { setDeclining(null); setDeclineReason(""); }
    done(r);
  });
  const undecline = (topicId: string) => start(async () => done(await portalUndeclineTopic(portalAuthFromLocation(), topicId).catch(() => ({ ok: false, message: "That didn't save — try again." }))));
  const swap = (selectionId: string) => start(async () => {
    const r = await portalSwapCarriedTopic(portalAuthFromLocation(), selectionId, swapTo).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) { setSwapping(null); setSwapTo(""); }
    done(r);
  });

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
                  <button key={m.id} type="button" role="tab" aria-selected={m.id === monthId} onClick={() => setMonthId(m.id)} className={cn("rounded-lg border px-2.5 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", m.id === monthId ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground")}>{monthLabel(m.monthKey)}</button>
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
                {waiting > 0 && <span className="text-muted"> · {waiting} more waiting (your package covers {month.owed} a month; extras stay in line, nothing is thrown away)</span>}
                {month.selected < month.owed && <span className="text-muted"> · pick {month.owed - month.selected} more</span>}
              </p>
            );
          })()}
        </div>
      )}
      {months.length === 0 && <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Your next program month isn&rsquo;t open yet — you can still read and discuss your topics; selecting opens when the month does.</p>}

      {/* Filters */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter topics">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)} className={cn("rounded-full border px-3 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", filter === f.key ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground")}>
            {/* Every chip carries its count, zero included — one chip without
                a number beside five with one reads as "unknown", not "none". */}
            {f.label} · {counts[f.key] ?? 0}
          </button>
        ))}
        {archivedCount > 0 && <span className="self-center text-[11px] text-muted-2">{archivedCount} set aside — we keep those so we never re-suggest them</span>}
      </div>

      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
      {justAdded && canAct && !readOnly && (
        <button type="button" onClick={answerJustAdded} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Answer the questions for it now <ChevronRight className="size-3.5" /></button>
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
                        <select value={swapTo} onChange={(e) => setSwapTo(e.target.value)} aria-label="Swap it for" className="min-w-0 max-w-full rounded-md border border-border bg-surface px-2 py-1 text-[11px] outline-none focus:border-brand">
                          <option value="">Swap it for…</option>
                          {swapOptions.map((o) => <option key={o.id} value={o.id}>{o.title}{o.mine ? " (your idea)" : ""}</option>)}
                        </select>
                        <button type="button" onClick={() => swap(t.swappable!)} disabled={busy || !swapTo} className="rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Swap</button>
                        <button type="button" onClick={() => { setSwapping(null); setSwapTo(""); }} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => { setSwapping(t.swappable); setSwapTo(""); }} disabled={busy || swapOptions.length === 0} className="inline-flex items-center gap-1 rounded-md border border-brand/30 px-2 py-1 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><ArrowLeftRight className="size-3" /> Swap for another topic</button>
                    ))}
                    {!t.carried && month && <button type="button" onClick={() => select(t.id)} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Plus className="size-3" /> Use for {shortMonth(month.monthKey)}</button>}
                  </div>
                )}
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
        <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Nothing under &ldquo;{FILTERS.find((f) => f.key === filter)?.label}&rdquo; yet.</p>
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
                          <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", chip.cls)}>{chip.label}</span>
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
                          <details className="mt-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2" open={!t.scriptText.historical}>
                            <summary className="cursor-pointer text-xs font-bold">
                              {t.scriptText.historical ? "An earlier script we have on file" : "Your script"}
                              <span className="ml-1 text-[10px] font-normal text-muted-2">
                                {t.scriptText.historical ? "history" : t.scriptText.versionLabel ? `script ${t.scriptText.versionLabel}` : "script"}
                                {t.scriptText.strategyLabel ? ` · strategy ${t.scriptText.strategyLabel}` : ""}
                              </span>
                            </summary>
                            {t.scriptText.historical && <p className="mt-1.5 text-[11px] text-muted">Kept as history — a script we already have for this topic, not the one we&rsquo;re writing for your next video.</p>}
                            <ScriptBody body={t.scriptText.body} size="xs" />
                            {/* THE CLIENT'S OWN VERDICT (F09). Only on a script
                                that is genuinely shared with them — an import we
                                hold as history is not theirs to approve, and a
                                draft they cannot see has nothing to approve. */}
                            {!t.scriptText.historical && t.script?.shared && canAct && !readOnly && (
                              <div className="mt-2 border-t border-border pt-2">
                                {t.script.decision === "APPROVED" ? (
                                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-success"><CheckCheck className="size-3.5" /> You signed off on this one{t.script.decidedAtISO ? ` on ${new Date(t.script.decidedAtISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}` : ""}.</p>
                                ) : t.script.decision === "CHANGES_REQUESTED" ? (
                                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning"><PencilLine className="size-3.5" /> You asked for changes — we&rsquo;re reworking it and the new version lands here.</p>
                                ) : (
                                  <>
                                    {t.script.staleApproval && <p className="mb-1.5 text-[11px] text-muted">We&rsquo;ve rewritten this since you last approved it — have another read.</p>}
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <button type="button" onClick={() => approveScript(t.script!.id, t.script!.sharedVersionId)} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><CheckCheck className="size-3" /> I&rsquo;ll film this</button>
                                      <button type="button" onClick={() => { setChanging(changing === t.script!.id ? null : t.script!.id); setChangeNote(""); }} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><PencilLine className="size-3" /> Change something</button>
                                    </div>
                                    {changing === t.script.id && (
                                      <div className="mt-1.5 flex items-start gap-2">
                                        <textarea value={changeNote} onChange={(e) => setChangeNote(e.target.value)} rows={2} placeholder="What should change? A line, a word, the whole angle&hellip;" aria-label="What should change about this script" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
                                        <button type="button" onClick={() => sendChanges(t.script!.id, t.script!.sharedVersionId)} disabled={busy || changeNote.trim().length < 3} className="shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Send</button>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </details>
                        )}
                        {/* Actions */}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {canSelect && <button type="button" onClick={() => select(t.id)} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Plus className="size-3" /> Select for {shortMonth(month!.monthKey)}</button>}
                          {t.selection && t.selection.removable && canAct && !readOnly && <button type="button" onClick={() => remove(t)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-danger disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><X className="size-3" /> Remove from {shortMonth(t.selection.monthKey)}</button>}
                          {t.selection && !t.selection.removable && t.state !== "FILMED" && <span className="inline-flex items-center gap-1 text-[11px] text-muted-2"><CheckCircle2 className="size-3" /> committed — text us to change it</span>}
                          {(t.selection || selectedHere) && t.state !== "FILMED" && canAct && !readOnly && (
                            <button type="button" onClick={() => openQuestions(t)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-brand/30 px-2 py-1 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                              {t.interview ? (t.interview.status === "SUBMITTED" ? "Your answers" : t.interview.answered > 0 ? "Continue the questions" : "Answer the questions") : "Answer the questions"} <ChevronRight className="size-3" />
                            </button>
                          )}
                          {canAct && !readOnly && <button type="button" onClick={() => { setOpenTopic(openTopic === t.id ? null : t.id); setNote(""); }} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><MessageSquare className="size-3" /> Discuss</button>}
                          {canAct && !readOnly && t.state === "SUGGESTED" && !t.selection && <button type="button" onClick={() => { setDeclining(declining === t.id ? null : t.id); setDeclineReason(""); }} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Ban className="size-3" /> Not interested</button>}
                        </div>
                        {declining === t.id && (
                          <div className="mt-1.5 flex items-start gap-2">
                            <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} placeholder="Why not? (optional — it helps us suggest better)" aria-label="Why this topic isn't for you (optional)" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
                            <button type="button" onClick={() => decline(t.id)} disabled={busy} className="shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Set aside</button>
                          </div>
                        )}
                        {openTopic === t.id && (
                          <div className="mt-1.5 flex items-start gap-2">
                            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="A thought on this topic — an angle, a story, a doubt…" aria-label="Note on this topic" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
                            <button type="button" onClick={() => discuss(t.id)} disabled={busy || note.trim().length < 2} className="shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Send</button>
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
                {canAct && !readOnly && <button type="button" onClick={() => undecline(t.id)} disabled={busy} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Undo2 className="size-3" /> Undo</button>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Suggest an idea */}
      {canAct && !readOnly && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          {!suggesting ? (
            <button type="button" onClick={() => setSuggesting(true)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Lightbulb className="size-4" /> Suggest a video idea of your own</button>
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
                <button type="button" onClick={suggest} disabled={busy || idea.title.trim().length < 3} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3.5 animate-spin" />} {useForMonth && month ? `Add it for ${shortMonth(month.monthKey)}` : "Add to my bank"}</button>
                <button type="button" onClick={() => setSuggesting(false)} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {strategyLabel && <p className="text-center text-[11px] text-muted-2">Topics are shaped by your strategy, version {strategyLabel}.</p>}
    </div>
  );
}
