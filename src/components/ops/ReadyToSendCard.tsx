import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Eye, Files, FolderOpen, Loader2, Send } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { MarkSent } from "@/components/ops/MarkSent";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import type { ReadyBoard, ReadyVideo, RenderingVideo } from "@/lib/readyToSend";

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
// A SERVER COMPONENT. It renders rows the page already fetched (opsDay), and
// the only interactive part is <MarkSent/>, which is a client island holding an
// id. Nothing here reaches the database, and nothing here can reach a client:
// the buttons are "download the file" and "record what you did".
//
// OWNER/ADMIN ONLY. Enforced by the caller (Home hides it) AND by both things
// it can actually do — the download routes are requireRole(OWNER/ADMIN) /
// canViewProject, and markVideoSentAction is requireAdmin. No editor or
// photographer ever sees a client delivery surface.
// ---------------------------------------------------------------------------

/** "3h" / "2 days" — the same unit the rest of the day uses. */
function waited(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

const SOURCE_CHIP: Record<ReadyVideo["file"]["source"], string> = {
  "topaz-1080p": "1080p",
  "editor-hub-copy": "Editor's file",
  "editor-dropbox": "Editor's file",
};

export function ReadyToSendCard({ board }: { board: ReadyBoard }) {
  const { ready, rendering } = board;
  if (ready.length === 0) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> Nothing waiting to go out.
        </p>
        <Rendering rows={rendering} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted">
        Download the file, upload it to Aryeo and deliver the listing — then mark it sent. Aryeo has no way for
        another program to do that step, so this card is the record that it happened. Each row also says what Aryeo
        is showing on that listing: the hub re-checks every hour, so a row that says it can&rsquo;t tell yet will
        name the video shortly.
      </p>
      {ready.map((v) => <ReadyRow key={v.submissionId} v={v} />)}
      <Rendering rows={rendering} />
    </div>
  );
}

/** The cuts the 1080p lane still owes work on: named, dated, and not offered.
 *  No Download, no "Mark as sent" — the file to send does not exist yet. */
function Rendering({ rows }: { rows: RenderingVideo[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-dashed border-border px-3.5 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
        <Loader2 className="size-3.5" /> Still in the 1080p pass — not ready yet
      </p>
      <ul className="mt-1 space-y-1">
        {rows.map((r) => (
          <li key={r.submissionId} className="min-w-0 text-[11px] leading-snug text-muted-2">
            <Link href={`/projects/${r.projectId}`} className="font-medium text-muted hover:text-brand">{r.street}</Link>
            <span> · {r.cutLabel} · v{r.round}</span>
            {/* A render that should have taken half an hour and has been at it
                for a day is the only thing worth shouting about here. */}
            <span className={cn(r.waitingHours >= 24 && "font-semibold text-danger")}> · approved {waited(r.waitingHours)} ago</span>
            <span className="block">{r.says}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReadyRow({ v }: { v: ReadyVideo }) {
  const stale = v.waitingHours >= 24;
  return (
    // min-w-0 all the way down + wrapping rows: at 375px the address, the file
    // name and the buttons stack instead of pushing the page sideways.
    <div className="min-w-0 rounded-xl border border-border px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm leading-snug">
        <Link href={`/projects/${v.projectId}`} className="font-semibold hover:text-brand">{v.street}</Link>
        <span className="min-w-0 text-muted">· {v.cutLabel}</span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">v{v.round}</span>
        <span className={cn(
          "rounded px-1.5 py-0.5 text-[10px] font-semibold",
          v.file.source === "topaz-1080p" ? "bg-brand/15 text-brand" : "bg-warning/15 text-warning",
        )}>
          {SOURCE_CHIP[v.file.source]}
        </span>
        {v.overdue && (
          <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold text-danger">
            <AlertTriangle className="size-2.5" /> past due
          </span>
        )}
      </div>

      <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] text-muted">
        <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
          <Avatar name={v.clientName} src={v.clientAvatarUrl} size={16} />
          <span className="truncate">{v.clientName}</span>
        </span>
        <span>· approved {etDateTime(new Date(v.approvedAtISO))}{v.approvedBy ? ` by ${v.approvedBy}` : ""}</span>
        <span>·</span>
        <span className={cn(stale && "font-semibold text-danger")}>ready {waited(v.waitingHours)}</span>
      </p>

      {/* Which file, and why it is that one rather than the other. */}
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-2">
        <span className="font-medium text-foreground">{v.file.says}</span>
        {/* break-all: a real file name is "Done_322 N 62nd St_Stephen
            Kennedy_1_prob4.mp4" and would otherwise run off a phone. */}
        <span className="mt-0.5 block break-all font-mono text-[10px]">{v.file.fileName}</span>
        {v.file.dropboxPath && (
          <span className="mt-0.5 flex items-start gap-1 break-all">
            <FolderOpen className="mt-0.5 size-3 shrink-0" />
            {v.file.dropboxPath}
          </span>
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
        {v.listing && (
          <span
            className={cn(
              "mt-1 flex items-start gap-1",
              v.listing.contested ? "font-medium text-danger" : v.listing.couldBeThisCut ? "text-warning" : "text-muted-2",
            )}
          >
            {v.listing.contested ? <AlertTriangle className="mt-0.5 size-3 shrink-0" /> : <ExternalLink className="mt-0.5 size-3 shrink-0" />}
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

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          href={v.file.downloadHref}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        >
          <Download className="size-3.5" /> Download
        </a>
        {v.aryeoUrl && (
          <a
            href={v.aryeoUrl}
            target="_blank"
            rel="noreferrer"
            title={v.aryeoTitle}
            className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" /> Aryeo
          </a>
        )}
        <Link
          href={v.reviewHref}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <Eye className="size-3.5" /> Watch it
        </Link>
        <MarkSent submissionId={v.submissionId} street={v.street} />
      </div>
    </div>
  );
}

/** The heading the block and the section share, so the count is written once. */
export function ReadyToSendHeading({ n }: { n: number }) {
  return (
    <h4 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-success">
      <Send className="size-3.5" /> Ready to send
      <span className="rounded-full bg-success/15 px-1.5 text-[10px] tabular-nums text-success">{n}</span>
    </h4>
  );
}
