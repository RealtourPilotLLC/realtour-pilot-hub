"use client";

import { useEffect, useReducer, useState, useTransition } from "react";
import { Loader2, Play, Save, ShieldCheck, AlertTriangle, Check, Copy, Send, MoonStar, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_TEMPLATE_IDS, RETIRED_TEMPLATE_IDS } from "@/lib/reminderTemplates";
import {
  currentPolicyValidation, parsePolicyDraft, policyEditorReducer, policyField, policyNumberInput,
  previewPolicyTemplate, REMINDER_ACTION_LABELS, updatePolicyField, type PolicyObject, type ReminderTemplateAction,
} from "@/lib/reminderPolicyEditor";
import {
  validateReminderPolicyAction, saveReminderPolicy, runReminderDryRun, sendReminderNowAction, copyReminderLinkAction, snoozeRemindersAction,
  type RemindersPanelState, type DryRunRow,
} from "@/app/settings/reminderActions";

// ---------------------------------------------------------------------------
// Settings → Program reminders (spec §24). What the owner sees:
//   1. the switch's truth (OFF / never configured, who turned it on, last run,
//      last error) — the switch itself is flipped on the Automations panel;
//   2. ordinary policy fields, templates and an advanced JSON editor, saved
//      without touching the switch or dropping unknown fields;
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
//
// FOUR LANES NOW (R03, Sep 28 2026): the row carries its lane. The per-row
// buttons act on a month's PLANNING (PRIMARY) or REVIEW lane only; the address
// and script-approval rows are per session and read-only here.
type Lane = "PRIMARY" | "REVIEW";
const laneOfRow = (r: DryRunRow): Lane => (r.lane === "REVIEW" || r.action === "REVIEW_WORK" ? "REVIEW" : "PRIMARY");
/** What the per-row buttons send: the month id carrying its own lane. */
const rowActionId = (r: DryRunRow) => `${r.monthId}#${laneOfRow(r)}`;
const hasMonthButtons = (r: DryRunRow) => !!r.action && (r.lane === "PLANNING" || r.lane === "REVIEW");
const LANE_WORDS: Record<DryRunRow["lane"], string> = { PLANNING: "planning", REVIEW: "review", ADDRESS: "exact address", APPROVE_SCRIPTS: "approve scripts" };
/** The rollout's verdict, in two words. */
const reachWords = (r: DryRunRow): { text: string; tone: "ok" | "muted" } =>
  r.tier ? { text: r.tier === "TEST" ? "TEST" : r.tier === "PILOT" ? "pilot" : "everyone", tone: "ok" }
    : { text: r.code === "feature_test_only" ? "held: TEST-only lock" : r.code ? "not in the rollout" : "—", tone: "muted" };

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
  if (typeof sa !== "object" || Array.isArray(sa) || [sa.clientLeadHours, sa.deadlineHoursBefore, sa.deskTaskLeadHours, sa.ownerBellLeadHours].some((value) => value !== undefined && (typeof value !== "number" || !Number.isFinite(value)))) {
    return <p className="text-sm text-muted">Validate the script reminder hours to see their timing summary.</p>;
  }
  return (
    <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
      <strong className="text-foreground">Scripts before filming:</strong> one email {sa.clientLeadHours ?? 48} hours before the session (moved into office hours, Friday for a Monday shoot),
      asking for approval {sa.deadlineHoursBefore ?? 24} hours before filming; Kyle gets a follow-up at {sa.deskTaskLeadHours ?? 24} hours and the scripts owner a bell at {sa.ownerBellLeadHours ?? 72} hours while
      scripts are still with us. The session is never cancelled or moved.
    </p>
  );
}

const fieldClass = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
type NumberField = { path: string[]; label: string; min: number; max: number; nullable?: boolean; hint?: string };
const cadenceFields: NumberField[] = [
  { path: ["monthlyOpenDayOfMonth"], label: "Planning opens · day of month", min: 1, max: 28, hint: "Weekends move to the next weekday. The monthly calendar uses Eastern time." },
  { path: ["midMonthDayOfMonth"], label: "Kyle's follow-up · day of month", min: 1, max: 28, hint: "Internal milestone, after the opening day. This is not a client booking cutoff." },
  { path: ["followUpAfterBusinessDays"], label: "Planning follow-up · business days", min: 1, max: 30 },
  { path: ["maxAttemptsPerAction"], label: "Planning attempts · maximum", min: 0, max: 6 },
  { path: ["quotedPlanningDeadlineDayOfMonth"], label: "Client planning deadline · day of month", min: 1, max: 28, nullable: true, hint: "Leave blank to quote no deadline. Setting a day adds a promise to planning emails." },
];
const otherFields: NumberField[] = [
  { path: ["firstReminderDelayBusinessDays"], label: "First reminder delay · business days", min: 0, max: 20 },
  { path: ["reviewWorkAfterBusinessDays"], label: "First cut reminder · business days after release", min: 0, max: 20 },
  { path: ["reviewFollowUpBusinessDays"], label: "Cut follow-up spacing · business days", min: 0, max: 20 },
  { path: ["reviewMaxAttempts"], label: "Cut review attempts · maximum", min: 0, max: 6 },
  { path: ["escalateWhenDeadlineWithinBusinessDays"], label: "Escalation lead · business days", min: 0, max: 30 },
  { path: ["sessionBookingDeadlineDayOfMonth"], label: "Filming escalation clock · day of month", min: 1, max: 28, hint: "Internal follow-up timing only. It does not block booking or forfeit filming." },
  { path: ["staleSchedulerSyncHours"], label: "Maximum scheduler sync age · hours", min: 1, max: 168 },
  { path: ["scriptShareBatchMinutes"], label: "Group scripts-ready emails · minutes", min: 0, max: 240 },
  { path: ["maxSendsPerRun"], label: "Messages per run · maximum", min: 1, max: 200 },
  { path: ["maxClientEmailsPerDay"], label: "Client emails per day · maximum", min: 1, max: 5 },
];
const filmingFields: NumberField[] = [
  { path: ["addressReminderHoursBefore"], label: "Address reminder · hours before filming", min: 1, max: 336 },
  { path: ["scriptApproval", "clientLeadHours"], label: "Script email · hours before filming", min: 1, max: 336 },
  { path: ["scriptApproval", "deadlineHoursBefore"], label: "Script approval deadline · hours before filming", min: 0, max: 168 },
  { path: ["scriptApproval", "deskTaskLeadHours"], label: "Kyle's script follow-up · hours before filming", min: 1, max: 168 },
  { path: ["scriptApproval", "ownerBellLeadHours"], label: "Scripts owner's alert · hours before filming", min: 1, max: 336 },
];

function PolicyNumbers({ fields, policy, onChange }: { fields: NumberField[]; policy: PolicyObject; onChange: (path: string[], value: unknown) => void }) {
  return <div className="grid gap-4 sm:grid-cols-2">{fields.map((field) => {
    const value = policyField(policy, field.path);
    return <label key={field.path.join(".")} className="block text-sm font-medium">
      {field.label}
      <input type="number" min={field.min} max={field.max} step={field.nullable ? 1 : "any"} required={!field.nullable}
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        onChange={(event) => onChange(field.path, policyNumberInput(event.target.value, field.nullable))}
        className={fieldClass} />
      {field.hint && <span className="mt-1 block text-xs font-normal leading-relaxed text-muted">{field.hint}</span>}
    </label>;
  })}</div>;
}

function TemplatePreview({ policy, action }: { policy: PolicyObject; action: ReminderTemplateAction }) {
  let preview: ReturnType<typeof previewPolicyTemplate> | null = null;
  let errorMessage = "Template preview unavailable.";
  try { preview = previewPolicyTemplate(policy, action); }
  catch (error) { if (error instanceof Error) errorMessage = error.message; }
  if (!preview) return <p role="alert" className="text-sm text-danger">{errorMessage}</p>;
  return <div className="rounded-lg border border-border bg-surface-2 p-3">
    <p className="mb-2 text-xs text-muted">Sample message · {preview.id}. Uses fictional details; actual dates, links and optional paragraphs depend on the client and active policy.</p>
    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{preview.body}</pre>
  </div>;
}

export function RemindersPanel({ state }: { state: RemindersPanelState }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [policyPending, startPolicy] = useTransition();
  const [policyOperation, setPolicyOperation] = useState<"validate" | "save">("validate");
  const [editor, edit] = useReducer(policyEditorReducer, {
    json: state.policyJson, savedJson: state.policyJson,
    validation: { json: state.policyJson, result: state.validation }, feedback: null,
  });
  const { json } = editor;
  const validation = currentPolicyValidation(editor);
  const { policy, error: parseError } = parsePolicyDraft(json);
  const dirty = json !== editor.savedJson;
  const [previewAction, setPreviewAction] = useState<ReminderTemplateAction>("CHOOSE_PATH");
  const [dry, setDry] = useState<{ rows: DryRunRow[]; note: string; enabled: boolean; policySource: string; scopeLine: string } | null>(null);
  const [copied, setCopied] = useState<{ monthId: string; link: string; body: string } | null>(null);
  const [showLedger, setShowLedger] = useState(false);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.message }); });
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const changeField = (path: string[], value: unknown) => {
    try { edit({ type: "edit", json: updatePolicyField(json, path, value) }); }
    catch (error) { edit({ type: "error", message: error instanceof Error ? error.message : "Could not update this field. Your draft is still here." }); }
  };
  const validate = () => {
    const submitted = json;
    setPolicyOperation("validate");
    startPolicy(async () => {
      try { edit({ type: "validation", json: submitted, result: await validateReminderPolicyAction(submitted) }); }
      catch { edit({ type: "error", message: "Validation could not finish. Your edits are kept; try Validate again." }); }
    });
  };
  const save = () => {
    const submitted = json;
    setPolicyOperation("save");
    startPolicy(async () => {
      try {
        const result = await saveReminderPolicy(submitted);
        edit({ type: "saved", json: submitted, ...result });
      } catch { edit({ type: "error", message: "The save could not be confirmed. Your edits are kept; retry Save policy." }); }
    });
  };

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
        policy, a dry run, and the history. Even with the switch on, reminders go only to the clients the rollout reaches (<a href="#program-rollout" className="font-medium text-brand hover:underline">Who the program may reach</a>),
        and the policy&rsquo;s <code>testClientsOnly</code> lock narrows that to TEST clients: lifting it lets the rollout scope receive reminders — your pilot
        clients, or every client only once the rollout is set to everyone. The same lock governs the scripts-ready emails. Every send holds to the
        Mon–Fri 9:00–4:30 ET client-text window on top of the policy&rsquo;s own hours.
      </p>
      {msg && <p className={cn("rounded-lg px-3 py-2 text-xs", msg.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{msg.text}</p>}

      {/* 2. Policy */}
      <section className="space-y-4 rounded-xl border border-border p-4" aria-labelledby="reminder-policy-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 id="reminder-policy-heading" className="text-base font-semibold">Reminder rules</h4>
            <p className="mt-1 text-sm text-muted">Only the owner can save. Saving keeps the automation switch as it is.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className={cn("text-sm", dirty ? "text-warning" : "text-muted")}>
              {policyPending ? policyOperation === "save" ? "Saving…" : "Validating…" : dirty ? "Unsaved changes" : editor.feedback?.ok ? "Saved" : state.policySource === "stored" ? "Saved policy" : "Using defaults"}
            </span>
            <Btn busy={policyPending} onClick={validate}><ListChecks className="size-3" /> Validate</Btn>
            <Btn busy={policyPending} tone="brand" onClick={save}><Save className="size-3" /> Save policy</Btn>
          </div>
        </div>
        {dirty && <p className="text-sm text-warning">Save before leaving this page. Dry runs use saved rules; the form and sample messages show your current draft.</p>}
        {editor.feedback && <p role={editor.feedback.ok ? "status" : "alert"} className={cn("rounded-lg px-3 py-2 text-sm", editor.feedback.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{editor.feedback.text}{editor.feedback.ok && dirty ? " Newer edits are still unsaved." : ""}</p>}
        {parseError && <p role="alert" className="text-sm text-danger">{parseError}</p>}
        {validation?.errors.length ? <ul role="alert" className="list-disc space-y-1 rounded-lg bg-danger/10 py-2 pl-7 pr-3 text-sm text-danger">{validation.errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
        {validation?.ok && <p role="status" className="text-sm text-success"><Check className="inline size-4" /> Current draft is valid.</p>}
        {!validation && !parseError && <p className="text-sm text-muted">This draft has not been validated yet.</p>}
        {validation?.warnings.length ? <ul className="list-disc space-y-1 rounded-lg bg-warning/10 py-2 pl-7 pr-3 text-sm text-warning">{validation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
        {policy && <>
          <PolicyNumbers fields={cadenceFields} policy={policy} onChange={changeField} />
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium">Sending hours and escalation owner</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium">Send-window timezone
                <input value={typeof policy.timezone === "string" ? policy.timezone : ""} onChange={(event) => changeField(["timezone"], event.target.value)} placeholder="America/New_York" className={fieldClass} />
              </label>
              <label className="text-sm font-medium">Escalation duty
                <select value={typeof policy.escalationOwnerDuty === "string" ? policy.escalationOwnerDuty : ""} onChange={(event) => changeField(["escalationOwnerDuty"], event.target.value)} className={fieldClass}>
                  <option value="" disabled>Select a duty</option>
                  {["STRATEGY", "SCRIPTS", "SCHEDULING", "DELIVERY", "ESCALATION", "REMINDERS"].map((duty) => <option key={duty} value={duty}>{duty.charAt(0) + duty.slice(1).toLowerCase()}</option>)}
                </select>
              </label>
              {(["start", "end"] as const).map((key) => {
                const value = policyField(policy, ["businessHours", key]);
                return <label key={key} className="text-sm font-medium">{key === "start" ? "Send window opens" : "Send window closes"} · local time above
                  <input type="time" value={typeof value === "string" ? value : ""} onChange={(event) => changeField(["businessHours", key], event.target.value)} className={fieldClass} />
                </label>;
              })}
              <fieldset className="sm:col-span-2">
                <legend className="mb-2 text-sm font-medium">Send-window days</legend>
                <div className="flex flex-wrap gap-3">{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => {
                  const value = policyField(policy, ["businessHours", "days"]);
                  const days = Array.isArray(value) ? value : [];
                  return <label key={day} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={days.includes(index)} onChange={(event) => changeField(["businessHours", "days"], event.target.checked ? [...days, index] : days.filter((d) => d !== index))} />{day.slice(0, 3)}</label>;
                })}</div>
              </fieldset>
              <p className="text-sm leading-relaxed text-muted sm:col-span-2">The monthly calendar uses Eastern time. Client sends also respect the existing Monday–Friday, 9:00 am–4:30 pm ET window, even if these hours are wider.</p>
            </div>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium">Review, delivery and sending limits</summary>
            <div className="mt-4"><PolicyNumbers fields={otherFields} policy={policy} onChange={changeField} /></div>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium">Scripts and filming reminders</summary>
            <div className="mt-4 space-y-4"><PolicyNumbers fields={filmingFields} policy={policy} onChange={changeField} /><ScriptApprovalLine json={json} /></div>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium">Audience and safeguards</summary>
            <div className="mt-4 space-y-3">
              {([
                ["testClientsOnly", "Limit reminders and scripts-ready emails to TEST clients", "Turning this off allows the existing rollout audience when the relevant switch is on. It does not approve or expand the rollout."],
                ["staffFollowUpsForRealClients", "Create internal follow-ups for real clients outside reminder scope", "Kyle can receive an internal task while client messages remain held."],
                ["includePastMonths", "Include past open months", "Adds older unfinished months to evaluation. Review the saved-policy dry run before any separate activation."],
                ["digestBothAppointments", "Mention missing filming in a planning reminder", "Combines the next steps when both appointments still need attention."],
              ] as const).map(([key, label, hint]) => <label key={key} className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1" checked={policy[key] === true} onChange={(event) => changeField([key], event.target.checked)} />
                <span><span className="font-medium">{label}</span><span className="mt-1 block leading-relaxed text-muted">{hint}</span></span>
              </label>)}
            </div>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium">Message templates and sample preview</summary>
            <div className="mt-4 space-y-4">
              <label className="block text-sm font-medium">Message purpose
                <select value={previewAction} onChange={(event) => setPreviewAction(event.target.value as ReminderTemplateAction)} className={fieldClass}>
                  {(Object.keys(REMINDER_ACTION_LABELS) as ReminderTemplateAction[]).map((action) => <option key={action} value={action}>{REMINDER_ACTION_LABELS[action]}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium">Template version
                <select value={typeof policyField(policy, ["templates", previewAction]) === "string" ? policyField(policy, ["templates", previewAction]) as string : DEFAULT_TEMPLATE_IDS[previewAction]} onChange={(event) => changeField(["templates", previewAction], event.target.value)} className={fieldClass}>
                  {state.templates.filter((template) => template.action === previewAction).map((template) => <option key={template.id} value={template.id} disabled={!!RETIRED_TEMPLATE_IDS[template.id]}>{template.id}{RETIRED_TEMPLATE_IDS[template.id] ? ` (retired; sends use ${RETIRED_TEMPLATE_IDS[template.id]})` : ""}</option>)}
                </select>
              </label>
              <TemplatePreview policy={policy} action={previewAction} />
            </div>
          </details>
        </>}
        <details open={!!parseError} className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-medium">Advanced policy · JSON</summary>
          <p id="reminder-json-help" className="my-3 text-sm leading-relaxed text-muted">Contains the complete draft, including legacy and unknown fields. Ordinary controls change only their own values. Validation checks this same draft before a save.</p>
          <label htmlFor="reminder-policy-json" className="text-sm font-medium">Policy JSON</label>
          <textarea id="reminder-policy-json" aria-describedby="reminder-json-help" value={json} onChange={(event) => edit({ type: "edit", json: event.target.value })} spellCheck={false} rows={12} className={cn(fieldClass, "font-mono text-xs leading-relaxed")} />
        </details>
        <div className="flex justify-end"><Btn busy={policyPending} tone="brand" onClick={save}><Save className="size-3" /> Save policy</Btn></div>
      </section>

      {/* 3. Dry run */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">What would go out now?</h4>
          <Btn busy={pending} onClick={() => start(async () => { const r = await runReminderDryRun(); setDry({ rows: r.rows, note: r.message, enabled: r.enabled, policySource: r.policySource, scopeLine: r.scopeLine }); })}>
            <Play className="size-3" /> Dry run (writes nothing)
          </Btn>
        </div>
        <p className="text-sm text-muted">Uses the saved policy and current rollout. This check sends nothing.</p>
        {dry && (
          <>
            <p className="text-xs text-muted">{dry.note} · evaluated with the {dry.policySource === "defaults" ? "code defaults" : "stored policy"}{dry.enabled ? "" : " · switch OFF, so none of this sends"}</p>
            {dry.scopeLine && <p className="text-xs text-muted"><strong className="text-foreground">Who reminders reach:</strong> {dry.scopeLine}.</p>}
            {dry.rows.length === 0 ? <p className="text-xs text-muted">No open months to evaluate.</p> : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                    <tr><th className="px-2 py-1.5">Client</th><th className="px-2 py-1.5">Month</th><th className="px-2 py-1.5">Action</th><th className="px-2 py-1.5">Decision</th><th className="px-2 py-1.5">To</th><th className="px-2 py-1.5">Why</th><th className="px-2 py-1.5">Next</th><th className="px-2 py-1.5"></th></tr>
                  </thead>
                  <tbody>
                    {dry.rows.map((r, i) => (
                      <tr key={`${r.enrollmentId}:${r.monthKey}:${r.lane}:${i}`} data-dry-lane={r.lane} className="border-t border-border align-top">
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.clientName} <Chip tone={reachWords(r).tone}>{reachWords(r).text}</Chip></td>
                        <td className="px-2 py-1.5">{r.monthKey}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{r.action ?? "—"}{r.attempt ? <span className="text-muted"> #{r.attempt}</span> : null}{r.lane !== "PLANNING" && <Chip tone="muted">{LANE_WORDS[r.lane]} lane</Chip>}</td>
                        <td className="px-2 py-1.5"><Chip tone={decisionTone(r.decision)}>{r.decision}{r.suppressionReason ? ` · ${r.suppressionReason}` : ""}</Chip>{r.escalation && <div className="mt-0.5 text-[11px] text-warning">escalate: {r.escalation}</div>}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted">{r.to ?? "—"}</td>
                        <td className="px-2 py-1.5 text-muted">{r.reason}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-muted">{fmt(r.nextEligibleAt)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {/* ADDRESS and APPROVE_SCRIPTS rows are per session and
                              read-only here: the buttons act on a month's lane. */}
                          {hasMonthButtons(r) && (
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
