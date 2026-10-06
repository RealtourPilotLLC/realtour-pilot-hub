"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Eye, Users } from "lucide-react";
import {
  addProgramPilotClientAction, editProgramPilotAction, endProgramPilotAction, loadProgramRolloutPanel, previewProgramAudienceAction,
  removeProgramPilotClientAction, setProgramRolloutModeAction, type ProgramRolloutPanelData,
} from "@/app/settings/rolloutActions";
import { previewHeldAccessReleaseAction, releaseHeldAccessAction } from "@/app/content/portalAccessActions";
import { EVERY_CLIENT_CONFIRM } from "@/lib/programAutomationCopy";
import type { AudiencePreviewRow } from "@/lib/programAudiencePreview";
import { cn } from "@/lib/utils";
import { attemptPanelOperation, changeSettingsPanel, readSettingsPanel, refreshPanelChoice, type PanelActionResult, type PanelChoice } from "@/lib/settingsPanelFeedback";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";

// ---------------------------------------------------------------------------
// WHO THE PROGRAM MAY REACH (R03, Sep 28 2026) — the one list.
//
// Every client-facing program feature (reminders, the scripts-ready and
// office-replied emails, portal invitations and sign-in, the new layout,
// automatic sharing, review deadlines, automatic approval, carry-over) AND the
// hub's Aryeo/Calendly bookings for real clients read this: only your TEST
// clients (the default), your TEST clients plus the named pilot clients (up
// to PROGRAM_PILOT_MAX — 30 since Oct 5 2026, when each client got their own
// choices on Settings → Client onboarding), or every client with a program. A switch stays the on/off; this
// decides who. Plain words, owner edits, admins read (business default 4).
//
// Shown here, before anything is saved, exactly which clients and which
// features, the cap, the optional end date and who approved it when; and two
// read-only previews built from the functions the sends themselves run: what
// would go out now, and what releasing held portal access would do.
//
// A server action loads it when the card opens (like the hub-write scopes
// below it), so the switches above paint without waiting. `initial` lets a
// caller hand the data in (the drill renders it with react-dom/server).
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50";
const quiet = cn(btn, "border border-border text-muted hover:bg-surface-2 hover:text-foreground");
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null);
/** A stored pilot end (the NEXT ET midnight after the chosen day) back as that day. */
const endDay = (iso: string | null | undefined) => (iso ? day(new Date(Date.parse(iso) - 1).toISOString()) : null);
const endDayInput = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) - 1).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");
/** Thirty days from today in ET, for the "suggest" button (the end date is optional). */
const in30Days = () => new Date(Date.now() + 30 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const MODES: { key: ProgramRolloutPanelData["mode"]; label: string; words: string }[] = [
  { key: "TEST_ONLY", label: "Only my TEST clients", words: "Nothing reaches a real client. This is where everything starts." },
  { key: "PILOT", label: "My TEST clients and the clients I name below", words: "Only the clients you name, for the things you turn on. Each client's own choices are made on Client onboarding." },
  // "unless a feature's own lock holds it" (review fix, Sep 28 2026): the
  // reminders, auto-share and automatic-approval locks still narrow to TEST.
  { key: "ALL", label: "Every client with a program", words: `Every switch that is on reaches every client with a program, unless a feature's own lock holds it to TEST clients. The hub still books in Aryeo and Calendly only for the clients named below. You type ${EVERY_CLIENT_CONFIRM} to choose it.` },
];
const TIER_WORDS = { TEST: "TEST client", PILOT: "in the pilot", ALL: "everyone (rollout)" } as const;
const CODE_WORDS: Record<string, string> = {
  rollout_test_only: "not reached: TEST only",
  not_in_pilot: "not reached: not in the pilot",
  pilot_unapproved: "not reached: no approval",
  pilot_expired: "not reached: the pilot ended",
  operation_not_in_pilot: "in the pilot, but for none of the program's features",
  feature_test_only: "held by a feature lock",
  client_missing: "client gone",
  scope_unreadable: "not reached: could not read the rollout",
};

export function PilotForm({ data, busy, onSave }: { data: ProgramRolloutPanelData; busy: boolean; onSave: (input: Parameters<typeof addProgramPilotClientAction>[0]) => void }) {
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [typed, setTyped] = useState("");
  // Business default 1: every group ticked when Jordan approves a pilot.
  const [groups, setGroups] = useState<string[]>(data.pilot?.groups ?? data.groups.map((g) => g.key));
  const savedUntil = endDayInput(data.pilot?.expiresAtISO);
  const [until, setUntil] = useState(savedUntil);
  const [note, setNote] = useState("");
  const candidate = data.candidates.find((c) => c.id === clientId) ?? null;
  const picked = candidate ?? (clientId ? { id: clientId, name: clientName } : null);
  const matches = !!candidate && typed.trim().replace(/\s+/g, " ").toLowerCase() === candidate.name.trim().replace(/\s+/g, " ").toLowerCase();
  const atCap = (data.pilot?.clients.length ?? 0) >= data.cap;
  return (
    <fieldset disabled={busy} className="mt-2 space-y-2 rounded-xl border border-warning/50 bg-warning-soft/40 p-3 text-[13px]">
      <legend className="font-medium">Name a real client for the pilot</legend>
      <p className="text-muted">They get the ticked things once the rollout is set to &ldquo;My TEST clients and the clients I name below&rdquo; and each switch is on. Type their name to confirm.</p>
      <label className="block">
        <span className="text-[14px] text-muted">Client (real clients with an active program)</span>
        <select className="mt-0.5 min-h-11 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={clientId} onChange={(e) => { setClientId(e.target.value); setClientName(data.candidates.find((c) => c.id === e.target.value)?.name ?? ""); setTyped(""); }}>
          <option value="">Choose a program client…</option>
          {picked && !candidate && <option value={picked.id}>{picked.name} (no longer available to add)</option>}
          {data.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {picked && (
        <label className="block">
          <span className="text-[14px] text-muted">Type &ldquo;{picked.name}&rdquo; to confirm</span>
          <input className="mt-0.5 min-h-11 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      )}
      <fieldset className="space-y-1">
        <legend className="text-[14px] text-muted">What the pilot covers (for every client in it)</legend>
        {data.groups.map((g) => (
          <label key={g.key} className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="mt-0.5" checked={groups.includes(g.key)} onChange={(e) => setGroups((cur) => (e.target.checked ? [...cur, g.key] : cur.filter((x) => x !== g.key)))} />
            <span>{g.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-[14px] text-muted">{savedUntil ? "Ends (the whole pilot)" : "Ends (optional)"}</span>
          <input type="date" className="mt-0.5 block min-h-11 rounded-lg border border-border bg-surface px-2 py-1.5" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        {!until && <button type="button" className={quiet} onClick={() => setUntil(in30Days())}>Suggest 30 days</button>}
        <label className="block min-w-0 flex-1">
          <span className="text-[14px] text-muted">Note (optional)</span>
          <input className="mt-0.5 min-h-11 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>
      <button
        className={cn(btn, "bg-brand-action text-white")}
        disabled={busy || atCap || !matches || groups.length === 0}
        onClick={() => onSave({ clientId, typedName: typed, groups, expiresOnET: until || null, clearExpiry: !until && !!savedUntil, note })}
      >
        Approve for the pilot
      </button>
    </fieldset>
  );
}

/** Does any named client have their own choices (Settings → Client onboarding)? Then this card edits only the whole list. */
export const hasPerClientChoices = (data: ProgramRolloutPanelData): boolean => !!data.pilot?.clients.some((c) => c.own != null);

export function EditPilotForm({ data, busy, onSave }: { data: ProgramRolloutPanelData; busy: boolean; onSave: (input: Parameters<typeof editProgramPilotAction>[0]) => void }) {
  const [groups, setGroups] = useState<string[]>(data.pilot?.groups ?? []);
  const savedUntil = endDayInput(data.pilot?.expiresAtISO);
  const [until, setUntil] = useState(savedUntil);
  // Oct 5 2026: with per-client choices, what each client gets is changed on
  // Client onboarding only; here, just when the whole list ends.
  const perClient = hasPerClientChoices(data);
  return (
    <fieldset disabled={busy} className="mt-2 space-y-2 rounded-xl border border-border bg-surface-2/40 p-3 text-[13px]">
      <legend className="font-medium">{perClient ? "Change when the pilot ends" : "Change what the pilot covers, or when it ends"}</legend>
      {perClient
        ? <p className="text-muted">What each client gets is changed on <a href="/settings/onboarding" className="font-medium text-brand hover:underline">Client onboarding</a>, one client at a time.</p>
        : (
          <fieldset className="space-y-1">
            {data.groups.map((g) => (
              <label key={g.key} className="flex min-h-11 items-center gap-2">
                <input type="checkbox" className="mt-0.5" checked={groups.includes(g.key)} onChange={(e) => setGroups((cur) => (e.target.checked ? [...cur, g.key] : cur.filter((x) => x !== g.key)))} />
                <span>{g.label}</span>
              </label>
            ))}
          </fieldset>
        )}
      <label className="block">
        <span className="text-[14px] text-muted">Ends (empty = no end date)</span>
        <input type="date" className="mt-0.5 block min-h-11 rounded-lg border border-border bg-surface px-2 py-1.5" value={until} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <button className={cn(btn, "bg-brand-action text-white")} disabled={busy || (!perClient && groups.length === 0)}
        onClick={() => onSave(perClient ? { expiresOnET: until || null, clearExpiry: !until && !!savedUntil } : { groups, expiresOnET: until || null, clearExpiry: !until && !!savedUntil })}>
        Save the pilot
      </button>
    </fieldset>
  );
}

/** The two read-only previews: what would go out now, and held portal access. */
function Previews({ isOwner, disabled, scopeVersion }: { isOwner: boolean; disabled: boolean; scopeVersion: string }) {
  const [rows, setRows] = useState<AudiencePreviewRow[] | null>(null);
  const [rowsNote, setRowsNote] = useState<PanelActionResult | null>(null);
  const [rowsVersion, setRowsVersion] = useState<string | null>(null);
  const [held, setHeld] = useState<Awaited<ReturnType<typeof previewHeldAccessReleaseAction>> | null>(null);
  const [heldVersion, setHeldVersion] = useState<string | null>(null);
  const [heldCurrent, setHeldCurrent] = useState(false);
  const [released, setReleased] = useState<Awaited<ReturnType<typeof releaseHeldAccessAction>> | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const running = useRef(false);
  const run = (label: string, operation: () => Promise<void>) => {
    if (running.current || disabled) return;
    running.current = true;
    setPending(label);
    start(async () => {
      try { await operation(); }
      finally { running.current = false; setPending(null); }
    });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className={quiet} disabled={busy || disabled} onClick={() => run("Reading the audience preview…", async () => {
          const r = await attemptPanelOperation(previewProgramAudienceAction, { ok: false, message: "The audience preview could not be read. Try the preview again; nothing was sent by this preview.", rows: [] });
          if (r.ok) { setRows(r.rows); setRowsVersion(scopeVersion); }
          setRowsNote(r);
        })}>
          <Eye className="mr-1 inline size-3" aria-hidden />What would go out now? (writes nothing)
        </button>
        {isOwner && (
          <button className={quiet} disabled={busy || disabled} onClick={() => run("Reading held portal access…", async () => {
            const r = await attemptPanelOperation(previewHeldAccessReleaseAction, { ok: false, message: "Held portal access could not be read. Try Preview again before releasing anything." });
            if (r.ok) setReleased(null);
            setHeld((previous) => r.ok ? r : { ...r, preview: previous?.preview });
            setHeldCurrent(r.ok);
            if (r.ok) setHeldVersion(scopeVersion);
          })}>
            Held portal access: preview
          </button>
        )}
      </div>
      {pending && <p role="status" aria-live="polite" className="text-sm text-muted">{pending}</p>}
      {rowsNote && <p role={rowsNote.ok ? "status" : "alert"} className={cn("text-sm", rowsNote.ok ? "text-muted" : "text-danger")}>{rowsNote.message}</p>}
      {rows && (!rowsNote?.ok || rowsVersion !== scopeVersion) && <p className="text-sm text-warning">The audience rows below are from an earlier preview. Preview again to check the current scope.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr><th className="px-2 py-1.5">Client</th><th className="px-2 py-1.5">Reached as</th><th className="px-2 py-1.5">What</th><th className="px-2 py-1.5">To</th><th className="px-2 py-1.5">Decision</th><th className="px-2 py-1.5">Why</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.lane}:${r.clientId}:${i}`} data-preview-lane={r.lane} data-preview-decision={r.decision} className="border-t border-border align-top">
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.clientName}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.tier ? TIER_WORDS[r.tier] : r.code ? CODE_WORDS[r.code] ?? r.code : "—"}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.lane.toLowerCase().replace(/_/g, " ")}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-muted">{r.to ?? "—"}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap"><span className={cn("rounded-full px-2 py-0.5 text-[13px] font-semibold", r.decision === "send" ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>{r.decision === "on_release" ? "on Release" : r.decision}</span></td>
                  <td className="px-2 py-1.5 text-muted">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {held && (
        <div className="rounded-lg border border-border p-2 text-[14px]">
          <p role={held.ok ? "status" : "alert"} className={held.ok ? "text-foreground" : "text-danger"}>{held.message}</p>
          {held.preview && (!heldCurrent || heldVersion !== scopeVersion) && <p className="mt-1 text-warning">The account details below are from an earlier preview. Preview again before another release.</p>}
          {held.preview && (
            <ul className="mt-1 space-y-0.5 text-muted">
              {held.preview.grant.map((o) => <li key={`g:${o.enrollmentId}:${o.email}`}>Would open: {o.clientName} · {o.email} ({o.reason}, owed since {day(o.since)})</li>)}
              {held.preview.stay.map((o) => <li key={`s:${o.enrollmentId}:${o.email}`}>Stays held: {o.clientName} · {o.email} — {o.why}</li>)}
            </ul>
          )}
          {isOwner && held.preview && held.preview.grant.length > 0 && (
            <button className={cn(btn, "mt-2 bg-brand-action text-white")} disabled={busy || disabled || !held.ok || !heldCurrent || heldVersion !== scopeVersion}
              onClick={() => run("Releasing held portal access…", async () => {
                const r = await attemptPanelOperation(releaseHeldAccessAction, { ok: false, message: "The request ended without an outcome. Some accounts or welcomes may have been processed.", granted: 0, held: 0, conflicts: [] });
                setReleased(r);
                setHeldCurrent(false);
              })}>
              Release: open {held.preview.grant.length} account{held.preview.grant.length === 1 ? "" : "s"} and send their welcome
            </button>
          )}
        </div>
      )}
      {released && <HeldAccessReceipt result={released} />}
    </div>
  );
}

export function HeldAccessReceipt({ result }: { result: Awaited<ReturnType<typeof releaseHeldAccessAction>> }) {
  const partial = result.ok && (result.held > 0 || result.conflicts.length > 0);
  return <p role={result.ok ? "status" : "alert"} aria-live={result.ok ? "polite" : "assertive"} className={cn("text-sm", !result.ok ? "text-danger" : partial ? "text-warning" : "text-foreground")}>
    {!result.ok ? <strong>Release not confirmed. </strong> : partial ? <strong>Some access remains held or needs attention. </strong> : null}{result.message}
    {(!result.ok || partial) && " Preview held access again before another release."}
  </p>;
}

export function ProgramRolloutPanel({ isOwner, initial = null }: { isOwner: boolean; initial?: ProgramRolloutPanelData | null }) {
  const [data, setData] = useState<ProgramRolloutPanelData | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<PanelActionResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<PanelChoice<ProgramRolloutPanelData["mode"]>>({ value: initial?.mode ?? null, saved: initial?.mode ?? null });
  const [confirmText, setConfirmText] = useState("");
  const [reading, setReading] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [busy, start] = useTransition();
  const changing = useRef(false);
  const readingRef = useRef(false);
  const uncertain = useRef(false);
  const load = useCallback(async () => {
    if (readingRef.current || changing.current) return;
    readingRef.current = true;
    setReading(true);
    try {
      const r = await readSettingsPanel(loadProgramRolloutPanel);
      if (r.ok) { setData(r.data); setMode((current) => refreshPanelChoice(current, r.data.mode)); setError(null); uncertain.current = false; setRequiresRefresh(false); }
      else setError(r.message);
    } finally { readingRef.current = false; setReading(false); }
  }, []);
  useEffect(() => { if (!initial) void load(); }, [initial, load]);
  const change = (action: () => Promise<PanelActionResult>, completedForm?: "add" | "edit" | "mode") => {
    if (changing.current || readingRef.current || uncertain.current) return;
    changing.current = true;
    setNote(null);
    start(async () => {
      try {
        const outcome = await changeSettingsPanel(action, loadProgramRolloutPanel);
        setNote(outcome.result);
        if (outcome.requiresRefresh) { uncertain.current = true; setRequiresRefresh(true); }
        if (outcome.read?.ok) {
          const next = outcome.read.data;
          setData(next); setMode((current) => refreshPanelChoice(current, next.mode)); setError(null);
        }
        else if (outcome.read) setError(outcome.read.message);
        if (outcome.result.ok) {
          // Only the submitted form is finished. Other draft choices stay put.
          if (completedForm === "add") setAdding(false);
          if (completedForm === "edit") setEditing(false);
          if (completedForm === "mode") {
            setConfirmText("");
            if (outcome.read?.ok) setMode({ value: outcome.read.data.mode, saved: outcome.read.data.mode });
          }
        }
      } finally { changing.current = false; }
    });
  };

  // The anchor is on every state: the reminders card and readiness link here.
  if (error && !data) return <div id="program-rollout" className="scroll-mt-28 space-y-2 text-sm">
    <p role="alert">{error}</p><Button variant="secondary" busy={reading} onClick={() => void load()}>Refresh program scope</Button>
  </div>;
  if (!data) return <p id="program-rollout" className="scroll-mt-28 text-[13px] text-muted">Reading who the program may reach…</p>;

  const p = data.pilot;
  const atCap = (p?.clients.length ?? 0) >= data.cap;
  const perClient = hasPerClientChoices(data);
  const chosen = mode.value ?? data.mode;
  const controlsBusy = busy || reading || !!error || requiresRefresh;
  const scopeVersion = JSON.stringify([data.mode, data.pilot, data.updatedAtISO, data.switchesOn]);
  return (
    <div id="program-rollout" data-rollout-mode={data.mode} className="scroll-mt-28 space-y-3 rounded-xl border border-border p-3 sm:p-4">
      <div className="flex items-start gap-2 text-[13px]">
        <Users className="mt-0.5 size-4 shrink-0 text-muted-2" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">Who the program may reach</p>
          <p className="text-muted">
            One list for every client-facing program feature and for the hub&rsquo;s Aryeo and Calendly bookings. A switch above is the on/off; this decides who.
            {!isOwner && " Only Jordan can change it."}
          </p>
        </div>
      </div>
      {data.problem && <p className="rounded-lg bg-warning/10 px-3 py-2 text-[14px] text-warning">The stored setting could not be read, so only TEST clients are reached, and it cannot be changed here until it is fixed: {data.problem}.</p>}
      {note && !busy && <SaveStatus state={note.ok ? "saved" : "error"} message={note.message} />}
      {busy && <SaveStatus state="saving" message="Updating the submitted program scope…" />}
      {error && <p role="alert" className="rounded-lg border border-warning/50 px-3 py-2 text-sm text-warning">The current program scope could not be refreshed. The last loaded details and your remaining inputs are still here; refresh before another change.</p>}
      {requiresRefresh && !error && <p className="text-sm text-warning">Changes are paused until Refresh confirms the current program scope. Your inputs and the last loaded details remain here.</p>}
      <Button variant="secondary" busy={reading} disabled={busy} onClick={() => void load()}>Refresh program scope</Button>

      {/* THE MODE, in plain words. */}
      <fieldset className="space-y-1.5" disabled={!isOwner || controlsBusy}>
        <legend className="text-[14px] text-muted">
          Reaching now: <span className="font-medium text-foreground">{MODES.find((m) => m.key === data.mode)?.label}</span>
          {data.modeSinceISO && <> · since {day(data.modeSinceISO)}</>}
          {data.updatedBy && <> · last changed by {data.updatedBy}{data.updatedAtISO ? ` on ${day(data.updatedAtISO)}` : ""}</>}
        </legend>
        {isOwner && MODES.map((m) => (
          <label key={m.key} className="flex min-h-11 items-start gap-2 py-2 text-[13px]">
            <input type="radio" name="program-rollout-mode" className="mt-1" checked={chosen === m.key} onChange={() => { setMode((current) => ({ ...current, value: m.key })); setConfirmText(""); }} />
            <span><span className="font-medium">{m.label}</span> <span className="text-muted">— {m.words}</span></span>
          </label>
        ))}
      </fieldset>
      {isOwner && chosen !== data.mode && (
        <div className="flex flex-wrap items-center gap-2">
          {chosen === "ALL" && (
            <label className="text-[14px] text-muted">
              Type {EVERY_CLIENT_CONFIRM}{" "}
              <input className="ml-1 min-h-11 rounded-lg border border-border bg-surface px-2 py-1" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} disabled={controlsBusy} autoComplete="off" />
            </label>
          )}
          <button className={cn(btn, "bg-brand-action text-white")} disabled={controlsBusy || (chosen === "ALL" && confirmText.trim() !== EVERY_CLIENT_CONFIRM)}
            onClick={() => change(() => setProgramRolloutModeAction({ mode: chosen, typedConfirm: confirmText }), "mode")}>
            Save: {MODES.find((m) => m.key === chosen)?.label}
          </button>
          <button className={quiet} disabled={controlsBusy} onClick={() => { setMode({ value: data.mode, saved: data.mode }); setConfirmText(""); }}>Cancel</button>
        </div>
      )}

      {/* THE PILOT: who, what, until when, who approved it. */}
      <div className="text-[14px]">
        <p>
          <span className="font-medium">Pilot</span> <span className="text-muted">(at most {data.cap} real clients; choose each client&rsquo;s features on <a href="/settings/onboarding" className="font-medium text-brand hover:underline">Client onboarding</a>)</span>:{" "}
          {p ? (
            <>
              <span className={cn("rounded-full px-2 py-0.5 text-[13px] font-semibold", p.state === "ACTIVE" ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>{p.state.toLowerCase()}</span>
              {" "}{p.clients.every((c) => c.own) ? "each client has their own choices" : <>covers {p.clients.some((c) => c.own) ? "(for clients without their own choices) " : ""}{data.groups.filter((g) => p.groups.includes(g.key)).map((g) => g.label.toLowerCase()).join("; ") || "nothing"}</>}
              {p.approvedBy && <> · approved by {p.approvedBy}{p.approvedAtISO ? ` on ${day(p.approvedAtISO)}` : ""}</>}
              {p.expiresAtISO ? <> · ends {endDay(p.expiresAtISO)}</> : <> · no end date</>}
              {p.note && <> · {p.note}</>}
              {data.mode !== "PILOT" && <span className="text-muted"> · on file, but the rollout is not set to a pilot, so it reaches {data.mode === "ALL" ? "everyone anyway" : "nobody real"}</span>}
            </>
          ) : <span className="text-muted">nobody named.</span>}
        </p>
        {p && (
          <ul className="mt-1 space-y-0.5">
            {p.clients.map((c) => (
              <li key={c.id} data-pilot-client={c.id} className="flex flex-wrap items-center gap-2">
                <span>{c.name}</span>
                {c.own && <span className="text-muted">own choices: {c.own.length ? c.own.join(", ") : "nothing"}</span>}
                {c.joinedAtISO && <span className="text-muted">joined {day(c.joinedAtISO)}</span>}
                {isOwner && (
                  <button className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50" disabled={controlsBusy}
                    aria-label={`Take ${c.name} out of the pilot`}
                    onClick={() => change(() => removeProgramPilotClientAction({ clientId: c.id }))}>
                    Take out of the pilot
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {isOwner && perClient && (
        <p className="text-[14px] text-muted" data-per-client-home>
          Each client here has their own choices. Add a client, or change what one gets, on{" "}
          <a href="/settings/onboarding" className="font-medium text-brand hover:underline">Client onboarding</a> — it changes only that client.
        </p>
      )}
      {isOwner && (
        <div className="flex flex-wrap gap-2">
          {!perClient && (
            <button className={quiet} disabled={controlsBusy || (atCap && !adding)} title={atCap ? `The pilot has ${data.cap} clients, the most it may have` : undefined} onClick={() => { setAdding(!adding); setEditing(false); }}>
              {adding ? "Cancel" : atCap ? `Pilot is full (${data.cap})` : "Add a pilot client"}
            </button>
          )}
          {p && <button className={quiet} disabled={controlsBusy} onClick={() => { setEditing(!editing); setAdding(false); }}>{editing ? "Cancel" : perClient ? "Change when it ends" : "Change the pilot"}</button>}
          {p && (
            <button className={quiet} disabled={controlsBusy} onClick={() => change(endProgramPilotAction)}>
              End the pilot
            </button>
          )}
        </div>
      )}
      {isOwner && adding && !perClient && <PilotForm data={data} busy={controlsBusy} onSave={(input) => change(() => addProgramPilotClientAction(input), "add")} />}
      {isOwner && editing && p && <EditPilotForm data={data} busy={controlsBusy} onSave={(input) => change(() => editProgramPilotAction(input), "edit")} />}

      {/* EVERY PROGRAM CLIENT, and whether the rollout reaches them. */}
      {data.audience.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Program clients and whether the rollout reaches them">
          {data.audience.map((c) => (
            <li key={c.clientId} title={c.reason} data-audience-client={c.clientId} data-audience-tier={c.tier ?? c.code ?? ""} data-audience-groups={c.groups.join("|")} className={cn("rounded-full px-2 py-0.5 text-[11px]", c.tier ? "bg-success/15 text-success" : "bg-surface-2 text-muted")}>
              {c.name}: {c.tier ? TIER_WORDS[c.tier] : c.code ? CODE_WORDS[c.code] ?? c.code : "not reached"}
              {/* Which groups, named (review fix, Sep 28 2026): one op used to
                  stand for all of them. */}
              {c.tier === "PILOT" && c.groups.length > 0 && <> — {c.groups.join(", ")}</>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[14px] text-muted">
        {data.switchesOn.length
          ? <>Client-reaching switches that are on: {data.switchesOn.join(", ")}.</>
          : <>No client-reaching switch is on, so this list reaches nobody yet.</>}
        {" "}Taking a client out stops everything further, including anything already queued; their people go back to the shared portal link (their seats are kept).
      </p>

      <Previews isOwner={isOwner} disabled={controlsBusy} scopeVersion={scopeVersion} />
    </div>
  );
}
