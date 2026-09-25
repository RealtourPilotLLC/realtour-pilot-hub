"use client";

import { useState, useTransition } from "react";
import { Loader2, Play, Save, ShieldCheck, AlertTriangle, Check, Copy, Send, MoonStar, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  validateReminderPolicyAction, saveReminderPolicy, runReminderDryRun, sendReminderNowAction, copyReminderLinkAction, snoozeRemindersAction,
  type RemindersPanelState, type DryRunRow,
} from "@/app/settings/reminderActions";

// ---------------------------------------------------------------------------
// Settings → Program reminders (spec §24). What the owner sees:
//   1. the switch's truth (OFF / never configured, who turned it on, last run,
//      last error) — the switch itself is flipped on the Automations panel;
//   2. the policy JSON with validation against the documented shape, saved
//      without touching the switch;
//   3. "What would go out now?" — a dry run over every live month: the ONE
//      action each needs, whether it would send / wait / be suppressed and why,
//      with Copy link and Send now per row (send-now is owner-only and still
//      blocked by the switch on the server);
//   4. the ledger — every attempt with its state, outcome, provider id,
//      suppression reason and next eligibility, so Jordan can inspect what
//      was sent and why.
// Client component: imports only the server actions and pure helpers.
// ---------------------------------------------------------------------------

const fmt = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

function Chip({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
      tone === "ok" && "bg-success/15 text-success", tone === "warn" && "bg-warning/15 text-warning",
      tone === "bad" && "bg-danger/15 text-danger", tone === "muted" && "bg-surface-2 text-muted",
    )}>{children}</span>
  );
}

function Btn({ onClick, children, busy, tone = "default", title }: { onClick: () => void; children: React.ReactNode; busy?: boolean; tone?: "default" | "brand" | "danger"; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} title={title} className={cn(
      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50",
      tone === "brand" && "border-brand bg-brand text-white", tone === "danger" && "border-danger/40 text-danger", tone === "default" && "border-border bg-surface-2",
    )}>{busy ? <Loader2 className="size-3 animate-spin" /> : null}{children}</button>
  );
}

// ---------------------------------------------------------------------------
// ONE MONTH IS TWO ROWS (F20 review, Sep 21 2026). §12 evaluates every month
// once per lane — planning/session, and review — so `enrollmentId:monthKey` is
// not a row identity: the two rows collided on one React key whenever a month
// had a released cut waiting on the client. Worse, both per-row buttons passed
// the bare month id, and the server defaulted that to the PRIMARY lane, so
// "Send now" on the review row would have sent the PLANNING message to a client
// who was only being asked to approve a cut.
//
// The lane is read off the action because REVIEW_WORK is the only action the
// review lane ever produces and the planning lane never produces it
// (programReminders.evaluateMonth). The row's position is the tiebreak for the
// rows that carry no action to name a lane with: a paused month is suppressed
// in both lanes with action null, and a dry run replaces the whole list at once,
// so nothing here is ever reordered or filtered in place.
type Lane = "PRIMARY" | "REVIEW";
const laneOfRow = (r: DryRunRow): Lane => (r.action === "REVIEW_WORK" ? "REVIEW" : "PRIMARY");
/** What the per-row buttons send: the month id carrying its own lane. */
const rowActionId = (r: DryRunRow) => `${r.monthId}#${laneOfRow(r)}`;

const decisionTone = (d: string): "ok" | "warn" | "bad" | "muted" => (d === "send" ? "ok" : d === "wait" ? "warn" : d === "suppressed" ? "bad" : d === "escalate" ? "warn" : "muted");
const stateTone = (s: string): "ok" | "warn" | "bad" | "muted" => (s === "SENT" ? "ok" : s === "QUEUED" || s === "PENDING" ? "warn" : s === "FAILED" || s === "BOUNCED" || s === "UNKNOWN" ? "bad" : "muted");

/**
 * 6.5 (Jordan, Sep 25 2026): the script-approval values in words, read from
 * the policy JSON above so the sentence always matches what is saved or typed.
 */
function ScriptApprovalLine({ json }: { json: string }) {
  type ScriptApprovalHours = { clientLeadHours?: number; deadlineHoursBefore?: number; deskTaskLeadHours?: number; ownerBellLeadHours?: number };
  let sa: ScriptApprovalHours | null = null;
  try { sa = (JSON.parse(json) as { scriptApproval?: ScriptApprovalHours }).scriptApproval ?? null; } catch { sa = null; }
  if (!sa) return null;
  return (
    <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
      <strong className="text-foreground">Scripts before filming:</strong> one email {sa.clientLeadHours ?? 48} hours before the session (moved into office hours, Friday for a Monday shoot),
      asking for approval {sa.deadlineHoursBefore ?? 24} hours before filming; Kyle gets a follow-up at {sa.deskTaskLeadHours ?? 24} hours and the scripts owner a bell at {sa.ownerBellLeadHours ?? 72} hours while
      scripts are still with us. The session is never cancelled or moved. Edit <code>scriptApproval</code> above to change the hours.
    </p>
  );
}

export function RemindersPanel({ state }: { state: RemindersPanelState }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [json, setJson] = useState(state.policyJson);
  const [validation, setValidation] = useState(state.validation);
  const [dry, setDry] = useState<{ rows: DryRunRow[]; note: string; enabled: boolean; policySource: string } | null>(null);
  const [copied, setCopied] = useState<{ monthId: string; link: string; body: string } | null>(null);
  const [showLedger, setShowLedger] = useState(false);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.message }); });

  return (
    <div className="space-y-5 text-sm">
      {/* 1. The switch's truth */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {state.switch.enabled
          ? <Chip tone="warn"><AlertTriangle className="size-3" /> Reminders ON — enabled by {state.switch.enabledBy ?? "?"} {fmt(state.switch.enabledAt)}</Chip>
          : <Chip tone="muted"><ShieldCheck className="size-3" /> {state.switch.missing ? "Never configured — OFF" : "OFF"}</Chip>}
        <span>Last run: <strong className="text-foreground">{fmt(state.switch.lastRunAt)}</strong></span>
        {state.switch.lastError && <span className="text-danger">Last error: {state.switch.lastError}</span>}
        <span className="ml-auto">Policy: {state.policySource === "stored" ? "stored" : "code defaults (nothing saved yet)"}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Nothing is sent while the switch is off, and a missing row is off. The switch is flipped on the Automations panel; this panel holds the
        policy, a dry run, and the history. Even with the switch on, <code>testClientsOnly</code> keeps every real client out until Jordan clears it,
        and every send holds to the Mon–Fri 9:00–4:30 ET client-text window on top of the policy&rsquo;s own hours.
      </p>
      {msg && <p className={cn("rounded-lg px-3 py-2 text-xs", msg.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{msg.text}</p>}

      {/* 2. Policy */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Reminder policy (JSON)</h4>
          <span className="flex gap-2">
            <Btn busy={pending} onClick={() => start(async () => setValidation(await validateReminderPolicyAction(json)))}><ListChecks className="size-3" /> Validate</Btn>
            <Btn busy={pending} tone="brand" onClick={() => run(() => saveReminderPolicy(json))}><Save className="size-3" /> Save policy</Btn>
          </span>
        </div>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
          rows={18}
          className="w-full rounded-lg border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed"
        />
        {validation.errors.length > 0 && (
          <ul className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{validation.errors.map((e) => <li key={e}>• {e}</li>)}</ul>
        )}
        {validation.ok && validation.errors.length === 0 && (
          <p className="text-xs text-success"><Check className="inline size-3" /> Valid shape.</p>
        )}
        <ScriptApprovalLine json={json} />
        {validation.warnings.length > 0 && (
          <ul className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">{validation.warnings.map((w) => <li key={w}>• {w}</li>)}</ul>
        )}
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Templates ({state.templates.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {state.templates.map((t) => <li key={t.id}><code>{t.id}</code> · {t.action} · {t.purpose}</li>)}
          </ul>
        </details>
      </div>

      {/* 3. Dry run */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">What would go out now?</h4>
          <Btn busy={pending} onClick={() => start(async () => { const r = await runReminderDryRun(); setDry({ rows: r.rows, note: r.message, enabled: r.enabled, policySource: r.policySource }); })}>
            <Play className="size-3" /> Dry run (writes nothing)
          </Btn>
        </div>
        {dry && (
          <>
            <p className="text-xs text-muted">{dry.note} · evaluated with the {dry.policySource === "defaults" ? "code defaults" : "stored policy"}{dry.enabled ? "" : " · switch OFF, so none of this sends"}</p>
            {dry.rows.length === 0 ? <p className="text-xs text-muted">No open months to evaluate.</p> : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                    <tr><th className="px-2 py-1.5">Client</th><th className="px-2 py-1.5">Month</th><th className="px-2 py-1.5">Action</th><th className="px-2 py-1.5">Decision</th><th className="px-2 py-1.5">Why</th><th className="px-2 py-1.5">Next</th><th className="px-2 py-1.5"></th></tr>
                  </thead>
                  <tbody>
                    {dry.rows.map((r, i) => (
                      <tr key={`${r.enrollmentId}:${r.monthKey}:${laneOfRow(r)}:${i}`} className="border-t border-border align-top">
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.clientName}{r.isTest && <Chip tone="muted">TEST</Chip>}</td>
                        <td className="px-2 py-1.5">{r.monthKey}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.action ?? "—"}{r.attempt ? <span className="text-muted"> #{r.attempt}</span> : null}{laneOfRow(r) === "REVIEW" && <Chip tone="muted">review lane</Chip>}</td>
                        <td className="px-2 py-1.5"><Chip tone={decisionTone(r.decision)}>{r.decision}{r.suppressionReason ? ` · ${r.suppressionReason}` : ""}</Chip>{r.escalation && <div className="mt-0.5 text-[11px] text-warning">escalate: {r.escalation}</div>}</td>
                        <td className="px-2 py-1.5 text-muted">{r.reason}{r.to ? ` → ${r.to}` : ""}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted">{fmt(r.nextEligibleAt)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {/* APPROVE_SCRIPTS rows (6.5) are per session and read-only here:
                              the buttons below act on a month's planning lane. */}
                          {r.action && r.action !== "APPROVE_SCRIPTS" && (
                            <span className="flex gap-1">
                              <Btn busy={pending} title={`Render the text + a portal link to paste yourself (records an attempt). Acts on this row's ${laneOfRow(r) === "REVIEW" ? "review" : "planning"} lane.`} onClick={() => start(async () => { const c = await copyReminderLinkAction(rowActionId(r)); setMsg({ ok: c.ok, text: c.message }); if (c.ok && c.link && c.body) setCopied({ monthId: r.monthId, link: c.link, body: c.body }); })}><Copy className="size-3" /> Copy link</Btn>
                              <Btn busy={pending} title={`Owner only. Still blocked while the switch is off; still holds outside the send window. Sends this row's ${laneOfRow(r) === "REVIEW" ? "review" : "planning"} message.`} onClick={() => run(() => sendReminderNowAction(rowActionId(r)))}><Send className="size-3" /> Send now</Btn>
                              <Btn busy={pending} title="Snooze this month's reminders for 7 days" onClick={() => { const reason = window.prompt("Why snooze this month's reminders?"); if (reason) run(() => snoozeRemindersAction(r.monthId, 7, reason)); }}><MoonStar className="size-3" /></Btn>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {copied && (
              <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs">
                <div className="mb-1 flex items-center justify-between"><strong>Copied text</strong><Btn onClick={() => { void navigator.clipboard?.writeText(copied.body); }}><Copy className="size-3" /> Copy to clipboard</Btn></div>
                <pre className="whitespace-pre-wrap font-sans">{copied.body}</pre>
              </div>
            )}
          </>
        )}
      </div>

      {/* 4. Ledger */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">History <span className="font-normal text-muted">({state.counts.total} attempts · {state.counts.sent} sent · {state.counts.suppressed} suppressed · {state.counts.failed} failed/bounced · {state.counts.unknown} unconfirmed)</span></h4>
          <Btn onClick={() => setShowLedger((v) => !v)}>{showLedger ? "Hide" : "Show"}</Btn>
        </div>
        {showLedger && (state.ledger.length === 0 ? <p className="text-xs text-muted">Nothing has been evaluated for sending yet.</p> : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                <tr><th className="px-2 py-1.5">When</th><th className="px-2 py-1.5">Client</th><th className="px-2 py-1.5">Month</th><th className="px-2 py-1.5">Action</th><th className="px-2 py-1.5">State</th><th className="px-2 py-1.5">To</th><th className="px-2 py-1.5">Detail</th></tr>
              </thead>
              <tbody>
                {state.ledger.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-2 py-1.5 whitespace-nowrap text-muted">{fmt(r.createdAt)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.clientName}</td>
                    <td className="px-2 py-1.5">{r.monthKey ?? "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.action} #{r.attempt}{r.manual && <Chip tone="muted">manual</Chip>}{r.channel !== "email" && <Chip tone="muted">{r.channel}</Chip>}</td>
                    <td className="px-2 py-1.5"><Chip tone={stateTone(r.state)}>{r.state}{r.outboxState ? ` · outbox ${r.outboxState}` : ""}</Chip></td>
                    <td className="px-2 py-1.5 text-muted">{r.to ?? "—"}</td>
                    <td className="px-2 py-1.5 text-muted">
                      {r.suppressionReason && <span>suppressed: {r.suppressionReason}. </span>}
                      {r.sentAt && <span>sent {fmt(r.sentAt)}{r.providerMessageId ? ` (id ${r.providerMessageId.slice(0, 12)}…)` : ""}. </span>}
                      {r.nextEligibleAt && !r.sentAt && <span>eligible {fmt(r.nextEligibleAt)}. </span>}
                      {r.nextAttemptAt && <span>retry {fmt(r.nextAttemptAt)}. </span>}
                      {r.lastError && <span className="text-danger">{r.lastError}</span>}
                      {r.requestedBy && <span> · by {r.requestedBy}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
