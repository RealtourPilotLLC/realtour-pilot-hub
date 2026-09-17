"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronRight, Lightbulb, Loader2, MessageSquare, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalDiscussTopic, portalOpenInterview, portalRemoveSelection, portalSelectTopic, portalSuggestTopic } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import type { PortalTopic, PortalTopicMonth, PortalTopicState } from "@/lib/portal";

// ---------------------------------------------------------------------------
// VIDEO TOPICS (spec §5): the client's bank by their pillars, in the
// presentation their strategist uses (pillar heading, purpose, numbered
// topics with a one-line concept). Filters: Suggested / Selected for a month
// / Preparing / Filmed (+ how many are archived, kept internally). Select for
// a NAMED month, remove an uncommitted selection, suggest an idea, discuss —
// each a server action that re-reads the page. Capacity is explained, never
// enforced by deleting: an extra becomes overflow that waits its turn.
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
  const [busy, start] = useTransition();
  const month = months.find((m) => m.id === monthId) ?? null;
  const done = (r: { ok: boolean; message: string }) => { setMsg({ ok: r.ok, text: r.message }); if (r.ok) router.refresh(); };

  const visible = useMemo(() => groups.map((g) => ({ ...g, topics: g.topics.filter((t) => filter === "ALL" || t.state === filter) })).filter((g) => g.topics.length > 0), [groups, filter]);
  const counts = useMemo(() => { const c: Record<string, number> = { ALL: 0 }; for (const g of groups) for (const t of g.topics) { c.ALL++; c[t.state] = (c[t.state] ?? 0) + 1; } return c; }, [groups]);

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
  const suggest = () => start(async () => {
    const r = await portalSuggestTopic(portalAuthFromLocation(), { title: idea.title, concept: idea.concept, pillarId: idea.pillarId || null, monthId: null }).catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) { setIdea({ title: "", concept: "", pillarId: "" }); setSuggesting(false); }
    done(r);
  });

  return (
    <div className="space-y-4">
      {/* Month + capacity, explained */}
      {months.length > 0 && (
        <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Selecting for</div>
            {months.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Which month">
                {months.map((m) => (
                  <button key={m.id} type="button" role="tab" aria-selected={m.id === monthId} onClick={() => setMonthId(m.id)} className={cn("rounded-lg border px-2.5 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", m.id === monthId ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground")}>{monthLabel(m.monthKey)}</button>
                ))}
              </div>
            )}
          </div>
          {month && (
            <p className="mt-1.5 text-sm">
              <span className="font-semibold">{monthLabel(month.monthKey)}</span> — {month.selected} of {month.owed} video{month.owed === 1 ? "" : "s"} chosen
              {month.overflow > 0 && <span className="text-muted"> · {month.overflow} extra waiting (your package covers {month.owed} a month; extras stay in line, nothing is thrown away)</span>}
              {month.selected < month.owed && <span className="text-muted"> · pick {month.owed - month.selected} more</span>}
            </p>
          )}
        </div>
      )}
      {months.length === 0 && <p className="rounded-2xl border border-border bg-surface/70 p-4 text-sm text-muted">Your next program month isn&rsquo;t open yet — you can still read and discuss your topics; selecting opens when the month does.</p>}

      {/* Filters */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter topics">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)} className={cn("rounded-full border px-3 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", filter === f.key ? "border-brand bg-brand text-white" : "border-border bg-surface text-muted hover:text-foreground")}>
            {f.label}{counts[f.key] ? ` · ${counts[f.key]}` : ""}
          </button>
        ))}
        {archivedCount > 0 && <span className="self-center text-[11px] text-muted-2">{archivedCount} set aside — we keep those so we never re-suggest them</span>}
      </div>

      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}

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
                  <li key={t.id} className="rounded-xl border border-border bg-surface px-3 py-2.5">
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
                        </div>
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
              <div className="flex gap-2">
                <button type="button" onClick={suggest} disabled={busy || idea.title.trim().length < 3} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3.5 animate-spin" />} Add to my bank</button>
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
