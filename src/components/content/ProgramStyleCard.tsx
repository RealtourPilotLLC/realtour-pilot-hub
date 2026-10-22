"use client";

import { useState, useTransition } from "react";
import { SlidersHorizontal, UserPlus, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { Switch } from "@/components/ui/Switch";
import { setCallModeAction, setProgramStyleAction, setSkitCastAction } from "@/app/content/[id]/workspaceActions";
import { DEFAULT_MIX_SKITS_PER_MONTH, MAX_SKITS_PER_MONTH, castMemberLabel, type SkitCastMember, type VideoStyle } from "@/lib/contentPolicy/videoFormat";

// ---------------------------------------------------------------------------
// PROGRAM STYLE (Oct 8 2026) — how this client's program runs, owner/admin.
//   Strategy calls          Required · Optional · Off
//   Client plans their own content (we show up and shoot)   on | off
// Each flips at once on screen; the server's answer replaces the note, and a
// refusal puts the control back. See lib/programStyle.ts for what each does.
//
// Oct 13 2026: a third setting, VIDEO STYLE: Direct-to-camera · Skits (Jordan:
// "Some clients ... prefer more creative, skit-style videos"). Skits = script
// drafts and revisions are short skits in the same framework, the client
// alone on camera, and topic ideas are skit concepts. Default Direct-to-camera.
//
// Oct 22 2026 (Bernadette Rabel's call): a third choice, Mix, with its
// target number of skits a month (2 unless typed). The style is the default
// for topics; each topic can be switched on its card (Topics). And the SKIT
// CAST: people the client confirmed may act in their skits, with a short note
// for the writer ("A voice impressionist. Happy to act.").
//
// ONE CALL-MODE CONTROL (Jordan, Oct 21 2026; audit D13). The Settings tab
// had a second one ("Planning & call requirement") whose own hint said it was
// "the same as Program style's Strategy calls off". The calls row here is now
// the only one, with all three modes and the written-answers choice; it saves
// through the same ledgered setter that form used (setCallModeAction).
// ---------------------------------------------------------------------------

type CallMode = "REQUIRED" | "OPTIONAL_WRITTEN" | "NOT_INCLUDED";
const VIDEO_STYLES: { value: VideoStyle; label: string; hint: string }[] = [
  { value: "DIRECT", label: "Direct-to-camera", hint: "Scripts are written to camera in the house framework. Topic ideas are straight topics. A topic marked Skit on its card is still written as a skit." },
  { value: "SKITS", label: "Skits", hint: "Scripts are short comedic skits in the same framework: the client alone on camera, or with a cast member below. Topic ideas are skit concepts. A topic marked Talking to camera is written to camera." },
  { value: "MIX", label: "Mix", hint: "Mostly talking to camera, plus a few skits a month. Topics are talking to camera unless marked Skit on their card, and topic ideas include skit concepts. The month shows how many skits are picked; nothing is blocked." },
];
const CALL_MODES: { value: CallMode; label: string }[] = [
  { value: "REQUIRED", label: "Required" },
  { value: "OPTIONAL_WRITTEN", label: "Optional" },
  { value: "NOT_INCLUDED", label: "Off" },
];

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const segment = (on: boolean) => `min-h-9 px-2.5 py-1 ${on ? "bg-brand-action font-semibold text-white" : "text-muted hover:bg-surface-2"} disabled:cursor-default disabled:opacity-60 ${focusRing}`;

function SwitchRow({ on, label, hint, onChange, disabled }: { on: boolean; label: string; hint: string; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[12px] text-muted">{hint}</p>
      </div>
      <Switch checked={on} onChange={onChange} aria-label={label} disabled={disabled} className="-mt-2.5" />
    </div>
  );
}

function callHint(mode: CallMode, explicit: boolean): string {
  if (mode === "NOT_INCLUDED") return "Off: no call step, no call reminders, nothing about booking a call.";
  if (mode === "OPTIONAL_WRITTEN") return "Optional: they may plan the month with a call or in writing, picking topics and answering questions in the portal.";
  return explicit
    ? "Required: the month does not start until the strategy call happens."
    : "Required for the first call (the program default). Later months may be planned in writing.";
}

export function ProgramStyleCard({ enrollmentId, callMode, callModeExplicit, noCallEligible, clientPlanned, videoStyle, skitsPerMonth = null, cast = [], canEdit }: {
  enrollmentId: string;
  callMode: CallMode;
  /** false = the program default (no column set): the first call is required, later months may be written. */
  callModeExplicit: boolean;
  noCallEligible: boolean | null;
  clientPlanned: boolean;
  videoStyle: VideoStyle;
  /** A Mix account's target number of skits a month. */
  skitsPerMonth?: number | null;
  /** People the client confirmed may act in their skits. */
  cast?: SkitCastMember[];
  canEdit: boolean;
}) {
  const [mode, setMode] = useState<CallMode>(callMode);
  const [explicit, setExplicit] = useState(callModeExplicit);
  const [eligible, setEligible] = useState<boolean>(noCallEligible === true);
  const [planned, setPlanned] = useState(clientPlanned);
  const [style, setStyle] = useState<VideoStyle>(videoStyle);
  const [target, setTarget] = useState<string>(String(skitsPerMonth ?? DEFAULT_MIX_SKITS_PER_MONTH));
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const saveCalls = (next: CallMode, nextEligible: boolean) => {
    const was = { mode, explicit, eligible };
    setMode(next); setExplicit(true); setEligible(nextEligible); // instant
    start(async () => {
      const r = await setCallModeAction(enrollmentId, next, next === "OPTIONAL_WRITTEN" ? nextEligible : null, "Program style").catch(() => ({ ok: false, message: "That wasn't saved. Reload and try again." }));
      if (!r.ok) { setMode(was.mode); setExplicit(was.explicit); setEligible(was.eligible); }
      setNote({ ok: r.ok, text: r.message });
    });
  };
  const flipPlanned = (v: boolean) => {
    setPlanned(v); // instant
    start(async () => {
      const r = await setProgramStyleAction(enrollmentId, { clientPlanned: v }).catch(() => ({ ok: false, message: "That wasn't saved. Reload and try again." }));
      if (!r.ok) setPlanned(!v);
      setNote({ ok: r.ok, text: r.message });
    });
  };
  const pickStyle = (v: VideoStyle, perMonth?: number) => {
    if (v === style && perMonth === undefined) return;
    const was = style;
    setStyle(v); // instant
    start(async () => {
      const r = await setProgramStyleAction(enrollmentId, { videoStyle: v, ...(v === "MIX" ? { skitsPerMonth: perMonth ?? (Number(target) || DEFAULT_MIX_SKITS_PER_MONTH) } : {}) }).catch(() => ({ ok: false, message: "That wasn't saved. Reload and try again." }));
      if (!r.ok) setStyle(was);
      setNote({ ok: r.ok, text: r.message });
    });
  };
  const saveTarget = () => {
    const n = Number(target);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SKITS_PER_MONTH) { setNote({ ok: false, text: `Skits a month is a whole number from 1 to ${MAX_SKITS_PER_MONTH}.` }); return; }
    if (n === skitsPerMonth) return;
    pickStyle("MIX", n);
  };
  const styleHint = VIDEO_STYLES.find((o) => o.value === style)?.hint ?? "";
  return (
    <Section icon={SlidersHorizontal} title="Program style">
      <div className="divide-y divide-border">
        <div className="py-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-sm font-medium" id={`call-mode-${enrollmentId}`}>Strategy calls</p>
              <p className="text-[12px] text-muted">{callHint(mode, explicit)}</p>
            </div>
            <div role="group" aria-labelledby={`call-mode-${enrollmentId}`} className="inline-flex shrink-0 overflow-hidden rounded-md border border-border text-[12px]">
              {CALL_MODES.map((o) => (
                <button key={o.value} type="button" aria-pressed={mode === o.value} disabled={!canEdit || busy}
                  onClick={() => { if (o.value !== mode) saveCalls(o.value, eligible); }}
                  className={segment(mode === o.value)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {mode === "OPTIONAL_WRITTEN" && (
            <label className="mt-1.5 flex min-h-9 items-center gap-2 text-[13px]">
              <input type="checkbox" checked={eligible} disabled={!canEdit || busy} onChange={(e) => saveCalls("OPTIONAL_WRITTEN", e.target.checked)} />
              Offer them the &ldquo;plan without a call&rdquo; choice in the portal
            </label>
          )}
        </div>
        <SwitchRow on={planned} disabled={!canEdit || busy} onChange={flipPlanned}
          label="Client plans their own content (we show up and shoot)"
          hint={planned ? "On — no topics, questions or scripts from us. They can add a brief for the month, and filming isn't held up by planning." : "Off — we plan topics and write scripts with them."} />
        <div className="flex flex-wrap items-start justify-between gap-3 py-2">
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-sm font-medium" id={`video-style-${enrollmentId}`}>Video style</p>
            <p className="text-[12px] text-muted">{styleHint}</p>
          </div>
          <div role="group" aria-labelledby={`video-style-${enrollmentId}`} className="inline-flex shrink-0 overflow-hidden rounded-md border border-border text-[12px]">
            {VIDEO_STYLES.map((o) => (
              <button key={o.value} type="button" title={o.hint} aria-pressed={style === o.value} disabled={!canEdit || busy} onClick={() => pickStyle(o.value)}
                className={segment(style === o.value)}>
                {o.label}
              </button>
            ))}
          </div>
          {style === "MIX" && (
            <label className="flex w-full flex-wrap items-center gap-2 text-[13px]">
              Skits a month
              <input type="number" min={1} max={MAX_SKITS_PER_MONTH} step={1} value={target} disabled={!canEdit || busy}
                onChange={(e) => setTarget(e.target.value)} onBlur={saveTarget} onKeyDown={(e) => { if (e.key === "Enter") saveTarget(); }}
                aria-label="Skits a month" className={`min-h-9 w-16 rounded-md border border-border bg-surface-2 px-2 py-1 text-sm ${focusRing}`} />
              <span className="text-[12px] text-muted">the rest are talking to camera</span>
            </label>
          )}
        </div>
        {style !== "DIRECT" || cast.length > 0 ? <SkitCast enrollmentId={enrollmentId} cast={cast} canEdit={canEdit} onNote={setNote} /> : null}
      </div>
      {!canEdit && <p className="mt-2 text-[12px] text-muted">The owner or an admin changes these.</p>}
      {note && <p role="status" className={`mt-2 text-[13px] ${note.ok ? "text-success" : "text-warning"}`}>{note.text}</p>}
    </Section>
  );
}

/**
 * THE SKIT CAST (Oct 22 2026): who, besides the client, may act in their
 * skits, as the client confirmed. The writer gives one of them a few short
 * lines at most; nobody else is written in.
 */
function SkitCast({ enrollmentId, cast, canEdit, onNote }: { enrollmentId: string; cast: SkitCastMember[]; canEdit: boolean; onNote: (n: { ok: boolean; text: string }) => void }) {
  const [list, setList] = useState<SkitCastMember[]>(cast);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ role: "", name: "", note: "" });
  const [busy, start] = useTransition();
  const add = () => start(async () => {
    const r: { ok: boolean; message: string; cast?: SkitCastMember[] } = await setSkitCastAction(enrollmentId, { add: { role: f.role, name: f.name || null, note: f.note || null } }).catch(() => ({ ok: false, message: "That wasn't saved. Reload and try again." }));
    if (r.ok) { if (r.cast) setList(r.cast); setF({ role: "", name: "", note: "" }); setAdding(false); }
    onNote({ ok: r.ok, text: r.message });
  });
  const remove = (m: SkitCastMember) => start(async () => {
    const r: { ok: boolean; message: string; cast?: SkitCastMember[] } = await setSkitCastAction(enrollmentId, { removeId: m.id }).catch(() => ({ ok: false, message: "That wasn't saved. Reload and try again." }));
    if (r.ok) setList(r.cast ?? list.filter((x) => x.id !== m.id));
    onNote({ ok: r.ok, text: r.message });
  });
  return (
    <div className="py-2">
      <p className="text-sm font-medium">Skit cast</p>
      <p className="text-[12px] text-muted">People the client confirmed may act in their skits. By default the client is alone on camera; a skit may give one of these people a few short lines, and nobody else is written in.</p>
      {list.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {list.map((m) => (
            <li key={m.id} className="flex items-start gap-2 text-[13px]">
              <span className="min-w-0 flex-1"><span className="font-medium">{castMemberLabel(m)}</span>{m.note ? <span className="text-muted">: {m.note}</span> : null}</span>
              {canEdit && <button type="button" disabled={busy} onClick={() => remove(m)} aria-label={`Take ${castMemberLabel(m)} off the skit cast`} className={`rounded-md border border-border p-1 text-muted hover:text-danger disabled:opacity-50 ${focusRing}`}><X className="size-3" /></button>}
            </li>
          ))}
        </ul>
      )}
      {list.length === 0 && <p className="mt-1 text-[12px] text-muted-2">Nobody yet: every skit is written for the client alone.</p>}
      {canEdit && (adding ? (
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          <input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} maxLength={60} placeholder="Who they are to the client, e.g. Spouse" aria-label="Who they are to the client" className={`min-h-9 rounded border border-border bg-surface-2 px-2 py-1 text-sm ${focusRing}`} />
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} placeholder="First name (optional)" aria-label="First name" className={`min-h-9 rounded border border-border bg-surface-2 px-2 py-1 text-sm ${focusRing}`} />
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={240} placeholder="For the writer, e.g. a voice impressionist, happy to act" aria-label="A note for the writer" className={`min-h-9 rounded border border-border bg-surface-2 px-2 py-1 text-sm sm:col-span-2 ${focusRing}`} />
          <div className="flex gap-1.5 sm:col-span-2">
            <button type="button" disabled={busy || !f.role.trim()} onClick={add} className={`min-h-9 rounded-md bg-brand-action px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50 ${focusRing}`}>Add to the cast</button>
            <button type="button" onClick={() => setAdding(false)} className={`min-h-9 rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 ${focusRing}`}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`mt-1.5 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-brand hover:underline ${focusRing}`}><UserPlus className="size-3.5" /> Add someone the client confirmed</button>
      ))}
    </div>
  );
}
