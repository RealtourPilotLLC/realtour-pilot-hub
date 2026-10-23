import "server-only";
import { prisma } from "@/lib/prisma";
import { stripQuotedReply } from "@/lib/text";
import { streetCore } from "@/lib/contacts";

// ---------------------------------------------------------------------------
// A TEAM ASSISTANT'S MESSAGE GOES TO THE AGENT WHOSE JOB IT NAMES (Oct 23 2026).
//
// Olivia Vecere is an assistant on the Gary Mercer Team. Her mail is about
// Sharra Mercer's jobs (the Sussex videos, 1337 Carolannes Way), Mike
// Flatley's (2 Quail Run Ln) and Joe Sutow's (2402 Hickory Hill Rd). In Aryeo
// she sits on "Mike Flatley's Team", so the customer-team fold
// (integrations/aryeo.ts syncAryeoCustomerTeams) put her under Mike Flatley
// and every email and text she sent filed there. Her Oct 21 final change
// request for Sharra's Sussex videos landed on Mike's 913 Lakeview Ct and
// never reached an editor. Jordan: "Go ahead and fix Olivia's routing too."
//
// THE RULE. A message from a client who is a folded assistant (parentClientId)
// or a member of an Aryeo customer team with someone else on it goes to the
// team agent whose OWN job it names. Nothing named: today's routing (the
// parent agent, or the sender), unchanged.
//
//   The candidate agents: the parent (or the sender); everyone on the
//   sender's Aryeo team (and on the parent's); everyone whose email or backup
//   email is on the sender's company domain (never a free mailbox: gmail,
//   yahoo, outlook, icloud ...). Anyone folded under one of them counts as
//   that agent. On garymercerteam.com that is Sharra Mercer, Gary Mercer Sr,
//   Gary Mercer Jr, Kim Mazzenga, Joseph Sutow (his backup email) and Mike
//   Flatley.
//
//   "Names a job": the house number and street of a candidate's job ("34
//   Oakland", "2 QUAIL RUN", "859 N Lawrence"), or a link to the job's own
//   listing page (media.realtourpilot.com/listings/<id>). Read the subject
//   first, then the sender's own words, then the thread quoted below them.
//   An address (or listing) that is a job of two or more clients names
//   nobody: the team office in every Gary Mercer Team signature (893 S
//   Matlack St is a job of Sharra, Joe Sutow and Gary Sr) is not a listing.
//   Several jobs named at the same depth: the parent's own wins (it stays
//   where today's routing puts it), else the job in flight, else the newest.
//
//   The parent's own job named in the subject by its street ("Flatley Appt
//   Quail Run") also keeps the message with the parent, as today.
//
// Everything else is as it was: staff mail stays staff (lib/staffEmail), a
// sender the hub does not know is never matched by a street, a solo client is
// unchanged, and the hand-set agent in client_team_overrides (the fold's
// own setting) still decides who the parent is.
//
// One rule, used by the Gmail scan (integrations/google.ts), the OpenPhone
// receiver for texts and call notes (contacts.resolveClientByPhones), the ask
// filing (clientAsks.fileAsksFromMessage), the info@ re-file
// (scripts/_live/oct23-info-mail-refile-v2.ts) and the repair
// (scripts/_live/oct23-team-assistant-refile.ts).
// ---------------------------------------------------------------------------

/** A mailbox anyone can have: never a company, never a team. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net",
  "cox.net", "charter.net", "earthlink.net", "optonline.net", "ptd.net", "frontier.com", "windstream.net", "rcn.com",
  "juno.com", "netzero.net", "protonmail.com", "proton.me", "gmx.com", "mail.com", "zoho.com", "yandex.com",
]);
const OUR_DOMAIN = "realtourpilot.com";

/** The company domain of an address, or null for a free mailbox, our own domain or no address. */
export function companyDomain(address: string | null | undefined): string | null {
  const a = (address ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return null;
  const d = a.slice(at + 1);
  if (!d.includes(".") || FREE_MAIL_DOMAINS.has(d) || d === OUR_DOMAIN) return null;
  return d;
}

// ---- the job matcher ---------------------------------------------------------

const DIR = "(?:(?:n|s|e|w|north|south|east|west)\\.?\\s+)?";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LISTING_LINK = /\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const IN_FLIGHT = new Set(["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"]);

/** A job's house number and first street word ("512 firethorn"), and the pattern that finds it in words. */
export function jobAddressKey(p: { title: string; addressLine: string | null }): { key: string; re: RegExp } | null {
  const m = new RegExp(`^(\\d+[a-z]?)\\s+${DIR}([a-z0-9'-]+)`, "i").exec((p.addressLine || p.title.split(",")[0]).trim());
  return m ? { key: `${m[1]} ${m[2]}`.toLowerCase(), re: new RegExp(`\\b${esc(m[1])}\\s+${DIR}${esc(m[2])}\\b`, "i") } : null;
}

export type DirClient = { id: string; name: string; email: string | null; backupEmail: string | null; parentClientId: string | null; aryeoTeamId: string | null };
export type DirJob = {
  id: string; title: string; status: string; clientId: string;
  /** the client the job files on: the job's client, folded onto their agent */
  root: string;
  key: string | null; re: RegExp | null; core: RegExp | null; listingId: string | null;
  inFlight: boolean;
  /** position in newest-order-first order (lower = newer) */
  rank: number;
};
export type TeamDirectory = {
  clients: Map<string, DirClient>;
  jobs: DirJob[];
  /** an address key → the agents (roots) with a job there */
  rootsOfKey: Map<string, Set<string>>;
  rootsOfListing: Map<string, Set<string>>;
  root: (clientId: string) => string;
};

/** Build the directory from rows (pure: the loader below and a drill both use it). Jobs newest order first. */
export function buildTeamDirectory(
  clients: DirClient[],
  jobs: { id: string; title: string; addressLine: string | null; status: string; clientId: string | null; aryeoListingId: string | null }[],
): TeamDirectory {
  const byId = new Map(clients.map((c) => [c.id, c]));
  // One hop, as the fold and every receiver read it (toAgent / effectiveClientWithProject).
  const root = (id: string) => {
    const p = byId.get(id)?.parentClientId;
    return p && byId.has(p) ? p : id;
  };
  const out: DirJob[] = [];
  const rootsOfKey = new Map<string, Set<string>>();
  const rootsOfListing = new Map<string, Set<string>>();
  jobs.forEach((p, i) => {
    if (!p.clientId || p.status === "CANCELLED") return;
    const k = jobAddressKey(p);
    const core = streetCore(p.addressLine || p.title).toLowerCase();
    const j: DirJob = {
      id: p.id, title: p.title, status: p.status, clientId: p.clientId, root: root(p.clientId),
      key: k?.key ?? null, re: k?.re ?? null,
      core: core.length >= 5 ? new RegExp(`\\b${esc(core)}\\b`, "i") : null,
      listingId: p.aryeoListingId?.toLowerCase() ?? null,
      inFlight: IN_FLIGHT.has(p.status), rank: i,
    };
    out.push(j);
    if (j.key) rootsOfKey.set(j.key, (rootsOfKey.get(j.key) ?? new Set<string>()).add(j.root));
    if (j.listingId) rootsOfListing.set(j.listingId, (rootsOfListing.get(j.listingId) ?? new Set<string>()).add(j.root));
  });
  return { clients: byId, jobs: out, rootsOfKey, rootsOfListing, root };
}

/** Every client and every job, newest order first: one read. */
export async function loadTeamDirectory(): Promise<TeamDirectory> {
  const [clients, jobs] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true, email: true, backupEmail: true, parentClientId: true, aryeoTeamId: true } }),
    prisma.project.findMany({
      where: { status: { not: "CANCELLED" } },
      orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { shootDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { id: true, title: true, addressLine: true, status: true, clientId: true, aryeoListingId: true },
    }),
  ]);
  return buildTeamDirectory(clients, jobs);
}

export type MessageTier = "subject" | "words" | "thread";
const flat = (s: string) => s.replace(/^[ \t]*(?:>[ \t]*)+/gm, "").replace(/\s+/g, " ").trim();

/** Where a message can name a job, most telling first: the subject, the sender's own words, the thread quoted below. */
export function messageTiers(m: { subject?: string | null; body?: string | null }): { tier: MessageTier; text: string }[] {
  const body = m.body ?? "";
  const own = body ? stripQuotedReply(body) : "";
  const tiers: { tier: MessageTier; text: string }[] = [];
  if (m.subject?.trim()) tiers.push({ tier: "subject", text: flat(m.subject) });
  if (own.trim()) tiers.push({ tier: "words", text: flat(own) });
  if (body.trim() && flat(body) !== flat(own)) tiers.push({ tier: "thread", text: flat(body) });
  return tiers;
}

/** The jobs these words name (house number and street, or the listing link), among `roots` (null = anyone's). An address or listing that is two or more clients' job names nobody. */
export function jobsNamedIn(dir: TeamDirectory, text: string, roots: Set<string> | null): DirJob[] {
  if (!text) return [];
  const links = new Set<string>();
  for (const m of text.matchAll(LISTING_LINK)) links.add(m[1].toLowerCase());
  return dir.jobs.filter((j) => {
    if (roots && !roots.has(j.root) && !roots.has(j.clientId)) return false;
    if (j.listingId && links.has(j.listingId) && (dir.rootsOfListing.get(j.listingId)?.size ?? 0) < 2) return true;
    return !!j.key && !!j.re && (dir.rootsOfKey.get(j.key)?.size ?? 0) < 2 && j.re.test(text);
  });
}

/** Among named jobs: the one in flight, else the newest. */
export function preferredJob(jobs: DirJob[]): DirJob | null {
  return [...jobs].sort((a, b) => Number(b.inFlight) - Number(a.inFlight) || a.rank - b.rank)[0] ?? null;
}

/** One client's job a message names, subject first (the info@ re-file v2 reads this per candidate client). */
export function namedJobOf(dir: TeamDirectory, clientId: string, m: { subject?: string | null; body?: string | null }): DirJob | null {
  const only = new Set([clientId]);
  for (const t of messageTiers(m)) {
    const hit = preferredJob(jobsNamedIn(dir, t.text, only));
    if (hit) return hit;
  }
  return null;
}

// ---- who a team sender's message can be about ---------------------------------

export type TeamCandidates = {
  sender: DirClient;
  /** today's routing: the parent agent, or the sender */
  defaultId: string;
  /** every candidate agent (roots), the default included */
  roots: Set<string>;
};

/** The agents a folded assistant's or team member's message can be about; null for a client with no team (unchanged routing). */
export function teamCandidates(dir: TeamDirectory, senderClientId: string): TeamCandidates | null {
  const sender = dir.clients.get(senderClientId);
  if (!sender) return null;
  const parent = sender.parentClientId ? dir.clients.get(sender.parentClientId) ?? null : null;
  const all = [...dir.clients.values()];
  const teamOf = (teamId: string | null) => (teamId ? all.filter((c) => c.aryeoTeamId === teamId) : []);
  const teammates = teamOf(sender.aryeoTeamId).filter((c) => c.id !== sender.id);
  if (!parent && teammates.length === 0) return null;
  const defaultId = dir.root(sender.id);
  const members = new Set<string>([defaultId, sender.id]);
  for (const c of [...teammates, ...teamOf(parent?.aryeoTeamId ?? null)]) members.add(c.id);
  const domains = new Set([companyDomain(sender.email), companyDomain(sender.backupEmail)].filter((d): d is string => !!d));
  if (domains.size) for (const c of all) if ([c.email, c.backupEmail].some((a) => { const d = companyDomain(a); return !!d && domains.has(d); })) members.add(c.id);
  // Anyone folded under one of them is that agent (their root).
  return { sender, defaultId, roots: new Set([...members].map(dir.root)) };
}

export type TeamRoute = {
  clientId: string;
  clientName: string;
  project: { id: string; title: string; status: string };
  tier: MessageTier;
  /** plain words for a log line or a dry run */
  how: string;
};
export type TeamDecision =
  | { action: "move"; route: TeamRoute; defaultId: string }
  | { action: "stay"; why: string; defaultId: string; job: DirJob | null }
  | { action: "none"; why: string; defaultId: string | null };

/**
 * The rule, over a loaded directory (pure). "move": the message names another
 * team agent's job. "stay": it names the default's own job, or none (today's
 * routing decides). "none": the sender has no team (unchanged).
 */
export function decideTeamRoute(dir: TeamDirectory, senderClientId: string, m: { subject?: string | null; body?: string | null }): TeamDecision {
  const cand = teamCandidates(dir, senderClientId);
  if (!cand) return { action: "none", why: "not a folded assistant or a team member", defaultId: null };
  const def = cand.defaultId;
  const defName = dir.clients.get(def)?.name ?? "the agent";
  // The parent's own job named in the subject by its street, as today's router reads it.
  const subject = flat(m.subject ?? "");
  if (subject) {
    const own = dir.jobs.find((j) => j.root === def && j.core?.test(subject));
    if (own) return { action: "stay", why: `the subject names ${defName}'s own ${own.title.split(",")[0]}`, defaultId: def, job: own };
  }
  for (const t of messageTiers(m)) {
    const hits = jobsNamedIn(dir, t.text, cand.roots);
    if (!hits.length) continue;
    const mine = preferredJob(hits.filter((j) => j.root === def));
    if (mine) return { action: "stay", why: `the ${t.tier === "subject" ? "subject" : t.tier === "words" ? "message" : "quoted thread"} names ${defName}'s own ${mine.title.split(",")[0]}`, defaultId: def, job: mine };
    const best = preferredJob(hits)!;
    const to = dir.clients.get(best.root);
    const where = t.tier === "subject" ? "the subject" : t.tier === "words" ? "the message" : "the quoted thread";
    return {
      action: "move",
      defaultId: def,
      route: {
        clientId: best.root,
        clientName: to?.name ?? "",
        project: { id: best.id, title: best.title, status: best.status },
        tier: t.tier,
        how: `${where} names ${to?.name ?? "a team agent"}'s ${best.title.split(",")[0]}${hits.length > 1 ? ` (${hits.length} team jobs named; ${best.inFlight ? "the one in flight" : "the newest"})` : ""}`,
      },
    };
  }
  return { action: "stay", why: "names no team agent's job", defaultId: def, job: null };
}

/** Is this client a folded assistant or on a team with someone else? Two small reads, nothing loaded for a solo client. */
export async function isTeamSender(clientId: string): Promise<boolean> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { parentClientId: true, aryeoTeamId: true } });
  if (!c) return false;
  if (c.parentClientId) return true;
  if (!c.aryeoTeamId) return false;
  return (await prisma.client.count({ where: { aryeoTeamId: c.aryeoTeamId, id: { not: clientId } } })) > 0;
}

/**
 * The receivers' entry point: the team agent and job this message belongs to,
 * or null to keep today's routing. `senderClientId` is the sender's OWN client
 * row (before the assistant → agent fold). A solo client costs one small read
 * and loads nothing; `directory` lets a scan load the team directory once for
 * many messages. Never throws (a failure keeps today's routing).
 */
export async function routeTeamMessage(input: {
  senderClientId: string | null | undefined;
  subject?: string | null;
  body?: string | null;
  directory?: () => Promise<TeamDirectory>;
}): Promise<TeamRoute | null> {
  try {
    if (!input.senderClientId || !(await isTeamSender(input.senderClientId))) return null;
    const dir = input.directory ? await input.directory() : await loadTeamDirectory();
    const d = decideTeamRoute(dir, input.senderClientId, { subject: input.subject, body: input.body });
    return d.action === "move" ? d.route : null;
  } catch (e) {
    console.error("[team-routing] kept today's routing", input.senderClientId, e);
    return null;
  }
}

/**
 * OUR REPLY TO A TEAM ASSISTANT stays in her conversation. When our reply
 * names a team agent's job, that job; when it names none, the client her last
 * message on this lane was filed on (the same thread subject for email, her
 * number for a text, within 14 days), when that is another team agent. So "On
 * it!" to Olivia's text about 1337 Carolannes Way answers Sharra's open
 * question, not Mike's. Null keeps today's routing. Never throws.
 */
export async function routeTeamReply(input: {
  recipientClientId: string | null | undefined;
  channel: "email" | "text";
  subject?: string | null;
  body?: string | null;
  /** the recipient's 10-digit number (texts) */
  phone?: string | null;
  /** the thread's subject key (email), as replyQueue.threadSubject reads it */
  threadKey?: string | null;
  directory?: () => Promise<TeamDirectory>;
  now?: Date;
}): Promise<{ clientId: string; clientName: string; projectId: string | null; how: string } | null> {
  try {
    if (!input.recipientClientId || !(await isTeamSender(input.recipientClientId))) return null;
    const dir = input.directory ? await input.directory() : await loadTeamDirectory();
    const d = decideTeamRoute(dir, input.recipientClientId, { subject: input.subject, body: input.body });
    if (d.action === "move") return { clientId: d.route.clientId, clientName: d.route.clientName, projectId: d.route.project.id, how: `our reply: ${d.route.how}` };
    if (d.action !== "stay" || d.job) return null; // no team, or our reply names the parent's own job
    const cand = teamCandidates(dir, input.recipientClientId);
    if (!cand) return null;
    const since = new Date((input.now ?? new Date()).getTime() - 14 * 86_400_000);
    const others = [...cand.roots].filter((r) => r !== cand.defaultId);
    if (!others.length) return null;
    let last: { clientId: string | null; projectId: string | null } | null = null;
    if (input.channel === "text" && input.phone) {
      last = await prisma.commLog.findFirst({ where: { channel: "text", direction: "in", fromPhone: input.phone, occurredAt: { gte: since } }, orderBy: { occurredAt: "desc" }, select: { clientId: true, projectId: true } });
    } else if (input.channel === "email" && input.threadKey) {
      const { threadSubject } = await import("@/lib/replyQueue");
      const rows = await prisma.commLog.findMany({
        where: { channel: "email", direction: "in", clientId: { in: [...cand.roots] }, occurredAt: { gte: since } },
        orderBy: { occurredAt: "desc" },
        take: 60,
        select: { clientId: true, projectId: true, subject: true },
      });
      last = rows.find((r) => threadSubject(r.subject) === input.threadKey) ?? null;
    }
    if (!last?.clientId || !others.includes(last.clientId)) return null;
    return { clientId: last.clientId, clientName: dir.clients.get(last.clientId)?.name ?? "", projectId: last.projectId, how: "our reply follows her last message on this lane" };
  } catch (e) {
    console.error("[team-routing] reply kept today's routing", input.recipientClientId, e);
    return null;
  }
}
