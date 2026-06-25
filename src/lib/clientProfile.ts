import "server-only";
import { prisma } from "@/lib/prisma";
import { etDate } from "@/lib/datetime";
import { synthesizeClientProfile, type ClientProfileInsights } from "@/lib/integrations/ai";

// The client "working profile": a creative-safe synthesis of who a client is to
// work with, drawn from comms, creatives' shoot debriefs, revision history,
// feedback, and the manual notes on file. Built on demand + nightly; stored on
// the Client so the client page (and the future creatives portal) can show it.

// Comms the creative team may see: CREATIVE + ADMIN tier, never OWNER-only.
const COMM_ROLES = ["CREATIVE", "ADMIN"];

export type ClientProfile = ClientProfileInsights & {
  stats: { totalOrders: number; revisions: number; inboundMsgs: number };
};

export async function buildClientProfile(clientId: string): Promise<{ ok: boolean; error?: string }> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true, name: true, company: true, segment: true, socialClient: true, socialPlan: true,
      clientPreferences: true, editingPreferences: true, generalNotes: true, brandColors: true,
      projects: {
        select: { id: true, title: true, status: true },
        orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: 40,
      },
    },
  });
  if (!client) return { ok: false, error: "Client not found." };

  const projectIds = client.projects.map((p) => p.id);
  const nonCancelled = client.projects.filter((p) => p.status !== "CANCELLED");

  const [comms, activities, feedback, revisions, inboundMsgs] = await Promise.all([
    prisma.commLog.findMany({
      where: { clientId, minRole: { in: COMM_ROLES } },
      orderBy: { occurredAt: "desc" }, take: 40,
      select: { direction: true, contactName: true, body: true, occurredAt: true },
    }),
    projectIds.length
      ? prisma.activity.findMany({
          where: { projectId: { in: projectIds }, type: { in: ["NOTE", "FLAG", "SPECIAL_REQUEST"] } },
          orderBy: { createdAt: "desc" }, take: 30,
          select: { body: true },
        })
      : Promise.resolve([] as { body: string }[]),
    projectIds.length
      ? prisma.feedback.findMany({
          where: { projectId: { in: projectIds } },
          orderBy: { createdAt: "desc" }, take: 12,
          select: { rating: true, sentiment: true, body: true },
        })
      : Promise.resolve([] as { rating: number | null; sentiment: string | null; body: string }[]),
    prisma.smartTask.count({ where: { clientId, taskType: "revision", status: { not: "CANCELLED" } } }),
    prisma.commLog.count({ where: { clientId, direction: "in", minRole: { in: COMM_ROLES } } }),
  ]);

  const stats = { totalOrders: nonCancelled.length, revisions, inboundMsgs };

  const insights = await synthesizeClientProfile({
    name: client.name,
    company: client.company,
    segment: client.segment,
    socialPlan: client.socialClient ? (client.socialPlan ?? "yes") : null,
    stats,
    sampleOrders: nonCancelled.slice(0, 8).map((p) => p.title),
    notes: {
      preferences: client.clientPreferences,
      editing: client.editingPreferences,
      general: client.generalNotes,
      brandColors: client.brandColors,
    },
    comms: comms
      .reverse()
      .map((c) => ({ who: c.direction === "out" ? "Us" : c.contactName || client.name, when: etDate(c.occurredAt), text: c.body || "" })),
    activities: activities.map((a) => a.body),
    feedback: feedback.map((f) => ({ rating: f.rating, sentiment: f.sentiment, text: f.body })),
  });

  if (!insights) return { ok: false, error: "Could not synthesize a profile (AI not connected, or not enough to go on yet)." };

  const profile: ClientProfile = { ...insights, stats };
  await prisma.client.update({
    where: { id: clientId },
    data: {
      profileSummary: insights.summary || null,
      profileJson: JSON.stringify(profile),
      profileUpdatedAt: new Date(),
    },
  });
  return { ok: true };
}

// Nightly: rebuild a bounded batch of missing/stale profiles for real clients
// (oldest first), so the creatives portal always has fresh context without a
// big one-time spend. Capped per run to keep AI cost predictable.
export async function refreshStaleClientProfiles(limit = 20): Promise<{ refreshed: number }> {
  const stale = await prisma.client.findMany({
    where: {
      parentClientId: null, // agents, not folded assistants
      transactionCount: { gt: 0 }, // only clients who've actually ordered
      OR: [
        { profileUpdatedAt: null },
        { profileUpdatedAt: { lt: new Date(Date.now() - 10 * 24 * 3600_000) } },
      ],
    },
    orderBy: [{ profileUpdatedAt: { sort: "asc", nulls: "first" } }],
    take: Math.min(limit, 60),
    select: { id: true },
  });
  let refreshed = 0;
  for (const c of stale) {
    try {
      const r = await buildClientProfile(c.id);
      if (r.ok) refreshed++;
    } catch {
      /* skip a single failure, keep going */
    }
  }
  return { refreshed };
}

export function parseClientProfile(json: string | null | undefined): ClientProfile | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ClientProfile;
  } catch {
    return null;
  }
}
