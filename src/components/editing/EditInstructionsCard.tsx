"use client";

import { useState, useTransition } from "react";
import { Check, ClipboardList, Loader2, Pencil, X } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { saveEditSpec } from "@/app/editing/actions";

// The Luma-order-form fields, per job: what the edit should sound and look
// like, in one card. Owner/admin edit in place; the editor sees it read-only —
// this is their spec, not their form.
export type EditSpec = {
  musicType?: string;
  colorProfile?: string;
  desiredLength?: string;
  instructions?: string;
};

const FIELDS = [
  { key: "musicType", label: "Music type", placeholder: "e.g. Up to the editor · Pop · Cinematic" },
  { key: "colorProfile", label: "Color profile", placeholder: "e.g. S-Log3, D-LogM · Rec709" },
  { key: "desiredLength", label: "Desired length", placeholder: "e.g. 45–60s" },
] as const;

export function EditInstructionsCard({ projectId, spec, canEdit }: { projectId: string; spec: EditSpec; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditSpec>(spec);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const empty = !spec.musicType && !spec.colorProfile && !spec.desiredLength && !spec.instructions;

  const save = () =>
    start(async () => {
      const r = await saveEditSpec(projectId, form);
      setNote(r.message);
      if (r.ok) setEditing(false);
    });

  return (
    <div className="rounded-2xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <ClipboardList className="size-4 text-brand" /> Edit instructions
        </span>
        {canEdit && !editing && (
          <button onClick={() => { setForm(spec); setEditing(true); setNote(null); }} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
            <Pencil className="size-3" /> {empty ? "Add" : "Edit"}
          </button>
        )}
        {editing && (
          <button onClick={() => setEditing(false)} className="text-muted hover:text-foreground"><X className="size-4" /></button>
        )}
      </div>
      <div className="p-4">
        {!editing ? (
          empty ? (
            <p className="text-sm text-muted">
              {canEdit ? "No instructions yet — add the music type, color profile, length and any notes for the editor." : "No special instructions on this one — cut it to the Style Guide."}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                {FIELDS.map((f) =>
                  spec[f.key] ? (
                    <div key={f.key}>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{f.label}</p>
                      <p className="mt-0.5 text-sm">{spec[f.key]}</p>
                    </div>
                  ) : null,
                )}
              </div>
              {spec.instructions && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Instructions</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">{spec.instructions}</p>
                </div>
              )}
            </div>
          )
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{f.label}</span>
                  <input
                    value={form[f.key] ?? ""}
                    onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                  />
                </label>
              ))}
            </div>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Instructions</span>
              <AutoTextarea
                value={form.instructions ?? ""}
                onChange={(e) => setForm((x) => ({ ...x, instructions: e.target.value }))}
                placeholder="Featured rooms, must-have shots, things to avoid, agent interactions to show…"
                minRows={3}
                className="mt-1 w-full rounded-lg border border-border bg-bg p-2.5 text-sm outline-none focus:border-brand"
              />
            </label>
            <button onClick={save} disabled={pending} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
            </button>
          </div>
        )}
        {note && <p className="mt-2 text-xs text-muted">{note}</p>}
      </div>
    </div>
  );
}
