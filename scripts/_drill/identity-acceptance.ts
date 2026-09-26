// ---------------------------------------------------------------------------
// DRILL: §18 ACCEPTANCE FOR IDENTITY AND ACCESS (Sep 21 2026, batch 2).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/identity-acceptance.ts
//
// A01 payment/discovery in either order, duplicates · A02 different payer and
// invitee address · A04 a teammate's reach · A22 preparation timing · A51 the
// launch gates.
//
// READ-ONLY, STRUCTURALLY, and that shapes what each test can prove. Where a
// path would WRITE, the drill proves the path by what it refuses before the
// write and by the write being refused by Postgres — never by performing it.
// Production is the only database there is (AGENTS.md), so "run it and see"
// is not available and pretending otherwise is how a drill starts lying.
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

let pass = 0;
let fail = 0;
const ok = (name: string, condition: boolean, detail = "") => {
  if (condition) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  let guard = "NOT PROVEN";
  try { await prisma.appSetting.updateMany({ where: { key: "__drill_readonly_probe__" }, data: { value: "x" } }); }
  catch (e) { guard = /read-only transaction/i.test(String(e)) ? "PROVEN" : "NOT PROVEN"; }
  console.log(`=== READ-ONLY GUARD: ${guard} ===\n`);
  if (guard !== "PROVEN") { console.error("The connection accepted a write. Refusing."); process.exitCode = 1; return; }

  const { PERMISSIONS, can, actorLabel, grantProgramAccess, composeWelcomeEmail, pendingProgramAccess, portalWelcomeKey } = await import("../../src/lib/portalAccess");
  const { payerInviteeConflict } = await import("../../src/lib/programOnboarding");
  const { isAutomationEnabled } = await import("../../src/lib/programAutomation");
  const { liveMemberships } = await import("../../src/lib/portal");

  // =========================================================================
  console.log("=== A51: the launch gates ===");
  const invitesOn = await isAutomationEnabled("portal_invites");
  const loginOn = await isAutomationEnabled("portal_login_email");
  ok("portal_invites is OFF", invitesOn === false, `isAutomationEnabled -> ${invitesOn}`);
  ok("portal_login_email is OFF", loginOn === false, `isAutomationEnabled -> ${loginOn}`);

  // A REAL, paying client. The grant must create nothing at all.
  const real = await prisma.contentEnrollment.findFirst({
    where: { packageSource: "website" },
    select: { id: true, clientId: true },
  });
  if (!real) { ok("a website-sourced enrollment exists to test against", false); }
  else {
    const c = await prisma.client.findUnique({ where: { id: real.clientId }, select: { name: true, email: true } });
    const before = {
      users: await prisma.clientUser.count(),
      seats: await prisma.clientMembership.count(),
      outbox: await prisma.outboxMessage.count({ where: { dedupeKey: { startsWith: "portal_invite:" } } }),
    };
    const g = await grantProgramAccess({ enrollmentId: real.id, emailRaw: c!.email!, name: c!.name, reason: "welcome", requestedBy: "drill" });
    const after = {
      users: await prisma.clientUser.count(),
      seats: await prisma.clientMembership.count(),
      outbox: await prisma.outboxMessage.count({ where: { dedupeKey: { startsWith: "portal_invite:" } } }),
    };
    ok(`grantProgramAccess on a real client (${c!.name}) returns HELD`, g.outcome === "HELD", g.outcome === "HELD" ? g.note : JSON.stringify(g));
    ok("no ClientUser was created", before.users === after.users, `${before.users} -> ${after.users}`);
    ok("no ClientMembership was created", before.seats === after.seats, `${before.seats} -> ${after.seats}`);
    ok("no invitation/welcome was enqueued", before.outbox === after.outbox, `${before.outbox} -> ${after.outbox}`);
  }

  // A TEST client takes the granting path — and hits the read-only wall, which
  // is the proof that the gate let it through rather than the switch stopping it.
  const testClients = await prisma.client.findMany({ where: { name: { contains: "TEST" } }, select: { id: true, name: true } });
  const testEnrollment = testClients.length
    ? await prisma.contentEnrollment.findFirst({ where: { clientId: { in: testClients.map((t) => t.id) } }, select: { id: true, clientId: true } })
    : null;
  if (!testEnrollment) ok("a TEST enrollment exists to exercise the granting path", false);
  else {
    let reached = "did not reach a write";
    try {
      const g2 = await grantProgramAccess({ enrollmentId: testEnrollment.id, emailRaw: "info+granttest@realtourpilot.com", name: "Grant TEST", reason: "teammate", requestedBy: "drill" });
      reached = `returned ${g2.outcome}`;
    } catch (e) {
      reached = /read-only transaction/i.test(String(e)) ? "REACHED THE WRITE (refused by the guard)" : `threw: ${String(e).slice(0, 120)}`;
    }
    ok("a TEST client is allowed past the gate", reached.startsWith("REACHED"), reached);
  }
  // The test-inbox exception is TEST-client AND staff-address. A staff address
  // on a REAL client is still held — otherwise "email it to me" would become a
  // way to open a paying client's account early.
  if (real) {
    const g3 = await grantProgramAccess({ enrollmentId: real.id, emailRaw: "info@realtourpilot.com", name: "Jordan Spackman", reason: "welcome", requestedBy: "drill" });
    ok("a staff address on a REAL client is still HELD", g3.outcome === "HELD", g3.outcome);
  }

  // =========================================================================
  console.log("\n=== A01: one enrollment, correct package, ONE welcome ===");
  const seats = await prisma.clientMembership.findMany({ where: { revokedAt: null }, select: { id: true } });
  const keys = seats.map((s) => portalWelcomeKey(s.id));
  ok("the welcome's identity carries no timestamp", keys.every((k) => k.endsWith(":welcome")), keys[0] ?? "(no seats)");
  const dupes = keys.length !== new Set(keys).size;
  ok("one welcome key per seat", !dupes);
  const owed = await pendingProgramAccess();
  console.log(`  held-access ledger: ${owed.length} row(s) ${owed.map((o) => o.email).join(", ")}`);
  // Enrollment uniqueness is the schema's job, and it does it: clientId is @unique.
  const enrollments = await prisma.contentEnrollment.count();
  const clientsWithEnrollment = (await prisma.contentEnrollment.findMany({ select: { clientId: true } })).map((e) => e.clientId);
  ok("one enrollment per client", new Set(clientsWithEnrollment).size === enrollments, `${enrollments} enrollments, ${new Set(clientsWithEnrollment).size} distinct clients`);
  console.log("\n  The welcome, as it would be sent (composed, NOT enqueued):");
  const sample = await composeWelcomeEmail({ name: "Kristin Ciarmella", clientName: "Kristin Ciarmella", reason: "welcome" });
  console.log(sample.split("\n").map((l) => `    | ${l}`).join("\n"));
  ok("no em dashes in the welcome", !/—/.test(sample));
  ok("no emoji in the welcome", !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(sample));
  ok("the welcome links to the DURABLE sign-in page, not a one-time token", sample.includes("/portal/login"));
  const teammate = await composeWelcomeEmail({ name: "Dana Reyes", clientName: "Kristin Ciarmella", reason: "teammate" });
  ok("the teammate note says actions carry their own name", /under your own name/i.test(teammate));

  // =========================================================================
  console.log("\n=== A02: a different payer and invitee address ===");
  const arielle = await prisma.client.findFirst({ where: { name: { contains: "Arielle" } }, select: { id: true, name: true, email: true, backupEmail: true } });
  const call = await prisma.programCallRecord.findFirst({ where: { inviteeEmail: { contains: "foxroach" } }, select: { inviteeEmail: true, matchState: true } });
  if (arielle && call) {
    const conflict = payerInviteeConflict({ payer: arielle.email, invitee: call.inviteeEmail, knownEmails: [arielle.email, arielle.backupEmail] });
    ok("the live Arielle payer/invitee mismatch is detected", !!conflict, conflict?.message ?? "no conflict returned");
    ok("nothing on the client record was treated as a match", arielle.backupEmail == null, `backupEmail=${arielle.backupEmail ?? "null"}, call matchState=${call.matchState}`);
    const alias = await prisma.clientEmailAlias.findFirst({ where: { email: call.inviteeEmail!.toLowerCase() }, select: { verifiedAt: true, active: true } });
    ok("the alias is a PROPOSAL, not a verified match", !!alias && alias.verifiedAt == null, alias ? `verifiedAt=${alias.verifiedAt}` : "no alias row");
  } else ok("live payer/invitee mismatch is available to test", false);
  // The same address on both sides is not a conflict.
  ok("same address on both sides is not a conflict", payerInviteeConflict({ payer: "a@b.com", invitee: "A@B.com", knownEmails: [] }) === null);
  ok("an address already on the client record is not a conflict", payerInviteeConflict({ payer: "a@b.com", invitee: "c@d.com", knownEmails: ["c@d.com"] }) === null);
  ok("a missing invitee address is not a conflict", payerInviteeConflict({ payer: "a@b.com", invitee: null, knownEmails: [] }) === null);

  // =========================================================================
  console.log("\n=== A04: what a teammate may do, and only for this client ===");
  console.log(`  OWNER        : ${Object.entries(PERMISSIONS.OWNER).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
  console.log(`  COLLABORATOR : ${Object.entries(PERMISSIONS.COLLABORATOR).filter(([, v]) => v).map(([k]) => k).join(", ") || "(none)"}`);
  console.log(`  VIEWER       : ${Object.entries(PERMISSIONS.VIEWER).filter(([, v]) => v).map(([k]) => k).join(", ") || "(none)"}`);
  ok("an OWNER-seat teammate gets §4.9's list", PERMISSIONS.OWNER.approveEdits && PERMISSIONS.OWNER.editBrandProfile && PERMISSIONS.OWNER.requestSession && PERMISSIONS.OWNER.requestChanges && PERMISSIONS.OWNER.suggest);
  ok("a VIEWER may do nothing", Object.values(PERMISSIONS.VIEWER).every((v) => !v));
  ok("the shared link may NOT hand out seats", !can({ enrollment: { id: "x", clientName: "c" } as never, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" }, "manageTeam"));
  ok("the shared link may NOT approve", !can({ enrollment: { id: "x", clientName: "c" } as never, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" }, "approveEdits"));
  const paused = can({ enrollment: { id: "x", clientName: "c", status: "PAUSED" } as never, actor: { kind: "CLIENT", clientUserId: "u", email: "e@f.g", name: "N", membershipId: "m", membershipRole: "OWNER" }, access: "READ_ONLY", via: "LOGIN" }, "requestSession");
  ok("a paused program refuses new work even to an owner seat", !paused);
  const label = actorLabel({ enrollment: { id: "x", clientName: "Kristin Ciarmella" } as never, actor: { kind: "CLIENT", clientUserId: "u", email: "dana@x.com", name: "Dana Reyes", membershipId: "m", membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" });
  ok("a teammate's actions are attributed to the teammate", label === "Dana Reyes", label);
  for (const u of await prisma.clientUser.findMany({ select: { id: true, email: true } })) {
    const live = await liveMemberships(u.id);
    console.log(`  ${u.email}: ${live.length} live seat(s) -> ${live.map((m) => m.clientName).join(", ") || "none"}`);
    ok(`${u.email} reaches only the programs it holds a seat on`, live.length <= 1 || new Set(live.map((m) => m.enrollmentId)).size === live.length);
  }

  // =========================================================================
  // Clarification 5. The rule is pure, so the ambiguous cases can be put to it
  // directly instead of hoping production happens to contain one.
  console.log("\n=== Clarification 5: what an AMBIGUOUS transcript match does ===");
  const { pairTranscriptCandidates } = await import("../../src/lib/contentCallRecords");
  const R = { startToleranceMinutes: 20 };
  const at = (iso: string) => new Date(iso);
  const doc = (id: string, name: string, heldAt: string | null, createdAt: string) => ({ id, name, prefix: name.split(" - ")[0], heldAt: heldAt ? at(heldAt) : null, createdAt: at(createdAt), link: null });

  // One call, one doc whose title prefix IS the calendar summary → auto.
  const one = pairTranscriptCandidates(
    [{ id: "r1", scheduledStart: at("2026-09-11T18:30:00Z"), calendarSummary: "Arielle Roemer and Jordan Spackman" }],
    [doc("d1", "Arielle Roemer and Jordan Spackman - 2026/09/11 13:30 CDT - Notes by Gemini", "2026-09-11T18:30:00Z", "2026-09-11T20:00:00Z")],
    R,
  ).get("r1")!;
  ok("one exclusive strong match auto-confirms", one.auto !== null, one.auto?.why);

  // TWO calls with the same client on the same day, one doc that is strong for
  // both → neither is confirmed. This is the case §5 forbids guessing on.
  const twoCalls = pairTranscriptCandidates(
    [
      { id: "rA", scheduledStart: at("2026-09-11T18:30:00Z"), calendarSummary: "Arielle Roemer and Jordan Spackman" },
      { id: "rB", scheduledStart: at("2026-09-11T18:35:00Z"), calendarSummary: "Arielle Roemer and Jordan Spackman" },
    ],
    [doc("d1", "Arielle Roemer and Jordan Spackman - 2026/09/11 13:30 CDT - Notes by Gemini", "2026-09-11T18:30:00Z", "2026-09-11T20:00:00Z")],
    R,
  );
  ok("a doc strong for two calls confirms on neither", twoCalls.get("rA")!.auto === null && twoCalls.get("rB")!.auto === null);
  ok("both calls still see it as a candidate for a person", twoCalls.get("rA")!.list.length === 1 && twoCalls.get("rB")!.list.length === 1);

  // A doc with the right TIME but somebody else's meeting title → candidate only.
  const wrongTitle = pairTranscriptCandidates(
    [{ id: "r1", scheduledStart: at("2026-09-11T18:30:00Z"), calendarSummary: "Arielle Roemer and Jordan Spackman" }],
    [doc("d2", "Rick Schultz and Jordan Spackman - 2026/09/11 14:30 EDT - Notes by Gemini", "2026-09-11T18:30:00Z", "2026-09-11T20:00:00Z")],
    R,
  ).get("r1")!;
  ok("a same-time doc with another person's title never auto-confirms", wrongTitle.auto === null && wrongTitle.list.length === 1, wrongTitle.list[0]?.why);

  // No calendar link to compare the title against → candidate only, never auto.
  const noCalendar = pairTranscriptCandidates(
    [{ id: "r1", scheduledStart: at("2026-09-11T18:30:00Z"), calendarSummary: null }],
    [doc("d1", "Arielle Roemer and Jordan Spackman - 2026/09/11 13:30 CDT - Notes by Gemini", "2026-09-11T18:30:00Z", "2026-09-11T20:00:00Z")],
    R,
  ).get("r1")!;
  ok("no calendar linkage means no auto-confirm, however close the time", noCalendar.auto === null, noCalendar.list[0]?.why);

  // The rules §5 forbids: a similar filename, a first name, "newest".
  const firstNameOnly = pairTranscriptCandidates(
    [{ id: "r1", scheduledStart: at("2026-09-11T18:30:00Z"), calendarSummary: "Arielle Roemer and Jordan Spackman" }],
    [doc("d3", "Arielle and Jordan - 2026/09/11 13:30 CDT - Notes by Gemini", "2026-09-11T18:30:00Z", "2026-09-11T20:00:00Z")],
    R,
  ).get("r1")!;
  ok("a first-name-only title is not ownership", firstNameOnly.auto === null, firstNameOnly.list[0]?.why);
  const farAway = pairTranscriptCandidates(
    [{ id: "r1", scheduledStart: at("2026-09-11T18:30:00Z"), calendarSummary: "Arielle Roemer and Jordan Spackman" }],
    [doc("d4", "Arielle Roemer and Jordan Spackman - 2026/09/12 13:30 EDT - Notes by Gemini", "2026-09-12T17:30:00Z", "2026-09-12T19:00:00Z")],
    R,
  ).get("r1")!;
  ok("the newest transcript is not the answer either — it is out of the window", farAway.list.length === 0);

  // =========================================================================
  console.log("\n=== A22: preparation timing, as the gate computes it ===");
  const { addWeekdayHoursET, DEFAULT_PREPARATION_WINDOW_HOURS } = await import("../../src/lib/programMonths");
  const et = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  // W01 (Sep 25 2026): 72 weekday hours, not 48 — §3's own examples.
  ok("the window is 72 hours of weekday time", DEFAULT_PREPARATION_WINDOW_HOURS === 72, String(DEFAULT_PREPARATION_WINDOW_HOURS));
  const mon = new Date("2026-09-14T18:00:00Z"); // Mon 2:00 PM ET
  const fri = new Date("2026-09-18T14:00:00Z"); // Fri 10:00 AM ET
  const monOut = addWeekdayHoursET(mon, DEFAULT_PREPARATION_WINDOW_HOURS);
  const friOut = addWeekdayHoursET(fri, DEFAULT_PREPARATION_WINDOW_HOURS);
  ok("Monday 2 PM -> Thursday 2 PM", et(monOut) === "Thu, Sep 17, 2:00 PM", et(monOut));
  ok("Friday 10 AM -> Wednesday 10 AM (the weekend does not count)", et(friOut) === "Wed, Sep 23, 10:00 AM", et(friOut));
  const springForward = addWeekdayHoursET(new Date("2026-03-05T19:00:00Z"), DEFAULT_PREPARATION_WINDOW_HOURS); // Thu Mar 5, 2:00 PM ET
  ok("the March transition keeps the time of day", /2:00 PM/.test(et(springForward)), et(springForward));
  const fallBack = addWeekdayHoursET(new Date("2026-10-29T18:00:00Z"), DEFAULT_PREPARATION_WINDOW_HOURS); // Thu Oct 29, 2:00 PM EDT
  ok("the November transition keeps the time of day", /2:00 PM/.test(et(fallBack)), et(fallBack));

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
