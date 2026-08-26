import Link from "next/link";
import { Clapperboard, FolderOpen, FileText, CalendarClock, ExternalLink, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { FloatingStyleGuide } from "@/components/editing/FloatingStyleGuide";
import { Section } from "@/components/ui/Section";
import { prisma } from "@/lib/prisma";
import { etAddDays } from "@/lib/datetime";
import { projectFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { videoTier } from "@/lib/projectStatus";
import { isMonthlyContentJob } from "@/lib/pipeline";
import { stripMoneySentences } from "@/lib/text";
import { SlaCountdown } from "./SlaCountdown";
import { SendToReviewButton } from "./EditorActions";

// ---------------------------------------------------------------------------
// The guided VA day for a logged-in EDITOR (Kim / Remar). NOT the owner tracker
// — this is their own scoped worklist:
//   · DO NOW — their open edit_video + revision tasks, sorted by dueAt, each with
//     a live SLA countdown + the three links they need (RAW / Brief / Frame.io)
//     and the "Done — send to review" action.
//   · UP NEXT — booked/scheduled shoots with a video deliverable coming up (60d
//     days, so they see the week's load coming.
// Creative-safe: NO money anywhere (they're creative tier).
// `editorScope` is the caller's resolved editor key (me.editorKey || slug).
// ---------------------------------------------------------------------------
export async function EditorDay({ editorScope, editorName }: { editorScope: string; editorName: string }) {
  const { editorRouting } = await import("@/lib/settings");
  const rules = await editorRouting();
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
        // The ASK itself — a revision card that just says "Revision" gives the
        // editor nothing to act on (audit). description holds the client's own
        // words; summary is the brain's read.
        ask: t.taskType === "revision" ? stripMoneySentences(t.description?.trim() || t.summary?.trim() || "") || null : null,
        rawUrl,
        briefUrl: `/edit/${p.id}`,
        frameio: p.frameioViewUrl,
      };
    });

  // UP NEXT — booked/scheduled shoots with a video deliverable landing in the
  // next 7 days. Not scoped to the editor (a shoot has no editor yet — it hasn't
  // been shot), but filtered to video jobs whose route would be this editor, so
  // the VA sees their own incoming load, not the whole company's calendar.
  const soon = etAddDays(new Date(), 60); // Jordan: ANY upcoming shoot, not just the week
  const upcomingRaw = await prisma.project.findMany({
    where: {
      status: { in: ["BOOKED", "SCHEDULED"] },
      shootDate: { gte: new Date(), lte: soon },
      deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
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
      const key = editorForDeliverable(v.type, v.label, isMonthlyContentJob(p.deliverables), rules);
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

  // The editor's notification feed + finished-work receipts — this page IS
  // their channel now (Jordan Aug 25: dashboard notifications, no Slack/SMS).
  const since = new Date(Date.now() - 14 * 86_400_000);
  const [pings, finished] = await Promise.all([
    prisma.notification.findMany({
      where: { userKey: `editor:${editorScope}`, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, title: true, href: true, createdAt: true, kind: true },
    }),
    prisma.smartTask.findMany({
      where: {
        assignedKey: editorScope,
        taskType: { in: ["edit_video", "revision"] },
        status: "COMPLETED",
        completedAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
      },
      orderBy: { completedAt: "desc" },
      take: 8,
      select: { id: true, title: true, completedAt: true },
    }),
  ]);

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
        // The Style Guide pops up as a draggable floating window now (Jordan),
        // so the editor can keep it beside the job they're cutting — the full
        // page stays one click away from the window's title bar.
        actions={<FloatingStyleGuide />}
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
                      {j.ask && (
                        <p className="mt-1.5 whitespace-pre-line break-words rounded-lg border border-danger/20 bg-danger/5 p-2 text-xs text-foreground/85">
                          {j.ask}
                        </p>
                      )}
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <a href={j.rawUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2">
                          <FolderOpen className="size-3.5 text-muted" /> RAW folder <ExternalLink className="size-3 text-muted-2" />
                        </a>
                        <Link href={j.briefUrl} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2">
                          <FileText className="size-3.5 text-muted" /> Brief
                        </Link>
                      </div>
                    </div>
                    <SendToReviewButton projectId={j.projectId} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* FOR YOU — raws landed, revisions, review verdicts. The bell rows
            addressed to this editor, on the page they actually open. */}
        {pings.length > 0 && (
          <Section icon={FileText} title="For you" count={pings.length}>
            <ul className="divide-y divide-border">
              {pings.map((n) => (
                <li key={n.id}>
                  <Link href={n.href} className="flex items-center justify-between gap-3 py-2 hover:bg-surface-2/50">
                    <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-2">
                      {n.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section icon={CalendarClock} title="Up next — on the schedule" count={upNext.length || null}>
          {upNext.length === 0 ? (
            <p className="text-sm text-muted">No video shoots on the schedule for you yet.</p>
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

        {/* THE DAY'S RECEIPTS — what you finished (the sweep used to close
            these silently, indistinguishable from "disappeared" — audit). */}
        {finished.length > 0 && (
          <Section icon={Clapperboard} title="Recently finished" count={finished.length}>
            <ul className="divide-y divide-border">
              {finished.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-muted">{f.title}</span>
                  <span className="shrink-0 text-[11px] text-success">
                    ✓ {f.completedAt?.toLocaleDateString("en-US", { month: "short", day: "numeric" }) ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
