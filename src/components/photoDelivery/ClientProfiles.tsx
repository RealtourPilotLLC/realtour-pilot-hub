"use client";

import { useMemo, useState, useTransition } from "react";
import { ChevronDown, Loader2, Plus, Save, Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { saveClientProfileAction } from "@/app/ops/photo-delivery/actions";
import { SEVERITY_LABEL } from "./format";
import type { ClientProfileView, RuleOption, RuleOverrideView, Severity } from "./types";

// ---------------------------------------------------------------------------
// CLIENT QC PROFILES (plan 4 ClientQcProfile, 7.5), owner only. Per client
// with photo jobs: notes the QC prompt reads, the delivery message (Kyle
// copies it when he delivers by hand; Realtour Pilot Team voice), and rule
// overrides: turn a rule off or re-grade it for this client, always with a
// reason, picked from the rules registry with a search box. (The profile's
// SLA hours column is not shown: the due time comes from the project.)
// ---------------------------------------------------------------------------

const input = "w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm focus-visible:outline-2 focus-visible:outline-brand";
const SEVS: Severity[] = ["CRITICAL", "MAJOR", "MINOR"];

function RulePicker({ rules, taken, onPick }: { rules: RuleOption[]; taken: Set<string>; onPick: (r: RuleOption) => void }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return rules.filter((r) => !taken.has(r.id) && (r.label.toLowerCase().includes(s) || r.id.toLowerCase().includes(s) || r.section.toLowerCase().includes(s))).slice(0, 25);
  }, [q, rules, taken]);
  return (
    <div>
      <label className="relative block">
        <span className="sr-only">Find a QC rule</span>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a rule to override (for example: trash, mirror, sky)" className={cn(input, "min-h-11 pl-9")} />
      </label>
      {q.trim().length >= 2 && (
        <ul className="mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-border" aria-label="Matching rules">
          {hits.length === 0 ? (
            <li className="p-2 text-[13px] text-muted">No rule matches.</li>
          ) : (
            hits.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(r);
                    setQ("");
                  }}
                  className="flex min-h-11 w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"
                >
                  <Plus aria-hidden className="size-3.5 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{r.label}</span>
                    <span className="block text-[12px] text-muted">{r.section} · {r.id}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-muted">{SEVERITY_LABEL[r.severity]}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function ProfileEditor({ p, rules, ruleById }: { p: ClientProfileView; rules: RuleOption[]; ruleById: Map<string, RuleOption> }) {
  const [notes, setNotes] = useState(p.notes);
  const [message, setMessage] = useState(p.deliveryMessage);
  const [overrides, setOverrides] = useState<RuleOverrideView[]>(p.overrides);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const taken = useMemo(() => new Set(overrides.map((o) => o.ruleId)), [overrides]);
  const update = (i: number, next: Partial<RuleOverrideView>) => setOverrides((cur) => cur.map((o, n) => (n === i ? { ...o, ...next } : o)));
  const save = () =>
    start(async () => {
      try {
        const r = await saveClientProfileAction({
          clientId: p.clientId,
          notes,
          deliveryMessage: message,
          ruleOverrides: overrides.map((o) => (o.disabled ? { ruleId: o.ruleId, disabled: true, reason: o.reason } : { ruleId: o.ruleId, severity: o.severity, reason: o.reason })),
        });
        setMsg({ ok: r.ok, text: r.message });
      } catch {
        setMsg({ ok: false, text: "The hub didn't answer. Reload to see what is saved." });
      }
    });
  const id = `pd-prof-${p.clientId}`;
  return (
    <div className="space-y-4 border-t border-border p-4">
      <div>
        <label htmlFor={`${id}-notes`} className="text-sm font-medium">Notes for QC</label>
        <textarea id={`${id}-notes`} rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="For example: bins at the curb are fine; always flag a crooked hero." className={cn(input, "py-2")} />
        <p className="mt-1 text-[12px] text-muted">The QC checks read these for this client&rsquo;s galleries.</p>
      </div>
      <div>
        <label htmlFor={`${id}-msg`} className="text-sm font-medium">Delivery message</label>
        <textarea id={`${id}-msg`} rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Blank uses the standard message, signed Realtour Pilot Team." className={cn(input, "py-2")} />
        <p className="mt-1 text-[12px] text-muted">Kyle copies this when delivering by hand.</p>
      </div>
      <div>
        <p className="text-sm font-medium">Rule overrides ({overrides.length})</p>
        <p className="text-[12px] text-muted">Turn a rule off or change its severity for this client only. A reason is required for each.</p>
        {overrides.length > 0 && (
          <ul className="mt-2 space-y-2">
            {overrides.map((o, i) => {
              const r = ruleById.get(o.ruleId);
              return (
                <li key={o.ruleId} className="rounded-xl border border-border p-2.5">
                  {/* Phone layout (Jordan, Oct 28 2026): the picker and button wrap under the rule instead of squeezing it. */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="min-w-0 flex-1 basis-48 text-sm">
                      <span className="font-medium">{r?.label ?? o.ruleId}</span>
                      <span className="block text-[12px] text-muted">{o.ruleId}{r ? ` · default ${SEVERITY_LABEL[r.severity].toLowerCase()}` : " · not in the registry"}</span>
                    </span>
                    <label className="ml-auto text-[13px]">
                      <span className="sr-only">What to do with {r?.label ?? o.ruleId}</span>
                      <select
                        value={o.disabled ? "OFF" : o.severity ?? "MINOR"}
                        onChange={(e) => (e.target.value === "OFF" ? update(i, { disabled: true, severity: undefined }) : update(i, { disabled: false, severity: e.target.value as Severity }))}
                        className={cn(input, "min-h-10 w-auto")}
                      >
                        <option value="OFF">Turn off</option>
                        {SEVS.map((s) => (
                          <option key={s} value={s}>Always {SEVERITY_LABEL[s].toLowerCase()}</option>
                        ))}
                      </select>
                    </label>
                    <button type="button" onClick={() => setOverrides((cur) => cur.filter((_, n) => n !== i))} aria-label={`Remove the override for ${r?.label ?? o.ruleId}`} className="inline-flex size-10 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-danger">
                      <Trash2 aria-hidden className="size-4" />
                    </button>
                  </div>
                  <label className="mt-1.5 block">
                    <span className="sr-only">Reason</span>
                    <input value={o.reason} onChange={(e) => update(i, { reason: e.target.value })} maxLength={300} placeholder="Why, for this client" className={cn(input, "min-h-10")} />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2">
          <RulePicker rules={rules} taken={taken} onPick={(r) => setOverrides((cur) => [...cur, { ruleId: r.id, disabled: true, reason: "" }])} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending} onClick={save} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:opacity-50">
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden className="size-4" />} Save {p.clientName}
        </button>
        <p role="status" className={`text-[13px] ${msg ? (msg.ok ? "text-success" : "text-warning") : ""}`}>{msg?.text ?? ""}</p>
      </div>
    </div>
  );
}

export function ClientProfiles({ profiles, rules }: { profiles: ClientProfileView[]; rules: RuleOption[] }) {
  const [q, setQ] = useState("");
  const ruleById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);
  const shown = profiles.filter((p) => !q.trim() || `${p.clientName} ${p.company ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  if (!profiles.length) return <p className="text-sm text-muted">No client has a photo job yet. Clients appear here once the hub opens their first photo job.</p>;
  return (
    <div className="space-y-3">
      {profiles.length > 6 && (
        <label className="relative block max-w-sm">
          <span className="sr-only">Find a client</span>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client" className={cn(input, "min-h-11 pl-9")} />
        </label>
      )}
      <ul className="space-y-2">
        {shown.map((p) => {
          const custom = p.notes || p.deliveryMessage || p.overrides.length > 0;
          return (
            <li key={p.clientId}>
              <details className="rounded-xl border border-border bg-surface">
                <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
                  <ChevronDown aria-hidden className="size-4 text-muted" />
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="font-medium">{p.clientName}</span>
                    {p.company && <span className="text-[13px] text-muted"> · {p.company}</span>}
                    <span className="block text-[12px] text-muted">
                      {p.jobCount} photo job{p.jobCount === 1 ? "" : "s"} ({p.openJobCount} open)
                      {p.updatedAt ? ` · profile saved ${etMonthDayTime(p.updatedAt)}${p.updatedBy ? ` by ${p.updatedBy}` : ""}` : ""}
                    </span>
                  </span>
                  <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[12px]", custom ? "bg-brand-soft text-foreground" : "bg-surface-2 text-muted")}>
                    {custom ? [p.overrides.length > 0 && `${p.overrides.length} override${p.overrides.length === 1 ? "" : "s"}`, p.deliveryMessage && "own message"].filter(Boolean).join(" · ") || "notes" : "Defaults"}
                  </span>
                </summary>
                <ProfileEditor p={p} rules={rules} ruleById={ruleById} />
              </details>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="text-sm text-muted">No client matches.</p>}
    </div>
  );
}
