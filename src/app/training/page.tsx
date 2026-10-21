import { requirePageAccess } from "@/lib/auth/guards";
import { ChevronDown, GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";
import { creativeMaySee } from "./lessonAccess";
import { LessonDetails } from "./LessonDetails";

export const dynamic = "force-dynamic";

// Which courses a creative may see: lessonAccess.ts (the page and the
// lesson-text action both apply it).

// These lessons are Studio 910 PB's videos on THEIR Vimeo. The Aug 14-17 2026
// outage ("Sorry, this video does not exist" everywhere, including 910's own
// Skool/site) was NEITHER embed-restriction NOR a deleted library: Studio 910
// told Jordan (Aug 17) they hit their Vimeo plan's PLAY LIMIT, which nukes the
// whole library — player 404s, oEmbed 404s, error-shell watch pages — until it
// resets/upgrades (theirs: expected fixed Aug 18). Embeds worked before the
// outage and Jordan asked for them back, so the player below is the shipped UI
// again. If every lesson errors at once in the future, suspect the play limit
// FIRST — it's account-wide and only Studio 910 can clear it.
//
// A 910 Academy Vimeo watch URL (e.g. https://vimeo.com/1206234728/43eb0c934b)
// → the player embed src (https://player.vimeo.com/video/1206234728?h=43eb0c934b).
function vimeoEmbed(url: string): string | null {
  const m = url.match(/vimeo\.com\/(\d+)(?:\/([a-zA-Z0-9]+))?/);
  if (!m) return null;
  return `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ""}`;
}

// Browsable course library (910 Academy) — full transcripts from TrainingLesson,
// grouped Volume → Course → Lesson (both collapsible). The same content the Hub
// searches (as concise/chunked KnowledgeItems); this is the READING view.
export default async function TrainingPage() {
  await requirePageAccess("training");
  const me = await getCurrentUser().catch(() => null);
  const creative = !!me && contentTier(me.role) === "CREATIVE";
  // Only the owner can mint a PUBLIC share link (it bypasses login).
  const canShare = !me || me.role === "OWNER";
  const allLessons = await prisma.trainingLesson.findMany({
    orderBy: [{ volumeNo: "asc" }, { courseNo: "asc" }, { orderNo: "asc" }],
    // Titles only (audit F21, Oct 20 2026): a lesson's text loads when it is
    // opened (LessonDetails), not every transcript in the page's HTML.
    select: { id: true, volumeNo: true, volume: true, courseNo: true, course: true, title: true, videoUrl: true, shareToken: true },
  });
  const lessons = creative ? allLessons.filter(creativeMaySee) : allLessons;

  // Group: volume → course → lessons (input is already ordered).
  type L = { id: string; title: string; videoUrl: string | null; shareToken: string | null };
  const volumes: { volumeNo: number; volume: string; courses: { course: string; lessons: L[] }[] }[] = [];
  for (const l of lessons) {
    let v = volumes.find((x) => x.volumeNo === l.volumeNo);
    if (!v) { v = { volumeNo: l.volumeNo, volume: l.volume, courses: [] }; volumes.push(v); }
    let c = v.courses.find((x) => x.course === l.course);
    if (!c) { c = { course: l.course, lessons: [] }; v.courses.push(c); }
    c.lessons.push({ id: l.id, title: l.title, videoUrl: l.videoUrl, shareToken: l.shareToken });
  }

  return (
    <div>
      <PageHeader
        eyebrow="910 Academy"
        title="Training"
        subtitle={`${volumes.length} volumes · ${lessons.length} lessons — tap a course, then a lesson to read it`}
      />
      <div className="space-y-8 p-4 sm:p-6">
        {volumes.length === 0 && (
          <p className="rounded-2xl border border-dashed bg-surface px-4 py-8 text-center text-sm text-muted">No training loaded yet.</p>
        )}
        {volumes.map((v) => {
          const count = v.courses.reduce((n, c) => n + c.lessons.length, 0);
          return (
            <section key={v.volumeNo}>
              <div className="mb-3 flex items-center gap-2 px-1">
                <GraduationCap className="size-5 text-brand" />
                <h2 className="text-base font-semibold tracking-tight">{v.volume}</h2>
                <span className="rounded-full bg-surface-2 px-2 text-xs font-medium text-muted">{count} lessons</span>
              </div>
              <div className="space-y-3">
                {v.courses.map((c) => (
                  <details key={c.course} className="group/c panel-shadow overflow-hidden rounded-2xl border bg-surface">
                    <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 hover:bg-surface-2">
                      <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open/c:rotate-0" />
                      <h3 className="text-sm font-semibold">{c.course}</h3>
                      <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{c.lessons.length}</span>
                    </summary>
                    <div className="divide-y divide-border border-t border-border">
                      {c.lessons.map((l) => (
                        <LessonDetails
                          key={l.id}
                          id={l.id}
                          title={l.title}
                          embed={l.videoUrl ? vimeoEmbed(l.videoUrl) : null}
                          canShare={canShare}
                          shareToken={l.shareToken}
                        />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
