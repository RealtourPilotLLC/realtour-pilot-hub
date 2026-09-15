"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, Circle, ClipboardCheck, Flag, Paperclip, PlusCircle, ChevronDown } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { parseEditorBriefSections, type UploadMarkState } from "@/lib/uploadSummary";
import { NOTHING_TO_REMOVE_SENTINEL } from "@/lib/debrief";
import { Markdown } from "@/components/ui/Markdown";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// "What you submitted" — the read-back of a submitted upload page (Jordan,
// Sep 15 2026: "be able to go in and be able to view them"). Rendered by the
// portal ABOVE the reopen button while the checklist is collapsed, so the
// notes are readable without reopening a 1,300px form. Everything verbatim:
// the sectioned video brief (parsed with the same helper the history rows
// use), shot order, removals, the cull confirmation, add-ons, each item's
// state, files, square footage, the script confirmation — and who submitted
// / last edited it. Read-only; edits go through the reopened checklist.
// ---------------------------------------------------------------------------

export type SubmittedItem = { label: string; quantity: number; state: UploadMarkState; reason: string | null };

export function WhatYouSubmitted({
  submittedAtISO,
  uploadedAtISO,
  submittedBy,
  lastEdited,
  items,
  cullingConfirmedAtISO,
  squareFeet,
  squareFeetBand,
  shotOrderNotes,
  removalNotes,
  videoInstructions,
  videosFilmed,
  scriptConfirmedAtISO,
  scriptConfirmNote,
  scriptBody,
  editorBrief,
  addOns,
  files,
  flags,
}: {
  submittedAtISO: string | null;
  uploadedAtISO: string | null;
  submittedBy: string | null;
  lastEdited: { by: string; atISO: string } | null;
  items: SubmittedItem[];
  cullingConfirmedAtISO: string | null;
  squareFeet: number | null;
  squareFeetBand: string | null;
  shotOrderNotes: string | null;
  removalNotes: string | null;
  videoInstructions: string | null;
  videosFilmed: number | null;
  scriptConfirmedAtISO: string | null;
  scriptConfirmNote: string | null;
  scriptBody: string | null;
  editorBrief: string | null;
  addOns: { item: string; note: string | null; addedBy: string | null; handled: boolean }[];
  files: { name: string; size: number }[];
  flags: string[];
}) {
  const [showScript, setShowScript] = useState(false);
  const brief = parseEditorBriefSections(videoInstructions);
  const nothingToRemove = removalNotes === NOTHING_TO_REMOVE_SENTINEL;
  const videoFacts = [
    brief.style ? `Style: ${brief.style}` : null,
    brief.colorProfile ? `Color profile: ${brief.colorProfile}` : null,
    videosFilmed != null ? `${videosFilmed} video${videosFilmed === 1 ? "" : "s"} filmed` : null,
  ].filter(Boolean) as string[];
  const hasVideo = !brief.empty || videosFilmed != null || !!scriptConfirmNote;

  return (
    <section className="rounded-2xl border bg-surface p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
          <ClipboardCheck className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug">What you submitted</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {submittedAtISO ? (
              <>Submitted by <span className="font-medium text-foreground/85">{submittedBy ?? "the photographer"}</span> · {etDateTime(submittedAtISO)}</>
            ) : (
              <>Raws detected in Dropbox{uploadedAtISO ? ` ${etDateTime(uploadedAtISO)}` : ""} — the page itself was never submitted.</>
            )}
            {lastEdited && (
              <> · last edited by <span className="font-medium text-foreground/85">{lastEdited.by}</span> {etDateTime(lastEdited.atISO)}</>
            )}
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-3.5 sm:pl-11">
        {/* Checked off */}
        {items.length > 0 && (
          <Block title="Checked off">
            <ul className="space-y-1">
              {items.map((it, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-2 text-sm">
                  {it.state === "uploaded" ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success" />
                  ) : it.state === "not_completed" ? (
                    <XCircle className="size-4 shrink-0 text-warning" />
                  ) : (
                    <Circle className="size-4 shrink-0 text-muted-2" />
                  )}
                  <span className="font-medium">
                    {it.label}
                    {it.quantity > 1 && <span className="text-muted"> ×{it.quantity}</span>}
                  </span>
                  <span className={cn("text-xs", it.state === "not_completed" ? "font-semibold text-warning" : "text-muted")}>
                    {it.state === "uploaded" ? "Uploaded" : it.state === "not_completed" ? "Couldn't complete" : "Not checked off"}
                  </span>
                  {it.state === "not_completed" && it.reason && <span className="text-sm text-foreground/80">— {it.reason}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
              {cullingConfirmedAtISO ? (
                <span className="text-success">Cull confirmed ✓ {etDateTime(cullingConfirmedAtISO)}</span>
              ) : (
                <span>Cull not confirmed</span>
              )}
              <span>
                Square footage:{" "}
                {squareFeet != null
                  ? `${squareFeet.toLocaleString("en-US")} sq ft`
                  : squareFeetBand
                    ? `${squareFeetBand.replace(/\s*\(.*\)$/, "")} (on the order)`
                    : "not recorded"}
              </span>
            </p>
          </Block>
        )}

        {shotOrderNotes && <Block title="Shot order"><Verbatim text={shotOrderNotes} /></Block>}

        {removalNotes && (
          <Block title="Remove in editing">
            {nothingToRemove ? <p className="text-sm text-success">Nothing needs removal ✓ — confirmed</p> : <Verbatim text={removalNotes} />}
          </Block>
        )}

        {hasVideo && (
          <Block title="Video">
            {videoFacts.length > 0 && <p className="text-xs text-muted">{videoFacts.join(" · ")}</p>}
            {brief.preface && <Verbatim text={brief.preface} className="mt-1.5" />}
            {brief.sections.map((s) => (
              <div key={s.label} className="mt-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{s.title}</div>
                <Verbatim text={s.text} />
              </div>
            ))}
            {scriptConfirmNote && (
              <div className="mt-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Script</div>
                <p className="text-sm text-foreground/85">
                  {scriptConfirmNote.split("\n").map((l) => l.trim()).filter(Boolean).join(" · ")}
                  {scriptConfirmedAtISO && <span className="text-muted"> · confirmed {etDateTime(scriptConfirmedAtISO)}</span>}
                </p>
                {scriptBody && (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowScript((v) => !v)}
                      className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
                    >
                      <ChevronDown className={cn("size-3.5 transition-transform", showScript && "rotate-180")} />
                      {showScript ? "Hide the script" : "Show the script"}
                    </button>
                    {showScript && (
                      <div className="mt-1.5 max-h-80 overflow-y-auto scroll-thin rounded-lg border border-border bg-surface-2/60 px-3 py-2">
                        <Markdown content={scriptBody} />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </Block>
        )}

        {editorBrief?.trim() && <Block title="Anything else for the editor"><Verbatim text={editorBrief} /></Block>}

        {addOns.length > 0 && (
          <Block title="Added at the shoot">
            <ul className="space-y-1">
              {addOns.map((a, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-1.5 text-sm">
                  <PlusCircle className="size-3.5 shrink-0 text-brand" />
                  <span className="font-medium">{a.item}</span>
                  {a.note && <span className="text-foreground/80">— {a.note}</span>}
                  {a.addedBy && <span className="text-xs text-muted">(by {a.addedBy})</span>}
                  {a.handled && <span className="text-xs text-success">handled ✓</span>}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {files.length > 0 && (
          <Block title="Files uploaded through this page">
            <ul className="space-y-0.5">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-1.5 text-sm">
                  <Paperclip className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate">{f.name}</span>
                  <span className="text-xs text-muted-2">{fmtSize(f.size)}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {flags.length > 0 && (
          <Block title="Flagged">
            <ul className="space-y-1">
              {flags.map((f, i) => (
                <li key={i} className="flex items-start gap-1.5 rounded-lg bg-danger-soft/60 px-2.5 py-1.5 text-xs text-danger">
                  <Flag className="mt-0.5 size-3.5 shrink-0" /> <span>{f}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}
      </div>
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-brand">{title}</div>
      {children}
    </div>
  );
}

// whitespace-pre-wrap: the photographer's line breaks survive, exactly as
// typed — this card is the record of what was said.
function Verbatim({ text, className }: { text: string; className?: string }) {
  return <p className={cn("whitespace-pre-wrap text-sm leading-relaxed text-foreground/85", className)}>{text}</p>;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
