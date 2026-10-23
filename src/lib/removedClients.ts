// ---------------------------------------------------------------------------
// CLIENTS WE REMOVED ON PURPOSE, AND THE SYNCS THAT WOULD BRING THEM BACK
// (Oct 23 2026).
//
// Jordan, Oct 23 2026: "Remove the Jordan Spackman Client Records and all the
// test Client Records." scripts/_live/oct23-remove-test-clients.ts deletes
// them. Three doors would mint them again within a day, because each of these
// people still exists in Aryeo:
//   · the daily roster sweep (syncAllAryeoClients) creates a client for every
//     Aryeo customer-user whose email the hub does not hold, and greets it;
//   · the order sync (syncAryeoOrders) imports any order it has no project
//     for — the resumable full reconcile walks the WHOLE order history every
//     hour — and resolves or creates that order's customer as a client;
//   · the Aryeo customer webhook (upsertAryeoCustomerClient).
// Nothing in the hub remembered that a row was removed on purpose, so the
// removal script writes one AppSetting row naming what it removed, and those
// three doors read it and step aside.
//
// THE RECORD (AppSetting "clients:removed", JSON):
//   { "version": 1, "entries": [ { clientId, name, aryeoCustomerIds[],
//     emails[], aryeoOrderIds[], removedAt, note } ] }
// An Aryeo customer id, an email (lower-cased, exact: no plus or dot folding,
// so a stranger's address can never collide with one of these), or an Aryeo
// order id on that list is skipped. Undo = remove the entry from the JSON.
//
// Pure apart from loadRemovedClients, which takes the client it reads with, so
// the drill and the live script use the same parser.
// ---------------------------------------------------------------------------

export const REMOVED_CLIENTS_KEY = "clients:removed";

export type RemovedClientEntry = {
  clientId: string;
  name: string;
  aryeoCustomerIds: string[];
  emails: string[];
  aryeoOrderIds: string[];
  removedAt: string;
  note?: string;
};

export type RemovedClients = {
  entries: RemovedClientEntry[];
  customerIds: Map<string, RemovedClientEntry>;
  emails: Map<string, RemovedClientEntry>;
  orderIds: Map<string, RemovedClientEntry>;
};

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

export function emptyRemovedClients(): RemovedClients {
  return { entries: [], customerIds: new Map(), emails: new Map(), orderIds: new Map() };
}

/** The stored JSON, read leniently: a malformed entry is skipped, never thrown. */
export function parseRemovedClients(value: string | null | undefined): RemovedClients {
  const out = emptyRemovedClients();
  if (!value) return out;
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { return out; }
  const list = Array.isArray((raw as { entries?: unknown })?.entries) ? (raw as { entries: unknown[] }).entries : [];
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.clientId !== "string") continue;
    const entry: RemovedClientEntry = {
      clientId: o.clientId,
      name: typeof o.name === "string" ? o.name : "",
      aryeoCustomerIds: strs(o.aryeoCustomerIds).map(norm),
      emails: strs(o.emails).map(norm),
      aryeoOrderIds: strs(o.aryeoOrderIds).map(norm),
      removedAt: typeof o.removedAt === "string" ? o.removedAt : "",
      ...(typeof o.note === "string" ? { note: o.note } : {}),
    };
    out.entries.push(entry);
    for (const id of entry.aryeoCustomerIds) out.customerIds.set(id, entry);
    for (const em of entry.emails) out.emails.set(em, entry);
    for (const id of entry.aryeoOrderIds) out.orderIds.set(id, entry);
  }
  return out;
}

export type RemovedProbe = {
  /** the Aryeo customer (or customer-user) id, plus any alternate ids the caller holds */
  customerIds?: (string | null | undefined)[];
  email?: string | null;
  orderId?: string | null;
};

/** The removed client this record belongs to, or null. What matched is in `on`. */
export function removedMatch(r: RemovedClients, p: RemovedProbe): { entry: RemovedClientEntry; on: string } | null {
  if (!r.entries.length) return null;
  const order = norm(p.orderId);
  if (order && r.orderIds.has(order)) return { entry: r.orderIds.get(order)!, on: `order ${order}` };
  for (const id of p.customerIds ?? []) {
    const k = norm(id);
    if (k && r.customerIds.has(k)) return { entry: r.customerIds.get(k)!, on: `Aryeo customer ${k}` };
  }
  const em = norm(p.email);
  if (em && r.emails.has(em)) return { entry: r.emails.get(em)!, on: `email ${em}` };
  return null;
}

/** The record with `add` merged in (one entry per client id; lists unioned). */
export function mergeRemovedClients(current: string | null | undefined, add: RemovedClientEntry[]): string {
  const now = parseRemovedClients(current).entries;
  const byId = new Map(now.map((e) => [e.clientId, e]));
  for (const a of add) {
    const prev = byId.get(a.clientId);
    const u = (x: string[], y: string[]) => [...new Set([...x, ...y].map(norm).filter(Boolean))];
    byId.set(a.clientId, prev
      ? { ...prev, name: a.name || prev.name, aryeoCustomerIds: u(prev.aryeoCustomerIds, a.aryeoCustomerIds), emails: u(prev.emails, a.emails), aryeoOrderIds: u(prev.aryeoOrderIds, a.aryeoOrderIds), removedAt: prev.removedAt || a.removedAt, note: a.note ?? prev.note }
      : { ...a, aryeoCustomerIds: u([], a.aryeoCustomerIds), emails: u([], a.emails), aryeoOrderIds: u([], a.aryeoOrderIds) });
  }
  return JSON.stringify({ version: 1, entries: [...byId.values()] });
}

type SettingReader = { appSetting: { findUnique: (a: { where: { key: string }; select: { value: true } }) => Promise<{ value: string } | null> } };

/**
 * Read the record. A read that fails is reported and treated as EMPTY: the
 * syncs then behave exactly as they did before this file existed, which is
 * the state the hub ran in until Oct 23 — never worse than that.
 */
export async function loadRemovedClients(db: SettingReader): Promise<RemovedClients> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: REMOVED_CLIENTS_KEY }, select: { value: true } });
    return parseRemovedClients(row?.value);
  } catch (e) {
    console.warn("[removed-clients] could not read the removed-clients record; syncs run unfiltered", e);
    return emptyRemovedClients();
  }
}
