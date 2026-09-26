import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// THE TEST-FIXTURE LIST, EDITED ON ITS OWN (batch-3 review, Sep 25 2026).
//
// `authorizedFixtureClientIds` on a provider-write switch (session_booking,
// address_sync, call_booking) names the disposable TEST clients the hub may
// write for. Nothing in Settings edited it: the pilot editor writes only the
// `pilot` field, and the supervised tests told the operator either to use a
// Settings control that does not exist or to paste a setAutomation(...) call
// that REPLACES the whole config — silently dropping an approved pilot — and
// writes no AuditLog row.
//
// This is the one writer of that list. It changes that ONE field through
// setAutomationConfigField (read-modify-write under the key's advisory lock,
// before → after into AuditLog in the same transaction), never the pilot,
// never the switch's on/off. The owner-only settings action and the
// supervised-test ops script (scripts/_ops/hub-write-fixture.ts) both call it.
//
// A fixture must BE one: a TEST name, never a never-synthetic id (a real
// client renamed TEST), its own email the verified test inbox, and not a
// client the switch's pilot names. Anything else is refused and nothing is
// written.
// ---------------------------------------------------------------------------

export type FixtureChange = { add?: string[]; remove?: string[]; clear?: boolean };
export type FixtureResult = { ok: boolean; message: string; from: string[]; to: string[] };

export async function setHubWriteFixtures(switchKey: string, change: FixtureChange, by: string): Promise<FixtureResult> {
  const { isHubWriteSwitch, parseHubWriteConfig } = await import("@/lib/hubWritePermit");
  const { storedAutomationConfigForDisplay, setAutomationConfigField } = await import("@/lib/programAutomation");
  const t = await import("@/lib/testClients");
  if (!isHubWriteSwitch(switchKey)) return { ok: false, message: `${switchKey} is not a provider-write switch.`, from: [], to: [] };
  const cfg = parseHubWriteConfig(await storedAutomationConfigForDisplay(switchKey));
  const from = [...cfg.authorizedFixtureClientIds];
  const add = [...new Set((change.add ?? []).map((x) => x.trim()).filter(Boolean))];
  const remove = new Set((change.remove ?? []).map((x) => x.trim()).filter(Boolean));
  if (add.length) {
    const rows = await prisma.client.findMany({ where: { id: { in: add } }, select: { id: true, name: true, email: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of add) {
      const c = byId.get(id);
      if (!c) return { ok: false, message: `No client ${id}. Nothing was changed.`, from, to: from };
      if (t.isNeverSyntheticClientId(c.id)) return { ok: false, message: `"${c.name}" is a real client carrying a TEST name. Nothing was changed.`, from, to: from };
      if (!t.isTestClientName(c.name)) return { ok: false, message: `"${c.name}" is a real client. Real clients are written for only inside an approved pilot. Nothing was changed.`, from, to: from };
      if (!t.isVerifiedTestDestinationEmail(c.email)) return { ok: false, message: `"${c.name}"'s own email (${c.email || "none"}) is not the verified test inbox ${t.JORDAN_TEST_EMAIL}. Nothing was changed.`, from, to: from };
      if (cfg.pilot?.clientIds.includes(c.id)) return { ok: false, message: `"${c.name}" is in this switch's pilot. Nothing was changed.`, from, to: from };
    }
  }
  const to = change.clear ? [] : [...new Set([...from.filter((id) => !remove.has(id)), ...add])];
  if (to.length === from.length && to.every((id, i) => id === from[i])) return { ok: true, message: "No change: the fixture list already reads that way.", from, to };
  await setAutomationConfigField(switchKey, "authorizedFixtureClientIds", to, by, "automation_fixture_change");
  return { ok: true, message: `${switchKey} fixtures: ${JSON.stringify(from)} → ${JSON.stringify(to)}. The pilot and the switch's on/off are unchanged.`, from, to };
}
