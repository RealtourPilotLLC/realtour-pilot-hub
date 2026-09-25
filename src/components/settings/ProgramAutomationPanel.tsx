"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CircleSlash, Clock, Power, ShieldAlert } from "lucide-react";
import { setAutomationAction } from "@/app/settings/programActions";
import { AUTOMATION_EFFECTS } from "@/lib/programAutomationCopy";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE SWITCHES (spec §13). One row per automation key, whatever the database
// holds — including keys with NO row at all, which read "never configured".
// That distinction is the whole point: "off because somebody turned it off"
// and "off because nobody has ever set it up" are different facts about the
// business, and a screen that showed both as a grey toggle would hide the
// second one.
//
// Turning something on takes a confirm that NAMES WHAT WILL START HAPPENING,
// in the words from programAutomationCopy — especially for the ones that
// reach a real client.
//
// This panel owns the SWITCHES and nothing else. The reminder policy is edited
// in "Program reminders" further down the page, which is where the evaluator
// that reads it lives; a second policy editor here wrote an incompatible shape
// to the same key and could silently replace the rules deciding when a client
// is emailed. Turning reminders on validates the stored policy server-side and
// refuses with the reason if it would not run.
// ---------------------------------------------------------------------------

export type AutomationUi = {
  key: string; enabled: boolean; missing: boolean; enabledBy: string | null; enabledAtISO: string | null;
  lastRunAtISO: string | null; lastError: string | null; lastErrorAtISO: string | null;
};

/**
 * SCRIPT RELEASE, THREE SEPARATE CONTROLS (6.5, §3). Drafting, sharing without
 * Jordan's approval, and the share email are three switches in the list below;
 * this reads them together, with what each one DEPENDS on, so a switch never
 * looks effective while another gate stops it. Presentation only — the rows
 * below are where they are turned on or off.
 */
function ScriptReleaseSummary({ rows }: { rows: AutomationUi[] }) {
  const on = (k: string) => rows.find((r) => r.key === k)?.enabled === true;
  const drafting = on("script_drafting");
  const ai = on("ai_runs");
  const autoShare = on("script_auto_share");
  const email = on("script_share_email");
  const items = [
    {
      label: "Draft scripts automatically",
      key: "script_drafting",
      state: drafting && ai ? "on" : drafting ? "on, but blocked" : "off",
      note: drafting && !ai
        ? "Has no effect while AI runs (the master switch) is off."
        : drafting ? "Drafts land in your review queue; nothing reaches the client from this alone." : "Scripts are drafted when someone presses Draft. Nothing is written on its own.",
    },
    {
      label: "Share scripts without my approval",
      key: "script_auto_share",
      state: autoShare && drafting && ai ? "on" : autoShare ? "on, but blocked" : "off",
      note: autoShare && !(drafting && ai)
        ? "Has no effect while drafting is off: it only shares scripts the hub drafted on its own."
        : autoShare ? "Clean automatic drafts are approved and released after a two-hour hold (TEST clients only until launch)." : "You approve every script before a client sees it.",
    },
    {
      label: "Email the client when a script is shared",
      key: "script_share_email",
      state: email ? "on" : "off",
      note: email ? "Emails only what has been shared, batched, inside client hours (TEST clients only until launch)." : "Shared scripts appear on the client's portal; no email is sent.",
    },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <p className="text-[12px] font-semibold">Script release: three separate controls</p>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((i) => (
          <li key={i.key} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="font-medium">{i.label}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", i.state === "on" ? "bg-success/15 text-success" : i.state === "off" ? "bg-surface-2 text-muted" : "bg-warning/15 text-warning")}>{i.state}</span>
            <span className="text-muted">{i.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const when = (isoStr: string | null) => (isoStr ? new Date(isoStr).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);
const btn = "rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50";

export function ProgramAutomationPanel({ rows, isOwner }: { rows: AutomationUi[]; isOwner: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const on = rows.filter((r) => r.enabled).length;
  const never = rows.filter((r) => r.missing).length;

  return (
    <div id="program-automations" className="scroll-mt-20 space-y-3">
      <p className="text-[13px] text-muted">
        {on === 0
          ? <>Nothing on the content program runs by itself. <span className="font-medium text-foreground">{never} of {rows.length}</span> have never been configured at all — no row exists for them, which is the same as off and is shown as such.</>
          : <><span className="font-semibold text-foreground">{on} of {rows.length}</span> are switched on. {never > 0 && `${never} have never been configured.`}</>}
      </p>
      {note && <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px]">{note}</p>}
      <ScriptReleaseSummary rows={rows} />

      <div className="divide-y divide-border rounded-xl border border-border">
        {rows.map((r) => {
          const e = AUTOMATION_EFFECTS[r.key as keyof typeof AUTOMATION_EFFECTS];
          const isConfirming = confirming === r.key;
          return (
            <div key={r.key} className="px-3 py-3 sm:px-4">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {r.enabled
                  ? <Power className="size-4 shrink-0 text-success" />
                  : r.missing ? <CircleSlash className="size-4 shrink-0 text-muted-2" /> : <Power className="size-4 shrink-0 text-muted-2" />}
                <span className="text-sm font-medium">{e?.title ?? r.key}</span>
                <code className="rounded bg-surface-2 px-1 text-[10px] text-muted-2">{r.key}</code>
                {e?.reaches === "clients" && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">reaches real clients</span>}
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold",
                  r.enabled ? "bg-success/15 text-success" : r.missing ? "bg-surface-2 text-muted-2" : "bg-surface-2 text-muted")}>
                  {r.enabled ? "on" : r.missing ? "never configured" : "off"}
                </span>
                {isOwner && (
                  <button
                    className={cn(btn, "ml-auto", r.enabled ? "border border-border text-muted hover:bg-surface-2 hover:text-foreground" : "bg-brand text-white")}
                    disabled={busy}
                    onClick={() => {
                      if (r.enabled) start(async () => { const x = await setAutomationAction(r.key, false); setNote(x.message); });
                      else setConfirming(isConfirming ? null : r.key);
                    }}
                  >
                    {r.enabled ? "Turn off" : isConfirming ? "Cancel" : "Turn on"}
                  </button>
                )}
              </div>

              <p className="mt-1 text-[12px] text-muted">
                {r.missing
                  ? "No row exists for this in the database. Nothing has ever run it, and nothing can until it is switched on here."
                  : r.enabled
                    ? <>on since {when(r.enabledAtISO) ?? "—"}{r.enabledBy ? ` · ${r.enabledBy}` : ""}</>
                    : <>configured but off{r.enabledAtISO ? ` · was last turned on ${when(r.enabledAtISO)}` : ""}</>}
                {r.lastRunAtISO && <> · <Clock className="inline size-3" /> last ran {when(r.lastRunAtISO)}</>}
              </p>
              {r.lastError && (
                <p className="mt-0.5 text-[12px] text-warning">
                  <AlertTriangle className="mr-1 inline size-3" />last run failed {when(r.lastErrorAtISO)}: {r.lastError.slice(0, 200)}
                </p>
              )}
              {e?.blocked && <p className="mt-0.5 text-[12px] text-muted-2"><ShieldAlert className="mr-1 inline size-3" />{e.blocked}</p>}

              {/* THE CONFIRM — it names what will start happening. */}
              {isConfirming && e && (
                <div className={cn("mt-2 rounded-xl border p-3 text-[13px]", e.reaches === "clients" ? "border-warning/50 bg-warning-soft/40" : "border-border bg-surface-2/50")}>
                  <p className="font-medium">{e.reaches === "clients" ? "This one reaches real clients. Turning it on means:" : "Turning it on means:"}</p>
                  <p className="mt-1">{e.onEffect}</p>
                  {e.blocked && <p className="mt-1 text-muted">{e.blocked}</p>}
                  {r.key === "reminders" && (
                    <p className="mt-1 text-muted">
                      It runs on the policy in <span className="font-medium">Program reminders</span> below — hours, cadence, templates and the test-clients-only lock.
                      If that policy would not run, this refuses to switch on and says why.
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      className={cn(btn, "bg-brand text-white")}
                      disabled={busy}
                      onClick={() => start(async () => {
                        const x = await setAutomationAction(r.key, true);
                        setNote(x.message); if (x.ok) setConfirming(null);
                      })}
                    >
                      Yes — turn it on
                    </button>
                    <button className={cn(btn, "border border-border text-muted hover:bg-surface-2")} onClick={() => setConfirming(null)}>Not yet</button>
                  </div>
                </div>
              )}

              {r.key === "reminders" && (
                <p className="mt-0.5 text-[12px] text-muted-2">
                  The reminder policy, a dry run of what would go out, and the send ledger are in <a href="#program-reminders" className="font-medium text-brand hover:underline">Program reminders</a> below.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
