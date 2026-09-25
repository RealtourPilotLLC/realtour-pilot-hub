"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Eye, FileVideo, Files, Loader2, Send } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { MarkSent } from "@/components/ops/MarkSent";
import { RetryRender } from "@/components/ops/RetryRender";
import { HeldRender } from "@/components/ops/HeldRender";
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

const SOURCE_CHIP: Record<ReadyVideo["file"]["source"], string> = {
  "topaz-1080p": "1080p",
  "editor-hub-copy": "Editor's file",
  "editor-dropbox": "Editor's file",
};

export function ReadyToSendCard({ board }: { board: ReadyBoard }) {
  const { ready, rendering, needsFinishing } = board;
  if (ready.length === 0) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> Nothing waiting to go out.
        </p>
        <NeedsFinishing rows={needsFinishing ?? []} />
        <Rendering rows={rendering} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <NeedsFinishing rows={needsFinishing ?? []} />
      <p className="text-[11px] text-muted">
        Download the file, upload it to Aryeo and deliver the listing — then mark it sent. Aryeo has no way for
        another program to do that step, so this card is the record that it happened. Each row also says what Aryeo
        is showing on that listing: the hub re-checks every hour, so a row that says it can&rsquo;t tell yet will
        name the video shortly. Downloading the file is noted on the row so nobody doubles up on it, but it
        isn&rsquo;t delivery &mdash; a row leaves this card when it&rsquo;s marked sent, or when the hourly check
        finds it live on Aryeo.
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
  // HELD rows first, and apart (O02): the lane has finished with them and is
  // waiting on a PERSON, so they carry the one decision on this footnote. Every
  // other row is only the lane at work and stays unpressable.
  const held = rows.filter((r) => r.held);
  const running = rows.filter((r) => !r.held);
  return (
    <>
      {held.length > 0 && <Held rows={held} />}
      {running.length > 0 && <Running rows={running} />}
    </>
  );
}

/** Finished renders whose sound couldn't be verified. The approved original is
 *  still the deliverable; the row asks somebody to listen and choose. */
function Held({ rows }: { rows: RenderingVideo[] }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-3.5 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
        <AlertTriangle className="size-3.5" /> Held — the 1080p file&rsquo;s sound couldn&rsquo;t be checked
      </p>
      <ul className="mt-1 space-y-2">
        {rows.map((r) => (
          <li key={r.submissionId} className="min-w-0 text-[11px] leading-snug text-muted-2">
            <Link href={`/projects/${r.projectId}`} className="font-medium text-muted hover:text-brand">{r.street}</Link>
            <span> · {r.cutLabel} · v{r.round}</span>
            <span className={cn(r.waitingHours >= 24 && "font-semibold text-danger")}> · approved {waited(r.waitingHours)} ago</span>
            <span className="block">{r.says}</span>
            {r.held && (
              <HeldRender jobId={r.held.jobId} street={r.street} fileName={r.held.fileName} dropboxUrl={r.held.dropboxUrl} lastCheck={r.held.lastCheck} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Running({ rows }: { rows: RenderingVideo[] }) {
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

/** A press is recent enough that somebody is plainly ON this row right now.
 *  Four hours, because the three steps after Download — upload to Aryeo,
 *  deliver the listing, come back and press Mark as sent — are an afternoon's
 *  work at most, and past that the silence is the story again. */
const IN_HAND_HOURS = 4;

function ReadyRow({ v }: { v: ReadyVideo }) {
  // SOMEBODY IS DOING THIS RIGHT NOW — so stop shouting at them (Jordan, Sep
  // 21). A row pulled ten minutes ago rendered identically to one nobody had
  // ever opened, both in red, both reading "ready 3 days". The red goes away
  // while the file is freshly in hand and comes straight back after that,
  // because "downloaded three days ago and still not sent" is a WORSE fact
  // than "nobody has touched it", not a better one.
  const inHand = v.downloadedHoursAgo != null && v.downloadedHoursAgo < IN_HAND_HOURS;
  const stale = v.waitingHours >= 24 && !inHand;
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

      {/* WHO HAS THE FILE, AND SINCE WHEN.
          Written by the download route once the file has actually been handed
          over, not by the press — a 409, a 404 on a moved file or a 502 leaves
          this line off the row, because nobody has anything. It is the
          difference between "nobody has looked at this in three days" and "Kyle
          is on it" — and on Sep 21, when 5 Raymond Cir, 453 Cardigan Terrace
          and 5642 Limeport Rd had all been sitting for days, the card could not
          tell those two apart on any row.

          IT SAYS OUT LOUD THAT IT IS NOT DELIVERY. Having the file is one step
          of three. The row is still here, still owed, and still needs Mark as
          sent or the hourly Aryeo check — and the sentence says so rather than
          letting a green tick imply otherwise. */}
      {v.downloadedAtISO && (
        <p className={cn("mt-0.5 text-[11px]", inHand ? "text-success" : "font-medium text-warning")}>
          Downloaded{v.downloadedBy ? ` by ${v.downloadedBy}` : ""} {etDateTime(new Date(v.downloadedAtISO))} ET
          {inHand
            ? " — still needs uploading to Aryeo and marking sent."
            : ` — that was ${waited(v.downloadedHoursAgo ?? 0)} ago and it still hasn’t been marked sent.`}
        </p>
      )}

      {/* Which file, and why it is that one rather than the other. */}
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-2">
        <span className="font-medium text-foreground">{v.file.says}</span>
        {/* break-all: a real file name is "Done_322 N 62nd St_Stephen
            Kennedy_1_prob4.mp4" and would otherwise run off a phone. */}
        <span className="mt-0.5 block break-all font-mono text-[10px]">{v.file.fileName}</span>
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
            className="mt-0.5 inline-flex items-center gap-1 text-muted hover:text-brand hover:underline"
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
        <DownloadFile href={v.file.downloadHref} taken={Boolean(v.downloadedAtISO)} />
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
        {/* THE RETRY LIVES WHERE THE FAILURE IS READ (Jordan, Sep 18: "I need a
            way to retry the render without going into connections"). Offered
            only on a row whose 1080p pass did NOT produce the file — there is a
            job to re-run and a reason printed two lines above it. A row already
            carrying the enhanced file has nothing to retry, and showing the
            button there would invite spending money to replace a good file. */}
        {v.topazJobId && v.file.source !== "topaz-1080p" && (
          <RetryRender jobId={v.topazJobId} street={v.street} />
        )}
      </div>
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
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
    >
      <Download className="size-3.5" /> Download
    </a>
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
      <p className="text-[11px] font-semibold text-warning">
        {rows.length === 1 ? "One video is recorded as sent but its paperwork did not finish" : `${rows.length} videos are recorded as sent but their paperwork did not finish`}
      </p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.submissionId} className="text-[11px] text-muted">
            <span className="font-medium text-foreground/85">{r.street}</span> — {r.why}.{" "}
            {r.sentBy ? `Marked sent by ${r.sentBy}.` : "Marked sent."}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-muted-2">
        The client has these. Nothing needs re-uploading or re-sending — the hourly check finishes our own records, and
        this note clears itself when it does.
      </p>
    </div>
  );
}
