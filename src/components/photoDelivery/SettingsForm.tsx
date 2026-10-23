"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { ChevronDown, Loader2, Plus, Save, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch as SwitchControl } from "@/components/ui/Switch";
import { saveSettingsAction, searchClientsAction } from "@/app/ops/photo-delivery/actions";

// ---------------------------------------------------------------------------
// Photo Delivery switches and thresholds (plan 14), owner only, every field
// with one plain line. Up front: what the hub does by itself. Behind
// "Advanced": the delivery-check thresholds. A pair of stored switches shows
// as one choice (fixes: fixRunnerEnabled + autoFix) and Save writes both.
// Everything that can spend money or reach a client defaults OFF
// (lib/photoDelivery/settings.ts). The server action validates each value again.
// Oct 23 2026 (Jordan: "Paid Photo QC should be off. Only using the free
// version."): no paid QC choice, budget or depth here any more; the free
// photo check and the paid AutoHDR fixes stay.
// ---------------------------------------------------------------------------

export type FixesMode = "off" | "approve" | "auto";
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
  qcShadow: boolean;
  /** ET day key (YYYY-MM-DD) or "" */
  qcFromDay: string;
  /** Percent (0 to 100). */
  displayConfidenceFloor: number;
  minLongEdgePx: number;
  adminCreditCap: number;
  /** Oct 15 2026: the free warp, coverage and after-delivery checks. */
  warpCv: boolean;
  warpCompareOriginal: boolean;
  freeCoverage: boolean;
  afterDeliveryCheck: boolean;
  /** Clients whose homes are shot as they are: clutter is not checked (prep.ts). */
  asIsClients: { id: string; name: string }[];
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
];

const input = "min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-brand";
const card = "flex cursor-pointer items-start gap-3 rounded-xl border p-3 hover:bg-surface-2/40";

// One setting as a card: the whole card is the tap target for the shared switch.
function Switch({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (on: boolean) => void }) {
  return <SwitchControl checked={checked} onChange={onChange} label={label} description={help} labelClassName={cn(card, "border-border")} />;
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

/** Oct 15 2026: clients whose homes are shot as they are (Nehemiah's shoots): clutter is not checked. */
function AsIsClients({ value, onChange }: { value: { id: string; name: string }[]; onChange: (v: { id: string; name: string }[]) => void }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string }[]>([]);
  const [note, setNote] = useState("");
  const searching = q.trim().length >= 2;
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      searchClientsAction(term)
        .then((r) => {
          if (!live) return;
          setHits(r.clients);
          setNote(r.message);
        })
        .catch(() => live && setNote("The client search didn't answer. Try again."));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const chosen = new Set(value.map((c) => c.id));
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-semibold">As-is clients</label>
      <p className="text-ui-status text-muted">Homes these clients book are shot as they are: clutter is not checked or fixed on their shoots (camera mistakes, cars, trash cans and warped lines still are). Any other home that looks lived in is found by the photo check.</p>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="As-is clients">
          {value.map((c) => (
            <li key={c.id} className="inline-flex min-h-10 items-center gap-1 rounded-full border border-border bg-surface-2 pl-3 pr-1 text-sm">
              {c.name}
              <button type="button" onClick={() => onChange(value.filter((x) => x.id !== c.id))} className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface" aria-label={`Remove ${c.name}`}>
                <X aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ui-status text-muted">No client on the list.</p>
      )}
      <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client by name" className={input} autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
      {searching && hits.length > 0 && (
        <ul className="space-y-1" aria-label="Clients found">
          {hits.map((c) => (
            <li key={c.id}>
              <button type="button" disabled={chosen.has(c.id)} onClick={() => { onChange([...value, c]); setQ(""); }} className="inline-flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50">
                <Plus aria-hidden className="size-4" /> {c.name}{chosen.has(c.id) ? " (on the list)" : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searching && note && <p role="status" className="text-ui-status text-muted">{note}</p>}
    </div>
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
          qcShadow: v.qcShadow,
          qcFrom: v.qcFromDay || null,
          displayConfidenceFloor: Math.round(v.displayConfidenceFloor) / 100,
          minLongEdgePx: v.minLongEdgePx,
          adminCreditCap: v.adminCreditCap,
          warpCv: v.warpCv,
          warpCompareOriginal: v.warpCompareOriginal,
          freeCoverage: v.freeCoverage,
          afterDeliveryCheck: v.afterDeliveryCheck,
          asIsClientIds: v.asIsClients.map((c) => c.id),
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
        {v.freeCheck && (
          <div className="space-y-3 border-l-2 border-border pl-3">
            <Switch label="Measure the lines" help="Measures each photo's walls, door frames and windows for leaning or bending, from copies the hub can read for free (never a paid download). A warp counts in full only when this and the photo check agree." checked={v.warpCv} onChange={(on) => set("warpCv", on)} />
            <Switch label="Compare cut-off roofs and warps with AutoHDR's original" help="Asks AutoHDR (free) whether the original photo had the problem too: the editing did it (turn Perspective Off in AutoHDR) or the framing or lens did (photographer coaching)." checked={v.warpCompareOriginal} onChange={(on) => set("warpCompareOriginal", on)} />
            <Switch label="Room coverage" help="Checks the delivery has the rooms the listing needs (front and rear exterior, kitchen, living area, primary bedroom, primary bathroom with its shower or tub), and whether a missing room was shot but left out, never shot, or lost in editing." checked={v.freeCoverage} onChange={(on) => set("freeCoverage", on)} />
            <Switch label="Check listing photos that change after delivery" help="For a week after delivery, new or replaced photos on the Aryeo listing get the free check, and Kyle and you hear about it. The job stays delivered." checked={v.afterDeliveryCheck} onChange={(on) => set("afterDeliveryCheck", on)} />
          </div>
        )}
      </div>

      <AsIsClients value={v.asIsClients} onChange={(list) => set("asIsClients", list)} />

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
          <Switch label="Never hold a delivery for open issues (shadow mode)" help="A check never puts a job on hold and Mark as delivering is never blocked; the hub's own Aryeo delivery still waits for a clean checklist." checked={v.qcShadow} onChange={(on) => set("qcShadow", on)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="pd-from" className="text-sm font-medium">Track shoots from</label>
              <input id="pd-from" type="date" value={v.qcFromDay} onChange={(e) => set("qcFromDay", e.target.value)} className={input} aria-describedby="pd-from-help" />
              <p id="pd-from-help" className="mt-1 text-ui-status text-muted">Shoots before this day (Eastern) get no photo job; blank means since Photo Delivery started.</p>
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
