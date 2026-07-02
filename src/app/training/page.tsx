import { ChevronDown, GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Markdown } from "@/components/ui/Markdown";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Browsable course library (910 Academy) — full transcripts from TrainingLesson,
// grouped Volume → Course → Lesson (both collapsible). The same content the Hub
// searches (as concise/chunked KnowledgeItems); this is the READING view.
export default async function TrainingPage() {
  const lessons = await prisma.trainingLesson.findMany({
    orderBy: [{ volumeNo: "asc" }, { courseNo: "asc" }, { orderNo: "asc" }],
    select: { volumeNo: true, volume: true, courseNo: true, course: true, title: true, body: true, summaryMd: true },
  });

  // Group: volume → course → lessons (input is already ordered).
  type L = { title: string; body: string; summaryMd: string | null };
  const volumes: { volumeNo: number; volume: string; courses: { course: string; lessons: L[] }[] }[] = [];
  for (const l of lessons) {
    let v = volumes.find((x) => x.volumeNo === l.volumeNo);
    if (!v) { v = { volumeNo: l.volumeNo, volume: l.volume, courses: [] }; volumes.push(v); }
    let c = v.courses.find((x) => x.course === l.course);
    if (!c) { c = { course: l.course, lessons: [] }; v.courses.push(c); }
    c.lessons.push({ title: l.title, body: l.body, summaryMd: l.summaryMd });
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
                      {c.lessons.map((l, i) => (
                        <details key={i} className="group/l">
                          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 pl-6 hover:bg-surface-2">
                            <ChevronDown className="size-3.5 shrink-0 -rotate-90 text-muted-2 transition-transform group-open/l:rotate-0" />
                            <span className="text-sm text-foreground/90">{l.title}</span>
                          </summary>
                          <div className="px-4 pb-4 pl-12">
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
