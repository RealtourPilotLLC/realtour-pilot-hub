import "server-only";
import { prisma } from "@/lib/prisma";
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

// Resolve a client id to the EFFECTIVE comms target + their most recent project.
// If the client is a folded team assistant (parentClientId set — e.g. Kelly on
// Jamie's team), hop to the agent so the order/task/activity lands on the agent
// (that's where the projects live). Otherwise it's the client themselves.
async function effectiveClientWithProject(clientId: string): Promise<{
  clientId: string;
  clientName: string;
  project: { id: string; title: string; status: string } | null;
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
  const project = await prisma.project.findFirst({
    where: { clientId: targetId },
    orderBy: [...RECENT_PROJECT_ORDER],
    select: { id: true, title: true, status: true },
  });
  return { clientId: targetId, clientName: targetName, project };
}

// Resolve an inbound set of phone numbers to a client id, checking both client
// records and synced contacts (which carry alternate numbers). Returns the
// client id + their most recent project, or null. Folds team assistants to
// their agent so comms route to where the orders are.
export async function resolveClientByPhones(phones: string[]): Promise<{
  clientId: string;
  clientName: string;
  project: { id: string; title: string; status: string } | null;
} | null> {
  const keys = new Set(phones.map((p) => phoneKey(p)).filter((k) => k.length === 10));
  if (keys.size === 0) return null;

  // 1) Direct client phone match.
  const clientCandidates = await prisma.client.findMany({
    where: { phone: { not: null } },
    select: {
      id: true,
      name: true,
      phone: true,
      projects: {
        // Most-RECENT real order, not import order. createdAt is the backfill
        // time (≈same for all), so order by the Aryeo order date / shoot date.
        orderBy: [
          { orderedAt: { sort: "desc", nulls: "last" } },
          { shootDate: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        take: 1,
        select: { id: true, title: true, status: true },
      },
    },
  });
  let hit = clientCandidates.find((c) => keys.has(phoneKey(c.phone)));

  // 2) Fall back to a synced contact's alternate number linked to a client.
  if (!hit) {
    const linked = await prisma.contact.findMany({
      where: { clientId: { not: null } },
      select: { phones: true, clientId: true },
    });
    let clientId: string | undefined;
    for (const ct of linked) {
      const nums: string[] = ct.phones ? JSON.parse(ct.phones) : [];
      if (nums.some((n) => keys.has(phoneKey(n)))) { clientId = ct.clientId!; break; }
    }
    if (clientId) return effectiveClientWithProject(clientId);
  }

  if (!hit) return null;
  return effectiveClientWithProject(hit.id);
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

function streetCore(addr: string): string {
  let s = (addr.split(",")[0] || "").trim().replace(/^\d+\s+/, ""); // drop house number
  s = s.replace(STREET_SUFFIX, "").trim(); // drop the suffix (Dr/St/Rd…)
  return s;
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
  let bestLen = 0;
  for (const p of projects) {
    if (!p.clientId) continue;
    const core = streetCore(p.addressLine || p.title);
    const words = core.split(/\s+/).filter(Boolean);
    const candidates = [core];
    if (words.length > 1) candidates.push(words[words.length - 1]); // bare street name
    for (const c of candidates) {
      const cl = c.toLowerCase();
      if (cl.length >= 4 && t.includes(cl) && cl.length > bestLen) {
        best = { id: p.id, title: p.title, status: p.status, clientId: p.clientId };
        bestLen = cl.length;
      }
    }
  }
  return best;
}
