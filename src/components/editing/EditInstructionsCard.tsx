"use client";

import { useState, useTransition } from "react";
import { Check, ClipboardList, Loader2, Pencil, Star, X } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { Section } from "@/components/ui/Section";
import { JobNoteEditor } from "@/components/editing/JobNoteEditor";
import { saveEditSpec } from "@/app/editing/actions";

// ---------------------------------------------------------------------------
// ONE card for everything the editor is told to do (Jordan, Sep 2: "Edit
// instructions and Edit notes are the same thing — merge into one card").
// It carries, in the order an editor reads them:
//   1. the spec — how it should sound, look and run (Luma-form fields, plus
//      the batch size the photographer actually filmed);
//   2. the customer's own words on THIS order;
//   3. what came off the shoot — the photographer's brief, per-deliverable
//      notes and any special request. Only when there IS something: Jordan
//      (Sep 2) doesn't want the editor told "no editing notes were submitted"
//      — that a photographer skipped the brief is the admin's information,
//      and Ops Day's QC card already says it to them. The photo retouch list
//      ("Remove in editing") is likewise not here any more: it is Kyle's QC
//      job, shown on the Ops Day QC card and the project page, not a video
//      editor's instruction. Nor is the SHOT ORDER (Jordan, Sep 2, round 3:
//      "Shot order does not need to be shown because the photographers
//      organize their video files into folders") — admins still read it in
//      the project page's shoot debrief.
//   4. our own note for the job, LAST and called "Additional notes" (Jordan,
//      Sep 2, round 3: "Note for this job should be below editing notes and
//      labeled additional notes" — it used to sit above the shoot section).
// Owner/admin edit in place; the editor reads. Money is already scrubbed by
// the caller for creative eyes.
// ---------------------------------------------------------------------------
export type EditSpec = {
  musicType?: string;
  colorProfile?: string;
  desiredLength?: string;
  instructions?: string;
};

// Everything the old "Editing notes" and "Customer notes" cards used to show
// that is an INSTRUCTION (the client's standing style preferences are client
// context and live beside their profile, not here).
export type EditBrief = {
  /** Owner/admin/photographer may rewrite the two job notes; editors read. */
  canEditNotes: boolean;
  /** The customer's own words from the Aryeo order intake. */
  orderNote: string | null;
  /** Project.notes ("Additional notes") — RAW for whoever can edit, scrubbed for everyone else. */
  jobNote: string | null;
  /** Project.editorBrief — what the photographer wrote at upload. */
  editorBrief: string | null;
  videoInstructions: string | null;
  // No shotOrderNotes and no removalNotes here on purpose — see the header.
  // The shot order is a folder walk the editor never needs; the retouch list
  // stays with QC (opsDay.ts → Ops Day "From the shoot", projects/[id] "Shoot
  // debrief", the editor-brief PDF); this card is what the VIDEO editor cuts.
  videosFilmed: number | null;
  scriptConfirmNote: string | null;
  deliverableNotes: { id: string; label: string; notes: string }[];
  specialRequests: { id: string; body: string }[];
};

const FIELDS = [
  { key: "musicType", label: "Music type", placeholder: "e.g. Up to the editor · Pop · Cinematic" },
  { key: "colorProfile", label: "Color profile", placeholder: "e.g. S-Log3, D-LogM · Rec709" },
  { key: "desiredLength", label: "Desired length", placeholder: "e.g. 45–60s" },
] as const;

function Para({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">{label}</div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{text}</p>
    </div>
  );
}

export function EditInstructionsCard({
  projectId,
  spec,
  canEdit,
  brief,
}: {
  projectId: string;
  spec: EditSpec;
  canEdit: boolean;
  brief: EditBrief;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditSpec>(spec);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const specEmpty = !spec.musicType && !spec.colorProfile && !spec.desiredLength && !spec.instructions;
  // A whitespace-only brief is no brief — the upload portal trims before
  // saving, but older rows and the in-place editor may not have.
  const shootBrief = brief.editorBrief?.trim() || null;
  // Exactly what section 3 prints, nothing more — "videos filmed" is a fact in
  // section 1, so it does not keep an otherwise-empty shoot section alive.
  const shootEmpty =
    !shootBrief && !brief.videoInstructions && !brief.scriptConfirmNote &&
    brief.deliverableNotes.length === 0 && brief.specialRequests.length === 0;
  // The job note always renders for whoever may write it (it carries its own
  // "add a note" affordance), so "empty" is only about the read-only material
  // around it.
  const nothingAtAll =
    specEmpty && shootEmpty && brief.videosFilmed == null && !brief.orderNote && !brief.jobNote;

  const save = () =>
    start(async () => {
      const r = await saveEditSpec(projectId, form);
      setNote(r.message);
      if (r.ok) setEditing(false);
    });

  // The quick facts — how it should sound, look, run, and how many to cut.
  const facts: { label: string; value: string; hint?: string; strong?: boolean }[] = [
    ...FIELDS.flatMap((f) => (spec[f.key] ? [{ label: f.label, value: spec[f.key] as string }] : [])),
    ...(brief.videosFilmed != null
      ? [{ label: "Videos to cut", value: String(brief.videosFilmed), hint: "filmed on this session", strong: true }]
      : []),
  ];

  return (
    <Section
      icon={ClipboardList}
      title="Edit instructions"
      action={
        canEdit ? (
          editing ? (
            <button onClick={() => setEditing(false)} className="text-muted hover:text-foreground" aria-label="Stop editing">
              <X className="size-4" />
            </button>
          ) : (
            <button
              onClick={() => { setForm(spec); setEditing(true); setNote(null); }}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <Pencil className="size-3" /> {specEmpty ? "Add spec" : "Edit spec"}
            </button>
          )
        ) : null
      }
    >
      {editing ? (
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
          {note && <p className="text-xs text-muted">{note}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          {nothingAtAll && (
            <p className="text-sm text-muted">
              {canEdit
                ? "Nothing on this job yet — add the music type, color profile, length and any notes for the editor."
                : "No special instructions on this one — cut it to the Style Guide."}
            </p>
          )}

          {/* 1 — THE SPEC: how it should sound, look and run. */}
          {facts.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {facts.map((f) => (
                <div key={f.label}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{f.label}</p>
                  <p className="mt-0.5 text-sm">
                    <span className={f.strong ? "text-base font-semibold text-brand" : ""}>{f.value}</span>
                    {f.hint && <span className="text-muted"> {f.hint}</span>}
                  </p>
                </div>
              ))}
            </div>
          )}
          {spec.instructions && <Para label="Instructions" text={spec.instructions} />}

          {/* 2 — THE CUSTOMER'S OWN WORDS on this order. Theirs, kept apart
              from ours on purpose — our note for the job is section 4, under
              everything the shoot produced. */}
          {brief.orderNote && (
            <div className="border-t border-border pt-4">
              <div className="rounded-lg border-l-2 border-brand/50 bg-surface-2/60 px-3 py-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-brand">From their order</div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{brief.orderNote}</p>
              </div>
            </div>
          )}

          {/* 3 — WHAT CAME OFF THE SHOOT. The photographer's brief is the
              anchor; everything else qualifies it. The whole section, and the
              brief inside it, only render when there is something to read —
              an empty "From the shoot" is the admin's news, not the editor's
              (Jordan, Sep 2), and Ops Day's QC card already carries it. */}
          {!shootEmpty && (
            <div className="space-y-3 border-t border-border pt-4">
              {shootBrief && (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">From the shoot</div>
                  {/* Still a JobNoteEditor so owner/admin/photographer can fix a
                      brief that exists; `empty` is only reachable by the person
                      who just cleared it — the next load hides the section. */}
                  <JobNoteEditor
                    projectId={projectId}
                    field="shoot"
                    value={shootBrief}
                    canEdit={brief.canEditNotes}
                    label=""
                    placeholder="What the editor needs to know from the shoot…"
                    empty="Cleared."
                  />
                </div>
              )}
              {brief.videoInstructions && <Para label="Video — instructions from the shoot" text={brief.videoInstructions} />}
              {brief.deliverableNotes.length > 0 && (
                <ul className="space-y-1.5">
                  {brief.deliverableNotes.map((d) => (
                    <li key={d.id} className="text-sm text-foreground/85">
                      <span className="font-medium">{d.label}:</span> {d.notes}
                    </li>
                  ))}
                </ul>
              )}
              {brief.specialRequests.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
                    <Star className="size-3.5" /> Special requests
                  </div>
                  {brief.specialRequests.map((a) => (
                    <p key={a.id} className="whitespace-pre-wrap text-sm text-foreground/85">{a.body}</p>
                  ))}
                </div>
              )}
              {brief.scriptConfirmNote && (
                <p className="text-[13px] text-muted">
                  Script: <span className="text-foreground/85">{brief.scriptConfirmNote}</span> — the confirmed text is in the Script card below.
                </p>
              )}
            </div>
          )}

          {/* 4 — ADDITIONAL NOTES: our own note for the job, LAST — under the
              editing notes, where Jordan asked for it (Sep 2, round 3). It
              always renders for whoever may write it (the "add a note"
              affordance lives inside JobNoteEditor), otherwise only when a
              note exists. The heading is ours, not JobNoteEditor's — its own
              label only appears once something is saved, which left an
              unlabelled "Nothing added." floating on the card. */}
          {(brief.canEditNotes || brief.jobNote) && (
            <div className="border-t border-border pt-4">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-2">Additional notes</div>
              <JobNoteEditor
                projectId={projectId}
                field="customer"
                value={brief.jobNote}
                canEdit={brief.canEditNotes}
                label=""
                placeholder="Anything else the editor should know about this customer or job…"
                empty="Nothing added."
              />
            </div>
          )}

          {note && <p className="text-xs text-muted">{note}</p>}
        </div>
      )}
    </Section>
  );
}
