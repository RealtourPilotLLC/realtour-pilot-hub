// ---------------------------------------------------------------------------
// DRILL: JORDAN'S TEST INBOXES (Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/test-inboxes.ts
//
// Jordan, Sep 28: "Bobby TEST Michael TEST was just a test account" and "the
// test email for bobby test can just be my jspackman215@gmail.com so I can see
// the test emails". jspackman215@gmail.com and bobmike0214@gmail.com are his.
//
// OLD behaviour first, and for real. ddce2d1 (pinned, never HEAD) is exported
// with `git archive` into a temp directory (read-only on the repository) and
// this same file runs INSIDE that tree as a child process on the same PGlite
// database — so every "@/lib/…" the old pass touches is ddce2d1's own code,
// guards and testClients alike, not a mix.
//
//    1. THE LAW, pure: both Gmail inboxes refused by ddce2d1, accepted now;
//       info@ and its plus-addresses unchanged; Gmail's own dot/+tag rule on
//       gmail.com only; a stranger's Gmail, lookalikes (gmail.co,
//       jspackman2150@, gmai1.com, googlemail.com) and dots on Workspace
//       refused; the phone law and the staff-controlled floor untouched; the
//       fixture identity accepts two different ones of Jordan's inboxes and
//       refuses Jordan's REAL Aryeo customer by id.
//    2. scripts/_ops/set-fixture-email.ts: Bobby → jspackman215@ on PGlite —
//       dry run writes nothing; --apply backs up (0600, outside the repo),
//       writes one column, audits, reads back; a re-run is a no-op; a non-TEST
//       name, a never-synthetic id renamed TEST, an address outside the list,
//       a TEST row on a stranger's inbox, a real Jordan Aryeo customer, a
//       backup inside the repo, a row that moves mid-write — all refused with
//       nothing written.
//    3. Bobby after the script, through the hub's own guards — ddce2d1's tree
//       first (child process), then this one: the fixture-list writer, the
//       Aryeo write permit, the TEST-client send floor, the Calendly scope,
//       readiness's fixture scope, the supervised Aryeo test's identity step.
//       ddce2d1 refuses every one; now each accepts.
//    4. still refused now: a stranger's Gmail on a TEST row, a real client
//       named TEST with a stranger's inbox, lookalike inboxes, a
//       never-synthetic row renamed TEST on Jordan's Gmail, and a TEST row
//       holding Jordan's REAL Aryeo customer (which reads as jspackman215@).
//    5. the Aryeo customer-user syncs (review, Sep 28): they match hub rows by
//       email alone, and jspackman215@ is ALSO the inbox of Jordan's REAL Aryeo
//       customer-user. ddce2d1's syncAryeoCustomers / syncAryeoSocialPlans
//       copy that real record's headshot, company, licence and social plan
//       onto Bobby — or unflag him when it has no social fields. Now a TEST
//       fixture takes nothing from an email match; the real row still syncs,
//       and so does a never-synthetic row renamed TEST.
//
// ISOLATION: PGlite on 127.0.0.1:DRILL_PORT (default 5962). Every non-loopback
// call is fenced, in both processes; the only Aryeo answers are canned GET
// /customers/{id} and (section 5, parent only) GET /customer-users. Nothing is
// sent, nothing real is contacted.
// THE CLOCK IS PINNED to Tue Sep 29 2026 10:00 ET (both processes).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { attachDrillChild, bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors, runDrillChild } from "./_harness";
import { createFixtureCustomers } from "./_fixtures/fixtureIdentity";

const PORT = Number(process.env.DRILL_PORT ?? 5962);
const BASE = "ddce2d1"; // pinned: the tree this change starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");
const OLD_PASS = "--old-pass";

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 8, 29, 14, 0, 0); // Tue Sep 29 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

// The real ids the main session will use, so the drill proves that exact command.
const BOBBY_ID = "cmtl98xl90008jl04yt5zawnv";
const BOBBY_CUSTOMER = "018f10e1-0000-4000-8000-00000000b0b1"; // a stand-in: only the prefix of Bobby's real customer is on record
const JSP = "jspackman215@gmail.com";
const BOB = "bobmike0214@gmail.com";
const STRANGER = "bobby.realperson@gmail.com";

type OldSpec = { customers: [string, string][] };

// ============================================================================
// SECTION 3's CORE, run twice: by the child inside ddce2d1's tree, and by the
// parent in this one. The same questions of Bobby (hub email jspackman215@,
// Aryeo customer bobmike0214@), answered by whichever tree loaded the modules.
// Returns what each guard said; the caller decides what that should have been.
// ============================================================================
type GuardAnswers = {
  fixtureAdd: { code: number; refused?: string; listed: string[]; enabled: boolean };
  permit: { ok: boolean; scope?: string; sandbox?: boolean; customer?: string | null; reason?: string };
  sends: { to: string; channel: "email" | "sms"; outcome: string }[];
  calendly: { invitee: string; ok: boolean; scope?: string; reason?: string }[];
  readiness: { entryProblems: string[]; blocking: string[] };
  supervised: { code: number; refused?: string; identityLine: string | null };
  inboxLaw: { jsp: boolean; bob: boolean; hasInboxList: boolean };
};

async function askTheGuards(tag: string, resetCache: () => void): Promise<GuardAnswers> {
  const { prisma } = await import("@/lib/prisma");
  const tc = await import("@/lib/testClients");
  const aryeo = await import("@/lib/integrations/aryeo");
  const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });
  const bobby = await prisma.client.findUniqueOrThrow({ where: { id: BOBBY_ID } });
  const who = { id: bobby.id, name: bobby.name };

  // The fixture-list writer (Settings' Remove + scripts/_ops/hub-write-fixture.ts), from an empty, OFF switch.
  await setSwitch("session_booking", false, { authorizedFixtureClientIds: [] });
  const { hubWriteFixture } = await import("../_ops/hub-write-fixture");
  const add = await hubWriteFixture(["--switch", "session_booking", "--add", BOBBY_ID, "--on", "--apply"], () => {});
  const row = await prisma.programAutomation.findUniqueOrThrow({ where: { key: "session_booking" } });
  const listed = (JSON.parse(row.configJson ?? "{}") as { authorizedFixtureClientIds?: string[] }).authorizedFixtureClientIds ?? [];
  const fixtureAdd = { code: add.code, refused: add.refused, listed, enabled: row.enabled };

  // The Aryeo write permit (R02), with Bobby listed and the switch on whatever the writer did.
  await setSwitch("session_booking", true, { authorizedFixtureClientIds: [BOBBY_ID] });
  resetCache();
  const p = await aryeo.hubWritePermit({ switchKey: "session_booking", client: who, operation: "orders.create" });
  const permit = p.ok ? { ok: true, scope: p.scope, sandbox: p.permit.sandbox, customer: p.permit.aryeoCustomerId } : { ok: false, reason: p.reason };

  // The TEST-client send floor (outbox): enqueue only; nothing drains in a drill.
  const outbox = await import("@/lib/outbox");
  const sends: GuardAnswers["sends"] = [];
  for (const [channel, to] of [["email", JSP], ["email", BOB], ["email", STRANGER], ["email", "jspackman215@gmail.co"], ["email", "jspackman2150@gmail.com"], ["sms", "+12678279038"], ["sms", "+12155348650"]] as const) {
    let outcome = "allowed";
    try {
      await outbox.enqueue({ channel, toRef: to, body: "drill — never sent", dedupeKey: `drill:test-inboxes:${tag}:${channel}:${to}`, clientId: BOBBY_ID });
    } catch (e) {
      outcome = e instanceof outbox.TestClientSendRefusedError ? "refused" : `error: ${String(e).slice(0, 80)}`;
    }
    sends.push({ to, channel, outcome });
  }

  // Calendly's scope (W03).
  const cb = await import("@/lib/callBooking");
  await setSwitch("call_booking", true, { mode: "EMBED", authorizedFixtureClientIds: [BOBBY_ID] });
  const calendly: GuardAnswers["calendly"] = [];
  for (const invitee of [JSP, "info@realtourpilot.com", "jspackman215@gmail.co"]) {
    const s = await cb.callBookingScope({ client: who, operation: "invitees.create", inviteeEmail: invitee });
    calendly.push(s.ok ? { invitee, ok: true, scope: s.scope } : { invitee, ok: false, reason: s.reason });
  }
  await setSwitch("call_booking", false, { mode: "EMBED", authorizedFixtureClientIds: [] });

  // Readiness's fixture scope (A56).
  const { fixtureScope } = await import("@/lib/readiness");
  const { parseHubWriteConfig } = await import("@/lib/hubWritePermit");
  const readiness = fixtureScope(parseHubWriteConfig({ authorizedFixtureClientIds: [BOBBY_ID] }), new Map([[BOBBY_ID, { id: BOBBY_ID, name: bobby.name, email: bobby.email }]]), new Date());

  // The supervised Aryeo test's identity step (dry run: reads only).
  const { aryeoSupervisedTest } = await import("../_ops/aryeo-supervised-test");
  const lines: string[] = [];
  resetCache();
  const sup = await aryeoSupervisedTest(["--fixture", BOBBY_ID], (l) => { lines.push(l); });
  const supervised = { code: sup.code, refused: sup.refused, identityLine: lines.find((l) => l.startsWith("Fixture: ")) ?? null };

  await setSwitch("session_booking", false, { authorizedFixtureClientIds: [] });
  const inboxLaw = { jsp: tc.isVerifiedTestDestinationEmail(JSP), bob: tc.isVerifiedTestDestinationEmail(BOB), hasInboxList: "JORDAN_TEST_INBOXES" in tc };
  return { fixtureAdd, permit, sends, calendly, readiness, supervised, inboxLaw };
}

// ============================================================================
// THE CHILD: ddce2d1's tree, this database.
// ============================================================================
async function oldPass(): Promise<void> {
  const spec = JSON.parse(process.argv[process.argv.indexOf(OLD_PASS) + 1] ?? "{}") as OldSpec;
  const ids = createFixtureCustomers();
  for (const [id, email] of spec.customers ?? []) ids.setCustomer(id, email);
  fenceFetch(async (url, init) => ids.route(url, init)); // before attach: the child's fence answers Aryeo's GET /customers
  const ctx = attachDrillChild();
  try {
    const aryeo = await import("@/lib/integrations/aryeo");
    const answers = await askTheGuards(BASE, () => aryeo.resetFixtureIdentityCache());
    await ctx.send({ answers, tree: __filename });
  } catch (e) {
    await ctx.send({ error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
  }
  await ctx.exit(0);
}

// ============================================================================
// THE PARENT.
// ============================================================================
async function main(): Promise<void> {
  installNextStubs();
  const ids = createFixtureCustomers();
  // Section 5's canned GET /customer-users (null = not answered, so the fence blocks it).
  let customerUsers: Record<string, unknown>[] | null = null;
  const CUSTOMER_USERS = /^https:\/\/api\.aryeo\.com\/v1\/customer-users(?:[?#].*)?$/;
  const customerUsersRoute = (url: string, init?: RequestInit): Response | null =>
    customerUsers && CUSTOMER_USERS.test(url) && (init?.method ?? "GET").toUpperCase() === "GET"
      ? new Response(JSON.stringify({ data: customerUsers, meta: { current_page: 1, last_page: 1 } }), { status: 200, headers: { "content-type": "application/json" } })
      : null;
  const fence = fenceFetch(async (url, init) => ids.route(url, init) ?? customerUsersRoute(url, init));
  const drill = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const tc = await import("@/lib/testClients");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-key-not-a-real-one");
  const aryeo = await import("@/lib/integrations/aryeo");
  const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(), configJson: config ? JSON.stringify(config) : null }, update: { enabled, configJson: config ? JSON.stringify(config) : null } });

  // ddce2d1, twice: its testClients as a module here (the pure law), and its
  // whole tree on disk for the child (the guards).
  const baseTree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `test-inboxes-${BASE}-`))); // realpath: macOS /var is /private/var
  execFileSync("/bin/sh", ["-c", `git archive ${BASE} src scripts tsconfig.json package.json vercel.json | tar -x -C "$0"`, baseTree], { cwd: REPO });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseTree, "node_modules"));
  fs.copyFileSync(__filename, path.join(baseTree, "scripts/_drill/test-inboxes.ts"));
  const OLD = (await import(path.join(baseTree, "src/lib/testClients.ts"))) as typeof import("../../src/lib/testClients");
  const cleanup = () => fs.rmSync(baseTree, { recursive: true, force: true });

  try {
    // ======================================================================
    c.head(`1 · the law, pure: ${BASE} vs now`);
    {
      c.ok(`${BASE}'s testClients is the one loaded as OLD (JORDAN_TEST_EMAIL, no JORDAN_TEST_INBOXES)`, OLD.JORDAN_TEST_EMAIL === "info@realtourpilot.com" && !("JORDAN_TEST_INBOXES" in OLD));
      for (const inbox of [JSP, BOB]) {
        c.ok(`${inbox}: ${BASE} refuses it`, OLD.isVerifiedTestDestinationEmail(inbox) === false);
        c.ok(`${inbox}: accepted now`, tc.isVerifiedTestDestinationEmail(inbox) === true);
      }
      c.ok("the list is exactly info@ + Jordan's two Gmail inboxes, info@ first", JSON.stringify(tc.JORDAN_TEST_INBOXES) === JSON.stringify(["info@realtourpilot.com", JSP, BOB]));
      c.ok("JORDAN_TEST_EMAIL is still info@realtourpilot.com", tc.JORDAN_TEST_EMAIL === "info@realtourpilot.com");
      for (const same of ["info@realtourpilot.com", "info+jordantest@realtourpilot.com", "  INFO+Cara@RealTourPilot.com "]) {
        c.ok(`unchanged: "${same.trim()}" is verified, then and now`, OLD.isVerifiedTestDestinationEmail(same) && tc.isVerifiedTestDestinationEmail(same));
      }
      c.ok("canonicalInbox keeps its old answers off gmail.com (plus folded, dots kept)",
        ["Info+X@RealTourPilot.com", "a.b+c@example.com", "no-at-sign", ""].every((e) => OLD.canonicalInbox(e) === tc.canonicalInbox(e)),
        ["Info+X@RealTourPilot.com", "a.b+c@example.com"].map((e) => tc.canonicalInbox(e)).join(" · "));
      for (const g of ["J.Spackman215@Gmail.com", "jspackman215+bobby@gmail.com", "j.s.p.a.c.k.m.a.n.2.1.5+x@gmail.com", "bob.mike.0214@gmail.com", " jspackman215@gmail.com "]) {
        c.ok(`Gmail's own rule: "${g.trim()}" is Jordan's inbox`, tc.isVerifiedTestDestinationEmail(g));
      }
      const refused: [string, string][] = [
        [STRANGER, "a stranger's Gmail"],
        ["someone@gmail.com", "another stranger's Gmail"],
        ["info@gmail.com", "info@ on gmail.com (the local part alone proves nothing)"],
        ["jspackman215@gmail.co", "lookalike domain gmail.co"],
        ["jspackman2150@gmail.com", "lookalike local jspackman2150"],
        ["jspackman21@gmail.com", "lookalike local jspackman21"],
        ["bobmike02140@gmail.com", "lookalike local bobmike02140"],
        ["jspackman215@gmai1.com", "lookalike domain gmai1.com"],
        ["jspackman215@gmail.comm", "lookalike domain gmail.comm"],
        ["jspackman215@gmail.com.evil.com", "Jordan's address as a subdomain"],
        ["jspackman215@gmail.com@evil.com", "a second @"],
        ["someone+jspackman215@gmail.com", "Jordan's name as somebody else's +tag"],
        ["jspackman215@googlemail.com", "googlemail.com (deliberately not folded onto gmail.com)"],
        ["jspackman215@realtourpilot.com", "a Gmail local part on the staff domain"],
        ["i.nfo@realtourpilot.com", "dots on Workspace (a dot is part of the address there)"],
        ["hello@realtourpilot.com", "staff-controlled, but somebody else's inbox"],
        ["info@realtorpilot.com", "the misspelled domain on the real Jordan row"],
        ["Jordan <jspackman215@gmail.com>", "a display-name form (not a bare address)"],
        ["", "empty"],
      ];
      for (const [e, why] of refused) c.ok(`refused now: ${why}`, tc.isVerifiedTestDestinationEmail(e) === false, e);
      c.ok("null/undefined refused", !tc.isVerifiedTestDestinationEmail(null) && !tc.isVerifiedTestDestinationEmail(undefined));
      c.ok("the pre-launch floor is untouched: Jordan's Gmail is NOT staff-controlled (portal people stay @realtourpilot.com)", !tc.isStaffControlledEmail(JSP) && !tc.isStaffControlledEmail(BOB) && tc.isStaffControlledEmail("info+x@realtourpilot.com"));
      c.ok("the phone law is untouched: 215-534-8650 yes, the 267 lookalike no", tc.isVerifiedTestDestinationPhone("+12155348650") && !tc.isVerifiedTestDestinationPhone("+12678279038") && OLD.isVerifiedTestDestinationPhone("+12155348650") && !OLD.isVerifiedTestDestinationPhone("+12678279038"));
      const throws = (fn: () => void) => { try { fn(); return ""; } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e); } };
      c.ok(`assertTestDestinations({ email: ${JSP} }): ${BASE} throws, now passes`, !!throws(() => OLD.assertTestDestinations({ email: JSP })) && !throws(() => tc.assertTestDestinations({ email: JSP })));
      const stranger = throws(() => tc.assertTestDestinations({ email: STRANGER }));
      c.ok("a stranger's Gmail still throws, and the refusal names every verified inbox", /NotAVerifiedTestDestinationError/.test(stranger) && stranger.includes("info@realtourpilot.com") && stranger.includes(JSP) && stranger.includes(BOB), stranger);
      const bobby = { clientEmail: JSP, aryeoCustomerId: BOBBY_CUSTOMER, aryeoCustomerEmail: BOB };
      c.ok(`fixture identity, hub ${JSP} + Aryeo ${BOB}: ${BASE} refuses`, !!throws(() => OLD.assertFixtureIdentity(bobby)), throws(() => OLD.assertFixtureIdentity(bobby)).slice(0, 110));
      c.ok("…now accepted", !throws(() => tc.assertFixtureIdentity(bobby)));
      c.ok("…and the other way round (hub bobmike0214@, Aryeo jspackman215@+tag)", !throws(() => tc.assertFixtureIdentity({ clientEmail: BOB, aryeoCustomerId: BOBBY_CUSTOMER, aryeoCustomerEmail: "jspackman215+aryeo@gmail.com" })));
      const realCustomer = tc.fixtureIdentityProblem({ clientEmail: JSP, aryeoCustomerId: tc.NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS[0], aryeoCustomerEmail: JSP });
      c.ok("Jordan's REAL Aryeo customer (reads jspackman215@) is refused by id — the widening does not open it", !!realCustomer && /never-synthetic/.test(realCustomer), realCustomer ?? "accepted");
      c.ok("…whatever case the id arrives in", !!tc.fixtureIdentityProblem({ clientEmail: JSP, aryeoCustomerId: tc.NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS[1].toUpperCase(), aryeoCustomerEmail: BOB }));
      c.ok("a stranger's Gmail as the fixture's own email is refused", /not the verified test inbox/.test(tc.fixtureIdentityProblem({ ...bobby, clientEmail: STRANGER }) ?? ""));
      c.ok("a stranger's Gmail on the Aryeo customer is refused", /bobby\.realperson@gmail\.com/.test(tc.fixtureIdentityProblem({ ...bobby, aryeoCustomerEmail: STRANGER }) ?? ""));
      c.ok("no Aryeo customer, or one that could not be read, is refused", !!tc.fixtureIdentityProblem({ ...bobby, aryeoCustomerId: null }) && /could not be read/.test(tc.fixtureIdentityProblem({ ...bobby, aryeoCustomerEmail: null }) ?? ""));
    }

    // ---- the world ------------------------------------------------------------
    // Bobby as production holds him (docs/content-program-checklist.md): his
    // Gmail, the unverified 267 phone, both auto-text flags on, a linked Aryeo
    // customer on bobmike0214@. And the real "Jordan Spackman" row on
    // jspackman215@ with its real Aryeo customer id.
    const NEVER = tc.NEVER_SYNTHETIC_CLIENT_IDS[0];
    const REAL_JORDAN_CUSTOMER = tc.NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS[0];
    await prisma.client.create({ data: { id: BOBBY_ID, name: "Bobby TEST Michael TEST", email: BOB, phone: "+12678279038", aryeoCustomerId: BOBBY_CUSTOMER, autoConfirmationText: true, autoDeliveryText: true } });
    ids.setCustomer(BOBBY_CUSTOMER, BOB, "Bobby TEST Michael TEST");
    await prisma.client.create({ data: { id: NEVER, name: "Jordan Spackman", email: JSP, phone: "+12678279038", aryeoCustomerId: REAL_JORDAN_CUSTOMER } });
    ids.setCustomer(REAL_JORDAN_CUSTOMER, JSP, "Jordan Spackman");

    // ======================================================================
    c.head("2 · scripts/_ops/set-fixture-email.ts — Bobby → jspackman215@ (PGlite only)");
    {
      const { setFixtureEmail, FIXTURE_EMAIL_AUDIT_ACTION } = await import("../_ops/set-fixture-email");
      const db = prisma as unknown as import("@prisma/client").PrismaClient;
      const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-inboxes-home-"));
      const lines: string[] = [];
      const run = async (argv: string[], dir = backupDir) => { lines.length = 0; return setFixtureEmail(db, argv, { log: (l) => { lines.push(l); }, backupDir: dir }); };
      const snapshot = async () => JSON.stringify(await prisma.client.findMany({ orderBy: { id: "asc" }, select: { id: true, name: true, email: true, backupEmail: true, phone: true, aryeoCustomerId: true } }));
      const audits = () => prisma.auditLog.count({ where: { action: FIXTURE_EMAIL_AUDIT_ACTION } });
      const files = () => fs.readdirSync(backupDir).sort();
      const CMD = ["--client", BOBBY_ID, "--email", JSP];

      // Refusals first — each must leave the rows, the audit log and the backup dir exactly as they were.
      const other = await prisma.client.create({ data: { name: "Marcee Realagent", email: "marcee@realagent.com" } });
      const strangerTest = await prisma.client.create({ data: { name: "Joe Agent TEST", email: "joe.agent@kw.com" } });
      const realCustTest = await prisma.client.create({ data: { name: "Relinked TEST", email: "info+relinked@realtourpilot.com", aryeoCustomerId: tc.NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS[1] } });
      const cases: [string, string[], RegExp][] = [
        ["a real client (no TEST in the name)", ["--client", other.id, "--email", JSP], /not a TEST client/],
        ["a never-synthetic row, even renamed TEST", ["--client", NEVER, "--email", JSP], /never-synthetic/],
        ["a TEST row on a stranger's inbox (a real client named TEST)", ["--client", strangerTest.id, "--email", JSP], /not one of Jordan's inboxes/],
        ["a TEST row linked to a real Jordan Aryeo customer", ["--client", realCustTest.id, "--email", JSP], /real "Jordan Spackman" row/],
        ["a stranger's Gmail as the new address", ["--client", BOBBY_ID, "--email", STRANGER], /not one of Jordan's verified test inboxes/],
        ["lookalike jspackman215@gmail.co", ["--client", BOBBY_ID, "--email", "jspackman215@gmail.co"], /not one of Jordan's verified test inboxes/],
        ["lookalike jspackman2150@gmail.com", ["--client", BOBBY_ID, "--email", "jspackman2150@gmail.com"], /not one of Jordan's verified test inboxes/],
        ["a staff address that is not a test inbox (hello@)", ["--client", BOBBY_ID, "--email", "hello@realtourpilot.com"], /not one of Jordan's verified test inboxes/],
        ["a display-name form", ["--client", BOBBY_ID, "--email", `Jordan <${JSP}>`], /not a plain email address/],
        ["a client that does not exist", ["--client", "cm-no-such-client", "--email", JSP], /does not exist/],
        ["two clients at once", ["--client", BOBBY_ID, "--client", other.id, "--email", JSP], /exactly one --client/],
        ["no address", ["--client", BOBBY_ID], /exactly one --email/],
      ];
      await prisma.client.update({ where: { id: NEVER }, data: { name: "Jordan Spackman TEST" } });
      const before = await snapshot();
      const a0 = await audits();
      for (const [label, argv, why] of cases) {
        const r = await run([...argv, "--apply"]);
        c.ok(`refused with --apply: ${label}`, r.code === 2 && why.test(r.refused ?? ""), r.refused ?? `code ${r.code}`);
      }
      const insideRepo = await run([...CMD, "--apply"], path.join(REPO, "tmp-backups"));
      c.ok("refused with --apply: a backup directory inside the repository", insideRepo.code === 2 && /inside the repository/.test(insideRepo.refused ?? "") && !fs.existsSync(path.join(REPO, "tmp-backups")), insideRepo.refused);
      c.ok("…and every refusal wrote nothing: rows, AuditLog and the backup directory unchanged", (await snapshot()) === before && (await audits()) === a0 && files().length === 0);
      await prisma.client.update({ where: { id: NEVER }, data: { name: "Jordan Spackman" } });

      // The dry run.
      const dry = await run(CMD);
      const bobbyNow = await prisma.client.findUniqueOrThrow({ where: { id: BOBBY_ID } });
      c.ok("DRY RUN: exit 0, nothing written, no backup, no audit row", dry.code === 0 && dry.mode === "dry-run" && bobbyNow.email === BOB && (await audits()) === a0 && files().length === 0);
      c.ok("…it prints the change it would make", lines.some((l) => l === `Would set: Client.email ${BOB} → ${JSP}. Nothing else changes.`), lines.find((l) => l.startsWith("Would set")));
      c.ok("…and names the real row already on jspackman215@ (email-matched readers may attribute it to either)", lines.some((l) => l.includes(NEVER) && l.includes("real, never-synthetic")), lines.filter((l) => l.includes(NEVER)).join(" | "));
      c.ok("…and says the unverified 267 phone stays (texts to it stay refused)", lines.some((l) => /phone\s+\+12678279038 \(NOT a verified test destination\)/.test(l)));
      c.ok("…and names the email-matched readers and the two Aryeo customer-user writers (which skip TEST fixtures)",
        lines.some((l) => /Gmail inbound, the Aryeo import fallback, OpenPhone contacts/.test(l)) && lines.some((l) => /Aryeo customer-user syncs \(headshot\/company\/licence, social flag\/plan\) skip TEST fixtures/.test(l)),
        lines.filter((l) => /Aryeo/.test(l)).join(" | ").slice(0, 200));

      // The apply.
      const beforeApply = await snapshot();
      const applied = await run([...CMD, "--apply"]);
      const after = await prisma.client.findUniqueOrThrow({ where: { id: BOBBY_ID } });
      c.ok("--apply: exit 0, Bobby's hub email is jspackman215@gmail.com", applied.code === 0 && applied.changed === true && after.email === JSP, lines.at(-1));
      c.ok("…ONE column changed: name, phone, backupEmail, Aryeo link and both text flags as they were",
        after.name === bobbyNow.name && after.phone === bobbyNow.phone && after.backupEmail === bobbyNow.backupEmail && after.aryeoCustomerId === BOBBY_CUSTOMER && after.autoConfirmationText === bobbyNow.autoConfirmationText && after.autoDeliveryText === bobbyNow.autoDeliveryText);
      const others = (s: string) => JSON.stringify((JSON.parse(s) as { id: string }[]).filter((r) => r.id !== BOBBY_ID));
      c.ok("…no other client row changed", others(await snapshot()) === others(beforeApply));
      const expected = path.join(backupDir, `rtp-backup-2026-09-29-fixture-${BOBBY_ID}.json`);
      c.ok("the backup is ~/rtp-backup-<ET date>-fixture-<id>.json", applied.backupPath === expected && fs.existsSync(expected), applied.backupPath);
      const mode = fs.existsSync(expected) ? fs.statSync(expected).mode & 0o777 : -1;
      c.ok("…mode 0600", mode === 0o600, mode.toString(8));
      const saved = fs.existsSync(expected) ? JSON.parse(fs.readFileSync(expected, "utf8")) : null;
      c.ok("…holding the WHOLE before-row (email bobmike0214@, the phone, the Aryeo link) and the change", saved?.client?.id === BOBBY_ID && saved.client.email === BOB && saved.client.phone === "+12678279038" && saved.client.aryeoCustomerId === BOBBY_CUSTOMER && saved.change?.from === BOB && saved.change?.to === JSP);
      const audit = await prisma.auditLog.findFirst({ where: { action: FIXTURE_EMAIL_AUDIT_ACTION }, orderBy: { createdAt: "desc" } });
      c.ok("one AuditLog row: target client:<id>, before -> after, the backup path", (await audits()) === a0 + 1 && audit?.id === applied.auditId && audit?.target === `client:${BOBBY_ID}` && audit.detail.startsWith(`email: ${BOB} -> ${JSP}`) && audit.detail.includes(expected), audit?.detail);

      const again = await run([...CMD, "--apply"]);
      c.ok("a second --apply is a no-op: exit 0, no second backup, no second audit row", again.code === 0 && again.changed === false && files().length === 1 && (await audits()) === a0 + 1, lines.join(" | ").slice(-120));

      // The compare-and-set: somebody renames the row the instant before the write's transaction opens.
      const racer = await prisma.client.create({ data: { name: "Racer TEST", email: "info+racer@realtourpilot.com" } });
      const racingDb = new Proxy(db, {
        get(t, k) {
          if (k === "$transaction") {
            return async (fn: never) => {
              await prisma.client.update({ where: { id: racer.id }, data: { name: "Racer Realname" } });
              return t.$transaction(fn);
            };
          }
          const v = (t as unknown as Record<string | symbol, unknown>)[k];
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const raced = await setFixtureEmail(racingDb, ["--client", racer.id, "--email", BOB, "--apply"], { log: () => {}, backupDir });
      const racerAfter = await prisma.client.findUniqueOrThrow({ where: { id: racer.id } });
      c.ok("a row renamed between the read and the write is refused (compare-and-set): nothing written, no audit row", raced.code === 2 && /changed between the read and the write/.test(raced.refused ?? "") && racerAfter.email === "info+racer@realtourpilot.com" && (await audits()) === a0 + 1, raced.refused);
      fs.rmSync(backupDir, { recursive: true, force: true });
    }

    // ======================================================================
    c.head(`3 · Bobby after the script, through the hub's own guards: ${BASE}'s tree refuses, this one accepts`);
    {
      // PGlite is ONE session: two Prisma clients would both prepare "s0". The
      // child's pgbouncer=true makes its statements unnamed, so they cannot
      // collide with this process's (which sits idle while the child runs).
      const childUrl = `${drill.url}${drill.url.includes("?") ? "&" : "?"}pgbouncer=true`;
      const child = runDrillChild(childUrl, path.join(baseTree, "scripts/_drill/test-inboxes.ts"), {
        args: [OLD_PASS, JSON.stringify({ customers: [[BOBBY_CUSTOMER, BOB]] } satisfies OldSpec)],
        env: { TSX_TSCONFIG_PATH: path.join(baseTree, "tsconfig.json") },
      });
      const got = await child.waitFor<{ answers?: GuardAnswers; tree?: string; error?: string }>((m) => !!m && typeof m === "object" && ("answers" in m || "error" in m), 240_000);
      await child.exited;
      // pgbouncer mode ran DEALLOCATE ALL on the one shared session, so this
      // process's named statements are gone: reconnect with an empty cache.
      await prisma.$disconnect();
      await drill.sql("DEALLOCATE ALL");
      if (got.error || !got.answers) {
        c.ok(`the ${BASE} pass ran`, false, got.error ?? "no answers");
      } else {
        const O = got.answers;
        const N = await askTheGuards("now", () => aryeo.resetFixtureIdentityCache());
        c.ok(`the OLD pass really ran ${BASE}'s tree (its testClients has no inbox list and refuses jspackman215@)`, got.tree?.startsWith(baseTree) === true && !O.inboxLaw.hasInboxList && !O.inboxLaw.jsp && !O.inboxLaw.bob, got.tree);
        c.ok("…and this pass ran this tree", N.inboxLaw.hasInboxList && N.inboxLaw.jsp && N.inboxLaw.bob);

        c.ok(`fixture-list writer (hub-write-fixture --add Bobby --on): ${BASE} refuses, writes nothing, leaves the switch off`, O.fixtureAdd.code === 2 && /not the verified test inbox/.test(O.fixtureAdd.refused ?? "") && O.fixtureAdd.listed.length === 0 && !O.fixtureAdd.enabled, O.fixtureAdd.refused);
        c.ok("…now: Bobby listed and the switch on (audited)", N.fixtureAdd.code === 0 && JSON.stringify(N.fixtureAdd.listed) === JSON.stringify([BOBBY_ID]) && N.fixtureAdd.enabled, N.fixtureAdd.refused);

        c.ok(`Aryeo write permit: ${BASE} refuses Bobby (own email not the test inbox)`, !O.permit.ok && /not the verified test inbox/.test(O.permit.reason ?? ""), O.permit.reason?.slice(0, 110));
        c.ok("…now a FIXTURE permit, sandbox:true, on Bobby's OWN Aryeo customer (bobmike0214@)", N.permit.ok && N.permit.scope === "FIXTURE" && N.permit.sandbox === true && N.permit.customer === BOBBY_CUSTOMER, N.permit.reason ?? N.permit.scope);

        const out = (a: GuardAnswers, to: string, channel = "email") => a.sends.find((s) => s.to === to && s.channel === channel)?.outcome;
        for (const inbox of [JSP, BOB]) {
          c.ok(`send floor, email Bobby at ${inbox}: ${BASE} refuses, now enqueued`, out(O, inbox) === "refused" && out(N, inbox) === "allowed", `${out(O, inbox)} → ${out(N, inbox)}`);
        }
        for (const [to, label] of [[STRANGER, "a stranger's Gmail"], ["jspackman215@gmail.co", "jspackman215@gmail.co"], ["jspackman2150@gmail.com", "jspackman2150@gmail.com"]] as const) {
          c.ok(`send floor, email Bobby at ${label}: refused then and now`, out(O, to) === "refused" && out(N, to) === "refused", `${out(O, to)} → ${out(N, to)}`);
        }
        c.ok("send floor, texts: the unverified 267 on Bobby's row refused, the verified 215 allowed — then and now", out(O, "+12678279038", "sms") === "refused" && out(N, "+12678279038", "sms") === "refused" && out(O, "+12155348650", "sms") === "allowed" && out(N, "+12155348650", "sms") === "allowed");
        const queued = await prisma.outboxMessage.findMany({ where: { clientId: BOBBY_ID }, select: { toRef: true, dedupeKey: true } });
        const mine = (tag: string) => queued.filter((q) => q.dedupeKey?.startsWith(`drill:test-inboxes:${tag}:`)).map((q) => q.toRef).sort();
        c.ok(`…a refusal never enqueues: ${BASE} queued only the 215 text; now the two inboxes and the 215 text`, JSON.stringify(mine(BASE)) === JSON.stringify(["+12155348650"]) && JSON.stringify(mine("now")) === JSON.stringify(["+12155348650", BOB, JSP].sort()), `${mine(BASE).join(",")} | ${mine("now").join(",")}`);

        const cal = (a: GuardAnswers, invitee: string) => a.calendly.find((x) => x.invitee === invitee);
        c.ok(`Calendly scope, invitee ${JSP}: ${BASE} refuses, now FIXTURE`, cal(O, JSP)?.ok === false && cal(N, JSP)?.ok === true && cal(N, JSP)?.scope === "FIXTURE", `${cal(O, JSP)?.reason?.slice(0, 80)} → ${cal(N, JSP)?.scope}`);
        c.ok(`…with the default invitee (info@) too: ${BASE} refuses Bobby's own inbox, now FIXTURE`, cal(O, "info@realtourpilot.com")?.ok === false && cal(N, "info@realtourpilot.com")?.scope === "FIXTURE");
        c.ok("…a lookalike invitee is refused now", cal(N, "jspackman215@gmail.co")?.ok === false && /verified test inbox/.test(cal(N, "jspackman215@gmail.co")?.reason ?? ""), cal(N, "jspackman215@gmail.co")?.reason);

        c.ok(`readiness fixture scope: ${BASE} names Bobby's inbox as a problem, now usable`, O.readiness.entryProblems.some((p) => /not the verified test inbox/.test(p)) && N.readiness.entryProblems.length === 0 && N.readiness.blocking.length === 0, `${O.readiness.entryProblems.join("; ")} → ${N.readiness.entryProblems.join("; ") || "none"}`);

        c.ok(`aryeo-supervised-test (dry run): ${BASE} refuses Bobby at the fixture identity`, O.supervised.code === 2 && /verified test inbox/.test(O.supervised.refused ?? "") && !O.supervised.identityLine, O.supervised.refused);
        c.ok("…now the identity holds (hub jspackman215@, Aryeo bobmike0214@) and the dry run goes on to its next check",
          !!N.supervised.identityLine && N.supervised.identityLine.includes(JSP) && N.supervised.identityLine.includes(BOB) && !/verified test inbox|identity/.test(N.supervised.refused ?? ""),
          `${N.supervised.identityLine ?? "(no identity line)"} · then: ${N.supervised.refused ?? "no refusal"}`);
        c.ok(`the ${BASE} child's fence stopped nothing (and reports into this one)`, child.blocked.length === 0, child.blocked.join(", "));
      }
    }

    // ======================================================================
    c.head("4 · still refused now: strangers, real clients named TEST, lookalikes, and Jordan's REAL Aryeo customer");
    {
      const { hubWriteFixture } = await import("../_ops/hub-write-fixture");
      const cb = await import("@/lib/callBooking");
      const outbox = await import("@/lib/outbox");
      let n = 0;
      const row = async (name: string, email: string, customerEmail: string, customerId?: string) => {
        const id = customerId ?? `0197cccc-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        const r = await prisma.client.create({ data: { name, email, aryeoCustomerId: id } });
        ids.setCustomer(id, customerEmail, name);
        return r;
      };
      // The realistic way Jordan's real Aryeo customer could reach a TEST row:
      // the real row's link is cleared (a merge, an unlink), a TEST row takes it.
      await prisma.client.update({ where: { id: NEVER }, data: { aryeoCustomerId: null } });
      const suspects: [string, Awaited<ReturnType<typeof row>>, RegExp][] = [
        ["a TEST row on a stranger's Gmail (its Aryeo customer too)", await row("Stranger TEST", STRANGER, STRANGER), /not the verified test inbox/],
        ["a real client named TEST with a stranger's inbox", await row("Joe Realagent TEST", "joe@realagent.com", "joe@realagent.com"), /not the verified test inbox/],
        ["a TEST row on jspackman215@gmail.co", await row("Lookalike TEST", "jspackman215@gmail.co", BOB), /not the verified test inbox/],
        ["a TEST row on jspackman2150@gmail.com", await row("Lookalike Two TEST", "jspackman2150@gmail.com", BOB), /not the verified test inbox/],
        ["a TEST row on Jordan's Gmail whose Aryeo customer is a stranger's", await row("Mixed TEST", JSP, "cara.agent@kw.com"), /cara\.agent@kw\.com/],
        ["a TEST row on Jordan's Gmail holding Jordan's REAL Aryeo customer (reads jspackman215@)", await row("Relinked Real TEST", JSP, JSP, REAL_JORDAN_CUSTOMER), /never-synthetic/],
      ];
      await setSwitch("session_booking", true, { authorizedFixtureClientIds: suspects.map(([, r]) => r.id) });
      await setSwitch("call_booking", true, { mode: "EMBED", authorizedFixtureClientIds: suspects.map(([, r]) => r.id) });
      const w0 = await prisma.auditLog.count({ where: { action: "automation_fixture_change" } });
      for (const [label, r, why] of suspects) {
        aryeo.resetFixtureIdentityCache();
        const p = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: r.id, name: r.name }, operation: "orders.create" });
        c.ok(`Aryeo permit refused: ${label}`, !p.ok && why.test(p.reason), p.ok ? "ALLOWED" : p.reason.slice(0, 120));
      }
      // The hub-side guards cannot see the Aryeo customer; they refuse on the row's own inbox.
      for (const [label, r] of suspects.slice(0, 4)) {
        const add = await hubWriteFixture(["--switch", "address_sync", "--add", r.id, "--apply"], () => {});
        const cal = await cb.callBookingScope({ client: { id: r.id, name: r.name }, operation: "invitees.create", inviteeEmail: "info@realtourpilot.com" });
        let sent = "allowed";
        try { await outbox.enqueue({ channel: "email", toRef: r.email!, body: "drill — never sent", dedupeKey: `drill:suspect:${r.id}`, clientId: r.id }); } catch (e) { sent = e instanceof outbox.TestClientSendRefusedError ? "refused" : String(e).slice(0, 60); }
        c.ok(`fixture list, Calendly scope and send floor all refuse: ${label}`, add.code === 2 && !cal.ok && sent === "refused", `${add.refused ?? "added"} · ${cal.ok ? "calendly ok" : "calendly refused"} · send ${sent}`);
      }
      c.ok("…and the fixture list was never written", (await prisma.auditLog.count({ where: { action: "automation_fixture_change" } })) === w0);
      // A never-synthetic row renamed TEST, on Jordan's Gmail: refused by id everywhere.
      await prisma.client.update({ where: { id: NEVER }, data: { name: "Jordan Spackman TEST" } });
      await setSwitch("session_booking", true, { authorizedFixtureClientIds: [NEVER] });
      const nv = await aryeo.hubWritePermit({ switchKey: "session_booking", client: { id: NEVER, name: "Jordan Spackman TEST" }, operation: "orders.create" });
      const nvAdd = await hubWriteFixture(["--switch", "address_sync", "--add", NEVER, "--apply"], () => {});
      c.ok("the real Jordan row renamed TEST, on jspackman215@: refused by id (permit and fixture list)", !nv.ok && /never-synthetic/.test(nv.reason) && nvAdd.code === 2 && /real client carrying a TEST name/.test(nvAdd.refused ?? ""), nv.ok ? "ALLOWED" : nv.reason.slice(0, 90));
      await setSwitch("session_booking", false, { authorizedFixtureClientIds: [] });
      await setSwitch("call_booking", false, { mode: "EMBED", authorizedFixtureClientIds: [] });
    }


    // ======================================================================
    c.head(`5 · the Aryeo customer-user syncs: Bobby on jspackman215@ takes nothing from Jordan's REAL customer (${BASE} vs now)`);
    {
      // ddce2d1's aryeo.ts, byte for byte, its imports aimed at this tree (so
      // both passes share this process's prisma and the same PGlite rows).
      const oldAryeoPath = path.join(baseTree, "src/lib/integrations/aryeo.base.ts");
      fs.writeFileSync(oldAryeoPath, execFileSync("git", ["show", `${BASE}:src/lib/integrations/aryeo.ts`], { cwd: REPO, encoding: "utf8" })
        .replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`)
        .replace(/(["'])\.\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src/lib/integrations", p)}${q}`));
      const OLD_ARYEO = (await import(oldAryeoPath)) as typeof import("../../src/lib/integrations/aryeo");

      // Jordan's REAL customer-user (jspackman215@) and Bobby's own (bobmike0214@).
      const social = (plan: string) => ({ customer_team_memberships: [{ user: { custom_field_entries: [
        { custom_field: { data: { name: "Social Client" } }, value: "Yes" },
        { custom_field: { data: { name: "Social Content Plan" } }, value: plan },
      ] } }] });
      const REAL_HEADSHOT = "https://cdn.drill.invalid/jordan-real-headshot.jpg";
      const realCu = (withSocial: boolean) => ({ id: "0197eeee-0000-4000-8000-00000000real", full_name: "Jordan Spackman", email: JSP, agent_company_name: "Real Brokerage DRILL", agent_license_number: "RS-0000-REAL", avatar_url: REAL_HEADSHOT, ...(withSocial ? social("Pro") : {}) });
      const bobCu = { id: "0197eeee-0000-4000-8000-0000000b0b1e", full_name: "Bobby TEST Michael TEST", email: BOB, avatar_url: null };
      const BOBBY_HEADSHOT = "https://cdn.drill.invalid/bobby-fixture.jpg";
      const pick = { name: true, email: true, avatarUrl: true, company: true, licenseNumber: true, socialClient: true, socialPlan: true, generalNotes: true } as const;
      // Bobby as the fixture holds him, and the real row as it would be before a sync.
      const reset = async () => {
        await prisma.client.update({ where: { id: BOBBY_ID }, data: { email: JSP, avatarUrl: BOBBY_HEADSHOT, company: null, licenseNumber: null, socialClient: true, socialPlan: "Starter" } });
        await prisma.client.update({ where: { id: NEVER }, data: { name: "Jordan Spackman", avatarUrl: null, company: null, licenseNumber: null, socialClient: false, socialPlan: null } });
      };
      const bobbyRow = () => prisma.client.findUniqueOrThrow({ where: { id: BOBBY_ID }, select: pick });
      const realRow = () => prisma.client.findUniqueOrThrow({ where: { id: NEVER }, select: pick });

      // ---- ddce2d1 --------------------------------------------------------
      await reset();
      customerUsers = [realCu(true), bobCu];
      await OLD_ARYEO.syncAryeoCustomers();
      await OLD_ARYEO.syncAryeoSocialPlans();
      const ob = await bobbyRow();
      c.ok(`${BASE}: Bobby TEST takes the REAL customer's headshot (a mirror, rewritten every run)`, ob.avatarUrl === REAL_HEADSHOT, String(ob.avatarUrl));
      c.ok(`${BASE}: …and fills his blank company and licence from the real record`, ob.company === "Real Brokerage DRILL" && ob.licenseNumber === "RS-0000-REAL", `${ob.company} · ${ob.licenseNumber}`);
      c.ok(`${BASE}: …and copies the real customer's social plan onto him (Starter → Pro)`, ob.socialClient === true && ob.socialPlan === "Pro", `${ob.socialClient}/${ob.socialPlan}`);
      await reset();
      customerUsers = [realCu(false), bobCu];
      await OLD_ARYEO.syncAryeoSocialPlans();
      const ou = await bobbyRow();
      c.ok(`${BASE}: with no social fields on the real record, Bobby (an ACTIVE fixture) is UNFLAGGED`, ou.socialClient === false && ou.socialPlan === null, `${ou.socialClient}/${ou.socialPlan}`);

      // ---- now ------------------------------------------------------------
      await reset();
      const before = JSON.stringify(await bobbyRow());
      customerUsers = [realCu(true), bobCu];
      const e1 = await aryeo.syncAryeoCustomers();
      const s1 = await aryeo.syncAryeoSocialPlans();
      c.ok("NOW: Bobby TEST is left exactly as he was — headshot, company, licence, social flag and plan, notes", JSON.stringify(await bobbyRow()) === before, JSON.stringify(await bobbyRow()).slice(0, 160));
      c.ok("…and both syncs say they skipped fixtures", e1.fixturesSkipped >= 1 && s1.fixturesSkipped >= 1, `customers ${JSON.stringify(e1)} · social ${JSON.stringify(s1)}`);
      const nr = await realRow();
      c.ok("NOW: the real Jordan row still syncs — the headshot, the blank company and licence, the social plan", nr.avatarUrl === REAL_HEADSHOT && nr.company === "Real Brokerage DRILL" && nr.licenseNumber === "RS-0000-REAL" && nr.socialClient === true && nr.socialPlan === "Pro", JSON.stringify(nr).slice(0, 180));
      customerUsers = [realCu(false), bobCu];
      await aryeo.syncAryeoSocialPlans();
      const nu = await bobbyRow();
      c.ok("NOW: with no social fields on the real record, Bobby stays flagged (Starter) — the unflag was never his", nu.socialClient === true && nu.socialPlan === "Starter", `${nu.socialClient}/${nu.socialPlan}`);
      c.ok("…while the real row, present and fieldless, is unflagged as before", (await realRow()).socialClient === false);
      // A never-synthetic row renamed TEST is still real: it keeps syncing.
      await reset();
      await prisma.client.update({ where: { id: NEVER }, data: { name: "Jordan Spackman TEST" } });
      customerUsers = [realCu(true), bobCu];
      await aryeo.syncAryeoCustomers();
      await aryeo.syncAryeoSocialPlans();
      const rn = await realRow();
      c.ok("NOW: the real Jordan row renamed \"… TEST\" is still real (by id) and still takes its own record", rn.avatarUrl === REAL_HEADSHOT && rn.socialPlan === "Pro", `${rn.avatarUrl} · ${rn.socialPlan}`);
      c.ok("…and Bobby is still untouched", JSON.stringify(await bobbyRow()) === before);
      c.ok("the pure predicate: a TEST name is a fixture row, a never-synthetic id is not whatever its name, a real name is not",
        tc.isSyntheticClientRow({ id: BOBBY_ID, name: "Bobby TEST Michael TEST" }) && !tc.isSyntheticClientRow({ id: NEVER, name: "Jordan Spackman TEST" }) && !tc.isSyntheticClientRow({ id: "cm-real", name: "Marcee Testa" }));
      await prisma.client.update({ where: { id: NEVER }, data: { name: "Jordan Spackman" } });
      customerUsers = null;
    }

    c.ok("fence: nothing left the machine (either process)", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    cleanup();
  }
  c.summary();
  quiet.restore();
  fence.restore();
  await drill.stop();
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes(OLD_PASS)) {
  oldPass().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
