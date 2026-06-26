import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayKey } from "@/lib/datetime";
import { parseClientProfile, type ClientProfile } from "@/lib/clientProfile";
import { segmentMeta, type SegmentMeta } from "@/lib/segments";
import { phoneKey } from "@/lib/integrations/openphone";
import { ActivityType, type DeliverableType, type DeliverableStatus } from "@prisma/client";

// Data layer for the guided photographer experience (/shoot). Assembles one
// clean, serializable view model per shoot — appointment access brief, customer
// working profile, capture checklist, and (separately) the photographer's pay —
// while leaving every pricing/financial field OUT.

// Turn Aryeo's HTML/entity-mixed appointment brief into clean plain text.
export function cleanBrief(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;|&apos;/gi, "’")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const firstNameOf = (name?: string | null) => (name || "there").trim().split(/\s+/)[0] || "there";
const streetOf = (title?: string | null) => (title || "").split(",")[0].trim();

export type ShootDeliverable = {
  id: string;
  type: DeliverableType;
  label: string | null;
  quantity: number;
  status: DeliverableStatus;
  capturedAt: string | null;
  uploadCount: number;
};

export type ShootView = {
  project: {
    id: string;
    title: string;
    street: string;
    addressFull: string;
    mapsQuery: string;
    packageName: string | null;
    status: string;
    shootDateISO: string | null;
    editorBrief: string | null;
    uploadedAt: string | null;
    aryeoListingId: string | null; // for pulling captured media off Aryeo
  };
  appointment: {
    id: string;
    startISO: string | null;
    endISO: string | null;
    durationMin: number | null;
    status: string | null;
    completedAtISO: string | null;
    brief: string;
    assignedToName: string | null;
  } | null;
  extraAppointments: number; // additional non-canceled appointments beyond the primary
  client: {
    id: string;
    name: string;
    firstName: string;
    phone: string | null;
    phoneE164: string | null;
    email: string | null;
    socialClient: boolean;
    socialPlan: string | null;
    editingPreferences: string | null;
  };
  segment: SegmentMeta | null;
  profile: ClientProfile | null;
  deliverables: ShootDeliverable[];
  specialRequests: string[];
  flags: string[];
  photographer: { id: string; name: string } | null;
};

export async function getShoot(projectId: string): Promise<ShootView | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      client: true,
      photographer: { select: { id: true, name: true } },
      deliverables: {
        orderBy: { createdAt: "asc" },
        include: { uploads: { select: { id: true } } },
      },
      appointments: { orderBy: { startAt: "asc" }, include: { assignedTo: { select: { name: true } } } },
      activities: {
        where: { type: { in: [ActivityType.SPECIAL_REQUEST, ActivityType.FLAG] } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!p) return null;

  const liveAppts = p.appointments.filter((a) => (a.status ?? "").toUpperCase() !== "CANCELED");
  const primary = liveAppts[0] ?? p.appointments[0] ?? null;

  const addressFull = [p.addressLine, p.city, p.state, p.zip].filter(Boolean).join(", ") || p.title;
  const phone = p.client.phone ?? null;
  const k = phoneKey(phone);

  return {
    project: {
      id: p.id,
      title: p.title,
      street: streetOf(p.title) || addressFull,
      addressFull,
      mapsQuery: addressFull,
      packageName: p.packageName,
      status: p.status,
      shootDateISO: p.shootDate?.toISOString() ?? null,
      editorBrief: p.editorBrief,
      uploadedAt: p.uploadedAt?.toISOString() ?? null,
      aryeoListingId: p.aryeoListingId,
    },
    appointment: primary
      ? {
          id: primary.id,
          startISO: primary.startAt?.toISOString() ?? null,
          endISO: primary.endAt?.toISOString() ?? null,
          durationMin: primary.durationMin,
          status: primary.status,
          completedAtISO: primary.completedAt?.toISOString() ?? null,
          brief: cleanBrief(primary.description),
          assignedToName: primary.assignedTo?.name ?? null,
        }
      : null,
    extraAppointments: Math.max(liveAppts.length - 1, 0),
    client: {
      id: p.client.id,
      name: p.client.name,
      firstName: firstNameOf(p.client.name),
      phone,
      phoneE164: k.length === 10 ? `+1${k}` : null,
      email: p.client.email,
      socialClient: p.client.socialClient,
      socialPlan: p.client.socialPlan,
      editingPreferences: p.client.editingPreferences,
    },
    segment: segmentMeta(p.client.segment),
    profile: parseClientProfile(p.client.profileJson),
    deliverables: p.deliverables.map((d) => ({
      id: d.id,
      type: d.type,
      label: d.label,
      quantity: d.quantity,
      status: d.status,
      capturedAt: d.capturedAt?.toISOString() ?? null,
      uploadCount: d.uploads.length,
    })),
    specialRequests: p.activities.filter((a) => a.type === ActivityType.SPECIAL_REQUEST).map((a) => a.body),
    flags: p.activities.filter((a) => a.type === ActivityType.FLAG).map((a) => a.body),
    photographer: p.photographer,
  };
}

export type ShootEarnings = {
  configured: boolean; // pay rates set on the team page
  hasHome: boolean; // home address set (for mileage)
  shootPay: number;
  mileageShare: number;
  total: number;
  dayMiles: number | null;
  payableMiles: number | null;
  sharedJobs: number; // shoots that day splitting the mileage
  mileageRate: number;
};

// What the assigned photographer earns on THIS shoot — base shoot pay + their
// share of the day's drive mileage. Reuses the canonical payroll engine, scoped
// to one creative so a single shoot view doesn't route everyone's day.
export async function shootEarnings(projectId: string, memberId: string | null): Promise<ShootEarnings | null> {
  if (!memberId) return null;
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      shootDate: true,
      appointments: {
        where: { status: { not: "CANCELED" }, startAt: { not: null } },
        select: { startAt: true },
        orderBy: { startAt: "asc" },
      },
    },
  });
  const payDate = proj?.appointments[0]?.startAt ?? proj?.shootDate ?? null;
  if (!payDate) return null;

  const { computePayroll, payPeriodFor } = await import("@/lib/payroll");
  const period = payPeriodFor(etDayKey(payDate));
  const start = new Date(period.startKey + "T00:00:00.000Z");
  const end = new Date(period.endKey + "T23:59:59.999Z");

  let person;
  try {
    const people = await computePayroll(start, end, { memberId });
    person = people.find((x) => x.member.id === memberId);
  } catch {
    return null;
  }
  if (!person) return null;

  const job = person.jobs.find((j) => j.projectId === projectId);
  const day = job ? person.days.find((d) => d.dayKey === job.dayKey) : null;
  return {
    configured: person.configured,
    hasHome: person.hasHome,
    shootPay: job?.shootPay ?? 0,
    mileageShare: job?.mileageShare ?? 0,
    total: job?.jobTotal ?? 0,
    dayMiles: day?.miles ?? null,
    payableMiles: day?.payableMiles ?? null,
    sharedJobs: day?.jobs ?? 1,
    mileageRate: person.mileageRate,
  };
}

export type MyShootRow = {
  id: string;
  title: string;
  street: string;
  whenISO: string | null;
  status: string;
  clientName: string;
  clientFirst: string;
  deliverableTypes: DeliverableType[];
  uploaded: boolean;
  completed: boolean;
  photographerName: string | null;
};

// A photographer's shoots (or all, for owner/admin previews): recent + upcoming,
// soonest-relevant first. `memberId = null` = no scoping (owner/admin view).
export async function listMyShoots(memberId: string | null): Promise<MyShootRow[]> {
  const since = new Date(Date.now() - 21 * 86400000); // last 3 weeks + everything ahead
  const rows = await prisma.project.findMany({
    where: {
      status: { not: "CANCELLED" },
      shootDate: { gte: since },
      ...(memberId
        ? { OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId } } }] }
        : {}),
    },
    include: {
      client: { select: { name: true } },
      photographer: { select: { name: true } },
      deliverables: { select: { type: true } },
      appointments: {
        where: { status: { not: "CANCELED" }, startAt: { not: null } },
        select: { startAt: true, completedAt: true },
        orderBy: { startAt: "asc" },
        take: 1,
      },
    },
    orderBy: { shootDate: "asc" },
    take: 100,
  });

  return rows.map((p) => {
    const appt = p.appointments[0];
    const when = appt?.startAt ?? p.shootDate;
    return {
      id: p.id,
      title: p.title,
      street: streetOf(p.title) || p.title,
      whenISO: when?.toISOString() ?? null,
      status: p.status,
      clientName: p.client.name,
      clientFirst: firstNameOf(p.client.name),
      deliverableTypes: Array.from(new Set(p.deliverables.map((d) => d.type))),
      uploaded: p.uploadedAt != null,
      completed: appt?.completedAt != null,
      photographerName: p.photographer?.name ?? null,
    };
  });
}
