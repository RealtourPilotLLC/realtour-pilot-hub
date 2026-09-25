"use client";

import { useState, useTransition } from "react";
import {
  CalendarClock, Check, FileText, Loader2, NotebookPen, Settings2, Sparkles,
} from "lucide-react";
import { Section } from "@/components/ui/Section";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import {
  addContentNote, analyzeTranscript, buildProfile, generateTopicIdeas,
  saveMonthTranscript, saveProfileSection,
  applyScriptSuggestion, dismissScriptSuggestion,
  setStrategyCallStatus,
  staffChangePackageAction, staffSetEnrollmentStatusAction,
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
    : cur === "COMPLETED" ? (analyzed ? "Strategy call held — its topics are proposed on Video Topics" : "Strategy call held")
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
              })} className={quietLink} title="Run the extraction again — topics a person already confirmed, removed or rejected stay exactly as they are">
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
              Turn the call into proposed topics
            </button>
          ) : (
            <button onClick={() => setShowPaste(true)} className={quietLink}>Paste the transcript to propose topics from the call</button>
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

// (TopicBank — the Overview's copy of the month's topic list — was retired
// with UI-02: Plan › Topics' TopicsPanel holds the month's selections, the
// bank, add-a-topic and reject, with the capacity rules this copy never had.)

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
// PACKAGE, STATUS AND A CUSTOM DEAL'S COUNT — ledgered, and Kyle's too (UI-02).
//
// Replaces the Client file's EnrollmentSettingsCard, which saved all three
// straight onto the enrollment with no ProgramEnrollmentChange row. Every
// change here goes through staffChangePackageAction / staffSetEnrollmentStatus
// Action → enrollmentChanges: a ledger row first, an explicit effective month,
// and for the month already underway an explicit KEEP-or-APPLY choice (the
// button stays disabled until one is picked). Its call-requirement and
// own-topics flags already live on the Settings panel beside it, and billing
// terms stay the owner's (SettingsPanel, requireOwner) — Jordan's rule.
//
// `packageAndStatus` is false for the owner, whose SettingsPanel already
// carries those controls; the custom count (the 5-video Accelerators) is shown
// to both, because SettingsPanel has no field for it.
//
// THE FORM STARTS FROM NEXT MONTH'S TERMS (Sep 24 fix). It used to start from
// today's columns and compare with them — but a scheduled decision does not
// move the columns until its month begins, so after "Pro from October" (or a
// KEEP upgrade, which leaves this month's count) the card stayed armed, and a
// second press, or re-typing the Pro count, cancelled the decision it had just
// recorded. Now "next month" is compared with `nextTerms` (scheduled changes
// folded in, enrollmentChanges.termsInMonth), a scheduled change is named on
// the card, and a success resets the form.
// ---------------------------------------------------------------------------
export function EnrollmentControls({
  enrollmentId, pkg, status, videosPerMonth, sessionsPerMonth, nextTerms, packages, currentMonthKey, currentMonthLabel, nextMonthKey, nextMonthLabel, currentMonthOwed, packageAndStatus,
}: {
  enrollmentId: string; pkg: string; status: string; videosPerMonth: number; sessionsPerMonth: number;
  nextTerms: { pkg: string; videosPerMonth: number; sessionsPerMonth: number };
  packages: { name: string; videosPerMonth: number; sessionsPerMonth: number }[];
  currentMonthKey: string; currentMonthLabel: string; nextMonthKey: string; nextMonthLabel: string; currentMonthOwed: number | null;
  packageAndStatus: boolean;
}) {
  const [nextPkg, setNextPkg] = useState(nextTerms.pkg);
  const [videos, setVideos] = useState(String(nextTerms.videosPerMonth));
  const [when, setWhen] = useState<"now" | "next">("next");
  const [choice, setChoice] = useState<"KEEP" | "APPLY" | "">("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const rule = packages.find((p) => p.name === nextPkg) ?? null;
  const n = Number(videos);
  const videosOk = Number.isInteger(n) && n >= 1 && n <= 31;
  // A custom count survives a package change only when somebody types it: a
  // blank-or-rule number means "the package's own quantity".
  const customVideos = videosOk && (!rule || n !== rule.videosPerMonth) ? n : null;
  const differsFrom = (t: { pkg: string; videosPerMonth: number }) => nextPkg !== t.pkg || (videosOk && n !== t.videosPerMonth);
  const today = { pkg, videosPerMonth };
  const scheduled = nextTerms.pkg !== pkg || nextTerms.videosPerMonth !== videosPerMonth || nextTerms.sessionsPerMonth !== sessionsPerMonth;
  // "Next month" is a change only against what next month already runs on.
  // "This month" is one against today's terms OR next month's — undoing a
  // scheduled raise matches today's numbers and is still a decision.
  const changed = when === "next" ? differsFrom(nextTerms) : differsFrom(today) || differsFrom(nextTerms);
  const showWhen = differsFrom(today) || differsFrom(nextTerms);
  const needsChoice = changed && when === "now";
  const ready = changed && videosOk && (!needsChoice || choice !== "");

  return (
    <Section icon={Settings2} title={packageAndStatus ? "Package, videos & status" : "Custom video count"}
      action={<span className="text-[11px] text-muted-2">every change is recorded in the history below</span>}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {packageAndStatus && (
            <label className="flex items-center gap-2">
              <span className="text-xs text-muted">Package</span>
              <select value={nextPkg} disabled={busy} onChange={(e) => { setNextPkg(e.target.value); const r = packages.find((p) => p.name === e.target.value); if (r) setVideos(String(r.videosPerMonth)); }}
                className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand">
                {packages.map((p) => <option key={p.name} value={p.name}>{p.name} — {p.videosPerMonth} videos / {p.sessionsPerMonth} session{p.sessionsPerMonth === 1 ? "" : "s"}</option>)}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2" title="Custom deals (the 5-video clients) set their real number here">
            <span className="text-xs text-muted">Videos a month</span>
            <input value={videos} onChange={(e) => setVideos(e.target.value)} inputMode="numeric" disabled={busy}
              className="w-16 rounded-lg border border-border bg-surface-2 px-2 py-1 text-right text-xs tabular-nums outline-none focus:border-brand" />
          </label>
          <span className="text-[11px] text-muted-2">now {pkg} · {videosPerMonth} videos / {sessionsPerMonth} session{sessionsPerMonth === 1 ? "" : "s"}</span>
        </div>
        {scheduled && (
          <p className="text-[11px] font-medium text-brand">
            Scheduled from {nextMonthLabel}: {nextTerms.pkg} · {nextTerms.videosPerMonth} videos / {nextTerms.sessionsPerMonth} session{nextTerms.sessionsPerMonth === 1 ? "" : "s"} — see the history below.
          </p>
        )}

        {showWhen && (
          <div className="space-y-2 border-t border-border pt-3">
            <div>
              <p className="mb-1 text-xs font-medium">From when?</p>
              <label className="mr-4 inline-flex items-center gap-1.5 text-xs">
                <input type="radio" name={`when-${enrollmentId}`} checked={when === "next"} onChange={() => { setWhen("next"); setChoice(""); }} /> {nextMonthLabel} (next month)
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs">
                <input type="radio" name={`when-${enrollmentId}`} checked={when === "now"} onChange={() => setWhen("now")} /> {currentMonthLabel} (this month)
              </label>
            </div>
            {!changed && (
              <p className="text-[11px] text-muted-2">{when === "next" ? nextMonthLabel : currentMonthLabel} already runs on these terms — nothing to record.</p>
            )}
            {needsChoice && (
              <div className="rounded-xl border border-warning/40 bg-warning-soft/40 p-3 text-xs">
                <p className="mb-1 font-medium text-warning">{currentMonthLabel} is already underway — what happens to this month?</p>
                <label className="block"><input type="radio" name={`choice-${enrollmentId}`} checked={choice === "KEEP"} onChange={() => setChoice("KEEP")} />{" "}
                  Keep {currentMonthLabel} as it was minted{currentMonthOwed != null ? ` (${currentMonthOwed} videos)` : ""} — the new number starts {nextMonthLabel}.
                </label>
                <label className="block"><input type="radio" name={`choice-${enrollmentId}`} checked={choice === "APPLY"} onChange={() => setChoice("APPLY")} />{" "}
                  Apply {videosOk ? `${n} videos` : "the new number"} to {currentMonthLabel} as well.
                </label>
              </div>
            )}
            {changed && <input className="w-full rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-brand" placeholder="Why (optional — it goes in the history)" value={reason} onChange={(e) => setReason(e.target.value)} />}
            {changed && <button disabled={busy || !ready} onClick={() => start(async () => {
              const r = await staffChangePackageAction(enrollmentId, {
                package: nextPkg,
                effectiveMonthKey: when === "now" ? currentMonthKey : nextMonthKey,
                currentMonthChoice: when === "now" ? (choice as "KEEP" | "APPLY") : null,
                videosPerMonth: customVideos,
                reason: reason.trim() || null,
              });
              setNote({ ok: r.ok, text: r.message });
              // Disarm: back to the default month. The revalidated nextTerms
              // now hold what was just recorded, so the same values read as
              // "nothing to record" instead of offering to record them again.
              if (r.ok) { setReason(""); setChoice(""); setWhen("next"); }
            })} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {busy ? <Loader2 className="inline size-3 animate-spin" /> : "Record the change"}
            </button>}
            {!videosOk && <p className="text-[11px] text-warning">Videos a month must be a whole number from 1 to 31.</p>}
          </div>
        )}

        {packageAndStatus && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-xs">Currently <span className="font-semibold">{status.toLowerCase()}</span>.</span>
            {(["ACTIVE", "PAUSED", "ENDED"] as const).filter((x) => x !== status).map((x) => (
              <button key={x} disabled={busy} onClick={() => start(async () => {
                if (x === "ENDED" && !window.confirm("End this client's program? Their portal stays open, read-only, on work already released. It is recorded in the history and can be undone by marking them active.")) return;
                const r = await staffSetEnrollmentStatusAction(enrollmentId, x, reason.trim() || undefined);
                setNote({ ok: r.ok, text: r.message });
              })} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
                {x === "ACTIVE" ? "Mark active" : x === "PAUSED" ? "Pause" : "End"}
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-2">A hub setting only — nothing is billed, cancelled or charged.</p>
        {note && <p className={`text-[11px] ${note.ok ? "text-success" : "text-danger"}`}>{note.ok ? note.text : `Couldn't do that — ${note.text}`}</p>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// THE CLIENT'S SCRIPT CHANGE REQUESTS (UI-02). These OPEN ScriptSuggestion rows
// were only ever shown inside the Overview's ScriptReview list — which also
// carried a second, by-id Approve button. That list is retired (the Scripts
// view's version-exact ScriptsPanel is the one approval surface); the queue of
// client asks moves here, above it, with the same Apply-with-AI / Dismiss.
// ---------------------------------------------------------------------------
export type ScriptRequestGroup = { scriptId: string; title: string; versionNo: number | null; requests: { id: string; body: string; createdAtISO: string }[] };

export function ScriptRequestsPanel({ groups }: { groups: ScriptRequestGroup[] }) {
  const total = groups.reduce((n, g) => n + g.requests.length, 0);
  if (total === 0) return null;
  return (
    <Section icon={FileText} title="The client asked for changes" count={total}
      action={<span className="text-[11px] text-muted-2">apply rewrites it as a new version for review</span>}>
      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.scriptId}>
            <p className="mb-1 text-[13px] font-semibold">{g.title}{g.versionNo != null && <span className="ml-1.5 text-[11px] font-normal text-muted-2">now v{g.versionNo}</span>}</p>
            {g.requests.map((sg) => <SuggestionRow key={sg.id} suggestion={sg} />)}
          </div>
        ))}
      </div>
    </Section>
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
  return <GenerateButton label="Suggest video topics from the strategy" busyLabel="Reading their approved strategy, accepted facts & history…" run={() => generateTopicIdeas(enrollmentId)} />;
}
export function ProfileBuildButton({ clientId }: { clientId: string }) {
  return <GenerateButton label="Build from calls & content" busyLabel="Reading calls, strategy & filmed scripts…" run={() => buildProfile(clientId)} />;
}
