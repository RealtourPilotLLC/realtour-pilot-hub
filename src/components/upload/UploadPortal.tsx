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
  Check,
} from "lucide-react";
import { DELIVERABLE_META } from "@/lib/pipeline";
import { markDeliverableUploaded, flagIssue, finalizeUpload, submitUploadFeedback } from "@/app/upload/actions";
import { cn } from "@/lib/utils";
import type { DeliverableType, DeliverableStatus } from "@prisma/client";
import { etDateTime } from "@/lib/datetime";
import { AutoTextarea } from "@/components/ui/AutoTextarea";

// ---------------------------------------------------------------------------
// The shoot debrief portal (rebuilt Aug 31 2026 per Jordan; readability pass
// Sep 1: numbered steps a tired photographer can scan on a phone at 9 PM).
// Files go to Dropbox directly — THIS page is where the photographer and the
// office get aligned. The job is not done until every step is answered.
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
const FRONT_TO_BACK_SENTINEL = "Shot front to back.";
const INTERIOR_EXTERIOR_SENTINEL = "Shot front to back — interior first, then exterior.";

// One numbered step card: orange number while open, green check once its
// requirement is satisfied. The whole page reads as a checklist.
function StepCard({
  n, title, done, subtitle, children,
}: {
  n: number; title: string; done: boolean; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-surface p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold",
            done ? "bg-success/15 text-success" : "bg-brand text-white",
          )}
        >
          {done ? <Check className="size-4.5" /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3 sm:pl-11">{children}</div>
    </section>
  );
}

// Small uppercase label that groups the standard into scannable chunks.
function MiniHeading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 mt-4 text-[11px] font-bold uppercase tracking-widest text-brand first:mt-0">{children}</div>;
}

// One group of the SOP §27 pre-upload checklist.
function CheckRow({ checked, onChange, title, text }: { checked: boolean; onChange: (v: boolean) => void; title: string; text: string }) {
  return (
    <label className={cn(
      "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors",
      checked ? "border-success/40 bg-success-soft/30" : "border-border hover:bg-surface-2",
    )}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
      <span className="text-sm leading-snug">
        <span className={cn("font-semibold", checked && "text-success")}>{title}.</span>{" "}
        <span className="text-foreground/75">{text}</span>
      </span>
    </label>
  );
}

export function UploadPortal({
  project,
  deliverables,
  specialRequests,
  flags: initialFlags,
  policy,
  script,
  foldersSlot,
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
    shotOrderNotes: string | null;
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
    range: { low: number; high: number; upper: number | null };
    rangeMode: "sop" | "legacy" | "override";
    squareFeet: number | null;
  };
  /** the shoot script pulled from Script Studio (null = none exists there) */
  script: { body: string; hook: string | null; url: string | null } | null;
  /** the Dropbox folders card, rendered by the server page */
  foldersSlot: React.ReactNode;
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
  const [processNote, setProcessNote] = useState("");
  const [processNoteSent, setProcessNoteSent] = useState(false);

  // --- Debrief state (prefilled from prior submits — re-opening never re-asks). ---
  // The SOP §27 pre-upload checklist: four groups, all four required.
  const confirmedBefore = !!project.cullingConfirmedAt;
  const [checks, setChecks] = useState({ coverage: confirmedBefore, culling: confirmedBefore, quality: confirmedBefore, count: confirmedBefore });
  const cullOk = checks.coverage && checks.culling && checks.quality && checks.count;
  const setCheck = (k: keyof typeof checks) => (v: boolean) => setChecks((c) => ({ ...c, [k]: v }));
  const priorNothing = project.removalNotes === NOTHING_SENTINEL;
  const [removal, setRemoval] = useState(priorNothing ? "" : project.removalNotes ?? "");
  const [nothingToRemove, setNothingToRemove] = useState(priorNothing);
  const priorStandardOrder =
    project.shotOrderNotes === FRONT_TO_BACK_SENTINEL || project.shotOrderNotes === INTERIOR_EXTERIOR_SENTINEL;
  const [orderChoice, setOrderChoice] = useState<"front-to-back" | "interior-exterior" | "out-of-order" | null>(
    !project.shotOrderNotes ? null
      : project.shotOrderNotes === FRONT_TO_BACK_SENTINEL ? "front-to-back"
      : project.shotOrderNotes === INTERIOR_EXTERIOR_SENTINEL ? "interior-exterior"
      : "out-of-order",
  );
  // Strip the storage prefix on rehydrate — otherwise every re-submit would
  // re-wrap it ("Out of order — Out of order — …") — same pattern as scriptNote.
  const [orderNotes, setOrderNotes] = useState(
    priorStandardOrder ? "" : (project.shotOrderNotes ?? "").replace(/^Out of order — /, ""),
  );
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
    if (policy.photosOrdered && !cullOk) missing.push("the pre-upload checklist (all four boxes)");
    if (policy.photosOrdered && orderChoice === null) missing.push("answer the shot order");
    if (policy.photosOrdered && orderChoice === "out-of-order" && !orderNotes.trim()) missing.push("the order you shot the home (and why)");
    if (policy.photosOrdered && !removal.trim() && !nothingToRemove) missing.push("answer the removal notes");
    if (policy.videoOrdered && !vidInstructions.trim()) missing.push("video instructions for the editor");
    if (policy.videoOrdered && script && !scriptChoice) missing.push("confirm the script");
    if (policy.videoOrdered && scriptChoice === "edited" && !scriptText.trim()) missing.push("the edited script text (or pick “Delivered as written”)");
    return missing;
  }

  function finalize() {
    const missing = missingItems();
    if (missing.length > 0) {
      setErr(`Not done yet — ${missing.join(" · ")}. The job isn't finished until every step is answered.`);
      window.scrollTo({ top: 0, behavior: "smooth" });
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
      shotOrder: orderChoice ? { mode: orderChoice, notes: orderNotes } : null,
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
        if (res.blocked) { setErr(res.blocked); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
        if (res.needsConfirm) {
          const proceed = window.confirm(res.warning ?? "Some ordered items look missing. Submit anyway?");
          if (!proceed) return;
          res = await finalizeUpload(project.id, { ...payload, force: true });
          if (res.blocked) { setErr(res.blocked); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
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
  const choiceBtn = (active: boolean, tone: "ok" | "warn" = "ok") =>
    cn(
      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium",
      active
        ? tone === "ok" ? "border-success bg-success/10 text-success" : "border-warning bg-warning/10 text-warning"
        : "border-border hover:bg-surface-2",
    );

  // Step numbering adapts — photo-only jobs never see the video step, video-
  // only jobs never see the photo steps (Jordan, Sep 1).
  let stepNo = 1;
  const removalAnswered = !!removal.trim() || nothingToRemove;
  const orderAnswered =
    orderChoice === "front-to-back" || orderChoice === "interior-exterior" ||
    (orderChoice === "out-of-order" && !!orderNotes.trim());
  const videoDone =
    !!vidInstructions.trim() && (!script || (scriptChoice !== null && (scriptChoice !== "edited" || !!scriptText.trim())));

  return (
    <div className="space-y-4">
      {/* ---- The job, big and first. ---- */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.title.split(",")[0]}</h1>
        <p className="mt-1 text-sm text-muted">
          {addr && <span>{addr} · </span>}
          {project.clientName}
          {project.shootDate && <span> · {etDateTime(project.shootDate)}</span>}
        </p>
        {project.packageName && <p className="mt-0.5 text-[13px] text-muted-2">{project.packageName}</p>}
      </div>

      {/* Success banner + process feedback */}
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
          {/* Post-job feedback on the PROCESS — Jordan reads every one. */}
          <div className="mt-3 border-t border-success/20 pt-3">
            {processNoteSent ? (
              <p className="text-[13px] text-success"><Check className="mr-1 inline size-3.5" />Feedback sent — thank you.</p>
            ) : (
              <>
                <p className="text-[13px] text-foreground/75">How was this upload process? Anything we should change?</p>
                <div className="mt-1.5 flex gap-2">
                  <input
                    value={processNote}
                    onChange={(e) => setProcessNote(e.target.value)}
                    placeholder="Optional — goes straight to Jordan."
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand"
                  />
                  <button
                    disabled={!processNote.trim() || isPending}
                    onClick={() => {
                      const note = processNote.trim();
                      // Confirm only AFTER the write lands — a dead cell
                      // connection must not eat feedback behind a thank-you.
                      startTransition(async () => {
                        const r = await submitUploadFeedback(project.id, note).catch(() => ({ ok: false }));
                        if (r.ok) setProcessNoteSent(true);
                        else setErr("Couldn't send the feedback — check your connection and try again.");
                      });
                    }}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </>
            )}
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

      {/* ---- STEP: Upload to Dropbox ---- */}
      <StepCard
        n={stepNo++}
        title="Upload everything to Dropbox"
        done={doneCount >= total && total > 0}
        subtitle="Raw files in the Raw folders · culled extras in Backup Photos."
      >
        {foldersSlot}
      </StepCard>

      {/* ---- STEP: The photo standard (the SOP, enforced) ---- */}
      {policy.photosOrdered && (
        <StepCard n={stepNo++} title="The photo standard — run your cull" done={cullOk}>
          <div className="rounded-xl bg-brand-soft/50 px-3.5 py-2.5 text-sm">
            {policy.rangeMode === "override" ? (
              <>
                <span className="font-semibold">This home&rsquo;s target: {policy.photoTarget} photos.</span>{" "}
                <span className="text-foreground/80">Set by the office for this property — it beats the size tier.</span>
              </>
            ) : policy.rangeMode === "legacy" ? (
              <>
                <span className="font-semibold">This shoot predates the new standard — ceiling ~{policy.photoTarget} finals.</span>{" "}
                <span className="text-foreground/80">Cull to the SOP anyway: hero shots, one composition once.</span>
              </>
            ) : policy.range.upper ? (
              <>
                <span className="font-semibold">This home: aim for {policy.range.low}–{policy.range.high} finals.</span>{" "}
                <span className="text-foreground/80">
                  {policy.range.upper} is the normal ceiling — and the ceiling is not a goal.
                  {policy.squareFeet ? ` (${policy.squareFeet.toLocaleString("en-US")} sq ft)` : ""}
                </span>
              </>
            ) : (
              <>
                <span className="font-semibold">7,000+ sq ft — property dependent.</span>{" "}
                <span className="text-foreground/80">
                  Professional judgment: complete coverage without unnecessary repetition. The sweep checks in
                  around ~{policy.photoTarget} finals unless the office sets a target.
                </span>
              </>
            )}
          </div>

          <MiniHeading>The standard</MiniHeading>
          <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/85">
            <li><strong>Every space gets one HERO SHOT</strong> — the photo you&rsquo;d pick if you could only show one. Supporting shots exist only to show what the hero can&rsquo;t.</li>
            <li><strong>One composition, once.</strong> No distance or zoom variations of the same angle.</li>
            <li><strong>Every photo must add new information.</strong> &ldquo;I like both&rdquo; is not a reason.</li>
            <li><strong>Open-concept areas are one space</strong> — not four rooms&rsquo; worth of angles.</li>
            <li><strong>5-bracket JPG.</strong> A bracket set counts as ONE composition. Not RAW, not 3-bracket.</li>
            <li><strong>Trash cans and pet items are a no-go.</strong> Fix it on site — don&rsquo;t lean on the editor.</li>
            <li><strong>Alternates go to Backup Photos</strong> — and cull that folder too.</li>
          </ul>

          <details className="mt-3 rounded-xl border border-border">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-muted hover:text-foreground">
              Room-by-room guide (guidelines, not quotas)
            </summary>
            <div className="border-t border-border px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground/80">
              Front &amp; rear exterior 2–4 (up to 5 with aerials) · kitchen 3–5 · living/family 2–3 · dining 1–2 ·
              primary bed &amp; bath 2–3 · other bedrooms 1–2 · full baths 1–2 · powder room 1 · basement 2–4 ·
              office/bonus 1–2 · deck/patio 1–2 · pool 2–3.{" "}
              <a href="/resources/photography-sop" target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                Full table in the SOP ↗
              </a>
            </div>
          </details>

          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            Unnecessary photos cost real money — extra editing plus office time to re-cull after the fact. A{" "}
            <strong className="text-foreground/85">$1 production charge may be deducted per clearly unnecessary photo</strong>{" "}
            (duplicates, distance variations, backups uploaded as finals — never justified coverage). This is not a
            photo-count penalty: a property that truly needs more gets more.{" "}
            <a href="/resources/photography-sop" target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
              Read the full Photography SOP ↗
            </a>
          </p>

          <MiniHeading>Before you upload — confirm all four</MiniHeading>
          <div className="space-y-2">
            <CheckRow checked={checks.coverage} onChange={setCheck("coverage")} title="Coverage"
              text="Every important space is represented, each has its hero shot, exteriors and drone (if ordered) are complete." />
            <CheckRow checked={checks.culling} onChange={setCheck("culling")} title="Culling"
              text="Failures and test shots gone, duplicates and distance variations gone, every supporting photo adds something, backups separated." />
            <CheckRow checked={checks.quality} onChange={setCheck("quality")} title="Quality"
              text="Distractions were fixed on site — no avoidable trash cans, pets, or pet items in frame." />
            <CheckRow checked={checks.count} onChange={setCheck("count")} title="Count"
              text={policy.rangeMode !== "sop"
                ? `The gallery makes sense for this home (~${policy.photoTarget} target) — every photo has a reason to exist.`
                : policy.range.upper
                  ? `The gallery makes sense for this home (aim ${policy.range.low}–${policy.range.high}) — anything above has a reason to exist.`
                  : "The gallery size makes sense for this property — every photo has a reason to exist."} />
          </div>
        </StepCard>
      )}

      {/* ---- STEP: Shot order ---- */}
      {policy.photosOrdered && (
        <StepCard
          n={stepNo++}
          title="Shot order — front to back?"
          done={orderAnswered}
          subtitle="The gallery should walk the house the way a buyer would. Organizing photos of a house we've never been in burns serious office time — presentation is everything."
        >
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { setOrderChoice("front-to-back"); setOrderNotes(""); }} className={choiceBtn(orderChoice === "front-to-back")}>
              <CheckCircle2 className="size-4" /> Front to back
            </button>
            <button onClick={() => { setOrderChoice("interior-exterior"); setOrderNotes(""); }} className={choiceBtn(orderChoice === "interior-exterior")}>
              <CheckCircle2 className="size-4" /> Interior front-to-back, then exterior
            </button>
            <button onClick={() => setOrderChoice("out-of-order")} className={choiceBtn(orderChoice === "out-of-order", "warn")}>
              Different order
            </button>
          </div>
          {orderChoice === "out-of-order" && (
            <div className="mt-2.5">
              <AutoTextarea
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                minRows={2}
                placeholder="Why, and the order you shot — e.g. contractor in the kitchen: started upstairs beds → baths → living/dining → kitchen last → exteriors."
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-muted">
                Totally fine when the seller, a contractor, or the agent forces it — just tell us the order so nobody has to guess what&rsquo;s where.
              </p>
            </div>
          )}
        </StepCard>
      )}

      {/* ---- STEP: Removal notes ---- */}
      {policy.photosOrdered && (
        <StepCard
          n={stepNo++}
          title="Anything to remove in editing?"
          done={removalAnswered}
          subtitle="Pets, trash cans, vehicles, clutter that couldn’t be moved. Move what you can on site — we aren’t stagers, but we’re professionals with strong attention to detail."
        >
          <AutoTextarea
            value={removal}
            onChange={(e) => { setRemoval(e.target.value); if (e.target.value.trim()) setNothingToRemove(false); }}
            minRows={2}
            placeholder="e.g. Trash cans in exterior 3–4 · dog bed in the primary bedroom · neighbor's car in the driveway shots."
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
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
        </StepCard>
      )}

      {/* ---- STEP: Video (only when a video is on the order) ---- */}
      {policy.videoOrdered && (
        <StepCard n={stepNo++} title="Video — script & your instructions" done={videoDone}>
          {script ? (
            <div>
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
                Did the agent deliver it as written? If anything changed on site, fix the text above — the editor cuts to what you confirm here.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => { setScriptChoice("as-written"); setScriptText(script.body); }} className={choiceBtn(scriptChoice === "as-written")}>
                  <CheckCircle2 className="size-4" /> Delivered as written
                </button>
                <button onClick={() => setScriptChoice("edited")} className={choiceBtn(scriptChoice === "edited", "warn")}>
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
            <p className="rounded-lg bg-surface-2/70 px-3 py-2 text-[13px] text-muted">
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
              placeholder="e.g. Open on the drone push-in, hook over the entry clip · kitchen is the money room, hold on it · agent walk-and-talks clips 12–18, tightest read is take 2 · end on the sunset back patio."
              className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <p className="mt-1.5 text-xs text-warning">
              This can&rsquo;t be left blank. Skipping the instructions forfeits future premium shoot assignments.
            </p>
          </div>
        </StepCard>
      )}

      {/* ---- STEP: Wrap up ---- */}
      <StepCard
        n={stepNo++}
        title="Check off & wrap up"
        done={done}
        subtitle="Tick each item once its files are in Dropbox, add anything else the editor should know, then submit."
      >
        <div className="space-y-2">
          {deliverables.map((d) => {
            const meta = DELIVERABLE_META[d.type];
            const on = uploaded[d.id];
            return (
              <button
                key={d.id}
                onClick={() => toggle(d.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                  on ? "border-success/40 bg-success-soft/30" : "bg-surface hover:bg-surface-2",
                )}
              >
                {on ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <Circle className="size-5 shrink-0 text-muted-2" />}
                <span className="flex-1 text-sm font-medium">
                  {meta.label}
                  {d.quantity > 1 && <span className="text-muted"> ×{d.quantity}</span>}
                </span>
                <span className="text-xs text-muted">{on ? "Uploaded" : "Not yet"}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-4">
          <label className="block text-sm font-semibold">Anything else for the editor?</label>
          <AutoTextarea
            value={editorBrief}
            onChange={(e) => setEditorBrief(e.target.value)}
            minRows={2}
            placeholder="e.g. House faces west so exteriors are backlit — recover sky. Seller wants the pool emphasized. Skip the cluttered office."
            className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
            <Flag className="size-4 text-danger" /> Flag a problem
          </div>
          <div className="flex gap-2">
            <input
              value={flagInput}
              onChange={(e) => setFlagInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitFlag()}
              placeholder="e.g. Couldn’t shoot the garage — heads up for the editor."
              className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <button onClick={submitFlag} className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2">
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
      </StepCard>

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
