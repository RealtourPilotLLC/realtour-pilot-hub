import Link from "next/link";
import { ArrowRight, Camera, Flag, MessageSquareWarning, PlayCircle, StickyNote, Video } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { jobDeliverables, type JobDeliverables, type StageStep, type VideoItem } from "@/lib/jobsBoard";
import type { JobCheckFlag, JobCheckRequest, JobChecks } from "@/lib/jobChecks";
import { loadBeforeYouSend } from "./BeforeYouSend";
import { CheckedButton } from "./CheckedButton";
import { RequestOwnerPicker } from "./RequestOwnerPicker";
import { StageChip, TONE_CLASS } from "./StageChip";
import { SendVideo } from "@/components/videoDelivery/SendVideo";
import { PushControls } from "@/components/videoDelivery/PushControls";
import { isOffice } from "@/lib/auth/access";

// ---------------------------------------------------------------------------
// ONE PAGE PER SHOOT: the Photos card and the Video card (Oct 19 2026), at the
// top of the job page, side by side (stacked on a phone). Jordan: "I need to
// be able to track each job and where they are at, and special requests for
// either photo or video, and individual photos and videos."
//
// Each card: where it stands (the same chip as the Shoots row) and a step bar
// (Photos: Shot, Edited, QC, Revisions only while in revisions, Delivered;
// Video: Shot, Edited, Reviewed, Ready, Sent, monthly content skips Ready);
// the individual work (the photo count and how many are flagged, opening the
// photo job; each video with its version and where it stands, opening the
// Review Room's player, and the room's own send button when it is ready to
// send); that medium's client requests WITH WHO OWNS EACH ONE (the creative
// until the shoot is over, then Kyle for photos and the job's editor for
// video; an unclear one "needs an owner" with a picker); and what was flagged
// at the shoot and the notes, from the job's "Before you send" read
// (lib/jobChecks, not a second query). A flag or note that applies to both
// shows once, under the cards. One "Checked" per card confirms its requests.
// ---------------------------------------------------------------------------

export type JobDeliverablesData = { data: JobDeliverables; photo: JobChecks; video: JobChecks; canCheck: boolean };

export async function loadJobDeliverables(projectId: string, now: Date = new Date()): Promise<JobDeliverablesData | null> {
  const [data, photo, video] = await Promise.all([
    jobDeliverables(projectId, now).catch((e: unknown) => {
      console.error("[job-deliverables] read failed", projectId, e);
      return null;
    }),
    loadBeforeYouSend(projectId, "photo"),
    loadBeforeYouSend(projectId, "video"),
  ]);
  if (!data) return null;
  return { data, photo: photo.data, video: video.data, canCheck: photo.canCheck };
}

export async function JobDeliverablesSection({ projectId }: { projectId: string }) {
  const d = await loadJobDeliverables(projectId);
  if (!d) return null;
  // Sending a video to Aryeo is the office's press (Oct 21 2026): the creative
  // manager reads where it stands and gets the link to the room instead.
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  if (me && !isOffice(me.role)) {
    d.data.video.items = d.data.video.items.map((v) => (v.send ? { ...v, send: { ...v.send, canPress: false, sendNow: false } } : v));
  }
  return <JobDeliverablesView {...d} />;
}

const STEP_BAR: Record<StageStep["state"], string> = { done: "bg-success", now: "bg-brand", todo: "bg-surface-2" };

function Steps({ steps, label }: { steps: StageStep[]; label: string }) {
  if (!steps.length) return null;
  return (
    <ol aria-label={label} className="grid gap-1 px-4 pb-1 pt-3" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((s) => (
        <li key={s.label} aria-current={s.state === "now" ? "step" : undefined} data-step={s.state} className={`grid gap-1 text-[11px] ${s.state === "now" ? "font-semibold text-foreground" : "text-muted"}`}>
          <span aria-hidden className={`block h-1.5 rounded-full ${STEP_BAR[s.state]}`} />
          <span className="truncate">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

const OWNER_CLASS = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium";

function Requests({ medium, checks, canCheck }: { medium: "photo" | "video"; checks: JobChecks; canCheck: boolean }) {
  const thing = medium === "photo" ? "the photos" : "the video";
  if (!checks.requests.length) {
    return checks.checked ? (
      <p className="text-xs text-muted" data-requests-checked>
        Client requests checked by {checks.checked.by}, {etDateTime(checks.checked.atISO)}.
      </p>
    ) : null;
  }
  return (
    <div className="space-y-2" data-card-requests={medium}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <MessageSquareWarning aria-hidden className="size-3.5 text-warning" /> Client requests for {thing}
      </p>
      <ul className="space-y-1.5">
        {checks.requests.map((r: JobCheckRequest) => (
          <li key={r.id} data-request-id={r.id} className="space-y-1.5 rounded-lg bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">{r.summary}</p>
                <p className="text-xs text-muted">
                  {r.askedBy ?? "The client"} · {etDateTime(r.askedAtISO)}
                </p>
              </div>
              {r.owner && (
                <span data-owner={r.owner.role} className={`${OWNER_CLASS} ${r.owner.needsOwner ? TONE_CLASS.waiting : "bg-surface text-foreground ring-1 ring-border"}`}>
                  {r.owner.label}
                </span>
              )}
            </div>
            {canCheck && (r.owner?.needsOwner || !["photo", "video", "both"].includes(String(r.medium ?? ""))) && <RequestOwnerPicker askId={r.id} />}
            {r.text.trim() && r.text.trim() !== r.summary.trim() && (
              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-brand">The client&rsquo;s words</summary>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-surface px-2 py-1.5 text-[13px] text-foreground/85">{r.text}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
      {canCheck ? (
        <CheckedButton projectId={checks.projectId} medium={medium} count={checks.requests.length} compact />
      ) : (
        <p className="text-xs text-muted">Kyle checks {checks.requests.length === 1 ? "this" : "these"} before {thing} go{medium === "video" ? "es" : ""} out.</p>
      )}
    </div>
  );
}

function FlagList({ flags, title = "Flagged at the shoot" }: { flags: JobCheckFlag[]; title?: string }) {
  if (!flags.length) return null;
  return (
    <div className="space-y-1" data-card-flags>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
        <Flag aria-hidden className="size-3.5" /> {title}
      </p>
      <ul className="space-y-1">
        {flags.map((f) => (
          <li key={f.id} className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-sm">
            <p className="text-foreground">{f.text}</p>
            <p className="text-xs text-muted">
              {f.by ?? "The photographer"} · {etDateTime(f.atISO)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoteList({ notes, title = "Notes" }: { notes: { label: string; text: string }[]; title?: string }) {
  if (!notes.length) return null;
  return (
    <div className="space-y-1" data-card-notes>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <StickyNote aria-hidden className="size-3.5" /> {title}
      </p>
      <dl className="space-y-1 text-sm">
        {notes.map((n, i) => (
          <div key={`${n.label}-${i}`} className="flex flex-wrap gap-x-1.5">
            <dt className="font-medium text-muted">{n.label}:</dt>
            <dd className="min-w-0 text-foreground/90">{n.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Card({ icon, title, stage, empty, link, steps, stepsLabel, children }: {
  icon: React.ReactNode; title: string; stage: JobDeliverables["photos"]["stage"]; empty: string; link: { href: string; label: string } | null;
  steps: StageStep[]; stepsLabel: string; children: React.ReactNode;
}) {
  return (
    <section aria-label={title} data-card={title.toLowerCase()} className="min-w-0 rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
        <StageChip stage={stage} empty={empty} />
        {link && (
          <Link href={link.href} className="ml-auto inline-flex min-h-9 items-center gap-1 text-xs font-medium text-brand hover:underline">
            {link.label} <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </header>
      <Steps steps={steps} label={stepsLabel} />
      <div className="space-y-4 px-4 py-3">{children}</div>
    </section>
  );
}

function VideoRowView({ v, street }: { v: VideoItem; street: string }) {
  const send = v.send;
  return (
    <li data-video-item={v.phase} className="space-y-1 rounded-lg bg-surface-2 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{v.label}</p>
          <p className={`text-xs ${v.late ? "font-semibold text-danger" : "text-muted"}`}>
            {v.words}
            {v.late ? " · late" : ""}
          </p>
        </div>
        {v.href && (
          <Link href={v.href} className="inline-flex min-h-9 shrink-0 items-center gap-1 text-xs font-medium text-brand hover:underline">
            <PlayCircle aria-hidden className="size-3.5" /> Watch
          </Link>
        )}
      </div>
      {v.phase === "ready" && send?.progress && <p className="text-xs text-muted">{send.progress}</p>}
      {v.phase === "ready" && send?.canPress ? (
        <SendVideo submissionId={send.submissionId} street={street} label={send.label} openAsks={send.openAsks} asksUnknown={send.asksUnknown} listingWarning={send.listingWarning} uploadOnly={send.uploadOnly} />
      ) : v.phase === "ready" && send?.sendNow ? (
        // Uploaded only (Oct 23 2026): Send now, the room's own press.
        <PushControls submissionId={send.submissionId} canDeliverNow canRelease={false} uploadedOnly />
      ) : v.phase === "ready" ? (
        <div className="space-y-0.5 text-xs">
          {send?.byHandWhy && <p className="font-medium text-warning">{send.byHandWhy}</p>}
          <Link href={v.href ?? "/review"} data-send-in-room className="inline-flex min-h-9 items-center gap-1 font-medium text-brand hover:underline">
            Send it in the Video Review Room <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      ) : null}
    </li>
  );
}

/** Flags and notes that apply to both cards show once, under them. */
function split<T>(photo: T[], video: T[], key: (x: T) => string): { both: T[]; photoOnly: T[]; videoOnly: T[] } {
  const inVideo = new Set(video.map(key));
  const inPhoto = new Set(photo.map(key));
  return { both: photo.filter((x) => inVideo.has(key(x))), photoOnly: photo.filter((x) => !inVideo.has(key(x))), videoOnly: video.filter((x) => !inPhoto.has(key(x))) };
}

export function JobDeliverablesView({ data, photo, video, canCheck }: JobDeliverablesData) {
  const p = data.photos;
  const v = data.video;
  const flags = split(photo.flags, video.flags, (f) => f.id);
  const notes = split(photo.notes, video.notes, (n) => `${n.label}|${n.text}`);
  const anything = p.ordered || v.ordered || photo.requests.length || video.requests.length || photo.flags.length || video.flags.length;
  if (!anything) return null;
  const owners = photo.owners ?? video.owners;
  return (
    <div data-job-deliverables className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Photos and video</h2>
        {data.due.line && (
          <span data-due className={`text-sm tabular-nums ${data.due.late ? "font-semibold text-danger" : "text-muted"}`}>
            {data.due.line}
          </span>
        )}
        {owners && !owners.shootOver && (
          <span className="text-xs text-muted">
            Requests go to {owners.creative ? owners.creative.split(/\s+/)[0] : "the creative"} at the shoot, then to editing.
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card
          icon={<Camera aria-hidden className="size-4 text-muted" />}
          title="Photos"
          stage={p.stage}
          empty={data.monthly ? "n/a" : "Not ordered"}
          link={p.href ? { href: p.href, label: "Open the photo job" } : null}
          steps={p.steps}
          stepsLabel="Photo stages"
        >
          {p.ordered ? (
            <p className="text-sm text-foreground/90" data-photo-count>
              {p.photoCount
                ? `${p.photoCount} ${p.photoCount === 1 ? "photo" : "photos"}${p.flagged ? ` · ${p.flagged} flagged` : ""}`
                : p.stage?.label === "Delivered"
                  ? p.photoJobId ? "Delivered. The photo count is not on record." : "Delivered on the Aryeo listing."
                  : p.photoJobId ? "The edited photos are not counted yet." : "Not in the photo pipeline yet."}
              {p.href && (
                <>
                  {" "}
                  <Link href={p.href} className="font-medium text-brand hover:underline">
                    See them
                  </Link>
                </>
              )}
            </p>
          ) : (
            <p className="text-sm text-muted">No photos on this job.</p>
          )}
          <Requests medium="photo" checks={photo} canCheck={canCheck} />
          <FlagList flags={flags.photoOnly} />
          <NoteList notes={notes.photoOnly} />
        </Card>
        <Card
          icon={<Video aria-hidden className="size-4 text-muted" />}
          title="Video"
          stage={v.stage}
          empty="Not ordered"
          link={v.ordered ? { href: v.href, label: "Open in the Review Room" } : null}
          steps={v.steps}
          stepsLabel="Video stages"
        >
          {v.ordered ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                {v.items.length === 1 ? "1 video" : `${v.items.length} videos`}
                {data.monthly ? " · monthly content, approved videos go to the client's portal" : ""}
              </p>
              <ul className="space-y-1.5">{v.items.map((it) => <VideoRowView key={it.key} v={it} street={data.street} />)}</ul>
            </div>
          ) : (
            <p className="text-sm text-muted">No video on this job.</p>
          )}
          <Requests medium="video" checks={video} canCheck={canCheck} />
          <FlagList flags={flags.videoOnly} />
          <NoteList notes={notes.videoOnly} />
        </Card>
      </div>
      {(flags.both.length > 0 || notes.both.length > 0) && (
        <div className="space-y-3 rounded-2xl border border-border bg-surface px-4 py-3" data-job-shared>
          <FlagList flags={flags.both} title="Flagged at the shoot (photos and video)" />
          <NoteList notes={notes.both} title="Notes on this job" />
        </div>
      )}
    </div>
  );
}
