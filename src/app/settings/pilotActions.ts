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
//
// ONE PILOT LIST (R03, Jordan's Sep 28 2026 rule). The Aryeo and Calendly
// guards now read the PROGRAM pilot (Settings → Who the program may reach,
// src/app/settings/rolloutActions.ts) — a client in the approved pilot with
// "bookings" ticked is written for once these switches are on. A second,
// per-switch list here could only drift from it, so this panel now SHOWS the
// program pilot read-only, per switch, and the three per-switch pilot actions
// refuse with a pointer to the one editor. The per-switch `pilot` values on
// file are left untouched (history) and read by nobody.
// ---------------------------------------------------------------------------

/** Where the one pilot is edited. */
const PROGRAM_PILOT_HOME = "Settings → Who the program may reach";
const retired = (): Result => ({ ok: false, message: `There is one pilot list now: the program pilot, in ${PROGRAM_PILOT_HOME}. Add or remove clients there, and tick "bookings" for the ones the hub may book for. Nothing was changed here.` });

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

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
  /** R03: the pilot shown is the PROGRAM pilot (read-only here). */
  pilotSource: "program";
  /** Why the program pilot could not be read, if it could not (nobody real is written for). */
  pilotProblem: string | null;
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
  // R03: each switch's config with its pilot REPLACED by the program pilot —
  // exactly what the guards route on — and the fixture list as stored.
  const { hubWriteScopeWithProgramPilot } = await import("@/lib/programRollout");
  const rows = await Promise.all(HUB_WRITE_SWITCHES.map(async (k) => {
    const scoped = await hubWriteScopeWithProgramPilot(parseHubWriteConfig(await storedAutomationConfigForDisplay(k)), k);
    return { k, s: await getAutomation(k), cfg: scoped.config, problem: scoped.problem };
  }));
  const ids = [...new Set(rows.flatMap((r) => [...r.cfg.authorizedFixtureClientIds, ...(r.cfg.pilot?.clientIds ?? [])]))];
  const clients = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const switches: HubWriteScopeView[] = rows.map(({ k, s, cfg, problem }) => {
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
      pilotSource: "program",
      pilotProblem: problem,
    };
  });
  // R03: nobody is added from here any more (one pilot list), so no candidates.
  return { switches, candidates: [] };
}

async function ownerEmail(): Promise<string> {
  await requireOwner();
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}

// THE PER-SWITCH PILOT ACTIONS ARE RETIRED (R03, Sep 28 2026). They wrote a
// `pilot` onto each switch's config — a second list beside the program pilot,
// free to drift from it. The names stay (the panel and any bookmarked form
// still call them) and each one refuses, owner-checked, pointing at the one
// editor. Nothing is written. What they used to do lives in the program
// pilot's actions (rolloutActions.ts), with the same typed-name confirm, the
// same end-date rules and the same audit row.

/** Retired — see above. */
export async function addPilotClientAction(input: {
  switchKey: string; clientId: string; typedName: string; groups: string[];
  expiresOnET?: string | null;
  clearExpiry?: boolean;
  note?: string | null;
}): Promise<Result> {
  void input;
  try { await ownerEmail(); } catch (e) { return fail(e); }
  return retired();
}

/** Retired — removing a client from the pilot is done once, in the program pilot. */
export async function removePilotClientAction(input: { switchKey: string; clientId: string }): Promise<Result> {
  void input;
  try { await ownerEmail(); } catch (e) { return fail(e); }
  return retired();
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

/** Retired — the pilot is ended once, in the program pilot. */
export async function endPilotAction(input: { switchKey: string }): Promise<Result> {
  void input;
  try { await ownerEmail(); } catch (e) { return fail(e); }
  return retired();
}
