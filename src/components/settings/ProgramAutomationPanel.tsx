"use client";

import { useRef, useState, useTransition } from "react";
import { AlertTriangle, CircleSlash, Clock, Power, ShieldAlert } from "lucide-react";
import { setAutomationAction } from "@/app/settings/programActions";
import { loadTranscriptQueueBatch, setTranscriptBacklogAction } from "@/app/settings/calendlyActions";
import { HubWriteScopePanel } from "@/components/settings/HubWriteScopePanel";
import { ProgramRolloutPanel } from "@/components/settings/ProgramRolloutPanel";
import { AUTOMATION_EFFECTS } from "@/lib/programAutomationCopy";
import type { TranscriptQueueBatch } from "@/lib/transcriptJobs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";
import { attemptAutomationChange, transcriptBatchReadable, type AutomationChangeResult } from "@/lib/automationChange";

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
//
// WHO, BELOW THE SWITCHES (R03, Sep 28 2026): "Who the program may reach"
// (ProgramRolloutPanel) — the one list every client-reaching switch and the
// hub's booking writes read. A switch reads "reaches clients", never "every
// client": whom it reaches is that list's answer.
//
// THE CALL PROCESSOR'S CONFIRM (R05, Sep 28 2026): turning transcript_jobs on
// first shows the batch it would face (transcriptJobs.transcriptQueueBatch —
// by kind, client and tier, what it skips as backlog, what the first run
// takes), so the owner reads it before he says yes, and he can choose to
// include the older jobs in the same step.
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
      // Not "blocked" by drafting (review, Sep 28): the sweep releases drafts
      // that already exist whatever drafting and AI runs are set to.
      state: autoShare ? "on" : "off",
      note: autoShare && !(drafting && ai)
        ? "Still releases clean drafts the hub already wrote, after the two-hour hold. No new drafts are written while drafting or AI runs is off."
        : autoShare ? "Clean automatic drafts are approved and released after a two-hour hold, only for the clients the rollout reaches (TEST clients only while its own lock is on)." : "You approve every script before a client sees it.",
    },
    {
      label: "Email the client when a script is shared",
      key: "script_share_email",
      state: email ? "on" : "off",
      note: email ? "Emails only what has been shared, batched, inside client hours, only to the clients the rollout reaches (TEST clients only while the reminder policy's lock is on)." : "Shared scripts appear on the client's portal; no email is sent.",
    },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <p className="text-[14px] font-semibold">Script release: three separate controls</p>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((i) => (
          <li key={i.key} className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
            <span className="font-medium">{i.label}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[13px] font-semibold", i.state === "on" ? "bg-success/15 text-success" : i.state === "off" ? "bg-surface-2 text-muted" : "bg-warning/15 text-warning")}>{i.state}</span>
            <span className="text-muted">{i.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const when = (isoStr: string | null) => (isoStr ? new Date(isoStr).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null);

/**
 * The batch the call processor would face, read when the owner opens its
 * confirm — and the backlog choice, made in the same step (default: skip what
 * was queued before the switch-on moment).
 */
function TranscriptBatchConfirm({ batch, include, setInclude }: { batch: TranscriptQueueBatch | { error: string } | null; include: boolean; setInclude: (v: boolean) => void }) {
  if (!batch) return <p className="mt-1 text-muted">Reading what is queued…</p>;
  if ("error" in batch) return <p className="mt-1 text-warning">{batch.error} Read Settings → Calendly & calls before turning this on.</p>;
  return (
    <div data-transcript-batch className="mt-2 space-y-1 rounded-lg border border-border bg-surface/60 p-2 text-[14px]">
      <p className="font-medium">{batch.queuedNowLine}</p>
      <p className="text-muted">{batch.line}</p>
      {batch.heldBacklog > 0 && batch.backlog.source !== "include_all" && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={include} onChange={(e) => setInclude(e.target.checked)} />
          <span>Also process the {batch.heldBacklog} job{batch.heldBacklog === 1 ? "" : "s"} already waiting (each AI job spends credit; some may be real clients&rsquo; calls). Left unticked, only jobs queued from now on are processed.</span>
        </label>
      )}
    </div>
  );
}

export function ProgramAutomationPanel({ rows, isOwner }: { rows: AutomationUi[]; isOwner: boolean }) {
  const [note, setNote] = useState<AutomationChangeResult | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [batch, setBatch] = useState<TranscriptQueueBatch | { error: string } | null>(null);
  const [includeBacklog, setIncludeBacklog] = useState(false);
  const [busy, start] = useTransition();
  const batchRead = useRef(0);
  const openConfirm = (key: string, open: boolean) => {
    const readId = ++batchRead.current;
    setConfirming(open ? key : null);
    if (open && key === "transcript_jobs") {
      setBatch(null);
      setIncludeBacklog(false);
      loadTranscriptQueueBatch().then((value) => { if (readId === batchRead.current) setBatch(value); }).catch(() => { if (readId === batchRead.current) setBatch({ error: "What is queued could not be read." }); });
    }
  };
  const change = (key: string, enabled: boolean) => start(async () => {
    if (enabled && key === "transcript_jobs" && !transcriptBatchReadable(batch)) return;
    setNote(null);
    const result = await attemptAutomationChange({
      includeBacklog: enabled && key === "transcript_jobs" && includeBacklog,
      setBacklog: () => setTranscriptBacklogAction("include"),
      setSwitch: () => setAutomationAction(key, enabled),
    });
    setNote(result);
    if (result.ok) { ++batchRead.current; setConfirming(null); }
  });
  const on = rows.filter((r) => r.enabled).length;
  const never = rows.filter((r) => r.missing).length;

  // No id here: the page's wrapper carries #program-automations (the anchor
  // /content and /content/monitoring link to), and a second copy of the same
  // id made the page's HTML invalid (11-settings-grouping, Sep 28).
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        {on === 0
          ? <>Nothing on the content program runs by itself. <span className="font-medium text-foreground">{never} of {rows.length}</span> have never been configured at all — no row exists for them, which is the same as off and is shown as such.</>
          : <><span className="font-semibold text-foreground">{on} of {rows.length}</span> are switched on. {never > 0 && `${never} have never been configured.`}</>}
      </p>
      {note && <div className="rounded-lg border border-border bg-surface-2 px-3 py-2"><SaveStatus state={note.ok ? "info" : "error"} message={note.message} />{note.needsReload && <Button variant="secondary" onClick={() => window.location.reload()} className="mt-2">Reload recorded state</Button>}</div>}
      <ScriptReleaseSummary rows={rows} />

      <div className="divide-y divide-border rounded-xl border border-border">
        {rows.map((r) => {
          const e = AUTOMATION_EFFECTS[r.key as keyof typeof AUTOMATION_EFFECTS];
          const isConfirming = confirming === r.key;
          // A switch that is on while a switch it depends on is off does
          // nothing (§11: never make a switch look effective when another gate
          // stops it). Only switch-on-switch dependencies are knowable here;
          // connections, config and scope are judged in Readiness at the top.
          const offDeps = (e?.requires?.switches ?? []).filter((d) => !rows.find((x) => x.key === d)?.enabled);
          const blockedBySwitch = r.enabled && offDeps.length > 0;
          return (
            <div key={r.key} className="px-3 py-3 sm:px-4">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {r.enabled
                  ? <Power className="size-4 shrink-0 text-success" />
                  : r.missing ? <CircleSlash className="size-4 shrink-0 text-muted-2" /> : <Power className="size-4 shrink-0 text-muted-2" />}
                <span className="text-sm font-medium">{e?.title ?? r.key}</span>
                <code className="rounded bg-surface-2 px-1 text-[13px] text-muted-2">{r.key}</code>
                {e?.reaches === "clients" && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[13px] font-semibold text-warning">reaches clients</span>}
                <span className={cn("rounded-full px-2 py-0.5 text-[13px] font-semibold",
                  blockedBySwitch ? "bg-warning/15 text-warning" : r.enabled ? "bg-success/15 text-success" : r.missing ? "bg-surface-2 text-muted-2" : "bg-surface-2 text-muted")}>
                  {blockedBySwitch ? "on, but blocked" : r.enabled ? "on" : r.missing ? "never configured" : "off"}
                </span>
                {isOwner && (
                  <Button
                    variant={r.enabled || isConfirming ? "secondary" : "primary"}
                    className="ml-auto"
                    disabled={busy || note?.needsReload}
                    onClick={() => {
                      if (r.enabled) change(r.key, false);
                      else openConfirm(r.key, !isConfirming);
                    }}
                  >
                    {r.enabled ? "Turn off" : isConfirming ? "Cancel" : "Turn on"}
                  </Button>
                )}
              </div>

              <p className="mt-1 text-[14px] text-muted">
                {r.missing
                  ? "No row exists for this in the database. Nothing has ever run it, and nothing can until it is switched on here."
                  : r.enabled
                    ? <>on since {when(r.enabledAtISO) ?? "—"}{r.enabledBy ? ` · ${r.enabledBy}` : ""}</>
                    : <>configured but off{r.enabledAtISO ? ` · was last turned on ${when(r.enabledAtISO)}` : ""}</>}
                {r.lastRunAtISO && <> · <Clock className="inline size-3" /> last ran {when(r.lastRunAtISO)}</>}
              </p>
              {blockedBySwitch && (
                <p className="mt-0.5 text-[14px] text-warning">
                  <AlertTriangle className="mr-1 inline size-3" />Has no effect until {offDeps.map((d) => `“${AUTOMATION_EFFECTS[d].title}”`).join(" and ")} {offDeps.length > 1 ? "are" : "is"} on as well.
                  {" "}Connections, settings and scope are checked in <a href="#readiness" className="font-medium text-brand hover:underline">Readiness</a> at the top.
                </p>
              )}
              {/* A switch that is off is not failing: its last error is history,
                  said in grey, not an amber fault (the Sep 23 regression). */}
              {r.lastError && (
                <p className={cn("mt-0.5 text-[14px]", r.enabled ? "text-warning" : "text-muted-2")}>
                  <AlertTriangle className="mr-1 inline size-3" />{r.enabled ? "last run failed" : "before it was turned off, its last run failed"} {when(r.lastErrorAtISO)}: {r.lastError.slice(0, 200)}
                </p>
              )}
              {e?.blocked && <p className="mt-0.5 text-[14px] text-muted-2"><ShieldAlert className="mr-1 inline size-3" />{e.blocked}</p>}

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
                  {e.launchGate === "programScope" && (
                    <p className="mt-1 text-muted">
                      Whom it reaches is <a href="#program-rollout" className="font-medium text-brand hover:underline">Who the program may reach</a>, below: your TEST clients, the pilot clients you named, or every client only if you chose that there.
                    </p>
                  )}
                  {r.key === "transcript_jobs" && <TranscriptBatchConfirm batch={batch} include={includeBacklog} setInclude={setIncludeBacklog} />}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      busy={busy} busyLabel="Checking change…"
                      disabled={note?.needsReload || (r.key === "transcript_jobs" && !transcriptBatchReadable(batch))}
                      onClick={() => change(r.key, true)}
                    >
                      Yes — turn it on
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={() => openConfirm(r.key, false)}>Not yet</Button>
                  </div>
                </div>
              )}

              {r.key === "reminders" && (
                <p className="mt-0.5 text-[14px] text-muted-2">
                  The reminder policy, a dry run of what would go out, and the send ledger are in <a href="#program-reminders" className="font-medium text-brand hover:underline">Program reminders</a> below.
                </p>
              )}
              {(r.key === "session_booking" || r.key === "address_sync" || r.key === "call_booking") && (
                <p className="mt-0.5 text-[14px] text-muted-2">
                  Its TEST fixtures are in <a href="#hub-write-scopes" className="font-medium text-brand hover:underline">Who the hub may write for</a>; its real clients are the program pilot&rsquo;s, with bookings ticked, in <a href="#program-rollout" className="font-medium text-brand hover:underline">Who the program may reach</a>.
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* R03 (Sep 28 2026): WHO THE PROGRAM MAY REACH — the one list every
          client-reaching switch reads, and the hub's booking writes too. */}
      <ProgramRolloutPanel isOwner={isOwner} />

      {/* R02/A26: the scope of the three provider-write switches. Their TEST
          fixtures are still per switch; their REAL clients come from the
          program pilot above (Jordan's Sep 28 rule: one list), which that
          panel shows read-only. */}
      <HubWriteScopePanel isOwner={isOwner} />
    </div>
  );
}
