import { notFound } from "next/navigation";
import Link from "next/link";
import {
  CalendarClock, Camera, CheckCircle2, ChevronRight, Download, FileText, Home, PlayCircle, Sparkles,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { monthLabel, etMonthKey } from "@/lib/contentProgram";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { portalCuts, CLIENT_VISIBLE_SCRIPT, type PortalCut } from "@/lib/portal";
import { PortalVideoReview } from "@/components/portal/PortalVideoReview";
import { PortalSuggestBox } from "@/components/portal/PortalSuggestBox";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// CLIENT-FACING content hub — a tabbed mini-app (Jordan, Aug 28, modeled on
// the Luma portal he liked): Home · Videos · Scripts · Sessions. The video
// library reads the materialized PortalVideo table (backfilled from Aryeo for
// every client; QC-passed cuts land via the Review Room approve hook), so a
// page load never calls Aryeo. STRICT content rules hold: approved scripts,
// delivered/approved videos, session dates, the booking link — never topics,
// internal notes, drafts, or money.

type TabKey = "home" | "videos" | "scripts" | "sessions";
const TABS: { key: TabKey; label: string; icon: typeof Home }[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "videos", label: "Videos", icon: PlayCircle },
  { key: "scripts", label: "Scripts", icon: FileText },
  { key: "sessions", label: "Sessions", icon: Camera },
];

const fmtSession = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (d: Date) =>
  d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });

export default async function ClientPortalPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { token } = await params;
  const { tab: rawTab } = await searchParams;
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(token)) notFound();
  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { portalToken: token },
    select: { id: true, clientId: true, status: true, videosPerMonth: true },
  });
  if (!enrollment || enrollment.status !== "ACTIVE") notFound();
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
  const tab: TabKey = (TABS.some((t) => t.key === rawTab) ? rawTab : "home") as TabKey;

  const monthKey = etMonthKey();
  const [months, cuts, library] = await Promise.all([
    prisma.contentMonth.findMany({
      where: { enrollmentId: enrollment.id },
      orderBy: { monthKey: "desc" },
      take: 18,
      select: { id: true, monthKey: true, strategyCallStatus: true, strategyCallAt: true },
    }),
    portalCuts(enrollment.id).catch(() => [] as PortalCut[]),
    prisma.portalVideo.findMany({
      where: { enrollmentId: enrollment.id },
      orderBy: { deliveredAt: "desc" },
      take: 200,
      select: { id: true, monthId: true, title: true, thumb: true, playback: true, download: true, deliveredAt: true },
    }),
  ]);
  const monthIds = months.map((m) => m.id);
  const keyOfMonth = new Map(months.map((m) => [m.id, m.monthKey]));
  const [scripts, sessions] = await Promise.all([
    prisma.contentScript.findMany({
      where: { monthId: { in: monthIds }, status: { in: CLIENT_VISIBLE_SCRIPT } },
      orderBy: { createdAt: "asc" },
      select: { id: true, monthId: true, title: true, body: true },
    }),
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds }, status: { not: "CANCELLED" }, shootDate: { not: null } },
      orderBy: { shootDate: "desc" },
      select: { id: true, contentMonthId: true, shootDate: true, status: true },
    }),
  ]);

  const current = months.find((m) => m.monthKey === monthKey) ?? null;
  const call = current?.strategyCallStatus ?? "NOT_SCHEDULED";
  const callAt = current?.strategyCallAt ?? null;
  const now = new Date();
  const upcoming = sessions.filter((s) => s.shootDate! >= now).sort((a, b) => +a.shootDate! - +b.shootDate!);
  const deliveredThisMonth = library.filter((v) => v.monthId && keyOfMonth.get(v.monthId) === monthKey).length;
  const currentScripts = scripts.filter((s) => s.monthId === current?.id);

  // Library grouped by month, newest month first; undated rows fall to their
  // delivery date's month label.
  const groups: { label: string; videos: typeof library }[] = [];
  for (const v of library) {
    const label = (v.monthId && keyOfMonth.get(v.monthId) && monthLabel(keyOfMonth.get(v.monthId)!)) ||
      v.deliveredAt.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", year: "numeric" });
    const g = groups.find((x) => x.label === label);
    if (g) g.videos.push(v);
    else groups.push({ label, videos: [v] });
  }

  const first = (client?.name ?? "there").split(/\s+/)[0];
  const href = (t: TabKey) => `/portal/${token}${t === "home" ? "" : `?tab=${t}`}`;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl p-4 pb-24 sm:p-6">
        {/* BRAND + NAME */}
        <div className="flex items-center gap-2.5 pt-3">
          <div className="flex size-9 items-center justify-center rounded-xl text-sm font-bold text-white"
            style={{ background: "linear-gradient(135deg, #f97316, #e96320 55%, #c2410c)" }}>RP</div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">
              Real<span className="text-brand">Tour</span> Pilot <span className="ml-1 hidden text-muted-2 sm:inline">· Content Program</span>
            </div>
            <div className="truncate text-xs text-muted">{client?.name}</div>
          </div>
        </div>

        {/* TABS */}
        <nav className="mt-5 flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map((t) => (
            <Link key={t.key} href={href(t.key)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                tab === t.key ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
              )}>
              <t.icon className="size-4" /> {t.label}
              {t.key === "videos" && (library.length > 0 || cuts.length > 0) && (
                <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-semibold text-muted">{library.length + cuts.length}</span>
              )}
            </Link>
          ))}
        </nav>

        {/* ---------------- HOME ---------------- */}
        {tab === "home" && (
          <div className="mt-5 space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">Hi {first} 👋</h1>

            <div className="rounded-2xl border border-border bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{monthLabel(monthKey)}</div>
              <div className="mt-2 space-y-2 text-sm">
                <p className="flex items-center gap-2">
                  <PlayCircle className="size-4 shrink-0 text-brand" />
                  <span><b>{deliveredThisMonth}</b> of {enrollment.videosPerMonth} videos delivered this month</span>
                </p>
                {call === "COMPLETED" ? (
                  <p className="flex items-center gap-2 text-success"><CheckCircle2 className="size-4 shrink-0" /> Strategy call done{callAt ? ` — ${fmtDay(callAt)}` : ""}</p>
                ) : call === "SCHEDULED" && callAt ? (
                  <p className="flex items-center gap-2"><CalendarClock className="size-4 shrink-0 text-brand" /> Strategy call booked — {fmtSession(callAt)} ET</p>
                ) : call === "NOT_SCHEDULED" ? (
                  <p className="flex items-center gap-2 text-warning"><CalendarClock className="size-4 shrink-0" /> Strategy call not booked yet</p>
                ) : null}
                {upcoming[0] ? (
                  <p className="flex items-center gap-2"><Camera className="size-4 shrink-0 text-brand" /> Next filming: {fmtSession(upcoming[0].shootDate!)} ET</p>
                ) : (
                  <p className="flex items-center gap-2 text-muted"><Camera className="size-4 shrink-0" /> No filming session booked yet</p>
                )}
              </div>
              {call === "NOT_SCHEDULED" && (
                <a href={STRATEGY_CALL_BOOKING_URL} target="_blank" rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                  <CalendarClock className="size-4" /> Book your strategy call
                </a>
              )}
            </div>

            {cuts.length > 0 && (
              <Link href={href("videos")} className="flex items-center gap-2 rounded-2xl border border-brand/30 bg-brand-soft/40 p-4 text-sm font-medium hover:bg-brand-soft/60">
                <PlayCircle className="size-4 text-brand" />
                {cuts.length} video{cuts.length === 1 ? "" : "s"} ready for your review
                <ChevronRight className="ml-auto size-4 text-brand" />
              </Link>
            )}

            {library.length > 0 && (
              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Latest videos</span>
                  <Link href={href("videos")} className="text-xs font-medium text-brand hover:underline">See all {library.length} →</Link>
                </div>
                <VideoGrid videos={library.slice(0, 4)} />
              </div>
            )}

            {currentScripts.length > 0 && (
              <Link href={href("scripts")} className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-4 text-sm font-medium hover:bg-surface-2">
                <FileText className="size-4 text-brand" />
                {currentScripts.length} script{currentScripts.length === 1 ? "" : "s"} ready for {monthLabel(monthKey)}
                <ChevronRight className="ml-auto size-4 text-muted-2" />
              </Link>
            )}
          </div>
        )}

        {/* ---------------- VIDEOS ---------------- */}
        {tab === "videos" && (
          <div className="mt-5 space-y-5">
            {cuts.length > 0 && (
              <div className="rounded-2xl border border-brand/30 bg-surface p-4">
                <div className="text-sm font-semibold">For your review</div>
                <p className="mt-1 text-xs text-muted-2">
                  Watch, pause and drop a note where you want a change, then hit &ldquo;Request changes&rdquo; — it goes straight to your editor.
                </p>
                <div className="mt-3 space-y-4">
                  {cuts.map((c) => (
                    <PortalVideoReview key={c.submissionId} token={token} cut={c} monthLabel={monthLabel(c.monthKey)} />
                  ))}
                </div>
              </div>
            )}
            {groups.length === 0 && cuts.length === 0 && (
              <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
                Your videos will appear here as soon as the first one is ready.
              </p>
            )}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="mb-2 text-sm font-semibold">{g.label} <span className="text-xs font-normal text-muted-2">· {g.videos.length}</span></div>
                <VideoGrid videos={g.videos} />
              </div>
            ))}
          </div>
        )}

        {/* ---------------- SCRIPTS ---------------- */}
        {tab === "scripts" && (
          <div className="mt-5 space-y-5">
            {scripts.length === 0 && (
              <p className="rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted">
                Scripts appear here the moment they&rsquo;re approved — usually right after your strategy call.
              </p>
            )}
            {months.filter((m) => scripts.some((s) => s.monthId === m.id)).map((m) => {
              const monthScripts = scripts.filter((s) => s.monthId === m.id);
              const isCurrent = m.monthKey === monthKey;
              return (
                <div key={m.id} className="rounded-2xl border border-border bg-surface p-4">
                  <div className="text-sm font-semibold">{monthLabel(m.monthKey)}{isCurrent && <span className="ml-2 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">this month</span>}</div>
                  {isCurrent && (
                    <p className="mt-1 text-xs text-muted-2">Tap a script to read it — and if you&rsquo;d word something differently, hit &ldquo;Suggest a change&rdquo;.</p>
                  )}
                  <div className="mt-3 space-y-2">
                    {monthScripts.map((sc) => (
                      <details key={sc.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={isCurrent && monthScripts.length <= 2}>
                        <summary className="cursor-pointer text-sm font-semibold">{sc.title}</summary>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{sc.body}</p>
                        {isCurrent && <PortalSuggestBox token={token} scriptId={sc.id} />}
                      </details>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ---------------- SESSIONS ---------------- */}
        {tab === "sessions" && (
          <div className="mt-5 space-y-4">
            <div className="rounded-2xl border border-border bg-surface p-4">
              <div className="text-sm font-semibold">Upcoming</div>
              {upcoming.length > 0 ? (
                <ul className="mt-2 space-y-1.5 text-sm">
                  {upcoming.map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <Camera className="size-4 shrink-0 text-brand" /> {fmtSession(s.shootDate!)} ET
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted">No filming session on the calendar yet — we&rsquo;ll get one booked after your strategy call.</p>
              )}
              {call === "NOT_SCHEDULED" && (
                <a href={STRATEGY_CALL_BOOKING_URL} target="_blank" rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
                  <CalendarClock className="size-4" /> Book your strategy call
                </a>
              )}
            </div>
            {sessions.filter((s) => s.shootDate! < now).length > 0 && (
              <div className="rounded-2xl border border-border bg-surface p-4">
                <div className="text-sm font-semibold">Past sessions</div>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {sessions.filter((s) => s.shootDate! < now).map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" /> {fmtDay(s.shootDate!)}
                      {s.status === "DELIVERED" && <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-xs text-muted-2">
          <Sparkles className="size-3.5" /> Questions or topic ideas? Text us any time.
        </p>
      </div>
    </div>
  );
}

// The library grid — playable inline, downloadable from the same links the
// delivery emails use.
function VideoGrid({ videos }: { videos: { id: string; title: string | null; thumb: string | null; playback: string | null; download: string | null }[] }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-3">
      {videos.map((v, i) => (
        <div key={v.id} className="overflow-hidden rounded-lg border border-border bg-surface">
          {v.playback ? (
            <video src={v.playback} poster={v.thumb ?? undefined} controls playsInline preload="none" className="aspect-[9/16] max-h-64 w-full bg-black object-contain" />
          ) : v.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.thumb} alt={v.title ?? "Video"} className="max-h-64 w-full object-cover" />
          ) : null}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{v.title ?? `Video ${i + 1}`}</span>
            {v.download && (
              <a href={v.download} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-brand hover:underline">
                <Download className="size-3" />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
