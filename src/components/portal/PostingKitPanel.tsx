"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Copy, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalDraftCaption, portalMarkPosted, portalSaveCaption } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { DownloadButton } from "@/components/portal/DownloadButton";
import type { CaptionView, DownloadPlan } from "@/lib/postingKit";

// ---------------------------------------------------------------------------
// The posting kit's interactive half (spec §10): download (through the gated
// door — the href carries a media token, never the portal link), the editable
// caption (a save is a new version; nothing overwrites), "Draft a caption"
// which the server refuses with a reason while the assistant is off, and the
// client-recorded facts — Download started / Saved, and Marked as posted by
// me — which are never a verified publication. "Started" (the door opened)
// and "Saved" (the page received every byte) are shown apart on purpose
// (CP-12): the first used to be labelled "Downloaded".
//
// `access` is the server's release rule (cutEntitlement, CP-01): until the
// client has approved the version in front of them (or it was delivered to
// them another way), there is no Download, no Draft, no Write/Edit — one line
// says why instead. The server refuses those actions anyway; the page simply
// stops offering buttons it would refuse.
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = { CAPTION: "Caption", SHORT_CAPTION: "Shorter caption", CTA: "Call to action", COVER_TITLE: "Cover title" };
const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function PostingKitPanel({ videoId, title, downloadHref, download, finalLabel, finalNote, captions, assistant, postedAtISO, downloadStartedAtISO, downloadCompletedAtISO, canEdit, transcriptGap, access }: {
  videoId: string;
  title: string;
  downloadHref: string | null;
  /** How to fetch it (CP-12): proxied with progress, or a plain link. */
  download: DownloadPlan | null;
  access: { download: boolean; captions: boolean; why: string | null };
  finalLabel: string | null;
  finalNote: string | null;
  captions: CaptionView[];
  assistant: { enabled: boolean; why: string | null };
  postedAtISO: string | null;
  downloadStartedAtISO: string | null;
  downloadCompletedAtISO: string | null;
  canEdit: boolean;
  transcriptGap: string | null;
}) {
  const router = useRouter();
  // Captions are drafted and written only for the file the client may have.
  const captionsOpen = canEdit && access.captions;
  const [editing, setEditing] = useState<{ kind: string; body: string; basedOnId: string | null } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const done = (r: { ok: boolean; message: string }) => { setMsg({ ok: r.ok, text: r.message }); if (r.ok) router.refresh(); };

  const chosenOrLatest = (kind: string) => captions.find((c) => c.kind === kind && c.status === "CHOSEN") ?? captions.find((c) => c.kind === kind && c.status !== "STALE") ?? captions.find((c) => c.kind === kind) ?? null;
  const kinds = ["CAPTION", "SHORT_CAPTION", "CTA", "COVER_TITLE"].filter((k) => k === "CAPTION" || captions.some((c) => c.kind === k));

  const copy = async (text: string, id: string) => { try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch { setMsg({ ok: false, text: "Couldn't copy — select the text and copy it by hand." }); } };
  const save = () => { if (!editing) return; start(async () => { const r = await portalSaveCaption(portalAuthFromLocation(), videoId, editing).catch(() => ({ ok: false, message: "That didn't save — try again." })); if (r.ok) setEditing(null); done(r); }); };
  const draft = () => start(async () => done(await portalDraftCaption(portalAuthFromLocation(), videoId).catch(() => ({ ok: false, message: "The assistant couldn't run just now — try again in a moment." }))));
  const mark = (posted: boolean) => start(async () => done(await portalMarkPosted(portalAuthFromLocation(), videoId, posted).catch(() => ({ ok: false, message: "That didn't save — try again." }))));

  return (
    <div className="space-y-4">
      {/* Final download */}
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Final file</div>
        {downloadHref ? (
          <div className="mt-1.5 space-y-1.5">
            <DownloadButton videoId={videoId} href={downloadHref} plan={download ?? { mode: "redirect", fileName: null, sizeBytes: null, ref: null }} label={finalLabel ?? "final"} title={title} />
            {/* Two facts, never merged: the door opening is not the file arriving. */}
            <p className="flex flex-wrap gap-x-3 text-xs text-muted">
              <span>{downloadStartedAtISO ? `Download started ${fmt(downloadStartedAtISO)}` : "Not downloaded yet"}</span>
              {/* "Download finished", not "Saved": the page knows the file left it
                  (shared, or handed to the browser's save), not what the phone did next. */}
              {downloadCompletedAtISO && <span className="text-success">Download finished {fmt(downloadCompletedAtISO)}</span>}
            </p>
          </div>
        ) : (
          <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /> {finalNote ?? access.why ?? "No file yet."}</p>
        )}
        {/* An earlier approved version is being served while a newer one waits for review — say which. */}
        {downloadHref && access.why && <p className="mt-1.5 text-xs text-muted">{access.why}</p>}
      </div>

      {/* Caption & CTA */}
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Caption &amp; CTA</div>
          {captionsOpen && (
            <button type="button" onClick={draft} disabled={busy} title={assistant.why ?? undefined} className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand", assistant.enabled ? "border-brand/30 text-brand hover:bg-brand-soft" : "border-border text-muted-2")}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Draft a caption
            </button>
          )}
        </div>
        {!access.captions ? (
          <p className="mt-1 text-[11px] text-muted-2">{access.why ?? "Captions unlock once this version is approved."}</p>
        ) : !assistant.enabled && <p className="mt-1 text-[11px] text-muted-2">{assistant.why}</p>}
        {/* Only say what a draft was made from when a draft exists — otherwise
            this claimed a drafting that never happened, above "No caption yet". */}
        {transcriptGap && captions.some((c) => c.authorKind === "AI") && <p className="mt-1 text-[11px] text-muted-2">These drafts were made from the script — no transcript yet ({transcriptGap}).</p>}
        <div className="mt-2 space-y-2">
          {kinds.map((k) => {
            const c = chosenOrLatest(k);
            const isEditing = editing?.kind === k;
            return (
              <div key={k} className="rounded-lg border border-border bg-surface-2/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-2">
                  <span className="font-semibold text-foreground">{KIND_LABEL[k] ?? k}</span>
                  {c && <span>v{c.versionNo} · {c.authorKind === "AI" ? "drafted" : c.authorKind === "CLIENT" ? "your words" : "written by the team"}{c.status === "STALE" ? " · from an older cut" : ""}</span>}
                  {c?.sourceNote && <span>· {c.sourceNote}</span>}
                </div>
                {isEditing ? (
                  <div className="mt-1.5 space-y-1.5">
                    <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={k === "CAPTION" ? 5 : 2} aria-label={`Edit ${KIND_LABEL[k] ?? k}`} className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm outline-none focus:border-brand" />
                    <div className="flex gap-2">
                      <button type="button" onClick={save} disabled={busy || !editing.body.trim()} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Save as new version</button>
                      <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
                    </div>
                  </div>
                ) : c ? (
                  <>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{c.body}</p>
                    {c.alternatives.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-muted">{c.alternatives.map((a, i) => <li key={i}>· {a}</li>)}</ul>}
                    <div className="mt-1.5 flex flex-wrap gap-2 text-[11px]">
                      <button type="button" onClick={() => copy(c.body, c.id)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Copy className="size-3" /> {copied === c.id ? "Copied" : "Copy"}</button>
                      {captionsOpen && <button type="button" onClick={() => setEditing({ kind: k, body: c.body, basedOnId: c.id })} className="rounded-md border border-border px-2 py-1 text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Edit</button>}
                    </div>
                  </>
                ) : (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                    <span>No caption yet.</span>
                    {captionsOpen && <button type="button" onClick={() => setEditing({ kind: k, body: "", basedOnId: null })} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Write one</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Client-recorded facts */}
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Posted?</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {postedAtISO ? (
            <>
              <span className="inline-flex items-center gap-1 text-sm text-success"><CheckCircle2 className="size-4" /> Marked as posted by you · {fmt(postedAtISO)}</span>
              {canEdit && <button type="button" onClick={() => mark(false)} disabled={busy} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Undo</button>}
            </>
          ) : canEdit ? (
            <button type="button" onClick={() => mark(true)} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Mark as posted by me</button>
          ) : (
            <span className="text-sm text-muted">Not marked as posted.</span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted-2">Your note to yourself and to us — we don&rsquo;t check the platform, so this is never a verified publication.</p>
      </div>
      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}
