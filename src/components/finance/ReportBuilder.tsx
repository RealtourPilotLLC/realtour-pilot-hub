"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Trash2 } from "lucide-react";
import { generateReportAction, deleteReportAction } from "@/app/sales/advisorActions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

type SavedReport = { id: string; title: string; startKey: string; endKey: string; createdAt: string };

const TYPES = [
  { key: "pnl", label: "Profit & Loss statement" },
  { key: "monthly", label: "Monthly summary" },
  { key: "spending", label: "Spending & categories" },
  { key: "people", label: "Contractor & people pay" },
  { key: "personal", label: "Personal spending" },
  { key: "custom", label: "Custom (describe it below)" },
];

function ranges(): { label: string; start: string; end: string }[] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const today = now.toISOString().slice(0, 10);
  const mStart = `${today.slice(0, 7)}-01`;
  const lm = new Date(Date.UTC(y, now.getUTCMonth() - 1, 1));
  const lmEnd = new Date(Date.UTC(y, now.getUTCMonth(), 0));
  return [
    { label: "Year to date", start: `${y}-01-01`, end: today },
    { label: "This month", start: mStart, end: today },
    { label: "Last month", start: lm.toISOString().slice(0, 10), end: lmEnd.toISOString().slice(0, 10) },
    { label: "Q2 (Apr–Jun)", start: `${y}-04-01`, end: `${y}-06-30` },
    { label: "Custom dates", start: "", end: "" },
  ];
}

export function ReportBuilder({ reports }: { reports: SavedReport[] }) {
  const router = useRouter();
  const R = ranges();
  const [type, setType] = useState("pnl");
  const [range, setRange] = useState(0);
  const [start, setStart] = useState(R[0].start);
  const [end, setEnd] = useState(R[0].end);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickRange = (i: number) => {
    setRange(i);
    if (R[i].start) { setStart(R[i].start); setEnd(R[i].end); }
  };

  const go = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await generateReportAction(type, start, end, type === "custom" ? custom : custom || undefined);
      if (r.id) router.push(`/sales/report/${r.id}`);
      else setErr(r.error ?? "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface">
      <div className="border-b border-border px-5 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4 text-brand" /> Create a report</span>
        <p className="mt-0.5 text-[11px] text-muted-2">A formal statement built from your live books — opens as a clean document you can download as a PDF.</p>
      </div>
      <div className="space-y-3 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted">Report type</span>
            <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-brand">
              {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-muted">Period</span>
            <select value={range} onChange={(e) => pickRange(Number(e.target.value))} className="w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-brand">
              {R.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
            </select>
          </label>
        </div>
        {!R[range].start && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 outline-none focus:border-brand" />
            <span className="text-muted-2">to</span>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 outline-none focus:border-brand" />
          </div>
        )}
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-muted">{type === "custom" ? "Describe the report you want" : "Extra instructions (optional)"}</span>
          <AutoTextarea value={custom} onChange={(e) => setCustom(e.target.value)} minRows={2}
            placeholder={type === "custom" ? "e.g. Compare Q1 vs Q2 revenue and payroll, and tell me if my margin is improving" : "e.g. focus on editing costs"}
            className="w-full rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-brand" />
        </label>
        <button onClick={go} disabled={busy || (type === "custom" && !custom.trim())} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          {busy ? <><Loader2 className="size-4 animate-spin" /> building your statement…</> : <>Generate report</>}
        </button>
        {err && <p className="text-xs text-danger">{err}</p>}

        {reports.length > 0 && (
          <div className="border-t border-border/60 pt-3">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-2">Saved reports</p>
            <div className="space-y-1">
              {reports.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-sm">
                  <a href={`/sales/report/${r.id}`} className="min-w-0 flex-1 truncate text-brand hover:underline">{r.title}</a>
                  <span className="shrink-0 text-[11px] text-muted-2">{r.startKey} → {r.endKey}</span>
                  <button
                    title="Delete report"
                    onClick={async () => { await deleteReportAction(r.id); router.refresh(); }}
                    className="text-muted-2 hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
