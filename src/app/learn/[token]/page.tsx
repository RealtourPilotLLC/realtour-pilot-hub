import { notFound } from "next/navigation";
import { GraduationCap } from "lucide-react";
import { Markdown } from "@/components/ui/Markdown";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PUBLIC (no login) training-lesson viewer, reached by an unguessable share
// token Jordan mints on /training. Deliberately shows only the video + the
// AI summary — NOT the verbatim transcript, which stays inside the app. This
// route is in the middleware public allowlist; access is the token itself.

function vimeoEmbed(url: string): string | null {
  const m = url.match(/vimeo\.com\/(\d+)(?:\/([a-zA-Z0-9]+))?/);
  if (!m) return null;
  return `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ""}`;
}

export default async function SharedLessonPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // A malformed/short token can't match a UUID column — bail before querying.
  if (!token || token.length < 8) notFound();

  // NOTE: `body` (the verbatim transcript) is deliberately NOT selected — it must
  // never reach this public page. The summary is the only text shown here.
  const lesson = await prisma.trainingLesson.findUnique({
    where: { shareToken: token },
    select: { title: true, course: true, volume: true, summaryMd: true, videoUrl: true },
  });
  // Revoked or never-shared → the token is gone → 404 (no leak that it existed).
  if (!lesson) notFound();

  const embed = lesson.videoUrl ? vimeoEmbed(lesson.videoUrl) : null;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-brand">
          <GraduationCap className="size-4" /> RealTour Pilot · Training
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{lesson.title}</h1>
        <p className="mt-1 text-sm text-muted">{lesson.volume}{lesson.course ? ` · ${lesson.course}` : ""}</p>

        {embed && (
          <div className="mt-5 aspect-video overflow-hidden rounded-2xl border border-border bg-black">
            <iframe
              src={embed}
              className="size-full"
              loading="lazy"
              title={lesson.title}
              allow="autoplay; fullscreen; picture-in-picture; clipboard-write"
              allowFullScreen
            />
          </div>
        )}

        <div className="mt-6">
          {lesson.summaryMd
            ? <Markdown content={lesson.summaryMd} />
            : <p className="text-sm text-muted">Watch the video above for this lesson.</p>}
        </div>

        <p className="mt-10 border-t border-border pt-4 text-[11px] text-muted-2">
          Shared privately by RealTour Pilot. Please don&apos;t redistribute this link.
        </p>
      </div>
    </div>
  );
}
