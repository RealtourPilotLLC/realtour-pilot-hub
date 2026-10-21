"use client";

import { useState, useTransition } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { Switch } from "@/components/ui/Switch";
import { setProgramStyleAction } from "@/app/content/[id]/workspaceActions";

// ---------------------------------------------------------------------------
// PROGRAM STYLE (Oct 8 2026) — two switches per client, owner/admin.
//   Strategy calls          on | off
//   Client plans their own content (we show up and shoot)   on | off
// Each flips at once on screen; the server's answer replaces the note, and a
// refusal puts the switch back. See lib/programStyle.ts for what each does.
//
// Oct 13 2026: a third setting, VIDEO STYLE: Direct-to-camera · Skits (Jordan:
// "Some clients ... prefer more creative, skit-style videos"). Skits = script
// drafts and revisions are short skits in the same framework, the client
// alone on camera, and topic ideas are skit concepts. Default Direct-to-camera.
// ---------------------------------------------------------------------------

type VideoStyle = "DIRECT" | "SKITS";
const VIDEO_STYLES: { value: VideoStyle; label: string; hint: string }[] = [
  { value: "DIRECT", label: "Direct-to-camera", hint: "Scripts are written to camera in the house framework. Topic ideas are straight topics." },
  { value: "SKITS", label: "Skits", hint: "Scripts are short comedic skits in the same framework, with the client alone on camera (off-camera voices, props, on-screen text). Topic ideas are skit concepts." },
];

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

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

export function ProgramStyleCard({ enrollmentId, strategyCalls, clientPlanned, videoStyle, canEdit }: { enrollmentId: string; strategyCalls: boolean; clientPlanned: boolean; videoStyle: VideoStyle; canEdit: boolean }) {
  const [calls, setCalls] = useState(strategyCalls);
  const [planned, setPlanned] = useState(clientPlanned);
  const [style, setStyle] = useState<VideoStyle>(videoStyle);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const flip = (key: "strategyCalls" | "clientPlanned", v: boolean) => {
    const undo = key === "strategyCalls" ? () => setCalls(!v) : () => setPlanned(!v);
    if (key === "strategyCalls") setCalls(v); else setPlanned(v); // instant
    start(async () => {
      const r = await setProgramStyleAction(enrollmentId, { [key]: v }).catch(() => ({ ok: false, message: "That wasn't saved — reload and try again." }));
      if (!r.ok) undo();
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
        <SwitchRow on={calls} disabled={!canEdit || busy} onChange={(v) => flip("strategyCalls", v)}
          label="Strategy calls"
          hint={calls ? "On — the month's planning call is part of their program." : "Off — no call step, no call reminders, nothing about booking a call."} />
        <SwitchRow on={planned} disabled={!canEdit || busy} onChange={(v) => flip("clientPlanned", v)}
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
                className={`px-2.5 py-1 ${style === o.value ? "bg-brand-action font-semibold text-white" : "text-muted hover:bg-surface-2"} disabled:cursor-default disabled:opacity-60 ${focusRing}`}>
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
