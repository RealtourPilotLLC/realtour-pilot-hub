"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, BadgeDollarSign, CalendarClock, History, Lock, Settings2, Users } from "lucide-react";
import { Section } from "@/components/ui/Section";
import {
  changePackageAction, setCallModeAction, setEnrollmentStatusAction, setBillingTermsAction,
  setWorkflowFlagsAction, setOverrideAction, setEnrollmentOwnerAction,
} from "@/app/content/[id]/workspaceActions";
import type { CurrentMonthChoice } from "@/lib/enrollmentChanges";

// ---------------------------------------------------------------------------
// SETTINGS (spec §17). Package, enrollment status, allowances, call
// requirement, owners, permitted overrides — and billing shown READ-ONLY with
// its source named.
//
// Two things this screen is built to make impossible:
//   · a silent package rewrite. Changing the package asks for the month it
//     takes effect and, when that is the month in flight, forces an explicit
//     choice about this month's obligation before the button will submit.
//   · the impression that a hub setting moves money. Every money field says
//     where its value came from and that nothing here bills anyone; the
//     synchronized truth (a Stripe checkout) is shown beside the typed note
//     and cannot be edited from here at all.
// ---------------------------------------------------------------------------

export type SettingsUi = {
  enrollmentId: string;
  clientId: string;
  pkg: string;
  status: string;
  packageSource: string;
  videosPerMonth: number;
  sessionsPerMonth: number;
  sessionHours: number;
  callMode: "REQUIRED" | "OPTIONAL_WRITTEN" | "NOT_INCLUDED";
  noCallEligible: boolean | null;
  clientSuppliesTopics: boolean;
  timezone: string | null;
  notes: string | null;
  overrides: Record<string, unknown>;
  currentMonthKey: string;
  currentMonthLabel: string;
  nextMonthKey: string;
  nextMonthLabel: string;
  currentMonthOwed: number | null;
  /** What next month runs on, scheduled changes included (enrollmentChanges.termsInMonth). */
  nextTerms: { pkg: string; videosPerMonth: number; sessionsPerMonth: number; sessionHours: number };
  packages: { name: string; videosPerMonth: number; sessionsPerMonth: number; sessionHours: number }[];
};

export type BillingUi = {
  source: "stripe" | "owner" | "none";
  typed: { type: string | null; rate: number | null; months: number | null };
  signup: { productName: string; amount: number; recurring: boolean; paidAtISO: string; subscriptionId: string | null; status: string } | null;
  packageSource: string;
};

export type OwnersUi = { duty: string; word: string; label: string; appUserId: string | null; scope: string }[];
export type HistoryUi = { id: string; field: string; from: string | null; to: string | null; effectiveAtISO: string; effectiveMonthKey: string | null; currentMonthChoice: string | null; reason: string | null; source: string; billingTruth: boolean; changedBy: string | null; appliedAtISO: string | null; createdAtISO: string; superseded: boolean }[];

const btn = "rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50";
const quiet = "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";
const input = "rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm";
const money = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
const day = (isoStr: string | null) => (isoStr ? new Date(isoStr).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "—");

export function SettingsPanel({
  s, billing, owners, history, staff, isOwner, packageHandledAbove = false,
}: {
  s: SettingsUi; billing: BillingUi | null; owners: OwnersUi; history: HistoryUi; staff: { id: string; name: string }[]; isOwner: boolean;
  /** Kyle's view: EnrollmentControls above already carries package + status (Jordan, Sep 24), so this panel
   *  drops its read-only copies — they told him only Jordan could change it, under a card that lets him. */
  packageHandledAbove?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const say = (r: { ok: boolean; message: string }) => setNote(`${r.ok ? "" : "Couldn't do that — "}${r.message}`);

  return (
    <div className="space-y-5">
      {note && <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">{note}</p>}

      {!packageHandledAbove && <PackageCard s={s} isOwner={isOwner} busy={busy} start={start} say={say} />}

      {/* CALL REQUIREMENT — the §19 planning path, per client. */}
      <Section icon={CalendarClock} title="Planning & call requirement">
        <CallModeForm s={s} busy={busy} start={start} say={say} />
      </Section>

      {/* OWNERS — who is on the hook (§16/§17). */}
      <Section icon={Users} title="Who owns what for this client" flush>
        <div className="divide-y divide-border">
          {owners.map((o) => (
            <div key={o.duty} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm">
              <span className="w-40 shrink-0 capitalize">{o.word}</span>
              <span className="font-medium">{o.label}</span>
              <span className="text-[11px] text-muted-2">{o.scope === "DEFAULT" ? "program default" : o.scope === "ENROLLMENT" ? "set for this client" : "set for this month"}</span>
              {isOwner && (
                <select
                  className={`${input} ml-auto`}
                  defaultValue={o.scope === "ENROLLMENT" ? o.appUserId ?? "" : ""}
                  disabled={busy}
                  onChange={(e) => start(async () => say(await setEnrollmentOwnerAction(s.enrollmentId, o.duty, e.target.value || null)))}
                >
                  <option value="">use the program default</option>
                  {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* ENROLLMENT STATUS. */}
      {!packageHandledAbove && <Section icon={Settings2} title="Enrollment status">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Currently <span className="font-semibold">{s.status.toLowerCase()}</span>.</span>
          {isOwner && (["ACTIVE", "PAUSED", "ENDED"] as const).filter((x) => x !== s.status).map((x) => (
            <button key={x} disabled={busy} className={quiet} onClick={() => start(async () => say(await setEnrollmentStatusAction(s.enrollmentId, x)))}>
              Mark {x.toLowerCase()}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-muted">
          Pausing or ending is a hub setting only. It cancels nothing with a payment processor, and the client keeps read-only access
          to the work already released to them until somebody revokes it on the Portal access card.
        </p>
      </Section>}

      {/* WORKFLOW FLAGS. */}
      <Section icon={Settings2} title="Workflow">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" defaultChecked={s.clientSuppliesTopics} disabled={busy}
            onChange={(e) => start(async () => say(await setWorkflowFlagsAction(s.enrollmentId, { clientSuppliesTopics: e.target.checked })))} />
          This client brings their own topics (the topic bank does not chase them)
        </label>
        <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          Time zone
          <input className={input} defaultValue={s.timezone ?? ""} placeholder="America/New_York" disabled={busy}
            onBlur={(e) => start(async () => say(await setWorkflowFlagsAction(s.enrollmentId, { timezone: e.target.value.trim() || null })))} />
          <span className="text-[11px] text-muted-2">blank = America/New_York</span>
        </label>
        {isOwner && (
          <div className="mt-3 space-y-2 border-t border-border pt-3">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">Permitted overrides</p>
            {/* W01: the rule's own unit. Every filming gate reads it (it used
                to write a days value nothing read). */}
            <Override label="Preparation window (weekday hours, default 72)" k="preparationWindowHours" v={s.overrides.preparationWindowHours} s={s} busy={busy} start={start} say={say} />
            {s.overrides.preparationWindowDays != null && s.overrides.preparationWindowDays !== "" && (
              <div className="pl-2 text-[12px] text-muted-2">
                <Override label={`Legacy window in days (read as ${Number(s.overrides.preparationWindowDays) * 24 || "?"} weekday hours${s.overrides.preparationWindowHours != null ? "; the hours above win" : ""}), clear it to retire`} k="preparationWindowDays" v={s.overrides.preparationWindowDays} s={s} busy={busy} start={start} say={say} />
              </div>
            )}
            <Override label="Extra sessions allowed without approval" k="extraSessionsAllowed" v={s.overrides.extraSessionsAllowed} s={s} busy={busy} start={start} say={say} boolean />
            <Override label="Require a call for the next N months" k="requireCallForMonths" v={s.overrides.requireCallForMonths} s={s} busy={busy} start={start} say={say} />
          </div>
        )}
      </Section>

      {/* BILLING — read-only, with its source. */}
      {billing && <BillingCard b={billing} s={s} isOwner={isOwner} busy={busy} start={start} say={say} />}

      {/* HISTORY. */}
      <Section icon={History} title="Every change to this enrollment" count={history.length} flush>
        <div className="divide-y divide-border">
          {history.length === 0 && <p className="px-5 py-3 text-sm text-muted">No changes recorded through the hub yet.</p>}
          {history.map((h) => (
            <div key={h.id} className="px-5 py-2 text-[12px]">
              <span className="font-medium">{h.field}</span>: <span className="text-muted-2">{h.from ?? "—"}</span> → <span>{h.to ?? "—"}</span>
              {" · "}effective {day(h.effectiveAtISO)}{h.effectiveMonthKey ? ` (${h.effectiveMonthKey})` : ""}
              {h.currentMonthChoice && <> · this month: <span className="font-medium">{h.currentMonthChoice === "KEEP" ? "kept as minted" : "new quantity applied"}</span></>}
              {h.superseded
                ? <span className="ml-1 rounded bg-surface-2 px-1 text-[10px] font-semibold text-muted-2">superseded — never applied</span>
                : !h.appliedAtISO && <span className="ml-1 rounded bg-brand-soft px-1 text-[10px] font-semibold text-brand">scheduled</span>}
              <span className="ml-1 rounded bg-surface-2 px-1 text-[10px] text-muted-2">{h.billingTruth ? "billing truth" : "program setting"}</span>
              <span className="block text-muted-2">{h.changedBy ?? "system"} · {day(h.createdAtISO)}{h.reason ? ` · ${h.reason}` : ""}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ---- the package change ---------------------------------------------------------------

function PackageCard({
  s, isOwner, busy, start, say,
}: { s: SettingsUi; isOwner: boolean; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  // Starts from, and compares with, NEXT month's terms (scheduled changes
  // included) — comparing with today's column left the button armed after a
  // scheduled change, and a second press used to cancel it (Sep 24).
  const [pkg, setPkg] = useState(s.nextTerms.pkg);
  const [when, setWhen] = useState<"now" | "next">("next");
  const [choice, setChoice] = useState<CurrentMonthChoice | "">("");
  const [reason, setReason] = useState("");
  const rule = s.packages.find((p) => p.name === pkg) ?? null;
  const scheduled = s.nextTerms.pkg !== s.pkg;
  const changed = when === "next" ? pkg !== s.nextTerms.pkg : pkg !== s.pkg || pkg !== s.nextTerms.pkg;
  const showWhen = pkg !== s.pkg || pkg !== s.nextTerms.pkg;
  const needsChoice = changed && when === "now";
  const ready = changed && (!needsChoice || choice !== "");

  return (
    <Section
      icon={Settings2}
      title="Package"
      action={<span className="text-[11px] text-muted-2">set {s.packageSource === "aryeo" ? "from the Aryeo social plan" : "by hand"}</span>}
    >
      <p className="text-sm">
        <span className="font-semibold">{s.pkg}</span> — {s.videosPerMonth} video{s.videosPerMonth === 1 ? "" : "s"} and{" "}
        {s.sessionsPerMonth} session{s.sessionsPerMonth === 1 ? "" : "s"} ({s.sessionHours}h) a month.
        {s.currentMonthOwed != null && <span className="text-muted"> {s.currentMonthLabel} was minted owing {s.currentMonthOwed}.</span>}
      </p>
      {scheduled && (
        <p className="mt-1 text-[12px] font-medium text-brand">
          Scheduled from {s.nextMonthLabel}: {s.nextTerms.pkg} — {s.nextTerms.videosPerMonth} videos / {s.nextTerms.sessionsPerMonth} session{s.nextTerms.sessionsPerMonth === 1 ? "" : "s"}.
        </p>
      )}

      {!isOwner ? (
        <p className="mt-2 text-[12px] text-muted">Jordan or Kyle changes a package — every change is recorded in the history below.</p>
      ) : (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Change to
            <select className={input} value={pkg} onChange={(e) => setPkg(e.target.value)} disabled={busy}>
              {s.packages.map((p) => <option key={p.name} value={p.name}>{p.name} — {p.videosPerMonth} videos / {p.sessionsPerMonth} session{p.sessionsPerMonth === 1 ? "" : "s"}</option>)}
            </select>
          </label>

          {showWhen && (
            <>
              {/* THE EFFECTIVE DATE — never implicit. */}
              <div className="text-sm">
                <p className="mb-1 font-medium">From when?</p>
                <label className="mr-4 inline-flex items-center gap-1.5">
                  <input type="radio" name="when" checked={when === "next"} onChange={() => { setWhen("next"); setChoice(""); }} />
                  {s.nextMonthLabel} (next month)
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input type="radio" name="when" checked={when === "now"} onChange={() => setWhen("now")} />
                  {s.currentMonthLabel} (this month)
                </label>
              </div>

              {!changed && <p className="text-[12px] text-muted-2">{when === "next" ? s.nextMonthLabel : s.currentMonthLabel} already runs on {pkg} — nothing to record.</p>}

              {/* THE CURRENT-MONTH CHOICE — required, and stated in plain words. */}
              {needsChoice && (
                <div className="rounded-xl border border-warning/40 bg-warning-soft/40 p-3 text-sm">
                  <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warning">
                    <AlertTriangle className="size-4" /> {s.currentMonthLabel} is already underway — what happens to this month?
                  </p>
                  <label className="block"><input type="radio" name="choice" checked={choice === "KEEP"} onChange={() => setChoice("KEEP")} />{" "}
                    Keep {s.currentMonthLabel} as it was minted{s.currentMonthOwed != null ? ` (${s.currentMonthOwed} videos)` : ""} — the new quantity starts {s.nextMonthLabel}.
                  </label>
                  <label className="block"><input type="radio" name="choice" checked={choice === "APPLY"} onChange={() => setChoice("APPLY")} />{" "}
                    Apply {rule ? `${rule.videosPerMonth} videos` : "the new quantity"} to {s.currentMonthLabel} as well.
                  </label>
                  <p className="mt-1 text-[11px] text-muted">Months before this one keep the quantities they were minted with, either way.</p>
                </div>
              )}

              <input className={`${input} w-full`} placeholder="Why (optional — it goes in the history)" value={reason} onChange={(e) => setReason(e.target.value)} />

              <div className="flex items-center gap-2">
                <button
                  disabled={busy || !ready}
                  className={btn}
                  onClick={() => start(async () => {
                    const r = await changePackageAction(s.enrollmentId, {
                      package: pkg,
                      effectiveMonthKey: when === "now" ? s.currentMonthKey : s.nextMonthKey,
                      currentMonthChoice: when === "now" ? (choice as CurrentMonthChoice) : null,
                      reason: reason.trim() || null,
                    });
                    say(r);
                    if (r.ok) { setReason(""); setChoice(""); setWhen("next"); }
                  })}
                >
                  Record the package change
                </button>
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-2"><Lock className="size-3" /> nothing is billed, cancelled or charged</span>
              </div>
            </>
          )}
        </div>
      )}
    </Section>
  );
}

function CallModeForm({
  s, busy, start, say,
}: { s: SettingsUi; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  const [mode, setMode] = useState(s.callMode);
  const [eligible, setEligible] = useState<boolean | null>(s.noCallEligible);
  const MODES = [
    { key: "REQUIRED" as const, label: "Call required", hint: "the month does not start until the strategy call happens" },
    { key: "OPTIONAL_WRITTEN" as const, label: "Optional — written answers allowed", hint: "they may plan the month without a call" },
    { key: "NOT_INCLUDED" as const, label: "No call in this package", hint: "planning is always written" },
  ];
  return (
    <div className="space-y-2 text-sm">
      {MODES.map((m) => (
        <label key={m.key} className="block">
          <input type="radio" name="callmode" checked={mode === m.key} onChange={() => setMode(m.key)} disabled={busy} />{" "}
          <span className="font-medium">{m.label}</span> <span className="text-muted-2">— {m.hint}</span>
        </label>
      ))}
      {mode === "OPTIONAL_WRITTEN" && (
        <label className="ml-5 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={eligible === true} onChange={(e) => setEligible(e.target.checked ? true : false)} disabled={busy} />
          Offer them the &ldquo;plan without a call&rdquo; choice in the portal
        </label>
      )}
      <button
        className={btn}
        disabled={busy || (mode === s.callMode && eligible === s.noCallEligible)}
        onClick={() => start(async () => say(await setCallModeAction(s.enrollmentId, mode, mode === "OPTIONAL_WRITTEN" ? eligible : null)))}
      >
        Save the call requirement
      </button>
    </div>
  );
}

function Override({
  label, k, v, s, busy, start, say, boolean: isBool,
}: { label: string; k: string; v: unknown; s: SettingsUi; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void; boolean?: boolean }) {
  const current = v === undefined || v === null ? "" : String(v);
  return (
    <label className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="min-w-56">{label}</span>
      {isBool ? (
        <select className={input} defaultValue={current} disabled={busy} onChange={(e) => start(async () => say(await setOverrideAction(s.enrollmentId, k, e.target.value)))}>
          <option value="">program default</option><option value="true">yes</option><option value="false">no</option>
        </select>
      ) : (
        <input className={`${input} w-24`} defaultValue={current} placeholder="default" disabled={busy}
          onBlur={(e) => start(async () => say(await setOverrideAction(s.enrollmentId, k, e.target.value)))} />
      )}
      {current === "" && <span className="text-[11px] text-muted-2">never set</span>}
    </label>
  );
}

function BillingCard({
  b, s, isOwner, busy, start, say,
}: { b: BillingUi; s: SettingsUi; isOwner: boolean; busy: boolean; start: (fn: () => void) => void; say: (r: { ok: boolean; message: string }) => void }) {
  const [type, setType] = useState(b.typed.type ?? "");
  const [rate, setRate] = useState(b.typed.rate == null ? "" : String(b.typed.rate));
  const [months, setMonths] = useState(b.typed.months == null ? "" : String(b.typed.months));
  return (
    <Section icon={BadgeDollarSign} title="Billing" action={<span className="text-[11px] text-muted-2">read-only where it is synchronized truth</span>}>
      {/* SYNCHRONIZED TRUTH — a real payment, shown, never editable here. */}
      {b.signup ? (
        <div className="rounded-xl border border-success/30 bg-success/5 p-3 text-[13px]">
          <p className="flex items-center gap-1.5 font-medium text-success"><Lock className="size-3.5" /> Synchronized billing truth — from the Stripe checkout</p>
          <p className="mt-1">
            {b.signup.productName} · {money(b.signup.amount)} {b.signup.recurring ? "recurring" : "one-off"} · paid {day(b.signup.paidAtISO)} · status {b.signup.status}
            {b.signup.subscriptionId && <span className="text-muted-2"> · subscription {b.signup.subscriptionId}</span>}
          </p>
          <p className="mt-1 text-[11px] text-muted">This comes from the payment processor. Nothing on this page can change, cancel or re-charge it.</p>
        </div>
      ) : (
        <p className="rounded-xl border border-border bg-surface-2/50 p-3 text-[13px] text-muted">
          No processor record is linked to this enrollment — everything below is a <span className="font-medium text-foreground">program setting</span>: a note of what was agreed.
        </p>
      )}

      {/* THE TYPED NOTE — a program setting. */}
      <div className="mt-3 space-y-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-2">Agreed terms (a note, not a charge)</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className={input} value={type} onChange={(e) => setType(e.target.value)} disabled={!isOwner || busy}>
            <option value="">not recorded</option>
            <option value="PAID_IN_FULL">paid in full</option>
            <option value="MONTHLY_CONTRACT">monthly, on a contract</option>
            <option value="MONTH_TO_MONTH">month to month</option>
            <option value="TRIAL">trial</option>
          </select>
          <input className={`${input} w-28`} placeholder="amount" value={rate} onChange={(e) => setRate(e.target.value)} disabled={!isOwner || busy} />
          <input className={`${input} w-24`} placeholder="months" value={months} onChange={(e) => setMonths(e.target.value)} disabled={!isOwner || busy} />
          {isOwner && (
            <button
              className={btn}
              disabled={busy}
              onClick={() => start(async () => say(await setBillingTermsAction(s.enrollmentId, {
                type: type || null, rate: rate.trim() === "" ? null : Number(rate), months: months.trim() === "" ? null : Number(months),
              })))}
            >
              Save the note
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted">
          Where it came from: {b.source === "stripe" ? "a Stripe checkout created this enrollment" : b.source === "owner" ? "typed here by the owner" : "nothing recorded"}.
          Package source: {b.packageSource}.
        </p>
      </div>
    </Section>
  );
}
