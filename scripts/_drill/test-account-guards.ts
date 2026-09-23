// ---------------------------------------------------------------------------
// DRILL: THE TEST-ACCOUNT GUARDS, EXERCISED (Sep 21 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     npx tsx scripts/_drill/test-account-guards.ts
//
// §16 asks for four properties. Three of them are decidable without touching a
// row, and the fourth is only meaningful against the real database:
//
//   1. the §16 name is synthetic and the two live look-alikes are not
//   2. test sends reach only the two destinations Jordan verified on Sep 21
//   3. a test journey cannot create a real billable session, and cannot edit a
//      real client's appointment
//   4. the two "Jordan Spackman" rows the guard refuses BY ID are really there,
//      and really are not synthetic
//
// READ-ONLY, STRUCTURALLY. The connection itself refuses writes (SQLSTATE
// 25006) and the drill proves that with a refused write before it reads
// anything, the same way scripts/_drill/attribution-rails.ts does. A promise
// about what this file calls is worth nothing next to a connection that cannot
// execute an INSERT.
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

let passed = 0;
let failed = 0;
function check(label: string, actual: boolean, expected: boolean): void {
  const ok = actual === expected;
  if (ok) passed++; else failed++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
}

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const g = await import("../../src/lib/testClients");

  // ---- prove the guard before trusting anything else in this file ----------
  let guard = "NOT PROVEN";
  try {
    await prisma.appSetting.updateMany({ where: { key: "__guards_drill_readonly_probe__" }, data: { value: "x" } });
  } catch (e) {
    guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
  }
  console.log(`=== READ-ONLY GUARD: ${guard} ===\n`);
  if (guard !== "PROVEN") { console.error("The connection accepted a write. Refusing to run."); process.exitCode = 1; return; }

  // ---- 1. names ----------------------------------------------------------
  console.log("1. NAMES — the §16 account is synthetic, the real rows are not");
  check(`"${g.JORDAN_TEST_CLIENT_NAME}" is a test name`, g.isTestClientName(g.JORDAN_TEST_CLIENT_NAME), true);
  check(`"Jordan Spackman" is NOT a test name (F28)`, g.isTestClientName("Jordan Spackman"), false);
  check(`"Jordan Spackman" is an operational client`, g.isOperationalClientName("Jordan Spackman"), true);
  check(`"${g.JORDAN_TEST_CLIENT_NAME}" is excluded from operational counts`, g.isOperationalClientName(g.JORDAN_TEST_CLIENT_NAME), false);
  check(`"Testa" is still not swept up`, g.isTestClientName("Marco Testa"), false);
  check(`isJordanTestClientName matches only the exact account`, g.isJordanTestClientName("  jordan   spackman   TEST "), true);
  check(`isJordanTestClientName rejects the real name`, g.isJordanTestClientName("Jordan Spackman"), false);

  // ---- 2. destinations ---------------------------------------------------
  console.log("\n2. DESTINATIONS — only what Jordan verified on Sep 21 2026");
  check(`${g.JORDAN_TEST_EMAIL} is verified`, g.isVerifiedTestDestinationEmail(g.JORDAN_TEST_EMAIL), true);
  check(`info+jordantest@realtourpilot.com folds to the same inbox`, g.isVerifiedTestDestinationEmail("info+jordantest@realtourpilot.com"), true);
  check(`hello@realtourpilot.com is staff-controlled but NOT a test destination`,
    g.isStaffControlledEmail("hello@realtourpilot.com") && !g.isVerifiedTestDestinationEmail("hello@realtourpilot.com"), true);
  check(`jspackman215@gmail.com is refused`, g.isVerifiedTestDestinationEmail("jspackman215@gmail.com"), false);
  check(`info@realtorpilot.com (misspelled domain) is refused`, g.isVerifiedTestDestinationEmail("info@realtorpilot.com"), false);
  check(`215-534-8650 is verified in every format`,
    ["2155348650", "+12155348650", "(215) 534-8650", "1-215-534-8650"].every(g.isVerifiedTestDestinationPhone), true);
  check(`the ambiguous 267-827-9038 is refused`, g.isVerifiedTestDestinationPhone(g.UNVERIFIED_LOOKALIKE_PHONE_DIGITS), false);
  check(`assertTestDestinations throws on a stranger's number`, throws(() => g.assertTestDestinations({ phone: "+12678279038" })), true);
  check(`assertTestDestinations passes the verified pair`,
    throws(() => g.assertTestDestinations({ email: "info+jordantest@realtourpilot.com", phone: "+12155348650" })), false);

  // ---- 3. provider writes (A48) ------------------------------------------
  console.log("\n3. PROVIDER WRITES — A48 isolation");
  const testRow = { id: "test-row", name: g.JORDAN_TEST_CLIENT_NAME };
  const realRow = { id: g.NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Jordan Spackman" };
  const allowed = (a: Parameters<typeof g.providerWriteDecision>[0]) => g.providerWriteDecision(a).allowed;
  check(`booking a real Aryeo session FOR the test client is refused`,
    allowed({ provider: "aryeo", operation: "orders.create", client: testRow }), false);
  check(`a test journey editing a real client's appointment is refused`,
    allowed({ provider: "aryeo", operation: "appointments.reschedule", client: realRow, actingAsTestClient: testRow }), false);
  check(`a test journey editing ANOTHER test client is refused`,
    allowed({ provider: "aryeo", operation: "appointments.cancel", client: { id: "other-test", name: "Cara TEST" }, actingAsTestClient: testRow }), false);
  check(`a Stripe charge for the test client is refused`,
    allowed({ provider: "stripe", operation: "subscriptions.create", client: testRow }), false);
  check(`a sandbox adapter is the one way through`,
    allowed({ provider: "aryeo", operation: "orders.create", client: testRow, sandbox: true }), true);
  check(`ordinary staff work on a real client is untouched`,
    allowed({ provider: "aryeo", operation: "appointments.reschedule", client: realRow }), true);
  check(`a test journey acting on its OWN record still needs a sandbox`,
    allowed({ provider: "aryeo", operation: "orders.create", client: testRow, actingAsTestClient: testRow }), false);
  check(`assertProviderWriteAllowed throws, not just returns`,
    throws(() => g.assertProviderWriteAllowed({ provider: "aryeo", operation: "orders.create", client: testRow })), true);

  // ---- 4. the never-synthetic rows, against the live database -------------
  console.log("\n4. THE LOOK-ALIKE ROWS — measured, not assumed");
  for (const id of g.NEVER_SYNTHETIC_CLIENT_IDS) {
    const c = await prisma.client.findUnique({ where: { id }, select: { id: true, name: true, email: true, phone: true } });
    if (!c) { console.log(`  [WARN] ${id} is no longer in the database — leave the id listed, note the merge.`); continue; }
    console.log(`         ${c.id}  "${c.name}"  ${c.email ?? "(no email)"}  ${c.phone ?? "(no phone)"}`);
    check(`  ${id} is refused by id even if renamed to contain TEST`,
      throws(() => g.assertTestClient({ id: c.id, name: `${c.name} TEST` })), true);
    check(`  ${id} is refused under its real name too`, throws(() => g.assertTestClient({ id: c.id, name: c.name })), true);
  }

  // A synthetic row with no id on the list still passes, so the hardening did
  // not break the fixtures that already exist.
  const cara = await prisma.client.findFirst({ where: { name: "Cara TEST" }, select: { id: true, name: true } });
  if (cara) check(`existing fixture "Cara TEST" still passes assertTestClient`, throws(() => g.assertTestClient(cara)), false);

  // ---- 5. the live fixtures' send posture --------------------------------
  // The audit in create-test-client.ts found this on Cara TEST; print it here
  // so the number is in one place. clientTextSweeps decides in the QUERY on
  // these two columns and has no test-client gate, so a TEST row with a phone
  // and either switch on is one shoot confirmation from a real outbound text.
  console.log("\n5. LIVE TEST FIXTURES — can any of them actually send?");
  const fixtures = await prisma.client.findMany({
    where: { OR: [{ name: { contains: "TEST" } }, { name: { contains: "Test" } }] },
    select: { id: true, name: true, email: true, phone: true, autoConfirmationText: true, autoDeliveryText: true },
  });
  for (const f of fixtures) {
    if (!g.isTestClientName(f.name)) continue;
    const canText = !!f.phone && (f.autoConfirmationText || f.autoDeliveryText);
    const verified = g.isVerifiedTestDestinationEmail(f.email) && (!f.phone || g.isVerifiedTestDestinationPhone(f.phone));
    console.log(`  ${canText ? "SMS-LIVE " : "no-sms   "} ${verified ? "verified-dest " : "UNVERIFIED-DEST "} "${f.name}"  ${f.email ?? "-"}  ${f.phone ?? "-"}  conf=${f.autoConfirmationText} deliv=${f.autoDeliveryText}`);
  }

  // ---- 6. how much do the fixtures already pollute operations? -----------
  // §16: "exclude fixtures from real operational counts, payouts, reminders
  // and reports." payroll.ts, kpi.ts, finance.ts, bookkeeping.ts and
  // ownerPulse.ts contain ZERO references to isTestClientName as of Sep 21
  // 2026, so nothing excludes them. This measures what that is worth today,
  // so the decision to fix it is made against a number rather than a worry.
  console.log("\n6. OPERATIONAL POLLUTION FROM EXISTING FIXTURES");
  const testIds = fixtures.filter((f) => g.isTestClientName(f.name)).map((f) => f.id);
  const [projects, deliverables, appointments] = await Promise.all([
    prisma.project.count({ where: { clientId: { in: testIds } } }),
    prisma.deliverable.count({ where: { project: { clientId: { in: testIds } } } }),
    prisma.appointment.count({ where: { project: { clientId: { in: testIds } } } }),
  ]);
  console.log(`  ${testIds.length} TEST clients carry ${projects} Projects, ${deliverables} Deliverables, ${appointments} Appointments`);
  console.log(`  every one of those is counted by payroll, KPI and finance today.`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) process.exitCode = 1;
}

function throws(fn: () => void): boolean {
  try { fn(); return false; } catch { return true; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
