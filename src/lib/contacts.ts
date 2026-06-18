import "server-only";
import { prisma } from "@/lib/prisma";
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

// Resolve an inbound set of phone numbers to a client id, checking both client
// records and synced contacts (which carry alternate numbers). Returns the
// client id + their most recent project, or null.
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
      projects: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, title: true, status: true } },
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
    if (clientId) {
      const c = await prisma.client.findUnique({
        where: { id: clientId },
        select: {
          id: true,
          name: true,
          projects: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, title: true, status: true } },
        },
      });
      if (c) return { clientId: c.id, clientName: c.name, project: c.projects[0] ?? null };
    }
  }

  if (!hit) return null;
  return { clientId: hit.id, clientName: hit.name, project: hit.projects[0] ?? null };
}
