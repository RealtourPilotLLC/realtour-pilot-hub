"use client";

import { useState, useTransition } from "react";
import { Loader2, RefreshCw, Check, AlertTriangle, ExternalLink, ShieldCheck, CircleSlash, FileText, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  saveCalendlyMapping, removeCalendlyMapping, revalidateCalendlyMappings, runCallSyncNow, saveCallRules,
  confirmCallClient, ignoreCall, retargetCall, confirmTranscript, rejectTranscript, verifyAlias, dismissAlias, rerunTranscriptJob,
  type CalendlyPanelState,
} from "@/app/settings/calendlyActions";

// ---------------------------------------------------------------------------
// Settings → Calendly & calls (spec §26). What the owner sees:
//   1. the account's event types with a purpose picker — the URI is the key;
//   2. the two configuration exceptions that matter ("no monthly type
//      enabled", "no brand-discovery type exists yet — create one in Calendly
//      and it will appear here");
//   3. the review queue — bookings nobody could match, transcripts waiting
//      for a person, alias proposals;
//   4. recent call records with booking link, type, client, source event,
//      transcript link, analysis state and last error (§26's last test);
//   5. the switches (read-only here; they stay off) and the job lane.
// ---------------------------------------------------------------------------

const PURPOSES = [
  { value: "", label: "Not part of the program" },
  { value: "MONTHLY_STRATEGY", label: "Monthly strategy call" },
  { value: "BRAND_DISCOVERY", label: "Brand discovery (onboarding)" },
  { value: "IGNORED", label: "Explicitly ignore" },
];
const fmt = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";

function Chip({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
      tone === "ok" && "bg-success/15 text-success", tone === "warn" && "bg-warning/15 text-warning",
      tone === "bad" && "bg-danger/15 text-danger", tone === "muted" && "bg-surface-2 text-muted",
    )}>{children}</span>
  );
}

function Btn({ onClick, children, busy, tone = "default" }: { onClick: () => void; children: React.ReactNode; busy?: boolean; tone?: "default" | "brand" | "danger" }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className={cn(
      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50",
      tone === "brand" && "border-brand bg-brand text-white", tone === "danger" && "border-danger/40 text-danger", tone === "default" && "border-border bg-surface-2",
    )}>{busy ? <Loader2 className="size-3 animate-spin" /> : null}{children}</button>
  );
}

export function CalendlyMappingsPanel({ state }: { state: CalendlyPanelState }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { purpose: string; enabled: boolean }>>(() =>
    Object.fromEntries(state.eventTypes.map((t) => [t.uri, { purpose: t.mapping?.purpose ?? "", enabled: t.mapping?.enabled ?? false }])),
  );
  const [nextDay, setNextDay] = useState(state.rules.nextMonthFromDay);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.message }); });

  // Three states for the brand-discovery hint: the type is not on the account
  // (create it), it is there but unmapped (map it), or it is mapped (quiet).
  const discoveryTypeExists = state.discoveryTypeExists || state.eventTypes.some((t) => t.mapping?.purpose === "BRAND_DISCOVERY");

  return (
    <div className="space-y-5 text-sm">
      {/* Health line */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {state.connected ? <Chip tone="ok"><Check className="size-3" /> {state.connectionLabel ?? "Calendly connected"}</Chip> : <Chip tone="bad">Calendly not connected</Chip>}
        <span>Calendly last successful sync: <strong className="text-foreground">{fmt(state.lastSyncedAt)}</strong></span>
        <span>· Drive (Gemini notes) last read: <strong className="text-foreground">{fmt(state.driveLastSyncedAt)}</strong></span>
        <span className="ml-auto flex gap-2">
          <Btn busy={pending} onClick={() => run(revalidateCalendlyMappings)}><ShieldCheck className="size-3" /> Re-validate</Btn>
          <Btn busy={pending} tone="brand" onClick={() => run(runCallSyncNow)}><RefreshCw className="size-3" /> Sync now</Btn>
        </span>
      </div>
      {state.fetchError && <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">Could not read the account&rsquo;s event types: {state.fetchError}</p>}
      {msg && <p className={cn("rounded-lg px-3 py-2 text-xs", msg.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{msg.text}</p>}

      {/* Configuration exceptions — the panel's whole reason to exist */}
      {!state.monthlyMapped && (
        <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span><strong>No monthly strategy type is enabled.</strong> Until one is, bookings are never classified by the program and the legacy sweep keeps today&rsquo;s behaviour. Pick the dedicated &ldquo;Content Program &ndash; Strategy Call&rdquo; type below — never the generic 30-minute call.</span>
        </p>
      )}
      {!discoveryTypeExists && (
        <p className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span><strong>No brand-discovery event type exists yet.</strong> Create one in Calendly (suggested name &ldquo;Content Program: Brand Discovery&rdquo;) — it will appear in this list on the next load, and mapping it here is what routes discovery calls to onboarding instead of a month.</span>
        </p>
      )}
      {discoveryTypeExists && !state.discoveryMapped && (
        <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span><strong>The brand-discovery type is on the account but not mapped yet.</strong> Set its purpose to &ldquo;Brand discovery (onboarding)&rdquo; below and switch it on — until then its bookings are outside the program.</span>
        </p>
      )}
      {state.orphanMappings.length > 0 && (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
          {state.orphanMappings.length} mapping(s) point at event types that are no longer on the account ({state.orphanMappings.map((m) => m.eventName).join(", ")}). A deleted-and-recreated type has a NEW uri: map the new one — the hub will not fall back to matching titles.
        </p>
      )}

      {/* Event types */}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-xs">
          <thead className="bg-surface-2 text-left text-muted">
            <tr><th className="px-3 py-2">Event type</th><th className="px-3 py-2">Purpose</th><th className="px-3 py-2">On</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Last sync</th><th className="px-3 py-2"></th></tr>
          </thead>
          <tbody className="divide-y">
            {state.eventTypes.map((t) => {
              const d = drafts[t.uri] ?? { purpose: "", enabled: false };
              const dirty = d.purpose !== (t.mapping?.purpose ?? "") || d.enabled !== (t.mapping?.enabled ?? false);
              return (
                <tr key={t.uri} className={cn(!t.active && "opacity-60")}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-[11px] text-muted">
                      {t.slug ?? "—"}{!t.active && " · inactive"}
                      {t.schedulingUrl && <a className="ml-2 inline-flex items-center gap-0.5 underline" href={t.schedulingUrl} target="_blank" rel="noreferrer">booking link <ExternalLink className="size-2.5" /></a>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <select value={d.purpose} onChange={(e) => setDrafts({ ...drafts, [t.uri]: { ...d, purpose: e.target.value, enabled: e.target.value ? d.enabled : false } })} className="rounded-lg border border-border bg-surface-2 px-2 py-1">
                      {PURPOSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={d.enabled} disabled={!d.purpose} onChange={(e) => setDrafts({ ...drafts, [t.uri]: { ...d, enabled: e.target.checked } })} />
                  </td>
                  <td className="px-3 py-2">
                    {t.mapping ? (
                      <Chip tone={t.mapping.validationStatus === "VALID" ? "ok" : t.mapping.validationStatus === "RENAMED" ? "warn" : t.mapping.validationStatus === "MISSING" ? "bad" : "muted"}>{t.mapping.validationStatus.toLowerCase()}</Chip>
                    ) : <Chip tone="muted">unmapped</Chip>}
                    {t.mapping?.lastError && <div className="mt-1 text-[11px] text-danger">{t.mapping.lastError}</div>}
                  </td>
                  <td className="px-3 py-2 text-muted">{fmt(t.mapping?.lastSyncedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    {(dirty || !t.mapping) && d.purpose && (
                      <Btn busy={pending} tone="brand" onClick={() => run(() => saveCalendlyMapping({ eventTypeUri: t.uri, purpose: d.purpose, enabled: d.enabled }))}>Save</Btn>
                    )}
                    {dirty && !d.purpose && t.mapping && (
                      // "Not part of the program" on a mapped row = remove the mapping (its records stay).
                      <Btn busy={pending} tone="danger" onClick={() => run(() => removeCalendlyMapping(t.uri))}>Remove mapping</Btn>
                    )}
                  </td>
                </tr>
              );
            })}
            {state.eventTypes.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-muted">No event types to show.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Rules + switches */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border p-3">
          <div className="mb-2 font-medium">Which month a monthly call plans</div>
          <p className="mb-2 text-[12px] text-muted">A call held on or after this day of the month plans the <em>next</em> month (a Sep 26 call plans October). Earlier calls plan their own month. The outcome and reason are stored on every record.</p>
          <div className="flex items-center gap-2 text-xs">
            <span>Day</span>
            <input inputMode="numeric" value={String(nextDay)} onChange={(e) => { const n = Number(e.target.value.replace(/[^\d]/g, "")); if (!Number.isNaN(n)) setNextDay(Math.min(31, Math.max(1, n))); }} className="w-14 rounded-lg border border-border bg-surface-2 px-2 py-1 tabular-nums" />
            <Btn busy={pending} onClick={() => run(() => saveCallRules({ nextMonthFromDay: nextDay }))}>Save</Btn>
          </div>
        </div>
        <div className="rounded-xl border p-3">
          <div className="mb-2 font-medium">Automation switches</div>
          <ul className="space-y-1 text-xs">
            {state.switches.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <Chip tone={s.enabled ? "ok" : "muted"}>{s.enabled ? "on" : s.missing ? "off (never configured)" : "off"}</Chip>
                <code>{s.key}</code>
                {s.lastError && <span className="text-danger">· {s.lastError}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">These stay off until launch is authorised. With them off, call records and transcripts are still collected and queued; nothing is analysed and nothing is booked or sent.</p>
        </div>
      </div>

      {/* Review queue */}
      <div className="rounded-xl border">
        <div className="flex items-center gap-2 border-b px-3 py-2 font-medium"><ListChecks className="size-4 text-muted" /> Needs a person <Chip tone={state.reviewRecords.length + state.queue.aliases.length ? "warn" : "muted"}>{state.reviewRecords.length + state.queue.aliases.length}</Chip></div>
        <div className="divide-y">
          {state.reviewRecords.map((r) => <ReviewRow key={r.id} r={r} clients={state.enrolledClients} busy={pending} run={run} />)}
          {state.queue.aliases.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <Chip tone="warn">alias proposal</Chip>
              <span><strong>{a.email}</strong> → {a.clientName} <span className="text-muted">({a.source}, {fmt(a.createdAt)})</span></span>
              <span className="ml-auto flex gap-2">
                <Btn busy={pending} tone="brand" onClick={() => run(() => verifyAlias(a.id))}>Verify</Btn>
                <Btn busy={pending} onClick={() => run(() => dismissAlias(a.id))}>Dismiss</Btn>
              </span>
            </div>
          ))}
          {state.reviewRecords.length === 0 && state.queue.aliases.length === 0 && <p className="px-3 py-3 text-xs text-muted">Nothing waiting.</p>}
        </div>
        {state.queue.unlinkedTranscripts.length > 0 && (
          <div className="border-t px-3 py-2 text-xs">
            <div className="mb-1 flex items-center gap-1 font-medium"><FileText className="size-3.5 text-muted" /> Unlinked Gemini notes (import queue) — {state.queue.unlinkedTranscripts.length}</div>
            <ul className="space-y-0.5 text-muted">
              {state.queue.unlinkedTranscripts.slice(0, 12).map((t) => (
                <li key={t.id}>{fmt(t.recordedAt)} · {t.sourceUrl ? <a className="underline" href={t.sourceUrl} target="_blank" rel="noreferrer">{t.title ?? t.id}</a> : (t.title ?? t.id)}{t.legacyMonthId && " · already on a month (legacy)"}{t.candidates.length > 0 && ` · ${t.candidates.length} candidate call(s)`}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Recent records */}
      <div className="overflow-x-auto rounded-xl border">
        <div className="border-b px-3 py-2 font-medium">Recent call records</div>
        <table className="w-full text-xs">
          <thead className="bg-surface-2 text-left text-muted"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Transcript</th><th className="px-3 py-2">Analysis</th><th className="px-3 py-2">Links</th></tr></thead>
          <tbody className="divide-y">
            {state.records.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 whitespace-nowrap">{fmt(r.scheduledStart)}</td>
                <td className="px-3 py-2">{r.callType.toLowerCase().replace("_", " ")}{r.targetMonthKey && <div className="text-[11px] text-muted">plans {r.targetMonthKey}</div>}</td>
                <td className="px-3 py-2">{r.client?.name ?? <span className="text-muted">{r.inviteeName ?? r.inviteeEmail ?? "—"}</span>}<div className="text-[11px] text-muted">{r.matchState.toLowerCase().replace(/_/g, " ")}</div></td>
                <td className="px-3 py-2"><Chip tone={r.status === "CANCELLED" || r.status === "RESCHEDULED" ? "muted" : r.status === "COMPLETED" ? "ok" : "warn"}>{r.status.toLowerCase()}</Chip></td>
                <td className="px-3 py-2">
                  <Chip tone={r.transcriptState === "CONFIRMED" || r.transcriptState === "ANALYZED" ? "ok" : r.transcriptState === "NEEDS_REVIEW" || r.transcriptState === "FAILED" ? "bad" : "muted"}>{r.transcriptState.toLowerCase().replace("_", " ")}</Chip>
                  {r.transcripts.filter((t) => t.matchState === "CONFIRMED").map((t) => t.sourceUrl ? <a key={t.id} className="ml-1 underline" href={t.sourceUrl} target="_blank" rel="noreferrer">doc</a> : null)}
                </td>
                <td className="px-3 py-2">
                  {r.jobs.length === 0 ? <span className="text-muted">—</span> : r.jobs.map((j) => (
                    <div key={j.id} className="flex items-center gap-1">
                      <Chip tone={j.state === "SUCCEEDED" ? "ok" : j.state === "QUEUED" || j.state === "RUNNING" ? "muted" : "bad"}>{j.kind.toLowerCase()} · {j.state.toLowerCase()}</Chip>
                      {(j.state === "FAILED" || j.state === "NEEDS_REVIEW" || j.state === "CANCELLED") && <Btn busy={pending} onClick={() => run(() => rerunTranscriptJob(j.id))}>Re-run</Btn>}
                    </div>
                  ))}
                  {r.lastError && <div className="mt-1 max-w-[260px] text-[11px] text-danger">{r.lastError}</div>}
                </td>
                <td className="px-3 py-2 text-[11px]">
                  {r.bookingLink && <a className="block underline" href={r.bookingLink} target="_blank" rel="noreferrer">booking link</a>}
                  {r.meetLink && <a className="block underline" href={r.meetLink} target="_blank" rel="noreferrer">meet{r.meetConferenceId ? ` (${r.meetConferenceId})` : ""}</a>}
                  {r.sourceEventUri && <span className="block text-muted" title={r.sourceEventUri}>event …{r.sourceEventUri.slice(-8)}</span>}
                </td>
              </tr>
            ))}
            {state.records.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-center text-muted">No call records yet — they appear after the first sync with an enabled mapping.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Job lane */}
      <div className="rounded-xl border p-3 text-xs">
        <div className="mb-1 flex items-center gap-2 font-medium">Transcript jobs <Chip tone={state.jobs.enabled ? "ok" : "muted"}>{state.jobs.enabled ? "running" : "off — rows wait"}</Chip></div>
        <div className="flex flex-wrap gap-2 text-muted">
          {Object.entries(state.jobs.handlers).map(([k, has]) => <Chip key={k} tone={has ? "ok" : "warn"}>{has ? <Check className="size-3" /> : <CircleSlash className="size-3" />} {k}{has ? "" : " (no handler in this build)"}</Chip>)}
        </div>
        {state.jobs.counts.length > 0 && (
          <div className="mt-2 text-muted">{state.jobs.counts.map((c) => `${c.kind} ${c.state.toLowerCase()}: ${c.n}`).join(" · ")}{state.jobs.oldestQueuedAt && ` · oldest queued ${fmt(state.jobs.oldestQueuedAt)}`}</div>
        )}
      </div>
    </div>
  );
}

function ReviewRow({ r, clients, busy, run }: { r: CalendlyPanelState["reviewRecords"][number]; clients: { id: string; name: string }[]; busy: boolean; run: (fn: () => Promise<{ ok: boolean; message: string }>) => void }) {
  const [clientId, setClientId] = useState(r.candidates[0]?.clientId ?? "");
  const [verify, setVerify] = useState(true);
  const [monthKey, setMonthKey] = useState(r.targetMonthKey ?? "");
  const identityOpen = ["UNMATCHED_INVITEE", "AMBIGUOUS_CLIENT", "AMBIGUOUS_MONTH", "UNMAPPED_TYPE"].includes(r.matchState);
  const candidates = r.transcripts.filter((t) => t.matchState === "CANDIDATE");
  return (
    <div className="space-y-2 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="warn">{identityOpen ? r.matchState.toLowerCase().replace(/_/g, " ") : r.transcriptState.toLowerCase().replace(/_/g, " ")}</Chip>
        <strong>{r.eventTypeName ?? r.callType}</strong> · {fmt(r.scheduledStart)} · {r.client?.name ?? r.inviteeName ?? "?"} {r.inviteeEmail && <span className="text-muted">&lt;{r.inviteeEmail}&gt;</span>}
        {r.lastError && <span className="text-danger">· {r.lastError}</span>}
      </div>
      {r.matchNote && <div className="text-muted">{r.matchNote}</div>}
      {identityOpen && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="rounded-lg border border-border bg-surface-2 px-2 py-1">
            <option value="">Pick the client…</option>
            {r.candidates.map((c) => <option key={c.clientId} value={c.clientId}>{c.name} (candidate: {c.reason})</option>)}
            {clients.filter((c) => !r.candidates.some((x) => x.clientId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="flex items-center gap-1"><input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> verify {r.inviteeEmail ?? "this address"} as their alias</label>
          <Btn busy={busy} tone="brand" onClick={() => clientId && run(() => confirmCallClient(r.id, clientId, verify))}>Confirm client</Btn>
          <Btn busy={busy} tone="danger" onClick={() => run(() => ignoreCall(r.id))}>Not a program call</Btn>
        </div>
      )}
      {!identityOpen && r.callType === "MONTHLY_STRATEGY" && (
        <div className="flex items-center gap-2">
          <span className="text-muted">plans</span>
          <input value={monthKey} onChange={(e) => setMonthKey(e.target.value)} placeholder="2026-10" className="w-20 rounded-lg border border-border bg-surface-2 px-2 py-1" />
          <Btn busy={busy} onClick={() => run(() => retargetCall(r.id, monthKey))}>Retarget</Btn>
        </div>
      )}
      {candidates.length > 0 && (
        <ul className="space-y-1">
          {candidates.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2">
              <FileText className="size-3 text-muted" />
              {t.sourceUrl ? <a className="underline" href={t.sourceUrl} target="_blank" rel="noreferrer">{t.title ?? t.id}</a> : (t.title ?? t.id)} <span className="text-muted">{fmt(t.recordedAt)}</span>
              <Btn busy={busy} tone="brand" onClick={() => run(() => confirmTranscript(t.id, r.id))}>This one</Btn>
              <Btn busy={busy} onClick={() => run(() => rejectTranscript(t.id))}>Not this</Btn>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
