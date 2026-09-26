"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import {
  addPilotClientAction, endPilotAction, loadHubWriteScopes, removeFixtureClientAction, removePilotClientAction,
  type HubWriteScopesPayload, type HubWriteScopeView,
} from "@/app/settings/pilotActions";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WHO THE HUB MAY WRITE FOR (R02 / A26, Sep 25 2026), per provider-write
// switch: the TEST fixtures and the approved pilot, with the guard's own
// objections shown next to anything it would refuse. Loaded on open through a
// server action, so the switches list above paints without waiting for it.
//
// The switch and the pilot are separate on purpose: approving a pilot here
// never turns anything on, and a switch that is off writes for nobody however
// full the lists are. The panel says both, so neither looks effective alone.
// ---------------------------------------------------------------------------

const btn = "rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null);
/** A stored pilot end (the next ET midnight after the chosen day) back as that day, for the date input. */
const endDayInput = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) - 1).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");

function PilotForm({ s, candidates, onDone }: { s: HubWriteScopeView; candidates: { id: string; name: string }[]; onDone: (msg: string, ok: boolean) => void }) {
  const [clientId, setClientId] = useState("");
  const [typed, setTyped] = useState("");
  const [groups, setGroups] = useState<string[]>(s.pilot?.groups ?? []);
  // The pilot's end date is ONE date for everyone in it, so the field starts
  // on the saved one: left as it is, it is kept; emptied, it is removed on
  // purpose (and the result says so).
  const savedUntil = endDayInput(s.pilot?.expiresAtISO);
  const [until, setUntil] = useState(savedUntil);
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const picked = candidates.find((c) => c.id === clientId) ?? null;
  const matches = !!picked && typed.trim().replace(/\s+/g, " ").toLowerCase() === picked.name.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-warning/50 bg-warning-soft/40 p-3 text-[13px]">
      <p className="font-medium">Add a real client to this pilot</p>
      <p className="text-muted">The hub will write to the provider for them for the ticked actions, once the switch itself is on. Type their name to confirm.</p>
      <label className="block">
        <span className="text-[12px] text-muted">Client</span>
        <select className="mt-0.5 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={clientId} onChange={(e) => { setClientId(e.target.value); setTyped(""); }}>
          <option value="">Choose a program client…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
        {s.groups.map((g) => (
          <label key={g.key} className="flex items-center gap-2">
            <input type="checkbox" checked={groups.includes(g.key)} onChange={(e) => setGroups((cur) => (e.target.checked ? [...cur, g.key] : cur.filter((x) => x !== g.key)))} />
            <span>{g.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <label className="block">
          <span className="text-[12px] text-muted">{savedUntil ? "Ends (the whole pilot)" : "Ends (optional)"}</span>
          <input type="date" className="mt-0.5 block rounded-lg border border-border bg-surface px-2 py-1.5" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <label className="block min-w-0 flex-1">
          <span className="text-[12px] text-muted">Note (optional)</span>
          <input className="mt-0.5 w-full rounded-lg border border-border bg-surface px-2 py-1.5" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>
      <button
        className={cn(btn, "bg-brand text-white")}
        disabled={busy || !matches || groups.length === 0}
        onClick={() => start(async () => {
          const r = await addPilotClientAction({ switchKey: s.switchKey, clientId, typedName: typed, groups, expiresOnET: until || null, clearExpiry: !until && !!savedUntil, note });
          onDone(r.message, r.ok);
        })}
      >
        Approve for this pilot
      </button>
    </div>
  );
}

export function HubWriteScopePanel({ isOwner }: { isOwner: boolean }) {
  const [data, setData] = useState<HubWriteScopesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const load = useCallback(() => {
    loadHubWriteScopes()
      .then((r) => { if ("error" in r) setError(r.error); else { setData(r); setError(null); } })
      .catch(() => setError("Could not read who the hub may write for. Nothing has changed."));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-[13px] text-muted">{error}</p>;
  if (!data) return <p className="text-[13px] text-muted">Reading who the hub may write for…</p>;

  return (
    <div id="hub-write-scopes" className="scroll-mt-20 space-y-3">
      <div className="flex items-start gap-2 text-[13px] text-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-2" />
        <p>
          Who the hub may write to Aryeo or Calendly for, per switch. <span className="font-medium text-foreground">TEST fixtures</span> are disposable test records on Jordan&rsquo;s test inbox.
          A <span className="font-medium text-foreground">pilot</span> is real clients you approve, for named actions only. Neither does anything while its switch is off.
        </p>
      </div>
      {note && <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px]">{note}</p>}
      <div className="divide-y divide-border rounded-xl border border-border">
        {data.switches.map((s) => (
          <div key={s.switchKey} className="px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{s.title}</span>
              <code className="rounded bg-surface-2 px-1 text-[10px] text-muted-2">{s.switchKey}</code>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", s.enabled ? "bg-success/15 text-success" : "bg-surface-2 text-muted")}>{s.enabled ? "switch on" : s.missing ? "never configured" : "switch off"}</span>
            </div>
            <p className="mt-1 text-[12px] text-muted">{s.headline}</p>
            <p className="mt-1 text-[12px]">
              <span className="font-medium">TEST fixtures:</span>{" "}
              {s.fixtures.length ? s.fixtures.map((f, i) => (
                <span key={f.id}>
                  {i > 0 && ", "}{f.name}{f.problem && <span className="text-warning"> (refused: {f.problem})</span>}
                  {isOwner && (
                    <button className="ml-1 text-[11px] font-medium text-brand hover:underline disabled:opacity-50" disabled={busy}
                      onClick={() => start(async () => { const r = await removeFixtureClientAction({ switchKey: s.switchKey, clientId: f.id }); setNote(r.message); load(); })}>
                      Remove
                    </button>
                  )}
                </span>
              )) : <span className="text-muted">none</span>}
            </p>
            <div className="mt-1 text-[12px]">
              <span className="font-medium">Pilot:</span>{" "}
              {s.pilot ? (
                <>
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", s.pilot.state === "ACTIVE" ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>{s.pilot.state.toLowerCase()}</span>{" "}
                  covers {s.groups.filter((g) => s.pilot!.groups.includes(g.key)).map((g) => g.label.toLowerCase()).join("; ") || "no actions"}
                  {s.pilot.approvedBy && <> · approved by {s.pilot.approvedBy}{s.pilot.approvedAtISO ? ` on ${day(s.pilot.approvedAtISO)}` : ""}</>}
                  {s.pilot.expiresAtISO && <> · ends {day(s.pilot.expiresAtISO)}</>}
                  {s.pilot.note && <> · {s.pilot.note}</>}
                  <ul className="mt-1 space-y-0.5">
                    {s.pilot.clients.map((c) => (
                      <li key={c.id} className="flex items-center gap-2">
                        <span>{c.name}</span>
                        {isOwner && (
                          <button className="text-[11px] font-medium text-brand hover:underline disabled:opacity-50" disabled={busy}
                            onClick={() => start(async () => { const r = await removePilotClientAction({ switchKey: s.switchKey, clientId: c.id }); setNote(r.message); load(); })}>
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              ) : <span className="text-muted">none. No real client is written for.</span>}
            </div>
            {isOwner && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className={cn(btn, "border border-border text-muted hover:bg-surface-2 hover:text-foreground")} onClick={() => setAdding(adding === s.switchKey ? null : s.switchKey)}>
                  {adding === s.switchKey ? "Cancel" : "Add a pilot client"}
                </button>
                {s.pilot && (
                  <button className={cn(btn, "border border-border text-muted hover:bg-surface-2 hover:text-foreground")} disabled={busy}
                    onClick={() => start(async () => { const r = await endPilotAction({ switchKey: s.switchKey }); setNote(r.message); load(); })}>
                    End this pilot
                  </button>
                )}
              </div>
            )}
            {isOwner && adding === s.switchKey && (
              <PilotForm s={s} candidates={data.candidates} onDone={(msg, ok) => { setNote(msg); if (ok) { setAdding(null); load(); } }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
