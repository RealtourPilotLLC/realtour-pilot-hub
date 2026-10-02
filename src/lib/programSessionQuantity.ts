import "server-only";
import { prisma } from "@/lib/prisma";
import { planSessions } from "@/lib/programMonths";
import type { SessionMatchKind } from "@/lib/sessionRequests";

// The reconciliation writer's canonical vocabulary, plus its explicit desk
// and moved-booking branches. CONTENT_EVIDENCE remains a legacy spelling;
// every entry still requires the exact current identity checks below.
const CONFIRMED_MATCH_STATES = {
  PROVIDER_ID: true, PROVIDER_ORDER: true, MONTH_LINK: true, CONTENT_DELIVERABLE: true,
  STAFF: true, MOVED: true, CONTENT_EVIDENCE: true,
} satisfies Record<SessionMatchKind | "STAFF" | "MOVED" | "CONTENT_EVIDENCE", true>;

/** A month label describes the whole allowance. Only an exact, current
 * confirmed request can prove that a particular job owes one session's part.
 * Missing/ambiguous legacy evidence returns no exception; failed reads throw
 * so a caller must not silently turn unavailable evidence into a quota lift. */
export async function confirmedProgramSessionQuantities(projectIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!projectIds.length) return out;
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds }, contentMonthId: { not: null } },
    select: { id: true, clientId: true, contentMonthId: true, aryeoOrderId: true,
      appointments: { select: { aryeoId: true, status: true, startAt: true, postponedAt: true } } },
  });
  if (!projects.length) return out;
  const [requests, months] = await Promise.all([
    prisma.programSessionRequest.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, status: { notIn: ["CANCELLED", "DECLINED", "EXPIRED"] } },
      select: { id: true, projectId: true, clientId: true, enrollmentId: true, monthId: true,
        kind: true, sessionIndex: true, status: true, confirmedAt: true, cancelledAt: true,
        matchState: true, bookingState: true, pendingChangeJson: true,
        aryeoAppointmentId: true, aryeoOrderId: true, slotStart: true },
    }),
    prisma.contentMonth.findMany({
      where: { id: { in: projects.map((p) => p.contentMonthId!) } },
      select: { id: true, clientId: true, enrollmentId: true, videosOwed: true },
    }),
  ]);
  if (!requests.length) return out;
  const [enrollments, replacements] = await Promise.all([
    prisma.contentEnrollment.findMany({
      where: { id: { in: months.map((m) => m.enrollmentId) } },
      select: { id: true, clientId: true, videosPerMonth: true, sessionsPerMonth: true },
    }),
    prisma.programSessionRequest.findMany({
      where: { supersedesId: { in: requests.map((r) => r.id) }, status: { notIn: ["CANCELLED", "DECLINED", "EXPIRED"] } },
      select: { supersedesId: true },
    }),
  ]);
  const superseded = new Set(replacements.map((r) => r.supersedesId));
  for (const project of projects) {
    const bound = requests.filter((r) => r.projectId === project.id);
    // Two live bindings are evidence to resolve, never permission to select
    // whichever smaller session happens to appear first in the query.
    if (bound.length !== 1) continue;
    const r = bound[0], month = months.find((m) => m.id === project.contentMonthId);
    const enrollment = month && enrollments.find((e) => e.id === month.enrollmentId);
    if (!month || !enrollment || enrollment.sessionsPerMonth <= 1 ||
      r.kind !== "CONTENT_SESSION" || r.status !== "CONFIRMED" || !r.confirmedAt || r.cancelledAt ||
      r.bookingState === "CONFLICT" || r.pendingChangeJson || superseded.has(r.id) ||
      !Object.hasOwn(CONFIRMED_MATCH_STATES, r.matchState ?? "") ||
      r.monthId !== month.id || r.enrollmentId !== enrollment.id ||
      r.clientId !== project.clientId || month.clientId !== project.clientId || enrollment.clientId !== project.clientId ||
      (r.aryeoOrderId && r.aryeoOrderId !== project.aryeoOrderId) ||
      !r.aryeoAppointmentId || !r.slotStart) continue;
    const appointment = project.appointments.find((a) => a.aryeoId === r.aryeoAppointmentId);
    if (!appointment || appointment.postponedAt || /cancel|postpon/i.test(appointment.status ?? "") ||
      appointment.startAt?.getTime() !== r.slotStart.getTime()) continue;
    const planned = planSessions([], {
      videosPerMonth: month.videosOwed > 0 ? month.videosOwed : enrollment.videosPerMonth,
      sessionsPerMonth: enrollment.sessionsPerMonth,
    }).find((s) => s.index === r.sessionIndex)?.plannedVideos;
    if (planned && Number.isInteger(planned) && planned > 0) out.set(project.id, planned);
  }
  return out;
}

/** Explicit custom sold counts still outrank a proved per-session allowance. */
export function sessionQuantityFloor(names: (string | null | undefined)[], planned: number): number {
  const stated = names.map((name) => /(\d{1,2})\s+videos?\b/i.exec(name ?? "")?.[1])
    .filter(Boolean).map(Number).filter((n) => n > 0 && n <= 60);
  return Math.max(planned, ...stated);
}
