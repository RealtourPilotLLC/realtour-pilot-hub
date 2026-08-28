import { notFound } from "next/navigation";
import { CalendarClock, Camera, FileText, PlayCircle, Sparkles } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { monthLabel, etMonthKey } from "@/lib/contentProgram";
import { STRATEGY_CALL_BOOKING_URL } from "@/lib/integrations/calendly";
import { portalCuts, CLIENT_VISIBLE_SCRIPT } from "@/lib/portal";
import { PortalVideoReview } from "@/components/portal/PortalVideoReview";
import { PortalSuggestBox } from "@/components/portal/PortalSuggestBox";

export const dynamic = "force-dynamic";

// CLIENT-FACING content portal (Phase 5, first slice — Aug 25). Public route
// gated by the unguessable per-client token; renders full-screen over the app
// shell like the public feedback form. STRICT content rules: approved scripts,
// session dates, and the booking link ONLY — no topics-in-progress, no internal
// notes, no drafts, never money.
// Script visibility now lives in src/lib/portal.ts — the render and the write
// layer must never drift apart on what a client may see.

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
  const month = await prisma.contentMonth.findUnique({
    where: { enrollmentId_monthKey: { enrollmentId: enrollment.id, monthKey } },
    select: { id: true },
  });
  const cuts = await portalCuts(enrollment.id).catch(() => []);
  const [scripts, sessions] = await Promise.all([
    month
      ? prisma.contentScript.findMany({
          where: { monthId: month.id, status: { in: CLIENT_VISIBLE_SCRIPT } },
          orderBy: { createdAt: "asc" },
          select: { id: true, title: true, body: true, status: true },
        })
      : Promise.resolve([]),
    month
      ? prisma.project.findMany({
          where: { contentMonthId: month.id, status: { not: "CANCELLED" }, shootDate: { not: null } },
          orderBy: { shootDate: "asc" },
          select: { shootDate: true },
        })
      : Promise.resolve([]),
  ]);

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

        {/* Session dates */}
        <div className="mt-6 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><Camera className="size-4 text-brand" /> Your filming session{sessions.length === 1 ? "" : "s"}</div>
          {sessions.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-muted">
              {sessions.map((s2, i) => (
                <li key={i}>
                  {s2.shootDate!.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} ET
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No session on the calendar yet — we&rsquo;ll get one booked.</p>
          )}
          <a
            href={STRATEGY_CALL_BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <CalendarClock className="size-4" /> Book your strategy call
          </a>
        </div>

        {/* Their videos — watch, drop timestamped notes, request changes.
            Only cuts Jordan APPROVED internally ever appear here. The card
            renders even while empty (Jordan, Aug 28: the interactive layer
            was invisible) so clients know the review loop exists. */}
        <div className="mt-5 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><PlayCircle className="size-4 text-brand" /> Your videos</div>
          {cuts.length > 0 ? (
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
          ) : (
            <p className="mt-2 text-sm text-muted">
              Your videos will appear right here as soon as they&rsquo;re ready — you&rsquo;ll watch them on this page, drop
              notes at the exact moment you want changed, and send them straight to your editor.
            </p>
          )}
        </div>

        {/* Approved scripts */}
        <div className="mt-5 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><FileText className="size-4 text-brand" /> Your scripts</div>
          {scripts.length > 0 && (
            <p className="mt-1 text-xs text-muted-2">
              Tap a script to read it — and if you&rsquo;d word something differently, hit &ldquo;Suggest a change&rdquo; inside and we&rsquo;ll rework it.
            </p>
          )}
          {scripts.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              Scripts for {monthLabel(monthKey)} are being written from your strategy call — they&rsquo;ll appear here the moment they&rsquo;re approved.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {scripts.map((sc) => (
                <details key={sc.id} className="rounded-xl border border-border bg-surface-2/40 px-4 py-3" open={scripts.length <= 2}>
                  <summary className="cursor-pointer text-sm font-semibold">{sc.title}</summary>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{sc.body}</p>
                  <PortalSuggestBox token={token} scriptId={sc.id} />
                </details>
              ))}
            </div>
          )}
        </div>

        <p className="mt-8 flex items-center gap-1.5 text-center text-xs text-muted-2">
          <Sparkles className="size-3.5" /> Questions or topic ideas? Text us any time — this page updates as your month progresses.
        </p>
      </div>
    </div>
  );
}
