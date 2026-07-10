import Link from "next/link";
import { Clapperboard, FolderOpen, FileText, CalendarClock, ExternalLink, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { prisma } from "@/lib/prisma";
import { etAddDays } from "@/lib/datetime";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { videoTier } from "@/lib/projectStatus";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { SlaCountdown } from "./SlaCountdown";
import { SendToReviewButton } from "./EditorActions";

// ---------------------------------------------------------------------------
// The guided VA day for a logged-in EDITOR (Kim / Remar). NOT the owner tracker
// — this is their own scoped worklist:
//   · DO NOW — their open edit_video + revision tasks, sorted by dueAt, each with
//     a live SLA countdown + the three links they need (RAW / Brief / Frame.io)
//     and the "Done — send to review" action.
//   · UP NEXT — booked/scheduled shoots with a video deliverable in the next 7
//     days, so they see the week's load coming.
// Creative-safe: NO money anywhere (they're creative tier).
// `editorScope` is the caller's resolved editor key (me.editorKey || slug).
// ---------------------------------------------------------------------------
export async function EditorDay({ editorScope, editorName }: { editorScope: string; editorName: string }) {
  // DO NOW — the editor's open work items on video jobs, scoped at the DB level
  // to their own assignedKey so the view can't even load someone else's.
  const tasks = await prisma.smartTask.findMany({
    where: {
      assignedKey: editorScope,
      taskType: { in: ["edit_video", "revision"] },
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }],
    include: {
      project: {
        select: {
          id: true,
          title: true,
          shootDate: true,
          frameioViewUrl: true,
          addressLine: true,
          createdAt: true,
          client: { select: { name: true, socialClient: true } },
          deliverables: { select: { type: true, label: true } },
        },
      },
    },
  });

  const doNow = tasks
    .filter((t) => t.project)
    .map((t) => {
      const p = t.project!;
      const street = (p.title || "").split(",")[0].trim() || p.title || "Job";
      const tier = videoTier(p.deliverables);
      const rawUrl = dropboxWebUrl(projectFolderPaths(p).rawVideo);
      return {
        taskId: t.id,
        taskType: t.taskType,
        projectId: p.id,
        street,
        client: p.client?.name ?? "",
        tier: tier === "premium" ? "Premium" : "Standard",
        premium: tier === "premium",
        dueISO: t.dueAt ? t.dueAt.toISOString() : null,
        rawUrl,
        briefUrl: `/edit/${p.id}`,
        frameio: p.frameioViewUrl,
      };
    });

  // UP NEXT — booked/scheduled shoots with a video deliverable landing in the
  // next 7 days. Not scoped to the editor (a shoot has no editor yet — it hasn't
  // been shot), but filtered to video jobs whose route would be this editor, so
  // the VA sees their own incoming load, not the whole company's calendar.
  const soon = etAddDays(new Date(), 7);
  const upcomingRaw = await prisma.project.findMany({
    where: {
      status: { in: ["BOOKED", "SCHEDULED"] },
      shootDate: { gte: new Date(), lte: soon },
    },
    orderBy: { shootDate: "asc" },
    select: {
      id: true,
      title: true,
      shootDate: true,
      client: { select: { name: true, socialClient: true } },
      deliverables: { select: { type: true, label: true } },
    },
  });
  const { editorForDeliverable } = await import("@/lib/editors");
  const upNext = upcomingRaw
    .map((p) => {
      const v = p.deliverables.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
      if (!v) return null;
      const key = editorForDeliverable(v.type, v.label, isMonthlyContentJob(p.deliverables));
      if (key !== editorScope) return null;
      const tier = videoTier(p.deliverables);
      return {
        id: p.id,
        street: (p.title || "").split(",")[0].trim() || p.title || "Job",
        client: p.client?.name ?? "",
        premium: tier === "premium",
        shootISO: p.shootDate ? p.shootDate.toISOString() : null,
      };
    })
    .filter(Boolean) as { id: string; street: string; client: string; premium: boolean; shootISO: string | null }[];

  const overdue = doNow.filter((d) => d.dueISO && new Date(d.dueISO).getTime() < Date.now()).length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Your editing day"
        title={`Hi ${editorName.split(" ")[0]}`}
        subtitle={
          doNow.length
            ? `${doNow.length} to edit${overdue ? ` · ${overdue} overdue` : ""}`
            : "Nothing waiting — you're all caught up."
        }
      />

      <div className="space-y-6 p-4 sm:p-6">
        <Section icon={Clapperboard} title="Do now" count={doNow.length || null}>
          {doNow.length === 0 ? (
            <p className="text-sm text-muted">No open edits. New raws land here the moment a shoot is uploaded.</p>
          ) : (
            <ul className="space-y-3">
              {doNow.map((j) => (
                <li key={j.taskId} className="rounded-xl border bg-surface p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {j.taskType === "revision" ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] font-semibold text-danger">
                            <Undo2 className="size-3" /> Revision
                          </span>
                        ) : null}
                        <span className="truncate text-sm font-semibold text-foreground">{j.street}</span>
                        <span
                          className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                          style={{ backgroundColor: j.premium ? "#a78bfa1a" : "#64748b1a", color: j.premium ? "#a78bfa" : "#64748b" }}
                        >
                          {j.tier}
                        </span>
                        <SlaCountdown dueISO={j.dueISO} />
                      </div>
                      {j.client && <div className="mt-0.5 text-xs text-muted">{j.client}</div>}
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <a href={j.rawUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2">
                          <FolderOpen className="size-3.5 text-muted" /> RAW folder <ExternalLink className="size-3 text-muted-2" />
                        </a>
                        <Link href={j.briefUrl} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2">
                          <FileText className="size-3.5 text-muted" /> Brief
                        </Link>
                        {j.frameio && (
                          <a href={j.frameio} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2">
                            <Clapperboard className="size-3.5 text-muted" /> Frame.io <ExternalLink className="size-3 text-muted-2" />
                          </a>
                        )}
                      </div>
                    </div>
                    <SendToReviewButton projectId={j.projectId} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section icon={CalendarClock} title="Up next — this week" count={upNext.length || null}>
          {upNext.length === 0 ? (
            <p className="text-sm text-muted">No video shoots booked for you in the next 7 days.</p>
          ) : (
            <ul className="divide-y divide-border">
              {upNext.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{u.street}</span>
                      {u.premium && (
                        <span className="rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: "#a78bfa1a", color: "#a78bfa" }}>
                          Premium
                        </span>
                      )}
                    </div>
                    {u.client && <span className="text-xs text-muted">{u.client}</span>}
                  </div>
                  {u.shootISO && (
                    <span className="shrink-0 text-xs text-muted">
                      Shoots {new Date(u.shootISO).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
