import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findUnansweredInbound } from "@/lib/commsSla";
import { TRIAGE_TYPES, boardVisibleWhere } from "@/lib/triage";
import { listAssignees, slugForName, viewerAssigneeKey, assigneeName, type Assignee } from "@/lib/assignees";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/user";
import { cleanEmailBody } from "@/lib/commsBoard";
import { isMonthlyContentJob, monthlyVideoQuota } from "@/lib/pipeline";
import { cleanBrief, parseShootBrief } from "@/lib/shoot";
import { NOTHING_TO_REMOVE_SENTINEL, isFieldFlag } from "@/lib/debrief";
import { actionableQcCount, nextPendingDue } from "@/lib/tasks";
import { turnaroundRules } from "@/lib/settings";
import type { StatusEvidence } from "@/lib/projectStatus";
import { videoStatesFor, videoReviewBoard, type ProjectVideoState, type VideoCutState } from "@/lib/reviewCuts";

// ---------------------------------------------------------------------------
// Kyle's Ops Day (Jordan's "Daily Operations & Client Experience Structure",
// Sep 1 2026; v2 per his block-by-block notes) — the data behind the guided
// screen, from the SAME sources the rest of the hub reads.
// ---------------------------------------------------------------------------

const ET = "America/New_York";

function etDayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: ET });
}
function etDayWindow(offsetDays: number): { start: Date; end: Date; key: string } {
  // DST-safe for ordinary days (offset resolved at the target day's noon).
  // Known accepted edges (review): on the two transition nights a shoot
  // timestamped 11 PM–1 AM can fall in the wrong/both windows — real shoots
  // never book those hours and the windows self-correct on the next render.
  const key = new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: ET });
  const noonUtc = new Date(`${key}T12:00:00Z`);
  const etHourAtNoon = Number(noonUtc.toLocaleString("en-US", { timeZone: ET, hour: "numeric", hour12: false }));
  const start = new Date(`${key}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + (12 - etHourAtNoon));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end, key };
}

// ---- The Aryeo appointment brief, parsed into labeled fields ----------------
export type AccessInfo = {
  name: string | null; email: string | null; phone: string | null;
  /** the customer-level "Notes:" — a standing client preference, NOT access info */
  notes: string | null;
  // The ON-SITE fields live AFTER "Order Items" in Aryeo's brief, inside the
  // Order Questions block — the old parser stopped at "Order Items" and threw
  // all of it away, so Kyle's card showed no door code while the photographer's
  // /shoot screen showed it fine (audit HIGH: 4 upcoming shoots lost a real
  // code, one of them today). Same parser as /shoot now — one source of truth.
  lockbox: string | null; access: string | null; presence: string | null;
  special: string | null; orderNotes: string | null;
};

export function parseAccessBrief(raw: string | null): AccessInfo {
  const EMPTY: AccessInfo = { name: null, email: null, phone: null, notes: null, lockbox: null, access: null, presence: null, special: null, orderNotes: null };
  if (!raw?.trim()) return EMPTY;
  const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const grab = (re: RegExp) => text.match(re)?.[1]?.trim() || null;
  const name = grab(/Name:\s*(.*?)(?=\s*(?:Email:|Phone:|Notes:|Order Items|$))/i);
  const email = grab(/Email:\s*(\S+@\S+)/i);
  const phone = grab(/Phone:\s*([()\d\s+.-]{7,20})/i);
  let notes = grab(/Notes:\s*(.*?)(?=\s*Order Items|$)/i);
  if (notes && /^n\/?a$/i.test(notes)) notes = null;
  // Anything typed BEFORE the first label (often the lockbox code itself)
  // must not vanish — fold it into notes. A dangling label word ("Customer:")
  // is structure, not content — drop it.
  const firstLabel = text.search(/(?:Customer|Contact|Name|Email|Phone|Notes|Order Items):/i);
  const leftover = firstLabel > 0 ? text.slice(0, firstLabel).trim() : "";
  // Only KNOWN label words are structure — a short real note ("Dogs inside",
  // "Use side door") must survive (review: the old any-short-string filter ate
  // those). Bare "Contact"/"Customer" fragments of compound labels still drop.
  if (leftover && !/^(?:Customer|Contact|Name|Email|Phone|Notes|Order(?: Items)?)(?: (?:Name|Info))?\s*:?$/i.test(leftover)) {
    notes = notes ? `${leftover} — ${notes}` : leftover;
  }
  const b = parseShootBrief(cleanBrief(raw));
  // A blob that doesn't match the Aryeo format at all → keep it whole as notes.
  if (!name && !email && !phone && !notes && !b) notes = text.slice(0, 300);
  const clip = (v: string | null | undefined) => (v ? v.slice(0, 300) : null);
  return {
    name, email, phone,
    notes: clip(notes),
    lockbox: clip(b?.lockbox), access: clip(b?.access), presence: clip(b?.presence),
    special: clip(b?.special), orderNotes: clip(b?.orderNotes),
  };
}

// ---- Weather at the shoot hour (Open-Meteo, keyless; cached 30 min) ---------
export type ShootWeather = { tempF: number; precipPct: number; windMph: number };

async function weatherFor(lat: number, lng: number, atISO: string): Promise<ShootWeather | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
      `&hourly=temperature_2m,precipitation_probability,wind_speed_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=America%2FNew_York`;
    const res = await fetch(url, { next: { revalidate: 1800 }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { hourly?: { time: string[]; temperature_2m: number[]; precipitation_probability: number[]; wind_speed_10m: number[] } };
    if (!j.hourly?.time?.length) return null;
    // Match the shoot's ET hour ("YYYY-MM-DDTHH:00" in the API's local time).
    const target = new Date(atISO).toLocaleString("sv-SE", { timeZone: ET }).slice(0, 13).replace(" ", "T") + ":00";
    const i = j.hourly.time.indexOf(target);
    if (i === -1 || j.hourly.temperature_2m?.[i] == null) return null;
    return {
      tempF: Math.round(j.hourly.temperature_2m[i]),
      precipPct: Math.round(j.hourly.precipitation_probability[i] ?? 0),
      windMph: Math.round(j.hourly.wind_speed_10m[i] ?? 0),
    };
  } catch {
    return null;
  }
}

// ---- FAA UAS Facility Map grid ceiling (drone jobs; best-effort) ------------
// The shoot card's airspace answer comes from the SHARED FAA module
// (src/lib/faa.ts droneAirspace) — the free, keyless FAA UAS Facility Map that
// the drone advisory already uses. Ops Day used to carry its own thinner copy
// of the same query and fell back to a "check airspace" link, which made Kyle
// do by hand what the API already answers (Jordan, Sep 1).
export type Airspace = {
  /** clear = Class G · laanc = controlled, auto-auth to a ceiling · restricted = 0 ft grid */
  status: "clear" | "laanc" | "restricted";
  ceilingFt: number | null;
  airport: string | null;
  airspaceClass: string | null;
  warning: boolean;
  /** false = the FAA lookup failed; "couldn't check" is never "clear" */
  available: boolean;
};

async function airspaceFor(lat: number, lng: number): Promise<Airspace> {
  const { droneAirspace } = await import("@/lib/faa");
  const a = await droneAirspace(lat, lng);
  return {
    status: a.status,
    ceilingFt: a.ceiling,
    airport: a.airport,
    airspaceClass: a.airspaceClass,
    warning: a.warning,
    available: a.available,
  };
}

// ---- Types ------------------------------------------------------------------
export type OpsShoot = {
  id: string;
  title: string;
  timeISO: string | null;
  photographer: string | null;
  services: string[];
  clientName: string;
  access: AccessInfo;
  specialRequests: string[];
  gaps: string[];
  videoOrdered: boolean;
  droneOrdered: boolean;
  debriefSubmitted: boolean;
  aryeoListingId: string | null;
  weather: ShootWeather | null;
  airspace: Airspace | null; // drone jobs only
  comms: { count: number; latestSnippet: string; latestAgoH: number; latestInbound: boolean; otherCount: number } | null;
};

export type QcEvidence = {
  present: string[];
  missing: string[];
  /** stale = this pass couldn't read Dropbox; counts are the last good read (at) */
  dropbox: { rawPhotos: number; rawVideo: number; finalPhotos: number; finalVideo: number; at?: string; stale?: boolean } | null;
};

export type OpsQcRow = {
  taskId: string;
  projectId: string;
  title: string;
  clientName: string | null;
  photographer: string | null;
  shootISO: string | null;
  services: string[];
  aryeoListingId: string | null;
  itemsLeft: number;
  /** of those, the ones Kyle can actually do now — the media is live (see
   *  actionableQcCount). The rest are rows waiting on media to land. */
  actionable: number;
  /** the JOB's promise — the LATEST pending deliverable. Drives "overdue". */
  dueISO: string | null;
  /** the next thing we OWE and when — what makes a card due today. */
  nextDueISO: string | null;
  nextDueCategories: string[];
  bucket: "overdue" | "today" | "waiting";
  evidence: QcEvidence;
  /** The photographer's upload-portal wrap-up, verbatim and untruncated — every
   *  field EXCEPT the video editing brief, which lives on /edit for the editor
   *  (Jordan, Sep 1: "the notes from the upload portal, not video editing
   *  notes, should be fully shown in each QC card"). */
  debrief: {
    shotOrder: string | null;
    removals: string | null;
    /** the photographer confirmed "nothing needs removal" (vs. never answered) */
    nothingToRemove: boolean;
    culled: boolean;
    editorBrief: string | null;
    /** "Flag a problem" entries from the wrap-up, newest first */
    flags: string[];
    /** per-deliverable notes typed on the wrap-up */
    itemNotes: { label: string; note: string }[];
    videosFilmed: number | null;
    videoBrief: boolean;
    unsubmitted: boolean;
  };
  /** items the photographer marked "couldn't complete" on the wrap-up, with why */
  notCompleted: { label: string; reason: string }[];
  /** monthly personal-branding content — its own card, not the listing QC pile
   *  (Jordan, Sep 1): different rhythm, different turnaround, batch delivery. */
  monthly: boolean;
  /** how many videos the batch owes (photographer's count, else the plan quota) */
  videosOwed: number | null;
  /** where the job's video is — editing / waiting on review / in revisions /
   *  approved — for shoots that ordered one (Jordan, Sep 1: "in morning QC I'd
   *  like to see the video status for shoots that have video"). null = no video. */
  video: ProjectVideoState | null;
};

export type PipelineRow = {
  projectId: string;
  title: string;
  status: string; // EDITING | REVIEW | REVISION
  clientName: string | null;
  services: string[];
  editor: string | null;
  sent: string[]; // delivered categories
  waitingOn: string[]; // missing categories
  videoDueISO: string | null;
  videoOverdue: boolean;
  revision: { headline: string | null; items: string[] } | null;
};

export type OpsLoop = {
  taskId: string;
  title: string;
  summary: string | null;
  dueISO: string | null;
  overdue: boolean;
  /** overdue, or promised today (ET) — the rows that need a move now */
  actNow: boolean;
  projectId: string | null;
  projectTitle: string | null;
  kind: "comms_followup" | "internal_instruction" | "callback" | "client_reply" | string;
  /** who the loop is FOR: an assignee key ("kyle"), OWNER_LANE, or OPS_LANE */
  lane: string;
  /** the viewer's own plate — their lane, or the shared ops pile */
  mine: boolean;
  /** the person it sits with, when that isn't the viewer ("Kim") */
  withWhom: string | null;
};

export type OpsDay = {
  nowISO: string;
  todayShoots: OpsShoot[];
  tomorrowShoots: OpsShoot[];
  unanswered: { count: number; oldestHours: number | null; preview: { name: string; snippet: string; hours: number }[] };
  qc: OpsQcRow[];
  pipeline: { rows: PipelineRow[]; editing: number; review: number; revision: number; overdueTasks: number; dueTodayTasks: number };
  openLoops: OpsLoop[];
  /** The same list, counted — so a header can say "14 loops, none of them
   *  yours" instead of a bare 0, and only claim "+" when it was truly cut off.
   *  Carried as a field (not read off the array) so it survives serialisation
   *  into a client component. */
  openLoopsTally: LoopsTally;
  /** every uploaded cut awaiting a verdict / back with its editor — the Ops Day
   *  "Video Review" block and the owner Dashboard card read the same list. */
  videoReview: { waiting: VideoCutState[]; revising: VideoCutState[] };
  needsAssigning: number;
  closeout: {
    todayShootsDone: boolean;
    todayDebriefsIn: number;
    todayDebriefsMissing: number;
    tomorrowGaps: number;
    unanswered: number;
    openQc: number;
    openRevisions: number;
  };
};

const DEBRIEF_GATE = Date.parse("2026-09-02T00:00:00-04:00");

const SHOOT_SELECT = {
  id: true, title: true, shootDate: true, debriefSubmittedAt: true,
  lat: true, lng: true, aryeoListingId: true, clientId: true,
  photographer: { select: { name: true } },
  client: { select: { name: true } },
  deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
  activities: { where: { type: "SPECIAL_REQUEST" as const }, select: { type: true, body: true } },
  appointments: { select: { description: true } },
} as const;

type ShootRowInput = {
  id: string; title: string; shootDate: Date | null; debriefSubmittedAt: Date | null;
  lat: number | null; lng: number | null; aryeoListingId: string | null; clientId: string | null;
  photographer: { name: string } | null;
  client: { name: string };
  deliverables: { type: string; label: string | null }[];
  activities: { type: string; body: string }[];
  appointments: { description: string | null }[];
};

// One recent-comms row, as pulled for the shoot cards.
type ShootCommRow = { projectId: string | null; projectGuess: boolean; channel: string; direction: string; subject: string | null; body: string; occurredAt: Date };

// A glanceable one-liner for the shoot card's comms chip. Email bodies carry
// signature junk ("[image: …]", quoted history) — clean them the same way the
// comms board does, falling back to the subject when nothing readable is left.
function shootCommSnippet(r: ShootCommRow): string {
  const text =
    r.channel === "email"
      ? cleanEmailBody(r.body ?? "") || (r.subject ?? "").trim() || "(image/attachment)"
      : (r.body ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, 110);
}

async function shootRow(
  p: ShootRowInput,
  commRows: Map<string, ShootCommRow[]>,
  now: Date,
): Promise<OpsShoot> {
  const services = [...new Set(p.deliverables.map((d) => d.label ?? d.type))];
  const videoOrdered = p.deliverables.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
  const droneOrdered = p.deliverables.some((d) => d.type === "DRONE");
  const special = p.activities.filter((a) => a.type === "SPECIAL_REQUEST").map((a) => a.body);
  const rawBrief = p.appointments.map((a) => a.description?.trim()).find(Boolean) ?? null;
  const access = parseAccessBrief(rawBrief);
  const gaps: string[] = [];
  if (!p.photographer) gaps.push("no photographer assigned");
  // Content, not existence: a 1,200-character brief with every access field
  // blank used to pass, so /ops promised "every shoot assigned with access
  // notes on file" while the cards showed none (audit).
  if (!access.lockbox && !access.access && !access.presence && !access.special && !access.orderNotes && !access.notes) {
    gaps.push("no lockbox / access answer on the appointment");
  }
  if (p.deliverables.length === 0) gaps.push("no services on the order");
  const [weather, airspace] = await Promise.all([
    p.lat != null && p.lng != null && p.shootDate ? weatherFor(p.lat, p.lng, p.shootDate.toISOString()) : Promise.resolve(null),
    droneOrdered && p.lat != null && p.lng != null ? airspaceFor(p.lat, p.lng) : Promise.resolve(null),
  ]);
  // Only comms about THIS shoot. A message filed to a DIFFERENT job by a
  // NAMED street match stays on that job — Jordan: Renee's 775 Scotch Way
  // email must not show on her 208 N Adams card. But the routers file every
  // known-client message to SOME job (review: 0 of 422 recent rows were
  // unfiled), so a heuristic guess (projectGuess) is NOT proof it's about the
  // other job — a shoot-eve "gate code changed" with no street would be
  // guessed onto an old job and must stay visible here. Named-elsewhere rows
  // still surface as a muted "+N on other jobs" count, never silently hidden.
  const clientRows = p.clientId ? commRows.get(p.clientId) ?? [] : [];
  const mine = clientRows.filter((r) => r.projectId === p.id || r.projectId == null || r.projectGuess);
  const otherCount = clientRows.length - mine.length;
  const latest = mine[0] ?? null; // rows are newest-first
  return {
    id: p.id,
    title: p.title.split(",")[0],
    timeISO: p.shootDate?.toISOString() ?? null,
    photographer: p.photographer?.name ?? null,
    services,
    clientName: p.client.name,
    access,
    specialRequests: special,
    gaps,
    videoOrdered,
    droneOrdered,
    debriefSubmitted: !!p.debriefSubmittedAt,
    aryeoListingId: p.aryeoListingId,
    weather,
    airspace,
    comms: latest || otherCount > 0
      ? {
          count: mine.length,
          latestSnippet: latest ? shootCommSnippet(latest) : "",
          latestAgoH: latest ? Math.max(0, Math.round((now.getTime() - latest.occurredAt.getTime()) / 3_600_000)) : 0,
          latestInbound: latest?.direction === "in",
          otherCount,
        }
      : null,
  };
}

function parseEvidence(json: string | null): { ev: StatusEvidence | null; qc: QcEvidence } {
  try {
    const ev = json ? (JSON.parse(json) as StatusEvidence) : null;
    return {
      ev,
      qc: {
        present: ev?.present ?? [],
        missing: ev?.missing ?? [],
        dropbox: ev?.dropbox ?? null,
      },
    };
  } catch {
    return { ev: null, qc: { present: [], missing: [], dropbox: null } };
  }
}

export async function buildOpsDay(): Promise<OpsDay> {
  const now = new Date();
  const today = etDayWindow(0);
  const tomorrow = etDayWindow(1);

  const [todayProjects, tomorrowProjects, qcTasks, loopTasks, pipelineProjects, pipelineCounts, unansweredList, needsAssigningCount] =
    await Promise.all([
      prisma.project.findMany({
        where: { shootDate: { gte: today.start, lt: today.end }, status: { notIn: ["CANCELLED", "ON_HOLD"] } },
        select: SHOOT_SELECT,
        orderBy: { shootDate: "asc" },
      }),
      prisma.project.findMany({
        where: { shootDate: { gte: tomorrow.start, lt: tomorrow.end }, status: { notIn: ["CANCELLED", "ON_HOLD"] } },
        select: SHOOT_SELECT,
        orderBy: { shootDate: "asc" },
      }),
      prisma.smartTask.findMany({
        where: {
          taskType: "media_qa",
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          // Orphan media_qa rows (null project) exist — the Review Room handles
          // them; Kyle's home page must not render dead /projects/null links.
          project: { is: { status: { notIn: ["CANCELLED", "ON_HOLD"] }, aryeoMissingAt: null } },
        },
        select: {
          id: true, title: true, dueAt: true, checklist: true, projectId: true,
          project: {
            select: {
              title: true, shootDate: true, shotOrderNotes: true, removalNotes: true, videoInstructions: true,
              debriefSubmittedAt: true, statusEvidence: true, aryeoListingId: true,
              photographer: { select: { name: true } },
              deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, notCompletedReason: true, notes: true } },
              packageName: true,
              videosFilmed: true,
              // The rest of the photographer's wrap-up. Jordan (Sep 1): every
              // upload-portal note except the video editing brief belongs on
              // the QC card, in full — QC is where those notes get acted on.
              editorBrief: true,
              cullingConfirmedAt: true,
              activities: {
                where: { type: "FLAG" as const },
                select: { body: true },
                orderBy: { createdAt: "desc" as const },
                take: 10,
              },
              client: { select: { name: true } },
            },
          },
        },
        orderBy: { dueAt: "asc" },
        take: 30,
      }),
      openLoopsList(now),
      prisma.project.findMany({
        where: { status: { in: ["EDITING", "REVIEW", "REVISION"] } },
        select: {
          id: true, title: true, status: true, statusEvidence: true,
          client: { select: { name: true } },
          deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true } },
          editor: { select: { name: true } },
          revisionBriefs: { orderBy: { createdAt: "desc" }, take: 1, select: { headline: true, itemsJson: true } },
        },
        orderBy: { updatedAt: "asc" },
        take: 25,
      }),
      Promise.all([
        prisma.project.count({ where: { status: "EDITING" } }),
        prisma.project.count({ where: { status: "REVIEW" } }),
        prisma.project.count({ where: { status: "REVISION" } }),
        // Scoped to what the destination (/tasks?tab=other) actually shows —
        // an unscoped count read "14 overdue" while the tab hid most (review).
        prisma.smartTask.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] }, dueAt: { lt: now }, AND: [boardVisibleWhere()] } }),
        prisma.smartTask.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] }, dueAt: { gte: today.start, lt: today.end }, AND: [boardVisibleWhere()] } }),
      ]),
      findUnansweredInbound(now).catch(() => []),
      // Exact count, same predicate as the /tasks triage strip (no sampling).
      prisma.smartTask.count({
        where: { status: { notIn: ["COMPLETED", "CANCELLED"] }, assignedKey: null, taskType: { in: [...TRIAGE_TYPES] } },
      }),
    ]);

  // One comms pull for every shoot client (last 72h) — the per-SHOOT filter
  // (this project or unfiled only) happens in shootRow, so a message about a
  // client's other job never bleeds onto this card.
  const shootClientIds = [...new Set([...todayProjects, ...tomorrowProjects].map((p) => p.clientId).filter((x): x is string => !!x))];
  const commRowsByClient = new Map<string, ShootCommRow[]>();
  if (shootClientIds.length) {
    const recent = await prisma.commLog.findMany({
      where: { clientId: { in: shootClientIds }, occurredAt: { gte: new Date(now.getTime() - 72 * 3_600_000) } },
      orderBy: { occurredAt: "desc" },
      select: { clientId: true, projectId: true, projectGuess: true, channel: true, subject: true, body: true, direction: true, occurredAt: true },
      take: 200,
    });
    for (const r of recent) {
      const cid = r.clientId as string;
      const list = commRowsByClient.get(cid);
      if (list) list.push(r);
      else commRowsByClient.set(cid, [r]);
    }
  }

  const [todayShoots, tomorrowShoots] = await Promise.all([
    Promise.all(todayProjects.map((p) => shootRow(p, commRowsByClient, now))),
    Promise.all(tomorrowProjects.map((p) => shootRow(p, commRowsByClient, now))),
  ]);

  const todayKey = today.key;
  const [turnarounds, videoStates, videoReview] = await Promise.all([
    turnaroundRules(),
    videoStatesFor(qcTasks.map((t) => t.projectId).filter((x): x is string => !!x)).catch(() => new Map<string, ProjectVideoState>()),
    videoReviewBoard().catch(() => ({ waiting: [] as VideoCutState[], revising: [] as VideoCutState[] })),
  ]);
  const qc: OpsQcRow[] = qcTasks.filter((t) => t.projectId != null).map((t) => {
    let itemsLeft = 0;
    let actionable = 0;
    const pr = t.project;
    const { qc: evidence } = parseEvidence(pr?.statusEvidence ?? null);
    try {
      const items = t.checklist ? (JSON.parse(t.checklist) as { label: string; done?: boolean }[]) : [];
      itemsLeft = items.filter((i) => !i.done).length;
      actionable = actionableQcCount(items, evidence.present);
    } catch { itemsLeft = 0; actionable = 0; }
    const monthly = isMonthlyContentJob(pr?.deliverables ?? [], pr?.packageName);
    const next = pr
      ? nextPendingDue({
          shootDate: pr.shootDate,
          deliverables: pr.deliverables ?? [],
          statusEvidence: pr.statusEvidence,
          monthlyContent: monthly,
          turnarounds,
        })
      : null;
    // "Overdue" is still the JOB's promise (t.dueAt = the LATEST pending item) —
    // a shoot whose photos are out and whose reel has another day to run is NOT
    // late (Jordan: 208 N Adams, 2009 Garrison, 263 Towamensing).
    // "Due today" is when there is QC WORK to do: media already live with
    // unticked checks, or the next thing we owe is promised today. Keying the
    // bucket on t.dueAt alone hid every one of yesterday's shoots behind their
    // video's SLA, which is exactly what Jordan hit ("Nothing due for QC today?
    // That's not true").
    const bucket: OpsQcRow["bucket"] =
      t.dueAt && t.dueAt < now
        ? "overdue"
        : actionable > 0 || (next && etDayKey(next.at) <= todayKey) || (t.dueAt && etDayKey(t.dueAt) === todayKey)
          ? "today"
          : "waiting";
    return {
      taskId: t.id,
      projectId: t.projectId!,
      title: (pr?.title ?? t.title).split(",")[0],
      clientName: pr?.client?.name ?? null,
      photographer: pr?.photographer?.name ?? null,
      shootISO: pr?.shootDate?.toISOString() ?? null,
      services: [...new Set((pr?.deliverables ?? []).map((d) => d.label ?? d.type))],
      aryeoListingId: pr?.aryeoListingId ?? null,
      itemsLeft,
      dueISO: t.dueAt?.toISOString() ?? null,
      bucket,
      evidence,
      debrief: {
        shotOrder: pr?.shotOrderNotes ?? null,
        removals: pr?.removalNotes && pr.removalNotes !== NOTHING_TO_REMOVE_SENTINEL ? pr.removalNotes : null,
        nothingToRemove: pr?.removalNotes === NOTHING_TO_REMOVE_SENTINEL,
        culled: !!pr?.cullingConfirmedAt,
        editorBrief: pr?.editorBrief?.trim() || null,
        // Human field flags only — FLAG also carries the wrap-up's own
        // "Not completed" echo and machine-written client revision rows whose
        // body is an entire email thread (see isFieldFlag).
        flags: (pr?.activities ?? []).map((a) => a.body).filter(isFieldFlag),
        itemNotes: (pr?.deliverables ?? [])
          .filter((d): d is typeof d & { notes: string } => !!d.notes?.trim())
          .map((d) => ({ label: d.label ?? d.type, note: d.notes.trim() })),
        videosFilmed: pr?.videosFilmed ?? null,
        videoBrief: !!pr?.videoInstructions,
        // Same predicate as the QC card's line (photo-category jobs only) —
        // two surfaces must never disagree about the same shoot (review).
        unsubmitted:
          !!pr?.shootDate && pr.shootDate.getTime() >= DEBRIEF_GATE && pr.shootDate < now && !pr.debriefSubmittedAt &&
          (pr.deliverables ?? []).some((d) => ["PHOTOS", "DRONE", "TWILIGHT"].includes(d.type)),
      },
      // The photographer's "couldn't complete + why" answers from the wrap-up —
      // the Admin reads the reason here instead of chasing a bare unchecked box.
      monthly,
      actionable,
      nextDueISO: next?.at.toISOString() ?? null,
      nextDueCategories: next?.categories ?? [],
      videosOwed: monthly
        ? pr?.videosFilmed ?? monthlyVideoQuota([pr?.packageName, ...(pr?.deliverables ?? []).map((d) => d.label)])
        : null,
      notCompleted: (pr?.deliverables ?? [])
        .filter((d): d is typeof d & { notCompletedReason: string } => !!d.notCompletedReason)
        .map((d) => ({ label: d.label ?? d.type, reason: d.notCompletedReason })),
      video: (() => {
        const v = videoStates.get(t.projectId as string);
        return v && v.owed > 0 ? v : null;
      })(),
    };
  });

  const pipelineRows: PipelineRow[] = pipelineProjects.map((p) => {
    const { ev, qc: e } = parseEvidence(p.statusEvidence);
    const brief = p.revisionBriefs[0] ?? null;
    let items: string[] = [];
    if (p.status === "REVISION" && brief?.itemsJson) {
      try {
        items = ((JSON.parse(brief.itemsJson) as { items?: { ask?: string }[] }).items ?? [])
          .map((i) => i.ask ?? "")
          .filter(Boolean)
          .slice(0, 4);
      } catch { items = []; }
    }
    return {
      projectId: p.id,
      title: p.title.split(",")[0],
      status: p.status,
      // WHO the job is for and WHAT was ordered — Jordan: the pipeline check
      // "should have more details on who it is, what it's for."
      clientName: p.client?.name ?? null,
      services: [...new Set(p.deliverables.map((d) => d.label ?? d.type))],
      editor: p.editor?.name ?? null,
      sent: e.present,
      waitingOn: e.missing,
      videoDueISO: ev?.videoDue ?? null,
      videoOverdue: !!ev?.videoOverdue,
      revision: p.status === "REVISION" ? { headline: brief?.headline ?? null, items } : null,
    };
  });

  const openLoops = loopTasks;

  const [editing, review, revision, overdueTasks, dueTodayTasks] = pipelineCounts;
  const shotAlready = todayShoots.filter((s) => s.timeISO && new Date(s.timeISO) < now);
  const debriefsIn = shotAlready.filter((s) => s.debriefSubmitted).length;

  return {
    nowISO: now.toISOString(),
    todayShoots,
    tomorrowShoots,
    unanswered: {
      count: unansweredList.length,
      oldestHours: unansweredList.length ? Math.max(...unansweredList.map((u) => Math.round(u.ageMin / 60))) : null,
      preview: unansweredList.slice(0, 5).map((u) => ({
        name: u.clientName || "Unknown",
        snippet: (u.snippet ?? "").slice(0, 90),
        hours: Math.round(u.ageMin / 60),
      })),
    },
    qc,
    pipeline: { rows: pipelineRows, editing, review, revision, overdueTasks, dueTodayTasks },
    openLoops,
    openLoopsTally: tallyLoops(openLoops),
    videoReview,
    needsAssigning: needsAssigningCount,
    closeout: {
      todayShootsDone: shotAlready.length === todayShoots.length,
      todayDebriefsIn: debriefsIn,
      todayDebriefsMissing: shotAlready.length - debriefsIn,
      tomorrowGaps: tomorrowShoots.reduce((s, x) => s + x.gaps.length, 0),
      unanswered: unansweredList.length,
      openQc: qc.length,
      openRevisions: revision,
    },
  };
}

// ---------------------------------------------------------------------------
// Open loops — follow-ups, instructions, callbacks and replies still owed.
// Shared by Ops Day and the owner Dashboard, which both let a human close one
// out (Jordan, Sep 1: "a button to view and a button to mark as handled").
//
// WHO SEES WHAT — Jordan, Sep 2: "it's showing Kyle things that are for me.
// That shouldn't be the case. It's also too many things there."
// The query used to pull EVERY open loop in the business with no owner filter,
// so an owner's decisions landed on Kyle's home screen behind a one-click
// "Handled" that closes them forever. (The nightly duplicate-client scan
// already had to route AROUND this list for exactly that reason — see the long
// comment in clientDedupe.ts.) A loop belongs to someone by the SAME rules the
// rest of the hub assigns work, in this order:
//   1. `assignedKey` — the first-name slug from assignees.ts, when a human or
//      an engine named a person ("kyle", "kim", "jordan").
//   2. else `ownerId` — the TeamMember the routers file work to. Every
//      comms-derived follow-up (Slack to-do, client reply, vendor chase) is
//      filed to Kyle that way while its assignedKey stays null, so this is the
//      signal that keeps his real pile on his screen.
//   3. else the loop is UNCLAIMED, and unclaimed work routes by its NATURE
//      (OWNER_LANE_SOURCES) instead of landing on everybody.
// The OWNER's lane is the whole business — he still sees every row, which is
// what makes the scoping safe: these four task types are hidden from the
// /tasks board by design (BOARD_HIDDEN_TYPES), so this list is the only place
// they render. Narrowing Kyle's view can misfile a row onto Jordan; it can
// never strand one.
// ---------------------------------------------------------------------------

/** The four task types that make up a "loop" — work owed to someone else. */
const LOOP_TYPES = ["comms_followup", "internal_instruction", "callback", "client_reply"];

/** Nobody named on the row, and its nature is nobody's in particular. */
export const OPS_LANE = "ops";
/** The owner's own plate — never rendered on an admin's or a creative's screen. */
export const OWNER_LANE = "owner";

// Unclaimed work whose NATURE is the owner's, not the shared ops pile. The
// monthly Content Program's strategy call IS Jordan's client relationship — he
// runs the call — and its booking-link drafts are minted with no assignee and
// no owner (contentCalls.ts mintStrategyCallInvites). Seven of them at once
// were most of the wall on Kyle's screen on Sep 2.
const OWNER_LANE_SOURCES = ["content_program"];

/** Who counts as an owner, live from the AppUser allowlist (Jordan + Lauren).
 *  Jordan's TeamMember role is PHOTOGRAPHER, so the roster can't answer this. */
async function ownerIdentities(): Promise<{ keys: string[]; teamIds: string[] }> {
  const owners = await prisma.appUser.findMany({
    where: { role: "OWNER" },
    select: { name: true, teamMemberId: true },
  });
  const keys = new Set<string>();
  for (const o of owners) {
    const k = o.name ? slugForName(o.name) : "";
    if (k) keys.add(k);
  }
  return { keys: [...keys], teamIds: owners.map((o) => o.teamMemberId).filter((x): x is string => !!x) };
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The signed-in person, as the loop list needs to know them. null = no
 *  session (local dev / a cron probe) → the full owner view, exactly as the
 *  Dashboard already documents for a sessionless render. */
export type LoopViewer = { key: string | null; role: string; teamMemberId: string | null };

/** The signed-in person as a LoopViewer, against a roster the caller already
 *  loaded. viewerAssigneeKey matches teamMemberId → email → first-name slug and
 *  returns null when it can't tell. A viewer we can't identify is shown MORE,
 *  never less (see below) — the failure mode has to be noise, not lost work. */
function loopViewerFrom(me: CurrentUser | null, assignees: Assignee[]): LoopViewer | null {
  if (!me) return null;
  return { key: viewerAssigneeKey(me, assignees), role: me.role, teamMemberId: me.teamMemberId };
}

/** Rows fetched at most. The scope below is in the WHERE clause, not applied
 *  afterwards, so a viewer's list is capped only when THEIR OWN is 120 long.
 *  We fetch CAP + 1 and keep CAP, so `capped` means "the database really had
 *  more", never "you happen to have exactly 120" — a badge only earns its "+"
 *  from `loopsCapped()`, never from `length >= OPEN_LOOPS_CAP` (review). */
export const OPEN_LOOPS_CAP = 120;

/** The loop list, plus the one thing a plain array can't say: whether it was
 *  truncated. `capped` is a non-enumerable own property, so the array still
 *  maps/serialises exactly as before; a copy that loses it reads as false —
 *  i.e. no "+" — which understates rather than lying. */
export type OpsLoopList = OpsLoop[] & { capped: boolean };

/** True only when the query hit the cap with rows to spare. */
export function loopsCapped(loops: OpsLoop[]): boolean {
  return (loops as Partial<OpsLoopList>).capped === true;
}

export type LoopsTally = {
  /** every loop this viewer is allowed to see */
  total: number;
  /** on their own plate — their lane plus the shared ops pile */
  mine: number;
  /** of theirs, overdue or promised today — the number the block badges */
  actNow: number;
  /** theirs, but not due yet */
  later: number;
  /** real, open, and sitting with someone else */
  elsewhere: number;
  capped: boolean;
};

/** One pass over the list for every count a header needs to tell the truth. */
export function tallyLoops(loops: OpsLoop[]): LoopsTally {
  let mine = 0, actNow = 0, later = 0;
  for (const l of loops) {
    if (!l.mine) continue;
    mine++;
    if (l.actNow) actNow++;
    else later++;
  }
  return { total: loops.length, mine, actNow, later, elsewhere: loops.length - mine, capped: loopsCapped(loops) };
}

/**
 * What a header should say when the act-now badge is 0 but the block is NOT
 * empty. Returns null when it genuinely is empty (say "clear" then).
 *
 * The bug this exists to kill: an admin whose own plate is clear while other
 * people's loops are still open saw a grey "0 / none due", which reads as an
 * empty world. James's screen on Sep 2 had 14 open loops and none of them his.
 * Say that instead — the rows are real, they're just not his.
 */
export function loopsZeroState(loops: OpsLoop[]): { label: string; title: string } | null {
  const t = tallyLoops(loops);
  if (t.total === 0) return null;
  const n = (c: number) => `${c} loop${c === 1 ? "" : "s"}`;
  if (t.mine === 0) {
    return {
      label: `${t.elsewhere} elsewhere`,
      title: `${n(t.elsewhere)} open${t.capped ? "+" : ""}, none of them yours — they're with someone else`,
    };
  }
  const tail = t.elsewhere > 0 ? `, ${t.elsewhere} with someone else` : "";
  return {
    label: "none due",
    title: `Nothing of yours is overdue or promised today — ${t.later} of yours still open${tail}`,
  };
}

/**
 * Every open loop this viewer should see, most urgent first. Pass `viewer`
 * explicitly to override; omit it and the signed-in user is resolved from the
 * session (so Ops Day and the Dashboard call the SAME function and each get
 * their own audience); pass `null` for the deliberate full-business view.
 */
export async function openLoopsList(now = new Date(), viewer?: LoopViewer | null): Promise<OpsLoopList> {
  // ONE roster read per render. It used to be two — currentLoopViewer() pulled
  // listAssignees() to resolve the viewer's key while this function pulled it
  // again for the display names — on every /ops and every dashboard load.
  const [sessionUser, owners, assignees] = await Promise.all([
    viewer === undefined ? getCurrentUser().catch(() => null) : Promise.resolve(null),
    ownerIdentities(),
    listAssignees().catch(() => []),
  ]);
  const me = viewer === undefined ? loopViewerFrom(sessionUser, assignees) : viewer;
  // The EFFECTIVE role, so an owner previewing "view as Kyle" gets Kyle's
  // screen. No session at all (local dev, a probe) = the full owner view, the
  // same fallback the Dashboard already documents.
  const ownerView = !me || me.role === "OWNER";

  const where: Prisma.SmartTaskWhereInput = {
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    taskType: { in: LOOP_TYPES },
  };
  if (!ownerView) {
    // Three NULL-safe exclusions, one per rule above. Each clause spells out
    // the null cases as their own branches: `notIn` on a NULL column is NULL,
    // not true, and would have silently dropped every unassigned row.
    //
    // A clause is built ONLY when its roster lookup returned something. Folding
    // an empty roster in with `...(xs.length ? [notIn] : [])` was NOT a no-op:
    // it left `{ OR: [{ assignedKey: null }] }` standing, which stops being an
    // exclusion and becomes a *restriction* — the filter inverts and the
    // viewer's own work vanishes off their screen with no error anywhere.
    // Measured on live data (Sep 2): with both lookups empty Kyle's Open Loops
    // went 14 → 0; with only `teamIds` empty (an owner AppUser not linked to a
    // TeamMember — Lauren's row is exactly that today) he lost the 10 unnamed
    // rows the routers file to him, i.e. his whole comms pile. An unreadable
    // roster must widen this list, never narrow it.
    const AND: Prisma.SmartTaskWhereInput[] = [];
    // 1 · not a row a named owner holds
    if (owners.keys.length) {
      AND.push({ OR: [{ assignedKey: null }, { assignedKey: { notIn: owners.keys } }] });
    }
    // 2 · not one the routers filed to an owner
    if (owners.teamIds.length) {
      AND.push({ OR: [{ assignedKey: { not: null } }, { ownerId: null }, { ownerId: { notIn: owners.teamIds } }] });
    }
    // 3 · not unclaimed work whose nature is the owner's (a module constant,
    //     guarded the same way so the shape can't rot back into an inversion)
    if (OWNER_LANE_SOURCES.length) {
      AND.push({ OR: [{ assignedKey: { not: null } }, { ownerId: { not: null } }, { source: { notIn: OWNER_LANE_SOURCES } }] });
    }
    if (AND.length) where.AND = AND;
  }

  const rows = await prisma.smartTask.findMany({
    where,
    select: {
      id: true, title: true, summary: true, dueAt: true, projectId: true, taskType: true,
      assignedKey: true, ownerId: true, source: true,
      owner: { select: { name: true } },
      project: { select: { title: true } },
    },
    orderBy: [{ dueAt: "asc" }],
    // One MORE than we keep: the extra row is how we know the list was really
    // truncated. Reading "capped" off `length === CAP` would stamp a "+" on a
    // viewer who has exactly 120 loops and no more.
    take: OPEN_LOOPS_CAP + 1,
  });
  const capped = rows.length > OPEN_LOOPS_CAP;
  const page = capped ? rows.slice(0, OPEN_LOOPS_CAP) : rows;

  const todayKey = etDayKey(now);
  const loops = page.map((t) => {
    const lane = t.assignedKey
      ? t.assignedKey
      : t.ownerId
        ? owners.teamIds.includes(t.ownerId)
          ? OWNER_LANE
          : t.owner?.name
            ? slugForName(t.owner.name)
            : OPS_LANE
        : OWNER_LANE_SOURCES.includes(t.source)
          ? OWNER_LANE
          : OPS_LANE;
    const ownerLane = lane === OWNER_LANE || owners.keys.includes(lane);
    // Shared ops work is on everyone's plate. Beyond that: the owner's plate is
    // his own lane, an admin's is their key. A viewer we could NOT identify
    // keeps the whole (already owner-filtered) list rather than an empty one.
    const mine =
      lane === OPS_LANE ||
      (ownerView ? ownerLane : !me?.key ? true : lane === me.key);
    const overdue = !!t.dueAt && t.dueAt < now;
    return {
      taskId: t.id,
      title: t.title,
      summary: t.summary,
      dueISO: t.dueAt?.toISOString() ?? null,
      overdue,
      actNow: overdue || (!!t.dueAt && etDayKey(t.dueAt) <= todayKey),
      projectId: t.projectId,
      projectTitle: t.project?.title?.split(",")[0]?.trim() ?? null,
      kind: t.taskType,
      lane,
      mine,
      // Real names come back capitalised; a key with no roster row (a vendor,
      // a departed editor) comes back as the raw slug — capitalise it so the
      // chip never reads "with luma".
      withWhom: mine || lane === OPS_LANE || lane === OWNER_LANE ? null : capitalize(assigneeName(lane, assignees)),
    } satisfies OpsLoop;
  });

  // Most urgent first, and the viewer's own work ahead of what's with someone
  // else — the Dashboard renders the first 8 of this list, so the order IS the
  // triage there (it has no room for sections).
  const rank = (l: OpsLoop) => (l.overdue ? 0 : l.actNow ? 1 : l.dueISO ? 2 : 3);
  loops.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.mine) - Number(a.mine) ||
      (Date.parse(a.dueISO ?? "") || Infinity) - (Date.parse(b.dueISO ?? "") || Infinity) ||
      a.title.localeCompare(b.title),
  );
  // Non-enumerable, so the list still behaves as a plain OpsLoop[] everywhere
  // (map, spread, JSON) and only loopsCapped()/tallyLoops() look for it.
  return Object.defineProperty(loops, "capped", { value: capped, enumerable: false }) as OpsLoopList;
}
