"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";

// ---------------------------------------------------------------------------
// THE PILOT EDITOR (R02 / A26, unified handoff Sep 25 2026). OWNER only.
//
// A real client's provider writes (an Aryeo booking, an address update, a
// Calendly booking) happen only inside an approved pilot on that switch —
// never by renaming the client TEST. Approving one is Jordan's launch decision,
// so this editor:
//   · requires the owner to TYPE the client's name (a picked row and a typed
//     name that disagree refuse — the same guard the settings danger-zone uses);
//   · stamps approvedBy / approvedAt on every change (a changed pilot is a new
//     approval, not an edit to an old one);
//   · writes before → after into AuditLog in the same transaction;
//   · NEVER switches anything on. The pilot is a list; the switch is separate
//     and stays off until Jordan turns it on above.
// The fixture list (TEST clients) is armed for the supervised tests by
// scripts/_ops/hub-write-fixture.ts; here the owner can only take a fixture
// OFF it (removeFixtureClientAction). Both go through lib/hubWriteFixtures —
// that one field, audited, never the pilot — and a real client on the list is
// refused by the guard anyway.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });
const squash = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export type HubWriteScopeView = {
  switchKey: string;
  title: string;
  enabled: boolean;
  missing: boolean;
  headline: string;
  fixtures: { id: string; name: string; problem: string | null }[];
  pilot: null | {
    state: string;
    clients: { id: string; name: string }[];
    groups: string[];
    approvedBy: string | null;
    approvedAtISO: string | null;
    expiresAtISO: string | null;
    note: string | null;
  };
  groups: { key: string; label: string }[];
};

export type HubWriteScopesPayload = {
  switches: HubWriteScopeView[];
  /** Real clients with a live program seat — the only people a pilot can name. */
  candidates: { id: string; name: string }[];
};

/** What every scoped switch covers right now. Read-only; admins may look, only the owner edits. */
export async function loadHubWriteScopes(): Promise<HubWriteScopesPayload | { error: string }> {
  try { await requireAdmin(); } catch (e) { return { error: fail(e).message }; }
  const { prisma } = await import("@/lib/prisma");
  const { getAutomation, storedAutomationConfigForDisplay } = await import("@/lib/programAutomation");
  const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
  const { HUB_WRITE_SWITCHES, HUB_WRITE_OPERATION_GROUPS, parseHubWriteConfig, describeHubWriteScope } = await import("@/lib/hubWritePermit");
  const { isTestClientName, isVerifiedTestDestinationEmail } = await import("@/lib/testClients");
  const now = new Date();
  const rows = await Promise.all(HUB_WRITE_SWITCHES.map(async (k) => ({ k, s: await getAutomation(k), cfg: parseHubWriteConfig(await storedAutomationConfigForDisplay(k)) })));
  const ids = [...new Set(rows.flatMap((r) => [...r.cfg.authorizedFixtureClientIds, ...(r.cfg.pilot?.clientIds ?? [])]))];
  const clients = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const switches: HubWriteScopeView[] = rows.map(({ k, s, cfg }) => {
    const d = describeHubWriteScope(k, { enabled: s.enabled, missing: s.missing, config: cfg }, names, now);
    const groups = HUB_WRITE_OPERATION_GROUPS[k];
    const p = cfg.pilot;
    return {
      switchKey: k,
      title: AUTOMATION_EFFECTS[k]?.title ?? k,
      enabled: s.enabled,
      missing: s.missing,
      headline: d.headline,
      // The guard's own objections, shown before anyone relies on the list: a
      // real client here is refused, and so is a fixture on a real inbox.
      fixtures: cfg.authorizedFixtureClientIds.map((id) => {
        const c = byId.get(id);
        const problem = !c ? "no such client" : !isTestClientName(c.name) ? "not a TEST client, so the guard refuses it (a real client needs a pilot)" : !isVerifiedTestDestinationEmail(c.email) ? "its email is not the verified test inbox, so the guard refuses it" : null;
        return { id, name: c?.name ?? id, problem };
      }),
      pilot: p && p.clientIds.length
        ? {
            state: d.pilotState,
            clients: p.clientIds.map((id) => ({ id, name: names.get(id) ?? `${id} (not found)` })),
            groups: groups.filter((g) => g.operations.every((op) => p.operations.includes(op))).map((g) => g.key),
            approvedBy: p.approvedBy, approvedAtISO: p.approvedAt, expiresAtISO: p.expiresAt, note: p.note,
          }
        : null,
      groups: groups.map((g) => ({ key: g.key, label: g.label })),
    };
  });
  // No relation on ContentEnrollment → Client, so two reads.
  const enrolled = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { clientId: true }, take: 500 });
  const enrolledClients = enrolled.length ? await prisma.client.findMany({ where: { id: { in: [...new Set(enrolled.map((e) => e.clientId))] } }, select: { id: true, name: true } }) : [];
  const candidates = enrolledClients
    .filter((c) => !isTestClientName(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { switches, candidates };
}

/** A pilot's stored end (the NEXT ET midnight after the chosen day) as the day the owner chose. */
function pilotEndDay(iso: string): string {
  return new Date(Date.parse(iso) - 1).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
}

async function ownerEmail(): Promise<string> {
  await requireOwner();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}

async function writePilot(switchKey: string, pilot: unknown, by: string): Promise<void> {
  const { isHubWriteSwitch } = await import("@/lib/hubWritePermit");
  if (!isHubWriteSwitch(switchKey)) throw new Error("That switch has no pilot.");
  const { setAutomationConfigField } = await import("@/lib/programAutomation");
  await setAutomationConfigField(switchKey, "pilot", pilot, by, "automation_pilot_change");
  revalidatePath("/settings");
}

/**
 * Add ONE real client to a switch's pilot, with the writes it covers. The
 * owner types the client's name; the pilot's operations become the groups
 * ticked here (for every client in it), and the approval is re-stamped.
 *
 * THE END DATE IS KEPT unless it is changed on purpose (batch-3 review, Sep 25
 * 2026). It is one date for the whole pilot, and adding a second client with
 * the optional field left blank used to write `expiresAt: null` — silently
 * removing the end date the owner approved for the clients already in it.
 * Now: a date given → that date; `clearExpiry` → no end date; neither → the
 * pilot's current end date. Any change to it is said in the result.
 */
export async function addPilotClientAction(input: {
  switchKey: string; clientId: string; typedName: string; groups: string[];
  /** "YYYY-MM-DD" in ET: the pilot runs to the END of that day. Empty/null = keep the current end date. */
  expiresOnET?: string | null;
  /** true = remove the pilot's end date (it runs until someone ends it). */
  clearExpiry?: boolean;
  note?: string | null;
}): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const { prisma } = await import("@/lib/prisma");
    const { HUB_WRITE_OPERATION_GROUPS, isHubWriteSwitch, parseHubWriteConfig } = await import("@/lib/hubWritePermit");
    const { isTestClientName, isNeverSyntheticClientId } = await import("@/lib/testClients");
    const { storedAutomationConfigForDisplay } = await import("@/lib/programAutomation");
    if (!isHubWriteSwitch(input.switchKey)) return { ok: false, message: "That switch has no pilot." };
    const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true } });
    if (!client) return { ok: false, message: "That client no longer exists." };
    if (squash(input.typedName) !== squash(client.name)) return { ok: false, message: `Type the client's name exactly as it appears ("${client.name}") to approve the pilot.` };
    if (isTestClientName(client.name)) {
      return { ok: false, message: isNeverSyntheticClientId(client.id) ? "This is a real client carrying a TEST name. Fix the name first; nothing was changed." : "TEST clients are fixtures, not pilot clients. Nothing was changed." };
    }
    const enrolled = await prisma.contentEnrollment.count({ where: { clientId: client.id, status: "ACTIVE" } });
    if (!enrolled) return { ok: false, message: `${client.name} has no active program, so there is nothing for a pilot to book.` };
    const groups = HUB_WRITE_OPERATION_GROUPS[input.switchKey].filter((g) => input.groups.includes(g.key));
    if (!groups.length) return { ok: false, message: "Tick at least one kind of write the pilot covers." };
    const cfg = parseHubWriteConfig(await storedAutomationConfigForDisplay(input.switchKey));
    const was = cfg.pilot?.clientIds.length ? cfg.pilot.expiresAt ?? null : null;
    let expiresAt: string | null = was;
    if (input.expiresOnET) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOnET)) return { ok: false, message: "Pick an end date from the calendar (or leave it empty)." };
      // The end of that ET day (DST-correct: the next ET midnight), not its first minute.
      const { etAt } = await import("@/lib/datetime");
      const [y, m, d] = input.expiresOnET.split("-").map(Number);
      const t = etAt(new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10), 0).getTime();
      if (!Number.isFinite(t) || t <= Date.now()) return { ok: false, message: "The end date has to be in the future (or left empty)." };
      expiresAt = new Date(t).toISOString();
    } else if (input.clearExpiry) {
      expiresAt = null;
    } else if (was && Date.parse(was) <= Date.now()) {
      // Kept as it is, it would add this client to a pilot that has already ended.
      return { ok: false, message: `This pilot ended on ${pilotEndDay(was)}. Pick a new end date, or remove the end date, to add a client. Nothing was changed.` };
    }
    if (cfg.authorizedFixtureClientIds.includes(client.id)) {
      return { ok: false, message: `${client.name} is on this switch's fixture list, which is for TEST clients only. Take them off it first; nothing was changed.` };
    }
    const pilot = {
      clientIds: [...new Set([...(cfg.pilot?.clientIds ?? []), client.id])],
      operations: [...new Set(groups.flatMap((g) => g.operations))],
      approvedBy: by,
      approvedAt: new Date().toISOString(),
      expiresAt,
      note: input.note?.trim().slice(0, 500) || cfg.pilot?.note || null,
    };
    await writePilot(input.switchKey, pilot, by);
    const endLine = (was ?? null) === (expiresAt ?? null)
      ? expiresAt ? ` The pilot still ends ${pilotEndDay(expiresAt)}.` : ""
      : cfg.pilot?.clientIds.length
        ? ` The pilot's end date changed from ${was ? pilotEndDay(was) : "none"} to ${expiresAt ? pilotEndDay(expiresAt) : "none"}, for every client in it.`
        : expiresAt ? ` The pilot ends ${pilotEndDay(expiresAt)}.` : "";
    return { ok: true, message: `${client.name} is in the ${input.switchKey} pilot for: ${groups.map((g) => g.label.toLowerCase()).join("; ")}.${endLine} Nothing runs until the switch itself is on.` };
  } catch (e) { return fail(e); }
}

/** Take one client out of a pilot. Recorded; an emptied pilot is removed. */
export async function removePilotClientAction(input: { switchKey: string; clientId: string }): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const { isHubWriteSwitch, parseHubWriteConfig } = await import("@/lib/hubWritePermit");
    const { storedAutomationConfigForDisplay } = await import("@/lib/programAutomation");
    if (!isHubWriteSwitch(input.switchKey)) return { ok: false, message: "That switch has no pilot." };
    const cfg = parseHubWriteConfig(await storedAutomationConfigForDisplay(input.switchKey));
    if (!cfg.pilot?.clientIds.includes(input.clientId)) return { ok: true, message: "That client was not in the pilot." };
    const rest = cfg.pilot.clientIds.filter((id) => id !== input.clientId);
    await writePilot(input.switchKey, rest.length ? { ...cfg.pilot, clientIds: rest, approvedBy: by, approvedAt: new Date().toISOString() } : null, by);
    return { ok: true, message: rest.length ? "Removed from the pilot. The hub no longer writes for them." : "The pilot is empty and has been ended. No real client is written for." };
  } catch (e) { return fail(e); }
}

/** Take one TEST fixture off a switch's fixture list (audited; the pilot and the on/off are untouched). */
export async function removeFixtureClientAction(input: { switchKey: string; clientId: string }): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    const { setHubWriteFixtures } = await import("@/lib/hubWriteFixtures");
    const r = await setHubWriteFixtures(input.switchKey, { remove: [input.clientId] }, by);
    revalidatePath("/settings");
    return { ok: r.ok, message: r.ok ? (r.from.length === r.to.length ? "That client was not on the fixture list." : "Removed from the fixture list. The hub no longer writes for that TEST client on this switch.") : r.message };
  } catch (e) { return fail(e); }
}

/** End a switch's pilot altogether. */
export async function endPilotAction(input: { switchKey: string }): Promise<Result> {
  let by: string;
  try { by = await ownerEmail(); } catch (e) { return fail(e); }
  try {
    await writePilot(input.switchKey, null, by);
    return { ok: true, message: "Pilot ended. No real client is written for on this switch." };
  } catch (e) { return fail(e); }
}
