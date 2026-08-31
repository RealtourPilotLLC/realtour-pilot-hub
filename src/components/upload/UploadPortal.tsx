"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Upload,
  CheckCircle2,
  Circle,
  AlertTriangle,
  Star,
  Flag,
  FileText,
  Loader2,
  Camera,
  Scissors,
  Eraser,
  Clapperboard,
} from "lucide-react";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { markDeliverableUploaded, flagIssue, finalizeUpload } from "@/app/upload/actions";
import { cn } from "@/lib/utils";
import type { DeliverableType, DeliverableStatus } from "@prisma/client";
import { etDateTime } from "@/lib/datetime";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// ---------------------------------------------------------------------------
// The shoot debrief portal (rebuilt Aug 31 2026 per Jordan). Files go to
// Dropbox directly — THIS page is where the photographer and the office get
// aligned: confirm the cull against the standard, name what the editor must
// remove, confirm the video script + hand over instructions, tick off the
// uploads, and debrief the shoot. The job is not done until it's all here.
// ---------------------------------------------------------------------------

type Deliverable = {
  id: string;
  type: DeliverableType;
  quantity: number;
  status: DeliverableStatus;
  uploadedAt: string | null;
};

const DETECTED: DeliverableStatus[] = ["UPLOADED", "IN_PROGRESS", "DONE"];
function initialUploaded(d: Deliverable): boolean {
  return d.uploadedAt != null || DETECTED.includes(d.status);
}

const NOTHING_SENTINEL = "Nothing needs removal — confirmed by the photographer.";

export function UploadPortal({
  project,
  deliverables,
  specialRequests,
  flags: initialFlags,
  policy,
  script,
}: {
  project: {
    id: string;
    title: string;
    addressLine: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    packageName: string | null;
    shootDate: string | null;
    status: string;
    editorBrief: string | null;
    uploadedAt: string | null;
    editorPdfPath: string | null;
    clientName: string;
    editingPreferences: string | null;
    photographerName: string | null;
    cullingConfirmedAt: string | null;
    removalNotes: string | null;
    videoInstructions: string | null;
    scriptConfirmedAt: string | null;
    scriptConfirmNote: string | null;
  };
  deliverables: Deliverable[];
  specialRequests: string[];
  flags: string[];
  policy: {
    photosOrdered: boolean;
    videoOrdered: boolean;
    photoTarget: number;
    squareFeet: number | null;
  };
  /** the shoot script pulled from Script Studio (null = none exists there) */
  script: { body: string; hook: string | null; url: string | null } | null;
}) {
  const [uploaded, setUploaded] = useState<Record<string, boolean>>(
    Object.fromEntries(deliverables.map((d) => [d.id, initialUploaded(d)])),
  );
  const [editorBrief, setEditorBrief] = useState(project.editorBrief ?? "");
  const [flags, setFlags] = useState(initialFlags);
  const [flagInput, setFlagInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [, startToggle] = useTransition();
  const [done, setDone] = useState(project.uploadedAt != null);
  const [pdfPath, setPdfPath] = useState<string | null>(project.editorPdfPath);
  const [err, setErr] = useState<string | null>(null);

  // --- Debrief state (prefilled from prior submits — re-opening never re-asks). ---
  const [cullOk, setCullOk] = useState(!!project.cullingConfirmedAt);
  const priorNothing = project.removalNotes === NOTHING_SENTINEL;
  const [removal, setRemoval] = useState(priorNothing ? "" : project.removalNotes ?? "");
  const [nothingToRemove, setNothingToRemove] = useState(priorNothing);
  const [vidInstructions, setVidInstructions] = useState(project.videoInstructions ?? "");
  const [scriptChoice, setScriptChoice] = useState<"as-written" | "edited" | null>(
    project.scriptConfirmedAt
      ? project.scriptConfirmNote?.startsWith("Edited") ? "edited" : "as-written"
      : null,
  );
  const [scriptText, setScriptText] = useState(script?.body ?? "");
  // Re-hydrate the "what changed" detail so a re-submit can't wipe it.
  const [scriptNote, setScriptNote] = useState(
    project.scriptConfirmNote?.startsWith("Edited on site — ")
      ? project.scriptConfirmNote.slice("Edited on site — ".length)
      : "",
  );

  const addr = [project.addressLine, project.city, project.state, project.zip].filter(Boolean).join(", ");
  const total = deliverables.length;
  const doneCount = Object.values(uploaded).filter(Boolean).length;
  const remaining = deliverables.filter((d) => !uploaded[d.id]);

  function toggle(id: string) {
    const next = !uploaded[id];
    setUploaded((u) => ({ ...u, [id]: next }));
    startToggle(async () => {
      try {
        await markDeliverableUploaded(id, next);
      } catch {
        setUploaded((u) => ({ ...u, [id]: !next }));
        setErr("Couldn’t save that — check your connection and try again.");
      }
    });
  }

  function submitFlag() {
    const body = flagInput.trim();
    if (!body) return;
    setFlags((prev) => [body, ...prev]);
    setFlagInput("");
    startTransition(async () => {
      await flagIssue(project.id, body);
    });
  }

  // What still blocks the submit — same rules the server enforces.
  function missingItems(): string[] {
    const missing: string[] = [];
    if (policy.photosOrdered && !cullOk) missing.push("confirm the cull (photo standard section)");
    if (policy.photosOrdered && !removal.trim() && !nothingToRemove) missing.push("answer the removal notes");
    if (policy.videoOrdered && !vidInstructions.trim()) missing.push("video instructions for the editor");
    if (policy.videoOrdered && script && !scriptChoice) missing.push("confirm the script");
    if (policy.videoOrdered && scriptChoice === "edited" && !scriptText.trim()) missing.push("the edited script text (or pick “Delivered as written”)");
    return missing;
  }

  function finalize() {
    const missing = missingItems();
    if (missing.length > 0) {
      setErr(`Not done yet — ${missing.join(" · ")}. The job isn't finished until everything on this page is answered.`);
      return;
    }
    if (remaining.length > 0) {
      const ok = window.confirm(
        `${remaining.length} item${remaining.length === 1 ? " isn’t" : "s aren’t"} checked off yet ` +
          `(${remaining.map((d) => DELIVERABLE_META[d.type].label).join(", ")}).\n\nSubmit to editors anyway?`,
      );
      if (!ok) return;
    }
    setErr(null);
    const payload = {
      editorBrief,
      cullingConfirmed: cullOk,
      removalNotes: removal,
      nothingToRemove,
      videoInstructions: vidInstructions,
      scriptConfirm: scriptChoice
        ? { state: scriptChoice, ...(scriptChoice === "edited" ? { script: scriptText, note: scriptNote } : {}) }
        : null,
      sawScript: !!script,
    };
    startTransition(async () => {
      try {
        let res = await finalizeUpload(project.id, payload);
        if (res.blocked) { setErr(res.blocked); return; }
        if (res.needsConfirm) {
          const proceed = window.confirm(res.warning ?? "Some ordered items look missing. Submit anyway?");
          if (!proceed) return;
          res = await finalizeUpload(project.id, { ...payload, force: true });
          if (res.blocked) { setErr(res.blocked); return; }
        }
        if (res.pdfPath) setPdfPath(res.pdfPath);
        setDone(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {
        setErr("Couldn’t submit — the editors were NOT notified. Please try again.");
      }
    });
  }

  const checkbox = "size-4 shrink-0 accent-[var(--brand)]";

  return (
    <div className="mt-3 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
        <div className="mt-1 text-sm text-muted">
          {addr && <span>{addr} · </span>}
          {project.clientName}
          {project.shootDate && <span> · {etDateTime(project.shootDate)}</span>}
        </div>
        {project.packageName && <div className="mt-1 text-xs text-muted">{project.packageName}</div>}
      </div>

      {/* Success banner */}
      {done && (
        <div className="rounded-2xl border border-success/30 bg-success-soft/50 p-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="size-5" />
            <span className="font-semibold">Submitted — editors notified</span>
          </div>
          <p className="mt-1 text-sm text-foreground/80">
            Thanks! Your notes are on the editor brief and the editors know the files are in Dropbox.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {pdfPath && (
              <a href={pdfPath} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
                <FileText className="size-4" /> View editor brief
              </a>
            )}
            <Link href={`/projects/${project.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg hover:opacity-90">
              View project
            </Link>
          </div>
        </div>
      )}

      {/* Special requests reminder */}
      {specialRequests.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-warning">
            <Star className="size-4" /> Special requests for this shoot
          </div>
          <ul className="ml-6 list-disc space-y-0.5 text-sm text-foreground/85">
            {specialRequests.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {project.editingPreferences && (
            <p className="mt-2 text-xs text-muted">Editing preferences: {project.editingPreferences}</p>
          )}
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="font-medium">{err}</div>
        </div>
      )}

      {/* ---- THE PHOTO STANDARD — cull before you upload. ---- */}
      {policy.photosOrdered && (
        <section className="rounded-2xl border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Scissors className="size-4 text-brand" />
            <h2 className="text-sm font-semibold">The photo standard — cull before you upload</h2>
          </div>

          <div className="mt-3 rounded-xl bg-brand-soft/50 px-3.5 py-2.5 text-sm">
            <span className="font-semibold">This home&rsquo;s cap: {policy.photoTarget} photos.</span>{" "}
            <span className="text-foreground/80">
              {policy.squareFeet
                ? `${policy.squareFeet.toLocaleString("en-US")} sq ft — up to 2,500 gets 50, 2,500–5,000 gets 65, above 5,000 gets 80–85.`
                : "Up to 2,500 sq ft gets 50 · 2,500–5,000 gets 65 · above 5,000 gets 80–85."}
            </span>
          </div>

          <ul className="mt-3 space-y-1.5 text-sm text-foreground/85">
            <li>· <strong>Front: max 4.</strong> Back: max 5. Bedrooms: 2 each. Bathrooms: 1–2 — if one frame shows everything, keep the better-looking angle.</li>
            <li>· <strong>No same angle at different distances.</strong> One composition, once.</li>
            <li>· <strong>Extras go to the Backup folder</strong> in Dropbox — never into the delivery set.</li>
            <li>· <strong>Shoot 5-bracket JPG.</strong> Not RAW. Not 3-bracket.</li>
          </ul>

          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            Why it matters: we pay to edit every photo you upload — including ones we&rsquo;ll never deliver — and an
            unculled gallery pulls Kyle and Jordan off revenue work to cull and reorganize it after editing.
            That&rsquo;s why <strong className="text-foreground/85">overages are deducted from your pay at $1 per photo</strong>.
            The best photographers don&rsquo;t take a lot of photos — they take the right ones. Overshooting at the
            shoot is fine; the gallery you upload must be culled. This is the standard.
          </p>

          <label className={cn(
            "mt-3.5 flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm font-medium transition-colors",
            cullOk ? "border-success/40 bg-success-soft/30 text-success" : "border-border hover:bg-surface-2",
          )}>
            <input type="checkbox" checked={cullOk} onChange={(e) => setCullOk(e.target.checked)} className={cn(checkbox, "mt-0.5")} />
            I culled to the standard — the gallery is at or under {policy.photoTarget}, and the extras are in the Backup folder.
          </label>
        </section>
      )}

      {/* ---- REMOVAL NOTES — what the editor must take out. ---- */}
      {policy.photosOrdered && (
        <section className="rounded-2xl border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Eraser className="size-4 text-brand" />
            <h2 className="text-sm font-semibold">Anything the editor needs to remove?</h2>
          </div>
          <p className="mt-1 text-[13px] text-muted">
            Pets, trash cans, vehicles, clutter that couldn&rsquo;t be moved on site. Move what you can while
            you&rsquo;re there — we aren&rsquo;t stagers, but we&rsquo;re professionals with strong attention to detail.
          </p>
          <AutoTextarea
            value={removal}
            onChange={(e) => { setRemoval(e.target.value); if (e.target.value.trim()) setNothingToRemove(false); }}
            minRows={2}
            placeholder="e.g. Trash cans visible in exterior 3–4 · dog bed in the primary bedroom · neighbor's car in the driveway shots."
            className="mt-2.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={nothingToRemove}
              onChange={(e) => { setNothingToRemove(e.target.checked); if (e.target.checked) setRemoval(""); }}
              className={checkbox}
            />
            Nothing needs removal — I checked.
          </label>
        </section>
      )}

      {/* ---- VIDEO — the script + your instructions. ---- */}
      {policy.videoOrdered && (
        <section className="rounded-2xl border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Clapperboard className="size-4 text-brand" />
            <h2 className="text-sm font-semibold">Video — script &amp; instructions for the editor</h2>
          </div>

          {script ? (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-muted">The shoot script (from Script Studio)</p>
                {script.url && (
                  <a href={script.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand hover:underline">
                    Open in Studio ↗
                  </a>
                )}
              </div>
              <AutoTextarea
                value={scriptText}
                onChange={(e) => {
                  const v = e.target.value;
                  setScriptText(v);
                  // Typing flips to "edited"; reverting to the exact original
                  // un-flips, so a stray touch can't confirm a phantom edit.
                  setScriptChoice((prev) => (v.trim() === script.body.trim() ? (prev === "edited" ? null : prev) : "edited"));
                }}
                minRows={4}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand"
              />
              <p className="mt-1.5 text-[13px] text-muted">
                Did the agent deliver it as written? If anything changed on site, fix the text above so the editor cuts to what was actually filmed.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => { setScriptChoice("as-written"); setScriptText(script.body); }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium",
                    scriptChoice === "as-written" ? "border-success bg-success/10 text-success" : "border-border hover:bg-surface-2",
                  )}
                >
                  <CheckCircle2 className="size-4" /> Delivered as written
                </button>
                <button
                  onClick={() => setScriptChoice("edited")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium",
                    scriptChoice === "edited" ? "border-warning bg-warning/10 text-warning" : "border-border hover:bg-surface-2",
                  )}
                >
                  Changed on site
                </button>
              </div>
              {scriptChoice === "edited" && (
                <input
                  value={scriptNote}
                  onChange={(e) => setScriptNote(e.target.value)}
                  placeholder="What changed? (one line — e.g. agent swapped the hook, dropped talking point 2)"
                  className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              )}
            </div>
          ) : (
            <p className="mt-2.5 rounded-lg bg-surface-2/70 px-3 py-2 text-[13px] text-muted">
              No script found in Script Studio for this shoot. If the agent read from one, put it in the instructions below so the editor has it.
            </p>
          )}

          <div className="mt-4 border-t border-border pt-3.5">
            <p className="text-sm font-semibold">
              Your instructions for the edit <span className="text-brand">— required</span>
            </p>
            <p className="mt-0.5 text-[13px] text-muted">
              The flow and your vision: shot order, the money shots, pacing, where the hook lands, anything you promised the agent.
            </p>
            <AutoTextarea
              value={vidInstructions}
              onChange={(e) => setVidInstructions(e.target.value)}
              minRows={3}
              placeholder="e.g. Open on the drone push-in, hook over the entry clip · kitchen is the money room, hold on it · agent walks and talks clips 12–18, tightest read is take 2 · end on the sunset back patio."
              className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <p className="mt-1.5 text-xs text-warning">
              This can&rsquo;t be left blank. Skipping the instructions forfeits future premium shoot assignments.
            </p>
          </div>
        </section>
      )}

      {/* Upload checklist */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Upload checklist</h2>
          <span className="text-xs text-muted-2">{doneCount}/{total} in Dropbox</span>
        </div>
        <p className="-mt-1 text-xs text-muted">
          Files go straight into the Dropbox folders above. Check each item off as it lands — your job isn&rsquo;t done until everything is uploaded.
        </p>
        {deliverables.map((d) => {
          const meta = DELIVERABLE_META[d.type];
          const on = uploaded[d.id];
          return (
            <button
              key={d.id}
              onClick={() => toggle(d.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                on ? "border-success/40 bg-success-soft/30" : "bg-surface hover:bg-surface-2",
              )}
            >
              {on ? <CheckCircle2 className="size-6 shrink-0 text-success" /> : <Circle className="size-6 shrink-0 text-muted-2" />}
              <span className="flex-1">
                <span className="block text-sm font-semibold">
                  {meta.label}
                  {d.quantity > 1 && <span className="text-muted"> ×{d.quantity}</span>}
                </span>
                <span className="block text-xs text-muted">{on ? "Uploaded to Dropbox" : "Not uploaded yet"}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Flag an issue */}
      <div className="rounded-2xl border bg-surface p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Flag className="size-4 text-danger" /> Flag an issue
        </div>
        <div className="flex gap-2">
          <input
            value={flagInput}
            onChange={(e) => setFlagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitFlag()}
            placeholder="e.g. Couldn’t shoot the garage, missing a bedroom — heads up for the editor."
            className="flex-1 rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <button onClick={submitFlag} className="rounded-lg border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">
            Flag
          </button>
        </div>
        {flags.length > 0 && (
          <ul className="mt-2 space-y-1">
            {flags.map((f, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg bg-danger-soft/60 px-2.5 py-1.5 text-xs text-danger">
                <AlertTriangle className="size-3.5" /> {f}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editor brief */}
      <div className="rounded-2xl border bg-surface p-4">
        <div className="mb-1 flex items-center gap-2">
          <Camera className="size-4 text-brand" />
          <label className="block text-sm font-semibold">Anything else for the editor?</label>
        </div>
        <p className="mb-2 text-xs text-muted">
          Whatever else shapes this edit — light, rooms to feature or skip, the agent&rsquo;s asks. Goes on the brief.
        </p>
        <AutoTextarea
          value={editorBrief}
          onChange={(e) => setEditorBrief(e.target.value)}
          minRows={3}
          placeholder="e.g. House faces west so exteriors are backlit — recover sky. Seller wants the pool emphasized. Skip the cluttered office."
          className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </div>

      {/* Submit */}
      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-2xl border bg-surface p-4 shadow-lg">
        <div className="text-sm text-muted">
          {doneCount}/{total} uploaded
          {project.photographerName && ` · ${project.photographerName}`}
        </div>
        <button
          onClick={finalize}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {done ? "Re-submit to editors" : "Everything's uploaded — submit"}
        </button>
      </div>
    </div>
  );
}
