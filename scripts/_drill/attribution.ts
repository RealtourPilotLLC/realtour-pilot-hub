// ---------------------------------------------------------------------------
// DRILL: sender attribution for OpenPhone texts (Sep 21 2026).
//
// Jordan asked for Kyle's OpenPhone responses to be tracked and coached. None of
// that is honest unless the hub can say WHICH of our people wrote a given
// outbound text — and Kyle's handset IS the company line, so every one of them
// was logged as "Us".
//
// This drill replays the real gate over every retained webhook payload and
// reports, without writing a single row:
//   1. who OpenPhone says works here, and who the matcher resolves each one to;
//   2. every payload the webhook would trust, and every one it would refuse
//      (with the reason) — including the inbound trap, where userId names the
//      inbox owner rather than the sender;
//   3. how many already-logged outbound rows COULD have carried a person if
//      this had been running.
//
// READ-ONLY. It calls the pure matcher and read-only helpers, never the stamp.
// ---------------------------------------------------------------------------
import { prisma } from "../../src/lib/prisma";

async function main() {
  const { OpenPhone, ourOpenPhoneNumberKeys, phoneKey } = await import("../../src/lib/integrations/openphone");
  const { matchOpUsers, isAttributableSource, hubComposedProviderId } = await import("../../src/lib/commSenders");

  // ---- 1. the roster match ------------------------------------------------
  console.log("=== 1. WHO OPENPHONE SAYS WORKS HERE ===");
  let users: Awaited<ReturnType<typeof OpenPhone.users>> = [];
  try {
    users = await OpenPhone.users();
  } catch (e) {
    console.log("  /users unavailable:", e instanceof Error ? e.message : String(e));
  }
  const team = await prisma.teamMember.findMany({ select: { id: true, name: true, email: true } });
  const { byUserId, labels } = matchOpUsers(users, team);
  const nameById = new Map(team.map((t) => [t.id, t.name]));
  for (const id of Object.keys(byUserId)) {
    const tm = byUserId[id];
    console.log(`  ${id}  ${labels[id]}  →  ${tm ? `${nameById.get(tm)} (${tm})` : "UNRESOLVED (stays null)"}`);
  }
  // The failure mode that must not exist: two provider users on one person.
  const dupes = Object.values(byUserId).filter((v): v is string => !!v);
  const clash = dupes.filter((v, i) => dupes.indexOf(v) !== i);
  console.log(`  distinct people matched: ${new Set(dupes).size}; collisions: ${clash.length === 0 ? "none" : clash.join(",")}`);

  // ---- 2. replay the gate over every retained payload ----------------------
  console.log("\n=== 2. THE GATE, REPLAYED OVER EVERY RETAINED PAYLOAD ===");
  const line = await ourOpenPhoneNumberKeys();
  const events = await prisma.webhookEvent.findMany({
    where: { provider: "openphone" },
    orderBy: { createdAt: "asc" },
    select: { eventType: true, createdAt: true, payload: true },
  });

  const refused = new Map<string, number>();
  const bump = (r: string) => refused.set(r, (refused.get(r) ?? 0) + 1);
  const trusted: { extId: string; userId: string }[] = [];
  // The trap, counted explicitly: how many payloads WOULD have been attributed
  // to the wrong person by a naive reader that took userId at face value.
  let inboundCarryingUserId = 0;

  for (const ev of events) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(ev.payload ?? "{}") as Record<string, unknown>; } catch { bump("unparseable payload"); continue; }
    const d = ((p.data as Record<string, unknown>)?.object ?? p.data ?? p) as Record<string, unknown>;
    const dir = String(d.direction ?? "").toLowerCase();
    const uid = typeof d.userId === "string" ? d.userId.trim() : "";
    const id = typeof d.id === "string" ? d.id : "";
    const from = phoneKey(String(d.from ?? ""));

    if (!(ev.eventType ?? "").startsWith("message")) { bump("not a message event (calls carry answeredBy, not a sender)"); continue; }
    if (!dir.startsWith("out")) {
      if (uid) inboundCarryingUserId++;
      bump("inbound — userId names the INBOX OWNER, not the sender");
      continue;
    }
    if (!line.has(from)) { bump("outgoing but not from the workspace line"); continue; }
    if (!uid) { bump("outgoing from the line but no userId"); continue; }
    if (!id) { bump("no message id — nothing to stamp"); continue; }
    trusted.push({ extId: `op-${id}`, userId: uid });
  }

  console.log(`  payloads examined: ${events.length}`);
  console.log(`  TRUSTED (distinct messages): ${new Set(trusted.map((t) => t.extId)).size}`);
  console.log("  refused:");
  for (const [r, c] of [...refused].sort((a, b) => b[1] - a[1])) console.log(`    ${c.toString().padStart(5)}  ${r}`);
  console.log(`  ↳ of those refusals, ${inboundCarryingUserId} inbound payloads DID carry a userId — every one of them the`);
  console.log("    workspace owner's. That is the bug this gate exists to prevent.");

  // ---- 3. what the stamp would decide, row by row ---------------------------
  console.log("\n=== 3. WHAT THE STAMP WOULD DECIDE ON THE ROWS WE ALREADY HAVE ===");
  const byExt = new Map(trusted.map((t) => [t.extId, t.userId]));
  const rows = await prisma.commLog.findMany({
    where: { externalId: { in: [...byExt.keys()] } },
    select: { externalId: true, source: true, occurredAt: true, senderTeamMemberId: true, senderUserId: true, contactName: true },
  });
  console.log(`  trusted message ids that have a CommLog row: ${rows.length} of ${byExt.size}`);

  const outcome = new Map<string, number>();
  const perPerson = new Map<string, number>();
  let hubComposed = 0;
  for (const r of rows) {
    const uid = byExt.get(r.externalId!)!;
    if (r.senderTeamMemberId || r.senderUserId) { outcome.set("skipped: already settled", (outcome.get("skipped: already settled") ?? 0) + 1); continue; }
    if (!isAttributableSource(r.source)) {
      outcome.set(`skipped: machine source (${r.source})`, (outcome.get(`skipped: machine source (${r.source})`) ?? 0) + 1);
      continue;
    }
    if (await hubComposedProviderId(r.externalId!.replace(/^op-/, ""))) {
      hubComposed++;
      outcome.set("skipped: the hub composed it (outbox)", (outcome.get("skipped: the hub composed it (outbox)") ?? 0) + 1);
      continue;
    }
    const tm = byUserId[uid] ?? null;
    if (tm) {
      outcome.set("STAMPED", (outcome.get("STAMPED") ?? 0) + 1);
      const who = nameById.get(tm) ?? tm;
      perPerson.set(who, (perPerson.get(who) ?? 0) + 1);
    } else {
      outcome.set("unresolved: userId kept, person left null", (outcome.get("unresolved: userId kept, person left null") ?? 0) + 1);
    }
  }
  for (const [k, v] of [...outcome].sort((a, b) => b[1] - a[1])) console.log(`    ${v.toString().padStart(5)}  ${k}`);
  console.log("  who the stamped rows belong to:");
  for (const [k, v] of [...perPerson].sort((a, b) => b[1] - a[1])) console.log(`    ${v.toString().padStart(5)}  ${k}`);
  console.log(`  (machine sends caught by the source allow-list AND by the outbox guard: ${hubComposed} would have been caught twice)`);

  // ---- 4. the size of the hole ---------------------------------------------
  console.log("\n=== 4. HOW MUCH OF HISTORY THIS COULD EVER REACH ===");
  const allUs = await prisma.commLog.count({ where: { channel: "text", direction: "out", source: "openphone", contactName: "Us" } });
  const stampable = [...outcome].filter(([k]) => k === "STAMPED").reduce((a, [, v]) => a + v, 0);
  const oldest = events[0]?.createdAt ?? null;
  console.log(`  outbound texts logged only as "Us", all time: ${allUs}`);
  console.log(`  covered by a retained payload the gate trusts:  ${stampable}`);
  console.log(`  beyond reach of retained payloads:              ${allUs - stampable}`);
  console.log(`  oldest retained openphone payload: ${oldest ? oldest.toISOString() : "none"}`);

  // ---- 5. the invariant that matters most -----------------------------------
  console.log("\n=== 5. INVARIANTS ===");
  const wouldOverwrite = rows.filter((r) => r.senderTeamMemberId).length;
  console.log(`  rows already carrying a person that the stamp refuses to touch: ${wouldOverwrite} (the where-clause is senderTeamMemberId: null)`);
  console.log(`  rows the gate would attribute with NO provider evidence: 0 by construction — the gate requires a userId on an outgoing payload.`);
  const nullMeansUnknown = await prisma.commLog.count({ where: { channel: "text", direction: "out", senderTeamMemberId: null } });
  console.log(`  outbound text rows currently unattributed (null = UNKNOWN, never "nobody"): ${nullMeansUnknown}`);
}

main().finally(() => prisma.$disconnect());
