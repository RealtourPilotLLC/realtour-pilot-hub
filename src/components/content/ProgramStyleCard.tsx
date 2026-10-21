"use client";

import { useState, useTransition } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { Switch } from "@/components/ui/Switch";
import { setCallModeAction, setProgramStyleAction } from "@/app/content/[id]/workspaceActions";

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
// ONE CALL-MODE CONTROL (Jordan, Oct 21 2026; audit D13). The Settings tab
// had a second one ("Planning & call requirement") whose own hint said it was
// "the same as Program style's Strategy calls off". The calls row here is now
// the only one, with all three modes and the written-answers choice; it saves
// through the same ledgered setter that form used (setCallModeAction).
// ---------------------------------------------------------------------------

type VideoStyle = "DIRECT" | "SKITS";
type CallMode = "REQUIRED" | "OPTIONAL_WRITTEN" | "NOT_INCLUDED";
const VIDEO_STYLES: { value: VideoStyle; label: string; hint: string }[] = [
  { value: "DIRECT", label: "Direct-to-camera", hint: "Scripts are written to camera in the house framework. Topic ideas are straight topics." },
  { value: "SKITS", label: "Skits", hint: "Scripts are short comedic skits in the same framework, with the client alone on camera (off-camera voices, props, on-screen text). Topic ideas are skit concepts." },
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

export function ProgramStyleCard({ enrollmentId, callMode, callModeExplicit, noCallEligible, clientPlanned, videoStyle, canEdit }: {
  enrollmentId: string;
  callMode: CallMode;
  /** false = the program default (no column set): the first call is required, later months may be written. */
  callModeExplicit: boolean;
  noCallEligible: boolean | null;
  clientPlanned: boolean;
  videoStyle: VideoStyle;
  canEdit: boolean;
}) {
  const [mode, setMode] = useState<CallMode>(callMode);
  const [explicit, setExplicit] = useState(callModeExplicit);
  const [eligible, setEligible] = useState<boolean>(noCallEligible === true);
  const [planned, setPlanned] = useState(clientPlanned);
  const [style, setStyle] = useState<VideoStyle>(videoStyle);
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
  const pickStyle = (v: VideoStyle) => {
    if (v === style) return;
    const was = style;
    setStyle(v); // instant
    start(async () => {
      const r = await setProgramStyleAction(enrollmentId, { videoStyle: v }).catch(() => ({ ok: false, message: "That wasn't saved. Reload and try again." }));
      if (!r.ok) setStyle(was);
      setNote({ ok: r.ok, text: r.message });
    });
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
        </div>
      </div>
      {!canEdit && <p className="mt-2 text-[12px] text-muted">The owner or an admin changes these.</p>}
      {note && <p role="status" className={`mt-2 text-[13px] ${note.ok ? "text-success" : "text-warning"}`}>{note.text}</p>}
    </Section>
  );
}
