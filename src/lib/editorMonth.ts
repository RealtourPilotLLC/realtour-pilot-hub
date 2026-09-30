import "server-only";

import type { CurrentUser } from "@/lib/auth/user";
import { canViewProject } from "@/lib/auth/guards";
import { actualFolderPaths, dropboxWebUrl } from "@/lib/dropboxFolders";
import { prisma } from "@/lib/prisma";
import { filmingBriefFor } from "@/lib/deliverableOutputs";

type Output = {
  projectId: string;
  category: string;
  currentSubmissionId: string | null;
  approvedSubmissionId: string | null;
  deliveredAt: Date | null;
};

/** Keep the package promise and job rows separate: old overrides may disagree. */
export function monthOutputCounts(outputs: Output[], filmedVideoIds: string[]) {
  const videos = outputs.filter((o) => o.category === "VIDEO" || o.category === "SOCIAL_REEL");
  return {
    slotsOnJobs: videos.length,
    filmedConfirmed: new Set(filmedVideoIds).size,
    submitted: videos.filter((o) => !!o.currentSubmissionId).length,
    approved: videos.filter((o) => !!o.approvedSubmissionId).length,
    delivered: videos.filter((o) => !!o.deliveredAt).length,
  };
}

export type EditorMonth = {
  enrollmentId: string;
  monthKey: string;
  allowance: number;
  allSessionsVisible: boolean;
  counts: ReturnType<typeof monthOutputCounts> | null;
  sessions: {
    key: string;
    id: string;
    appointmentIndex: number;
    appointmentsOnJob: number;
    title: string;
    dateISO: string | null;
    address: string;
    status: string;
    rawUrl: string;
    topics: string[];
    noTopicLinks: boolean;
    jobSlots: number;
  }[];
  unlinkedClientJobs: number;
};

/** Read-only, exact ContentMonth links only. Never infer a session from a name/date. */
export async function editorMonthFor(projectId: string, viewer: CurrentUser | null): Promise<EditorMonth | null> {
  const current = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true, contentMonthId: true } });
  if (!current?.contentMonthId) return null;
  const month = await prisma.contentMonth.findUnique({
    where: { id: current.contentMonthId },
    select: { id: true, clientId: true, enrollmentId: true, monthKey: true, videosOwed: true },
  });
  if (!month || month.clientId !== current.clientId) return null;

  const [linked, unlinkedClientJobs] = await Promise.all([
    prisma.project.findMany({
      where: { contentMonthId: month.id, clientId: current.clientId, status: { not: "CANCELLED" } },
      orderBy: [{ shootDate: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, title: true, addressLine: true, city: true, state: true, shootDate: true, createdAt: true,
        status: true, dropboxFolder: true, client: { select: { name: true } },
        appointments: { where: { status: { not: "CANCELED" } }, orderBy: { startAt: "asc" }, select: { id: true, startAt: true } },
      },
    }),
    // A prompt for staff reconciliation, not a suggested match. These may be
    // unrelated listing jobs; we never attach or show their folders here.
    prisma.project.count({ where: { clientId: current.clientId, contentMonthId: null, status: { not: "CANCELLED" }, deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null, waivedAt: null } } } }),
  ]);
  const visible = (await Promise.all(linked.map(async (p) => ({ p, allowed: await canViewProject(p.id, viewer ?? undefined) })))).filter((r) => r.allowed).map((r) => r.p);
  if (!visible.some((p) => p.id === projectId)) return null;
  const allSessionsVisible = visible.length === linked.length;
  const ids = visible.map((p) => p.id);
  const [outputs, filmed] = await Promise.all([
    prisma.deliverableOutput.findMany({
      where: { projectId: { in: ids }, waivedAt: null, removedFromOrderAt: null },
      select: { projectId: true, category: true, currentSubmissionId: true, approvedSubmissionId: true, deliveredAt: true },
    }),
    prisma.contentVideo.findMany({
      where: { projectId: { in: ids }, clientId: current.clientId, OR: [{ monthId: month.id }, { monthId: null }], filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" } },
      select: { id: true },
    }),
  ]);
  const briefs = await Promise.all(visible.map((p) => filmingBriefFor(p.id).catch(() => null)));
  return {
    enrollmentId: month.enrollmentId,
    monthKey: month.monthKey,
    allowance: month.videosOwed,
    allSessionsVisible,
    counts: allSessionsVisible ? monthOutputCounts(outputs, filmed.map((v) => v.id)) : null,
    sessions: visible.flatMap((p, index) => {
      const rows = briefs[index]?.rows ?? [];
      const topics = [...new Set(rows.map((r) => r.topicTitle).filter(Boolean))];
      const address = [p.addressLine, p.city, p.state].filter(Boolean).join(", ") || p.title;
      // One project may hold two Aryeo appointments. Both are visible, while
      // its outputs are counted once and no topic is guessed onto either leg.
      const appointments = p.appointments.length ? p.appointments : [{ id: null, startAt: p.shootDate }];
      return appointments.map((appointment, appointmentIndex) => ({
        key: `${p.id}:${appointment.id ?? "job"}`,
        id: p.id,
        appointmentIndex: appointmentIndex + 1,
        appointmentsOnJob: p.appointments.length,
        title: p.title,
        dateISO: appointment.startAt?.toISOString() ?? null,
        address,
        status: p.status,
        rawUrl: dropboxWebUrl(actualFolderPaths(p).rawVideo),
        topics,
        noTopicLinks: rows.length === 0 || rows.some((r) => !r.topicId),
        jobSlots: outputs.filter((o) => o.projectId === p.id && (o.category === "VIDEO" || o.category === "SOCIAL_REEL")).length,
      }));
    }),
    unlinkedClientJobs,
  };
}
