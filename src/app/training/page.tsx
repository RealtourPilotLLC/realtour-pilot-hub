import { ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Browsable course view of the ingested training (currently the 910 Academy
// "Agent on Camera" course). Lessons are KnowledgeItem rows (source: aoc-training)
// — the same content Ask the Hub searches — grouped into modules parsed from each
// item's sourceRef ("… · Module N: Title · Lesson M"). Read-only, whole crew.
type Lesson = { lessonNo: number; title: string; body: string };

export default async function TrainingPage() {
  const items = await prisma.knowledgeItem.findMany({
    where: { source: "aoc-training", archived: false },
    select: { title: true, body: true, sourceRef: true },
  });

  const modules = new Map<number, { title: string; lessons: Lesson[] }>();
  for (const it of items) {
    const m = (it.sourceRef ?? "").match(/Module (\d+):\s*(.+?)\s*·\s*Lesson (\d+)/);
    if (!m) continue;
    const no = parseInt(m[1], 10);
    const mod = modules.get(no) ?? { title: m[2].trim(), lessons: [] };
    mod.lessons.push({ lessonNo: parseInt(m[3], 10), title: it.title.replace(/^AOC\s*·\s*/, ""), body: it.body });
    modules.set(no, mod);
  }
  for (const mod of modules.values()) mod.lessons.sort((a, b) => a.lessonNo - b.lessonNo);
  const ordered = [...modules.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div>
      <PageHeader
        eyebrow="910 Academy"
        title="Agent on Camera — Training"
        subtitle={`${ordered.length} modules · ${items.length} lessons · tap a lesson to read it`}
      />
      <div className="space-y-4 p-4 sm:p-6">
        {ordered.length === 0 ? (
          <p className="rounded-2xl border border-dashed bg-surface px-4 py-8 text-center text-sm text-muted">
            No training loaded yet.
          </p>
        ) : (
          ordered.map(([no, mod]) => (
            <section key={no} className="panel-shadow overflow-hidden rounded-2xl border bg-surface">
              <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand/15 text-xs font-bold text-brand">{no}</span>
                <h2 className="text-sm font-semibold">{mod.title}</h2>
                <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">{mod.lessons.length}</span>
              </div>
              <div className="divide-y divide-border">
                {mod.lessons.map((l) => (
                  <details key={l.lessonNo} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 hover:bg-surface-2">
                      <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
                      <span className="text-sm text-foreground/90">{l.title}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted-2">Lesson {l.lessonNo}</span>
                    </summary>
                    <div className="whitespace-pre-wrap px-4 pb-4 pl-10 text-sm leading-relaxed text-foreground/80">{l.body}</div>
                  </details>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
