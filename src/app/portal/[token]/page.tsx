import { notFound } from "next/navigation";
import { CalendarClock, Camera, CheckCircle2, Download, FileText, History, PlayCircle, Sparkles } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { monthLabel, etMonthKey } from "@/lib/contentProgram";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { portalCuts, portalMonths, type PortalMonth } from "@/lib/portal";
import { PortalVideoReview } from "@/components/portal/PortalVideoReview";
import { PortalSuggestBox } from "@/components/portal/PortalSuggestBox";

export const dynamic = "force-dynamic";

// CLIENT-FACING content portal. Public route gated by the unguessable
// per-client token; renders full-screen over the app shell. STRICT content
// rules: approved scripts, sessions, delivered/approved videos, and the
// booking link ONLY — no topics-in-progress, no internal notes, no drafts,
// never money.
//
// Aug 28 rebuild (Jordan: "this honestly wasn't totally what I was
// expecting"): the page is now the client's WHOLE program, not one month's
// slice — a state-aware strategy-call card (no booking button when the call
// already happened), this month's sessions/videos/scripts, and a
// month-by-month archive of everything backfilled: past sessions, delivered
// videos straight from Aryeo (watch + download), and every approved script.

const fmtSession = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric" });

export default async function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(token)) notFound();
  const enrollment = await prisma.contentEnrollment.findUnique({
    where: { portalToken: token },
    select: { id: true, clientId: true, status: true, videosPerMonth: true },
  });
  if (!enrollment || enrollment.status !== "ACTIVE") notFound();
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });

  const monthKey = etMonthKey();
  const [cuts, allMonths] = await Promise.all([
    portalCuts(enrollment.id).catch(() => []),
    portalMonths(enrollment.id).catch(() => [] as PortalMonth[]),
  ]);
  const current = allMonths.find((m) => m.monthKey === monthKey) ?? null;
  const past = allMonths.filter((m) => m.monthKey !== monthKey && (m.scripts.length > 0 || m.videos.length > 0 || m.sessions.length > 0));

  // The strategy call, truthfully: done → say so; booked → show when; only a
  // genuinely un-booked required call gets the booking button (Jordan: "the
  // button is right there and not even needed — she already had her call").
  const call = current?.strategyCallStatus ?? "NOT_SCHEDULED";
  const callAt = current?.strategyCallAtISO ?? null;
  const showBooking = call === "NOT_SCHEDULED";

  const first = (client?.name ?? "there").split(/\s+/)[0];
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <div className="mx-auto max-w-2xl p-6 pb-20">
        <div className="mb-8 flex items-center gap-2.5 pt-4">
          <div
            className="flex size-9 items-center justify-center rounded-xl text-sm font-bold text-white"
            style={{ background: "linear-gradient(135deg, #f97316, #e96320 55%, #c2410c)" }}
          >
            RP
          </div>
          <div className="text-sm font-semibold tracking-tight">
            Real<span className="text-brand">Tour</span> Pilot <span className="ml-1 text-muted-2">· Content Program</span>
          </div>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">Hi {first} 👋</h1>
        <p className="mt-1 text-sm text-muted">
          Your {monthLabel(monthKey)} content — {enrollment.videosPerMonth} video{enrollment.videosPerMonth === 1 ? "" : "s"} this month.
        </p>

        {/* THIS MONTH — call state + sessions */}
        <div className="mt-6 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> This month</div>

          {/* Strategy call, state-aware */}
          <div className="mt-2 text-sm">
            {call === "COMPLETED" ? (
              <p className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="size-4" /> Strategy call done{callAt ? ` — ${fmtDay(callAt)}` : ""}. Your content plan is set.
              </p>
            ) : call === "SCHEDULED" && callAt ? (
              <p className="flex items-center gap-1.5 text-muted">
                <CalendarClock className="size-4 text-brand" /> Strategy call booked for {fmtSession(callAt)} ET.
              </p>
            ) : call === "SKIPPED" || call === "NOT_REQUIRED" ? null : null}
          </div>

          {/* Sessions */}
          {(current?.sessions.length ?? 0) > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-muted">
              {current!.sessions.filter((s) => s.dateISO).map((s, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <Camera className="size-3.5 text-muted-2" />
                  Filming: {fmtSession(s.dateISO!)} ET
                  {s.delivered && <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">delivered</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No filming session on the calendar yet — we&rsquo;ll get one booked.</p>
          )}

          {showBooking && (
            <a
              href={STRATEGY_CALL_BOOKING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              <CalendarClock className="size-4" /> Book your strategy call
            </a>
          )}
        </div>

        {/* VIDEOS — in-review cuts (interactive) + this month's delivered, or the what's-coming note */}
        <div className="mt-5 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><PlayCircle className="size-4 text-brand" /> Your videos</div>
          {cuts.length > 0 && (
            <>
              <p className="mt-1 text-xs text-muted-2">
                Watch each cut, pause and drop a note where you want a change, then hit &ldquo;Request changes&rdquo; — it goes straight to your editor.
              </p>
              <div className="mt-3 space-y-4">
                {cuts.map((c) => (
                  <PortalVideoReview key={c.submissionId} token={token} cut={c} monthLabel={monthLabel(c.monthKey)} />
                ))}
              </div>
            </>
          )}
          {(current?.videos.length ?? 0) > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">Delivered this month</div>
              <DeliveredGrid videos={current!.videos} />
            </div>
          )}
          {cuts.length === 0 && (current?.videos.length ?? 0) === 0 && (
            <p className="mt-2 text-sm text-muted">
              Your videos will appear right here as soon as they&rsquo;re ready — you&rsquo;ll watch them on this page, drop
              notes at the exact moment you want changed, and send them straight to your editor.
            </p>
          )}
        </div>

        {/* Approved scripts */}
        <div className="mt-5 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4 text-brand" /> Your scripts</div>
          {(current?.scripts.length ?? 0) > 0 ? (
            <>
              <p className="mt-1 text-xs text-muted-2">
                Tap a script to read it — and if you&rsquo;d word something differently, hit &ldquo;Suggest a change&rdquo; inside and we&rsquo;ll rework it.
              </p>
              <div className="mt-3 space-y-3">
                {current!.scripts.map((sc) => (
                  <details key={sc.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={current!.scripts.length <= 2}>
                    <summary className="cursor-pointer text-sm font-semibold">{sc.title}</summary>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{sc.body}</p>
                    <PortalSuggestBox token={token} scriptId={sc.id} />
                  </details>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Scripts for {monthLabel(monthKey)} are being written from your strategy call — they&rsquo;ll appear here the moment they&rsquo;re approved.
            </p>
          )}
        </div>

        {/* THE ARCHIVE — every past month: sessions, delivered videos, scripts */}
        {past.length > 0 && (
          <div className="mt-5 rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-sm font-semibold"><History className="size-4 text-brand" /> Past months</div>
            <p className="mt-1 text-xs text-muted-2">Everything we&rsquo;ve made together — sessions, videos and scripts, month by month.</p>
            <div className="mt-3 space-y-3">
              {past.map((m) => (
                <details key={m.monthKey} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3">
                  <summary className="cursor-pointer text-sm font-semibold">
                    {monthLabel(m.monthKey)}
                    <span className="ml-2 text-xs font-normal text-muted-2">
                      {[
                        m.videos.length > 0 ? `${m.videos.length} video${m.videos.length === 1 ? "" : "s"}` : null,
                        m.scripts.length > 0 ? `${m.scripts.length} script${m.scripts.length === 1 ? "" : "s"}` : null,
                      ].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </summary>
                  {m.sessions.filter((s) => s.dateISO).length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-muted">
                      {m.sessions.filter((s) => s.dateISO).map((s, i) => (
                        <li key={i}>Filmed {fmtDay(s.dateISO!)}</li>
                      ))}
                    </ul>
                  )}
                  {m.videos.length > 0 && <DeliveredGrid videos={m.videos} />}
                  {m.scripts.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {m.scripts.map((sc) => (
                        <details key={sc.id} className="rounded-lg border border-border bg-surface px-3 py-2">
                          <summary className="cursor-pointer text-xs font-semibold">{sc.title}</summary>
                          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">{sc.body}</p>
                        </details>
                      ))}
                    </div>
                  )}
                </details>
              ))}
            </div>
          </div>
        )}

        <p className="mt-8 flex items-center gap-1.5 text-center text-xs text-muted-2">
          <Sparkles className="size-3.5" /> Questions or topic ideas? Text us any time — this page updates as your month progresses.
        </p>
      </div>
    </div>
  );
}

// Delivered videos straight from Aryeo — playable inline, downloadable from
// the same CDN link the delivery email uses.
function DeliveredGrid({ videos }: { videos: { title: string | null; thumb: string | null; playback: string | null; download: string | null }[] }) {
  return (
    <div className="mt-2 grid gap-3 sm:grid-cols-2">
      {videos.map((v, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border bg-surface">
          {v.playback ? (
            <video src={v.playback} poster={v.thumb ?? undefined} controls playsInline preload="none" className="aspect-[9/16] max-h-72 w-full bg-black object-contain" />
          ) : v.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.thumb} alt={v.title ?? "Video"} className="max-h-72 w-full object-cover" />
          ) : null}
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{v.title ?? `Video ${i + 1}`}</span>
            {v.download && (
              <a href={v.download} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-brand hover:underline">
                <Download className="size-3" /> Download
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
