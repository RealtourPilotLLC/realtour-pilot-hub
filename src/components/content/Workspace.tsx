"use client";

import { useRef, useState, useTransition } from "react";
import {
  CalendarClock, Check, Compass, FileText, FileUp, Loader2, NotebookPen, Plus, Settings2, Sparkles, Trash2, Upload, X,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { TOPIC_STATUS_WORDS } from "@/lib/contentStatus";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import {
  addContentNote, addTopic, analyzeTranscript, approveScript, buildProfile, generateTopicIdeas, previewScriptBackfill, previewStrategyBackfill,
  reviseScriptAI, saveEnrollmentSettings, saveMonthTranscript, saveProfileSection, saveScriptBackfill,
  applyScriptSuggestion, dismissScriptSuggestion,
  saveScriptText, saveStrategyBackfill, setStrategyCallStatus, setTopicStatus,
  type BackfillPreview, type StrategyPreview,
} from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Strategy call card — status ladder + manual transcript paste (Phase 3 wires
// Calendly + Meet automation; the manual path always survives as the fallback).
// ---------------------------------------------------------------------------
function fmtCallTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
}

// The call step of the month checklist — a state machine, not a status ladder.
// One sentence for where the call stands, one clear next action, everything
// else behind a quiet "change" menu. Same server actions as always.
export function StrategyCallCard({
  monthId, status, at, hasTranscript, transcriptProcessed, required, bookingUrl,
}: {
  monthId: string; status: string; at: string | null; hasTranscript: boolean;
  transcriptProcessed: boolean; required: boolean; bookingUrl: string;
}) {
  const [cur, setCur] = useState(status);
  const [showPaste, setShowPaste] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [analyzed, setAnalyzed] = useState(transcriptProcessed);
  const [onFile, setOnFile] = useState(hasTranscript);
  const [busy, start] = useTransition();

  const setStatus = (key: string) => start(async () => {
    const r = await setStrategyCallStatus(monthId, key);
    if (r.ok) setCur(key); else setNote(r.message);
  });

  const isDone = cur === "COMPLETED" || cur === "SKIPPED" || cur === "NOT_REQUIRED" || !required;

  const title =
    !required || cur === "NOT_REQUIRED" ? "Strategy call — not needed for this client"
    : cur === "SKIPPED" ? "Strategy call — skipped this month"
    : cur === "COMPLETED" ? (analyzed ? "Strategy call held — turned into this month's topics and scripts" : "Strategy call held")
    : cur === "SCHEDULED" ? `Strategy call booked${at ? ` for ${fmtCallTime(at)}` : ""}`
    : "The strategy call isn't booked yet";

  const primaryBtn = "inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50";
  const quietLink = "text-[13px] font-medium text-muted hover:text-foreground hover:underline";

  return (
    <Section icon={CalendarClock} title="Strategy call"
      action={isDone ? <Check className="size-4 text-success" /> : undefined}>
      <p className={isDone ? "text-sm text-foreground/85" : "text-[15px] font-semibold"}>{title}</p>
      {/* Paste box — reachable from every state, because reality is messy. */}
      {showPaste ? (
        <div className="mt-2.5">
          <AutoTextarea value={transcript} onChange={(e) => setTranscript(e.target.value)} minRows={4}
            placeholder="Paste the call transcript here…"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand" />
          <div className="mt-2 flex items-center gap-2">
            <button disabled={busy || !transcript.trim()} onClick={() => start(async () => {
              const r = await saveMonthTranscript(monthId, transcript);
              setNote(r.message);
              // A NEW transcript is un-analyzed by definition (the server clears
              // the stamp) — re-arm the big Analyze button instead of claiming
              // the old analysis covers it.
              if (r.ok) { setShowPaste(false); setCur("COMPLETED"); setOnFile(true); setAnalyzed(false); setTranscript(""); }
            })} className={primaryBtn}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Save transcript"}
            </button>
            <button onClick={() => setShowPaste(false)} className={quietLink}>Cancel</button>
          </div>
        </div>
      ) : cur === "NOT_SCHEDULED" && required ? (
        <div className="mt-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => { navigator.clipboard?.writeText(bookingUrl); setNote("Booking link copied — text it to them."); }}
              className={primaryBtn}
            >
              Copy the booking link
            </button>
            <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className={quietLink}>Open Calendly ↗</a>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button onClick={() => setShowPaste(true)} className={quietLink}>Already held it — paste the transcript</button>
            <span className="text-muted-2">·</span>
            <button disabled={busy} onClick={() => setStatus("SKIPPED")} className={quietLink}>Skip this month</button>
            <span className="text-muted-2">·</span>
            <button disabled={busy} onClick={() => setStatus("NOT_REQUIRED")} className={quietLink}>They don&rsquo;t do calls</button>
          </div>
        </div>
      ) : cur === "SCHEDULED" ? (
        <div className="mt-2.5">
          <button onClick={() => setShowPaste(true)} className={primaryBtn}>
            Call happened — paste the transcript
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button onClick={() => { navigator.clipboard?.writeText(bookingUrl); setNote("Booking link copied."); }} className={quietLink}>Copy booking link</button>
            <span className="text-muted-2">·</span>
            <button disabled={busy} onClick={() => setStatus("SKIPPED")} className={quietLink}>Skip this month</button>
          </div>
        </div>
      ) : cur === "COMPLETED" ? (
        <div className="mt-1.5">
          {analyzed ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button disabled={busy} onClick={() => start(async () => {
                setNote("Re-reading the call…");
                const r = await analyzeTranscript(monthId, true);
                setNote(r.message);
              })} className={quietLink} title="Run the extraction again — existing topics are kept, duplicates avoided">
                Re-analyze the call
              </button>
              <span className="text-muted-2">·</span>
              <button onClick={() => setShowPaste(true)} className={quietLink}>Replace transcript</button>
            </div>
          ) : onFile ? (
            <button disabled={busy} onClick={() => start(async () => {
              setNote("Reading the call — this takes a moment…");
              const r = await analyzeTranscript(monthId);
              setNote(r.message);
              if (r.ok) setAnalyzed(true);
            })} className={primaryBtn}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Turn the call into topics + scripts
            </button>
          ) : (
            <button onClick={() => setShowPaste(true)} className={quietLink}>Paste the transcript to unlock topics + scripts</button>
          )}
        </div>
      ) : (
        // SKIPPED / NOT_REQUIRED / no-calls clients — the paste door stays open
        // (calls happen even for clients who "don't do calls"), plus one quiet
        // undo when a required call was skipped.
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button onClick={() => setShowPaste(true)} className={quietLink}>
            Held a call anyway? Paste the transcript
          </button>
          {required && (
            <>
              <span className="text-muted-2">·</span>
              <button disabled={busy} onClick={() => setStatus("NOT_SCHEDULED")} className={quietLink}>
                {cur === "SKIPPED" ? "Undo — they're doing the call after all" : "Turn monthly calls back on"}
              </button>
            </>
          )}
        </div>
      )}
      {note && <p className="mt-2 text-[13px] text-muted">{note}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Topic bank / month plan — add, promote to month, reject.
// ---------------------------------------------------------------------------
type TopicRow = { id: string; title: string; concept: string | null; pillar: string | null; status: string; source: string };

export function TopicBank({
  enrollmentId, monthId, topics, mode, monthName,
}: {
  enrollmentId: string; monthId: string | null; topics: TopicRow[]; mode: "month" | "bank"; monthName?: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [concept, setConcept] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <div>
      <div className="divide-y divide-border">
        {topics.map((t) => (
          <div key={t.id} className="flex items-start gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-medium">{t.title}</span>
                {!["SAVED", "RECOMMENDED", "IDEA"].includes(t.status) && (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                    {TOPIC_STATUS_WORDS[t.status] ?? t.status.toLowerCase()}
                  </span>
                )}
              </div>
              {t.concept && <p className="mt-1 text-[13px] leading-relaxed text-muted">{t.concept}</p>}
            </div>
            {mode === "bank" && monthId && (
              <button disabled={busy} title="Plan into the selected month"
                onClick={() => start(async () => { const r = await setTopicStatus(t.id, "SELECTED", monthId); if (!r.ok) setNote(r.message); })}
                className="shrink-0 rounded-lg border border-brand/40 px-2.5 py-1.5 text-xs font-semibold text-brand hover:bg-brand-soft">
                Use for {monthName ?? "this month"}
              </button>
            )}
            {mode === "month" && (
              <button disabled={busy} title="Back to the bank"
                onClick={() => start(async () => { const r = await setTopicStatus(t.id, "SAVED", null); if (!r.ok) setNote(r.message); })}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-surface-2">
                <X className="size-3" />
              </button>
            )}
            <button disabled={busy} title="Reject"
              onClick={() => start(async () => { const r = await setTopicStatus(t.id, "REJECTED"); if (!r.ok) setNote(r.message); })}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-danger-soft hover:text-danger">
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}
        {topics.length === 0 && <p className="px-5 py-4 text-sm text-muted">{mode === "month" ? "No topics planned yet." : "The bank is empty — add ideas as they come up."}</p>}
      </div>

      <div className="border-t border-border px-5 py-3">
        {adding ? (
          <div className="space-y-1.5">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Topic title — specific enough that the hook is obvious"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
            <AutoTextarea value={concept} onChange={(e) => setConcept(e.target.value)} minRows={2} placeholder="Angle / why it works (optional)"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs outline-none focus:border-brand" />
            <div className="flex gap-1.5">
              <button disabled={busy || !title.trim()} onClick={() => start(async () => {
                const r = await addTopic(enrollmentId, { title, concept, monthId: mode === "month" ? monthId : null });
                setNote(r.ok ? null : r.message);
                if (r.ok) { setTitle(""); setConcept(""); setAdding(false); }
              })} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                {busy ? <Loader2 className="inline size-3 animate-spin" /> : "Add topic"}
              </button>
              <button onClick={() => setAdding(false)} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
            <Plus className="size-3.5" /> Add a topic
          </button>
        )}
        {note && <p className="mt-1.5 text-[11px] text-danger">{note}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Script backfill — upload a PDF/Word doc of past scripts; AI splits it and
// guesses the month from the title; staff confirm the month and save.
// ---------------------------------------------------------------------------
export function ScriptBackfillCard({ enrollmentId, defaultMonth }: { enrollmentId: string; defaultMonth: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [monthKey, setMonthKey] = useState(defaultMonth);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <Section icon={FileUp} title="Backfill past scripts"
      action={<span className="text-[11px] text-muted-2">PDF, Word or text — history for the portal + the AI&rsquo;s memory</span>}>
      <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const fd = new FormData(); fd.append("file", f);
        setNote(null);
        start(async () => {
          const p = await previewScriptBackfill(fd);
          if (!p.ok) { setNote(p.message); setPreview(null); return; }
          setPreview(p);
          if (p.monthGuess) setMonthKey(p.monthGuess);
        });
        e.target.value = "";
      }} />

      {!preview ? (
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2.5 text-sm text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {busy ? "Reading the document…" : "Upload a script document"}
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            <Sparkles className="mr-1 inline size-3.5 text-brand" />
            {preview.message}
            {preview.monthGuess ? <> The document looks like <strong>{preview.monthGuess}</strong> — confirm below.</> : <> No month named in the document — pick it below.</>}
          </p>
          <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border bg-surface-2/40 p-3">
            {preview.scripts!.map((s, i) => (
              <details key={i}>
                <summary className="cursor-pointer text-xs font-medium">{s.title}</summary>
                <div className="mt-1"><ScriptBody body={s.body.slice(0, 1200) + (s.body.length > 1200 ? "…" : "")} size="xs" /></div>
              </details>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-muted">Month:</label>
            <input type="month" value={monthKey} onChange={(e) => setMonthKey(e.target.value)}
              className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand" />
            <button disabled={busy} onClick={() => start(async () => {
              const r = await saveScriptBackfill(enrollmentId, monthKey, preview.scripts!, preview.sourceFile ?? "upload");
              setNote(r.message);
              if (r.ok) setPreview(null);
            })} className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy ? <Loader2 className="inline size-3 animate-spin" /> : `Save ${preview.scripts!.length} script${preview.scripts!.length === 1 ? "" : "s"}`}
            </button>
            <button onClick={() => setPreview(null)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2">Discard</button>
          </div>
        </div>
      )}
      {note && <p className="mt-2 text-[11px] text-muted">{note}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Agent profile — six sections of labeled key/value pairs over JSON columns.
// ---------------------------------------------------------------------------
const SECTIONS: { key: string; label: string; hint: string; fields: string[] }[] = [
  { key: "brandJson", label: "Brand & positioning", hint: "who they are, who they serve, what they should be known for", fields: ["Positioning", "Primary message", "Target audience", "Markets", "Specialties", "Differentiators", "Content pillars", "Goals"] },
  { key: "voiceJson", label: "Voice & scripting style", hint: "how they talk and how scripts should read", fields: ["Tone", "Cadence & sentence length", "Humor", "Phrases they use", "Phrases to avoid", "Script format preference", "CTA preference"] },
  { key: "contentPrefsJson", label: "Content preferences", hint: "what they'll do on camera and what's off the table", fields: ["Topics they love", "Topics to avoid", "Formats they prefer", "Storytelling comfort", "Polarization comfort", "Personal-life comfort"] },
  { key: "productionJson", label: "Production", hint: "how shoots with them actually go", fields: ["Preferred locations", "Preferred days/times", "Teleprompter", "Wardrobe notes", "On-camera notes"] },
  { key: "editingJson", label: "Editing style", hint: "persistent edit preferences — distinct from one-job notes", fields: ["Pacing", "Captions", "Music", "Graphics & logo", "Color/grade", "Recurring revision patterns"] },
  { key: "storiesJson", label: "Stories, POVs & knowledge", hint: "raw material: real stories, strong opinions, local insight", fields: ["Stories", "Opinions / POVs", "Expertise", "Local knowledge"] },
];

export function ProfileSections({
  clientId, profile, customerNote,
}: {
  clientId: string;
  profile: Record<string, string | null>;
  /** THE customer note on the client record (src/lib/clientNotes.ts). */
  customerNote: string | null;
}) {
  return (
    <Section icon={NotebookPen} title="Agent profile" action={<ProfileBuildButton clientId={clientId} />}>
      <div className="space-y-2">
        {SECTIONS.map((s) => (
          <ProfileSection key={s.key} clientId={clientId} section={s} raw={profile[s.key] ?? null} />
        ))}
        {customerNote && (
          <p className="whitespace-pre-line rounded-lg bg-surface-2/60 px-3 py-2 text-[11px] text-muted">
            Customer notes on the client record: &ldquo;{customerNote.slice(0, 160)}&rdquo;
          </p>
        )}
      </div>
    </Section>
  );
}

function ProfileSection({ clientId, section, raw }: { clientId: string; section: (typeof SECTIONS)[number]; raw: string | null }) {
  let parsed: Record<string, string> = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(parsed);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const filled = Object.keys(parsed).length;

  return (
    <div className="rounded-xl border border-border">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className="flex-1 text-sm font-medium">{section.label}</span>
        <span className="text-[11px] text-muted-2">{filled > 0 ? `${filled} filled` : "empty"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
          <p className="text-[11px] text-muted-2">{section.hint}</p>
          {section.fields.map((f) => (
            <div key={f}>
              <label className="text-[11px] font-medium text-muted">{f}</label>
              <AutoTextarea value={values[f] ?? ""} minRows={1}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                className="mt-0.5 w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs outline-none focus:border-brand" />
            </div>
          ))}
          <button disabled={busy} onClick={() => start(async () => {
            const r = await saveProfileSection(clientId, section.key, values);
            setNote(r.message);
          })} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
            {busy ? <Loader2 className="inline size-3 animate-spin" /> : "Save"}
          </button>
          {note && <span className="ml-2 text-[11px] text-muted">{note}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes — chronological; "intelligence" notes feed AI context later.
// ---------------------------------------------------------------------------
export function NotesCard({
  clientId, notes,
}: {
  clientId: string;
  notes: { id: string; body: string; authorName: string | null; intelligence: boolean; at: string }[];
}) {
  const [body, setBody] = useState("");
  const [intel, setIntel] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <Section icon={NotebookPen} title="Program notes" count={notes.length} flush>
      <div className="px-5 py-3">
        <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} minRows={2} placeholder="Add a note…"
          className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs outline-none focus:border-brand" />
        <div className="mt-1.5 flex items-center gap-2">
          <button disabled={busy || !body.trim()} onClick={() => start(async () => {
            const r = await addContentNote(clientId, body, intel);
            setNote(r.ok ? null : r.message);
            if (r.ok) { setBody(""); setIntel(false); }
          })} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
            {busy ? <Loader2 className="inline size-3 animate-spin" /> : "Add note"}
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={intel} onChange={(e) => setIntel(e.target.checked)} className="accent-[var(--brand)]" />
            Also feed the AI&rsquo;s memory of this client
          </label>
        </div>
        {note && <p className="mt-1 text-[11px] text-danger">{note}</p>}
      </div>
      <div className="divide-y divide-border border-t border-border">
        {notes.map((n) => (
          <div key={n.id} className="px-5 py-2.5">
            <p className="whitespace-pre-wrap text-xs text-foreground/85">{n.body}</p>
            <p className="mt-0.5 text-[10px] text-muted-2">
              {n.authorName ?? "—"} · {new Date(n.at).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}
              {n.intelligence && <span className="ml-1.5 rounded bg-brand-soft px-1 py-0.5 text-brand">AI memory</span>}
            </p>
          </div>
        ))}
        {notes.length === 0 && <p className="px-5 py-3 text-xs text-muted">No notes yet.</p>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Enrollment settings — package override + workflow flags (spec §3).
// ---------------------------------------------------------------------------
export function EnrollmentSettingsCard({
  enrollmentId, pkg, status, packageSource, strategyCallRequired, clientSuppliesTopics, notes, billing, videosPerMonth = 4,
}: {
  enrollmentId: string; pkg: string; status: string; packageSource: string;
  strategyCallRequired: boolean; clientSuppliesTopics: boolean; notes: string | null;
  videosPerMonth?: number;
  // Owner-only: the page passes this ONLY for the owner; the action re-checks.
  billing?: { type: string | null; rate: number | null; months: number | null };
}) {
  const [state, setState] = useState({ pkg, status, strategyCallRequired, clientSuppliesTopics, notes: notes ?? "" });
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [bill, setBill] = useState({
    type: billing?.type ?? "",
    rate: billing?.rate != null ? String(billing.rate) : "",
    months: billing?.months != null ? String(billing.months) : "",
  });
  const saveBilling = (partial: Partial<typeof bill>) => {
    const next = { ...bill, ...partial };
    setBill(next);
    start(async () => {
      const r = await saveEnrollmentSettings(enrollmentId, {
        billingType: next.type || null,
        billingRate: next.rate.trim() === "" ? null : Number(next.rate.replace(/[$,\s]/g, "")),
        billingMonths: next.months.trim() === "" ? null : Number(next.months),
      });
      setNote(r.message);
    });
  };

  function save(partial: Partial<typeof state>) {
    const next = { ...state, ...partial };
    setState(next);
    start(async () => {
      const r = await saveEnrollmentSettings(enrollmentId, {
        package: next.pkg,
        status: next.status,
        strategyCallRequired: next.strategyCallRequired,
        clientSuppliesTopics: next.clientSuppliesTopics,
        notes: next.notes,
      });
      setNote(r.message);
    });
  }

  return (
    <Section icon={Settings2} title="Program settings"
      action={packageSource === "manual" ? <span className="text-[11px] text-warning">package set by hand — Aryeo no longer overrides it</span> : <span className="text-[11px] text-muted-2">package follows Aryeo</span>}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <label className="w-28 text-xs text-muted">Package</label>
          <select value={state.pkg} onChange={(e) => save({ pkg: e.target.value })}
            className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
            <option>Starter</option><option>Accelerator</option><option>Pro</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="w-28 text-xs text-muted">Status</label>
          <select value={state.status} onChange={(e) => save({ status: e.target.value })}
            className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
            <option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="ENDED">Ended</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={state.strategyCallRequired} onChange={(e) => save({ strategyCallRequired: e.target.checked })} className="accent-[var(--brand)]" />
          Monthly strategy call required
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={state.clientSuppliesTopics} onChange={(e) => save({ clientSuppliesTopics: e.target.checked })} className="accent-[var(--brand)]" />
          Client supplies their own topics
        </label>
        <div className="flex items-center gap-2">
          <label className="w-28 text-xs text-muted">Videos / month</label>
          <input
            defaultValue={videosPerMonth}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 31 && n !== videosPerMonth) {
                start(async () => { const r = await saveEnrollmentSettings(enrollmentId, { videosPerMonth: n }); setNote(r.message); });
              }
            }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            inputMode="numeric"
            className="w-16 rounded-lg border border-border bg-surface-2 px-2 py-1 text-right text-xs tabular-nums outline-none focus:border-brand"
            title="Custom deals (the 5-video clients) set their real number here — it survives package changes"
          />
        </div>

        {/* Billing terms — rendered only for the owner (the action re-checks). */}
        {billing !== undefined && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Billing · owner only</p>
            <div className="flex items-center gap-2">
              <label className="w-28 text-xs text-muted">How they pay</label>
              <select value={bill.type} onChange={(e) => saveBilling({ type: e.target.value })}
                className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
                <option value="">Not set</option>
                <option value="PAID_IN_FULL">Paid in full</option>
                <option value="MONTHLY_CONTRACT">Monthly · contract</option>
                <option value="MONTH_TO_MONTH">Month to month</option>
                <option value="TRIAL">Trial</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="w-28 text-xs text-muted">{bill.type === "PAID_IN_FULL" || bill.type === "TRIAL" ? "Amount" : "Rate / month"}</label>
              <input value={bill.rate} onChange={(e) => setBill((b) => ({ ...b, rate: e.target.value }))}
                onBlur={() => saveBilling({})} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                inputMode="decimal" placeholder="$"
                className="w-24 rounded-lg border border-border bg-surface-2 px-2 py-1 text-right text-xs tabular-nums outline-none focus:border-brand" />
            </div>
            <div className="flex items-center gap-2">
              <label className="w-28 text-xs text-muted">Term (months)</label>
              <input value={bill.months} onChange={(e) => setBill((b) => ({ ...b, months: e.target.value }))}
                onBlur={() => saveBilling({})} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                inputMode="numeric" placeholder="12, or blank for open-ended"
                className="w-40 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand" />
            </div>
          </div>
        )}
        {busy && <Loader2 className="size-3.5 animate-spin text-muted" />}
        {note && !busy && <p className="text-[11px] text-muted">{note}</p>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Content strategy — the active strategy's sections + the backfill upload.
// ---------------------------------------------------------------------------
export function StrategyCard({
  enrollmentId, strategy,
}: {
  enrollmentId: string;
  strategy: { sections: Record<string, string>; sourceFile: string | null; updatedAt: string } | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<StrategyPreview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <Section icon={Compass} title="Content strategy"
      action={strategy ? <span className="text-[11px] text-muted-2">{strategy.sourceFile ? `from ${strategy.sourceFile}` : "active"}</span> : undefined}>
      <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={(e) => {
        const f = e.target.files?.[0]; if (!f) return;
        const fd = new FormData(); fd.append("file", f);
        setNote(null);
        start(async () => {
          const p = await previewStrategyBackfill(fd);
          if (!p.ok) { setNote(p.message); return; }
          setPreview(p);
        });
        e.target.value = "";
      }} />

      {preview ? (
        <div className="space-y-3">
          <p className="text-sm"><Sparkles className="mr-1 inline size-3.5 text-brand" />{preview.message} Review, then save — it becomes the client&rsquo;s active strategy{strategy ? " and the current one is archived" : ""}.</p>
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border bg-surface-2/40 p-3">
            {Object.entries(preview.sections!).map(([k, v]) => (
              <details key={k} open>
                <summary className="cursor-pointer text-xs font-semibold">{k}</summary>
                <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">{v.slice(0, 2000)}{v.length > 2000 ? "…" : ""}</p>
              </details>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button disabled={busy} onClick={() => start(async () => {
              const r = await saveStrategyBackfill(enrollmentId, preview.sections!, preview.rawText ?? "", preview.sourceFile ?? "upload");
              setNote(r.message);
              if (r.ok) setPreview(null);
            })} className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy ? <Loader2 className="inline size-3 animate-spin" /> : "Save as active strategy"}
            </button>
            <button onClick={() => setPreview(null)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2">Discard</button>
          </div>
        </div>
      ) : strategy ? (
        <div className="space-y-2">
          {Object.entries(strategy.sections).map(([k, v]) => (
            <details key={k} className="rounded-xl border border-border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">{k}</summary>
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">{v}</p>
            </details>
          ))}
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline disabled:opacity-50">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            {busy ? "Reading the document…" : "Replace with an uploaded strategy"}
          </button>
        </div>
      ) : (
        <button onClick={() => fileRef.current?.click()} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2.5 text-sm text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {busy ? "Reading the document…" : "Upload their content strategy"}
        </button>
      )}
      {note && <p className="mt-2 text-[11px] text-muted">{note}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Script review — Jordan's loop: approve each script, ask the AI to revise
// with instructions, or edit it by hand. Everything stays internal until
// approved; the portal (Phase 5) will only ever show approved scripts.
// ---------------------------------------------------------------------------
export type ScriptRow = {
  id: string; title: string; body: string; status: string; source: string;
  sourceFile: string | null; productionIdeas: string[];
  // OPEN portal suggestions from the client (interactive layer, Aug 28).
  suggestions?: { id: string; body: string; createdAtISO: string }[];
};

const SCRIPT_STATUS: Record<string, { label: string; tone: "warn" | "ok" | "muted" }> = {
  DRAFT: { label: "needs your OK", tone: "warn" },
  INTERNAL_REVIEW: { label: "needs your OK", tone: "warn" },
  APPROVED: { label: "approved", tone: "ok" },
  CLIENT_VISIBLE: { label: "live in their portal", tone: "ok" },
  READY_TO_FILM: { label: "ready to film", tone: "ok" },
};

export function ScriptReview({ scripts }: { scripts: ScriptRow[] }) {
  return (
    <div className="divide-y divide-border">
      {scripts.map((s) => <ScriptItem key={s.id} script={s} />)}
      {scripts.length === 0 && <p className="px-5 py-4 text-sm text-muted">No scripts for this month yet — analyze the call transcript or add topics and generate.</p>}
    </div>
  );
}

function SuggestionRow({ suggestion }: { suggestion: { id: string; body: string; createdAtISO: string } }) {
  const [gone, setGone] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  if (gone) return <p className="mb-2 text-[11px] font-medium text-success">{gone}</p>;
  return (
    <div className="mb-2 rounded-lg border border-brand/30 bg-brand-soft/40 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-brand">
        Client suggestion · {new Date(suggestion.createdAtISO).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">{suggestion.body}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button disabled={busy} onClick={() => start(async () => {
          setNote("Rewriting with their suggestion…");
          const r = await applyScriptSuggestion(suggestion.id);
          if (r.ok) setGone(r.message); else setNote(r.message);
        })} className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} Apply with AI
        </button>
        <button disabled={busy} onClick={() => start(async () => {
          const r = await dismissScriptSuggestion(suggestion.id);
          if (r.ok) setGone("Dismissed."); else setNote(r.message);
        })} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2">Dismiss</button>
      </div>
      {note && <p className="mt-1 text-[11px] text-muted">{note}</p>}
    </div>
  );
}

function ScriptItem({ script }: { script: ScriptRow }) {
  const [mode, setMode] = useState<"read" | "revise" | "edit">("read");
  const [body, setBody] = useState(script.body);
  const [instructions, setInstructions] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const st = SCRIPT_STATUS[script.status] ?? { label: script.status.toLowerCase(), tone: "muted" as const };
  const needsReview = script.status === "INTERNAL_REVIEW" || script.status === "DRAFT";

  return (
    <details className="group px-5 py-3" open={needsReview}>
      <summary className="flex cursor-pointer items-center gap-2 marker:content-none">
        <FileText className="size-3.5 shrink-0 text-muted-2" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{script.title}</span>
        <span className={
          st.tone === "warn" ? "shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand"
          : st.tone === "ok" ? "shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success"
          : "shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted"
        }>{st.label}</span>
      </summary>

      <div className="mt-2">
        {/* The client's own asks, from their portal — apply runs the AI rewrite
            with their words and drops the script back to needs-your-review. */}
        {(script.suggestions ?? []).map((sg) => (
          <SuggestionRow key={sg.id} suggestion={sg} />
        ))}
        {mode === "edit" ? (
          <div>
            <AutoTextarea value={body} onChange={(e) => setBody(e.target.value)} minRows={6}
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-brand" />
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={busy} onClick={() => start(async () => {
                const r = await saveScriptText(script.id, body);
                setNote(r.message); if (r.ok) setMode("read");
              })} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">Save</button>
              <button onClick={() => { setBody(script.body); setMode("read"); }} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2">Cancel</button>
            </div>
          </div>
        ) : (
          /* Same bold-label rendering the client sees in the portal — Jordan's
             side reads the script the way it ships, not as a wall of text. */
          <ScriptBody body={body} size="sm" />
        )}

        {script.productionIdeas.length > 0 && mode === "read" && (
          <div className="mt-2 rounded-lg bg-surface-2/60 px-2.5 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-2">Production ideas (not spoken)</div>
            <ul className="mt-0.5 list-inside list-disc text-[11px] text-muted">
              {script.productionIdeas.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          </div>
        )}

        {mode === "revise" && (
          <div className="mt-2">
            <AutoTextarea value={instructions} onChange={(e) => setInstructions(e.target.value)} minRows={2}
              placeholder="Tell the AI what to change — e.g. 'hook is too generic, lead with the 1987 kitchen story' or 'shorter, punchier, drop the stats'…"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs outline-none focus:border-brand" />
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={busy || !instructions.trim()} onClick={() => start(async () => {
                setNote("Revising…");
                const r = await reviseScriptAI(script.id, instructions);
                setNote(r.message);
                if (r.ok) { setMode("read"); setInstructions(""); }
              })} className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} Revise
              </button>
              <button onClick={() => setMode("read")} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2">Cancel</button>
            </div>
          </div>
        )}

        {mode === "read" && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {script.status !== "READY_TO_FILM" && (
              <button disabled={busy} onClick={() => start(async () => { const r = await approveScript(script.id); setNote(r.ok ? null : r.message); })}
                className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2.5 py-1 text-xs font-semibold text-success hover:bg-success/25 disabled:opacity-50">
                <Check className="size-3" /> Approve
              </button>
            )}
            <button onClick={() => setMode("revise")} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
              <Sparkles className="size-3" /> Ask AI to revise
            </button>
            <button onClick={() => setMode("edit")} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
              Edit myself
            </button>
            {script.sourceFile && <span className="text-[10px] text-muted-2">from {script.sourceFile}</span>}
          </div>
        )}
        {note && <p className="mt-1.5 text-[11px] text-muted">{note}</p>}
      </div>
    </details>
  );
}


// One-click generators with result note — used by the bank + profile headers.
export function GenerateButton({ label, busyLabel, run }: { label: string; busyLabel: string; run: () => Promise<{ ok: boolean; message: string }> }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <span className="flex items-center gap-2">
      {note && <span className="max-w-64 truncate text-[11px] text-muted" title={note}>{note}</span>}
      <button disabled={busy} onClick={() => start(async () => { setNote(busyLabel); const r = await run(); setNote(r.message); })}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3 text-brand" />}
        {label}
      </button>
    </span>
  );
}

export function TopicSeedButton({ enrollmentId }: { enrollmentId: string }) {
  return <GenerateButton label="Generate ideas from strategy" busyLabel="Reading their strategy, calls & history…" run={() => generateTopicIdeas(enrollmentId)} />;
}
export function ProfileBuildButton({ clientId }: { clientId: string }) {
  return <GenerateButton label="Build from calls & content" busyLabel="Reading calls, strategy & filmed scripts…" run={() => buildProfile(clientId)} />;
}
