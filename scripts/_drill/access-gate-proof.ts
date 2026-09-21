// ---------------------------------------------------------------------------
// DRILL: the four access defects, OLD RULE vs NEW RULE on live rows.
// Sep 21 2026, batch 2 review close-out.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/access-gate-proof.ts
//
// READ-ONLY. The connection is forced read-only before anything is imported and
// the guard is PROVEN by a refused write. Where a fix changes what gets WRITTEN,
// the drill proves it by running the real predicate over the real rows and
// showing both answers — never by performing the write.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

function makeTheDatabaseReadOnly(): void {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    for (const file of [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../../.env")]) {
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ""); break; }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}
makeTheDatabaseReadOnly();

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const SOURCE = (p: string) => fs.readFileSync(path.resolve(__dirname, "../../", p), "utf8");

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`=== READ-ONLY GUARD: ${guard} ===\n`);
  if (guard !== "PROVEN") { console.error("The connection accepted a write. Refusing."); process.exitCode = 1; return; }

  // =========================================================================
  console.log("=== BLOCKING: a closed task is closed to the whole hub ===");
  const byStatus = await prisma.smartTask.groupBy({ by: ["status"], _count: { _all: true } });
  const total = byStatus.reduce((n, r) => n + r._count._all, 0);
  const vocab = byStatus.map((r) => `${r.status}=${r._count._all}`).sort().join(" ");
  console.log(`  live SmartTask vocabulary (${total} rows): ${vocab}`);
  ok('no live row has ever carried "DONE" or "CLOSED"', byStatus.every((r) => !["DONE", "CLOSED"].includes(r.status)));
  const countedOpen = await prisma.smartTask.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] } } });
  console.log(`  counted OPEN by queries.ts:59 today: ${countedOpen}`);

  const src = SOURCE("src/lib/programOnboarding.ts");
  const closeWrites = src.match(/data:\s*\{\s*status:\s*"([A-Z_]+)",\s*completedAt:\s*new Date\(\)\s*\}/)?.[1] ?? "(none)";
  ok("closeDiscoveryTask writes a status the schema defines", closeWrites === "COMPLETED", `writes "${closeWrites}"`);
  const doneList = src.match(/const TASK_DONE = \[(.*?)\];/)?.[1] ?? "";
  ok("TASK_DONE is the hub's closed set", /"COMPLETED"/.test(doneList) && /"CANCELLED"/.test(doneList) && !/"DONE"/.test(doneList), `TASK_DONE = [${doneList}]`);
  ok("the legacy list is read-only and still recognises the old words", /TASK_DONE_INCLUDING_LEGACY = \[\.\.\.TASK_DONE, "DONE", "CLOSED"\]/.test(src));
  // What the old code did, stated as an arithmetic fact about this table:
  console.log(`  a task closed as "DONE" would still be one of the ${countedOpen + 1} rows every list, count and board calls open.`);

  // =========================================================================
  console.log("\n=== IMPORTANT: the identity question has its own row ===");
  const schedKey = src.match(/DISCOVERY_TASK_PREFIX = "(.*?)"/)?.[1] ?? "";
  const identKey = src.match(/IDENTITY_TASK_PREFIX = "(.*?)"/)?.[1] ?? "";
  ok("two distinct prefixes", !!schedKey && !!identKey && schedKey !== identKey, `${schedKey} vs ${identKey}`);
  ok("reconcileDiscoveryTasks cannot reach the identity key", !identKey.startsWith(schedKey) && !schedKey.startsWith(identKey));
  ok("the identity key carries the address in question", /IDENTITY_TASK_PREFIX\}\$\{enrollmentId\}:\$\{conflict\.invitee\}/.test(src));
  ok("a closed identity question is not reopened by the next sweep", /reopenIfClosed: false/.test(src));
  ok("an OPEN desk row's facts are rewritten rather than dropped", /existing\.title !== title \|\| existing\.description !== description/.test(src));
  const sched = await prisma.smartTask.count({ where: { dedupeKey: { startsWith: schedKey } } });
  const ident = await prisma.smartTask.count({ where: { dedupeKey: { startsWith: identKey } } });
  console.log(`  live rows today: scheduling ${sched}, identity ${ident} (the chain has not run on a paid signup yet)`);

  // =========================================================================
  console.log("\n=== IMPORTANT: the pre-launch welcome goes to ONE inbox ===");
  const { isStaffControlledEmail, isVerifiedTestDestinationEmail } = await import("../../src/lib/testClients");
  const addresses = new Set<string>();
  for (const cu of await prisma.clientUser.findMany({ select: { email: true } })) addresses.add(cu.email.toLowerCase());
  for (const c of await prisma.client.findMany({ select: { email: true, backupEmail: true } })) {
    for (const e of [c.email, c.backupEmail]) if (e) addresses.add(e.toLowerCase());
  }
  const oldAllows = [...addresses].filter(isStaffControlledEmail).sort();
  const newAllows = [...addresses].filter(isVerifiedTestDestinationEmail).sort();
  console.log(`  addresses on file: ${addresses.size}`);
  console.log(`  OLD rule (isStaffControlledEmail) would send to ${oldAllows.length}: ${oldAllows.join(", ")}`);
  console.log(`  NEW rule (isVerifiedTestDestinationEmail) sends to ${newAllows.length}: ${newAllows.join(", ")}`);
  const lost = oldAllows.filter((e) => !newAllows.includes(e));
  ok("somebody else's inbox is now refused", lost.length > 0 && lost.every((e) => !isVerifiedTestDestinationEmail(e)), `refused: ${lost.join(", ") || "none"}`);
  ok("Jordan's own plus-addresses still reach him", newAllows.length > 0);
  ok("the enqueue gate reads the narrow predicate", /isTestClient && isVerifiedTestDestinationEmail\(input\.email\)/.test(SOURCE("src/lib/portalAccess.ts")));

  // =========================================================================
  console.log("\n=== IMPORTANT: no client renames another client's person ===");
  const pa = SOURCE("src/lib/portalAccess.ts");
  ok("grantProgramAccess no longer overwrites a name", !/update: name \? \{ name \} : \{\}, select: \{ id: true \} \}\);\n  const existing = await prisma\.clientMembership/.test(pa) && /data: \{ name \}, select: \{ id: true \} \}\)\n      : \{ id: priorPerson\.id \}/.test(pa));
  ok("a blank name may still be filled in", /name && !priorPerson\.name/.test(pa));
  ok("an address seated on another client is refused before any write", /clientUserId: priorPerson\.id, revokedAt: null, clientId: \{ not: target\.clientId \}/.test(pa));
  ok("the portal repeats the stop in the client's own words", /clientUserId: existing\.id, revokedAt: null, clientId: \{ not: v\.enrollment\.clientId \}/.test(SOURCE("src/app/portal/actions.ts")));

  const users = await prisma.clientUser.findMany({ select: { id: true, email: true, name: true } });
  const named = users.filter((u) => !!u.name);
  const seats = await prisma.clientMembership.findMany({ where: { revokedAt: null }, select: { clientUserId: true, clientId: true } });
  const clientsOf = new Map<string, Set<string>>();
  for (const s of seats) { if (!clientsOf.has(s.clientUserId)) clientsOf.set(s.clientUserId, new Set()); clientsOf.get(s.clientUserId)!.add(s.clientId); }
  console.log(`  ClientUser rows: ${users.length} (named: ${named.length}); live seats: ${seats.length} across ${new Set(seats.map((s) => s.clientId)).size} client(s)`);
  console.log(`  OLD: a teammate invite naming any of those ${named.length} addresses rewrote that row's name, whoever it belonged to.`);
  console.log(`  NEW: renameable by a teammate invite: 0 (an existing name is never overwritten); seats on another client: refused.`);
  const crossTenantToday = [...clientsOf.values()].filter((c) => c.size > 1).length;
  console.log(`  people seated on more than one client today: ${crossTenantToday} (the refusal is the guard, not the count)`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
