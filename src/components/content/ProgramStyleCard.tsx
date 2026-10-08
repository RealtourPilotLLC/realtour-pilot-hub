"use client";

import { useState, useTransition } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { setProgramStyleAction } from "@/app/content/[id]/workspaceActions";

// ---------------------------------------------------------------------------
// PROGRAM STYLE (Oct 8 2026) — two switches per client, owner/admin.
//   Strategy calls          on | off
//   Client plans their own content (we show up and shoot)   on | off
// Each flips at once on screen; the server's answer replaces the note, and a
// refusal puts the switch back. See lib/programStyle.ts for what each does.
// ---------------------------------------------------------------------------

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

function Switch({ on, label, hint, onChange, disabled }: { on: boolean; label: string; hint: string; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[12px] text-muted">{hint}</p>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
        className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-brand" : "bg-surface-2 ring-1 ring-border-strong"} ${focusRing}`}>
        <span className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

export function ProgramStyleCard({ enrollmentId, strategyCalls, clientPlanned, canEdit }: { enrollmentId: string; strategyCalls: boolean; clientPlanned: boolean; canEdit: boolean }) {
  const [calls, setCalls] = useState(strategyCalls);
  const [planned, setPlanned] = useState(clientPlanned);
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
  return (
    <Section icon={SlidersHorizontal} title="Program style">
      <div className="divide-y divide-border">
        <Switch on={calls} disabled={!canEdit || busy} onChange={(v) => flip("strategyCalls", v)}
          label="Strategy calls"
          hint={calls ? "On — the month's planning call is part of their program." : "Off — no call step, no call reminders, nothing about booking a call."} />
        <Switch on={planned} disabled={!canEdit || busy} onChange={(v) => flip("clientPlanned", v)}
          label="Client plans their own content (we show up and shoot)"
          hint={planned ? "On — no topics, questions or scripts from us. They can add a brief for the month, and filming isn't held up by planning." : "Off — we plan topics and write scripts with them."} />
      </div>
      {!canEdit && <p className="mt-2 text-[12px] text-muted">The owner or an admin changes these.</p>}
      {note && <p role="status" className={`mt-2 text-[13px] ${note.ok ? "text-success" : "text-warning"}`}>{note.text}</p>}
    </Section>
  );
}
