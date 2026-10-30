import "server-only";
import { prisma } from "@/lib/prisma";
import { etDateTime, etMonthDay, etMonthKey, etTime, endOfBusinessDaysET } from "@/lib/datetime";
import { firstName } from "@/lib/assignees";
import { delegationFor, resurfaceOf, tasksDelegatedByAny, STATE_WORDS, type DelegatedTaskView, type Resurface } from "@/lib/delegation";
import type { AssignSeed, RowAction, Tone } from "@/lib/ownerDashboard";
import { resolveVideoSpec } from "@/lib/pipeline";
import { videoTier } from "@/lib/projectStatus";

// ---------------------------------------------------------------------------
// JORDAN'S DASHBOARD, MY WORK (Oct 23 2026, his spec §4 E–H): meetings and
// their prep, the scripts and creative decisions that are his, the email
// that needs him personally, and what he delegated. Same rules as the
// oversight half (lib/ownerDashboard): real records only, a missing source
// says so, a failed read is `unavailable`, never an empty "all clear".
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const warn = (what: string) => (e: unknown) => {
  console.warn(`owner work: ${what} failed`, (e as Error)?.message);
  return null;
};
/** Jordan's own mailbox (lib/integrations/google EXPECTED_MAILBOXES: info@ is his, hello@ Kyle's). */
export const OWNER_MAILBOX = "info@realtourpilot.com";

// =====================================================================================
// E. MEETINGS & PREPARATION
// =====================================================================================

export type MeetingRow = {
  id: string;
  startISO: string;
  type: string;
  who: string;
  clientId: string | null;
  purpose: string;
  /** the brief: the client's month or onboarding */
  href: string;
  joinLink: string | null;
  points: string[];
  missing: string[];
  prep: { taskId: string | null; words: string; tone: Tone; owner: string | null; dueISO: string | null; delegated: boolean };
  assignPrep: AssignSeed | null;
  followUp: AssignSeed;
  /** the meeting brief the panel opens (Loom, Oct 27 2026, 3:22) */
  brief: MeetingBrief;
};
/**
 * THE MEETING BRIEF (Jordan's Loom, Oct 27 2026, 3:22: "Open brief" should
 * open the brief for the meeting, not the content program page). Read from
 * records the hub keeps, each line left out when there is nothing on file:
 * the program they are on, the last call, the last thing they wrote to us,
 * the month's topics, what is open on the month, and questions to ask by
 * call type. Never an invented client fact.
 */
export type MeetingBrief = {
  program: string | null;
  lastCall: string | null;
  lastFromClient: string | null;
  topics: string[];
  openItems: string[];
  questions: string[];
};
const BRIEF_QUESTIONS: Record<string, string[]> = {
  MONTHLY_STRATEGY: [
    "What listings, open houses or events are coming up this month?",
    "Which of last month's videos did well, and which didn't land?",
    "Has anything changed in their market or their brand?",
    "Who is on camera, and which days can they film?",
  ],
  BRAND_DISCOVERY: [
    "Who is their ideal client, and which areas do they farm?",
    "What makes them different from the other agents there?",
    "What content have they tried before, and what worked?",
    "How comfortable are they on camera?",
  ],
};
export type Meetings = {
  calendly: { state: "connected" | "stale" | "not_connected"; words: string };
  calendarNote: string;
  scopeNote: string;
  rows: MeetingRow[];
  unavailable: string[];
};

export async function meetingsSection(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<Meetings> {
  const now = opts.now ?? new Date();
  const exclude = new Set(opts.excludeClientIds ?? []);
  const { CALL_WORDS, PREP_CALL_TYPES, prepKey, prepPointsFor } = await import("@/lib/meetingPrep");
  const [conn, mappings, records, lastSync] = await Promise.all([
    prisma.connection.findUnique({ where: { provider: "calendly" }, select: { status: true, secretEncrypted: true, lastSyncedAt: true } }).catch(warn("calendly connection")),
    prisma.programCalendlyEventMapping.findMany({ where: { enabled: true, purpose: { not: "IGNORED" } }, select: { eventTypeUri: true, eventName: true, lastSyncedAt: true } }).catch(warn("calendly mappings")),
    prisma.programCallRecord.findMany({
      where: { status: "SCHEDULED", scheduledStart: { gte: new Date(now.getTime() - HOUR), lte: new Date(now.getTime() + 14 * DAY) } },
      orderBy: { scheduledStart: "asc" },
      take: 40,
      select: { id: true, callType: true, scheduledStart: true, clientId: true, enrollmentId: true, monthId: true, onboardingId: true, inviteeName: true, meetLink: true, rescheduledFromId: true, calendlyEventTypeUri: true },
    }).catch(warn("calls")),
    prisma.cronRun.findFirst({ where: { job: "sync", summary: { not: null } }, orderBy: { startedAt: "desc" }, select: { summary: true, startedAt: true } }).catch(() => null),
  ]);
  const unavailable: string[] = records ? [] : ["the call records"];
  const connected = !!conn && conn.status === "CONNECTED" && !!conn.secretEncrypted;
  const synced = [conn?.lastSyncedAt, ...(mappings ?? []).map((m) => m.lastSyncedAt)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const calendly: Meetings["calendly"] = !connected
    ? { state: "not_connected", words: "Calendly isn't connected, so no meetings are read" }
    : !synced || now.getTime() - synced.getTime() > 3 * HOUR
      ? { state: "stale", words: synced ? `Calendly last read ${etDateTime(synced)}: meetings may be out of date` : "Calendly has never been read" }
      : { state: "connected", words: `Connected to Calendly · read ${etTime(synced)}` };
  const summary = lastSync?.summary ?? "";
  const calendarNote = /Google not connected|Google Calendar scope missing|isn't connected/i.test(summary)
    ? "Google Calendar isn't connected (it needs one re-consent on Connections), so meetings booked outside Calendly don't show here."
    : summary ? "Google Calendar is read only to link Calendly calls to their calendar events." : "Google Calendar's state is unknown (no sync recorded).";
  const scopeNote = `Only the program's Calendly call types are synced (${(mappings ?? []).map((m) => m.eventName).join(", ") || "none set up"}); other Calendly event types aren't in the hub.`;

  // Walk each record back to its booking chain's first record (the prep task's key).
  const rows = (records ?? []).filter((r) => !r.clientId || !exclude.has(r.clientId));
  const rootOf = new Map<string, string>();
  const parents = new Map<string, string | null>(rows.map((r) => [r.id, r.rescheduledFromId]));
  for (let round = 0; round < 6; round++) {
    const missing = [...new Set([...parents.values()].filter((p): p is string => !!p && !parents.has(p)))];
    if (!missing.length) break;
    const found = await prisma.programCallRecord.findMany({ where: { id: { in: missing } }, select: { id: true, rescheduledFromId: true } }).catch(() => []);
    for (const f of found) parents.set(f.id, f.rescheduledFromId);
    if (!found.length) break;
  }
  for (const r of rows) {
    let id = r.id;
    for (let i = 0; i < 20 && parents.get(id); i++) id = parents.get(id)!;
    rootOf.set(r.id, id);
  }
  const [clients, months, tasks] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }).catch(() => []),
    prisma.contentMonth.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.monthId).filter((x): x is string => !!x))] } }, select: { id: true, monthKey: true } }).catch(() => []),
    prisma.smartTask.findMany({ where: { dedupeKey: { in: rows.map((r) => prepKey(rootOf.get(r.id)!)) } }, select: { id: true, dedupeKey: true, status: true, dueAt: true, assignedKey: true, delegatedAt: true } }).catch(() => []),
  ]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const monthOf = new Map(months.map((m) => [m.id, m.monthKey]));
  const taskOf = new Map(tasks.map((t) => [t.dedupeKey, t]));
  const views = await delegationFor(tasks.filter((t) => t.delegatedAt).map((t) => t.id)).catch(() => new Map<string, DelegatedTaskView>());
  const typeName = new Map((mappings ?? []).map((m) => [m.eventTypeUri, m.eventName]));

  // The briefs' records, read once for every meeting on the list.
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x))];
  const enrollmentIds = [...new Set(rows.map((r) => r.enrollmentId).filter((x): x is string => !!x))];
  const monthIds = [...new Set(rows.map((r) => r.monthId).filter((x): x is string => !!x))];
  const [enrollments, pastCalls, monthTopics, lastIns, actions] = await Promise.all([
    enrollmentIds.length ? prisma.contentEnrollment.findMany({ where: { id: { in: enrollmentIds } }, select: { id: true, package: true, videosPerMonth: true, status: true, startedAt: true } }).catch(() => []) : [],
    clientIds.length
      ? prisma.programCallRecord.findMany({ where: { clientId: { in: clientIds }, status: "COMPLETED", scheduledStart: { lt: now } }, orderBy: { scheduledStart: "desc" }, distinct: ["clientId"], select: { clientId: true, callType: true, scheduledStart: true } }).catch(() => [])
      : [],
    monthIds.length ? prisma.contentTopic.findMany({ where: { monthId: { in: monthIds }, status: { notIn: ["REJECTED", "ARCHIVED"] } }, orderBy: { createdAt: "asc" }, take: 300, select: { monthId: true, title: true } }).catch(() => []) : [],
    clientIds.length
      ? prisma.commLog.findMany({ where: { clientId: { in: clientIds }, direction: "in", channel: { in: ["text", "email"] } }, orderBy: { occurredAt: "desc" }, distinct: ["clientId"], select: { clientId: true, channel: true, body: true, subject: true, occurredAt: true } }).catch(() => [])
      : [],
    enrollmentIds.length ? import("@/lib/contentActions").then((m) => m.monthlyContentActions({ now, excludeClientIds: [...exclude] })).catch(() => null) : null,
  ]);
  const enrollmentOf = new Map(enrollments.map((e) => [e.id, e]));
  const briefOf = (r: (typeof rows)[number], month: string | null | undefined): MeetingBrief => {
    const e = r.enrollmentId ? enrollmentOf.get(r.enrollmentId) : undefined;
    const last = r.clientId ? pastCalls.find((c) => c.clientId === r.clientId) : undefined;
    const said = r.clientId ? lastIns.find((c) => c.clientId === r.clientId) : undefined;
    const row = e && month ? actions?.rows.find((x) => x.key === `${e.id}:${month}`) : undefined;
    const text = said ? `${said.subject ? `${said.subject}: ` : ""}${(said.body ?? "").replace(/\s+/g, " ").trim()}` : "";
    return {
      program: e ? `${e.package}, ${e.videosPerMonth} videos a month${e.status !== "ACTIVE" ? ` (${e.status.toLowerCase()})` : ""}${e.startedAt ? ` · since ${etMonthDay(e.startedAt)}` : ""}` : null,
      lastCall: last?.scheduledStart ? `${(CALL_WORDS[last.callType] ?? "Call").replace(/^./, (c) => c.toUpperCase())}, ${etDateTime(last.scheduledStart)}` : null,
      lastFromClient: said ? `${said.channel === "email" ? "Email" : "Text"} ${etDateTime(said.occurredAt)}: "${text.length > 220 ? `${text.slice(0, 217).trimEnd()}...` : text}"` : null,
      topics: r.monthId ? monthTopics.filter((t) => t.monthId === r.monthId).map((t) => t.title).slice(0, 8) : [],
      openItems: row ? row.items.map((i) => i.words) : [],
      questions: BRIEF_QUESTIONS[r.callType] ?? [],
    };
  };

  const out: MeetingRow[] = [];
  for (const r of rows) {
    const start = r.scheduledStart!;
    const who = (r.clientId && nameOf.get(r.clientId)) || r.inviteeName || "Someone";
    const prepType = (PREP_CALL_TYPES as readonly string[]).includes(r.callType);
    const t = prepType ? taskOf.get(prepKey(rootOf.get(r.id)!)) : undefined;
    const v = t ? views.get(t.id) : undefined;
    const { points, missing } = prepType ? await prepPointsFor(r) : { points: [], missing: [] };
    const month = r.monthId ? monthOf.get(r.monthId) : null;
    const owner = v?.assigneeName ?? (t?.assignedKey ? firstName(t.assignedKey).replace(/^./, (c) => c.toUpperCase()) : null);
    let prep: MeetingRow["prep"];
    if (!prepType) prep = { taskId: null, words: "No prep for this call type", tone: "ok", owner: null, dueISO: null, delegated: false };
    else if (!t) prep = { taskId: null, words: "Prep not set up yet (the next hourly sync adds it)", tone: "warn", owner: null, dueISO: null, delegated: false };
    else if (t.status === "COMPLETED") prep = { taskId: t.id, words: "Prep ready", tone: "ok", owner, dueISO: t.dueAt?.toISOString() ?? null, delegated: !!v };
    else if (t.status === "CANCELLED") prep = { taskId: t.id, words: "Prep was closed", tone: "warn", owner, dueISO: null, delegated: !!v };
    else {
      const late = !!t.dueAt && t.dueAt.getTime() < now.getTime();
      prep = { taskId: t.id, words: `${late ? "Prep overdue" : "Prep due"} ${t.dueAt ? etDateTime(t.dueAt) : ""}${v ? ` · ${v.assigneeName ?? "someone"}: ${STATE_WORDS[v.state].toLowerCase()}` : owner ? ` · ${owner}` : ""}`.trim(), tone: late ? "bad" : missing.length ? "warn" : "ok", owner, dueISO: t.dueAt?.toISOString() ?? null, delegated: !!v };
    }
    const typeLabel = (r.calendlyEventTypeUri && typeName.get(r.calendlyEventTypeUri)) || CALL_WORDS[r.callType] || "Meeting";
    out.push({
      id: r.id,
      startISO: start.toISOString(),
      type: typeLabel.replace(/^./, (c) => c.toUpperCase()),
      who,
      clientId: r.clientId,
      purpose: r.callType === "MONTHLY_STRATEGY" ? `Plan ${month ? new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) : "the month"}'s content` : r.callType === "BRAND_DISCOVERY" ? "Brand discovery: who they are, their audience, their goals" : "Not a program call type",
      href: r.enrollmentId ? `/content/${r.enrollmentId}${month ? `?month=${month}` : ""}` : r.clientId ? `/clients/${r.clientId}` : "/content/calls",
      joinLink: r.meetLink,
      points,
      missing,
      prep,
      assignPrep: t && t.status !== "COMPLETED" && t.status !== "CANCELLED" ? { title: `Prepare for ${who}'s ${CALL_WORDS[r.callType] ?? "meeting"}`, sourceTaskId: t.id, dueAt: t.dueAt?.toISOString() ?? null, clientId: r.clientId } : null,
      followUp: { title: `Follow up: ${who}'s ${CALL_WORDS[r.callType] ?? "meeting"} (${etMonthDay(start)})`, outcome: "The decisions from the call written down and sent", dueAt: endOfBusinessDaysET(start, 1).toISOString(), sourceHref: `/content/calls#call-${r.id}-follow-up`, clientId: r.clientId },
      brief: briefOf(r, month),
    });
  }
  return { calendly, calendarNote, scopeNote, rows: out, unavailable };
}

// =====================================================================================
// F. SCRIPTS & CREATIVE DECISIONS
// =====================================================================================

export type CreativeRow = {
  id: string;
  kind: "listing" | "monthly";
  client: string;
  what: string;
  writer: string;
  approver: string;
  /** who holds the pen: Jordan, or someone drafting for his approval */
  mode: "jordan" | "drafted";
  dueISO: string | null;
  related: string | null;
  nextAction: string;
  href: string;
  tone: Tone;
  assign: AssignSeed;
  /** the open task behind the row (a Script Studio nudge), when there is one */
  taskId: string | null;
  /** The buttons (Oct 27 2026): the first is the primary. */
  actions: RowAction[];
};
/** One quiet line for the listing scripts the creative manager holds (Oct 27 2026); Open lists them. */
export type ListingFyi = { owner: string; count: number; words: string; rows: { id: string; title: string; sub: string; href: string; tone: Tone }[] };
export type CreativeDecisions = { rows: CreativeRow[]; jordanOwns: number; othersDraft: number; listingFyi: ListingFyi | null; unavailable: string[] };

const CREATIVE_ITEMS = new Set(["topics", "write", "approve", "changes", "suggestions", "strategy", "proposals", "ideas"]);
const prevMonthKey = (k: string) => {
  const [y, m] = k.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * LISTING SCRIPTS STILL TO WRITE OR APPROVE: a premium reel or premium
 * cinematic video shooting by `until` with no script, a draft waiting on
 * review, or the client's changes. One rule for the Scripts card, the
 * Bottlenecks row and Pre-production. Their approver is the creative manager
 * (Jordan's Loom, Oct 27 2026), else Jordan.
 */
type ListingScript = { projectId: string; clientId: string; client: string; street: string; shootISO: string | null; what: string; next: string; hasScript: boolean };
async function listingScriptsWaiting(now: Date, until: Date, exclude: string[]): Promise<ListingScript[] | null> {
  const listing = await prisma.project.findMany({
    where: {
      status: { in: ["BOOKED", "SCHEDULED"] },
      shootDate: { gte: now, lte: until },
      contentMonthId: null,
      ...(exclude.length ? { clientId: { notIn: exclude } } : {}),
      deliverables: { some: { type: { in: ["VIDEO", "SOCIAL_REEL"] }, removedFromOrderAt: null } },
    },
    orderBy: { shootDate: "asc" },
    take: 40,
    select: {
      id: true, title: true, shootDate: true, clientId: true, client: { select: { name: true } }, reelScript: true, scriptingId: true, scriptingStatus: true, scriptingDraftVersion: true, scriptingVersion: true,
      packageName: true,
      deliverables: { select: { type: true, label: true, productTitle: true, videoStyle: true, notCompletedReason: true, waivedAt: true, removedFromOrderAt: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
    },
  }).catch(warn("listing scripts"));
  if (!listing) return null;
  const out: ListingScript[] = [];
  for (const p of listing) {
    // Only a job whose video takes a script (Oct 26 2026, Jordan: "I think some
    // of these dont get listing scripts?"). The video step's own rule: premium
    // reels and premium cinematic videos need one; a standard reel, an
    // agent-intro reel (the agent's intro lines go on the upload page) or a
    // standard cinematic video never do. A job Script Studio already holds
    // stays, whatever it was ordered as.
    if (!p.scriptingId) {
      const live = p.deliverables.filter((d) => !d.notCompletedReason && !d.waivedAt && !d.removedFromOrderAt);
      const { spec } = resolveVideoSpec({ deliverables: p.deliverables, orderItems: p.orderItems, packageName: p.packageName, isPremium: videoTier(live) === "premium" });
      if (!spec.requireScript) continue;
    }
    const st = (p.scriptingStatus ?? "").toLowerCase();
    let what: string | null = null;
    let next = "";
    if (!p.reelScript && !p.scriptingId) { what = "No script yet"; next = "Generate or write the script"; }
    else if (st === "hooks_proposed" && p.scriptingDraftVersion == null) { what = "Script options ready to pick"; next = "Pick an option in Script Writing"; }
    else if (p.scriptingDraftVersion != null || st === "awaiting_review" || st === "hooks_proposed") { what = `Draft${p.scriptingDraftVersion ? ` v${p.scriptingDraftVersion}` : ""} waiting for approval`; next = "Review the script"; }
    else if (st === "client_revision_requested") { what = "The client asked for changes"; next = "Revise the script"; }
    if (!what) continue;
    out.push({ projectId: p.id, clientId: p.clientId, client: p.client?.name ?? "A client", street: p.title.split(",")[0], shootISO: p.shootDate?.toISOString() ?? null, what, next, hasScript: !!(p.reelScript || p.scriptingId) });
  }
  return out;
}

/**
 * WHAT THE SHOOTS AHEAD REQUIRE (Jordan's Loom, Oct 27 2026, 2:52:
 * "Pre-production should really not say five shoots coming up, it should be
 * like, hey, we have five scripts that need to be written ... or scripts need
 * to be approved. I don't care about the shoots coming up, I care about the
 * stuff coming up that the shoots require."). One row per need: a listing
 * script for a shoot in the next seven days (lib rule above), and a content
 * month's scripts (this month and next: to write, or waiting for approval,
 * never counting a script already filmed). `n` is the number of scripts;
 * `owner` the person whose move it is (the creative manager for listing
 * scripts, the month's script owner for content). Null = that source failed.
 */
export type ScriptNeed = {
  id: string;
  kind: "listing" | "monthly";
  need: "write" | "approve";
  n: number;
  client: string;
  /** the property, or the client for a content month */
  street: string;
  what: string;
  dueISO: string | null;
  owner: string;
  href: string;
  projectId: string | null;
};
export async function scriptNeedsAhead(opts: { now: Date; excludeClientIds: string[]; listingOwner: string }): Promise<{ listing: ScriptNeed[] | null; monthly: ScriptNeed[] | null }> {
  const { now, excludeClientIds: exclude } = opts;
  const [listing, monthly] = await Promise.all([
    listingScriptsWaiting(now, new Date(now.getTime() + 7 * DAY), exclude),
    (async (): Promise<ScriptNeed[] | null> => {
      const [{ monthlyContentActions }, { ownersForMany, pairKey }, { readScriptsFilmed }] = await Promise.all([import("@/lib/contentActions"), import("@/lib/programOwners"), import("@/lib/scriptFilmed")]);
      const content = await monthlyContentActions({ now, excludeClientIds: exclude }).catch(warn("monthly scripts"));
      if (!content) return null;
      const thisMonth = etMonthKey(now);
      const [y, m] = thisMonth.split("-").map(Number);
      const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const rows = content.rows
        .filter((r) => r.monthKey >= thisMonth && r.monthKey <= nextMonth)
        .map((r) => ({ ...r, items: r.items.filter((i) => i.key === "write" || i.key === "approve" || i.key === "changes") }))
        .filter((r) => r.items.length);
      if (!rows.length) return [];
      const pairs = rows.map((r) => ({ enrollmentId: r.key.split(":")[0], monthKey: r.key.split(":")[1] }));
      const months = await prisma.contentMonth.findMany({ where: { OR: pairs.map((p) => ({ enrollmentId: p.enrollmentId, monthKey: p.monthKey })) }, select: { id: true, enrollmentId: true, monthKey: true } });
      const monthId = (e: string, k: string) => months.find((x) => x.enrollmentId === e && x.monthKey === k)?.id ?? null;
      const owners = await ownersForMany(pairs.map((p) => ({ enrollmentId: p.enrollmentId, monthId: monthId(p.enrollmentId, p.monthKey) }))).catch(() => null);
      // Waiting scripts already filmed are not a decision any more (the Scripts card's rule).
      const scripts = months.length ? await prisma.contentScript.findMany({ where: { monthId: { in: months.map((x) => x.id) }, currentVersionId: { not: null }, historical: false }, select: { id: true, topicId: true, monthId: true, currentVersionId: true } }) : [];
      const waitingIds = new Set(scripts.length ? (await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId!) }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } }, select: { id: true } })).map((v) => v.id) : []);
      const waiting = scripts.filter((s) => waitingIds.has(s.currentVersionId!));
      const filmed = waiting.length ? await readScriptsFilmed(waiting).catch(() => new Map()) : new Map();
      const firstInt = (s: string) => Number(/\d+/.exec(s)?.[0] ?? 1) || 1;
      const out: ScriptNeed[] = [];
      for (const r of rows) {
        const [enrollmentId, monthKey] = r.key.split(":");
        const mid = monthId(enrollmentId, monthKey);
        const owner = owners?.get(pairKey(enrollmentId, mid))?.SCRIPTS;
        const ownerName = owner && owner.label !== "unassigned" ? firstName(owner.label) : opts.listingOwner;
        const monthLabel = new Date(`${monthKey}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
        for (const i of r.items) {
          let n = firstInt(i.words);
          if (i.key === "approve") {
            const here = waiting.filter((s) => s.monthId === mid);
            if (here.length) n = here.filter((s) => !filmed.has(s.id)).length;
            if (!n) continue;
          }
          const need = i.key === "approve" ? "approve" : "write";
          out.push({
            id: `month:${r.key}:${i.key}`,
            kind: "monthly",
            need,
            n,
            client: r.clientName,
            street: r.clientName,
            what: `${monthLabel} content: ${need === "approve" ? `${plural(n, "script")} waiting for approval` : i.key === "changes" ? `${plural(n, "script")} to rework (client changes)` : `${plural(n, "script")} to write`}`,
            dueISO: null,
            owner: ownerName,
            href: i.href,
            projectId: null,
          });
        }
      }
      return out;
    })().catch(warn("monthly scripts")),
  ]);
  return {
    listing: listing
      ? listing.map((p) => ({
          id: `script:${p.projectId}`,
          kind: "listing" as const,
          need: p.hasScript && !/asked for changes/i.test(p.what) ? ("approve" as const) : ("write" as const),
          n: 1,
          client: p.client,
          street: p.street,
          what: `Listing script: ${p.what.charAt(0).toLowerCase()}${p.what.slice(1)}`,
          dueISO: p.shootISO,
          owner: opts.listingOwner,
          href: `/projects/${p.projectId}${p.hasScript ? "#script" : ""}`,
          projectId: p.projectId,
        }))
      : null,
    monthly,
  };
}

/**
 * The Bottlenecks row for scripts (Oct 27 2026, his mockup: "Two shoots lack
 * approved scripts · Jordan · Review today · Review scripts"): a listing
 * script missing or unapproved for a shoot by the end of the next business
 * day. One row, however many; its button goes to the script (one job) or to
 * the Scripts card (several).
 */
export type ScriptsBottleneck = { issue: string; owner: string; nextStep: string; href: string; projectId: string | null; tone: Tone; firstShootISO: string | null; items: ScriptNeed[] };
/** From the listing needs (scriptNeedsAhead): the shoots by the end of the next business day. Since the Loom (Oct 27 2026) the owner is the creative manager. */
export function scriptsBottleneckFrom(listing: ScriptNeed[], opts: { now: Date; ownerName: string }): ScriptsBottleneck | null {
  const until = endOfBusinessDaysET(opts.now, 1, 23).getTime();
  const waiting = listing.filter((n) => n.kind === "listing" && !!n.dueISO && Date.parse(n.dueISO) <= until);
  if (!waiting.length) return null;
  const one = waiting.length === 1 ? waiting[0] : null;
  const first = waiting[0];
  const bare = (n: ScriptNeed) => n.what.replace(/^Listing script: /, "");
  return {
    issue: one ? `${one.street}: ${bare(one)}, shoot ${etDateTime(one.dueISO)}` : `${plural(waiting.length, "shoot")} lack approved scripts (first ${first.street}, ${etDateTime(first.dueISO)})`,
    owner: opts.ownerName,
    nextStep: "Approve today",
    href: one ? one.href : "#creative",
    projectId: one?.projectId ?? null,
    tone: first.dueISO && Date.parse(first.dueISO) - opts.now.getTime() < DAY ? "bad" : "warn",
    firstShootISO: first.dueISO,
    items: waiting,
  };
}

export async function creativeDecisions(opts: { now?: Date; excludeClientIds?: string[]; ownerEmail?: string | null; ownerEmails?: string[] } = {}): Promise<CreativeDecisions> {
  const now = opts.now ?? new Date();
  const ownerEmail = (opts.ownerEmail ?? OWNER_MAILBOX).toLowerCase();
  // Every address the owner signs in with is him (info@ is the one the content
  // program's owner assignments name).
  const isOwnerEmail = (e: string | null | undefined) => !!e && [ownerEmail, OWNER_MAILBOX, ...(opts.ownerEmails ?? []).map((x) => x.toLowerCase())].includes(e.toLowerCase());
  const exclude = opts.excludeClientIds ?? [];
  const unavailable: string[] = [];
  const rows: CreativeRow[] = [];

  // ---- monthly content: the month rows that wait on Jordan ---------------------
  const [{ monthlyContentActions }, { ownersForMany, pairKey }, { readScriptsFilmed }] = await Promise.all([import("@/lib/contentActions"), import("@/lib/programOwners"), import("@/lib/scriptFilmed")]);
  const content = await monthlyContentActions({ now, excludeClientIds: exclude }).catch(warn("monthly content"));
  if (!content) unavailable.push("monthly content");
  // STALE MONTHS (Oct 27 2026: Rick Schultz's August read "4 scripts to
  // approve" in late October). The shared card reaches six months back for
  // waiting approvals; on Jordan's list a month before last is past (a missed
  // month is forfeited, catch-ups are approved by staff), and a script already
  // filmed is not a decision any more. So: this month, next month, and last
  // month's waiting scripts that are not filmed yet (a late session).
  const thisMonth = etMonthKey(now);
  const lastMonth = prevMonthKey(thisMonth);
  const creative = (content?.rows ?? [])
    .filter((r) => r.monthKey >= lastMonth)
    .map((r) => ({ ...r, items: r.items.filter((i) => CREATIVE_ITEMS.has(i.key)) }))
    .filter((r) => r.items.length);
  if (creative.length) {
    const pairs = creative.map((r) => ({ enrollmentId: r.key.split(":")[0], monthKey: r.key.split(":")[1] }));
    const months = await prisma.contentMonth.findMany({ where: { OR: pairs.map((p) => ({ enrollmentId: p.enrollmentId, monthKey: p.monthKey })) }, select: { id: true, enrollmentId: true, monthKey: true } }).catch(() => []);
    const monthId = (e: string, k: string) => months.find((m) => m.enrollmentId === e && m.monthKey === k)?.id ?? null;
    const owners = await ownersForMany(pairs.map((p) => ({ enrollmentId: p.enrollmentId, monthId: monthId(p.enrollmentId, p.monthKey) }))).catch(warn("script owners"));
    // Who drafted the scripts waiting for approval (the current version's author).
    const scripts = months.length
      ? await prisma.contentScript.findMany({ where: { monthId: { in: months.map((m) => m.id) }, currentVersionId: { not: null }, historical: false }, select: { id: true, topicId: true, monthId: true, currentVersionId: true } }).catch(() => [])
      : [];
    const versions = scripts.length
      ? await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId!) }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } }, select: { id: true, createdBy: true } }).catch(() => [])
      : [];
    const waitingIds = new Set(versions.map((v) => v.id));
    const waitingScripts = scripts.filter((s) => waitingIds.has(s.currentVersionId!));
    const filmed = waitingScripts.length ? await readScriptsFilmed(waitingScripts).catch(() => new Map()) : new Map();
    // createdBy is an email, often with a note ("info@… (via Claude: v2.4 restart)"),
    // or a word for the system ("ai", "import", "migration", "cron").
    const emailIn = (v: string | null) => (/[^\s@()]+@[^\s@()]+\.[a-z]{2,}/i.exec(v ?? "")?.[0] ?? null)?.toLowerCase() ?? null;
    const authors = [...new Set(versions.map((v) => emailIn(v.createdBy)).filter((x): x is string => !!x))];
    const users = authors.length ? await prisma.appUser.findMany({ where: { email: { in: authors, mode: "insensitive" } }, select: { email: true, name: true } }).catch(() => []) : [];
    // The owner's own mailbox is the owner (his login may be another address).
    const ownerFirst0 = (await prisma.appUser.findFirst({ where: { email: { equals: ownerEmail, mode: "insensitive" } }, select: { name: true } }).catch(() => null))?.name;
    const nameOfEmail = (e: string) => {
      const u = users.find((x) => x.email.toLowerCase() === e.toLowerCase());
      if (u?.name) return firstName(u.name);
      if (isOwnerEmail(e)) return ownerFirst0 ? firstName(ownerFirst0) : "Jordan";
      return e.split("@")[0];
    };
    for (const r of creative) {
      const [enrollmentId, monthKey] = r.key.split(":");
      const mid = monthId(enrollmentId, monthKey);
      const o = owners?.get(pairKey(enrollmentId, mid));
      const scriptOwner = o?.SCRIPTS;
      const strategyOwner = o?.STRATEGY;
      // Waiting scripts already filmed drop out; none left, the approval drops.
      const waitingHere = waitingScripts.filter((s) => s.monthId === mid);
      const unfilmed = waitingHere.filter((s) => !filmed.has(s.id)).length;
      const lastMonthRow = monthKey < thisMonth;
      const scriptItems = r.items
        .filter((i) => ["write", "approve", "changes", "suggestions", "topics", "ideas"].includes(i.key))
        .filter((i) => !lastMonthRow || i.key === "approve" || i.key === "changes")
        .flatMap((i) => {
          if (i.key !== "approve" || !waitingHere.length) return [i];
          if (!unfilmed) return [];
          return [unfilmed === waitingHere.length ? i : { ...i, words: `${plural(unfilmed, "script")} to approve` }];
        });
      const strategyItems = lastMonthRow ? [] : r.items.filter((i) => i.key === "strategy" || i.key === "proposals");
      const mineScripts = isOwnerEmail(scriptOwner?.email);
      const mineStrategy = isOwnerEmail(strategyOwner?.email);
      const items = [...(mineScripts ? scriptItems : []), ...(mineStrategy ? strategyItems : [])];
      if (!items.length) continue;
      const monthScripts = scripts.filter((s) => s.monthId === mid).map((s) => versions.find((v) => v.id === s.currentVersionId)).filter((v): v is { id: string; createdBy: string | null } => !!v);
      const authorOf = (by: string | null): string | null => {
        const email = emailIn(by);
        if (email) return nameOfEmail(email);
        if (by === "ai") return "AI draft";
        if (by === "import" || by === "migration") return "Imported";
        if (by === "cron") return "The hub";
        return null;
      };
      const writers = [...new Set(monthScripts.map((v) => authorOf(v.createdBy)).filter((x): x is string => !!x))];
      const ownerFirst = firstName(scriptOwner?.label ?? "Jordan");
      const drafted = writers.some((w) => w !== ownerFirst && w !== "AI draft" && w !== "Imported" && w !== "The hub");
      const monthLabel = new Date(`${monthKey}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
      const assign: AssignSeed = { title: `${r.clientName} ${monthLabel}: ${items[0].words}`, outcome: "Scripts drafted for Jordan's approval", sourceHref: items[0].href, sourceTaskId: null };
      const primary = items[0].key === "write" ? "Write scripts" : items[0].key === "strategy" || items[0].key === "proposals" ? "Open strategy" : items[0].key === "topics" || items[0].key === "ideas" ? "Open topics" : "Review";
      rows.push({
        id: `month:${r.key}`,
        kind: "monthly",
        client: r.clientName,
        what: items.map((i) => i.words).join(" · "),
        writer: writers.length ? writers.join(", ") : items.some((i) => i.key === "write") ? `${ownerFirst} (not started)` : ownerFirst,
        approver: mineScripts ? ownerFirst : firstName(strategyOwner?.label ?? "Jordan"),
        mode: drafted ? "drafted" : "jordan",
        dueISO: null,
        related: `Month ${monthLabel}`,
        nextAction: items[0].words,
        href: items[0].href,
        tone: items.some((i) => i.tone === "warn") ? "warn" : "ok",
        assign,
        taskId: null,
        actions: [{ kind: "link", label: primary, href: items[0].href }, { kind: "assign", label: "Delegate", seed: assign }],
      });
    }
  }

  // ---- listing scripts for shoots in the next 7 days ---------------------------
  const listing = await listingScriptsWaiting(now, new Date(now.getTime() + 7 * DAY), exclude);
  if (!listing) unavailable.push("listing scripts");
  // SCRIPT STUDIO'S OWN NUDGES (Oct 27 2026: the package it generated, and the
  // client's reply on it, are routed to the listing-scripts owner: James since
  // the Loom, else Jordan).
  // One per job, keyed by the webhook ("scripting-pick-<job>" since options
  // first, Oct 30 2026, "scripting-script-<job>", "scripting-client-<job>");
  // Done closes it, and the Studio reopens it on its next event.
  const studio = await prisma.smartTask.findMany({
    where: {
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      AND: [
        { OR: [{ dedupeKey: { startsWith: "scripting-pick-" } }, { dedupeKey: { startsWith: "scripting-script-" } }, { dedupeKey: { startsWith: "scripting-client-" } }] },
        ...(exclude.length ? [{ OR: [{ clientId: null }, { clientId: { notIn: exclude } }] }] : []),
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 30,
    select: { id: true, title: true, dedupeKey: true, projectId: true, clientId: true, dueAt: true, project: { select: { title: true, shootDate: true, status: true, client: { select: { name: true } } } } },
  }).catch(warn("Script Studio tasks"));
  if (!studio) unavailable.push("Script Studio tasks");
  const studioByProject = new Map<string, NonNullable<typeof studio>[number]>();
  for (const t of studio ?? []) {
    if (!t.projectId || t.project?.status === "CANCELLED") continue;
    // The client's reply outranks the "script ready" nudge on the same job.
    const had = studioByProject.get(t.projectId);
    if (!had || t.dedupeKey?.startsWith("scripting-client-")) studioByProject.set(t.projectId, t);
  }
  const listingRow = (p: { projectId: string; clientId: string | null; client: string; street: string; shootISO: string | null; what: string; next: string; hasScript: boolean }, taskId: string | null): CreativeRow => {
    const assign: AssignSeed = { title: `Listing script: ${p.street}`, outcome: "An approved script before the shoot", sourceHref: `/projects/${p.projectId}#script`, projectId: p.projectId, clientId: p.clientId, dueAt: p.shootISO ? new Date(Date.parse(p.shootISO) - DAY).toISOString() : null };
    return {
      id: `listing:${p.projectId}`,
      kind: "listing",
      client: p.client,
      what: `${p.street}: ${p.what}`,
      writer: "Jordan (Script Studio)",
      approver: "Jordan",
      mode: "jordan",
      dueISO: p.shootISO,
      related: p.shootISO ? `Shoot ${etDateTime(p.shootISO)}` : null,
      nextAction: p.next,
      href: `/projects/${p.projectId}${p.hasScript ? "#script" : ""}`,
      tone: p.shootISO && Date.parse(p.shootISO) - now.getTime() < 2 * DAY ? "bad" : "warn",
      assign,
      taskId,
      actions: [
        { kind: "link", label: p.hasScript ? "Review script" : "Write script", href: `/projects/${p.projectId}${p.hasScript ? "#script" : ""}` },
        taskId ? { kind: "done", label: "Done", taskId } : { kind: "assign", label: "Delegate", seed: assign },
      ],
    };
  };
  const listingRows: CreativeRow[] = [];
  for (const p of listing ?? []) {
    listingRows.push(listingRow(p, studioByProject.get(p.projectId)?.id ?? null));
    studioByProject.delete(p.projectId);
  }
  // A Studio nudge on a job the 7-day list doesn't hold (shooting later, or the script is in but the client replied).
  for (const [pid, t] of studioByProject) {
    const client = t.dedupeKey?.startsWith("scripting-client-");
    const pick = t.dedupeKey?.startsWith("scripting-pick-");
    const changes = /changes/i.test(t.title);
    listingRows.push(listingRow({
      projectId: pid,
      clientId: t.clientId,
      client: t.project?.client?.name ?? "A client",
      street: t.project?.title ? t.project.title.split(",")[0] : t.title.split(/\s[\u2014-]\s/).pop() || "A job",
      shootISO: t.project?.shootDate?.toISOString() ?? null,
      what: client ? (changes ? "The client asked for changes in Script Studio" : "The client replied on the script in Script Studio") : pick ? "Script options ready to pick" : "Script Studio's package is ready to review",
      next: client ? (changes ? "Revise the script" : "Check the client's reply") : pick ? "Pick an option in Script Writing" : "Review and lock the script",
      hasScript: !pick,
    }, t.id));
  }
  // LISTING SCRIPTS ARE JAMES'S NOW (Jordan's Loom, Oct 27 2026, 3:51: "I
  // don't need to approve the scripts, James can approve them, I'm not
  // worried about approving the listing content scripts ... he's the content
  // manager ... I don't mind reviewing them, I just don't think I really need
  // to"). With a creative manager on the roster, the listing rows leave this
  // card for one quiet line ("James has 2 listing scripts to approve") whose
  // Open lists them; the Studio nudges are routed to him (taskRouting). With
  // no creative manager they stay Jordan's rows, as before.
  const cm = listingRows.length ? await prisma.teamMember.findFirst({ where: { active: true, creativeManager: true }, orderBy: { createdAt: "asc" }, select: { name: true } }).catch(() => null) : null;
  let listingFyi: ListingFyi | null = null;
  if (cm?.name) {
    const who = firstName(cm.name);
    const approve = listingRows.filter((r) => !/No script yet|asked for changes/i.test(r.what)).length;
    const verb = approve === listingRows.length ? "approve" : approve === 0 ? "write" : "write or approve";
    listingFyi = {
      owner: who,
      count: listingRows.length,
      words: `${who} has ${plural(listingRows.length, "listing script")} to ${verb}`,
      rows: listingRows.map((r) => ({ id: r.id, title: r.what, sub: [r.client, r.related].filter(Boolean).join(" · "), href: r.href, tone: r.tone })),
    };
  } else rows.push(...listingRows);
  rows.sort((a, b) => Number(b.tone === "bad") - Number(a.tone === "bad") || (a.dueISO ?? "9999").localeCompare(b.dueISO ?? "9999"));
  return { rows, jordanOwns: rows.filter((r) => r.mode === "jordan").length, othersDraft: rows.filter((r) => r.mode === "drafted").length, listingFyi, unavailable };
}

// =====================================================================================
// G. EMAIL NEEDING MY REPLY
// =====================================================================================

export type EmailClass = "reply" | "decide" | "team" | "waiting";
export const EMAIL_CLASS_WORDS: Record<EmailClass, string> = {
  reply: "You need to reply",
  decide: "You need to decide",
  team: "The team can handle it",
  waiting: "Waiting on someone else",
};
export type EmailRow = {
  key: string;
  cls: EmailClass;
  /** who handles it when it is not Jordan's */
  handledBy: string | null;
  sender: string;
  subject: string;
  summary: string;
  waitingSinceISO: string;
  businessHours: number | null;
  client: string | null;
  clientId: string | null;
  projectId: string | null;
  lastExchange: string | null;
  replyHref: string;
  groupKey: string;
  threadKey: string;
  taskId: string | null;
  assign: AssignSeed;
  /** Their newest email, and our last reply in the thread (Oct 27 2026, the Loom: "I should see his last email, response"). */
  lastFromThem: { atISO: string; text: string } | null;
  lastFromUs: { atISO: string; text: string } | null;
  /** the conversation, oldest first (the newest ten turns): "Open thread" */
  thread: EmailTurn[];
  /** the comms-log row the panel's reply box answers (the newest email they sent); null: Messages only */
  commLogId: string | null;
  /** handed to someone (Delegated by me lists it, with their state) */
  delegated: { taskId: string; assignee: string; state: string; dueISO: string | null } | null;
};
export type EmailTurn = { role: "client" | "us"; atISO: string | null; text: string };
export type EmailSection = { rows: EmailRow[]; counts: Record<EmailClass, number>; connected: boolean | null; note: string; unavailable: string[] };

/**
 * EMAIL NEEDING MY REPLY. A delegated email leaves his list (Jordan's Loom,
 * Oct 27 2026, 6:51: "email needing my reply should be empty now, because
 * I've delegated all of these"): its row is kept as "waiting" (Delegated by me
 * shows it with the assignee's state) and the card lists only what still
 * needs him. Who has it is read from the THREAD (lib/emailDelegation), and
 * from the client's reply to-do only for a delegation made before that (the
 * to-do changes when the client writes again, which is how a delegated email
 * came back). Delegate goes to the office (Kyle) by default, due by 5 PM.
 */
export async function emailNeedingReply(opts: { now?: Date; excludeClientIds?: string[] } = {}): Promise<EmailSection> {
  const now = opts.now ?? new Date();
  const [{ unansweredComms }, google, { normalizeSubject }, { waitingReplyHref }, cov, ed, { listAssignees }, { kylePerson }] = await Promise.all([
    import("@/lib/replyQueue"),
    import("@/lib/integrations/google"),
    import("@/components/comms/emailThreads"),
    import("@/components/comms/messagesNav"),
    import("@/lib/coverage"),
    import("@/lib/emailDelegation"),
    import("@/lib/assignees"),
    import("@/lib/opsHome"),
  ]);
  const [threads, boxes, rules] = await Promise.all([
    unansweredComms({ now, families: ["email"], includeUnmatched: true, includeTeam: false, excludeClientIds: opts.excludeClientIds }).catch(warn("email")),
    google.connectedGmailMailboxes().catch(() => null),
    cov.coverageRules().catch(() => null),
  ]);
  const connected = boxes ? boxes.includes(OWNER_MAILBOX) : null;
  const counts: Record<EmailClass, number> = { reply: 0, decide: 0, team: 0, waiting: 0 };
  if (!threads) return { rows: [], counts, connected, note: "Email couldn't load. This is not an empty inbox.", unavailable: ["email"] };
  if (connected === false) return { rows: [], counts, connected, note: `Your inbox (${OWNER_MAILBOX}) isn't connected, so the hub can't see email waiting on you.`, unavailable: ["your inbox"] };
  const mine = threads.filter((t) => t.pending.some((m) => (m.mailboxes ?? []).includes(OWNER_MAILBOX)) || (t.inboxes ?? []).includes(OWNER_MAILBOX));
  const latestOf = (t: (typeof mine)[number]) => t.pending[t.pending.length - 1];
  // The Messages link (exact), and the delegation key (the same link, kept short enough to key a task).
  const hrefOf = (t: (typeof mine)[number]) => waitingReplyHref("email", `${normalizeSubject(latestOf(t)?.subject)}::${t.clientId}`);
  const keyOf = (t: (typeof mine)[number]) => ed.emailThreadHref(latestOf(t)?.subject, t.clientId);
  const keyed = mine.map((t) => `deleg:${keyOf(t)}`.slice(0, 190));
  const oldestAt = mine.reduce<number | null>((m, t) => {
    const at = latestOf(t)?.at?.getTime();
    return at == null ? m : m == null ? at : Math.min(m, at);
  }, null);
  const [keyedTasks, threadTasks, issues, inbound, roster] = await Promise.all([
    keyed.length ? prisma.smartTask.findMany({ where: { dedupeKey: { in: keyed }, delegatedAt: { not: null }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true, dedupeKey: true } }).catch(() => []) : Promise.resolve([]),
    mine.length ? ed.openEmailDelegations(mine.map((t) => t.clientId)).catch(() => []) : Promise.resolve([]),
    prisma.clientIssue.findMany({ where: { dismissedAt: null, state: { in: ["OPEN", "UNRESOLVED"] }, clientId: { in: mine.map((t) => t.clientId).filter((x): x is string => !!x) } }, select: { clientId: true } }).catch(() => []),
    // The panel's reply box answers the comms-log row of the newest email they sent (Messages' own reply box).
    oldestAt != null
      ? prisma.commLog.findMany({ where: { channel: "email", direction: "in", externalId: { startsWith: "gmail-" }, occurredAt: { gte: new Date(oldestAt - 5 * 60_000) } }, select: { id: true, clientId: true, occurredAt: true, subject: true }, orderBy: { occurredAt: "desc" }, take: 400 }).catch(() => [])
      : Promise.resolve([]),
    listAssignees().catch(() => []),
  ]);
  const views = await delegationFor([...mine.map((t) => t.openTaskId).filter((x): x is string => !!x), ...keyedTasks.map((t) => t.id), ...threadTasks.map((t) => t.id)]).catch(() => new Map<string, DelegatedTaskView>());
  const keyedBy = new Map(keyedTasks.map((t) => [t.dedupeKey, t.id]));
  const complaint = new Set(issues.map((i) => i.clientId));
  const office = await kylePerson(roster).catch(() => null);
  const officeKey = office?.key ?? roster.find((a) => a.key === "kyle")?.key ?? null;
  const due = await ed.replyDueAt(now);
  const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n);
  const rows: EmailRow[] = [];
  for (const t of mine) {
    const latest = latestOf(t);
    const href = hrefOf(t);
    const key = keyOf(t);
    // Who has it: the thread's own delegation, then the one keyed to its link, then a reply to-do delegated before Oct 27.
    const byThread = threadTasks.find((d) => ed.threadMatches(d.ref, t.clientId, t.pending.map((m) => m.subject)));
    const delegated = (byThread ? views.get(byThread.id) : undefined) ?? views.get(keyedBy.get(`deleg:${key}`.slice(0, 190)) ?? "") ?? (t.openTaskId ? views.get(t.openTaskId) : undefined);
    const otherInbox = (t.inboxes ?? []).some((b) => b !== OWNER_MAILBOX);
    const cls: EmailClass = delegated ? "waiting" : t.clientId && complaint.has(t.clientId) ? "decide" : otherInbox ? "team" : "reply";
    counts[cls]++;
    const lastOurs = [...t.turns].reverse().find((x) => x.role === "us");
    const at = latest?.at?.getTime() ?? null;
    const sameSender = inbound.filter((r) => (r.clientId ?? null) === (t.clientId ?? null));
    const commLogId = (at != null ? sameSender.find((r) => Math.abs(r.occurredAt.getTime() - at) < 2 * 60_000) : undefined)?.id
      ?? sameSender.find((r) => normalizeSubject(r.subject) === normalizeSubject(latest?.subject))?.id
      ?? null;
    rows.push({
      key: t.key,
      cls,
      handledBy: delegated ? `${delegated.assigneeName ?? "Someone"} · ${STATE_WORDS[delegated.state].toLowerCase()}` : cls === "team" ? "Also in the office inbox" : null,
      sender: t.displayName,
      subject: latest?.subject?.trim() || "(no subject)",
      summary: (latest?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 180),
      waitingSinceISO: t.waitingSince.toISOString(),
      businessHours: rules ? Math.round(cov.coveredHoursBetween(t.waitingSince, now, rules) * 10) / 10 : null,
      client: t.clientName,
      clientId: t.clientId,
      projectId: t.projectId,
      lastExchange: lastOurs?.at ? `Our last reply ${etDateTime(lastOurs.at)}` : "No reply from us in this thread yet",
      replyHref: href,
      groupKey: t.groupKey,
      threadKey: t.key,
      taskId: t.openTaskId,
      // Keyed to the THREAD (never the client's reply to-do), to the office, by 5 PM (the Loom, 6:00: "should probably automatically be delegated to Kyle").
      assign: { title: `Reply to ${t.displayName}: ${latest?.subject?.trim() || "their email"}`.slice(0, 140), outcome: "The client has an answer", assigneeKey: officeKey, dueAt: due, sourceTaskId: null, sourceHref: key, clientId: t.clientId, projectId: t.projectId },
      lastFromThem: latest ? { atISO: latest.at.toISOString(), text: clip(latest.body, 1500) } : null,
      lastFromUs: lastOurs ? { atISO: lastOurs.at, text: clip(lastOurs.text, 1500) } : null,
      thread: t.turns.slice(-10).map((x) => ({ role: x.role, atISO: x.at ?? null, text: clip(x.text, 1200) })),
      commLogId,
      delegated: delegated ? { taskId: delegated.taskId, assignee: delegated.assigneeName ?? "Someone", state: STATE_WORDS[delegated.state], dueISO: delegated.dueAt } : null,
    });
  }
  const order: Record<EmailClass, number> = { decide: 0, reply: 1, team: 2, waiting: 3 };
  rows.sort((a, b) => order[a.cls] - order[b.cls] || a.waitingSinceISO.localeCompare(b.waitingSinceISO));
  return { rows, counts, connected, note: "Unanswered client email in your inbox. Read is not answered; a draft is not sent.", unavailable: [] };
}

// =====================================================================================
// H. DELEGATED BY ME
// =====================================================================================

export type DelegatedRow = DelegatedTaskView & { resurface: Resurface | null };
export type DelegatedByMe = { rows: DelegatedRow[]; open: number; flagged: number; unavailable: string[] };

export async function delegatedByMe(opts: { now?: Date; email: string | null; emails?: string[] }): Promise<DelegatedByMe> {
  const now = opts.now ?? new Date();
  const emails = [...(opts.emails ?? []), ...(opts.email ? [opts.email] : [])];
  if (!emails.length) return { rows: [], open: 0, flagged: 0, unavailable: [] };
  const list = await tasksDelegatedByAny(emails, { now }).catch(warn("delegated"));
  if (!list) return { rows: [], open: 0, flagged: 0, unavailable: ["your assignments"] };
  const rows = list.map((d) => ({ ...d, resurface: resurfaceOf(d, now) }));
  rows.sort((a, b) => Number(!!b.resurface) - Number(!!a.resurface) || Number(b.state !== "COMPLETED" && b.state !== "CANCELLED") - Number(a.state !== "COMPLETED" && a.state !== "CANCELLED") || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
  return {
    rows,
    open: rows.filter((r) => r.state !== "COMPLETED" && r.state !== "CANCELLED").length,
    flagged: rows.filter((r) => !!r.resurface).length,
    unavailable: [],
  };
}

