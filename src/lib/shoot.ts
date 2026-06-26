import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayStartUtc, etTime } from "@/lib/datetime";
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

// The shoot brief, parsed from Aryeo's "Order Questions" block into the few
// fields a photographer actually needs on-site. Aryeo's format is consistent:
//   Order Questions:
//    - Lock Box / Door Code: 1923
//    - Additional information to access the property: ...
//    - Special Instructions for the photographer (for this property only): ...
//    - Will you or the seller be present at the appointment?: Vacant
//    - Is the time of the appointment flexible on the requested day?: ...
export type ShootBrief = {
  lockbox: string | null;
  access: string | null;
  presence: string | null;
  special: string | null;
  timing: string | null;
  orderNotes: string | null;
  extra: { label: string; value: string }[];
};

const isBlank = (v: string) => !v || /^n\/?a$/i.test(v.trim());

export function parseShootBrief(text: string): ShootBrief | null {
  if (!text) return null;
  const out: ShootBrief = { lockbox: null, access: null, presence: null, special: null, timing: null, orderNotes: null, extra: [] };

  // "Order Notes:" value (the block before "Order Questions:").
  const on = text.match(/Order Notes:\s*\n+([\s\S]*?)(?:\n\s*\n|Order Questions:|Or View Full)/i);
  if (on && !isBlank(on[1])) out.orderNotes = on[1].trim();

  // Parse ONLY the "Order Questions:" block (between that header and the order
  // link) so order-item / customer lines — which also look like "- Key: Value" —
  // don't get scooped up as questions.
  const qSection = text.split(/Order Questions:/i)[1]?.split(/Or View Full Order Details/i)[0] ?? "";
  for (const line of qSection.split("\n")) {
    const m = line.match(/^\s*[-•]\s+(.+?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (isBlank(val)) continue;
    if (/present at the appointment|seller be present/i.test(key)) out.presence = val;
    else if (/lock\s*box|door\s*code/i.test(key)) out.lockbox = val;
    else if (/access the property|additional information to access/i.test(key)) out.access = val;
    else if (/special instructions/i.test(key)) out.special = val;
    else if (/flexible/i.test(key)) out.timing = val;
    else if (/waitlist|square footage/i.test(key)) continue; // internal noise
    else out.extra.push({ label: key.replace(/\s*\(for this property only\)/i, ""), value: val });
  }

  const any = out.lockbox || out.access || out.presence || out.special || out.timing || out.orderNotes || out.extra.length;
  return any ? out : null;
}

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
    brief: string; // raw cleaned text (fallback)
    parsed: ShootBrief | null; // structured fields for a nice render
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
      ? (() => {
          const cleaned = cleanBrief(primary.description);
          return {
            id: primary.id,
            startISO: primary.startAt?.toISOString() ?? null,
            endISO: primary.endAt?.toISOString() ?? null,
            durationMin: primary.durationMin,
            status: primary.status,
            completedAtISO: primary.completedAt?.toISOString() ?? null,
            brief: cleaned,
            parsed: parseShootBrief(cleaned),
            assignedToName: primary.assignedTo?.name ?? null,
          };
        })()
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

  // Scope payroll to JUST this shoot's ET day, not the whole 14-day pay period.
  // The per-job numbers (shoot pay + that day's mileage share) are identical, but
  // we route one day instead of fourteen — the difference between a snappy page
  // and a multi-second OSRM stall. MileageDay caching makes repeat loads instant.
  const { computePayroll } = await import("@/lib/payroll");
  const start = etDayStartUtc(payDate);
  const end = new Date(start.getTime() + 86400000 - 1);

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

// The TeamMember a logged-in user shoots as — their AppUser link, or an email
// match against the photographer roster as a fallback. Used to scope a
// photographer to only their own shoots. Returns null when unresolvable (callers
// fail CLOSED: a photographer we can't place sees no shoots, never everyone's).
export async function photographerMemberId(user: { teamMemberId: string | null; email: string } | null): Promise<string | null> {
  if (!user) return null;
  if (user.teamMemberId) return user.teamMemberId;
  const tm = await prisma.teamMember.findFirst({
    where: { email: { equals: user.email, mode: "insensitive" } },
    select: { id: true },
  });
  return tm?.id ?? null;
}

// Is this shoot assigned to this photographer (as the project's photographer OR
// the assignee on one of its appointments)?
export async function photographerOwnsShoot(projectId: string, memberId: string): Promise<boolean> {
  const n = await prisma.project.count({
    where: { id: projectId, OR: [{ photographerId: memberId }, { appointments: { some: { assignedToId: memberId } } }] },
  });
  return n > 0;
}

export type ShootMapPin = { lat: number; lng: number; label: string; time: string | null; current: boolean };
export type ShootMapData = {
  pins: ShootMapPin[];
  home: { lat: number; lng: number } | null;
  route: [number, number][]; // road geometry (or straight-line fallback) for the day
};

// Map data for the shoot screen: this shoot + the photographer's OTHER shoots
// that same day, ordered by time, plus the home base and the driving route
// through them. Returns null if this shoot has no map location.
export async function getShootMapData(projectId: string, memberId: string | null): Promise<ShootMapData | null> {
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, lat: true, lng: true, shootDate: true,
      appointments: { where: { status: { not: "CANCELED" }, startAt: { not: null } }, select: { startAt: true }, orderBy: { startAt: "asc" } },
    },
  });
  if (!proj || proj.lat == null || proj.lng == null) return null;
  const thisTime = proj.appointments[0]?.startAt ?? proj.shootDate ?? null;

  type DayProj = { id: string; title: string; lat: number | null; lng: number | null; startAt: Date | null };
  let dayProjects: DayProj[] = [];
  let home: { lat: number; lng: number } | null = null;

  if (memberId && thisTime) {
    const dayStart = etDayStartUtc(thisTime);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const [rows, member] = await Promise.all([
      prisma.project.findMany({
        where: {
          photographerId: memberId, status: { not: "CANCELLED" }, lat: { not: null }, lng: { not: null },
          OR: [
            { appointments: { some: { startAt: { gte: dayStart, lt: dayEnd }, status: { not: "CANCELED" } } } },
            { shootDate: { gte: dayStart, lt: dayEnd } },
          ],
        },
        select: {
          id: true, title: true, lat: true, lng: true, shootDate: true,
          appointments: { where: { startAt: { gte: dayStart, lt: dayEnd }, status: { not: "CANCELED" } }, select: { startAt: true }, orderBy: { startAt: "asc" }, take: 1 },
        },
      }),
      prisma.teamMember.findUnique({ where: { id: memberId }, select: { homeLat: true, homeLng: true } }),
    ]);
    dayProjects = rows.map((r) => ({ id: r.id, title: r.title, lat: r.lat, lng: r.lng, startAt: r.appointments[0]?.startAt ?? r.shootDate ?? null }));
    if (member?.homeLat != null && member?.homeLng != null) home = { lat: member.homeLat, lng: member.homeLng };
  }

  if (!dayProjects.some((d) => d.id === proj.id)) {
    dayProjects.push({ id: proj.id, title: proj.title, lat: proj.lat, lng: proj.lng, startAt: thisTime });
  }
  dayProjects.sort((a, b) => (a.startAt?.getTime() ?? 0) - (b.startAt?.getTime() ?? 0));

  const pins: ShootMapPin[] = dayProjects
    .filter((d) => d.lat != null && d.lng != null)
    .map((d) => ({ lat: d.lat!, lng: d.lng!, label: streetOf(d.title) || d.title, time: d.startAt ? etTime(d.startAt) : null, current: d.id === proj.id }));

  const linePts = [...(home ? [home] : []), ...pins.map((p) => ({ lat: p.lat, lng: p.lng })), ...(home ? [home] : [])];
  let route: [number, number][] = [];
  if (linePts.length >= 2) {
    const { dayRouteGeometry } = await import("@/lib/travel");
    route = (await dayRouteGeometry(linePts)) ?? linePts.map((p) => [p.lat, p.lng] as [number, number]);
  }

  return { pins, home, route };
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
  const since = new Date(Date.now() - 60 * 86400000); // last ~2 months + everything ahead (for the calendar)
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
    take: 250,
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
