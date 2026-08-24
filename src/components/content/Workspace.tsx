"use client";

import { useRef, useState, useTransition } from "react";
import {
  CalendarClock, Check, Compass, FileText, FileUp, Loader2, NotebookPen, Plus, Settings2, Sparkles, Trash2, Upload, X,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import {
  addContentNote, addTopic, analyzeTranscript, approveScript, previewScriptBackfill, previewStrategyBackfill,
  reviseScriptAI, saveEnrollmentSettings, saveMonthTranscript, saveProfileSection, saveScriptBackfill,
  saveScriptText, saveStrategyBackfill, setStrategyCallStatus, setTopicStatus,
  type BackfillPreview, type StrategyPreview,
} from "@/app/content/actions";

// ---------------------------------------------------------------------------
// Strategy call card — status ladder + manual transcript paste (Phase 3 wires
// Calendly + Meet automation; the manual path always survives as the fallback).
// ---------------------------------------------------------------------------
const CALL_STEPS: { key: string; label: string }[] = [
  { key: "NOT_SCHEDULED", label: "Not scheduled" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "COMPLETED", label: "Completed" },
  { key: "SKIPPED", label: "Skipped" },
  { key: "NOT_REQUIRED", label: "Not required" },
];

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
  const [busy, start] = useTransition();

  return (
    <Section icon={CalendarClock} title="Strategy call" action={!required ? <span className="text-[11px] text-muted-2">not required for this client</span> : undefined}>
      <div className="flex flex-wrap gap-1.5">
        {CALL_STEPS.map((s) => (
          <button
            key={s.key}
            disabled={busy}
            onClick={() => start(async () => {
              const r = await setStrategyCallStatus(monthId, s.key);
              if (r.ok) setCur(s.key); else setNote(r.message);
            })}
            className={
              cur === s.key
                ? "rounded-lg bg-brand px-2.5 py-1 text-xs font-semibold text-white"
                : "rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2"
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      {at && <p className="mt-2 text-xs text-muted">Booked for {new Date(at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET</p>}

      {/* The client's booking link — copy it into a text, or it goes out
          automatically as a drafted invite on the 1st. */}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="truncate text-xs font-medium text-brand hover:underline">
          {bookingUrl.replace("https://", "")}
        </a>
        <button
          onClick={() => { navigator.clipboard?.writeText(bookingUrl); setNote("Booking link copied."); }}
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[10px] font-medium text-muted hover:bg-surface-2"
        >
          Copy link
        </button>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {hasTranscript && !showPaste ? (
          transcriptProcessed ? (
            <p className="text-xs text-success"><Check className="mr-1 inline size-3.5" />Transcript analyzed — topics and scripts are below.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-success"><Check className="mr-1 inline size-3.5" />Transcript on file.</p>
              <button disabled={busy} onClick={() => start(async () => {
                setNote("Analyzing the call — this takes a moment…");
                const r = await analyzeTranscript(monthId);
                setNote(r.message);
              })} className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                Analyze → topics + scripts
              </button>
            </div>
          )
        ) : showPaste ? (
          <div>
            <AutoTextarea value={transcript} onChange={(e) => setTranscript(e.target.value)} minRows={4}
              placeholder="Paste the Google Meet transcript here…"
              className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-xs outline-none focus:border-brand" />
            <div className="mt-1.5 flex gap-1.5">
              <button disabled={busy || !transcript.trim()} onClick={() => start(async () => {
                const r = await saveMonthTranscript(monthId, transcript);
                setNote(r.message); if (r.ok) { setShowPaste(false); setCur("COMPLETED"); }
              })} className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                {busy ? <Loader2 className="inline size-3 animate-spin" /> : "Save transcript"}
              </button>
              <button onClick={() => setShowPaste(false)} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowPaste(true)} className="text-xs font-medium text-brand hover:underline">
            {hasTranscript ? "Replace transcript" : "Paste call transcript"}
          </button>
        )}
      </div>
      {note && <p className="mt-2 text-[11px] text-muted">{note}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Topic bank / month plan — add, promote to month, reject.
// ---------------------------------------------------------------------------
type TopicRow = { id: string; title: string; concept: string | null; pillar: string | null; status: string; source: string };

export function TopicBank({
  enrollmentId, monthId, topics, mode,
}: {
  enrollmentId: string; monthId: string | null; topics: TopicRow[]; mode: "month" | "bank";
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
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t.title}</span>
                {t.pillar && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">{t.pillar}</span>}
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-2">{t.status.toLowerCase()}</span>
              </div>
              {t.concept && <p className="mt-0.5 text-xs text-muted">{t.concept}</p>}
            </div>
            {mode === "bank" && monthId && (
              <button disabled={busy} title="Plan into the selected month"
                onClick={() => start(async () => { const r = await setTopicStatus(t.id, "SELECTED", monthId); if (!r.ok) setNote(r.message); })}
                className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground">
                Plan this month
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
                <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/80">{s.body.slice(0, 1200)}{s.body.length > 1200 ? "…" : ""}</p>
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
  clientId, profile, editingPreferences,
}: {
  clientId: string;
  profile: Record<string, string | null>;
  editingPreferences: string | null;
}) {
  return (
    <Section icon={NotebookPen} title="Agent profile" action={<span className="text-[11px] text-muted-2">the living memory of this relationship</span>}>
      <div className="space-y-2">
        {SECTIONS.map((s) => (
          <ProfileSection key={s.key} clientId={clientId} section={s} raw={profile[s.key] ?? null} />
        ))}
        {editingPreferences && (
          <p className="rounded-lg bg-surface-2/60 px-3 py-2 text-[11px] text-muted">
            Existing editing notes on the client record: &ldquo;{editingPreferences.slice(0, 160)}&rdquo;
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
  enrollmentId, pkg, status, packageSource, strategyCallRequired, clientSuppliesTopics, notes,
}: {
  enrollmentId: string; pkg: string; status: string; packageSource: string;
  strategyCallRequired: boolean; clientSuppliesTopics: boolean; notes: string | null;
}) {
  const [state, setState] = useState({ pkg, status, strategyCallRequired, clientSuppliesTopics, notes: notes ?? "" });
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();

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
};

const SCRIPT_STATUS: Record<string, { label: string; tone: "warn" | "ok" | "muted" }> = {
  DRAFT: { label: "draft", tone: "muted" },
  INTERNAL_REVIEW: { label: "needs your review", tone: "warn" },
  APPROVED: { label: "approved", tone: "ok" },
  CLIENT_VISIBLE: { label: "client visible", tone: "ok" },
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
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{script.title}</span>
        <span className={
          st.tone === "warn" ? "rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning"
          : st.tone === "ok" ? "rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-medium text-success"
          : "rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted"
        }>{st.label}</span>
      </summary>

      <div className="mt-2">
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
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">{body}</p>
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
