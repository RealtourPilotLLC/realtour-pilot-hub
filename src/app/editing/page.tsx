import Link from "next/link";
import { FileText, Clock, Palette } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { prisma } from "@/lib/prisma";
import { stageMeta, DELIVERABLE_STATUS_META, DELIVERABLE_META } from "@/lib/pipeline";
import { format } from "date-fns";

export const dynamic = "force-dynamic";

export default async function EditorQueuePage() {
  const projects = await prisma.project.findMany({
    where: { status: { in: ["EDITING", "REVIEW"] } },
    orderBy: [{ priority: "desc" }, { deliveryDue: "asc" }],
    include: { client: true, editor: true, deliverables: true },
  });

  // Group by editor (unassigned bucket last).
  const groups = new Map<string, { editor: (typeof projects)[number]["editor"]; items: typeof projects }>();
  for (const p of projects) {
    const key = p.editor?.id ?? "__unassigned__";
    if (!groups.has(key)) groups.set(key, { editor: p.editor, items: [] });
    groups.get(key)!.items.push(p);
  }

  return (
    <div>
      <PageHeader
        title="Editor Queue"
        subtitle={`${projects.length} project${projects.length === 1 ? "" : "s"} in production`}
      />
      <div className="space-y-6 p-6">
        {projects.length === 0 && (
          <p className="text-sm text-muted">Nothing in editing or review right now.</p>
        )}
        {[...groups.values()].map(({ editor, items }) => (
          <div key={editor?.id ?? "unassigned"}>
            <div className="mb-2 flex items-center gap-2">
              {editor ? (
                <Avatar name={editor.name} color={editor.avatarColor} size={26} />
              ) : (
                <span className="flex size-[26px] items-center justify-center rounded-full bg-surface-2 text-muted">
                  <Palette className="size-3.5" />
                </span>
              )}
              <span className="text-sm font-semibold">{editor?.name ?? "Unassigned"}</span>
              <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium text-muted">
                {items.length}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {items.map((p) => {
                const stage = stageMeta(p.status);
                const done = p.deliverables.filter((d) => d.status === "DONE").length;
                return (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}`}
                    className="rounded-2xl border bg-surface p-4 transition-shadow hover:shadow-md"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold">{p.title}</span>
                      <Badge color={stage.color} soft={stage.soft}>
                        {stage.short}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-muted">{p.client.name}</div>

                    <div className="mt-3 space-y-1">
                      {p.deliverables.map((d) => {
                        const m = DELIVERABLE_STATUS_META[d.status];
                        return (
                          <div key={d.id} className="flex items-center justify-between text-xs">
                            <span className="text-foreground/80">
                              {DELIVERABLE_META[d.type].label}
                            </span>
                            <Badge color={m.color} soft={m.soft}>
                              {m.label}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex items-center justify-between border-t pt-2 text-xs text-muted">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {p.deliveryDue ? `Due ${format(p.deliveryDue, "MMM d")}` : "No due date"}
                      </span>
                      <span>
                        {done}/{p.deliverables.length} done
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
