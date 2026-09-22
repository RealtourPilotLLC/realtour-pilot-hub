// ---------------------------------------------------------------------------
// DRILL: THE TEST-CLIENT SEND FLOOR (§16, Sep 22 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/test-client-send-floor.ts
//
// Phase 0: nothing stood between a synthetic client and a real outbound
// message. Every protection was a per-feature check that a new send path only
// had to forget. This proves the floor under all of them — against the LIVE
// database, read-only, with a connection that cannot execute a write.
//
// It does not send anything. It asks the guard about real rows: the two live
// "Jordan Spackman" look-alikes (which must NOT be blocked — they are real
// clients and their texts run today), and the synthetic ones (which must be
// blocked at any destination Jordan has not verified).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

function makeTheDatabaseReadOnly(): void {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    const file = path.resolve(__dirname, "../../.env");
    const m = fs.existsSync(file) ? fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m) : null;
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}
makeTheDatabaseReadOnly();

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const { prisma } = await import("../../src/lib/prisma");

  let guard = "NOT PROVEN";
  try {
    await prisma.appSetting.updateMany({ where: { key: "__send_floor_probe__" }, data: { value: "x" } });
  } catch (e) {
    guard = /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "PROVEN" : "NOT PROVEN";
  }
  console.log(`\n=== READ-ONLY GUARD: ${guard} ===\n`);
  if (guard !== "PROVEN") throw new Error("Refusing to run without a connection that cannot write.");

  const { enqueue, TestClientSendRefusedError } = await import("../../src/lib/outbox");
  const { JORDAN_TEST_PHONE_DIGITS, JORDAN_TEST_EMAIL } = await import("../../src/lib/testClients");

  const tryEnqueue = async (clientId: string, channel: "sms" | "email", toRef: string): Promise<"refused" | "allowed" | string> => {
    try {
      await enqueue({ channel, toRef, body: "drill — never sent", dedupeKey: `drill:${clientId}:${toRef}:${channel}`, clientId });
      return "allowed";
    } catch (e) {
      if (e instanceof TestClientSendRefusedError) return "refused";
      // Anything else is the read-only connection refusing the INSERT, which
      // means the guard let it through — which is the answer we want to record.
      return /read-only transaction/i.test(e instanceof Error ? e.message : String(e)) ? "allowed" : `error: ${String(e).slice(0, 80)}`;
    }
  };

  // ---- real clients must be untouched -------------------------------------
  const real = await prisma.client.findMany({
    where: { id: { in: ["cmqikskt1008u9k9qej9ltjy5", "cmtl9n46u0001la04skvn78nb"] } },
    select: { id: true, name: true, phone: true },
  });
  console.log(`the two live "Jordan Spackman" rows on file: ${real.length}`);
  for (const c of real) {
    const r = await tryEnqueue(c.id, "sms", "6105550123");
    ok(`a REAL client ("${c.name}") is not blocked`, r === "allowed", r);
  }

  const someReal = await prisma.client.findMany({ where: { phone: { not: null } }, select: { id: true, name: true }, take: 40 });
  const { isTestClientName } = await import("../../src/lib/testClients");
  const otherReal = someReal.find((c) => !isTestClientName(c.name)) ?? null;
  if (otherReal) {
    const r = await tryEnqueue(otherReal.id, "sms", "6105550124");
    ok(`another real client ("${otherReal.name}") is not blocked`, r === "allowed", r);
  }

  // ---- synthetic clients ---------------------------------------------------
  const tests = await prisma.client.findMany({ where: { name: { contains: "TEST", mode: "insensitive" } }, select: { id: true, name: true, phone: true } });
  console.log(`\nsynthetic clients on file: ${tests.length} — ${tests.map((t) => t.name).join(", ")}`);
  for (const c of tests) {
    ok(`"${c.name}" cannot be texted at an unverified number`, (await tryEnqueue(c.id, "sms", "6105550199")) === "refused");
    ok(`"${c.name}" cannot be emailed at an unverified address`, (await tryEnqueue(c.id, "email", "someone@example.com")) === "refused");
    ok(`"${c.name}" CAN be texted at Jordan's verified number`, (await tryEnqueue(c.id, "sms", JORDAN_TEST_PHONE_DIGITS)) === "allowed");
    ok(`"${c.name}" CAN be emailed at Jordan's verified address`, (await tryEnqueue(c.id, "email", JORDAN_TEST_EMAIL)) === "allowed");
  }

  // The 267 number is explicitly NOT a verified destination — it sits on three
  // different client rows and nobody established whose handset it is.
  const jordanTest = tests.find((t) => /jordan/i.test(t.name ?? ""));
  if (jordanTest) {
    ok("the unverified 267 look-alike number is still refused", (await tryEnqueue(jordanTest.id, "sms", "2678279038")) === "refused");
  }

  // A message with no client attached is not this floor's business.
  ok("a message with no client is not blocked", (await tryEnqueue("", "sms", "6105550125")) !== "refused");

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
