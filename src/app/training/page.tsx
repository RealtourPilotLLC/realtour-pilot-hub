import { ChevronDown, GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Markdown } from "@/components/ui/Markdown";
import { ShareLessonButton } from "@/components/training/ShareLessonButton";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

// Which Vol II courses creatives (photographers/editors) may see. Jordan's rule:
// they get everything CREATIVE — shooting, filming, editing, scripting — and
// none of the business side (sales, pricing, systems, growth, coaching replays).
// Vol I "Agent on Camera" is entirely creative and always visible. This is an
// ALLOWLIST on purpose: a newly-ingested business course is hidden by default.
// The Hub's KnowledgeItem chunks for the excluded courses are minRole ADMIN, so
// Ask-the-Hub matches this page.
const CREATIVE_VOL2_COURSES = new Set([
  "AI Editing",
  "Editing",
  "Scripting",
  "Shooting",
  "Viral Editing Masterclass (2024)",
  "Viral Editing Masterclass (2025)",
]);

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
  const me = await getCurrentUser().catch(() => null);
  const creative = !!me && contentTier(me.role) === "CREATIVE";
  // Only the owner can mint a PUBLIC share link (it bypasses login).
  const canShare = !me || me.role === "OWNER";
  const allLessons = await prisma.trainingLesson.findMany({
    orderBy: [{ volumeNo: "asc" }, { courseNo: "asc" }, { orderNo: "asc" }],
    select: { id: true, volumeNo: true, volume: true, courseNo: true, course: true, title: true, body: true, summaryMd: true, videoUrl: true, shareToken: true },
  });
  const lessons = creative
    ? allLessons.filter((l) => l.volume === "Agent on Camera" || CREATIVE_VOL2_COURSES.has(l.course))
    : allLessons;

  // Group: volume → course → lessons (input is already ordered).
  type L = { id: string; title: string; body: string; summaryMd: string | null; videoUrl: string | null; shareToken: string | null };
  const volumes: { volumeNo: number; volume: string; courses: { course: string; lessons: L[] }[] }[] = [];
  for (const l of lessons) {
    let v = volumes.find((x) => x.volumeNo === l.volumeNo);
    if (!v) { v = { volumeNo: l.volumeNo, volume: l.volume, courses: [] }; volumes.push(v); }
    let c = v.courses.find((x) => x.course === l.course);
    if (!c) { c = { course: l.course, lessons: [] }; v.courses.push(c); }
    c.lessons.push({ id: l.id, title: l.title, body: l.body, summaryMd: l.summaryMd, videoUrl: l.videoUrl, shareToken: l.shareToken });
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
                      {c.lessons.map((l, i) => {
                        const embed = l.videoUrl ? vimeoEmbed(l.videoUrl) : null;
                        return (
                        <details key={i} className="group/l">
                          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 pl-6 hover:bg-surface-2">
                            <ChevronDown className="size-3.5 shrink-0 -rotate-90 text-muted-2 transition-transform group-open/l:rotate-0" />
                            <span className="text-sm text-foreground/90">{l.title}</span>
                            {embed && <span className="rounded-full bg-brand-soft px-1.5 text-[10px] font-medium text-brand">Video</span>}
                            {canShare && (
                              <span className="ml-auto">
                                <ShareLessonButton lessonId={l.id} initialToken={l.shareToken} />
                              </span>
                            )}
                          </summary>
                          <div className="px-4 pb-4 pl-12">
                            {embed && (
                              <div className="mb-3 aspect-video overflow-hidden rounded-xl border border-border bg-black">
                                <iframe
                                  src={embed}
                                  className="size-full"
                                  loading="lazy"
                                  title={l.title}
                                  allow="autoplay; fullscreen; picture-in-picture; clipboard-write"
                                  allowFullScreen
                                />
                              </div>
                            )}
                            {l.summaryMd
                              ? <Markdown content={l.summaryMd} />
                              : <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">{l.body}</div>}
                            {l.summaryMd && (
                              <details className="group/t mt-3 border-t border-border pt-2">
                                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-2 hover:text-foreground">
                                  <ChevronDown className="size-3 shrink-0 -rotate-90 transition-transform group-open/t:rotate-0" /> Full transcript
                                </summary>
                                <div className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">{l.body}</div>
                              </details>
                            )}
                          </div>
                        </details>
                        );
                      })}
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
