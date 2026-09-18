import "server-only";
import { prisma } from "@/lib/prisma";
// Type-only (erased at build) — this module hands notify.ts a target, it does
// not pull the bell's machinery in.
import type { NotifyTarget } from "@/lib/notify";

// ---------------------------------------------------------------------------
// "THE PHOTOGRAPHER ON THIS JOB" — one answer, in one place.
//
// Three files had already written this same ladder by hand (the cut-note lane
// in review/actions.ts, notifyProjectMessage in mentions.ts, and the shoot
// guard in lib/shoot.ts): the project's photographer of record, and when that
// column is empty, whoever the first assigned appointment belongs to. Sep 18
// gave the photographer a bell of their own for the Review Room, which would
// have been a fourth copy — and a fourth chance for two surfaces to disagree
// about whose job it is, which is exactly how somebody stops being told.
//
// MEASURED BEFORE IT WAS WRITTEN (live, Sep 18 2026): 1,507 of 1,583 projects
// carry a photographerId and ZERO of the remaining 76 have an appointment
// assignee either. So the appointment fallback resolves nothing today — it is
// kept because photographerOwnsShoot() has always honoured it, and a person
// who can OPEN a job's Review Room must be a person the bell can reach for it.
// The two tests are the same test or the feature is broken by construction.
// ---------------------------------------------------------------------------

/** Who shot this job: the photographer of record, else the assignee on its
 *  earliest assigned appointment. Null = nobody is on it (76 jobs live). */
export async function projectPhotographerId(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { photographerId: true } });
  if (p?.photographerId) return p.photographerId;
  const appt = await prisma.appointment.findFirst({
    where: { projectId, assignedToId: { not: null } },
    orderBy: { startAt: "asc" },
    select: { assignedToId: true },
  });
  return appt?.assignedToId ?? null;
}

/**
 * The bell's way of saying "the photographer on this job" — a person-addressed
 * NotifyTarget (tm:<id>), or null when there is nobody to address.
 *
 * Person-addressed on purpose: a role broadcast to PHOTOGRAPHER would ring
 * every photographer for every cut, and only a tm: row crosses the Slack/SMS
 * bridge, which is where their preference matrix and quiet hours live
 * (notify.ts bridgePerson). `href` is always supplied by the caller because
 * the office's default link is usually a page this person cannot open —
 * approveCut's is /projects/<id>, which a photographer is redirected off.
 *
 * Refuses an INACTIVE roster row: an off-boarded photographer is still the
 * photographer of record on hundreds of old jobs, and notifyProjectMessage
 * already learned to check (Sep 16). `skip` lets a caller drop the person who
 * caused the event — nobody is told about their own action.
 *
 * And it refuses the OWNER, which matters more here than it looks: Jordan is
 * PHOTOGRAPHER on the roster and the photographer of record on 712 of the
 * 1,583 live jobs. Addressing him as "the photographer" would mint a row whose
 * audience is ["PHOTOGRAPHER"] under an OWNER login — a bell row he cannot see
 * — beside the OWNER+ADMIN row that every one of these emitters already sends
 * him. notifyProjectMessage skips owners for the same reason (Sep 16).
 */
export async function photographerNotifyTarget(
  projectId: string,
  opts: { href: string; slackDm?: string; skipMemberId?: string | null },
): Promise<NotifyTarget | null> {
  const mid = await projectPhotographerId(projectId).catch(() => null);
  if (!mid || mid === opts.skipMemberId) return null;
  const owners = await (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]);
  if (owners.includes(mid)) return null;
  const member = await prisma.teamMember.findUnique({ where: { id: mid }, select: { active: true } }).catch(() => null);
  if (!member?.active) return null;
  return {
    // PHOTOGRAPHER alone, which also puts the row under notifyInApp's money
    // clamp — this person never sees a price, and the clamp is the single
    // place that is enforced rather than sixteen call sites remembering to.
    roles: ["PHOTOGRAPHER"],
    userKey: `tm:${mid}`,
    href: opts.href,
    ...(opts.slackDm ? { slackDm: opts.slackDm } : {}),
  };
}
