"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { loadHubWriteScopes, removeFixtureClientAction, type HubWriteScopesPayload } from "@/app/settings/pilotActions";
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
//
// ONE PILOT LIST (R03, Sep 28 2026). The pilot the Aryeo and Calendly guards
// read is the PROGRAM pilot, so this panel shows it READ-ONLY, per switch,
// with a link to its one editor ("Who the program may reach", #program-rollout).
// Only the TEST fixture list is still managed here.
// ---------------------------------------------------------------------------

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null);

export function HubWriteScopePanel({ isOwner }: { isOwner: boolean }) {
  const [data, setData] = useState<HubWriteScopesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const load = useCallback(() => {
    loadHubWriteScopes()
      .then((r) => { if ("error" in r) setError(r.error); else { setData(r); setError(null); } })
      .catch(() => setError("Could not read who the hub may write for. Nothing has changed."));
  }, []);
  useEffect(() => { load(); }, [load]);

  // The anchor is on every state, not only the loaded one: the switches above
  // link here, and before this the link went nowhere until the read finished.
  if (error) return <p id="hub-write-scopes" className="scroll-mt-28 text-[13px] text-muted">{error}</p>;
  if (!data) return <p id="hub-write-scopes" className="scroll-mt-28 text-[13px] text-muted">Reading who the hub may write for…</p>;

  return (
    <div id="hub-write-scopes" className="scroll-mt-28 space-y-3">
      <div className="flex items-start gap-2 text-[13px] text-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-2" />
        <p>
          Who the hub may write to Aryeo or Calendly for, per switch. <span className="font-medium text-foreground">TEST fixtures</span> are disposable test records on Jordan&rsquo;s test inbox.
          The <span className="font-medium text-foreground">pilot</span> is the program pilot &mdash; the real clients you approve in{" "}
          <a href="#program-rollout" className="font-medium text-brand hover:underline">Who the program may reach</a>, with &ldquo;bookings&rdquo; ticked. There is one pilot list, edited there. Neither does anything while its switch is off.
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
              <span className="font-medium">Program pilot:</span>{" "}
              {s.pilotProblem ? (
                <span className="text-warning">could not be read ({s.pilotProblem}) — no real client is written for.</span>
              ) : s.pilot ? (
                <>
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", s.pilot.state === "ACTIVE" ? "bg-warning/15 text-warning" : "bg-surface-2 text-muted")}>{s.pilot.state.toLowerCase()}</span>{" "}
                  {s.pilot.groups.length ? `covers ${s.groups.filter((g) => s.pilot!.groups.includes(g.key)).map((g) => g.label.toLowerCase()).join("; ")}` : "bookings are not ticked for the pilot, so nothing is written"}
                  {s.pilot.approvedBy && <> · approved by {s.pilot.approvedBy}{s.pilot.approvedAtISO ? ` on ${day(s.pilot.approvedAtISO)}` : ""}</>}
                  {s.pilot.expiresAtISO && <> · ends {day(s.pilot.expiresAtISO)}</>}
                  <ul className="mt-1 space-y-0.5">
                    {s.pilot.clients.map((c) => <li key={c.id}>{c.name}</li>)}
                  </ul>
                </>
              ) : <span className="text-muted">none. No real client is written for.</span>}{" "}
              <a href="#program-rollout" className="text-[11px] font-medium text-brand hover:underline">{isOwner ? "Edit the program pilot" : "See the program pilot"}</a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
