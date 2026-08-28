import { notFound } from "next/navigation";
import Link from "next/link";
import {
  CalendarClock, Camera, CheckCircle2, ChevronRight, Clock, Download, FileText, Home, MapPin, PlayCircle, ScrollText, Sparkles, UserRound,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { monthLabel, etMonthKey } from "@/lib/contentProgram";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { portalCuts, CLIENT_VISIBLE_SCRIPT, type PortalCut } from "@/lib/portal";
import { listClientAssets } from "@/lib/clientAssets";
import { PortalVideoReview } from "@/components/portal/PortalVideoReview";
import { PortalSuggestBox } from "@/components/portal/PortalSuggestBox";
import { PortalScheduler } from "@/components/portal/PortalScheduler";
import { PortalProfile } from "@/components/portal/PortalProfile";
import { ScriptBody } from "@/components/portal/ScriptBody";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// THE CLIENT HUB — a tabbed mini-app on the client's private token link
// (Jordan, Aug 28, round three): Home (this month + one-spot session info +
// scheduling) · Content Library (every session: date/time/location, videos
// and that month's scripts together) · Agent Profile (their preferences,
// brand colors, uploads → their Dropbox asset folder) · Terms. Strict rules
// hold: approved content only, never money, never internal notes.

type TabKey = "home" | "library" | "profile" | "terms";
const TABS: { key: TabKey; label: string; icon: typeof Home }[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "library", label: "Content Library", icon: PlayCircle },
  { key: "profile", label: "Agent Profile", icon: UserRound },
  { key: "terms", label: "Terms", icon: ScrollText },
];

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });
const fmtTime = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const streetOf = (title: string | null, addressLine: string | null) => (addressLine || (title ?? "").split(",")[0] || "").trim();

// Client-facing program terms. The AppSetting `portal-terms` overrides this
// default wholesale (blank lines split paragraphs; "## " starts a heading) —
// so the owner can rewrite the language without a deploy.
const DEFAULT_TERMS = `## The program
Your Content Program includes the monthly videos, filming sessions, scripting, editing and delivery described in your package. We plan each month together on your strategy call, film it at your session, and deliver finished videos to this portal.

## Scheduling
Strategy calls come first — we plan the month on that call, then film it. Sessions are booked after your call, and we ask for at least a few business days between the call and the shoot so scripts are ready. Need to move a session? Give us 48 hours' notice and we'll reschedule without fuss.

## Revisions
Every video comes with revision rounds to get it right. Ask right here in the portal — pause the video, tell us what to change, and it goes straight to your editor.

## Your content
Finished videos are yours to post, share and run ads with. Raw footage stays with us. We may feature finished work in our own portfolio unless you ask us not to.

## Cancellation
Month-to-month plans can cancel with notice before the next billing date. Annual commitments run their term as agreed. Questions about billing? Text Jordan directly — this portal never handles payment details.`;

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
  const client = await prisma.client.findUnique({
    where: { id: enrollment.clientId },
    select: { name: true, brandColors: true, editingPreferences: true, clientPreferences: true, portalVideoStyle: true, portalPreferences: true },
  });
  const tab: TabKey = (TABS.some((t) => t.key === rawTab) ? rawTab : "home") as TabKey;

  const monthKey = etMonthKey();
  const [months, cuts, libraryRaw] = await Promise.all([
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
      select: { id: true, monthId: true, projectId: true, source: true, title: true, thumb: true, playback: true, download: true, deliveredAt: true },
    }),
  ]);
  // One video, one card: once a project's videos are on Aryeo (delivered
  // truth), the review-sourced rows are the same cuts pre-delivery — drop
  // them (review finding: both writers materialized the same video twice).
  {
    const aryeoProjects = new Set(libraryRaw.filter((v) => v.source === "aryeo" && v.projectId).map((v) => v.projectId));
    for (let i = libraryRaw.length - 1; i >= 0; i--) {
      const v = libraryRaw[i];
      if (v.source === "review" && v.projectId && aryeoProjects.has(v.projectId)) libraryRaw.splice(i, 1);
    }
  }
  const library = libraryRaw;
  const monthIds = months.map((m) => m.id);
  const [scripts, sessions] = await Promise.all([
    prisma.contentScript.findMany({
      where: { monthId: { in: monthIds }, status: { in: CLIENT_VISIBLE_SCRIPT } },
      orderBy: { createdAt: "asc" },
      select: { id: true, monthId: true, title: true, body: true },
    }),
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds }, status: { not: "CANCELLED" } },
      orderBy: { shootDate: "desc" },
      select: { id: true, contentMonthId: true, shootDate: true, status: true, title: true, addressLine: true },
    }),
  ]);
  // Agent-profile prefill (Jordan: "it should include information we already
  // have from them — they can overwrite it"): when a Client field is blank,
  // seed the form from the AI-built profile so the client edits from what we
  // know instead of a blank box. Their save writes the canonical Client
  // fields; the AI profile itself is never overwritten.
  const { stripMoneySentences: scrubMoney } = await import("@/lib/text");
  let prefill = {
    brandColors: client?.brandColors ?? "",
    videoStyle: client?.portalVideoStyle ?? scrubMoney(client?.editingPreferences ?? ""),
    preferences: client?.portalPreferences ?? scrubMoney(client?.clientPreferences ?? ""),
  };
  if (tab === "profile" && (!prefill.brandColors || !prefill.videoStyle || !prefill.preferences)) {
    const ap = await prisma.agentProfile.findUnique({
      where: { clientId: enrollment.clientId },
      select: { brandJson: true, editingJson: true, productionJson: true },
    }).catch(() => null);
    const joinVals = (raw: string | null | undefined): string => {
      try {
        const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        return Object.values(obj).filter((v): v is string => typeof v === "string" && v.trim().length > 0).join("\n");
      } catch { return ""; }
    };
    const stripMoneySentences = scrubMoney;
    if (!prefill.brandColors) {
      const hexes = [...new Set((joinVals(ap?.brandJson).match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []))];
      if (hexes.length) prefill.brandColors = hexes.join(", ");
    }
    if (!prefill.videoStyle) prefill.videoStyle = stripMoneySentences(joinVals(ap?.editingJson)).slice(0, 1200);
    if (!prefill.preferences) prefill.preferences = stripMoneySentences(joinVals(ap?.productionJson)).slice(0, 1200);
  }
  // Their content strategy — the ACTIVE one, read-only and money-scrubbed
  // (Jordan: "in their agent profile, they should have their content strategy
  // on display").
  let strategySections: { name: string; body: string }[] = [];
  if (tab === "profile") {
    const strat = await prisma.contentStrategy.findFirst({
      where: { enrollmentId: enrollment.id, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { sectionsJson: true },
    }).catch(() => null);
    if (strat?.sectionsJson) {
      try {
        const { stripMoneySentences } = await import("@/lib/text");
        const obj = JSON.parse(strat.sectionsJson) as Record<string, unknown>;
        strategySections = Object.entries(obj)
          .filter(([, v]) => typeof v === "string" && (v as string).trim().length > 0)
          .map(([k, v]) => ({
            name: k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
            body: stripMoneySentences(v as string),
          }))
          .filter((sec) => sec.body.trim().length > 0);
      } catch { /* unreadable strategy → tab renders without it */ }
    }
  }
  // Terms + assets only when their tabs render (assets = Dropbox round-trips).
  const termsSetting = tab === "terms" ? await prisma.appSetting.findUnique({ where: { key: "portal-terms" } }).catch(() => null) : null;
  const assets = tab === "profile" ? await listClientAssets(enrollment.clientId, { links: true }).catch(() => null) : null;

  const current = months.find((m) => m.monthKey === monthKey) ?? null;
  const call = current?.strategyCallStatus ?? "NOT_SCHEDULED";
  const callAt = current?.strategyCallAt ?? null;
  const callBooked = call !== "NOT_SCHEDULED";
  const now = new Date();
  const upcoming = sessions.filter((s) => s.shootDate && s.shootDate >= now).sort((a, b) => +a.shootDate! - +b.shootDate!);
  const currentVideos = library.filter((v) => v.monthId === current?.id);
  const currentScripts = scripts.filter((s) => s.monthId === current?.id);
  const first = (client?.name ?? "there").split(/\s+/)[0];
  const href = (t: TabKey) => `/portal/${token}${t === "home" ? "" : `?tab=${t}`}`;

  const terms = (termsSetting?.value?.trim() || DEFAULT_TERMS).split(/\n\s*\n/);

  return (
    <div className="portal-light fixed inset-0 z-50 overflow-y-auto bg-background text-foreground">
      {/* aurora wash — the hub's futurist ground, tuned for the portal */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 h-72"
        style={{ background: "radial-gradient(60% 100% at 50% 0%, color-mix(in oklab, var(--brand) 14%, transparent), transparent 70%)" }} />
      <div className="relative mx-auto max-w-3xl p-4 pb-24 sm:p-6">
        {/* BRAND + NAME */}
        <div className="flex items-center gap-2.5 pt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
<img src="/brand/mark.svg" alt="RealTour Pilot" className="flex size-10 rounded-xl shadow-lg bg-white p-1" />
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">
              Real<span className="text-brand">Tour</span> Pilot <span className="ml-1 hidden text-muted-2 sm:inline">· Content Program</span>
            </div>
            <div className="truncate text-xs text-muted">{client?.name}</div>
          </div>
        </div>

        {/* TABS — segmented pill */}
        <nav className="mt-5 flex gap-1 overflow-x-auto rounded-2xl border border-border bg-surface/70 p-1 backdrop-blur">
          {TABS.map((t) => (
            <Link key={t.key} href={href(t.key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold sm:text-sm",
                tab === t.key ? "bg-brand text-white shadow" : "text-muted hover:text-foreground",
              )}>
              <t.icon className="size-4" /> {t.label}
            </Link>
          ))}
        </nav>

        {/* ---------------- HOME ---------------- */}
        {tab === "home" && (
          <div className="mt-6 space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight">Hi {first} 👋</h1>

            {/* This month at a glance */}
            <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">{monthLabel(monthKey)}</span>
                <span className="text-sm font-bold tabular-nums">{currentVideos.length}<span className="text-muted-2">/{enrollment.videosPerMonth} videos</span></span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-gradient-to-r from-brand to-orange-400"
                  style={{ width: `${Math.min(100, (currentVideos.length / Math.max(1, enrollment.videosPerMonth)) * 100)}%` }} />
              </div>
              <div className="mt-3 space-y-2 text-sm">
                {call === "COMPLETED" ? (
                  <p className="flex items-center gap-2 text-success"><CheckCircle2 className="size-4 shrink-0" /> Strategy call done{callAt ? ` — ${fmtDate(callAt)}` : ""}</p>
                ) : call === "SCHEDULED" && callAt ? (
                  <p className="flex items-center gap-2"><CalendarClock className="size-4 shrink-0 text-brand" /> Strategy call — {fmtDate(callAt)} at {fmtTime(callAt)} ET</p>
                ) : null}
                {/* THE SESSION — date, time, location, one spot */}
                {upcoming[0] ? (
                  <div className="rounded-xl border border-brand/25 bg-brand-soft/30 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-widest text-brand">Your next session</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-medium">
                      <span className="flex items-center gap-1.5"><CalendarClock className="size-4 text-brand" /> {fmtDate(upcoming[0].shootDate!)}</span>
                      <span className="flex items-center gap-1.5"><Clock className="size-4 text-brand" /> {fmtTime(upcoming[0].shootDate!)} ET</span>
                      {streetOf(upcoming[0].title, upcoming[0].addressLine) && (
                        <span className="flex items-center gap-1.5"><MapPin className="size-4 text-brand" /> {streetOf(upcoming[0].title, upcoming[0].addressLine)}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 text-muted"><Camera className="size-4 shrink-0" /> No filming session booked yet</p>
                )}
              </div>
            </div>

            {/* Scheduling */}
            <PortalScheduler token={token} callBooked={callBooked} bookingUrl={STRATEGY_CALL_BOOKING_URL} hasUpcomingSession={!!upcoming[0]} />

            {cuts.length > 0 && (
              <Link href={href("library")} className="flex items-center gap-2 rounded-2xl border border-brand/30 bg-brand-soft/40 p-4 text-sm font-medium hover:bg-brand-soft/60">
                <PlayCircle className="size-4 text-brand" />
                {cuts.length} video{cuts.length === 1 ? "" : "s"} ready for your review
                <ChevronRight className="ml-auto size-4 text-brand" />
              </Link>
            )}

            {/* This month's content */}
            {currentVideos.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">This month&rsquo;s videos</span>
                  <Link href={href("library")} className="text-xs font-medium text-brand hover:underline">Full library →</Link>
                </div>
                <VideoGrid videos={currentVideos} />
              </div>
            )}
            {currentScripts.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                <div className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4 text-brand" /> This month&rsquo;s scripts</div>
                <p className="mt-1 text-xs text-muted-2">Tap to read — and hit &ldquo;Suggest a change&rdquo; if you&rsquo;d word anything differently.</p>
                <div className="mt-3 space-y-2">
                  {currentScripts.map((sc) => (
                    <details key={sc.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={currentScripts.length <= 2}>
                      <summary className="cursor-pointer text-sm font-bold">{sc.title}</summary>
                      <ScriptBody body={sc.body} />
                      <PortalSuggestBox token={token} scriptId={sc.id} />
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------- CONTENT LIBRARY ---------------- */}
        {tab === "library" && (
          <div className="mt-6 space-y-5">
            {cuts.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-brand/30 bg-surface/70 p-4 backdrop-blur">
                <div className="text-sm font-semibold">For your review</div>
                <p className="mt-1 text-xs text-muted-2">Pause, drop a note where you want a change, then &ldquo;Request changes&rdquo; — straight to your editor.</p>
                <div className="mt-3 space-y-4">
                  {cuts.map((c) => (
                    <PortalVideoReview key={c.submissionId} token={token} cut={c} monthLabel={monthLabel(c.monthKey)} />
                  ))}
                </div>
              </div>
            )}
            {months.filter((m) => library.some((v) => v.monthId === m.id) || scripts.some((s) => s.monthId === m.id) || sessions.some((s) => s.contentMonthId === m.id && s.shootDate)).map((m) => {
              const mVideos = library.filter((v) => v.monthId === m.id);
              const mScripts = scripts.filter((s) => s.monthId === m.id);
              const mSessions = sessions.filter((s) => s.contentMonthId === m.id && s.shootDate);
              const isCurrent = m.monthKey === monthKey;
              return (
                <div key={m.id} className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-base font-semibold">{monthLabel(m.monthKey)}</span>
                    {isCurrent && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">this month</span>}
                    <span className="text-xs text-muted-2">
                      {[mVideos.length > 0 ? `${mVideos.length} video${mVideos.length === 1 ? "" : "s"}` : null, mScripts.length > 0 ? `${mScripts.length} script${mScripts.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {/* Session line: date · time · location */}
                  {mSessions.map((s) => (
                    <div key={s.id} className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      <span className="flex items-center gap-1"><CalendarClock className="size-3.5 text-brand" /> {fmtDate(s.shootDate!)}</span>
                      <span className="flex items-center gap-1"><Clock className="size-3.5 text-brand" /> {fmtTime(s.shootDate!)} ET</span>
                      {streetOf(s.title, s.addressLine) && <span className="flex items-center gap-1"><MapPin className="size-3.5 text-brand" /> {streetOf(s.title, s.addressLine)}</span>}
                      {s.status === "DELIVERED" && <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span>}
                    </div>
                  ))}
                  {mVideos.length > 0 && <VideoGrid videos={mVideos} />}
                  {mScripts.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-2">Scripts</div>
                      {mScripts.map((sc) => (
                        <details key={sc.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                          <summary className="cursor-pointer text-sm font-bold">{sc.title}</summary>
                          <ScriptBody body={sc.body} size="xs" />
                          {isCurrent && <PortalSuggestBox token={token} scriptId={sc.id} />}
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ---------------- AGENT PROFILE ---------------- */}
        {tab === "profile" && (
          <div className="mt-6 space-y-4">
            {strategySections.length > 0 && (
              <div className="panel-shadow rounded-2xl border border-border bg-surface/70 p-4 backdrop-blur">
                <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> Your content strategy</div>
                <p className="mt-1 text-xs text-muted-2">The playbook behind your monthly content — built from your brand discovery and strategy calls.</p>
                <div className="mt-3 space-y-2">
                  {strategySections.map((sec) => (
                    <details key={sec.name} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                      <summary className="cursor-pointer text-sm font-bold">{sec.name}</summary>
                      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/85">{sec.body}</p>
                    </details>
                  ))}
                </div>
              </div>
            )}
            <PortalProfile
              token={token}
              initial={prefill}
              assets={(assets?.files ?? []).map((f) => ({ name: f.name, url: f.url }))}
            />
          </div>
        )}

        {/* ---------------- TERMS ---------------- */}
        {tab === "terms" && (
          <div className="panel-shadow mt-6 rounded-2xl border border-border bg-surface/70 p-5 backdrop-blur">
            <div className="flex items-center gap-2 text-sm font-semibold"><ScrollText className="size-4 text-brand" /> Terms of Service</div>
            <div className="mt-3 space-y-3">
              {terms.map((block, i) => {
                if (block.startsWith("## ")) {
                  // The heading may share its block with body lines (review
                  // finding: the whole block rendered inside the <h3>).
                  const [head, ...rest] = block.split("\n");
                  const body = rest.join("\n").trim();
                  return (
                    <div key={i}>
                      <h3 className="pt-3 text-sm font-bold text-foreground">{head.replace(/^## /, "")}</h3>
                      {body && (rest.every((l) => !l.trim() || l.trim().startsWith("- ")) ? (
                        <ul className="mt-2 space-y-1 pl-1">
                          {rest.filter((l) => l.trim().startsWith("- ")).map((l, j) => (
                            <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85">
                              <span className="text-brand">·</span>
                              <span>{l.trim().replace(/^- /, "")}</span>
                            </li>
                          ))}
                          {rest.filter((l) => l.trim() && !l.trim().startsWith("- ")).map((l, j) => (
                            <p key={`p${j}`} className="text-sm leading-relaxed text-foreground/85">{l}</p>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/85">{body}</p>
                      ))}
                    </div>
                  );
                }
                const lines = block.split("\n");
                if (lines.every((l) => l.trim().startsWith("- "))) {
                  return (
                    <ul key={i} className="space-y-1 pl-1">
                      {lines.map((l, j) => (
                        <li key={j} className="flex gap-2 text-sm leading-relaxed text-foreground/85">
                          <span className="text-brand">·</span>
                          <span>{l.trim().replace(/^- /, "")}</span>
                        </li>
                      ))}
                    </ul>
                  );
                }
                return <p key={i} className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">{block}</p>;
              })}
            </div>
          </div>
        )}

        <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-xs text-muted-2">
          <Sparkles className="size-3.5" /> Questions or topic ideas? Text us any time.
        </p>
      </div>
    </div>
  );
}

function VideoGrid({ videos }: { videos: { id: string; title: string | null; thumb: string | null; playback: string | null; download: string | null }[] }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-3">
      {videos.map((v, i) => (
        <div key={v.id} className="lift overflow-hidden rounded-xl border border-border bg-surface">
          {v.playback ? (
            <video src={v.playback} poster={v.thumb ?? undefined} controls playsInline preload="none" className="aspect-[9/16] max-h-64 w-full bg-black object-contain" />
          ) : v.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.thumb} alt={v.title ?? "Video"} className="max-h-64 w-full object-cover" />
          ) : null}
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{v.title ?? `Video ${i + 1}`}</span>
            {v.download && (
              <a href={v.download} target="_blank" rel="noopener noreferrer" title="Download"
                className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-semibold text-brand hover:underline">
                <Download className="size-3" />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
