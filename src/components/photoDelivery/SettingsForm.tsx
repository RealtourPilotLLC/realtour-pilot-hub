"use client";

import { useState, useTransition } from "react";
import { ChevronDown, Loader2, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveSettingsAction } from "@/app/ops/photo-delivery/actions";

// ---------------------------------------------------------------------------
// Photo Delivery switches and thresholds (plan 14), owner only, every field
// with one plain line. Up front: what the hub does by itself. Behind
// "Advanced": the paid QC and the delivery-check thresholds. Two pairs of
// stored switches show as one choice each (fixes: fixRunnerEnabled + autoFix;
// paid QC: qcEnabled + paidQcAuto) and Save writes both. Everything that can
// spend money or reach a client defaults OFF (lib/photoDelivery/settings.ts).
// The server action validates each value again.
// ---------------------------------------------------------------------------

export type FixesMode = "off" | "approve" | "auto";
export type PaidQcMode = "off" | "press" | "auto";
export type AryeoMode = "off" | "on";

export type SettingsValues = {
  enabled: boolean;
  autoSubmit: boolean;
  showAutohdrPhotos: boolean;
  freeCheck: boolean;
  fixes: FixesMode;
  fixTargetUsd: number;
  fixMaxUsd: number;
  autoFixDailyMaxCredits: number;
  /** The hub uploads and delivers in Aryeo once Kyle approves the job (aryeoPush.ts). */
  aryeoPush: AryeoMode;
  /** Same-day orders approve and deliver themselves when every check passes. */
  sameDayAutoDeliver: boolean;
  paidQc: PaidQcMode;
  monthlyQcBudgetUsd: number;
  maxBuildPhase: 1 | 2 | 3;
  qcShadow: boolean;
  /** ET day key (YYYY-MM-DD) or "" */
  qcFromDay: string;
  /** Percent (0 to 100). */
  displayConfidenceFloor: number;
  minLongEdgePx: number;
  adminCreditCap: number;
};

type Option<T extends string> = { value: T; label: string; help: string };

const FIXES: Option<FixesMode>[] = [
  { value: "off", label: "Off", help: "No fix runs, not even one approved in the Fix Cart." },
  { value: "approve", label: "Only when someone approves", help: "Fixes run once Kyle or you approve them in the Fix Cart." },
  { value: "auto", label: "Automatic", help: "After each check the hub picks and runs the fixes itself, within the limits below." },
];

const ARYEO_STAGES: Option<AryeoMode>[] = [
  { value: "off", label: "Off", help: "The hub never touches the Aryeo listing; Kyle uploads and delivers by hand." },
  { value: "on", label: "Kyle approves each job", help: "Jobs wait in Ready to review. Kyle reorders and checks, then presses Approve and deliver, or Approve and upload to Aryeo." },
]

const PAID_QC: Option<PaidQcMode>[] = [
  { value: "off", label: "Off", help: "No Claude QC runs; the free photo check is separate." },
  { value: "press", label: "Only when someone presses Run QC", help: "Runs on a job only when someone asks for it." },
  { value: "auto", label: "Every gallery", help: "Checks every gallery as it lands, until the monthly budget is reached." },
];

const input = "min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-brand";
const card = "flex cursor-pointer items-start gap-3 rounded-xl border p-3 hover:bg-surface-2/40";

function Switch({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={cn(card, "border-border")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-ui-status text-muted">{help}</span>
      </span>
    </label>
  );
}

function Choice<T extends string>({ name, legend, help, options, value, onChange, grid }: { name: string; legend: string; help?: string; options: Option<T>[]; value: T; onChange: (v: T) => void; grid?: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">{legend}</legend>
      {help && <p className="text-ui-status text-muted">{help}</p>}
      <div className={cn("grid gap-2", grid)}>
        {options.map((o) => (
          <label key={o.value} className={cn(card, value === o.value ? "border-brand bg-brand-soft/40" : "border-border")}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" />
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-ui-status text-muted">{o.help}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NumberField({ id, label, help, value, onChange, min, max, step = 1, suffix }: { id: string; label: string; help: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input id={id} type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} className={input} aria-describedby={`${id}-help`} />
        {suffix && <span className="shrink-0 text-sm text-muted">{suffix}</span>}
      </div>
      <p id={`${id}-help`} className="mt-1 text-ui-status text-muted">{help}</p>
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
          autoSubmit: v.autoSubmit,
          showAutohdrPhotos: v.showAutohdrPhotos,
          freeCheck: v.freeCheck,
          fixRunnerEnabled: v.fixes !== "off",
          autoFix: v.fixes === "auto",
          fixTargetUsd: v.fixTargetUsd,
          fixMaxUsd: v.fixMaxUsd,
          autoFixDailyMaxCredits: v.autoFixDailyMaxCredits,
          aryeoPush: v.aryeoPush,
          sameDayAutoDeliver: v.sameDayAutoDeliver,
          qcEnabled: v.paidQc !== "off",
          paidQcAuto: v.paidQc === "auto",
          monthlyQcBudgetUsd: v.monthlyQcBudgetUsd,
          maxBuildPhase: v.maxBuildPhase,
          qcShadow: v.qcShadow,
          qcFrom: v.qcFromDay || null,
          displayConfidenceFloor: Math.round(v.displayConfidenceFloor) / 100,
          minLongEdgePx: v.minLongEdgePx,
          adminCreditCap: v.adminCreditCap,
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
      <div className="space-y-3">
        <Switch label="Photo Delivery on" help="Opens a job for every photo shoot and follows it until delivery; the AutoHDR switches below need it on." checked={v.enabled} onChange={(on) => set("enabled", on)} />
        <Switch label="Send shoots to AutoHDR" help="The hub sends each finished upload to AutoHDR with your default look; editing is free until the photos are downloaded." checked={v.autoSubmit} onChange={(on) => set("autoSubmit", on)} />
        <Switch label="Bring the edits back into the hub" help="Downloads each finished shoot once (1 credit a photo, the same credit Aryeo charges) so it shows here; needed for the Aryeo upload." checked={v.showAutohdrPhotos} onChange={(on) => set("showAutohdrPhotos", on)} />
        <Switch label="Free photo check" help="AutoHDR's free describe tool checks every edited photo against the checklist, with no credits and no Claude cost." checked={v.freeCheck} onChange={(on) => set("freeCheck", on)} />
      </div>

      <div className="space-y-4">
        <Choice name="pd-fixes" legend="Fixes" options={FIXES} value={v.fixes} onChange={(m) => set("fixes", m)} grid="sm:grid-cols-3" />
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField id="pd-fix-target" label="Fix target per shoot" suffix="USD" help="Most shoots stay inside this, and clutter is fixed only inside it." value={v.fixTargetUsd} onChange={(n) => set("fixTargetUsd", n)} min={0} max={1000} step={0.5} />
          <NumberField id="pd-fix-max" label="Fix maximum per shoot" suffix="USD" help="Never passed; only camera, crooked-line, car and trash fixes go above the target." value={v.fixMaxUsd} onChange={(n) => set("fixMaxUsd", n)} min={0} max={1000} step={0.5} />
          <NumberField id="pd-daily" label="Daily limit on automatic fixes" suffix="credits" help="Automatic fixes on all shoots stop for the day at this many credits." value={v.autoFixDailyMaxCredits} onChange={(n) => set("autoFixDailyMaxCredits", n)} min={0} max={10000} />
        </div>
      </div>

      <div className="space-y-2">
        <Choice name="pd-aryeo-push" legend="Aryeo upload and delivery" help="Uses the hub's own Aryeo login (Connections, Aryeo hub login)." options={ARYEO_STAGES} value={v.aryeoPush} onChange={(m) => set("aryeoPush", m)} grid="sm:grid-cols-2" />
        {v.aryeoPush === "on" && (
          <Switch label="Same-day orders deliver by themselves" help="When the order has same-day photo delivery, the hub approves and delivers it in its suggested order once every check passes, and checks again just before delivering." checked={v.sameDayAutoDeliver} onChange={(on) => set("sameDayAutoDeliver", on)} />
        )}
      </div>

      <details className="group rounded-xl border border-border">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 px-3 text-sm font-semibold hover:bg-surface-2/40 [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden className="size-4 text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none" /> Advanced
          {initial.qcShadow && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-ui-status font-medium text-muted ring-1 ring-inset ring-border">Shadow mode on</span>}
        </summary>
        <div className="space-y-5 border-t border-border p-3">
          <Choice name="pd-paid-qc" legend="Paid QC (Claude)" help="Claude vision checks, paid in Anthropic money, never AutoHDR credits." options={PAID_QC} value={v.paidQc} onChange={(m) => set("paidQc", m)} grid="sm:grid-cols-3" />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField id="pd-budget" label="Monthly QC budget" suffix="USD" help="The paid QC pauses, and you are alerted, once the month's spend passes this." value={v.monthlyQcBudgetUsd} onChange={(n) => set("monthlyQcBudgetUsd", n)} min={0} max={100000} step={1} />
            <div>
              <label htmlFor="pd-phase" className="text-sm font-medium">Which checks the paid QC runs</label>
              <select id="pd-phase" value={v.maxBuildPhase} onChange={(e) => set("maxBuildPhase", Number(e.target.value) as 1 | 2 | 3)} className={input} aria-describedby="pd-phase-help">
                <option value={1}>The checklist&rsquo;s priority checks</option>
                <option value={2}>Plus the second tier</option>
                <option value={3}>Every check</option>
              </select>
              <p id="pd-phase-help" className="mt-1 text-ui-status text-muted">Checks that can be critical (privacy, wrong property, damaged files) always run.</p>
            </div>
          </div>
          <Switch label="Never hold a delivery for open issues (shadow mode)" help="A check never puts a job on hold and Mark as delivering is never blocked; the hub's own Aryeo delivery still waits for a clean checklist." checked={v.qcShadow} onChange={(on) => set("qcShadow", on)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pd-from" className="text-sm font-medium">Track shoots from</label>
              <input id="pd-from" type="date" value={v.qcFromDay} onChange={(e) => set("qcFromDay", e.target.value)} className={input} aria-describedby="pd-from-help" />
              <p id="pd-from-help" className="mt-1 text-ui-status text-muted">Shoots before this day (Eastern) get no photo job and no paid QC; blank means since Photo Delivery started.</p>
            </div>
            <NumberField id="pd-floor" label="Confidence floor" suffix="%" help="Findings below this go in a collapsed Low confidence drawer and never block delivery." value={v.displayConfidenceFloor} onChange={(n) => set("displayConfidenceFloor", n)} min={0} max={100} />
            <NumberField id="pd-edge" label="Smallest photo allowed" suffix="px" help="A photo whose long edge is shorter than this fails the delivery check." value={v.minLongEdgePx} onChange={(n) => set("minLongEdgePx", n)} min={300} max={20000} />
            <NumberField id="pd-cap" label="Kyle's approval limit" suffix="credits per batch" help="Kyle can approve a fix batch up to this many credits; above it, you approve." value={v.adminCreditCap} onChange={(n) => set("adminCreditCap", n)} min={0} max={10000} />
          </div>
        </div>
      </details>

      <div className="sticky bottom-0 z-10 -mx-5 -mb-4 flex flex-wrap items-center gap-3 rounded-b-2xl border-t border-border bg-surface px-5 py-3">
        <button type="submit" disabled={pending} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:opacity-50">
          {pending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden className="size-4" />} Save settings
        </button>
        <p role="status" className={cn("text-ui-status", msg && (msg.ok ? "text-success" : "text-warning"))}>{msg?.text ?? ""}</p>
      </div>
    </form>
  );
}
