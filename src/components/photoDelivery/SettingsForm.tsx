"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { saveSettingsAction } from "@/app/ops/photo-delivery/actions";

// ---------------------------------------------------------------------------
// Photo Delivery switches and thresholds (plan 14), owner only, every field
// with a plain-English line. Everything that can spend money or reach a
// client defaults OFF (lib/photoDelivery/settings.ts). The server action
// validates each value again.
// ---------------------------------------------------------------------------

export type SettingsValues = {
  enabled: boolean;
  qcEnabled: boolean;
  qcShadow: boolean;
  fixRunnerEnabled: boolean;
  maxBuildPhase: 1 | 2 | 3;
  autoFixZeroCredit: boolean;
  adminCreditCap: number;
  dailyAutoCreditCap: number;
  aryeoTags: boolean;
  p3AllPhotos: boolean;
  displayConfidenceFloor: number;
  maskPaddingPct: number;
  maskPaddingMinPx: number;
  minLongEdgePx: number;
  /** ET day key (YYYY-MM-DD) or "" */
  qcFromDay: string;
  monthlyQcBudgetUsd: number;
  autoSubmit: boolean;
  freeCheck: boolean;
  paidQcAuto: boolean;
};

const SWITCHES: { key: keyof SettingsValues; label: string; help: string }[] = [
  { key: "enabled", label: "Track photo jobs", help: "Opens a job for every photo shoot and follows its gallery until delivery. Reads Aryeo and Dropbox only; writes nothing outside the hub." },
  { key: "autoSubmit", label: "Send uploads to AutoHDR", help: "When a photographer's upload is finished (and when files are added later), the hub sends the raws to AutoHDR with your account's default look. Editing is free; a credit per photo comes off at the first download, as always. Kyle is told, so nobody adds the folder by hand too." },
  { key: "freeCheck", label: "Free photo check", help: "Asks AutoHDR's free describe tool to check every edited photo against the checklist (bins, hoses, toilet seats, reflections, crooked lines and more). No credits, no Claude cost." },
  { key: "qcEnabled", label: "Paid QC available", help: "The Claude QC (measured checks plus Claude vision, about $3 to $4 a shoot, never AutoHDR credits). Whether it starts by itself is the switch below." },
  { key: "paidQcAuto", label: "Run the paid QC by itself", help: "Off: the Claude QC only runs when someone presses Run QC on a job. On: it inspects every gallery as it lands, about $3 to $4 a shoot." },
  { key: "qcShadow", label: "Shadow mode", help: "QC results are advisory: nothing is held or blocked by them, and Kyle keeps his manual check. Leave on until the checks have proven themselves." },
  { key: "fixRunnerEnabled", label: "Run approved AutoHDR fixes", help: "Off until you have approved the first live test. While off, the Fix Cart cannot start a batch and nothing is sent to AutoHDR." },
  { key: "autoFixZeroCredit", label: "Auto-run fixes that cost no credits", help: "Off by default. When on, a fix AutoHDR prices at zero runs without a click, only on non-critical findings at 90% confidence or more. Everything else waits for a click." },
  { key: "aryeoTags", label: "Mirror status into Aryeo", help: "Off: Aryeo order tags and internal notes stay untouched until you switch this on." },
  { key: "p3AllPhotos", label: "Compare every photo with its original", help: "Runs the original vs edited check on every photo instead of only the risky ones (kitchens, exteriors, fixed photos). More thorough, costs more." },
];

const input = "min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-brand";

function NumberField({ id, label, help, value, onChange, min, max, step = 1, suffix }: { id: string; label: string; help: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input id={id} type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} className={input} aria-describedby={`${id}-help`} />
        {suffix && <span className="shrink-0 text-sm text-muted">{suffix}</span>}
      </div>
      <p id={`${id}-help`} className="mt-1 text-[12px] text-muted">{help}</p>
    </div>
  );
}

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const [v, setV] = useState<SettingsValues>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof SettingsValues>(k: K, val: SettingsValues[K]) => setV((cur) => ({ ...cur, [k]: val }));
  const save = () =>
    start(async () => {
      try {
        const r = await saveSettingsAction({
          enabled: v.enabled,
          qcEnabled: v.qcEnabled,
          qcShadow: v.qcShadow,
          fixRunnerEnabled: v.fixRunnerEnabled,
          autoSubmit: v.autoSubmit,
          freeCheck: v.freeCheck,
          paidQcAuto: v.paidQcAuto,
          maxBuildPhase: v.maxBuildPhase,
          autoFixZeroCredit: v.autoFixZeroCredit,
          adminCreditCap: v.adminCreditCap,
          dailyAutoCreditCap: v.dailyAutoCreditCap,
          aryeoTags: v.aryeoTags,
          p3AllPhotos: v.p3AllPhotos,
          displayConfidenceFloor: Math.round(v.displayConfidenceFloor) / 100,
          maskPaddingPct: v.maskPaddingPct,
          maskPaddingMinPx: v.maskPaddingMinPx,
          minLongEdgePx: v.minLongEdgePx,
          qcFrom: v.qcFromDay || null,
          monthlyQcBudgetUsd: v.monthlyQcBudgetUsd,
        });
        setMsg({ ok: r.ok, text: r.message });
      } catch {
        setMsg({ ok: false, text: "The hub didn't answer. Reload to see what is saved." });
      }
    });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-6"
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Switches</legend>
        {SWITCHES.map((s) => (
          <label key={s.key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-surface-2/40">
            <input type="checkbox" checked={v[s.key] as boolean} onChange={(e) => set(s.key, e.target.checked as never)} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
            <span>
              <span className="block text-sm font-medium">{s.label}</span>
              <span className="block text-[13px] text-muted">{s.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">QC</legend>
        <div>
          <label htmlFor="pd-phase" className="text-sm font-medium">Build phase</label>
          <select id="pd-phase" value={v.maxBuildPhase} onChange={(e) => set("maxBuildPhase", Number(e.target.value) as 1 | 2 | 3)} className={input} aria-describedby="pd-phase-help">
            <option value={1}>1: the checklist&rsquo;s priority checks</option>
            <option value={2}>2: plus the second tier</option>
            <option value={3}>3: every rule</option>
          </select>
          <p id="pd-phase-help" className="mt-1 text-[12px] text-muted">Which QC rules run. Rules that can be critical (privacy, wrong property, damaged files) always run.</p>
        </div>
        <NumberField id="pd-floor" label="Confidence floor" suffix="%" help="Findings below this go in a collapsed Low confidence drawer and never block delivery." value={v.displayConfidenceFloor} onChange={(n) => set("displayConfidenceFloor", n)} min={0} max={100} />
        <NumberField id="pd-edge" label="Minimum long edge" suffix="px" help="A photo smaller than this fails the delivery file check." value={v.minLongEdgePx} onChange={(n) => set("minLongEdgePx", n)} min={300} max={20000} />
        <div>
          <label htmlFor="pd-from" className="text-sm font-medium">QC start date</label>
          <input id="pd-from" type="date" value={v.qcFromDay} onChange={(e) => set("qcFromDay", e.target.value)} className={input} aria-describedby="pd-from-help" />
          <p id="pd-from-help" className="mt-1 text-[12px] text-muted">Only galleries that landed on or after this day (Eastern) are checked. Blank: since the feature started.</p>
        </div>
        <NumberField id="pd-budget" label="Monthly QC budget" suffix="USD" help="QC pauses, and you are alerted, once the month's Anthropic spend passes this." value={v.monthlyQcBudgetUsd} onChange={(n) => set("monthlyQcBudgetUsd", n)} min={0} max={100000} step={1} />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Fixes</legend>
        <NumberField id="pd-cap" label="Kyle's approval limit" suffix="credits per batch" help="Kyle can approve a fix batch up to this many credits; above it, you approve." value={v.adminCreditCap} onChange={(n) => set("adminCreditCap", n)} min={0} max={10000} />
        <NumberField id="pd-daily" label="Daily automatic credit limit" suffix="credits" help="The most credits automatic fixes may spend in a day. 0 means nothing automatic spends credits." value={v.dailyAutoCreditCap} onChange={(n) => set("dailyAutoCreditCap", n)} min={0} max={10000} />
        <NumberField id="pd-mpct" label="Mask padding" suffix="% of the box" help="How much room around each issue box an AutoRemove mask gets." value={v.maskPaddingPct} onChange={(n) => set("maskPaddingPct", n)} min={0} max={100} step={0.5} />
        <NumberField id="pd-mpx" label="Minimum mask padding" suffix="px" help="Never less than this many pixels around a box." value={v.maskPaddingMinPx} onChange={(n) => set("maskPaddingMinPx", n)} min={0} max={500} />
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:opacity-50">
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden className="size-4" />} Save settings
        </button>
        <p role="status" className={`text-[13px] ${msg ? (msg.ok ? "text-success" : "text-warning") : ""}`}>{msg?.text ?? ""}</p>
      </div>
    </form>
  );
}
