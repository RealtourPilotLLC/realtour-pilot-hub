"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Pin, PinOff, SlidersHorizontal, X } from "lucide-react";
import { saveEditOverrides } from "@/app/editing/actions";
import { etAt, etDateTime } from "@/lib/datetime";
import {
  EDIT_PRIORITIES,
  EDIT_STATUS_LABELS,
  EDIT_TIERS,
  type EditComputedView,
  type EditOverrideInput,
  type EditOverrideView,
  type EditPriority,
  type EditStatusLabel,
  type EditTier,
} from "@/lib/editOverrideDefaults";

// THE OVERRIDE DIALOG — the office's "I want to be able to override anything"
// (Jordan, Sep 13: "I want to be able to change the status, amount of
// deliverables, the due date and all other information for the edits in the
// editing room"). Opened from the small sliders glyph beside each queue row's
// status pill and from the Override button in the /edit/<id> header — office
// (owner/admin) only; the server (saveEditOverrides) is the real guard.
//
// Every field shows two things: what the HUB says on its own (the computed
// value the engines would use) and what the office set on top of it. A field
// with no override shows the hub's value and nothing else; "Use the hub's
// value" clears an override and the engines take the field back. Status is
// the one field that is not a column override but a PIN: picking a status
// here writes it straight to the job — past every guardrail the pill has —
// and pins it so the hourly sweeps stop moving it; "Let the hub manage the
// status again" unpins without changing it.
//
// Client-safe by construction: this file imports the dependency-free
// defaults module, the server action, the ET helpers (datetime.ts imports
// nothing) and lucide — never Prisma, settings or the task engine.

// The queue's assignable video editors — same options as the row's Editor
// select (Unassigned / John Mark / Kim / External agency), same key words the
// server's setEditVideoEditor takes.
const VIDEO_EDITORS = [
  { key: "john", name: "John Mark" },
  { key: "kim", name: "Kim" },
] as const;
const UNASSIGN = "";
const EXTERNAL = "external_agency";

const TIER_LABEL: Record<EditTier, string> = { standard: "Standard", premium: "Premium", branding: "Personal Branding" };

// Who set the override, when, and why — the chip's hover text and the
// dialog's footer line.
function provenance(o: EditOverrideView): string {
  return [o.by ? `Override by ${o.by}` : "Office override", o.at ? etDateTime(o.at) : null, o.note ? `“${o.note}”` : null]
    .filter(Boolean)
    .join(" · ");
}

/** True when the office has set anything on this job — drives the row chip.
    A note on its own counts (review, Sep 13): the server keeps the who/when/
    note for a note-only save, and the office's words should be findable on
    the row, not only on the timeline. */
export function hasOverride(o: EditOverrideView): boolean {
  return o.statusPinned || o.dueAt != null || o.videosOwed != null || o.tier != null || o.typeDetail != null || o.priority != null || o.note != null;
}

// The fields the office has overridden, in words, for the chip's tooltip.
function overriddenFields(o: EditOverrideView): string[] {
  const out: string[] = [];
  if (o.statusPinned) out.push("status pinned");
  if (o.dueAt != null) out.push(`due ${etDateTime(o.dueAt)}`);
  if (o.videosOwed != null) out.push(`${o.videosOwed} video${o.videosOwed === 1 ? "" : "s"} owed`);
  if (o.priority != null) out.push(`priority ${o.priority}`);
  if (o.tier != null) out.push(`tier ${TIER_LABEL[o.tier]}`);
  if (o.typeDetail != null) out.push(`video type “${o.typeDetail}”`);
  return out;
}

/** The "Override" chip a row (or the /edit header) wears when any override or
    pin is set. Hover = who, when, note, and what is overridden. Renders
    nothing when the office has set nothing. */
export function OverrideChip({ overrides, className = "" }: { overrides: EditOverrideView; className?: string }) {
  if (!hasOverride(overrides)) return null;
  const title = [provenance(overrides), overriddenFields(overrides).join(" · ")].filter(Boolean).join("\n");
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded bg-brand-soft px-1.5 text-[10px] font-semibold text-brand ${className}`}
    >
      <SlidersHorizontal className="size-2.5" /> Override
    </span>
  );
}

// ---- ET wall-clock ↔ instant --------------------------------------------
// The due input is a datetime-local the office reads as EASTERN time (the
// business runs on ET; the label says so). A datetime-local carries no zone,
// so the value is converted here: instant → ET wall clock via Intl for the
// input, and ET wall clock → instant via etAt() — DST-safe, the offset comes
// from the day itself rather than a hard-coded -04:00.
const TZ = "America/New_York";
function toEtLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
function fromEtLocal(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = etAt(m[1], Number(m[2]), Number(m[3]));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Everything the dialog needs to know about one job — a queue row supplies
    it from its own fields, the /edit page from the project row. */
export type EditOverridesJob = {
  projectId: string;
  street: string;
  /** The status label the row/page shows NOW (after overrides — the pinned
      label when pinned). */
  status: string;
  editorKey: string | null; // "" or null = unassigned
  editorName: string | null; // display name, so a historical editor (Luma / Remar) still reads
  editorAuto: boolean; // the routing rules picked the editor — no human did
  overrides: EditOverrideView;
  computed: EditComputedView;
};

type Draft = {
  status: string;
  pin: boolean;
  editorKey: string;
  videosOwed: string; // "" = the hub's value
  dueLocal: string; // "" = the hub's value; else "YYYY-MM-DDTHH:mm" in ET
  priority: "" | EditPriority;
  tier: "" | EditTier;
  typeDetail: string; // "" = the hub's value
  note: string;
};

const draftFrom = (j: EditOverridesJob): Draft => ({
  status: j.status,
  pin: j.overrides.statusPinned,
  editorKey: j.editorKey ?? UNASSIGN,
  videosOwed: j.overrides.videosOwed != null ? String(j.overrides.videosOwed) : "",
  dueLocal: toEtLocal(j.overrides.dueAt),
  priority: j.overrides.priority ?? "",
  tier: j.overrides.tier ?? "",
  typeDetail: j.overrides.typeDetail ?? "",
  note: j.overrides.note ?? "",
});

const isStatusLabel = (s: string): s is EditStatusLabel => (EDIT_STATUS_LABELS as readonly string[]).includes(s);

// What to send: only the fields that moved. undefined = leave as is, null =
// clear the override. Returns the input or the reason it can't be sent.
function diff(init: Draft, d: Draft): { input: EditOverrideInput } | { error: string } {
  const input: EditOverrideInput = {};
  if (d.status !== init.status) {
    if (!isStatusLabel(d.status)) return { error: "Pick one of the six statuses." };
    input.status = d.status; // a picked status is pinned by the server
  } else if (d.pin && !init.pin) {
    if (!isStatusLabel(d.status)) return { error: "Pick one of the six statuses to pin." };
    input.status = d.status; // pin the label it is on now
  } else if (!d.pin && init.pin) {
    input.pinStatus = false; // unpin, status untouched
  }
  // The label this dialog OPENED on, for the timeline sentence only: the
  // queue's reading can differ from the stored status (a cut in review on a
  // job whose Project.status is still REVIEW reads Revisions), and the
  // sentence should say what the office saw (review, Sep 13).
  if (input.status !== undefined || input.pinStatus !== undefined) input.fromLabel = init.status;
  if (d.editorKey !== init.editorKey) input.editorKey = d.editorKey;
  if (d.videosOwed !== init.videosOwed) {
    if (d.videosOwed === "") input.videosOwed = null;
    else {
      const n = Number(d.videosOwed);
      if (!Number.isInteger(n) || n < 1 || n > 40) return { error: "Videos owed must be a whole number from 1 to 40." };
      input.videosOwed = n;
    }
  }
  if (d.dueLocal !== init.dueLocal) {
    if (d.dueLocal === "") input.dueAt = null;
    else {
      const iso = fromEtLocal(d.dueLocal);
      if (!iso) return { error: "That due date isn't a real date." };
      input.dueAt = iso;
    }
  }
  if (d.priority !== init.priority) input.priority = d.priority === "" ? null : d.priority;
  if (d.tier !== init.tier) input.tier = d.tier === "" ? null : d.tier;
  const type = d.typeDetail.trim();
  if (type !== init.typeDetail.trim()) {
    if (type.length > 120) return { error: "Keep the video type under 120 characters." };
    input.typeDetail = type === "" ? null : type;
  }
  const note = d.note.trim();
  if (note.length > 300) return { error: "Keep the note under 300 characters." };
  // The note rides with any change (so it always reads what the dialog shows),
  // and alone when only the note changed.
  if (Object.keys(input).length > 0 || note !== init.note.trim()) input.note = note;
  return { input };
}

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const INPUT = "rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm outline-none focus:border-brand";
const SELECT = "cursor-pointer rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-6 text-sm outline-none focus:border-brand";

// One field: label, the hub's value, the control, and the reset when an
// override is in place.
function Field({
  label, hub, overridden, onReset, hint, children,
}: {
  label: string;
  hub: string;
  overridden: boolean;
  onReset?: () => void;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cx("rounded-xl border px-3 py-2.5", overridden ? "border-brand/40 bg-brand-soft/30" : "border-border")}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">
          {label}
          {overridden && <span className="ml-1.5 rounded bg-brand-soft px-1 text-[10px] font-semibold normal-case tracking-normal text-brand">override</span>}
        </span>
        {overridden && onReset && (
          <button type="button" onClick={onReset} className="text-[11px] font-medium text-brand hover:underline">
            Use the hub&rsquo;s value
          </button>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">{children}</div>
      <div className="mt-1 text-[11px] text-muted">
        <span className="text-muted-2">Hub:</span> {hub}
        {hint && <span className="text-muted-2"> · {hint}</span>}
      </div>
    </div>
  );
}

// The switch from settings/OperatingRules, same look.
function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50", on ? "bg-success" : "bg-surface-2 ring-1 ring-border")}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

function OverridesDialog({ job, onClose, onSaved }: { job: EditOverridesJob; onClose: () => void; onSaved: (msg: string) => void }) {
  const [init] = useState(() => draftFrom(job));
  const [d, setD] = useState<Draft>(init);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const set = (patch: Partial<Draft>) => { setD((p) => ({ ...p, ...patch })); setMsg(null); };

  // Escape closes, like clicking the backdrop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { computed, overrides } = job;
  const statusKnown = isStatusLabel(d.status);
  const knownEditor = d.editorKey === EXTERNAL || VIDEO_EDITORS.some((e) => e.key === d.editorKey);
  const hubEditor = job.editorAuto
    ? `the routing rules put it with ${job.editorName ?? "an editor"}`
    : job.editorName
      ? `assigned by hand to ${job.editorName}`
      : "unassigned";

  const save = () =>
    start(async () => {
      const r = diff(init, d);
      if ("error" in r) return setMsg(r.error);
      if (Object.keys(r.input).length === 0) return setMsg("Nothing changed.");
      const res = await saveEditOverrides(job.projectId, r.input).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      if (!res.ok) return setMsg(res.message || "That didn't save — try again.");
      onSaved(res.message || "Override saved.");
      onClose();
    });

  // Portalled to <body>: the /edit header is a sticky bar with a backdrop
  // blur, and backdrop-filter makes it the containing block for anything
  // position:fixed inside it — the overlay would have been pinned inside the
  // header strip. React still bubbles the synthetic events up the component
  // tree, so on a queue row the cell's swallow keeps clicks in here from
  // opening the edit page.
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Override ${job.street}`}
        className="fixed left-1/2 top-1/2 z-[70] max-h-[90vh] w-[min(94vw,36rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-2xl sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <SlidersHorizontal className="size-4 text-brand" /> Override · {job.street}
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">
              Whatever you set here wins over what the hub works out on its own. Clear a field to hand it back.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {/* STATUS — a pin, not a column: picking one writes it straight to
              the job and holds it there. */}
          <Field
            label="Status"
            overridden={d.pin}
            hub={d.pin ? "would set it from the uploads and the cuts once you let go" : "sets it from the uploads and the cuts"}
            hint="picking a status pins it"
          >
            <select
              aria-label="Status"
              value={d.status}
              onChange={(e) => set({ status: e.target.value, pin: true })}
              className={SELECT}
            >
              {!statusKnown && <option value={d.status} disabled>{d.status} (the hub&rsquo;s reading)</option>}
              {EDIT_STATUS_LABELS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Switch
                on={d.pin}
                onChange={(v) => (v ? set({ pin: true }) : set({ pin: false, status: init.status }))}
                label="Pin the status"
                disabled={!statusKnown && !d.pin}
              />
              {d.pin ? (
                <span className="inline-flex items-center gap-1"><Pin className="size-3 text-brand" /> Pinned — the hub won&rsquo;t move it</span>
              ) : (
                <span>Not pinned — the hub moves it</span>
              )}
            </span>
            {d.pin && (
              <button
                type="button"
                onClick={() => set({ pin: false, status: init.status })}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
              >
                <PinOff className="size-3" /> Let the hub manage the status again
              </button>
            )}
          </Field>

          {/* EDITOR — the row's own reassign control, here so one Save covers
              the whole hand-off. Routes through setEditVideoEditor. */}
          <Field label="Editor" overridden={false} hub={hubEditor} hint="moves the open task and pings the editor, like the row's select">
            <select aria-label="Editor" value={d.editorKey} onChange={(e) => set({ editorKey: e.target.value })} className={SELECT}>
              <option value={UNASSIGN}>Unassigned</option>
              {!knownEditor && d.editorKey && <option value={d.editorKey} disabled>{job.editorName ?? d.editorKey}</option>}
              <optgroup label="Our editors">
                {VIDEO_EDITORS.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
              </optgroup>
              <optgroup label="Outside">
                <option value={EXTERNAL}>External agency</option>
              </optgroup>
            </select>
          </Field>

          {/* VIDEOS OWED — the batch size: cut slots, the queue count and the
              monthly quota all follow it. */}
          <Field
            label="Videos owed"
            overridden={d.videosOwed !== ""}
            onReset={() => set({ videosOwed: "" })}
            hub={`${computed.videosOwed} (the order's quantity, or the photographer's count)`}
          >
            <input
              inputMode="numeric"
              aria-label="Videos owed"
              value={d.videosOwed}
              placeholder={String(computed.videosOwed)}
              onChange={(e) => set({ videosOwed: e.target.value.replace(/[^\d]/g, "").slice(0, 2) })}
              className={cx(INPUT, "w-16 tabular-nums")}
            />
            <span className="text-xs text-muted">1 to 40</span>
          </Field>

          {/* DUE — Eastern time. The input has no zone of its own; the value is
              read as ET and converted to an instant on save. */}
          <Field
            label="Due (Eastern time)"
            overridden={d.dueLocal !== ""}
            onReset={() => set({ dueLocal: "" })}
            hub={computed.dueAt ? `${etDateTime(computed.dueAt)} ET (the turnaround promise)` : "no deadline yet — needs a shoot date"}
          >
            <input
              type="datetime-local"
              aria-label="Due, Eastern time"
              value={d.dueLocal}
              onChange={(e) => set({ dueLocal: e.target.value })}
              className={INPUT}
            />
            <span className="text-xs text-muted">ET</span>
            {d.dueLocal && fromEtLocal(d.dueLocal) && (
              <span className="text-[11px] text-muted-2">= {etDateTime(fromEtLocal(d.dueLocal))} ET</span>
            )}
          </Field>

          <div className="grid gap-2 sm:grid-cols-2">
            {/* PRIORITY — pins the edit card's priority. */}
            <Field
              label="Priority"
              overridden={d.priority !== ""}
              onReset={() => set({ priority: "" })}
              hub={computed.priority}
            >
              <select aria-label="Priority" value={d.priority} onChange={(e) => set({ priority: e.target.value as Draft["priority"] })} className={SELECT}>
                <option value="">Hub&rsquo;s value ({computed.priority})</option>
                {EDIT_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>

            {/* TIER — the row's Standard / Premium / Personal Branding pill. */}
            <Field
              label="Tier"
              overridden={d.tier !== ""}
              onReset={() => set({ tier: "" })}
              hub={TIER_LABEL[computed.tier]}
            >
              <select aria-label="Tier" value={d.tier} onChange={(e) => set({ tier: e.target.value as Draft["tier"] })} className={SELECT}>
                <option value="">Hub&rsquo;s value ({TIER_LABEL[computed.tier]})</option>
                {EDIT_TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select>
            </Field>
          </div>

          {/* VIDEO TYPE — the row's "video type" text under the tier pill. */}
          <Field
            label="Video type"
            overridden={d.typeDetail.trim() !== ""}
            onReset={() => set({ typeDetail: "" })}
            hub={computed.typeDetail || "—"}
          >
            <input
              aria-label="Video type"
              value={d.typeDetail}
              maxLength={120}
              placeholder={computed.typeDetail || "e.g. Standard Reel with Agent Intro"}
              onChange={(e) => set({ typeDetail: e.target.value })}
              className={cx(INPUT, "w-full")}
            />
          </Field>

          {/* NOTE — the reason, one line; shows on the row's chip and the
              timeline sentence. */}
          <div className="rounded-xl border border-border px-3 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Note <span className="font-normal normal-case tracking-normal">— optional, one line</span></span>
            <input
              aria-label="Note"
              value={d.note}
              maxLength={300}
              placeholder="Why — shows on the row and the job's timeline"
              onChange={(e) => set({ note: e.target.value })}
              className={cx(INPUT, "mt-1.5 w-full")}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
          </button>
          <button type="button" onClick={onClose} className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            Cancel
          </button>
          {msg && <span className="text-[13px] font-medium text-warning">{msg}</span>}
        </div>
        {hasOverride(overrides) && (
          <p className="mt-2 text-[11px] text-muted-2">{provenance(overrides)}</p>
        )}
      </div>
    </>,
    document.body,
  );
}

/** The control that opens the dialog. `row` = the bare sliders glyph beside a
    queue row's status pill; `header` = the bordered button in the /edit
    header, which also wears the Override chip when one is set. onReceipt
    takes the server's sentence (the queue shows it above the tabs, where it
    survives the row moving to another view); without it, the sentence is
    shown as a note under the control. */
export function EditOverridesButton({
  job, variant = "row", onReceipt,
}: {
  job: EditOverridesJob;
  variant?: "row" | "header";
  onReceipt?: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const title = "Override this job — status, editor, videos owed, due date, priority, tier, video type";
  const saved = (m: string) => (onReceipt ? onReceipt(m) : setNote(m));
  return (
    <span className={variant === "header" ? "inline-flex flex-col items-end gap-1" : "inline-flex"}>
      {variant === "header" ? (
        <span className="inline-flex items-center gap-2">
          <OverrideChip overrides={job.overrides} />
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={title}
            className="inline-flex items-center gap-1 rounded-lg border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground"
          >
            <SlidersHorizontal className="size-3.5" /> Override
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={title}
          aria-label="Override this job"
          className="inline-flex items-center rounded-md p-0.5 text-muted-2 transition-colors hover:bg-surface-2 hover:text-brand"
        >
          <SlidersHorizontal className="size-3.5" />
        </button>
      )}
      {note && !onReceipt && (
        <span className="flex max-w-96 items-start gap-2 whitespace-normal rounded-lg border border-success/30 bg-success/10 px-2 py-1 text-left text-[11px] leading-snug text-foreground/90">
          <span className="min-w-0 flex-1">{note}</span>
          <button type="button" onClick={() => setNote(null)} aria-label="Dismiss" className="shrink-0 text-muted hover:text-foreground">
            <X className="size-3" />
          </button>
        </span>
      )}
      {open && <OverridesDialog job={job} onClose={() => setOpen(false)} onSaved={saved} />}
    </span>
  );
}
