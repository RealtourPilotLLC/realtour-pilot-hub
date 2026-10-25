import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayStartUtc } from "@/lib/datetime";
import type { ProjectStatus } from "@prisma/client";
import {
  allOpenPhoneContacts,
  contactPhoneValues,
  contactEmailValues,
  phoneKey,
} from "@/lib/integrations/openphone";

// ---------------------------------------------------------------------------
// Sync every OpenPhone/HubSpot contact and reconcile it to a client, so an
// inbound text or call from ANY known number — including a client's secondary
// line that isn't on their Aryeo record — resolves to the right project.
// ---------------------------------------------------------------------------

function nameKey(first?: string | null, last?: string | null, full?: string | null): string {
  const s = (full ?? `${first ?? ""} ${last ?? ""}`).toLowerCase();
  return s.replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

export async function syncOpenPhoneContacts(): Promise<{
  contacts: number;
  matchedToClients: number;
  clientsReached: number;
}> {
  // Build client lookup indexes (phone / email / name → clientId).
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, email: true, phone: true },
  });
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string | null>(); // null = ambiguous (>1 client)
  for (const c of clients) {
    const pk = phoneKey(c.phone);
    if (pk.length === 10) byPhone.set(pk, c.id);
    if (c.email) byEmail.set(c.email.toLowerCase(), c.id);
    const nk = nameKey(null, null, c.name);
    if (nk) byName.set(nk, byName.has(nk) ? null : c.id);
  }

  const contacts = await allOpenPhoneContacts();
  const reached = new Set<string>();
  let matched = 0;

  for (const c of contacts) {
    if (!c.id) continue;
    const phones = contactPhoneValues(c);
    const emails = contactEmailValues(c);
    const first = c.defaultFields?.firstName ?? null;
    const last = c.defaultFields?.lastName ?? null;

    // Resolve to a client: phone first (strongest), then email, then a unique name.
    let clientId: string | undefined;
    for (const p of phones) {
      const hit = byPhone.get(phoneKey(p));
      if (hit) { clientId = hit; break; }
    }
    if (!clientId) for (const e of emails) {
      const hit = byEmail.get(e.toLowerCase());
      if (hit) { clientId = hit; break; }
    }
    if (!clientId) {
      const nk = nameKey(first, last);
      const hit = nk ? byName.get(nk) : undefined;
      if (hit) clientId = hit; // null (ambiguous) is falsy → skipped
    }
    if (clientId) { matched++; reached.add(clientId); }

    const data = {
      firstName: first,
      lastName: last,
      company: c.defaultFields?.company ?? null,
      email: emails[0] ?? null,
      phones: phones.length ? JSON.stringify(phones) : null,
      source: c.source ?? null,
      externalId: c.externalId ?? null,
      clientId: clientId ?? null,
    };
    await prisma.contact.upsert({
      where: { openPhoneId: c.id },
      create: { openPhoneId: c.id, ...data },
      update: data,
    });
  }

  return { contacts: contacts.length, matchedToClients: matched, clientsReached: reached.size };
}

const RECENT_PROJECT_ORDER = [
  { orderedAt: { sort: "desc", nulls: "last" } },
  { shootDate: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
] as const;

// The project a client's message is most likely ABOUT, absent any street match:
// their next upcoming shoot, else the most recent still-active job, else the
// most recent overall. "Most recent overall" alone (the old rule) pinned a
// client's new ask to a job delivered months ago while their live shoots sat
// unmentioned (audit: Jesse's Zillow ask on a 133-day-old delivery).
export async function mostRelevantProject(clientId: string): Promise<
  { id: string; title: string; status: string } | null
> {
  const rows = await prisma.project.findMany({
    where: { clientId },
    orderBy: [...RECENT_PROJECT_ORDER],
    select: { id: true, title: true, status: true, shootDate: true },
  });
  if (rows.length === 0) return null;
  const todayEt = etDayStartUtc();
  const upcoming = rows
    .filter((p) => p.status !== "CANCELLED" && p.shootDate && p.shootDate >= todayEt)
    .sort((a, b) => a.shootDate!.getTime() - b.shootDate!.getTime())[0];
  const pick =
    upcoming ??
    rows.find((p) => (ACTIVE_PROJECT_STATUSES as string[]).includes(p.status)) ??
    rows[0];
  return { id: pick.id, title: pick.title, status: pick.status };
}

// The client's newest job that can actually RECEIVE a revision (delivered or
// already in the review/revision loop). A revision-classified message must
// anchor here, never to an upcoming shoot: the DELIVERED_ISH gates downstream
// silently DROP the revision when the anchored project is pre-delivery
// (mostRelevantProject prefers the next shoot — right for scheduling chatter,
// wrong for "can you brighten the kitchen photos?").
export async function mostRecentDeliveredIsh(clientId: string): Promise<
  { id: string; title: string; status: string } | null
> {
  return prisma.project.findFirst({
    where: { clientId, status: { in: ["DELIVERED", "REVISION", "REVIEW"] } },
    orderBy: [...RECENT_PROJECT_ORDER],
    select: { id: true, title: true, status: true },
  });
}

// Resolve a client id to the EFFECTIVE comms target + their most relevant
// project. If the client is a folded team assistant (parentClientId set — e.g.
// Kelly on Jamie's team), hop to the agent so the order/task/activity lands on
// the agent (that's where the projects live). Otherwise it's the client themselves.
// `identified`: the signal pointed at this ONE row, so its own name is the
// person who wrote in (senderName) — see resolveClientByPhones.
async function effectiveClientWithProject(clientId: string, identified = false): Promise<{
  clientId: string;
  clientName: string;
  project: { id: string; title: string; status: string } | null;
  senderName: string | null;
  senderClientId: string | null;
} | null> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, parentClientId: true },
  });
  if (!c) return null;
  const targetId = c.parentClientId ?? c.id;
  let targetName = c.name;
  if (c.parentClientId) {
    const parent = await prisma.client.findUnique({ where: { id: c.parentClientId }, select: { name: true } });
    if (parent) targetName = parent.name;
  }
  const project = await mostRelevantProject(targetId);
  return { clientId: targetId, clientName: targetName, project, senderName: identified ? c.name : null, senderClientId: identified ? c.id : null };
}

// Resolve an inbound set of phone numbers to a client id, checking both client
// records and synced contacts (which carry alternate numbers). Returns the
// client id + their most recent project, or null. Folds team assistants to
// their agent so comms route to where the orders are.
//
// senderName (Sep 28): WHO wrote in, by the matched row's OWN name — an
// assistant folded onto the agent is still herself, not the agent. Only when
// the phone pointed at exactly one client row: a number two rows share (or a
// synced contact's alternate number) cannot say which person is typing, so it
// is null and nobody is named rather than guessing the account holder.
//
// A TEAM ASSISTANT'S TEXT OR CALL (Oct 23 2026, lib/teamRouting): with
// `opts.text`, when the number is exactly one client row and that row is a
// folded assistant or a team member, the message goes to the team agent whose
// own job it names (house number and street, or its listing link), and
// `projectNamed` says the job was named. Olivia Vecere's number folds onto
// Mike Flatley; her text about Sharra Mercer's 1337 Carolannes Way is
// Sharra's. With `opts.reply` (our own text TO that number) and no job named,
// it stays in her conversation: the team agent her last text was filed on.
// Nothing named: the fold, as before.
export async function resolveClientByPhones(phones: string[], opts: { text?: string | null; reply?: boolean } = {}): Promise<{
  clientId: string;
  clientName: string;
  project: { id: string; title: string; status: string } | null;
  senderName: string | null;
  /** the job was named in the message (team routing), not the router's guess */
  projectNamed?: boolean;
  /** the matched row's own id when the number is that one row (before the fold) */
  senderClientId?: string | null;
} | null> {
  const keys = new Set(phones.map((p) => phoneKey(p)).filter((k) => k.length === 10));
  if (keys.size === 0) return null;

  // 1) Direct client phone match — collect EVERY row that matches, then rank.
  // A phone can legitimately hit more than one row (a re-minted twin, or two
  // rows pending a merge); the old unordered .find() picked whichever Postgres
  // returned first, which could dodge the clientId-scoped task auto-close.
  const clientCandidates = await prisma.client.findMany({
    where: { phone: { not: null } },
    select: {
      id: true,
      name: true,
      phone: true,
      parentClientId: true,
      aryeoCustomerId: true,
      createdAt: true,
      projects: {
        // Most-RECENT real order, not import order. createdAt is the backfill
        // time (≈same for all), so order by the Aryeo order date / shoot date.
        orderBy: [
          { orderedAt: { sort: "desc", nulls: "last" } },
          { shootDate: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        take: 1,
        select: { orderedAt: true, shootDate: true, createdAt: true },
      },
    },
  });
  const matches = clientCandidates.filter((c) => keys.has(phoneKey(c.phone)));
  const hit = rankClientRows(matches)[0];
  if (hit && matches.length === 1 && (opts.text?.trim() || opts.reply)) {
    const T = await import("@/lib/teamRouting");
    const team = opts.text?.trim() ? await T.routeTeamMessage({ senderClientId: hit.id, body: opts.text }) : null;
    if (team) return { clientId: team.clientId, clientName: team.clientName, project: team.project, senderName: hit.name, projectNamed: true, senderClientId: hit.id };
    const cont = opts.reply ? await T.routeTeamReply({ recipientClientId: hit.id, channel: "text", body: opts.text ?? "", phone: phoneKey(hit.phone) }) : null;
    if (cont) {
      const p = cont.projectId ? await prisma.project.findUnique({ where: { id: cont.projectId }, select: { id: true, title: true, status: true } }) : null;
      return { clientId: cont.clientId, clientName: cont.clientName, project: p ?? (await mostRelevantProject(cont.clientId)), senderName: hit.name, projectNamed: false, senderClientId: hit.id };
    }
  }
  if (hit) return effectiveClientWithProject(hit.id, matches.length === 1);

  // 2) Fall back to a synced contact's alternate number linked to a client —
  // again collecting all matches before ranking.
  const linked = await prisma.contact.findMany({
    where: { clientId: { not: null } },
    select: { phones: true, clientId: true },
  });
  const linkedIds = new Set<string>();
  for (const ct of linked) {
    let nums: string[] = [];
    try { nums = ct.phones ? (JSON.parse(ct.phones) as string[]) : []; } catch { nums = []; }
    if (nums.some((n) => keys.has(phoneKey(n)))) linkedIds.add(ct.clientId!);
  }
  if (linkedIds.size === 1) return effectiveClientWithProject([...linkedIds][0]);
  if (linkedIds.size > 1) {
    const rows = await prisma.client.findMany({
      where: { id: { in: [...linkedIds] } },
      select: {
        id: true, name: true, parentClientId: true, aryeoCustomerId: true, createdAt: true,
        projects: {
          orderBy: [
            { orderedAt: { sort: "desc", nulls: "last" } },
            { shootDate: { sort: "desc", nulls: "last" } },
            { createdAt: "desc" },
          ],
          take: 1,
          select: { orderedAt: true, shootDate: true, createdAt: true },
        },
      },
    });
    const best = rankClientRows(rows)[0];
    if (best) return effectiveClientWithProject(best.id);
  }
  return null;
}

// Deterministic pick among client rows that all matched the same signal:
// prefer the agent over a folded assistant, then the row with the freshest
// project activity, then a row with an Aryeo identity, then the OLDEST row
// (the canonical original beats a freshly-minted twin).
export function rankClientRows<T extends {
  id: string;
  parentClientId: string | null;
  aryeoCustomerId: string | null;
  createdAt: Date;
  projects: { orderedAt: Date | null; shootDate: Date | null; createdAt: Date }[];
}>(rows: T[]): T[] {
  const activity = (r: T) => {
    const p = r.projects[0];
    if (!p) return 0;
    return Math.max(p.orderedAt?.getTime() ?? 0, p.shootDate?.getTime() ?? 0, p.createdAt.getTime());
  };
  return [...rows].sort((a, b) => {
    const child = Number(a.parentClientId !== null) - Number(b.parentClientId !== null);
    if (child !== 0) return child;
    const act = activity(b) - activity(a);
    if (act !== 0) return act;
    const aryeo = Number(b.aryeoCustomerId !== null) - Number(a.aryeoCustomerId !== null);
    if (aryeo !== 0) return aryeo;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

// Who is this single phone number? Checks team members, then clients, then
// synced contacts. Lets the comms webhook recognize NON-client senders — a
// photographer (Harrison) or a client-side coordinator (Ruthie) — so their
// project instructions can be filed against the right job.
export async function resolveSenderName(phone: string): Promise<
  { name: string; isTeam: boolean; clientId: string | null } | null
> {
  const k = phoneKey(phone);
  if (k.length !== 10) return null;

  const team = await prisma.teamMember.findMany({
    where: { phone: { not: null } },
    select: { name: true, phone: true },
  });
  const tm = team.find((t) => phoneKey(t.phone) === k);
  if (tm) return { name: tm.name, isTeam: true, clientId: null };

  const clients = await prisma.client.findMany({
    where: { phone: { not: null } },
    select: { id: true, name: true, phone: true },
  });
  const cl = clients.find((c) => phoneKey(c.phone) === k);
  if (cl) return { name: cl.name, isTeam: false, clientId: cl.id };

  const contacts = await prisma.contact.findMany({
    where: { phones: { not: null } },
    select: { firstName: true, lastName: true, company: true, phones: true, clientId: true },
  });
  for (const ct of contacts) {
    let nums: string[] = [];
    try { nums = ct.phones ? (JSON.parse(ct.phones) as string[]) : []; } catch { nums = []; }
    if (nums.some((n) => phoneKey(n) === k)) {
      const name = [ct.firstName, ct.lastName].filter(Boolean).join(" ").trim() || ct.company || "";
      if (name) return { name, isTeam: false, clientId: ct.clientId };
    }
  }
  return null;
}

// Find the active project a message is ABOUT, by matching a project's street
// name inside the text (e.g. "Virtual staging for Steeplechase" → 2443
// Steeplechase Dr). Returns the most specific (longest) match, or null.
const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = [
  "BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION",
];
const STREET_SUFFIX =
  /\b(dr|drive|st|street|rd|road|ave|avenue|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|hwy|sq|square|run|trl|trail|loop|pike|row)\.?$/i;

export function streetCore(addr: string): string {
  let s = (addr.split(",")[0] || "").trim().replace(/^\d+\s+/, ""); // drop house number
  s = s.replace(STREET_SUFFIX, "").trim(); // drop the suffix (Dr/St/Rd…)
  return s;
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * HOW STRONGLY A MESSAGE NAMES THIS JOB (audit Oct 25 2026). 0 = it doesn't.
 * A bare street scores its core's length, as the finders always ranked it; the
 * house number right before the street ("1316 Blair") scores above every bare
 * street (1001-2000, earlier in the text higher). The longest core used to win outright, so a core that is also a
 * TOWN beat a real address: Kimberly Mazzenga's "Re: 1316 Blair
 * Updates/Showcase" (Mike Flatley's job) was filed to Marcee McMullen's 1244
 * West Chester Pike because her signature says "West Chester PA 19382". The
 * number and street together are the strongest thing a message can say.
 * Pure; every finder below and refileRecentCommsToProject share it.
 */
export function streetMatchScore(p: { title: string; addressLine: string | null }, text: string): number {
  const core = streetCore(p.addressLine || p.title).toLowerCase();
  if (core.length < 5) return 0;
  const re = new RegExp(`\\b${escapeRegExp(core)}\\b`, "i");
  if (!re.test(text)) return 0;
  // The number counts only right before the SAME core the bare rule matches
  // (direction and all). Deliberately no looser: every Gary Mercer team
  // signature carries "893 S. Matlack St", a job of Joe Sutow's, and a looser
  // number match would file the whole team's mail there.
  // Two numbered addresses: the one named FIRST wins (the subject and the
  // opening words name the property; a signature's office address comes last).
  const num = /^\s*(\d+[a-z]?)\s/i.exec((p.addressLine || p.title.split(",")[0] || "").trim())?.[1];
  const at = num ? text.search(new RegExp(`\\b${escapeRegExp(num)}\\s+${escapeRegExp(core)}\\b`, "i")) : -1;
  return at >= 0 ? 2000 - Math.min(at, 999) : core.length;
}

export async function findActiveProjectByText(
  text: string,
): Promise<{ id: string; title: string; status: string; clientId: string } | null> {
  const t = (text || "").toLowerCase();
  if (t.length < 4) return null;
  const projects = await prisma.project.findMany({
    where: { status: { in: ACTIVE_PROJECT_STATUSES } },
    select: { id: true, title: true, status: true, clientId: true, addressLine: true },
    orderBy: [{ shootDate: { sort: "desc", nulls: "last" } }],
  });
  let best: { id: string; title: string; status: string; clientId: string } | null = null;
  let bestScore = 0;
  for (const p of projects) {
    if (!p.clientId) continue;
    // Match the FULL street core as a whole word/phrase only. We deliberately do
    // NOT fall back to the bare last word: it is usually a common word ("Market",
    // "Run", "Way") that turns up in unrelated messages, and the old raw substring
    // test also matched "market" inside "marketing" — which once filed a note
    // about one client's video order onto a DIFFERENT client's "E Market St" job.
    const score = streetMatchScore(p, t);
    if (score > bestScore) {
      best = { id: p.id, title: p.title, status: p.status, clientId: p.clientId };
      bestScore = score;
    }
  }
  return best;
}

// Which project (any client) is a message about, by the street it names? Used to
// route a comm to the right LISTING even when the sender isn't that listing's
// client — e.g. a team coordinator or executive assistant emailing about an
// agent's property. Whole-word street-core match across all non-cancelled
// projects; most specific (longest) wins, ties break to the most recent.
export async function findProjectByText(
  text: string,
): Promise<{ id: string; title: string; status: string; clientId: string } | null> {
  const t = (text || "").toLowerCase();
  if (t.length < 4) return null;
  const projects = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    select: { id: true, title: true, status: true, clientId: true, addressLine: true },
    orderBy: [
      { orderedAt: { sort: "desc", nulls: "last" } },
      { shootDate: { sort: "desc", nulls: "last" } },
    ],
  });
  let best: { id: string; title: string; status: string; clientId: string } | null = null;
  let bestScore = 0;
  for (const p of projects) {
    if (!p.clientId) continue;
    const score = streetMatchScore(p, t);
    if (score > bestScore) {
      best = { id: p.id, title: p.title, status: p.status, clientId: p.clientId };
      bestScore = score;
    }
  }
  return best;
}

// Which of THIS client's properties is a message about? Scoped to one client and
// across ALL their projects (any status), so a multi-order client (e.g. an agent
// with several active listings) who texts about an older order doesn't get it
// filed on their most-recent order by default. Returns the most specific street
// match (longest core), preferring the most-recent on ties. Client-scoped, so it
// can never cross-file onto a different client's job.
// A new project's booking conversation predates the project row: texts/emails
// that NAMED this street were filed to the client's previous job (or left
// unfiled) because this project didn't exist yet to match. Re-point them the
// moment the project is created, with the same whole-word street-core matcher
// the live routers trust. (Review probe: ~15% of shoots had such rows in the
// 72h pre-shoot window — "1429 n 62nd ready tomorrow." filed to an old job.)
export async function refileRecentCommsToProject(project: {
  id: string;
  clientId: string | null;
  title: string;
  addressLine: string | null;
}): Promise<number> {
  if (!project.clientId) return 0;
  const core = streetCore(project.addressLine || project.title).toLowerCase();
  if (core.length < 5) return 0;
  // Only rows the routers were UNSURE about (unfiled, or a heuristic guess).
  // A NAMED filing on a sibling job stays put — review: "34 Adams Ct" must
  // not steal "N Adams" rows, and a same-street add-on order must not yank
  // the main job's access texts (they still surface on the new shoot's card
  // via the "+N on other jobs" count).
  const rows = await prisma.commLog.findMany({
    where: {
      clientId: project.clientId,
      occurredAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
      OR: [{ projectId: null }, { projectGuess: true }],
    },
    select: { id: true, subject: true, body: true, channel: true },
    orderBy: { occurredAt: "desc" },
    take: 200,
  });
  if (rows.length === 0) return 0;
  // The same longest-core-wins competition the live router runs: the new
  // project must be the BEST street match for the row, not merely A match —
  // and email rows are matched on the sender's OWN words (quoted history can
  // name other properties; the router strips it, so must we). Projects are
  // ordered like findClientProjectByText so ties resolve identically.
  const projects = await prisma.project.findMany({
    where: { clientId: project.clientId },
    select: { id: true, title: true, addressLine: true },
    orderBy: [
      { orderedAt: { sort: "desc", nulls: "last" } },
      { shootDate: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
  });
  const { stripQuotedReply, clip } = await import("@/lib/text");
  const ids: string[] = [];
  for (const r of rows) {
    const text = `${r.subject ?? ""} ${r.channel === "email" ? clip(stripQuotedReply(r.body), 2000) : r.body}`;
    let best: { id: string; score: number } | null = null;
    for (const p of projects) {
      const score = streetMatchScore(p, text);
      if (score > (best?.score ?? 0)) best = { id: p.id, score };
    }
    if (best?.id === project.id) ids.push(r.id);
  }
  if (ids.length === 0) return 0;
  await prisma.commLog.updateMany({
    where: { id: { in: ids } },
    data: { projectId: project.id, projectGuess: false },
  });
  return ids.length;
}

export async function findClientProjectByText(
  clientId: string,
  text: string,
): Promise<{ id: string; title: string; status: string } | null> {
  const t = (text || "").toLowerCase();
  if (t.length < 4) return null;
  const projects = await prisma.project.findMany({
    where: { clientId },
    select: { id: true, title: true, status: true, addressLine: true },
    orderBy: [
      { orderedAt: { sort: "desc", nulls: "last" } },
      { shootDate: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
  });
  let best: { id: string; title: string; status: string } | null = null;
  let bestScore = 0;
  for (const p of projects) {
    const score = streetMatchScore(p, t);
    if (score > bestScore) {
      best = { id: p.id, title: p.title, status: p.status };
      bestScore = score;
    }
  }
  return best;
}
