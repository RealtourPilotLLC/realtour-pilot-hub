"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, Loader2 } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { addEntitlementAction, changeEntitlementAction, setTermAction } from "@/app/clients/clientCareActions";
import { ENTITLEMENT_KINDS, ENTITLEMENT_LABEL, STATE_LABEL, monthName, type EntitlementKind } from "@/lib/entitlementsCore";
import type { EntitlementSummary } from "@/lib/entitlements";

// ---------------------------------------------------------------------------
// WHAT THIS CLIENT IS OWED (Oct 15 2026): the agreement's term with any extra
// months, the sessions used, missed, postponed and still to film, and every
// promise beyond the package (an extra month, a carried month, an extra
// video, a credit, a refund that was NOT agreed). A record of agreements;
// nothing here charges or books anything. Mountable wherever a program client
// is shown: it needs the enrollment id and entitlements.entitlementSummary().
// ---------------------------------------------------------------------------

const SOURCES = [["call", "On a call"], ["text", "By text"], ["email", "By email"], ["portal", "In the portal"], ["staff", "Office decision"]] as const;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");

export function EntitlementsCard({ summary, canEdit }: { summary: EntitlementSummary; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [termStart, setTermStart] = useState(summary.term.start ?? "");
  const [termEnd, setTermEnd] = useState(summary.term.signedEnd ?? "");
  const [kind, setKind] = useState<EntitlementKind>("EXTENSION_MONTH");
  const [qty, setQty] = useState("1");
  const [monthKey, setMonthKey] = useState("");
  const [targetMonthKey, setTargetMonthKey] = useState("");
  const [description, setDescription] = useState("");
  const [agreedBy, setAgreedBy] = useState("");
  const [source, setSource] = useState("call");
  const [undoWhy, setUndoWhy] = useState<Record<string, string>>({});

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, after?: () => void) =>
    start(async () => {
      setMsg(null);
      const r = await fn().catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) { after?.(); router.refresh(); }
    });

  const t = summary.term;
  const s = summary.sessions;
  const live = summary.rows.filter((r) => r.state !== "VOID");
  const added = t.extensions + t.carried;

  return (
    <Section icon={CalendarRange} title="What they're owed" count={summary.owed.length ? `${summary.owed.length} owed` : null} tone={summary.owed.length ? "warning" : "default"}>
      <div className="space-y-4 text-sm" data-entitlements>
        {/* THE TERM */}
        <div>
          <p className="font-medium">
            {t.start && t.end ? <>Term: {monthName(t.start)} to {monthName(t.end)}</> : t.start ? <>Started {monthName(t.start)}, end not on file</> : <>Term not on file</>}
          </p>
          {added > 0 && t.signedEnd && (
            <p className="text-xs text-muted">Signed to end {monthName(t.signedEnd)}, plus {t.extensions ? `${t.extensions} extra month${t.extensions === 1 ? "" : "s"}` : ""}{t.extensions && t.carried ? " and " : ""}{t.carried ? `${t.carried} carried month${t.carried === 1 ? "" : "s"}` : ""}.</p>
          )}
          <p className="text-[11px] text-muted-2">{t.basis}</p>
          {canEdit && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">Signed start<input type="month" value={termStart} onChange={(e) => setTermStart(e.target.value)} disabled={pending} className="mt-0.5 block rounded-md border border-border bg-surface px-2 py-1" /></label>
              <label className="text-xs text-muted">Signed end<input type="month" value={termEnd} onChange={(e) => setTermEnd(e.target.value)} disabled={pending} className="mt-0.5 block rounded-md border border-border bg-surface px-2 py-1" /></label>
              <button type="button" disabled={pending} onClick={() => run(() => setTermAction({ enrollmentId: summary.enrollmentId, termStartMonth: termStart || null, termEndMonth: termEnd || null }))} className="min-h-11 rounded-lg border border-border px-3 text-sm font-medium">Save term</button>
            </div>
          )}
        </div>

        {/* SESSIONS */}
        {s && (
          <div>
            <p className="font-medium">Sessions</p>
            <dl className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[["Used", s.used], ["Missed", s.missed], ["Postponed", s.postponed], ["Still to film", s.available]].map(([label, n]) => (
                <div key={label as string} className="rounded-lg bg-surface-2 px-2.5 py-1.5"><dt className="text-[11px] text-muted">{label}</dt><dd className="text-base font-semibold tabular-nums">{n}</dd></div>
              ))}
            </dl>
            {s.perMonth.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-brand">Month by month</summary>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {s.perMonth.map((m) => <li key={m.monthKey}>{m.label}: {m.held} of {m.required} held · {m.state}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* OWED */}
        <div>
          <p className="font-medium">Promised beyond the package</p>
          {live.length === 0 ? <p className="text-xs text-muted-2">Nothing recorded.</p> : (
            <ul className="mt-1 space-y-1.5">
              {live.map((r) => (
                <li key={r.id} className={cn("rounded-lg border px-2.5 py-1.5", r.state === "OPEN" || r.state === "SCHEDULED" ? "border-warning/40 bg-warning-soft/30" : "border-border")} data-entitlement={r.kind}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{r.label}{r.qty > 1 ? ` × ${r.qty}` : ""}</span>
                    <span className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">{STATE_LABEL[r.state]}</span>
                    {(r.monthKey || r.targetMonthKey) && <span className="text-[11px] text-muted">{r.monthKey ? monthName(r.monthKey) : ""}{r.targetMonthKey ? ` → ${monthName(r.targetMonthKey)}` : ""}</span>}
                  </div>
                  <p className="text-foreground/90">{r.description}</p>
                  <p className="text-[11px] text-muted-2">Agreed {day(r.agreedAtISO)}{r.agreedBy ? ` by ${r.agreedBy}` : ""} · {SOURCES.find(([k]) => k === r.source)?.[1] ?? r.source}{r.fulfilledRef ? ` · ${r.fulfilledRef}` : ""}</p>
                  {canEdit && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {r.state === "OPEN" && <button type="button" disabled={pending} onClick={() => run(() => changeEntitlementAction({ id: r.id, to: "SCHEDULED" }))} className="min-h-9 rounded-md border border-border px-2 text-xs">Scheduled</button>}
                      {(r.state === "OPEN" || r.state === "SCHEDULED") && <button type="button" disabled={pending} onClick={() => run(() => changeEntitlementAction({ id: r.id, to: "FULFILLED" }))} className="min-h-9 rounded-md border border-success/40 px-2 text-xs text-success">Done</button>}
                      {r.state === "FULFILLED" && <button type="button" disabled={pending} onClick={() => run(() => changeEntitlementAction({ id: r.id, to: "OPEN" }))} className="min-h-9 rounded-md border border-border px-2 text-xs">Back to owed</button>}
                      <input value={undoWhy[r.id] ?? ""} onChange={(e) => setUndoWhy((u) => ({ ...u, [r.id]: e.target.value }))} placeholder="Why undo" className="min-h-9 w-32 rounded-md border border-border bg-surface px-2 text-xs" />
                      <button type="button" disabled={pending || (undoWhy[r.id] ?? "").trim().length < 3} onClick={() => run(() => changeEntitlementAction({ id: r.id, to: "VOID", note: undoWhy[r.id] }))} className="min-h-9 rounded-md border border-border px-2 text-xs text-muted disabled:opacity-50">Undo</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {summary.rows.some((r) => r.state === "VOID") && (
            <details className="mt-1"><summary className="cursor-pointer text-xs text-muted">Undone entries</summary>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">{summary.rows.filter((r) => r.state === "VOID").map((r) => <li key={r.id}>{r.label}: {r.description} (undone: {r.voidReason})</li>)}</ul>
            </details>
          )}
        </div>

        {/* ADD */}
        {canEdit && (
          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Record an agreement</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted">What was agreed
                <select value={kind} onChange={(e) => setKind(e.target.value as EntitlementKind)} disabled={pending} className="mt-0.5 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm">
                  {ENTITLEMENT_KINDS.map((k) => <option key={k} value={k}>{ENTITLEMENT_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="text-xs text-muted">How many<input type="number" min={1} max={24} value={qty} onChange={(e) => setQty(e.target.value)} disabled={pending} className="mt-0.5 block w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" /></label>
              <label className="text-xs text-muted">About which month (optional)<input type="month" value={monthKey} onChange={(e) => setMonthKey(e.target.value)} disabled={pending} className="mt-0.5 block rounded-md border border-border bg-surface px-2 py-1.5 text-sm" /></label>
              <label className="text-xs text-muted">Lands in (optional)<input type="month" value={targetMonthKey} onChange={(e) => setTargetMonthKey(e.target.value)} disabled={pending} className="mt-0.5 block rounded-md border border-border bg-surface px-2 py-1.5 text-sm" /></label>
              <label className="text-xs text-muted sm:col-span-2">In plain words<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} disabled={pending} placeholder="One extra month at the end of the term for the July session" className="mt-0.5 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" /></label>
              <label className="text-xs text-muted">Agreed by<input value={agreedBy} onChange={(e) => setAgreedBy(e.target.value)} disabled={pending} placeholder="Jordan" className="mt-0.5 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" /></label>
              <label className="text-xs text-muted">Where
                <select value={source} onChange={(e) => setSource(e.target.value)} disabled={pending} className="mt-0.5 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm">
                  {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
            </div>
            <button
              type="button"
              disabled={pending || description.trim().length < 3}
              onClick={() => run(() => addEntitlementAction({ enrollmentId: summary.enrollmentId, kind, qty: Number(qty) || 1, monthKey: monthKey || null, targetMonthKey: targetMonthKey || null, description, agreedBy: agreedBy || null, source }), () => { setDescription(""); setMonthKey(""); setTargetMonthKey(""); setQty("1"); })}
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending && <Loader2 className="size-4 animate-spin" />} Record it
            </button>
          </details>
        )}
        {msg && <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
      </div>
    </Section>
  );
}
