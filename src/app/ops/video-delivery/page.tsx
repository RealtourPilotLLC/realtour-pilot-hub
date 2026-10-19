import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, CalendarClock, CheckCircle2, Clapperboard, ExternalLink, Eye, Hand, Hourglass, Send, SlidersHorizontal, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { authEnforced, requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { videoDeliveryBoard, type VideoLane, type VideoRow, type ProgramRow } from "@/lib/videoDelivery";
import { VIDEO_PUSH_MODES, VIDEO_PUSH_MODE_WORDS } from "@/lib/videoDeliverySettings";
import { PushControls, PushModeCard } from "@/components/videoDelivery/PushControls";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/video-delivery: VIDEO DELIVERY (Oct 19 2026, lib/videoDelivery).
// Jordan: "how many videos are going out today or need to go out today or
// are due today, and how many we're behind on." Kyle and Jordan. Up top the
// three numbers; then the listing videos in lanes (late, due today, sending to
// Aryeo with where the hub's upload stands, held and why, in review, coming
// up, delivered this week); then the content program's late and due videos;
// then the switch for the hub's own Aryeo upload and delivery (owner changes
// it). Every row opens its job or its cut. Times are Eastern.
// ---------------------------------------------------------------------------

const LANE: Record<VideoLane, { title: string; icon: LucideIcon; empty: string; tone?: "warning" }> = {
  late: { title: "Late", icon: AlertTriangle, empty: "Nothing late.", tone: "warning" },
  today: { title: "Due today", icon: Sun, empty: "Nothing else due today." },
  sending: { title: "Approved and sending to Aryeo", icon: Send, empty: "No approved video waiting to go out." },
  held: { title: "Held", icon: Hand, empty: "Nothing held.", tone: "warning" },
  review: { title: "In review", icon: Eye, empty: "No cut waiting for review." },
  upcoming: { title: "Coming up", icon: CalendarClock, empty: "Nothing else owed." },
  delivered: { title: "Delivered this week", icon: CheckCircle2, empty: "Nothing delivered in the last 7 days." },
};
const ORDER: VideoLane[] = ["late", "today", "sending", "held", "review", "upcoming", "delivered"];

const TONE: Record<string, string> = {
  progress: "text-foreground",
  waiting: "text-foreground",
  held: "font-medium text-warning",
  failed: "font-medium text-danger",
  done: "text-success",
  info: "text-muted",
};

function hoursWords(h: number | null): string {
  if (h == null) return "";
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "danger" | "warning" }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="text-ui-status font-medium text-muted">{label}</div>
      <div className={cn("text-2xl font-semibold tabular-nums", tone === "danger" && "text-danger", tone === "warning" && "text-warning")}>{value}</div>
      {note && <div className="text-ui-status text-muted">{note}</div>}
    </div>
  );
}

function Row({ r, canAct }: { r: VideoRow; canAct: boolean }) {
  return (
    <li className="min-w-0 px-5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <Link href={`/projects/${r.projectId}`} className="font-semibold hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{r.street}</Link>
        <span className="text-muted">· {r.clientName}</span>
        <span className="min-w-0 font-medium">· {r.label}{r.round ? `, version ${r.round}` : ""}</span>
        {r.late && r.lane !== "late" && r.lane !== "delivered" && <span className="rounded px-1.5 py-0.5 text-ui-status font-bold text-danger">late</span>}
        {r.lane === "delivered" && r.late && <span className="rounded px-1.5 py-0.5 text-ui-status font-semibold text-warning">delivered late</span>}
      </div>
      <p className="mt-0.5 text-sm text-muted">
        <span className="font-medium text-foreground">{r.stage}</span>
        {" · "}
        <span className={cn(r.late && r.lane !== "delivered" && "font-semibold text-danger")}>{r.promiseWords}</span>
        {r.deliveredAtISO && <> · delivered {etDateTime(r.deliveredAtISO)} ET{r.deliveredBy ? ` by ${r.deliveredBy}` : ""}</>}
      </p>
      {r.heldWhy && <p className="mt-1 text-sm font-medium text-warning">{r.heldWhy}</p>}
      {r.push && !(r.heldWhy && r.push.says === r.heldWhy) && <p className={cn("mt-1 text-sm", TONE[r.push.tone])}>{r.push.says}</p>}
      {!r.push && (r.lane === "sending" || r.lane === "held") && <p className="mt-1 text-sm text-muted">Kyle uploads it to Aryeo and delivers it by hand (the switch below is off).</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {r.reviewHref && (
          <Link href={r.reviewHref} prefetch={false} className="inline-flex min-h-11 items-center gap-1 underline underline-offset-2 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <Clapperboard aria-hidden className="size-3.5" /> Open the cut
          </Link>
        )}
        {r.aryeoUrl && (r.lane === "sending" || r.lane === "held" || r.lane === "delivered") && (
          <a href={r.aryeoUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 underline underline-offset-2 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <ExternalLink aria-hidden className="size-3.5" /> Aryeo listing
          </a>
        )}
      </div>
      {canAct && r.submissionId && r.push && (
        <PushControls submissionId={r.submissionId} street={r.street} canRetry={r.push.canRetry} canDeliverNow={r.push.canDeliverNow} canHold={r.push.canHold} canRelease={r.push.canRelease} />
      )}
    </li>
  );
}

function ProgramList({ rows }: { rows: ProgramRow[] }) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.outputId} className="min-w-0 px-5 py-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link href={`/projects/${r.projectId}`} className="font-semibold hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{r.clientName}</Link>
            <span className="text-muted">· {r.monthWords}</span>
            <span className="min-w-0 font-medium">· {r.title}</span>
          </div>
          <p className="mt-0.5 text-muted">
            <span className="font-medium text-foreground">{r.stage}</span> · <span className={cn(r.late && "font-semibold text-danger")}>{r.promiseWords}</span>
          </p>
          {r.why && <p className="mt-0.5 text-muted">{r.why}</p>}
        </li>
      ))}
    </ul>
  );
}

export default async function VideoDeliveryPage() {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/ops/video-delivery");
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect(homeFor(me.role));
  const isOwner = !me || me.role === "OWNER";

  const board = await videoDeliveryBoard({ fresh: true }).catch((e) => {
    console.error("[video-delivery] board failed", e);
    return null;
  });
  const c = board?.counts;
  const subtitle = c
    ? `${c.dueToday} due today · ${c.behind} behind${c.oldestLateHours != null ? ` · the oldest late by ${hoursWords(c.oldestLateHours)}` : ""}. Listing videos go to Aryeo; program videos to the client's portal. Times are Eastern.`
    : "Every listing video from the shoot to delivered, and the content program's late videos.";

  return (
    <div>
      <PageHeader eyebrow="Operations" title="Video delivery" subtitle={subtitle} />
      <div className="mx-auto max-w-5xl space-y-4 p-4 pb-16 sm:p-6">
        {!board ? (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">The video delivery board could not be read. Refresh to try again.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Due today" value={String(c!.dueToday)} note="due by tonight, not delivered" />
              <Stat label="Late" value={String(c!.behind)} note={c!.lateMonthly ? `${c!.lateListing} listing · ${c!.lateMonthly} program` : "past their promise"} tone={c!.behind ? "danger" : undefined} />
              <Stat label="Oldest late" value={c!.oldestLateHours != null ? hoursWords(c!.oldestLateHours) : "None"} note="listing videos" tone={c!.oldestLateHours != null ? "warning" : undefined} />
              <Stat label="Going out" value={String(board.lanes.sending.length)} note={board.lanes.held.length ? `${board.lanes.held.length} held` : "approved, not sent"} />
            </div>

            {ORDER.map((lane) => {
              const rows = board.lanes[lane];
              const meta = LANE[lane];
              if (!rows.length && (lane === "review" || lane === "upcoming")) return null;
              return (
                <Section key={lane} icon={meta.icon} title={meta.title} count={rows.length} tone={meta.tone && rows.length ? meta.tone : "default"} flush>
                  {rows.length ? (
                    <ul className="divide-y divide-border">
                      {rows.map((r) => <Row key={r.key} r={r} canAct={board.mode === "upload" || board.mode === "deliver"} />)}
                    </ul>
                  ) : (
                    <p className="px-5 py-4 text-sm text-muted">{meta.empty}</p>
                  )}
                </Section>
              );
            })}

            <Section icon={Hourglass} title="Content program" count={board.program.late.length + board.program.dueToday.length} flush>
              {board.program.unavailable ? (
                <p role="alert" className="px-5 py-4 text-sm text-warning">The program videos could not be read just now.</p>
              ) : board.program.late.length + board.program.dueToday.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">No program video is late or due today{board.program.atRisk ? ` (${board.program.atRisk} at risk: see Program watch)` : ""}. These go to the client&rsquo;s portal, never to Aryeo by the hub.</p>
              ) : (
                <>
                  <p className="px-5 pt-3 text-sm text-muted">Monthly videos go to the client&rsquo;s portal. {board.program.atRisk ? `${board.program.atRisk} more at risk.` : ""}</p>
                  {board.program.late.length > 0 && <><h3 className="px-5 pt-3 text-sm font-semibold text-danger">Late ({board.program.late.length})</h3><ProgramList rows={board.program.late} /></>}
                  {board.program.dueToday.length > 0 && <><h3 className="px-5 pt-3 text-sm font-semibold">Due today ({board.program.dueToday.length})</h3><ProgramList rows={board.program.dueToday} /></>}
                </>
              )}
            </Section>

            <Section icon={SlidersHorizontal} title="The hub sends listing videos to Aryeo">
              <p className="mb-3 text-sm text-muted">
                Once a listing video is approved in the Review Room and back from the 1080p pass, the hub can put it on the Aryeo listing and re-deliver the listing
                itself, signed in as its own Aryeo login. It holds a video while the client has an open ask, while the sound check holds the file, or while the
                job is on hold, and says why on the row.
              </p>
              <PushModeCard
                value={board.mode}
                options={VIDEO_PUSH_MODES.map((m) => ({ value: m, ...VIDEO_PUSH_MODE_WORDS[m] }))}
                canChange={isOwner}
                connected={board.connected}
              />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
