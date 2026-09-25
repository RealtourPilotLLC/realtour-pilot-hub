"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, History, Link2, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { adoptTopicVideoAction, confirmPairingAction, correctVideoIdentityAction, relinkDeliveredFileAction } from "@/app/content/[id]/workspaceActions";
import type { LibraryIdentityOptions, LibraryIdentityUi } from "@/components/content/ContentLibraryPanel";

// ---------------------------------------------------------------------------
// THE IDENTITY TOOL, one video at a time (CP-12). Four acts, each a ledger
// row per changed field (ContentVideoCorrection) and each re-checked by the
// server (OWNER/ADMIN, this enrollment only):
//
//   · correct the title / topic / script / kind, and confirm a backfilled
//     month (which moves the row out of the client's "Previous content");
//   · confirm a delivered file's pairing where it stands;
//   · move a delivered file to the video it really belongs to — this changes
//     which file the client downloads, so it asks for a reason;
//   · join a photographer-confirmed topic row onto the cut chain it never met.
//
// Nothing here deletes, and nothing here writes to Aryeo or Dropbox: the file
// stays where it is; only which video it counts as changes.
// ---------------------------------------------------------------------------

const BASIS_WORD: Record<string, string> = {
  cut: "the review cut itself", own: "its own video", known: "linked earlier", name: "matched by title", index: "matched by list position only", staff: "set by staff",
};
const day = (isoStr: string) => new Date(isoStr).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function LibraryIdentityEditor({ options, video, identity }: {
  options: LibraryIdentityOptions;
  video: { id: string; title: string; topicId: string | null; scriptId: string | null; kind: string; monthKey: string | null; status: string };
  identity: LibraryIdentityUi;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [title, setTitle] = useState(video.title);
  const [topicId, setTopicId] = useState(video.topicId ?? "");
  const [scriptId, setScriptId] = useState(video.scriptId ?? "");
  const [kind, setKind] = useState(video.kind);
  const [reason, setReason] = useState("");
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [adoptInto, setAdoptInto] = useState(identity.adoptInto[0]?.id ?? "");
  const e = options.enrollmentId;

  const done = (r: { ok: boolean; message: string }) => { setMsg({ ok: r.ok, text: r.message }); if (r.ok) router.refresh(); };
  const act = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => done(await fn().catch(() => ({ ok: false, message: "That didn't save — try again." }))));

  const dirty = title.trim() !== video.title || (topicId || null) !== video.topicId || (scriptId || null) !== video.scriptId || kind !== video.kind;
  const saveIdentity = () => act(() => correctVideoIdentityAction(e, video.id, {
    ...(title.trim() !== video.title ? { title: title.trim() } : {}),
    ...((topicId || null) !== video.topicId ? { topicId: topicId || null } : {}),
    ...((scriptId || null) !== video.scriptId ? { scriptId: scriptId || null } : {}),
    ...(kind !== video.kind ? { kind } : {}),
  }, reason));

  const field = "rounded-md border border-border bg-surface px-2 py-1 text-[12px] outline-none focus:border-brand";
  const small = "rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50";

  return (
    <div className="space-y-2.5 rounded-lg border border-border/70 bg-surface px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">
        <ShieldCheck className="size-3" /> Identity
        <span className="font-normal normal-case tracking-normal">
          {identity.confirmedAtISO ? `confirmed by ${identity.confirmedBy ?? "staff"} ${day(identity.confirmedAtISO)}` : "not confirmed by a person"}
          {identity.section === "PREVIOUS" ? " · the client sees it under Previous content" : ""}
        </span>
      </p>

      {/* Title / topic / script / kind */}
      <div className="grid gap-1.5 sm:grid-cols-2">
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">Title
          <input value={title} onChange={(ev) => setTitle(ev.target.value)} maxLength={200} className={field} />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">Topic
          <select value={topicId} onChange={(ev) => setTopicId(ev.target.value)} className={field}>
            <option value="">— no topic —</option>
            {options.topics.map((t) => <option key={t.id} value={t.id}>{t.title}{t.status === "ARCHIVED" || t.status === "REJECTED" ? ` (${t.status.toLowerCase()})` : ""}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">Script
          <select value={scriptId} onChange={(ev) => setScriptId(ev.target.value)} className={field}>
            <option value="">— no script —</option>
            {options.scripts.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">Counts as
          <select value={kind} onChange={(ev) => setKind(ev.target.value)} className={field}>
            <option value="PROGRAM">Program video (counts toward the allowance)</option>
            <option value="LISTING">Listing video (does not count)</option>
            <option value="EXTRA">Extra (does not count)</option>
            {!["PROGRAM", "LISTING", "EXTRA"].includes(video.kind) && <option value={video.kind} disabled>{video.kind.toLowerCase()}</option>}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Why (kept in the history)" maxLength={500} className={cn(field, "min-w-0 flex-1 basis-48")} />
        <button type="button" onClick={saveIdentity} disabled={busy || !dirty || !title.trim()} className="rounded-md bg-brand px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Save correction</button>
        {identity.monthHistorical && !identity.confirmedAtISO && (
          <button type="button" onClick={() => act(() => correctVideoIdentityAction(e, video.id, { confirmMonth: true }, reason))} disabled={busy} className={small} title="The client will see it under this month instead of Previous content">
            Confirm {video.monthKey ?? "month"}
          </button>
        )}
        {identity.monthHistorical && identity.confirmedAtISO && (
          <button type="button" onClick={() => act(() => correctVideoIdentityAction(e, video.id, { confirmMonth: false }, reason))} disabled={busy} className={small}>Back to Previous content</button>
        )}
      </div>

      {/* Delivered files */}
      {identity.files.length > 0 && (
        <ul className="space-y-1.5">
          {identity.files.map((f) => {
            const weak = !f.confirmedAtISO && f.matchBasis !== "staff" && (f.matchBasis === "index" || f.legacyKey);
            return (
              <li key={f.sourceId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                <Link2 className="size-3 text-muted-2" />
                <span className="font-medium">{f.title ?? "Delivered file"}</span>
                <span className="font-mono text-[10px] text-muted-2">{f.externalKey}</span>
                <span className={cn("text-[11px]", weak ? "text-warning" : "text-muted")}>
                  {f.matchBasis ? BASIS_WORD[f.matchBasis] ?? f.matchBasis : "pairing not recorded"}
                  {f.legacyKey ? " · legacy position key" : ""}
                  {f.confirmedAtISO ? ` · confirmed by ${f.confirmedBy ?? "staff"}` : ""}
                </span>
                {!f.confirmedAtISO && f.matchBasis !== "staff" && (
                  <button type="button" onClick={() => act(() => confirmPairingAction(e, f.sourceId))} disabled={busy} className={small}><CheckCircle2 className="mr-0.5 inline size-3" />Right video</button>
                )}
                {identity.relinkTargets.length > 0 && (
                  <span className="flex items-center gap-1">
                    <select value={moveTo[f.sourceId] ?? ""} onChange={(ev) => setMoveTo({ ...moveTo, [f.sourceId]: ev.target.value })} className={field} aria-label="Move this file to">
                      <option value="">Move to…</option>
                      {identity.relinkTargets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </select>
                    <button
                      type="button" disabled={busy || !moveTo[f.sourceId] || !reason.trim()} className={small}
                      title={!reason.trim() ? "Say why first — this changes which file the client downloads" : undefined}
                      onClick={() => act(() => relinkDeliveredFileAction(e, f.sourceId, moveTo[f.sourceId], reason))}
                    >Move</button>
                  </span>
                )}
              </li>
            );
          })}
          {identity.relinkTargets.length > 0 && <li className="text-[11px] text-muted-2">Moving a file changes which file the client downloads for each video — write the reason above first.</li>}
        </ul>
      )}

      {/* A filmed topic that never met its cut */}
      {identity.adoptInto.length > 0 && video.status !== "ARCHIVED" && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-muted">This topic row has no cut. Join it to the video that has the cuts:</span>
          <select value={adoptInto} onChange={(ev) => setAdoptInto(ev.target.value)} className={field}>
            {identity.adoptInto.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <button type="button" onClick={() => act(() => adoptTopicVideoAction(e, adoptInto, video.id))} disabled={busy || !adoptInto} className={small}>Join</button>
        </div>
      )}

      {/* History */}
      {identity.corrections.length > 0 && (
        <details className="text-[11px]">
          <summary className="flex cursor-pointer items-center gap-1 text-muted-2"><History className="size-3" /> {identity.corrections.length} correction{identity.corrections.length === 1 ? "" : "s"} on file</summary>
          <ul className="mt-1 space-y-0.5">
            {identity.corrections.map((c) => (
              <li key={c.id} className="text-muted">
                <span className="font-medium text-foreground">{c.field}</span>: {c.fromValue ?? "—"} → {c.toValue ?? "—"} · {c.by} · {day(c.createdAtISO)}{c.reason ? ` · “${c.reason}”` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {busy && <p className="flex items-center gap-1 text-[11px] text-muted"><Loader2 className="size-3 animate-spin" /> Saving…</p>}
      {msg && <p role="status" className={cn("text-[11px]", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}
