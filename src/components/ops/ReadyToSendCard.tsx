"use client";

import Link from "next/link";
import { useState } from "react";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Eye, FileVideo, Files, Loader2, Send } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { MarkSent } from "@/components/ops/MarkSent";
import { MarkUploaded } from "@/components/ops/MarkUploaded";
import { MarkProjectSent } from "@/components/ops/MarkProjectSent";
import { ChooseAryeoDelivery } from "@/components/ops/ChooseAryeoDelivery";
import { WatchDeliveryVideo, deliveryPreview } from "@/components/ops/WatchDeliveryVideo";
import { uploadedDeliveryGroups, type UploadedTarget } from "@/lib/uploadedDeliveryGroups";
import { CorrectUpload } from "@/components/ops/CorrectUpload";
import { RetryRender } from "@/components/ops/RetryRender";
import { HeldRender } from "@/components/ops/HeldRender";
import { PortalNextStep } from "@/components/ops/PortalNextStep";
import { NotTold } from "@/components/ops/NotTold";
import { SaveStatus } from "@/components/ui/SaveStatus";
import { undoVideoUploadAction } from "@/app/ops/actions";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import type { ReadyBoard, ReadyVideo, RenderingVideo } from "@/lib/readyToSend";
import type { DeliveryNoticeIncident } from "@/lib/deliveryNoticeIncidents";

// ---------------------------------------------------------------------------
// READY TO SEND — the delivery half of Kyle's afternoon.
//
// Video Review asks "does this cut pass?". This card asks the question nobody
// had a home for: "which finished videos have NOT gone to the client?" It sits
// next to Video Review because they are the two halves of the same half-hour,
// and because the answer to the first creates work for the second.
//
// Sep 17: a client's video went out silent, was re-cut by lunchtime, and then
// sat in hand while everyone assumed somebody else had re-sent it. Every screen
// in the hub said the job was delivered. This card is the one that says it
// isn't — and it keeps saying so until a person presses the button.
//
// TWO LISTS, AND THE LINE BETWEEN THEM IS THE POINT. The rows carry a file and
// a button. The footnote underneath carries neither: those are cuts whose 1080p
// pass is still running, and the better file is half an hour away. They are on
// screen so a stalled render is visible, and they are unpressable so nobody
// sends the editor's un-enhanced export by mistake.
//
// A CLIENT COMPONENT SINCE Sep 21, and only for one reason: after a press the
// row has to come back and LOOK at itself, and that is a browser event. It
// WRITES nothing of its own any more — the "somebody has this file" stamp is
// the download route's to write, once the file has actually been handed over
// (review, Sep 21: this button used to write it on the press, so a 404 on a
// moved file still read "Downloaded by Kyle"). Everything else is unchanged —
// it still renders rows the page already fetched (opsDay), it still reaches no
// database of its own, and every field it reads is a plain string or number off
// ReadyBoard. `import type` above is erased at build, so nothing drags
// @/lib/readyToSend (prisma, settings, server-only) across the client boundary;
// keep it that way.
//
// Nothing here can reach a client. The buttons are "download the file", "record
// what I did" and "run the 1080p pass again".
//
// OWNER/ADMIN ONLY — and since Sep 21 the ADMIN half is the point. Jordan: "I
// just want to make sure Kyle gets that view." Three approved videos had sat
// unsent for up to three days (5 Raymond Cir, 453 Cardigan Terrace, 5642
// Limeport Rd) because the big card was owner-gated and Kyle's copy lived
// inside a time block that only opens by itself between 1:00 and 1:30 PM.
// Sending these IS his job, so the card is now at the top of his page too.
// Enforced by the caller (Home renders it for OWNER and ADMIN, and no other
// role reaches Home at all) AND by everything it can do — the download routes
// are requireRole(OWNER/ADMIN) / canViewProject, the hand-off stamp inside them
// is written only for an OWNER or ADMIN, and markVideoSentAction is
// requireAdmin. No editor or photographer ever sees a client delivery surface.
// ---------------------------------------------------------------------------

/** "3h" / "2 days" — the same unit the rest of the day uses. */
function waited(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

function monthName(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return year && month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month - 1, 1, 12)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    : monthKey;
}

const SOURCE_CHIP: Record<ReadyVideo["file"]["source"], string> = {
  "topaz-1080p": "1080p",
  "editor-hub-copy": "Editor's file",
  "editor-dropbox": "Editor's file",
};
const usesPortal = (v: ReadyVideo) => v.deliveryDestination ? v.deliveryDestination === "client-portal" : v.monthlyProgram;

export function ReadyToSendCard({ board, includeTest = false }: { board: ReadyBoard; includeTest?: boolean }) {
  const router = useRouter();
  const [recorded, setRecorded] = useState<Map<string, string | null | undefined>>(() => new Map());
  const [sent, setSent] = useState<Map<string, string | null | undefined>>(() => new Map());
  const [aryeoChoices, setAryeoChoices] = useState<Map<string, string>>(() => new Map());
  const { needsFinishing } = board;
  const chosenDestination = <T extends ReadyVideo | RenderingVideo>(v: T): T => aryeoChoices.has(v.submissionId) && aryeoChoices.get(v.submissionId) === v.destinationFingerprint ? { ...v, deliveryDestination: "aryeo-listing", canChooseAryeo: false } : v;
  const rendering = board.rendering.map(chosenDestination);
  const chooseAryeo = (v: ReadyVideo | RenderingVideo) => setAryeoChoices(previous => new Map(previous).set(v.submissionId, v.destinationFingerprint!));
  // UNDO, AT ONCE (Oct 5 2026): an undone upload is back in "Ready for upload"
  // the moment it is pressed; the server's answer only has to agree with it.
  const [undone, setUndone] = useState<Map<string, string>>(() => new Map());
  const isUndone = (v: ReadyVideo) => !!v.uploadFingerprint && undone.get(v.submissionId) === v.uploadFingerprint;
  const ready = board.ready.filter((v) => !(sent.has(v.submissionId) && sent.get(v.submissionId) === v.uploadFingerprint)).map(chosenDestination)
    .map((v) => isUndone(v) ? { ...v, uploaded: null } : v);
  const isRecorded = (v: ReadyVideo) => !isUndone(v) && recorded.has(v.submissionId) && recorded.get(v.submissionId) === v.uploadFingerprint;
  const uploadedRows = ready.filter((v) => !usesPortal(v) && (v.uploaded || isRecorded(v)));
  const [undoErrors, setUndoErrors] = useState<Map<string, string>>(() => new Map());
  const undoUpload = (v: ReadyVideo) => {
    const fingerprint = v.uploadFingerprint;
    if (!fingerprint || isUndone(v)) return;
    const putBack = (message: string) => {
      setUndone((previous) => { const next = new Map(previous); next.delete(v.submissionId); return next; });
      setUndoErrors((previous) => new Map(previous).set(v.submissionId, message));
    };
    setUndoErrors((previous) => { const next = new Map(previous); next.delete(v.submissionId); return next; });
    setUndone((previous) => new Map(previous).set(v.submissionId, fingerprint));
    setRecorded((previous) => { const next = new Map(previous); next.delete(v.submissionId); return next; });
    void undoVideoUploadAction(v.submissionId, fingerprint)
      .then((r) => { if (!r.ok) putBack(r.message); })
      .catch(() => putBack("Couldn't confirm the undo. Refresh to see where this video stands."));
  };
  const uploadedGroups = uploadedDeliveryGroups(uploadedRows);
  const sentGroup = (cuts: UploadedTarget[]) => setSent(previous => {
    const next = new Map(previous);
    for (const cut of cuts) next.set(cut.submissionId, cut.fingerprint);
    return next;
  });
  const uploaded = (v: ReadyVideo, delivered = false) => {
    setUndone((previous) => { const next = new Map(previous); next.delete(v.submissionId); return next; });
    setRecorded((previous) => new Map(previous).set(v.submissionId, v.uploadFingerprint));
    if (delivered) setSent((previous) => new Map(previous).set(v.submissionId, v.uploadFingerprint));
  };
  // 9.2: sent, and the client not told yet — its own short list (NotTold).
  const notTold = board.notTold ?? [];
  const unavailable = board.boardUnavailable || board.followUpChecks?.needsFinishing === null || board.followUpChecks?.notTold === null || board.noticeIncidentCheck === null;
  const recoveryStatus = unavailable && (
    <div role="alert" className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm text-foreground">
      <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" /> Could not check all delivery follow-up.</p>
      <p className="mt-1 text-muted">
        {board.boardUnavailable ? "The delivery board is unavailable." : [
          board.followUpChecks?.needsFinishing === null ? "Delivery records" : null,
          board.followUpChecks?.notTold === null ? "Client notification" : null,
          board.noticeIncidentCheck === null ? "Delivery-text outcomes" : null,
        ].filter(Boolean).join(" and ") + " could not be checked."} Work may still be waiting.
      </p>
      {!board.boardUnavailable && <div className="mt-1 space-y-0.5 text-ui-status text-muted">
        {(["needsFinishing", "notTold"] as const).filter((lane) => board.followUpChecks?.[lane] === null).map((lane) => (
          <p key={lane}>{lane === "needsFinishing" ? "Delivery records" : "Client notification"}: {board.followUpLastSuccess?.[lane]
            // ET, through the shared helper: a bare toLocaleString() printed the
            // server's UTC clock and the browser its own zone — two different
            // strings for one render, a hydration error (#418) every time.
            ? `last successful check ${etDateTime(board.followUpLastSuccess[lane])} ET`
            : "no previous successful check recorded"}.</p>
        ))}
      </div>}
      <button type="button" onClick={() => router.refresh()} className="mt-2 min-h-11 rounded-lg border border-border-strong bg-surface px-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Check again</button>
    </div>
  );
  if (ready.length === 0) {
    return (
      <div className="space-y-2">
        {recoveryStatus}
        {!board.boardUnavailable && <p className="flex items-center gap-1.5 text-sm text-muted">
          <CheckCircle2 className="size-4" /> No new files ready to send.
        </p>}
        <NeedsFinishing rows={needsFinishing ?? []} />
        <NotTold rows={notTold} />
        <DeliveryTextIncidents rows={board.noticeIncidents ?? []} includeTest={includeTest} />
        <Rendering rows={rendering} onAryeoChosen={chooseAryeo} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {recoveryStatus}
      <NeedsFinishing rows={needsFinishing ?? []} />
      <NotTold rows={notTold} />
      <DeliveryTextIncidents rows={board.noticeIncidents ?? []} includeTest={includeTest} />
      {[
        { title: "Ready for upload", rows: ready.filter((v) => !usesPortal(v) && !v.uploaded && !isRecorded(v)) },
        { title: "Portal delivery needs attention", rows: ready.filter(usesPortal) },
      ].map((group) => group.rows.length > 0 && <section key={group.title} className="space-y-2"><h4 className="font-semibold">{group.title} <span className="text-muted">({group.rows.length})</span></h4>{group.rows.map((v) => <ReadyRow key={v.submissionId} v={v} onUploaded={(delivered) => uploaded(v, delivered)} onAryeoChosen={() => chooseAryeo(v)} />)}</section>)}
      {uploadedGroups.length > 0 && <section className="space-y-2" aria-label="Uploaded, not sent"><h4 className="font-semibold">Uploaded, not sent <span className="text-muted">({uploadedGroups.length})</span></h4>{uploadedGroups.map(group => <UploadedRow key={group.projectId} group={group} onSent={sentGroup} onUndo={undoUpload} undoErrors={undoErrors} />)}</section>}
      <Rendering rows={rendering} onAryeoChosen={chooseAryeo} />
    </div>
  );
}

function UploadedRow({ group, onSent, onUndo, undoErrors }: { group: ReturnType<typeof uploadedDeliveryGroups>[number]; onSent: (cuts: UploadedTarget[]) => void; onUndo: (v: ReadyVideo) => void; undoErrors: Map<string, string> }) {
  // Only today's own presses can be undone (ET); older receipts are history.
  const undoable = group.videos.filter((v) => v.uploaded?.undoable && v.uploadFingerprint);
  const errors = group.videos.flatMap((v) => undoErrors.has(v.submissionId) ? [undoErrors.get(v.submissionId)!] : []);
  return <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
    <div className="min-w-0 flex-1 basis-48"><p className="break-words text-sm font-medium">{group.title}</p>{group.overdue && <span className="text-xs font-medium text-danger">Past due</span>}
      {undoable.map((v) => <button key={v.submissionId} type="button" onClick={() => onUndo(v)}
        className="mr-3 inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        Undo upload{undoable.length > 1 ? ` · ${v.cutLabel} v${v.round}` : ""}
      </button>)}
      {errors.map((message, i) => <SaveStatus key={i} state="error" message={message} className="block" />)}</div>
    <div className="flex max-w-full flex-wrap items-center gap-2">
      {group.videos.every(v => !!v.uploadFingerprint)
        ? <WatchDeliveryVideo label="Watch" videos={group.videos.map(v => deliveryPreview(v.submissionId, v.uploadFingerprint!, `${v.street} · ${v.cutLabel} · v${v.round}`))} />
        : <Link href={group.watchHref} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium">Watch</Link>}
      {group.aryeoUrl && <a href={group.aryeoUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium">Aryeo listing</a>}
      {group.targets.length === group.videos.length && <MarkProjectSent projectId={group.projectId} cuts={group.targets} onRecorded={onSent} />}
    </div>
  </div>;
}

function DeliveryTextIncidents({ rows, includeTest = false }: { rows: DeliveryNoticeIncident[]; includeTest?: boolean }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-3">
      <p className="flex items-center gap-2 text-ui-status font-semibold text-warning"><AlertTriangle className="size-4" /> Delivery texts needing a check</p>
      <ul className="mt-2 space-y-2">
        {rows.map((r) => (
          <li key={r.projectId} className="text-ui-status leading-relaxed">
            <Link href={`/projects/${r.projectId}`} className="font-semibold hover:text-brand">{r.street}</Link>
            <span className="text-muted"> · {r.state === "unknown" ? "provider outcome unknown — check OpenPhone before retrying" : r.state === "failed" ? "send failed — review the task and client thread" : "send queued or in progress — no acceptance recorded"} · queued {etDateTime(new Date(r.queuedAtISO))}</span>
            <Link href={`/communications?incident=${encodeURIComponent(r.outboxId)}`} className="ml-2 inline-flex min-h-11 items-center rounded-lg font-medium text-brand underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Check conversation</Link>
            {r.taskId && <Link href={homeRecordHref(`/tasks?tab=other&task=${r.taskId}`, includeTest)} className="ml-2 inline-flex min-h-11 items-center rounded-lg font-medium text-brand underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Open task</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The cuts the 1080p lane still owes work on: named, dated, and not offered.
 *  No Download, no "Mark as sent" — the file to send does not exist yet. */
function Rendering({ rows, onAryeoChosen }: { rows: RenderingVideo[]; onAryeoChosen?: (v: RenderingVideo) => void }) {
  if (rows.length === 0) return null;
  // HELD rows first, and apart (O02): the lane has finished with them and is
  // waiting on a PERSON, so they carry the one decision on this footnote. Every
  // other row is only the lane at work and stays unpressable.
  const held = rows.filter((r) => r.held);
  const running = rows.filter((r) => !r.held);
  return (
    <>
      {held.length > 0 && <Held rows={held} />}
      {running.length > 0 && <Running rows={running} onAryeoChosen={onAryeoChosen} />}
    </>
  );
}

/** Finished renders whose sound couldn't be verified. The approved original is
 *  still the deliverable; the row asks somebody to listen and choose. */
function Held({ rows }: { rows: RenderingVideo[] }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-3.5 py-2.5">
      <p className="flex items-center gap-1.5 text-ui-status font-semibold text-warning">
        <AlertTriangle className="size-3.5" /> Held — the 1080p file&rsquo;s sound couldn&rsquo;t be checked
      </p>
      <ul className="mt-1 space-y-2">
        {rows.map((r) => (
          <li key={r.submissionId} className="min-w-0 text-ui-status leading-snug text-muted">
            <Link href={`/projects/${r.projectId}`} className="font-medium text-muted hover:text-brand">{r.street}</Link>
            <span> · {r.cutLabel} · v{r.round}</span>
            <span className={cn(r.waitingHours >= 24 && "font-semibold text-danger")}> · approved {waited(r.waitingHours)} ago</span>
            <span className="block">{r.says}</span>
            {r.held && (
              <HeldRender jobId={r.held.jobId} street={r.street} fileName={r.held.fileName} dropboxUrl={r.held.dropboxUrl} lastCheck={r.held.lastCheck} monthly={!!r.monthlyProgram} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Running({ rows, onAryeoChosen }: { rows: RenderingVideo[]; onAryeoChosen?: (v: RenderingVideo) => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-3.5 py-2.5">
      <p className="flex items-center gap-1.5 text-ui-status font-semibold text-muted">
        <Loader2 className="size-3.5" /> Still in the 1080p pass — not ready yet
      </p>
      <ul className="mt-1 space-y-1">
        {rows.map((r) => (
          <li key={r.submissionId} className="min-w-0 text-ui-status leading-snug text-muted">
            <Link href={`/projects/${r.projectId}`} className="font-medium text-muted hover:text-brand">{r.street}</Link>
            <span> · {r.cutLabel} · v{r.round}</span>
            {/* A render that should have taken half an hour and has been at it
                for a day is the only thing worth shouting about here. */}
            <span className={cn(r.waitingHours >= 24 && "font-semibold text-danger")}> · approved {waited(r.waitingHours)} ago</span>
            <span className="block">{r.says}</span>
            {r.deliveryDestination === "aryeo-listing" && <span className="block">Destination: Aryeo. The finished file will still be saved in Final Dropbox.</span>}
            {r.canChooseAryeo && r.destinationFingerprint && onAryeoChosen && <ChooseAryeoDelivery submissionId={r.submissionId} fingerprint={r.destinationFingerprint} onChosen={() => onAryeoChosen(r)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A press is recent enough that somebody is plainly ON this row right now.
 *  Four hours, because the three steps after Download — upload to Aryeo,
 *  deliver the listing, come back and press Mark as sent — are an afternoon's
 *  work at most, and past that the silence is the story again. */
const IN_HAND_HOURS = 4;

function ReadyRow({ v, onUploaded, onAryeoChosen }: { v: ReadyVideo; onUploaded?: (sent?: boolean) => void; onAryeoChosen?: () => void }) {
  // SOMEBODY STARTED THE HANDOFF — so stop shouting at them briefly (Jordan,
  // Sep 21). A row pulled ten minutes ago rendered identically to one nobody had
  // ever opened, both in red, both reading "ready 3 days". The red goes away
  // while the download is fresh and comes straight back after that,
  // because "download started three days ago and still not sent" is a WORSE fact
  // than "nobody has touched it", not a better one.
  const inHand = v.downloadedHoursAgo != null && v.downloadedHoursAgo < IN_HAND_HOURS;
  const stale = v.waitingHours >= 24 && !inHand;
  return (
    // min-w-0 all the way down + wrapping rows: at 375px the address, the file
    // name and the buttons stack instead of pushing the page sideways.
    <div className="min-w-0 rounded-xl border border-border px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm leading-snug">
        <Link href={`/projects/${v.projectId}`} className="font-semibold hover:text-brand">
          {v.monthlyProgram ? v.clientName : v.street}
        </Link>
        {v.monthlyProgram && <span className="text-muted">· {v.monthKey ? monthName(v.monthKey) : "Month link unverified"}</span>}
        {v.monthlyProgram && <span className="min-w-0 font-medium">· {v.topicTitle ?? "Topic not linked"}</span>}
        <span className={cn(
          "rounded px-1.5 py-0.5 text-ui-status font-semibold",
          v.file.source === "topaz-1080p" ? "bg-brand/15 text-brand" : "bg-warning/15 text-warning",
        )}>
          {v.portalStep?.blocked ? "Needs 1080p" : SOURCE_CHIP[v.file.source]}
        </span>
        {v.overdue && (
          <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-ui-status font-bold text-danger">
            <AlertTriangle className="size-2.5" /> past due
          </span>
        )}
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
        {!v.monthlyProgram && <span className="inline-flex items-center gap-1"><Avatar name={v.clientName} src={v.clientAvatarUrl} size={16} />{v.clientName} ·</span>}
        <span className="font-medium text-foreground">{v.cutLabel} · version {v.round}</span>
        <span>· Kyle · <span className={cn(stale && "font-semibold text-danger")}>ready {waited(v.waitingHours)}</span></span>
      </p>
      <p className="mt-1 text-sm text-muted">Approved {etDateTime(new Date(v.approvedAtISO))}{v.approvedBy ? ` by ${v.approvedBy}` : ""}.</p>
      {/* A portal video: exactly what stands between it and the client, and
          the one button that moves it (Oct 5 2026). */}
      {usesPortal(v) && v.portalStep
        ? <PortalNextStep submissionId={v.submissionId} street={v.street} clientName={v.clientName} step={v.portalStep} dropboxUrl={v.file.dropboxUrl} />
        : !usesPortal(v) && v.listingMissing
          // The upload can't be recorded against a listing the job doesn't
          // have, so the button would only ever be refused (Oct 5 2026).
          ? <p className="mt-1 text-sm font-medium text-warning">
            <Link href={`/projects/${v.projectId}`} className="underline underline-offset-2 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Link the Aryeo listing first</Link>
            <span className="font-normal text-muted"> — open the job and press Refresh from Aryeo. Then upload this version.</span>
          </p>
          : <p className="mt-1 text-sm text-foreground/85">
          {usesPortal(v)
            ? "Destination: the client's portal, with a backup in the Final Dropbox folder."
            : `Upload this version to Aryeo, then record the upload.${v.monthlyProgram ? " Its final Dropbox backup is retained." : ""}`}
        </p>}

      {/* The route records a successful handoff of a link or start of a stream.
          That cannot prove the device saved the complete file or the client
          received it. A route error leaves the row unstamped. */}
      {v.downloadedAtISO && (
        <p className={cn("mt-1 text-sm", inHand ? "text-muted" : "font-medium text-warning")}>
          Download started{v.downloadedBy ? ` by ${v.downloadedBy}` : ""} {etDateTime(new Date(v.downloadedAtISO))} ET
          {inHand
            ? " — receipt on the device and client delivery are not verified."
            : ` — ${waited(v.downloadedHoursAgo ?? 0)} ago; client delivery is still unverified.`}
        </p>
      )}

      {v.listing && (v.listing.contested || v.listing.couldBeThisCut) && (
        <p className={cn("mt-2 flex items-start gap-1 text-sm", v.listing.contested ? "font-medium text-danger" : "text-warning")}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {v.listing.says}
        </p>
      )}

      {/* Technical file identity and provider evidence stay available without
          making Kyle read them before he can see the next action. */}
      <details className="mt-2 rounded-lg border border-border bg-surface-2/40">
        <summary className="min-h-11 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">File and delivery evidence</summary>
        <div className="px-3 pb-3">
          <p className="text-sm leading-relaxed text-muted">
            <span className="block">Approved {etDateTime(new Date(v.approvedAtISO))}{v.approvedBy ? ` by ${v.approvedBy}` : ""}.</span>
            <span className="mt-1 block font-medium text-foreground">{v.file.says}</span>
            {/* break-all: a real file name is "Done_322 N 62nd St_Stephen
                Kennedy_1_prob4.mp4" and would otherwise run off a phone. */}
            <span className="mt-0.5 block break-all font-mono text-ui-status">{v.file.fileName}</span>
            {/* A DOOR, NOT A STRING (Jordan, Sep 21 2026: "I dont think we need to
                show the file path on dropbox, a link to the dropbox would be
                better"). The path was four lines of
                /AutoHDR/2026/Q3/September/… that nobody reads and nobody can
                click. This opens the file itself, previewed in the folder it lives
                in, where Kyle already works.

                THE LABEL SAYS WHAT THE LINK DOES. It read "Open the Dropbox folder"
                while the URL was built from the file's own path (review, Sep 21):
                two different promises, neither of them kept. dropboxFileUrl in
                lib/readyToSend now builds the one form Dropbox honours for a file —
                the parent folder, with the file named in ?preview= — and the words
                here match it.

                The full path is still on the row, as the link's title: a deep
                link into a folder that has since been reorganised lands somewhere
                unhelpful, and the string is what you search with when it does —
                322 N 62nd St's Final Video folder was emptied out from under this
                very pointer. Shown on hover, not in the layout. */}
            {v.file.dropboxUrl && (
              <a
                href={v.file.dropboxUrl}
                target="_blank"
                rel="noreferrer"
                title={v.file.dropboxPath ?? undefined}
                className="mt-0.5 inline-flex min-h-11 items-center gap-1 rounded-lg text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <FileVideo className="size-3 shrink-0" />
                Open this file in Dropbox
              </a>
            )}
            {/* Only when the bytes come from the hub's own store AND no filed copy
                is on record. Saying "it's in Dropbox" when it is not is how this
                morning happened — and saying it is NOT there when it is sends Kyle
                hunting for a file he is standing on. */}
            {v.file.source === "editor-hub-copy" && !v.file.dropboxPath && (
              <span className="mt-0.5 block">The hub is holding this file — it isn&rsquo;t in the job&rsquo;s Final Video folder.</span>
            )}
            {v.file.why && <span className="mt-1 block italic">Why the 1080p pass didn&rsquo;t produce it: {v.file.why}</span>}
            {/* WHAT ARYEO IS ALREADY SHOWING ON THIS LISTING.
                The card cannot prove that the video up there is this file — a
                re-cut looks exactly like a first cut from the outside — so it
                stops pretending the question isn't there and answers the half it
                can. A row that is really done becomes one look and one tap with the
                evidence beside it instead of a trip to Aryeo to find out; a row
                that is really owed gets the listing saying so out loud.

                THREE COLOURS, BECAUSE THEY ARE THREE DIFFERENT SITUATIONS and
                colour is what gets scanned first. Muted: the listing supports the
                row, or nobody has looked — nothing to decide. Warning: something up
                there could be this file, so somebody has to play it before the
                button. Danger: the client has complained about this job SINCE this
                file was ready, so what is up there may be the very thing they are
                complaining about — 322 N 62nd St, where clearing the row costs a
                client their video. Until Sep 17 these last two rendered
                identically, in the same colour, with the same closing words. */}
            {v.listing && !v.listing.contested && !v.listing.couldBeThisCut && (
              <span className="mt-1 flex items-start gap-1 text-muted">
                <ExternalLink className="mt-0.5 size-3 shrink-0" />
                {v.listing.says}
              </span>
            )}
            {/* Two approved exports of one video. The newest is above; the others
                are NAMED rather than dropped, so "which file did I send?" has an
                answer on screen. */}
            {v.alsoOnFile.length > 0 && (
              <span className="mt-1 flex items-start gap-1 break-all">
                <Files className="mt-0.5 size-3 shrink-0" />
                Also approved on this job, older: {v.alsoOnFile.join(", ")} — the newest is the one offered here.
              </span>
            )}
          </p>
        </div>
      </details>

      {v.uploaded && <p className="mt-2 text-sm">Uploaded by {v.uploaded.by} · {etDateTime(new Date(v.uploaded.at))}</p>}
      {v.uploaded && <div className="mt-2"><MarkSent submissionId={v.submissionId} street={v.street} expectedFingerprint={v.uploadFingerprint ?? undefined} /></div>}
      <section className="mt-3" aria-label="Files and upload"><h5 className="mb-2 text-sm font-medium">Files and upload</h5>
      <div className="flex flex-wrap items-center gap-2">
        {/* No checked 1080p file yet: nothing for a portal video to hand over. */}
        {!v.portalStep?.blocked && <DownloadFile href={v.file.downloadHref} taken={Boolean(v.downloadedAtISO)} />}
        {!usesPortal(v) && v.aryeoUrl && (
          <a
            href={v.aryeoUrl}
            target="_blank"
            rel="noreferrer"
            title={v.aryeoTitle}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <ExternalLink className="size-3.5" /> Aryeo
          </a>
        )}
        {v.uploadFingerprint && !usesPortal(v) ? <WatchDeliveryVideo videos={[deliveryPreview(v.submissionId, v.uploadFingerprint, `${v.street} · ${v.cutLabel} · v${v.round}`)]} /> : <Link
          href={v.reviewHref} prefetch={false}
          className="inline-flex min-h-11 min-w-11 max-w-full items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <Eye className="size-3.5" /> Watch it
        </Link>}
        {!usesPortal(v) && !v.uploaded && !v.listingMissing && v.uploadFingerprint && <MarkUploaded submissionId={v.submissionId} fingerprint={v.uploadFingerprint} onUploaded={onUploaded} />}
        {/* THE RETRY LIVES WHERE THE FAILURE IS READ (Jordan, Sep 18: "I need a
            way to retry the render without going into connections"). Offered
            only on a row whose 1080p pass did NOT produce the file — there is a
            job to re-run and a reason printed two lines above it. A row already
            carrying the enhanced file has nothing to retry, and showing the
            button there would invite spending money to replace a good file. */}
        {v.topazJobId && v.file.source !== "topaz-1080p" && !usesPortal(v) && (
          <RetryRender jobId={v.topazJobId} street={v.street} />
        )}
      </div>
        {v.uploaded && <CorrectUpload submissionId={v.submissionId} receiptId={v.uploaded.id} />}
        {usesPortal(v) && v.canChooseAryeo && v.destinationFingerprint && onAryeoChosen && <ChooseAryeoDelivery submissionId={v.submissionId} fingerprint={v.destinationFingerprint} onChosen={onAryeoChosen} />}
      </section>
    </div>
  );
}

/** Long enough for the route to have minted its Dropbox link and written the
 *  stamp, short enough that the row repaints while Kyle is still looking at it.
 *  A refresh that finds nothing new changes nothing on screen, so erring late
 *  costs a second and erring early costs the sentence. */
const REPAINT_AFTER_MS = 2500;

/**
 * DOWNLOAD — the bytes, and nothing else.
 *
 * Still a plain <a>. The href is a route that mints a fresh Dropbox link on
 * every press (see /api/topaz/download/[id]), so the link works on day thirty;
 * the anchor is deliberately untouched — navigation, middle-click, "save link
 * as" and the browser's own download handling all keep working exactly as they
 * did.
 *
 * THE PRESS WRITES NOTHING (review, Sep 21 2026). It used to fire
 * recordCutDownloadedAction from here, which is a press, not a hand-off: both
 * download routes have real failure exits — 409 the 1080p file is not filed
 * yet, 404 it was moved or renamed in Dropbox, 502 Dropbox refused — and on
 * every one of them the row was left permanently reading "Downloaded by Kyle"
 * for a file nobody had. 322 N 62nd St, whose Final Video folder was emptied
 * out from under its own pointer, is that 404. First press wins, so nothing
 * could correct it, and the four-hour quiet period then suppressed the red
 * "waiting 3 days" on the one row where the file was actually missing.
 *
 * The stamp is now written inside the routes, once Dropbox has handed over a
 * link or the store has started returning bytes. All this does afterwards is
 * come back and look: if the file was served the row repaints with who has it,
 * and if it was not the row honestly still reads untouched.
 *
 * AND IT IS NOT "SENT". Pressing this does not take the row off the card, does
 * not change what the card says is owed, and does not touch Aryeo, the
 * project's status or the cut's sentToClientAt. A client has the video when
 * Kyle has uploaded it and delivered the listing — nothing less, and no
 * download will ever be allowed to stand in for that.
 */
function DownloadFile({ href, taken }: { href: string; taken: boolean }) {
  const router = useRouter();
  return (
    <a
      href={href}
      onClick={() => {
        // Already stamped: the first hand-off is the one that answers "since
        // when", so a second copy changes nothing and there is nothing to see.
        if (taken) return;
        window.setTimeout(() => router.refresh(), REPAINT_AFTER_MS);
      }}
      className="inline-flex min-h-11 min-w-11 max-w-full items-center gap-1.5 rounded-lg bg-brand-action px-3 py-1.5 text-sm font-semibold text-brand-fg hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <Download className="size-4" /> Download
    </a>
  );
}

/** The heading the block and the section share, so the count is written once. */
export function ReadyToSendHeading({ n }: { n: number }) {
  return (
    <h4 className="flex items-center gap-1.5 text-ui-status font-bold uppercase tracking-widest text-success">
      <Send className="size-3.5" /> Video delivery
      <span className="rounded-full bg-success/15 px-1.5 text-ui-status tabular-nums text-success">{n}</span>
    </h4>
  );
}

/**
 * R5 — SENT, BUT OUR OWN RECORDS DID NOT FINISH.
 *
 * The video really did go and that stamp is permanent — this is never a reason
 * to send anything again, and the wording says so twice because the one thing
 * that must not happen here is a second upload. It is derived on every read, so
 * unlike the in-page "press again" it survives a refresh, and it disappears by
 * itself when the hourly repair closes the gap.
 */
function NeedsFinishing({ rows }: { rows: { submissionId: string; street: string; sentAtISO: string; sentBy: string | null; why: string }[] }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2">
      <p className="text-ui-status font-semibold text-warning">
        {rows.length === 1 ? "One video is recorded as sent but its paperwork did not finish" : `${rows.length} videos are recorded as sent but their paperwork did not finish`}
      </p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.submissionId} className="text-ui-status text-muted">
            <span className="font-medium text-foreground/85">{r.street}</span> — {r.why}.{" "}
            {r.sentBy ? `Marked sent by ${r.sentBy}.` : "Marked sent."}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-ui-status text-muted">
        The handoff is recorded; this alone does not prove client approval, notification or receipt. Reconcile the named records without uploading or sending again. The hourly check retries this bookkeeping, and the note clears when those records are complete.
      </p>
    </div>
  );
}
