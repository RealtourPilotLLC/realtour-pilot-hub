"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Eye, Users } from "lucide-react";
import {
  addProgramPilotClientAction, editProgramPilotAction, endProgramPilotAction, loadProgramRolloutPanel, previewProgramAudienceAction,
  removeProgramPilotClientAction, setProgramRolloutModeAction, type ProgramRolloutPanelData,
} from "@/app/settings/rolloutActions";
import { previewHeldAccessReleaseAction, releaseHeldAccessAction } from "@/app/content/portalAccessActions";
import { EVERY_CLIENT_CONFIRM } from "@/lib/programAutomationCopy";
import type { AudiencePreviewRow } from "@/lib/programAudiencePreview";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WHO THE PROGRAM MAY REACH (R03, Sep 28 2026) — the one list.
//
// Every client-facing program feature (reminders, the scripts-ready and
// office-replied emails, portal invitations and sign-in, the new layout,
// automatic sharing, review deadlines, automatic approval, carry-over) AND the
// hub's Aryeo/Calendly bookings for real clients read this: only your TEST
// clients (the default), your TEST clients plus up to three named pilot
// clients, or every client with a program. A switch stays the on/off; this
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

const btn = "rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50";
const quiet = cn(btn, "border border-border text-muted hover:bg-surface-2 hover:text-foreground");
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null);
/** A stored pilot end (the NEXT ET midnight after the chosen day) back as that day. */
const endDay = (iso: string | null | undefined) => (iso ? day(new Date(Date.parse(iso) - 1).toISOString()) : null);
const endDayInput = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) - 1).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");
/** Thirty days from today in ET, for the "suggest" button (the end date is optional). */
const in30Days = () => new Date(Date.now() + 30 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const MODES: { key: ProgramRolloutPanelData["mode"]; label: string; words: string }[] = [
  { key: "TEST_ONLY", label: "Only my TEST clients", words: "Nothing reaches a real client. This is where everything starts." },
  { key: "PILOT", label: "My TEST clients and the clients I name below", words: "At most three real clients, for the things you tick." },
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

function PilotForm({ data, onDone }: { data: ProgramRolloutPanelData; onDone: (msg: string, ok: boolean) => void }) {
  const [clientId, setClientId] = useState("");
  const [typed, setTyped] = useState("");
  // Business default 1: all five groups ticked when Jordan approves a pilot.
  const [groups, setGroups] = useState<string[]>(data.pilot?.groups ?? data.groups.map((g) => g.key));
  const savedUntil = endDayInput(data.pilot?.expiresAtISO);
  const [until, setUntil] = useState(savedUntil);
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const picked = data.candidates.find((c) => c.id === clientId) ?? null;
  const matches = !!picked && typed.trim().replace(/\s+/g, " ").toLowerCase() === picked.name.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-warning/50 bg-warning-soft/40 p-3 text-[13px]">
      <p className="font-medium">Name a real client for the pilot</p>
      <p className="text-muted">They get the ticked things once the rollout is set to &ldquo;My TEST clients and the clients I name below&rdquo; and each switch is on. Type their name to confirm.</p>
      <label className="block">
        <span className="text-[12px] text-muted">Client (real clients with an active program)</span>
        <select className="mt-0.5 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={clientId} onChange={(e) => { setClientId(e.target.value); setTyped(""); }}>
          <option value="">Choose a program client…</option>
          {data.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {picked && (
        <label className="block">
          <span className="text-[12px] text-muted">Type &ldquo;{picked.name}&rdquo; to confirm</span>
          <input className="mt-0.5 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      )}
      <fieldset className="space-y-1">
        <legend className="text-[12px] text-muted">What the pilot covers (for every client in it)</legend>
        {data.groups.map((g) => (
          <label key={g.key} className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={groups.includes(g.key)} onChange={(e) => setGroups((cur) => (e.target.checked ? [...cur, g.key] : cur.filter((x) => x !== g.key)))} />
            <span>{g.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-[12px] text-muted">{savedUntil ? "Ends (the whole pilot)" : "Ends (optional)"}</span>
          <input type="date" className="mt-0.5 block rounded-lg border border-border bg-surface px-2 py-1.5" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        {!until && <button type="button" className={quiet} onClick={() => setUntil(in30Days())}>Suggest 30 days</button>}
        <label className="block min-w-0 flex-1">
          <span className="text-[12px] text-muted">Note (optional)</span>
          <input className="mt-0.5 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>
      <button
        className={cn(btn, "bg-brand text-white")}
        disabled={busy || !matches || groups.length === 0}
        onClick={() => start(async () => {
          const r = await addProgramPilotClientAction({ clientId, typedName: typed, groups, expiresOnET: until || null, clearExpiry: !until && !!savedUntil, note });
          onDone(r.message, r.ok);
        })}
      >
        Approve for the pilot
      </button>
    </div>
  );
}

function EditPilotForm({ data, onDone }: { data: ProgramRolloutPanelData; onDone: (msg: string, ok: boolean) => void }) {
  const [groups, setGroups] = useState<string[]>(data.pilot?.groups ?? []);
  const savedUntil = endDayInput(data.pilot?.expiresAtISO);
  const [until, setUntil] = useState(savedUntil);
  const [busy, start] = useTransition();
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-border bg-surface-2/40 p-3 text-[13px]">
      <p className="font-medium">Change what the pilot covers, or when it ends</p>
      <fieldset className="space-y-1">
        {data.groups.map((g) => (
          <label key={g.key} className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={groups.includes(g.key)} onChange={(e) => setGroups((cur) => (e.target.checked ? [...cur, g.key] : cur.filter((x) => x !== g.key)))} />
            <span>{g.label}</span>
          </label>
        ))}
      </fieldset>
      <label className="block">
        <span className="text-[12px] text-muted">Ends (empty = no end date)</span>
        <input type="date" className="mt-0.5 block rounded-lg border border-border bg-surface px-2 py-1.5" value={until} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <button className={cn(btn, "bg-brand text-white")} disabled={busy || groups.length === 0}
        onClick={() => start(async () => { const r = await editProgramPilotAction({ groups, expiresOnET: until || null, clearExpiry: !until && !!savedUntil }); onDone(r.message, r.ok); })}>
        Save the pilot
      </button>
    </div>
  );
}

/** The two read-only previews: what would go out now, and held portal access. */
function Previews({ isOwner }: { isOwner: boolean }) {
  const [rows, setRows] = useState<AudiencePreviewRow[] | null>(null);
  const [rowsNote, setRowsNote] = useState<string | null>(null);
  const [held, setHeld] = useState<Awaited<ReturnType<typeof previewHeldAccessReleaseAction>> | null>(null);
  const [released, setReleased] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button className={quiet} disabled={busy} onClick={() => start(async () => { const r = await previewProgramAudienceAction(); setRows(r.rows); setRowsNote(r.message); })}>
          <Eye className="mr-1 inline size-3" aria-hidden />What would go out now? (writes nothing)
        </button>
        {isOwner && (
          <button className={quiet} disabled={busy} onClick={() => start(async () => { setReleased(null); setHeld(await previewHeldAccessReleaseAction()); })}>
            Held portal access: preview
          </button>
        )}
      </div>
      {rowsNote && <p className="text-[12px] text-muted">{rowsNote}</p>}
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
                  <td className="px-2 py-1.5 whitespace-nowrap"><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", r.decision === "send" ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>{r.decision === "on_release" ? "on Release" : r.decision}</span></td>
                  <td className="px-2 py-1.5 text-muted">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {held && (
        <div className="rounded-lg border border-border p-2 text-[12px]">
          <p className={held.ok ? "text-foreground" : "text-warning"}>{held.message}</p>
          {held.preview && (
            <ul className="mt-1 space-y-0.5 text-muted">
              {held.preview.grant.map((o) => <li key={`g:${o.enrollmentId}:${o.email}`}>Would open: {o.clientName} · {o.email} ({o.reason}, owed since {day(o.since)})</li>)}
              {held.preview.stay.map((o) => <li key={`s:${o.enrollmentId}:${o.email}`}>Stays held: {o.clientName} · {o.email} — {o.why}</li>)}
            </ul>
          )}
          {isOwner && held.preview && held.preview.grant.length > 0 && (
            <button className={cn(btn, "mt-2 bg-brand text-white")} disabled={busy}
              onClick={() => start(async () => { const r = await releaseHeldAccessAction(); setReleased(r.message); setHeld(null); })}>
              Release: open {held.preview.grant.length} account{held.preview.grant.length === 1 ? "" : "s"} and send their welcome
            </button>
          )}
        </div>
      )}
      {released && <p className="text-[12px]">{released}</p>}
    </div>
  );
}

export function ProgramRolloutPanel({ isOwner, initial = null }: { isOwner: boolean; initial?: ProgramRolloutPanelData | null }) {
  const [data, setData] = useState<ProgramRolloutPanelData | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<ProgramRolloutPanelData["mode"] | null>(initial?.mode ?? null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, start] = useTransition();
  const load = useCallback(() => {
    loadProgramRolloutPanel()
      .then((r) => { if ("error" in r) setError(r.error); else { setData(r); setMode(r.mode); setError(null); } })
      .catch(() => setError("Could not read who the program may reach. Nothing has changed."));
  }, []);
  useEffect(() => { if (!initial) load(); }, [initial, load]);
  const after = (msg: string, ok: boolean) => { setNote({ text: msg, ok }); if (ok) { setAdding(false); setEditing(false); setConfirmText(""); load(); } };

  // The anchor is on every state: the reminders card and readiness link here.
  if (error) return <p id="program-rollout" className="scroll-mt-28 text-[13px] text-muted">{error}</p>;
  if (!data) return <p id="program-rollout" className="scroll-mt-28 text-[13px] text-muted">Reading who the program may reach…</p>;

  const p = data.pilot;
  const atCap = (p?.clients.length ?? 0) >= data.cap;
  const chosen = mode ?? data.mode;
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
      {data.problem && <p className="rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">The stored setting could not be read, so only TEST clients are reached, and it cannot be changed here until it is fixed: {data.problem}.</p>}
      {note && <p className={cn("rounded-lg border px-3 py-2 text-[13px]", note.ok ? "border-border bg-surface-2" : "border-warning/50 text-warning")}>{note.text}</p>}

      {/* THE MODE, in plain words. */}
      <fieldset className="space-y-1.5" disabled={!isOwner || busy}>
        <legend className="text-[12px] text-muted">
          Reaching now: <span className="font-medium text-foreground">{MODES.find((m) => m.key === data.mode)?.label}</span>
          {data.modeSinceISO && <> · since {day(data.modeSinceISO)}</>}
          {data.updatedBy && <> · last changed by {data.updatedBy}{data.updatedAtISO ? ` on ${day(data.updatedAtISO)}` : ""}</>}
        </legend>
        {isOwner && MODES.map((m) => (
          <label key={m.key} className="flex items-start gap-2 text-[13px]">
            <input type="radio" name="program-rollout-mode" className="mt-1" checked={chosen === m.key} onChange={() => { setMode(m.key); setConfirmText(""); }} />
            <span><span className="font-medium">{m.label}</span> <span className="text-muted">— {m.words}</span></span>
          </label>
        ))}
      </fieldset>
      {isOwner && chosen !== data.mode && (
        <div className="flex flex-wrap items-center gap-2">
          {chosen === "ALL" && (
            <label className="text-[12px] text-muted">
              Type {EVERY_CLIENT_CONFIRM}{" "}
              <input className="ml-1 rounded-lg border border-border bg-surface px-2 py-1" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
            </label>
          )}
          <button className={cn(btn, "bg-brand text-white")} disabled={busy || (chosen === "ALL" && confirmText.trim() !== EVERY_CLIENT_CONFIRM)}
            onClick={() => start(async () => { const r = await setProgramRolloutModeAction({ mode: chosen, typedConfirm: confirmText }); after(r.message, r.ok); })}>
            Save: {MODES.find((m) => m.key === chosen)?.label}
          </button>
          <button className={quiet} onClick={() => { setMode(data.mode); setConfirmText(""); }}>Cancel</button>
        </div>
      )}

      {/* THE PILOT: who, what, until when, who approved it. */}
      <div className="text-[12px]">
        <p>
          <span className="font-medium">Pilot</span> <span className="text-muted">(at most {data.cap} real clients)</span>:{" "}
          {p ? (
            <>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", p.state === "ACTIVE" ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>{p.state.toLowerCase()}</span>
              {" "}covers {data.groups.filter((g) => p.groups.includes(g.key)).map((g) => g.label.toLowerCase()).join("; ") || "nothing"}
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
                {c.joinedAtISO && <span className="text-muted">joined {day(c.joinedAtISO)}</span>}
                {isOwner && (
                  <button className="text-[11px] font-medium text-brand hover:underline disabled:opacity-50" disabled={busy}
                    onClick={() => start(async () => { const r = await removeProgramPilotClientAction({ clientId: c.id }); after(r.message, r.ok); })}>
                    Take out of the pilot
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {isOwner && (
        <div className="flex flex-wrap gap-2">
          <button className={quiet} disabled={atCap} title={atCap ? `The pilot has ${data.cap} clients, the most it may have` : undefined} onClick={() => { setAdding(!adding); setEditing(false); }}>
            {adding ? "Cancel" : atCap ? `Pilot is full (${data.cap})` : "Add a pilot client"}
          </button>
          {p && <button className={quiet} onClick={() => { setEditing(!editing); setAdding(false); }}>{editing ? "Cancel" : "Change the pilot"}</button>}
          {p && (
            <button className={quiet} disabled={busy} onClick={() => start(async () => { const r = await endProgramPilotAction(); after(r.message, r.ok); })}>
              End the pilot
            </button>
          )}
        </div>
      )}
      {isOwner && adding && !atCap && <PilotForm data={data} onDone={after} />}
      {isOwner && editing && p && <EditPilotForm data={data} onDone={after} />}

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
      <p className="text-[12px] text-muted">
        {data.switchesOn.length
          ? <>Client-reaching switches that are on: {data.switchesOn.join(", ")}.</>
          : <>No client-reaching switch is on, so this list reaches nobody yet.</>}
        {" "}Taking a client out stops everything further, including anything already queued; their people go back to the shared portal link (their seats are kept).
      </p>

      <Previews isOwner={isOwner} />
    </div>
  );
}
