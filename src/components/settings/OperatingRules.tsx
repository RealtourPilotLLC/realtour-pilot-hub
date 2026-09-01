"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { saveTurnarounds, saveInternalAlerts, saveTextTemplates } from "@/app/settings/actions";
import type { TurnaroundRules, InternalAlertRules, TextTemplates } from "@/lib/settings";
import { cn } from "@/lib/utils";

// Everything that used to be a constant in the code (Jordan, Sep 1: "I want
// settings for turnaround promises, alert thresholds, anything currently hard
// coded"). Each group saves independently so one bad edit can't take the rest
// with it, and every value is clamped again server-side on read.

const hour12 = (h: number) => {
  const am = h < 12 || h === 24;
  const v = h % 12 === 0 ? 12 : h % 12;
  return `${v}:00 ${am ? "AM" : "PM"}`;
};

function Num({ value, onChange, min, max, suffix, wide }: { value: number; onChange: (n: number) => void; min: number; max: number; suffix?: string; wide?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^\d]/g, ""));
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className={cn("rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm tabular-nums outline-none focus:border-brand", wide ? "w-20" : "w-16")}
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label}
      onClick={() => onChange(!on)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", on ? "bg-success" : "bg-surface-2 ring-1 ring-border")}
    >
      <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

function SaveRow({ onSave, msg, busy }: { onSave: () => void; msg: string | null; busy: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button onClick={onSave} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
      </button>
      {msg && <span className="text-[13px] font-medium text-muted">{msg}</span>}
    </div>
  );
}

const TURN_ROWS: { key: keyof TurnaroundRules; label: string; hint: string; max: number; unit: string }[] = [
  { key: "photos", label: "Photos", hint: "the promise clients hear most", max: 720, unit: "hours after the shoot" },
  { key: "drone", label: "Drone / aerial", hint: "", max: 720, unit: "hours" },
  { key: "twilight", label: "Twilight", hint: "", max: 720, unit: "hours" },
  { key: "floorPlan", label: "Floor plan", hint: "CubiCasa round-trip", max: 720, unit: "hours" },
  { key: "tour3d", label: "3D tour (Matterport / Zillow)", hint: "", max: 720, unit: "hours" },
  { key: "headshot", label: "Headshots", hint: "", max: 720, unit: "hours" },
  { key: "virtualStaging", label: "Virtual staging", hint: "", max: 720, unit: "hours" },
  { key: "standardVideoHours", label: "Standard reel / video", hint: "in-house edit", max: 720, unit: "hours" },
  { key: "premiumVideoHours", label: "Premium reel / video", hint: "beats monthly when both apply", max: 720, unit: "hours" },
  { key: "otherHours", label: "Anything else", hint: "unmapped products", max: 720, unit: "hours" },
];

export function TurnaroundSettings({ initial }: { initial: TurnaroundRules }) {
  const [r, setR] = useState(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">
        What we promise, per deliverable. These drive every due date, the QC card&rsquo;s deadline, the late/overdue
        flags, and the video SLA countdown — change one and the whole hub follows.
      </p>
      <div className="space-y-1.5">
        {TURN_ROWS.map((row) => (
          <div key={row.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <span className="text-[13px]">
              <b>{row.label}</b>
              {row.hint && <span className="text-muted"> — {row.hint}</span>}
            </span>
            <Num
              value={r[row.key] as number}
              onChange={(n) => { setR((p) => ({ ...p, [row.key]: n })); setMsg(null); }}
              min={1} max={row.max} suffix={row.unit}
            />
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <span className="text-[13px]"><b>Monthly content</b><span className="text-muted"> — personal branding batches</span></span>
          <Num value={r.monthlyBusinessDays} onChange={(n) => { setR((p) => ({ ...p, monthlyBusinessDays: n })); setMsg(null); }} min={1} max={60} suffix="business days" />
        </div>
      </div>
      <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
        const res = await saveTurnarounds(r).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
        setMsg(res.message);
      })} />
    </div>
  );
}

export function InternalAlertSettings({ initial }: { initial: InternalAlertRules }) {
  const [r, setR] = useState(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<InternalAlertRules>) => { setR((p) => ({ ...p, ...patch })); setMsg(null); };
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">These go to the team, never to clients.</p>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Upload reminder</p>
            <p className="text-[13px] text-muted">Texts a photographer whose shoot has no submitted upload page.</p>
          </div>
          <Toggle on={r.uploadReminder.enabled} onChange={(v) => set({ uploadReminder: { ...r.uploadReminder, enabled: v } })} label="Upload reminder" />
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Sends at</span>
          <Num value={r.uploadReminder.hour} onChange={(n) => set({ uploadReminder: { ...r.uploadReminder, hour: n } })} min={0} max={23} suffix={`ET (${hour12(r.uploadReminder.hour)})`} />
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Late-night chaser</p>
            <p className="text-[13px] text-muted">Second nudge if the upload page is still not submitted.</p>
          </div>
          <Toggle on={r.uploadChaser.enabled} onChange={(v) => set({ uploadChaser: { ...r.uploadChaser, enabled: v } })} label="Upload chaser" />
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Sends at</span>
          <Num value={r.uploadChaser.hour} onChange={(n) => set({ uploadChaser: { ...r.uploadChaser, hour: n } })} min={0} max={23} suffix={`ET (${hour12(r.uploadChaser.hour)})`} />
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Photos not delivered</p>
            <p className="text-[13px] text-muted">Texts Kyle and Jordan when a shoot&rsquo;s photos still aren&rsquo;t released.</p>
          </div>
          <Toggle on={r.photosUndelivered.enabled} onChange={(v) => set({ photosUndelivered: { ...r.photosUndelivered, enabled: v } })} label="Photos not delivered" />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <span className="text-[13px] text-muted">Late after</span>
          <Num value={r.photosUndelivered.lateAfterHours} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, lateAfterHours: n } })} min={1} max={336} suffix="hours" />
          <span className="text-[13px] text-muted">· alert between</span>
          <Num value={r.photosUndelivered.fromHour} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, fromHour: n } })} min={0} max={22} suffix={hour12(r.photosUndelivered.fromHour)} />
          <span className="text-xs text-muted-2">and</span>
          <Num value={r.photosUndelivered.toHour} onChange={(n) => set({ photosUndelivered: { ...r.photosUndelivered, toHour: n } })} min={1} max={23} suffix={hour12(r.photosUndelivered.toHour)} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Raw video missing</p>
          <p className="text-[13px] text-muted">Bell + text to the creative when a video job&rsquo;s footage can&rsquo;t be found.</p>
        </div>
        <Toggle on={r.rawVideoMissing.enabled} onChange={(v) => set({ rawVideoMissing: { enabled: v } })} label="Raw video missing" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-semibold">Kyle&rsquo;s Slack digests</p>
          <p className="text-[13px] text-muted">Morning list and the 4 PM open-items recap.</p>
        </div>
        <Toggle on={r.kyleDigests.enabled} onChange={(v) => set({ kyleDigests: { enabled: v } })} label="Kyle's Slack digests" />
      </div>

      <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
        const res = await saveInternalAlerts(r).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
        setMsg(res.message);
      })} />
    </div>
  );
}

const TPL_FIELDS: { key: keyof TextTemplates; label: string; hint: string; vars: string[] }[] = [
  { key: "confirmation", label: "Shoot confirmation", hint: "sent before the shoot", vars: ["{first}", "{street}", "{when}", "{items}"] },
  { key: "deliveryAll", label: "Delivery — everything shipped", hint: "", vars: ["{first}", "{street}", "{feedbackUrl}"] },
  { key: "deliveryPartial", label: "Delivery — part still in production", hint: "", vars: ["{first}", "{street}", "{delivered}", "{remaining}", "{feedbackUrl}"] },
];

export function TextTemplateSettings({ initial }: { initial: TextTemplates }) {
  const [t, setT] = useState(initial);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Leave a box empty to use the hub&rsquo;s built-in wording. Placeholders are filled in automatically — an unknown
        one is left as-is rather than sent blank.
      </p>
      {TPL_FIELDS.map((f) => (
        <div key={f.key}>
          <label className="text-[13px] font-medium">
            {f.label}
            {f.hint && <span className="font-normal text-muted"> — {f.hint}</span>}
          </label>
          <textarea
            value={t[f.key]}
            onChange={(e) => { setT((p) => ({ ...p, [f.key]: e.target.value })); setMsg(null); }}
            rows={3}
            placeholder="Using the built-in wording"
            className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <p className="mt-1 text-[11px] text-muted-2">Placeholders: {f.vars.join(" · ")}</p>
        </div>
      ))}
      <SaveRow busy={busy} msg={msg} onSave={() => start(async () => {
        const res = await saveTextTemplates(t).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
        setMsg(res.message);
      })} />
    </div>
  );
}
