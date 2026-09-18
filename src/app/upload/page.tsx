import { requirePageAccess } from "@/lib/auth/guards";
import Link from "next/link";
import { CheckCircle2, Camera, ArrowRight, Upload, FolderOpen, Scissors, CalendarPlus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, ink } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { CullingReminder } from "@/components/upload/CullingReminder";
import { getCurrentUser } from "@/lib/auth/user";
import { photographerMemberId } from "@/lib/shoot";
import { rawPhotoCounts } from "@/lib/dropboxFolders";
import { photoTargetFor, rawOverageCeiling } from "@/lib/culling";
import { DEBRIEF_PAY_GATE_FROM } from "@/lib/payroll";
import { stageMeta, DELIVERABLE_META } from "@/lib/pipeline";
import { DeliverableType } from "@prisma/client";
import { etDateTime, etDaysAgo } from "@/lib/datetime";
import {
  historyPhotographers, listUploadHistory, ownedBy, uploadWindowStart,
  REOPENED_FOR_ADDITIONAL_SHOOT, UPLOAD_PENDING_STATUSES, UPLOAD_PENDING_WHERE,
  type UploadViewerScope,
} from "@/lib/uploadHistory";
import { UploadHistory } from "@/components/upload/UploadHistory";

export const dynamic = "force-dynamic";

// Day-buckets for the "come home, unload gear, upload" flow — newest first.
const BUCKETS = [
  { key: "today", label: "Today's jobs" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "Past 7 days" },
  { key: "older", label: "Previous weeks" },
  { key: "upcoming", label: "Upcoming" },
  { key: "unscheduled", label: "Unscheduled" },
] as const;
type BucketKey = (typeof BUCKETS)[number]["key"];

function bucketFor(shootDate: Date | null): BucketKey {
  if (!shootDate) return "unscheduled";
  const days = etDaysAgo(shootDate); // +past / -future, in Eastern calendar days
  if (days < 0) return "upcoming";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  return "older";
}

export default async function UploadListPage() {
  await requirePageAccess("upload");
  // Photographers see ONLY their own shoots here (fail-closed: unresolvable →
  // none). Owner/admin/editor see all.
  const user = await getCurrentUser();
  // First visit under the new process: photographers read the standard and
  // agree once before the queue opens (Jordan, Sep 1).
  if (user?.role === "PHOTOGRAPHER" && user.email) {
    const ack = await prisma.appSetting.findUnique({ where: { key: `upload-ack-${user.email.toLowerCase()}` } });
    if (!ack) redirect("/upload/welcome");
  }
  const mine = user?.role === "PHOTOGRAPHER" ? ((await photographerMemberId(user)) ?? "__none__") : null;

  // Which jobs the buckets carry (Jordan, Sep 15: "It actually shows ones
  // that were submitted too but I'm not seeing all of them"). The old filter
  // was status ∈ {BOOKED, SCHEDULED, SHOT}, so a job vanished from Today /
  // Yesterday / Past 7 days the moment it advanced to editing — 8 of 15 jobs
  // in the window on Sep 15, every one of them submitted. Now:
  //   · inside the 7-day window: every non-cancelled status, submitted or not;
  //   · Upcoming: the pending statuses, as before;
  //   · Previous weeks / Unscheduled: UPLOAD_PENDING_WHERE — a pending-status
  //     job whose page was never SUBMITTED. Raws the sweep detected do not
  //     retire it from here (review, Sep 15): it still owes the photographer's
  //     submit and keeps its "Submit to add to payroll" chip. "Past uploads"
  //     below excludes exactly that set, so a job is never listed twice.
  const now = new Date();
  const windowStart = uploadWindowStart(now);
  const scopeWhere = mine ? ownedBy(mine) : {};
  const shoots = await prisma.project.findMany({
    where: {
      AND: [
        scopeWhere,
        {
          OR: [
            { status: { not: "CANCELLED" }, shootDate: { gte: windowStart, lte: now } },
            { status: { in: UPLOAD_PENDING_STATUSES }, shootDate: { gt: now } },
            { ...UPLOAD_PENDING_WHERE, shootDate: null },
            { ...UPLOAD_PENDING_WHERE, shootDate: { lt: windowStart } },
            // …AND THE JOB THAT CAME BACK (Jordan, Sep 18 — 204 Spring Ln).
            // A photographer who filmed an extra reel for a job that already
            // delivered has no other way onto this page: every clause above is
            // about the shoot the job was booked for, and that one is done.
            // Deliberately not status-scoped beyond CANCELLED — the whole point
            // is that a DELIVERED job is listed here again, without its status,
            // its delivery date or its promise being touched.
            { ...REOPENED_FOR_ADDITIONAL_SHOOT, status: { not: "CANCELLED" } },
          ],
        },
      ],
    },
    orderBy: [{ shootDate: "desc" }, { createdAt: "desc" }],
    include: {
      client: true,
      photographer: true,
      deliverables: {
        where: { removedFromOrderAt: null },
        // manual/capturedAt/uploadedAt carry the extra shoot: which day it was
        // filmed, and whether its raws are in yet.
        select: { id: true, type: true, manual: true, capturedAt: true, uploadedAt: true },
      },
      _count: { select: { uploads: true } },
    },
  });

  // "Over budget" chip: only SHOT jobs have raws in the folder, so we only spend
  // Dropbox calls on those (one call each, in parallel). A shoot is over budget
  // when its raw pile exceeds its home's target × the overage factor.
  const overBudget = new Set<string>();
  const shotJobs = shoots.filter((s) => s.status === "SHOT");
  if (shotJobs.length > 0) {
    const counts = await rawPhotoCounts(shotJobs);
    if (counts) {
      for (const s of shotJobs) {
        const raw = counts.get(s) ?? 0;
        if (raw > rawOverageCeiling(photoTargetFor(s))) overBudget.add(s.id);
      }
    }
  }

  // THE DAY THIS ROW IS ABOUT. For almost every job that is Project.shootDate.
  // For a job reopened for an extra shoot it is the day the EXTRA footage was
  // filmed — bucketing a job re-shot yesterday under a shoot date from three
  // weeks ago would file it in "Previous weeks", which is the one place the
  // photographer will not look for today's upload.
  const rows = shoots.map((s) => {
    const extra = extraShootDay(s.deliverables);
    return { s, extra, when: extra ?? s.shootDate };
  });
  rows.sort((a, b) => (b.when?.getTime() ?? 0) - (a.when?.getTime() ?? 0));

  const grouped = new Map<BucketKey, typeof rows>();
  for (const r of rows) {
    const b = bucketFor(r.when);
    const arr = grouped.get(b) ?? [];
    arr.push(r);
    grouped.set(b, arr);
  }
  // "Upcoming" oldest-first (next shoot first); everything else newest-first.
  const up = grouped.get("upcoming");
  if (up) up.sort((a, b) => (a.when?.getTime() ?? 0) - (b.when?.getTime() ?? 0));

  // Still to upload. A reopened job has Project.uploadedAt set from its FIRST
  // shoot, so the project stamp alone would count the extra footage as already
  // in — the open extra shoot is what makes it pending again.
  const stillToUpload = (r: (typeof rows)[number]) => !r.s.uploadedAt || r.extra != null;
  const pendingToday = (grouped.get("today") ?? []).filter(stillToUpload).length;

  // Past uploads — first page server-rendered; search / chips / paging go
  // through the searchUploadHistory action (same scope, re-derived there).
  // requirePageAccess above already vetted the viewer, so the scope is just
  // the `mine` pin resolved for the buckets.
  const scope: UploadViewerScope = { mine, office: mine === null };
  const [history, photographers] = await Promise.all([
    listUploadHistory(scope, {}, now),
    historyPhotographers(scope, now),
  ]);

  return (
    <div>
      <PageHeader
        title="Upload Portal"
        subtitle="Unload gear, sit down, and clear today's uploads — newest shoots first"
      />
      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <CullingReminder />

        {shoots.length === 0 && <p className="text-sm text-muted">No shoots in the last week or coming up.</p>}

        {BUCKETS.map(({ key, label }) => {
          const items = grouped.get(key);
          if (!items || items.length === 0) return null;
          const pending = items.filter(stillToUpload).length;
          return (
            <section key={key}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold">{label}</h2>
                <span className="rounded-full bg-surface-2 px-2 text-xs font-medium text-muted">{items.length}</span>
                {pending > 0 && key !== "upcoming" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 text-xs font-medium text-brand">
                    <Upload className="size-3" /> {pending} to upload
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {items.map((r) => (
                  <JobRow key={r.s.id} s={r.s} extraShoot={r.extra} overBudget={overBudget.has(r.s.id)} nowMs={now.getTime()} />
                ))}
              </div>
            </section>
          );
        })}

        {pendingToday === 0 && (grouped.get("today")?.length ?? 0) > 0 && (
          <p className="text-center text-sm text-success">All of today&rsquo;s jobs are uploaded. Nice work.</p>
        )}

        {/* The only signpost to the way back in (Jordan, Sep 18). A job that
            has left the portal is reachable ONLY through the history below, and
            a photographer standing in a driveway with an extra reel has no
            reason to guess that an old job's page is where it goes. */}
        <p className="-mb-4 text-xs text-muted-2">
          Shot an extra reel or video for a job you&rsquo;ve already finished? Open it below and use
          &ldquo;Add another shoot&rdquo; — it comes back to the top of this page to upload.
        </p>

        <UploadHistory initial={history} photographers={photographers} officeView={scope.office} />
      </div>
    </div>
  );
}

type Shoot = {
  debriefSubmittedAt: Date | null;
  id: string; title: string; status: string; shootDate: Date | null; uploadedAt: Date | null;
  client: { name: string; avatarUrl: string | null }; photographer: { name: string; avatarColor: string } | null;
  deliverables: { type: DeliverableType }[]; _count: { uploads: number };
};

/** The day an EXTRA shoot re-opened this job, or null for the ordinary case.
 *  A manual video row carrying `capturedAt` and no photographer upload tick is
 *  the shape app/upload/actions.reopenForAdditionalShoot writes; the newest one
 *  wins, so a job re-shot twice files under the later visit. Kept beside the
 *  Prisma predicate's twin in lib/uploadHistory.ts — that one decides WHICH
 *  jobs are read, this one decides which DAY the row sits under, and they must
 *  agree about what an extra shoot is. */
function extraShootDay(
  deliverables: { type: DeliverableType; manual: boolean; capturedAt: Date | null; uploadedAt: Date | null }[],
): Date | null {
  let best: Date | null = null;
  for (const d of deliverables) {
    if (!d.manual || !d.capturedAt || d.uploadedAt) continue;
    if (d.type !== DeliverableType.VIDEO && d.type !== DeliverableType.SOCIAL_REEL) continue;
    if (!best || d.capturedAt.getTime() > best.getTime()) best = d.capturedAt;
  }
  return best;
}

// Shoots from Sep 2 2026 on ride the payroll gate: pay shows in My Pay only
// once the upload page is SUBMITTED (debriefSubmittedAt — not the Dropbox
// auto-stamp). The row says so until they do.

// `nowMs` comes from the page's one `now` (a render must not read the clock).
function JobRow({ s, extraShoot, overBudget, nowMs }: { s: Shoot; extraShoot: Date | null; overBudget: boolean; nowMs: number }) {
  const stage = stageMeta(s.status as Parameters<typeof stageMeta>[0]);
  // An extra shoot's raws are not in, whatever the project stamp says: that
  // stamp belongs to the first shoot, and a delivered job carries it.
  const uploaded = s.uploadedAt != null && !extraShoot;
  const payrollPending =
    !s.debriefSubmittedAt &&
    s.shootDate != null &&
    s.shootDate.getTime() >= DEBRIEF_PAY_GATE_FROM &&
    s.shootDate.getTime() <= nowMs;
  // Distinct deliverable types = the checklist of what to capture/upload.
  const types = [...new Set(s.deliverables.map((d) => d.type))];
  return (
    <Link href={`/upload/${s.id}`} className="flex items-center gap-4 rounded-2xl border bg-surface p-4 transition-shadow hover:shadow-md">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: stage.soft, color: ink(stage.color) }}>
        {uploaded ? <CheckCircle2 className="size-5" /> : <Camera className="size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-semibold">{s.title}</span>
          {/* The pipeline status always shows now that submitted jobs stay
              listed (Sep 15) — "Uploaded" alone hid whether a job was still
              waiting on the office or already in editing. The submit stamp
              (debriefSubmittedAt — the human submit, never the sweep's
              uploadedAt) rides beside it. */}
          <Badge color={stage.color} soft={stage.soft}>{stage.short}</Badge>
          {/* The job is back on this page for footage shot on ANOTHER day. The
              badge names that day, because the row's own date is now the extra
              shoot's and the job's status still belongs to the first one —
              without it a Delivered job sitting under "Today" reads as a bug. */}
          {extraShoot && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand">
              <CalendarPlus className="size-3" /> Extra shoot {etDateTime(extraShoot)}
            </span>
          )}
          {s.debriefSubmittedAt && !extraShoot ? (
            <Badge color="#34d399" soft="rgba(52,211,153,0.14)">Submitted ✓ {etDateTime(s.debriefSubmittedAt)}</Badge>
          ) : uploaded ? (
            <Badge color="#34d399" soft="rgba(52,211,153,0.14)">Uploaded</Badge>
          ) : null}
          {/* Raw pile blew past this home's budget — cull before it goes to edit. */}
          {overBudget && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
              <Scissors className="size-3" /> Over budget
            </span>
          )}
          {payrollPending && (
            <span className="inline-flex items-center rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand">
              Submit to add to payroll
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 truncate text-xs text-muted">
          <Avatar name={s.client.name} src={s.client.avatarUrl} size={16} />
          {s.client.name}
          {s.shootDate ? ` · ${etDateTime(s.shootDate)}` : ""}
          {s._count.uploads > 0 ? ` · ${s._count.uploads} file${s._count.uploads === 1 ? "" : "s"}` : ""}
        </div>
        {types.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {types.map((t) => (
              <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted-2">
                {DELIVERABLE_META[t]?.label ?? t}
              </span>
            ))}
          </div>
        )}
      </div>
      {s.photographer && <Avatar name={s.photographer.name} color={s.photographer.avatarColor} size={28} />}
      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-brand">
        {/* A reopened job reads "Upload" even though its page was submitted
            weeks ago — the extra footage is what the photographer is here for,
            and "View" would send them away from the only thing left to do. */}
        {s.debriefSubmittedAt && !extraShoot ? "View" : uploaded ? "Review" : <><FolderOpen className="size-4" /> Upload</>} <ArrowRight className="size-4" />
      </span>
    </Link>
  );
}
