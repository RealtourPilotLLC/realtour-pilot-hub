"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { AlertTriangle, Check, Loader2, Pin, PinOff, Send, SlidersHorizontal, X, Zap } from "lucide-react";
import { escalateRushToJordan, previewPriorityImpact, saveEditOverrides, type RushGate } from "@/app/editing/actions";
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
// (owner/admin) only; the server (saveEditOverrides) is the real guard. The
// header's Rush button (RushButton, below) opens the same dialog on the due
// date and priority alone.
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

// ---- WHAT A RUSH PUSHES BACK (§10, Sep 26 2026) ----------------------------
// Jordan: "James and Kyle - James is the creative manager now. Also It can be
// escalated to me." When the new date or priority would put this job ahead of
// others on the same editor's desk, the dialog shows those jobs BEFORE Save,
// asks the approver to say they looked and why, and offers "Send to Jordan".
// The server recomputes the list and is the real guard (saveEditOverrides).

/** The due/priority part of a draft, as the server takes it — undefined when unchanged. */
function rushChangeOf(init: Draft, d: Draft): { dueAt?: string | null; priority?: EditPriority | null; editorKey?: string } | null {
  const out: { dueAt?: string | null; priority?: EditPriority | null; editorKey?: string } = {};
  if (d.dueLocal !== init.dueLocal) {
    if (d.dueLocal === "") out.dueAt = null;
    else {
      const iso = fromEtLocal(d.dueLocal);
      if (!iso) return null;
      out.dueAt = iso;
    }
  }
  if (d.priority !== init.priority) out.priority = d.priority === "" ? null : d.priority;
  if (out.dueAt === undefined && out.priority === undefined) return null;
  if (d.editorKey !== init.editorKey) out.editorKey = d.editorKey;
  return out;
}

export function RushPanel({
  gate, loading, ack, onAck, reason, onReason, onEscalate, escalating,
}: {
  gate: RushGate | null;
  loading: boolean;
  ack: boolean;
  onAck: (v: boolean) => void;
  reason: string;
  onReason: (v: string) => void;
  onEscalate: () => void;
  escalating: boolean;
}) {
  if (loading && !gate) {
    return <p className="flex items-center gap-1.5 text-[11px] text-muted"><Loader2 className="size-3 animate-spin" /> Checking what this moves ahead of…</p>;
  }
  if (!gate) return null;
  const { impact, authority } = gate;
  if (impact.displaced.length === 0) {
    return (
      <p className="text-[11px] text-muted-2">
        {impact.note ?? "Moves nothing ahead on the editor's desk."}
        {impact.editorOut.length > 0 && ` Internal: ${impact.editorOut.join(" · ")}.`}
      </p>
    );
  }
  const first = (n: string) => n.split(/\s+/)[0];
  return (
    <div className="rounded-xl border border-warning/40 bg-warning-soft/30 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
        <AlertTriangle className="size-3.5 text-warning" />
        This pushes back {impact.displaced.length} of {impact.editorName ? `${first(impact.editorName)}'s` : "the editor's"} job{impact.displaced.length === 1 ? "" : "s"}
      </div>
      <ul className="mt-1.5 space-y-1">
        {impact.displaced.map((j) => (
          <li key={j.projectId} className="text-[12px] leading-snug text-foreground/90">
            <span className="font-medium">{j.street}</span>
            <span className="text-muted"> · {j.client}</span>
            <span className="block text-[11px] text-muted">
              {j.promiseISO ? `promised ${etDateTime(j.promiseISO)} ET` : j.dueISO ? `due ${etDateTime(j.dueISO)} ET` : "no date"}
              {j.dueISO && j.promiseISO && j.dueISO !== j.promiseISO && ` · on the board ${etDateTime(j.dueISO)} ET`}
              {j.why === "priority" && " · due sooner, now outranked"}
              {j.atRisk && <span className="font-medium text-danger"> · {j.slackHours != null && j.slackHours < 0 ? "already late" : "due inside a day"}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-muted">
        {impact.promiseISO ? `This job was promised ${etDateTime(impact.promiseISO)} ET` : "This job has no pinned promise"}
        {impact.paidRush ? " · a rush is on the order (paid)" : impact.fasterThanPromise ? " · the new date is faster than the client paid for" : ""}.
        {impact.editorOut.length > 0 && ` Internal: ${impact.editorOut.join(" · ")}.`}
      </p>
      {authority.may ? (
        <div className="mt-2 space-y-1.5">
          {authority.as !== "OWNER" && (
            <label className="flex items-start gap-2 text-[12px] text-foreground">
              <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} className="mt-0.5" />
              I&rsquo;ve looked at {impact.displaced.length === 1 ? "this job" : `these ${impact.displaced.length} jobs`} and approve moving this ahead of {impact.displaced.length === 1 ? "it" : "them"}.
            </label>
          )}
          <input
            aria-label="Why"
            value={reason}
            maxLength={200}
            placeholder={authority.as === "OWNER" ? "Why — optional; goes on the job's timeline" : "Why — goes on the job's timeline with your name"}
            onChange={(e) => onReason(e.target.value)}
            className={cx(INPUT, "w-full text-[12px]")}
          />
        </div>
      ) : (
        <p className="mt-2 text-[12px] font-medium text-warning">{authority.why}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-2">
        {!authority.seatsNamed && <span>The review seats aren&rsquo;t named in Settings, so any office login can approve this.</span>}
        {authority.as !== "OWNER" && (
          <button
            type="button"
            onClick={onEscalate}
            disabled={escalating}
            title={`Puts it on ${authority.escalateTo ?? "Jordan"}'s list with the reason — nothing on the job changes until it is approved`}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 font-medium text-muted hover:text-foreground disabled:opacity-50"
          >
            {escalating ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send to {first(authority.escalateTo ?? "Jordan")} instead
          </button>
        )}
      </div>
    </div>
  );
}

/** An open "approve this rush?" card for this job (escalateRushToJordan), as the job page reads it. */
export type RushAsk = { by: string | null; atISO: string | null; words: string };

function OverridesDialog({
  job, onClose, onSaved, mode = "all", ask = null,
}: {
  job: EditOverridesJob;
  onClose: () => void;
  onSaved: (msg: string) => void;
  /** "rush" = only the due date and priority, with what they push back (the job page's Rush button). */
  mode?: "all" | "rush";
  ask?: RushAsk | null;
}) {
  const rushOnly = mode === "rush";
  const [init] = useState(() => draftFrom(job));
  const [d, setD] = useState<Draft>(init);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const set = (patch: Partial<Draft>) => { setD((p) => ({ ...p, ...patch })); setMsg(null); };

  // The rush check follows the draft: re-read (debounced) whenever the date,
  // the priority or the editor changes; cleared when neither date nor priority
  // differs from what the dialog opened on.
  // The answer is stored WITH the change it answers, so a stale one is never
  // shown against a newer draft: loading = no answer for this change yet.
  const [fetched, setFetched] = useState<{ key: string; gate: RushGate | null }>({ key: "", gate: null });
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const [escalating, startEscalate] = useTransition();
  const change = rushChangeOf(init, d);
  const changeKey = change ? JSON.stringify(change) : "";
  useEffect(() => {
    if (!changeKey) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await previewPriorityImpact(job.projectId, JSON.parse(changeKey)).catch(() => null);
      if (!live) return;
      setFetched({ key: changeKey, gate: r?.ok && r.gate ? r.gate : null });
      setAck(false);
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [changeKey, job.projectId]);
  const gate = changeKey && fetched.key === changeKey ? fetched.gate : null;
  const gateLoading = !!changeKey && fetched.key !== changeKey;
  const displacing = !!gate && gate.impact.displaced.length > 0;
  const escalate = () =>
    startEscalate(async () => {
      if (!change) return setMsg("Set the new due date or priority first.");
      if (!reason.trim()) return setMsg("Say why first — Jordan decides from what you write.");
      const r = await escalateRushToJordan(job.projectId, change, reason).catch(() => ({ ok: false, message: "That didn't send — try again." }));
      if (!r.ok) return setMsg(r.message);
      onSaved(r.message);
      onClose();
    });

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
      if (gateLoading) return setMsg("Still checking what this moves ahead of — one moment.");
      // Jordan (the escalation) is shown the list but never made to fill a
      // form; James and Kyle tick and say why (the server holds the same line).
      const owner = gate?.authority.as === "OWNER";
      if (displacing && gate && !owner) {
        if (!gate.authority.may) return setMsg(gate.authority.why ?? "Only James or Kyle can approve this.");
        if (!ack) return setMsg("Tick that you've looked at the jobs this pushes back.");
        if (!reason.trim()) return setMsg("Say why — it goes on the timeline with your name.");
      }
      const rush = displacing && gate && (!owner || reason.trim()) ? { seen: gate.impact.displaced.map((j) => j.projectId), reason } : undefined;
      const res: { ok: boolean; message: string; rush?: RushGate } = await saveEditOverrides(job.projectId, r.input, rush).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      if (!res.ok) {
        // The server's list is the one that counts: show it, and ask again.
        if (res.rush) { setFetched({ key: changeKey, gate: res.rush }); setAck(false); }
        return setMsg(res.message || "That didn't save — try again.");
      }
      onSaved(res.message || "Override saved.");
      onClose();
    });

  // The shared native dialog sits above sticky headers and keeps the covered
  // page inert. Pending saves/escalations retain focus and cannot be dismissed.
  return (
      <ModalDialog
        label={`${rushOnly ? "Rush" : "Override"} ${job.street}`}
        busy={busy || escalating}
        onCancel={onClose}
        className="w-[min(94vw,36rem)] [&_button]:min-h-11 [&_button]:min-w-11"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              {rushOnly ? <Zap className="size-4 text-warning" /> : <SlidersHorizontal className="size-4 text-brand" />} {rushOnly ? "Rush" : "Override"} · {job.street}
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">
              {rushOnly
                ? "Pull the due date earlier or raise the priority. Before you save, you see which of the editor's jobs this pushes back. The date the client was promised stays on record."
                : "Whatever you set here wins over what the hub works out on its own. Clear a field to hand it back."}
            </p>
          </div>
          <button type="button" data-modal-initial-focus disabled={busy || escalating} onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
            <X className="size-4" />
          </button>
        </div>

        {rushOnly && ask && <RushAskNote ask={ask} />}

        <div className="mt-3 space-y-2">
          {/* STATUS — a pin, not a column: picking one writes it straight to
              the job and holds it there. */}
          {!rushOnly && <Field
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
          </Field>}

          {/* EDITOR — the row's own reassign control, here so one Save covers
              the whole hand-off. Routes through setEditVideoEditor. */}
          {!rushOnly && <Field label="Editor" overridden={false} hub={hubEditor} hint="moves the open task and pings the editor, like the row's select">
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
          </Field>}

          {/* VIDEOS OWED — the batch size: cut slots, the queue count and the
              monthly quota all follow it. */}
          {!rushOnly && <Field
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
          </Field>}

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

          <div className={cx("grid gap-2", !rushOnly && "sm:grid-cols-2")}>
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
            {!rushOnly && <Field
              label="Tier"
              overridden={d.tier !== ""}
              onReset={() => set({ tier: "" })}
              hub={TIER_LABEL[computed.tier]}
            >
              <select aria-label="Tier" value={d.tier} onChange={(e) => set({ tier: e.target.value as Draft["tier"] })} className={SELECT}>
                <option value="">Hub&rsquo;s value ({TIER_LABEL[computed.tier]})</option>
                {EDIT_TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select>
            </Field>}
          </div>

          {/* VIDEO TYPE — the row's "video type" text under the tier pill. */}
          {!rushOnly && <Field
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
          </Field>}

          {/* NOTE — the reason, one line; shows on the row's chip and the
              timeline sentence. A rush asks its own "why" below instead. */}
          {!rushOnly && <div className="rounded-xl border border-border px-3 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Note <span className="font-normal normal-case tracking-normal">— optional, one line</span></span>
            <input
              aria-label="Note"
              value={d.note}
              maxLength={300}
              placeholder="Why — shows on the row and the job's timeline"
              onChange={(e) => set({ note: e.target.value })}
              className={cx(INPUT, "mt-1.5 w-full")}
            />
          </div>}
        </div>

        {/* §10: what the new date / priority pushes back, before Save. */}
        {change && (
          <div className="mt-3">
            <RushPanel
              gate={gate}
              loading={gateLoading}
              ack={ack}
              onAck={(v) => { setAck(v); setMsg(null); }}
              reason={reason}
              onReason={(v) => { setReason(v); setMsg(null); }}
              onEscalate={escalate}
              escalating={escalating}
            />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={busy || (displacing && !!gate && !gate.authority.may)}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
          </button>
          <button type="button" disabled={busy || escalating} onClick={onClose} className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
            Cancel
          </button>
          {msg && <span role="status" className="text-sm font-medium text-warning">{msg}</span>}
        </div>
        {hasOverride(overrides) && (
          <p className="mt-2 text-[11px] text-muted-2">{provenance(overrides)}</p>
        )}
      </ModalDialog>
  );
}

/** The control that opens the dialog. `row` = the bare sliders glyph beside a
    queue row's status pill; `header` = the bordered button in the /edit
    header, which also wears the Override chip when one is set. onReceipt
    takes the server's sentence (the queue shows it above the tabs, where it
    survives the row moving to another view); without it, the sentence is
    shown as a note under the control. */
export function EditOverridesButton({
  job, variant = "row", onReceipt, renderTrigger, onDialogClose,
}: {
  job: EditOverridesJob;
  variant?: "row" | "header";
  onReceipt?: (msg: string) => void;
  renderTrigger?: (open: () => void) => ReactNode;
  onDialogClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const title = "Override this job — status, editor, videos owed, due date, priority, tier, video type";
  const saved = (m: string) => (onReceipt ? onReceipt(m) : setNote(m));
  return (
    <span className={variant === "header" ? "inline-flex flex-col items-end gap-1" : "inline-flex"}>
      {renderTrigger ? renderTrigger(() => setOpen(true)) : variant === "header" ? (
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
      {open && <OverridesDialog job={job} onClose={() => { setOpen(false); onDialogClose?.(); }} onSaved={saved} />}
    </span>
  );
}

// ---- THE JOB PAGE'S RUSH BUTTON (§10, Sep 28 2026) --------------------------
// The rush lived inside Override, under a due-date field nobody would read as
// "rush". This is the same dialog, the same server actions and the same guard
// (saveEditOverrides / previewPriorityImpact / escalateRushToJordan), opened on
// the two fields a rush is: the due date and the priority. What the change
// pushes back is shown before Save, and a rush someone sent to Jordan shows
// here, on the job, where it is approved. Mounted for the desk only (owner /
// admin, never an editor, never a "view as" preview); the server re-checks.

/** The ask someone sent to Jordan, above the fields. */
function RushAskNote({ ask }: { ask: RushAsk }) {
  return (
    <div className="mt-3 rounded-xl border border-warning/40 bg-warning-soft/30 px-3 py-2.5 text-[12px] leading-snug text-foreground">
      <div className="flex items-center gap-1.5 font-semibold">
        <Send className="size-3.5 text-warning" /> Waiting on approval{ask.by ? ` · sent by ${ask.by}` : ""}{ask.atISO ? ` · ${etDateTime(ask.atISO)} ET` : ""}
      </div>
      <p className="mt-1 text-foreground/90">{ask.words}</p>
      <p className="mt-1 text-[11px] text-muted">Set the same date or priority below and save to approve it. Cancel leaves the job as it is.</p>
    </div>
  );
}

export function RushButton({ job, ask = null }: { job: EditOverridesJob; ask?: RushAsk | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={ask ? "A rush on this job is waiting on approval" : "Rush this job: an earlier due date or a higher priority, with what it pushes back"}
        className={cx(
          "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium",
          ask ? "border-warning/50 bg-warning-soft/40 text-foreground" : "bg-surface text-muted hover:text-foreground",
        )}
      >
        <Zap className={cx("size-3.5", ask && "text-warning")} /> {ask ? "Rush asked" : "Rush"}
      </button>
      {note && (
        // Never wider than a phone's content column (375px, 16px gutters).
        <span className="flex max-w-[min(24rem,calc(100vw-2rem))] items-start gap-2 whitespace-normal rounded-lg border border-success/30 bg-success/10 px-2 py-1 text-left text-[11px] leading-snug text-foreground/90">
          <span className="min-w-0 flex-1">{note}</span>
          <button type="button" onClick={() => setNote(null)} aria-label="Dismiss" className="shrink-0 text-muted hover:text-foreground">
            <X className="size-3" />
          </button>
        </span>
      )}
      {open && <OverridesDialog job={job} mode="rush" ask={ask} onClose={() => setOpen(false)} onSaved={setNote} />}
    </span>
  );
}
