"use client";

import { useState, useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Camera, Car, SlidersHorizontal, ChevronDown, AlertTriangle, Loader2, Pencil, Plus, X, RefreshCw, FileDown, RotateCcw, Search, Receipt,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { usd, parseMoney } from "@/lib/money";
import type { PayrollPerson, PayrollJob, PayrollDay } from "@/lib/payroll";
import { setJobOverride, addAdjustment, removeAdjustment, recomputeMileage, setMileageOverride, creativeStatementHtml, restoreJob, searchPayableProjects, addShootToPayroll } from "@/app/payouts/actions";

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
}

export function PayoutCard({ person, periodStartISO }: { person: PayrollPerson; periodStartISO: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [exporting, startExport] = useTransition();
  const refresh = () => router.refresh();

  // Open a clean, print-ready statement for the creative (no overrides/flags).
  // Window is opened synchronously on click to dodge pop-up blockers, then filled.
  function exportStatement() {
    const w = window.open("", "_blank");
    startExport(async () => {
      const r = await creativeStatementHtml(person.member.id, periodStartISO.slice(0, 10));
      if (r.ok && r.html && w) { w.document.write(r.html); w.document.close(); }
      else { w?.close(); router.refresh(); }
    });
  }

  return (
    <div className="rounded-2xl border bg-surface">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex items-center gap-3">
          <Avatar name={person.member.name} color={person.member.avatarColor} size={36} />
          <div>
            <div className="text-sm font-semibold">{person.member.name}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              {person.configured ? (
                <span>{Math.round((person.payPercent ?? 0) * 100)}% · min {usd(person.payFloor)} · ${person.mileageRate}/mi over {person.homeRadiusMi}mi</span>
              ) : (
                <Link href={`/team/${person.member.id}`} className="inline-flex items-center gap-1 text-warning hover:underline">
                  <AlertTriangle className="size-3" /> Set pay rates
                </Link>
              )}
              {person.configured && !person.hasHome && (
                <Link href={`/team/${person.member.id}`} className="inline-flex items-center gap-1 text-warning hover:underline">
                  <AlertTriangle className="size-3" /> Add home address for mileage
                </Link>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {person.issues.some((i) => i.level === "warn") && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-1 text-[11px] font-medium text-warning">
              <AlertTriangle className="size-3" /> {person.issues.filter((i) => i.level === "warn").length} to review
            </span>
          )}
          <div className="text-right">
            <div className="text-[11px] text-muted">Period total</div>
            <div className="text-xl font-semibold text-success">{usd(person.total)}</div>
          </div>
          <button
            onClick={exportStatement}
            disabled={exporting}
            title="Export a clean statement for the creative"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-60"
          >
            {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />} Statement
          </button>
        </div>
      </div>

      {/* Discrepancies / issues */}
      {person.issues.length > 0 && (
        <div className="space-y-1.5 border-t border-border px-5 py-3">
          {person.issues.map((iss, i) => (
            <div key={i} className={`flex items-start gap-1.5 text-xs ${iss.level === "warn" ? "text-warning" : "text-muted"}`}>
              <AlertTriangle className={`mt-0.5 size-3.5 shrink-0 ${iss.level === "warn" ? "" : "text-muted-2"}`} />
              {iss.projectId ? (
                <Link href={`/projects/${iss.projectId}`} className="hover:underline">{iss.message}</Link>
              ) : (
                <span>{iss.message}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Breakdown chips */}
      <div className="flex flex-wrap gap-2 px-5 py-3 text-xs">
        {/* Total eligible invoices their % is computed from (return-trip legs
            count $0 — those pay a flat rate, not a share of the invoice). */}
        <Chip icon={<Receipt className="size-3.5" />} label="Invoices" value={usd(person.jobs.reduce((s, j) => s + j.invoice, 0))} />
        <Chip icon={<Camera className="size-3.5" />} label="Shoot pay" value={usd(person.shootPayTotal)} />
        <Chip icon={<Car className="size-3.5" />} label="Mileage" value={usd(person.mileageTotal)} />
        <Chip icon={<SlidersHorizontal className="size-3.5" />} label="Adjustments" value={usd(person.adjustmentTotal)} />
      </div>

      {/* Jobs */}
      <details className="border-t border-border px-5 py-3" open>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-brand">
          <ChevronDown className="size-3.5" /> Shoots ({person.jobs.length})
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-2">
                <th className="py-1 pr-2 font-medium">Date</th>
                <th className="py-1 pr-2 font-medium">Property</th>
                <th className="py-1 pr-2 text-right font-medium">Invoice</th>
                <th className="py-1 pr-2 text-right font-medium">Shoot</th>
                <th className="py-1 pr-2 text-right font-medium">Mileage</th>
                <th className="py-1 pr-2 text-right font-medium">Total</th>
                <th className="py-1 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {person.jobs.map((j) => (
                <JobRow key={j.projectId} job={j} memberId={person.member.id} busy={busy} run={(fn) => start(async () => { await fn(); refresh(); })} />
              ))}
              {person.jobs.length === 0 && (
                <tr><td colSpan={7} className="py-3 text-center text-xs text-muted">No shoots this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </details>

      {/* Add a shoot (by address → pulls the order) */}
      <div className="border-t border-border px-5 py-2.5">
        <AddShoot memberId={person.member.id} busy={busy} run={(fn) => start(async () => { await fn(); refresh(); })} />
      </div>

      {/* Removed shoots — restore anything taken out of the payout */}
      {person.removedJobs.length > 0 && (
        <details className="border-t border-border px-5 py-3">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted">
            <ChevronDown className="size-3.5" /> Removed shoots ({person.removedJobs.length})
          </summary>
          <div className="mt-2 space-y-1.5">
            {person.removedJobs.map((j) => (
              <div key={j.projectId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <Link href={`/projects/${j.projectId}`} className="text-muted line-through hover:text-brand">{j.title.split(",")[0]}</Link>
                  <span className="ml-1 text-[11px] text-muted-2">· {fmtDay(j.shootISO)}</span>
                </span>
                <button
                  onClick={() => start(async () => { await restoreJob(j.projectId, person.member.id); refresh(); })}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium hover:bg-surface-2 disabled:opacity-60"
                >
                  <RotateCcw className="size-3" /> Restore
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Daily mileage */}
      {person.days.length > 0 && (
        <details className="border-t border-border px-5 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-brand">
            <span className="inline-flex items-center gap-1.5"><ChevronDown className="size-3.5" /> Daily mileage</span>
            <button
              onClick={(e) => { e.preventDefault(); start(async () => { await recomputeMileage(person.member.id); refresh(); }); }}
              className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Recompute
            </button>
          </summary>
          <div className="mt-2 space-y-1">
            {person.days.map((d) => (
              <MileageDayRow
                key={d.dayKey}
                day={d}
                memberId={person.member.id}
                busy={busy}
                run={(fn) => start(async () => { await fn(); refresh(); })}
              />
            ))}
          </div>
        </details>
      )}

      {/* Adjustments */}
      <details className="border-t border-border px-5 py-3">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-brand">
          <ChevronDown className="size-3.5" /> Manual adjustments ({person.adjustments.length})
        </summary>
        <div className="mt-2 space-y-1.5">
          {person.adjustments.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{a.label} <span className="text-[11px] text-muted-2">· {fmtDay(a.dateISO)}</span></span>
              <span className={a.amount < 0 ? "text-danger" : "text-success"}>{a.amount < 0 ? "−" : "+"}{usd(Math.abs(a.amount))}</span>
              <button onClick={() => start(async () => { await removeAdjustment(a.id); refresh(); })} className="text-muted-2 hover:text-danger"><X className="size-3.5" /></button>
            </div>
          ))}
          <AdjustmentForm memberId={person.member.id} defaultDateISO={periodStartISO} busy={busy} run={(fn) => start(async () => { await fn(); refresh(); })} />
        </div>
      </details>
    </div>
  );
}

function Chip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1">
      <span className="text-muted-2">{icon}</span>
      <span className="text-muted">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

function JobRow({ job, memberId, busy, run }: { job: PayrollJob; memberId: string; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [invoice, setInvoice] = useState(job.override?.invoiceOverride != null ? String(job.override.invoiceOverride) : "");
  const [flat, setFlat] = useState(job.override?.flatAmount != null ? String(job.override.flatAmount) : "");
  const [noMileage, setNoMileage] = useState(!!job.override?.noMileage);
  const [excluded, setExcluded] = useState(!!job.override?.excluded);
  const [note, setNote] = useState(job.override?.note ?? "");

  const save = () =>
    run(() => setJobOverride(job.projectId, memberId, {
      // parseMoney tolerates "$1,200" / "1,200" — a bare Number() would make those
      // NaN and the server would then wipe the override instead of setting it.
      invoiceOverride: parseMoney(invoice),
      flatAmount: parseMoney(flat),
      noMileage, excluded, note: note.trim() || null,
    }));
  const clear = () => run(() => setJobOverride(job.projectId, memberId, {}));

  return (
    <>
      <tr className="border-t border-border/60">
        <td className="py-1.5 pr-2 text-muted whitespace-nowrap">{fmtDay(job.shootISO)}</td>
        <td className="py-1.5 pr-2"><Link href={`/projects/${job.projectId}`} className="hover:text-brand">{job.title.split(",")[0]}</Link>{job.override && <span className="ml-1 rounded bg-warning/15 px-1 text-[10px] font-medium text-warning">override</span>}</td>
        <td className="py-1.5 pr-2 text-right text-muted-2">{usd(job.invoice)}{job.invoiceOverridden ? <span title="invoice manually set" className="text-warning">†</span> : job.invoiceIsFallback ? "*" : ""}</td>
        <td className="py-1.5 pr-2 text-right">{usd(job.shootPay)}</td>
        <td className="py-1.5 pr-2 text-right text-muted-2">{job.override?.noMileage ? "—" : usd(job.mileageShare)}</td>
        <td className="py-1.5 pr-2 text-right font-semibold">{usd(job.jobTotal)}</td>
        <td className="py-1.5 text-right"><button onClick={() => setOpen((o) => !o)} className="text-[11px] text-muted hover:text-foreground">{open ? "Close" : "Edit"}</button></td>
      </tr>
      {open && (
        <tr className="bg-surface-2/40">
          <td colSpan={7} className="px-2 py-3">
            {job.returnTrip && (
              <div className="mb-2 rounded-md bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                Return/second trip — pays the flat minimum by default. Set an <span className="font-semibold">Invoice total</span> here to pay their % of that amount instead (e.g. a split-invoice job), or hard-set the pay with <span className="font-semibold">Flat shoot pay</span>.
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3 text-xs">
              <label className="flex flex-col gap-1">
                <span className="text-muted-2">Invoice total ($)</span>
                <input value={invoice} onChange={(e) => setInvoice(e.target.value)} inputMode="decimal" placeholder="auto" className="w-24 rounded-lg border bg-surface px-2 py-1" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-2">Flat shoot pay ($)</span>
                <input value={flat} onChange={(e) => setFlat(e.target.value)} inputMode="decimal" placeholder="auto" className="w-24 rounded-lg border bg-surface px-2 py-1" />
              </label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={noMileage} onChange={(e) => setNoMileage(e.target.checked)} /> No mileage</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} /> Exclude job</label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-muted-2">Note</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. partial completion" className="w-full rounded-lg border bg-surface px-2 py-1" />
              </label>
              <button onClick={save} disabled={busy} className="rounded-lg bg-brand px-2.5 py-1 font-medium text-white disabled:opacity-60">Save</button>
              {job.override && <button onClick={clear} disabled={busy} className="rounded-lg border px-2.5 py-1 text-muted hover:text-foreground">Clear</button>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AdjustmentForm({ memberId, defaultDateISO, busy, run }: { memberId: string; defaultDateISO: string; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(defaultDateISO.slice(0, 10));
  const add = () => {
    const amt = parseMoney(amount);
    if (!label.trim() || amt == null || amt === 0) return;
    run(() => addAdjustment(memberId, label.trim(), amt, new Date(date + "T12:00:00").toISOString()));
    setLabel(""); setAmount("");
  };
  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2 text-xs">
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bonus / camera payback…" className="flex-1 rounded-lg border bg-surface px-2 py-1.5" />
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="± $" className="w-20 rounded-lg border bg-surface px-2 py-1.5" />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border bg-surface px-2 py-1.5" />
      <button onClick={add} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 font-medium text-white disabled:opacity-60"><Plus className="size-3.5" /> Add</button>
    </div>
  );
}

// Add a shoot to this creative's payout by typing the address — searches synced
// Aryeo orders and pulls the invoice. Pays them full (tune with the row's Edit).
function AddShoot({ memberId, busy, run }: { memberId: string; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; title: string; invoice: number; dateISO: string | null; photographer: string | null }[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 3) { setResults([]); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const h = setTimeout(async () => {
      const r = await searchPayableProjects(query);
      if (alive) { setResults(r); setSearching(false); }
    }, 300);
    return () => { alive = false; clearTimeout(h); };
  }, [q, open]);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline">
        <Plus className="size-3.5" /> Add a shoot
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5">
          <Search className="size-3.5 text-muted-2" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type the address — pulls the order…" className="flex-1 bg-transparent text-sm outline-none" />
          {searching && <Loader2 className="size-3.5 animate-spin text-muted-2" />}
        </div>
        <button onClick={() => { setOpen(false); setQ(""); setResults([]); }} className="rounded-lg border border-border px-2 py-1.5 text-muted hover:bg-surface-2"><X className="size-3.5" /></button>
      </div>
      {q.trim().length >= 3 && (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-surface-2/40 p-1">
          {results.length === 0 && !searching && <div className="px-2 py-2 text-xs text-muted">No matching orders.</div>}
          {results.map((r) => (
            <button
              key={r.id}
              disabled={busy}
              onClick={() => run(async () => { await addShootToPayroll(r.id, memberId); setOpen(false); setQ(""); setResults([]); })}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface disabled:opacity-60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{r.title.split(",")[0]}</span>
                <span className="text-[11px] text-muted-2">{r.photographer ? `${r.photographer} · ` : ""}{r.dateISO ? fmtDay(r.dateISO) : "no date"}</span>
              </span>
              <span className="whitespace-nowrap text-xs font-medium text-muted">{usd(r.invoice)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// One day in the mileage breakdown — with Jordan's inline correction. The
// computed (routed) figure stays visible under an override so "adjusted from
// what" is never a mystery, and Reset returns the day to fully automatic.
function MileageDayRow({ day: d, memberId, busy, run }: {
  day: PayrollDay; memberId: string; busy: boolean; run: (fn: () => Promise<unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [miles, setMiles] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const adjusted = d.overrideMiles != null;
  const orphan = adjusted && d.jobs === 0; // adjustment survives, but no shoots pay out of this day
  const dayLabel = new Date(d.dayKey + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const beginEdit = () => {
    if (busy) return; // a Recompute/refresh is in flight — don't capture a stale prefill
    // Prefill with the figure being edited — the override when one exists
    // (0 is a real value: "carpooled, no drive"), else the computed miles.
    setMiles(String(adjusted ? d.overrideMiles : d.miles));
    setNote(d.overrideNote ?? "");
    setErr(null);
    setEditing(true);
  };
  const save = () => {
    if (busy) return;
    if (miles.trim() === "") {
      setErr("Enter the miles — or use the reset arrow to go back to automatic.");
      return;
    }
    setErr(null);
    // Editor stays open until the server confirms — a rejected value must
    // never look saved.
    run(() =>
      setMileageOverride(memberId, d.dayKey, miles, note).then((r) => {
        if (r.ok) setEditing(false);
        else setErr(r.message);
      }),
    );
  };

  if (editing) {
    return (
      <div className="rounded-lg bg-surface-2/60 px-2 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">{dayLabel}</span>
          <input
            type="number" inputMode="decimal" min={0} step={0.1} value={miles} autoFocus
            onChange={(e) => setMiles(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
            className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-xs"
            placeholder="miles" aria-label="Miles driven that day"
          />
          <span className="text-muted-2">mi</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs"
            placeholder="why? (optional — e.g. detour on Rt 30)" aria-label="Reason for the adjustment"
          />
          <button onClick={save} disabled={busy} className="rounded-md bg-brand px-2 py-1 font-semibold text-white disabled:opacity-50">
            {busy ? <Loader2 className="size-3 animate-spin" /> : "Save"}
          </button>
          <button onClick={() => setEditing(false)} aria-label="Cancel" className="text-muted-2 hover:text-foreground"><X className="size-3.5" /></button>
        </div>
        {err && <p className="mt-1 font-medium text-danger">{err}</p>}
      </div>
    );
  }

  return (
    <div className="group text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted">{dayLabel}</span>
        <span className="min-w-0 flex-1 text-right text-muted-2">
          {adjusted && (
            <span
              title={`${d.overrideNote ? `${d.overrideNote} · ` : ""}router said ${d.computedMiles.toFixed(1)} mi`}
              className="mr-1.5 rounded bg-warning/10 px-1 py-0.5 text-[10px] font-semibold text-warning"
            >
              adjusted · was {d.computedMiles.toFixed(1)}
            </span>
          )}
          {orphan ? (
            <span className="text-warning">{d.miles.toFixed(1)} mi — no shoots this day anymore; pays nothing</span>
          ) : (
            <>
              {d.miles.toFixed(1)} mi − {d.freeMiles} free = <span className="text-foreground">{d.payableMiles.toFixed(1)} paid</span> · {d.jobs} job{d.jobs === 1 ? "" : "s"}
            </>
          )}
        </span>
        <span className="font-medium">{usd(d.mileagePay)}</span>
        <span className="flex shrink-0 items-center gap-1">
          <button onClick={beginEdit} aria-label={`Adjust miles for ${dayLabel}`} title="Adjust this day's miles" className="text-muted-2 opacity-60 transition-opacity hover:text-foreground group-hover:opacity-100">
            <Pencil className="size-3" />
          </button>
          {adjusted && (
            <button
              onClick={() => run(() => setMileageOverride(memberId, d.dayKey, null))}
              disabled={busy}
              aria-label={`Reset ${dayLabel} to computed mileage`}
              title="Back to the computed figure"
              className="text-muted-2 opacity-60 transition-opacity hover:text-danger group-hover:opacity-100"
            >
              <RotateCcw className="size-3" />
            </button>
          )}
        </span>
      </div>
      {adjusted && d.overrideNote && (
        <p className="pl-2 text-right text-[10px] italic text-muted-2">“{d.overrideNote}”</p>
      )}
    </div>
  );
}
