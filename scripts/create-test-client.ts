// ---------------------------------------------------------------------------
// Create (or top up) a SYNTHETIC content-program client for testing the
// portal's identity layer in production, where the only database is.
//
//   npx tsx scripts/create-test-client.ts --dry-run                → plan only
//   npx tsx scripts/create-test-client.ts                          → "Cara TEST"
//   npx tsx scripts/create-test-client.ts "Dave TEST" dave         → another one
//
// THE §16 JORDAN ACCOUNT, which is what this script is for now:
//
//   npx tsx scripts/create-test-client.ts --jordan --dry-run       → plan
//   npx tsx scripts/create-test-client.ts --jordan                 → apply
//   npx tsx scripts/create-test-client.ts --jordan --phone         → + SMS route
//
// REFUSES any name without the word TEST (src/lib/testClients.ts), any sign-in
// address outside the staff-controlled @realtourpilot.com domain, any client id
// on the never-synthetic list, and any destination that is not one Jordan
// verified. Idempotent: run it twice and nothing duplicates. Never deletes,
// never touches a non-test row. Prisma self-loads .env, so DATABASE_URL is the
// live Neon — that is the point, and the guards above are the safety.
//
// ---------------------------------------------------------------------------
// WHY --dry-run IS A CONNECTION AND NOT A PROMISE (Sep 21 2026).
//
// The attribution drill claimed "wrote nothing" and then wrote an AppSetting
// three calls deep through a helper that rebuilt a cache. A promise about what
// a file calls is worth nothing next to a connection that cannot execute an
// INSERT. So --dry-run does two independent things: it opens the database with
// `default_transaction_read_only=on` and PROVES that with a refused write
// before reading anything, and it separately takes the no-write branch at every
// step. Either one alone would do; both together mean a bug in the second is
// caught by the first instead of by production.
// ---------------------------------------------------------------------------
// WHAT IT MAKES (all ids fresh — nothing is copied from a real client):
//
//   Client "<name>"            email info+<slug>test@realtourpilot.com
//                              phone NULL unless --phone, aryeoCustomerId NULL,
//                              autoConfirmationText / autoDeliveryText OFF
//   ContentEnrollment          ACTIVE · Starter · 2 videos / 1 session / 2h · manual
//   ContentMonth 2026-09       OPEN
//   portalToken                issued (so the link path is testable)
//   ClientUser + Membership    OWNER seat for the same address
//
// The two auto-text switches default to TRUE in the schema and clientTextSweeps
// has NO test-client gate — it decides in the query on those columns. A test
// client created with the defaults and a phone number is one shoot confirmation
// away from a real outbound text, so this script writes them OFF explicitly and
// re-asserts them OFF on every top-up run.
//
// Sep 21 2026 — THAT SENTENCE WAS A COMMENT, NOT A SAFEGUARD. The review read
// the code under it: only the CREATE branch wrote the two switches. The `client
// exists` branch performed no update at all, so a test client that was ever
// flipped SMS-live in the admin UI stayed live through every later run while
// this header said the opposite. --phone had the same shape — applied at create
// only, so a top-up run with --phone changed nothing and still printed the
// WARNING block claiming the number was being written. And auditIsolation
// counted FAILs into a local variable and never touched process.exitCode, so a
// run that DISCOVERED the test client was SMS-live exited 0 and read as success
// in any wrapper. reassertSafetyFlags() below is now the actual re-assert, on
// both branches; --phone writes the verified number on both branches; and a
// failed isolation audit exits non-zero. Absence of --phone deliberately does
// NOT clear an existing number (retire, never delete) — the audit reports the
// live value and fails the run if it is not a verified destination.
//
// With --scenarios it ALSO stands up the §25 acceptance fixtures on the same
// client (idempotent, tagged, never touching a non-test row):
//
//   npx tsx scripts/create-test-client.ts "Cara TEST" cara 2026-09 --scenarios
//
// Fixtures are marked with the sentinel below so a re-run tops them up rather
// than duplicating, and so scripts/run-acceptance-scenarios.ts can tell a
// fixture from real data. See that script for what each scenario asserts.
//
// With --month-fixture=program|full it ALSO seeds a REPRESENTATIVE MONTH on the
// same client (CP-15, Sep 24 2026 — scripts/_fixtures/representativeMonth.ts
// says exactly what, and what a live run leaves behind). The fixture runs the
// app's own functions, which need the react-server condition:
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/create-test-client.ts --jordan 2026-09 --month-fixture=program [--variant=pro|ended]
//
//   · program — strategy, topic bank, a planned month, scripts in every state,
//     a session request. Creates NO Project; the only tier allowed on the live
//     hub. Moves the TEST enrollment to Accelerator (Pro for --variant=pro)
//     through the ledgered package change.
//   · full — adds cuts, a revision round and deliveries. REFUSED before this
//     script writes anything when DATABASE_URL looks hosted: isolated copies
//     only. The month is the positional month argument, which must be the
//     current ET month (program: this month or later).
// --dry-run prints what the fixture would do and runs none of it.
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertTestClient,
  assertTestDestinations,
  isStaffControlledEmail,
  isNeverSyntheticClientId,
  isVerifiedTestDestinationEmail,
  isVerifiedTestDestinationPhone,
  JORDAN_TEST_CLIENT_NAME,
  JORDAN_TEST_PHONE_DIGITS,
  providerWriteDecision,
} from "../src/lib/testClients";
import { assertIsolatedDatabase, REPRESENTATIVE_MARKER, type RepresentativeTier, type RepresentativeVariant } from "./_fixtures/representativeMonth";

const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith("--") && !a.includes("=")));
const POSITIONAL = ARGS.filter((a) => !a.startsWith("--"));

const DRY_RUN = FLAGS.has("--dry-run");
const JORDAN = FLAGS.has("--jordan");
const WITH_SCENARIOS = FLAGS.has("--scenarios");
const WITH_PHONE = FLAGS.has("--phone");
/** CP-15: --month-fixture=program|full, --variant=accelerator|pro|ended. */
const flagValue = (name: string): string | null => ARGS.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const MONTH_FIXTURE = flagValue("--month-fixture") as RepresentativeTier | null;
const VARIANT = (flagValue("--variant") ?? "accelerator") as RepresentativeVariant;

const NAME = JORDAN ? JORDAN_TEST_CLIENT_NAME : (POSITIONAL[0] ?? "Cara TEST");
const SLUG = (JORDAN ? "jordan" : (POSITIONAL[1] ?? NAME.split(/\s+/)[0])).toLowerCase().replace(/[^a-z0-9]/g, "");
const EMAIL = `info+${SLUG}test@realtourpilot.com`;
/** Only ever the number Jordan verified on Sep 21 2026, and only when asked for. */
const PHONE = WITH_PHONE ? `+1${JORDAN_TEST_PHONE_DIGITS}` : null;
// The month is the third positional ("Dave TEST" dave 2026-10). CP-15: with
// --jordan there is no name or slug to pass, so a month anywhere in the
// positionals counts — `--jordan 2026-10` used to seed 2026-09 silently.
const MONTH_KEY = (POSITIONAL[2] && /^\d{4}-\d{2}$/.test(POSITIONAL[2]) ? POSITIONAL[2] : null)
  ?? (JORDAN ? POSITIONAL.find((a) => /^\d{4}-\d{2}$/.test(a)) ?? null : null)
  ?? "2026-09";
/** Isolated by construction — never a real client's folder. Nothing is created in Dropbox here. */
const BRAND_ASSETS_PATH = `/RealTour Pilot TEST FIXTURES/${NAME}/Brand Assets`;

/** Every row this script writes for §25 carries this, so a re-run tops up and a reader can tell. */
export const SCENARIO_TAG = "[§25 acceptance fixture]";

// ---------------------------------------------------------------------------
// THE READ-ONLY CONNECTION (--dry-run only). Postgres refuses every write on
// it, SQLSTATE 25006, however deep the call stack goes. Built before the client
// is constructed, because PrismaClient resolves its URL at construction.
// dotenv is not imported on purpose: it is a transitive dependency, not a
// declared one, and a safety guard must not rest on somebody else's package
// tree. Prisma self-loads .env, so DATABASE_URL is usually absent from the
// process environment here and we read the file ourselves.
// ---------------------------------------------------------------------------
function readOnlyDatabaseUrl(): string {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    for (const file of [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "../.env")]) {
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ""); break; }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to dry-run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

const prisma = DRY_RUN ? new PrismaClient({ datasourceUrl: readOnlyDatabaseUrl() }) : new PrismaClient();

const plan: string[] = [];
const would = (line: string) => { plan.push(line); console.log(`WOULD  ${line}`); };
const isOk = (ok: boolean) => (ok ? "ok  " : "FAIL");

/**
 * An UPDATE whose WHERE matches nothing: Postgres still refuses it inside a
 * read-only transaction, and if the guard were ever broken it would change no
 * row. The one probe that is safe whether or not it is needed.
 */
async function proveReadOnly(): Promise<boolean> {
  try {
    await prisma.appSetting.updateMany({ where: { key: "__create_test_client_readonly_probe__" }, data: { value: "x" } });
    return false;
  } catch (e) {
    return /read-only transaction/i.test(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The columns the safety re-assert reasons about. Both branches select exactly
 * these so the create path and the top-up path hand the same shape to
 * reassertSafetyFlags — a narrower select on one branch is how the two drifted
 * apart in the first place (Sep 21 2026).
 */
const TEST_CLIENT_SELECT = {
  id: true,
  name: true,
  phone: true,
  autoConfirmationText: true,
  autoDeliveryText: true,
} as const;

type TestClientRow = {
  id: string;
  name: string | null;
  phone: string | null;
  autoConfirmationText: boolean;
  autoDeliveryText: boolean;
};

/**
 * Re-assert the §16 safety flags on an EXISTING row, which is what the header
 * has always promised and what the code did not do until Sep 21 2026.
 *
 * Writes only the columns that are actually wrong, so a healthy record costs no
 * UPDATE and the log says plainly that nothing needed changing. --phone writes
 * the verified number here exactly as it does on create; its absence does not
 * clear an existing number, because retire-never-delete applies to a column
 * somebody may have set on purpose — the isolation audit below is what reports
 * an unverified one, and it now fails the run.
 */
async function reassertSafetyFlags(c: TestClientRow): Promise<void> {
  const data: { autoConfirmationText?: false; autoDeliveryText?: false; phone?: string } = {};
  const parts: string[] = [];
  if (c.autoConfirmationText !== false) { data.autoConfirmationText = false; parts.push(`autoConfirmationText ${c.autoConfirmationText} -> false`); }
  if (c.autoDeliveryText !== false) { data.autoDeliveryText = false; parts.push(`autoDeliveryText ${c.autoDeliveryText} -> false`); }
  // PHONE is null unless --phone, and assertTestDestinations has already refused
  // anything that is not Jordan's verified number, so this can only ever write that.
  if (PHONE && c.phone !== PHONE) { data.phone = PHONE; parts.push(`phone ${c.phone ?? "NULL"} -> ${PHONE}`); }

  if (!parts.length) {
    console.log(`Safety flags        already correct (autoConfirmationText=false, autoDeliveryText=false${PHONE ? `, phone=${PHONE}` : ""})`);
    return;
  }
  if (DRY_RUN) {
    would(`update Client ${c.id}: ${parts.join(", ")}`);
    return;
  }
  await prisma.client.update({ where: { id: c.id }, data });
  console.log(`Safety re-asserted  ${parts.join(", ")}`);
}

async function main() {
  console.log(`=== create-test-client  ${DRY_RUN ? "DRY RUN (nothing will be written)" : "APPLY"} ===`);
  console.log(`name   ${NAME}`);
  console.log(`email  ${EMAIL}`);
  console.log(`phone  ${PHONE ?? "(none — no SMS route at all)"}`);
  console.log(`month  ${MONTH_KEY}`);
  console.log(`folder ${BRAND_ASSETS_PATH}\n`);

  if (PHONE) {
    // src/lib/contacts.ts builds a phone -> client index (phoneKey, :171/:200),
    // so putting Jordan's own mobile on a Client row means his handset's
    // inbound texts can start resolving to this TEST client in the comms
    // surfaces. That is a real, visible side effect, not a theoretical one, so
    // --phone is off by default and says so out loud when it is on.
    console.log(`WARNING  --phone puts ${PHONE} on a Client row, on a create run AND on a top-up run.`);
    console.log(`         Inbound texts from Jordan's own handset can then resolve to this TEST client`);
    console.log(`         in comms (src/lib/contacts.ts phone index).`);
    console.log(`         Both auto-text switches are re-asserted OFF on every run, so nothing sends on its own.\n`);
  }

  // CP-15: a bad fixture request is refused before THIS script writes a row,
  // not after it has made the client and handed over to the fixture.
  if (MONTH_FIXTURE) {
    if (MONTH_FIXTURE !== "program" && MONTH_FIXTURE !== "full") throw new Error(`--month-fixture must be program or full, not "${MONTH_FIXTURE}".`);
    if (!["accelerator", "pro", "ended"].includes(VARIANT)) throw new Error(`--variant must be accelerator, pro or ended, not "${VARIANT}".`);
    if (MONTH_FIXTURE === "full") assertIsolatedDatabase();
    if (!DRY_RUN) await assertServerConditions();
  }

  if (DRY_RUN) {
    const proven = await proveReadOnly();
    console.log(`=== READ-ONLY GUARD: ${proven ? "PROVEN" : "NOT PROVEN"} ===\n`);
    if (!proven) {
      console.error("  The connection accepted a write. Refusing to run against production.");
      process.exitCode = 1;
      return;
    }
  }

  // ---- refuse anything that is not the test record, before touching a row --
  assertTestClient({ name: NAME });
  if (!isStaffControlledEmail(EMAIL)) throw new Error(`Refusing: ${EMAIL} is not a staff-controlled address.`);
  // §16: every test send lands on a destination Jordan verified himself.
  assertTestDestinations({ email: EMAIL, phone: PHONE });

  let client = await prisma.client.findFirst({ where: { name: NAME }, select: TEST_CLIENT_SELECT });
  if (client) {
    // The ordering matters: a REAL row renamed to contain TEST must be refused
    // by id, and assertTestClient checks the id first for exactly that reason.
    assertTestClient(client);
    console.log(`Client exists       ${client.id}  ${NAME}`);
    // Sep 21 2026: this call is the difference between the header's promise and
    // a comment. Before it, a top-up run left an SMS-live test client SMS-live.
    await reassertSafetyFlags(client);
  } else if (DRY_RUN) {
    would(`create Client "${NAME}" email=${EMAIL} phone=${PHONE ?? "NULL"} aryeoCustomerId=NULL autoConfirmationText=false autoDeliveryText=false brandAssetsPath="${BRAND_ASSETS_PATH}"`);
  } else {
    client = await prisma.client.create({
      data: {
        name: NAME,
        email: EMAIL,
        phone: PHONE,
        brandAssetsPath: BRAND_ASSETS_PATH,
        // OFF explicitly. See the header: the schema defaults are true and
        // clientTextSweeps has no test-client gate.
        autoConfirmationText: false,
        autoDeliveryText: false,
        generalNotes: `SYNTHETIC TEST CLIENT — not a real person, excluded from counts, payouts, reminders and reports. Created ${new Date().toISOString().slice(0, 10)} for the §16 walkthrough.`,
      },
      select: TEST_CLIENT_SELECT,
    });
    assertTestClient(client);
    console.log(`Client created      ${client.id}  ${NAME}`);
  }

  // ---- the isolation audit, on whatever exists -----------------------------
  // Read-only and run on every pass, dry or not: §16's isolation is a property
  // of the row as it stands today, not of the moment it was created.
  // Sep 21 2026: the count used to stop at a console line. A wrapper that shells
  // out to this script read exit 0 and called an SMS-live test client healthy,
  // so the audit's verdict is now the process's verdict.
  if (client) {
    const failures = await auditIsolation(client.id);
    if (failures > 0) process.exitCode = 1;
  }

  let enrollmentId: string | null = null;
  let portalToken: string | null = null;
  let videosOwed = 2; // the Starter allowance this script creates, unless a row already says otherwise
  if (client) {
    let e = await prisma.contentEnrollment.findUnique({ where: { clientId: client.id } });
    if (!e && DRY_RUN) {
      would(`create ContentEnrollment for ${client.id}: Starter 2 videos / 1 session / 2h, ACTIVE, packageSource=manual`);
    } else if (!e) {
      e = await prisma.contentEnrollment.create({
        data: {
          clientId: client.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2,
          status: "ACTIVE", statusManual: true, packageSource: "manual", startedAt: new Date(),
          notes: "SYNTHETIC — portal identity-layer testing.",
        },
      });
      console.log(`Enrollment created  ${e.id}`);
    } else console.log(`Enrollment exists   ${e.id}  ${e.status}`);

    if (e && !e.portalToken) {
      if (DRY_RUN) would(`issue a fresh portalToken on enrollment ${e.id} (new random value, never copied)`);
      else {
        e = await prisma.contentEnrollment.update({ where: { id: e.id }, data: { portalToken: randomBytes(24).toString("base64url"), portalTokenIssuedAt: new Date() } });
        console.log("Portal link issued");
      }
    }
    enrollmentId = e?.id ?? null;
    portalToken = e?.portalToken ?? null;
    if (e) videosOwed = e.videosPerMonth;
  } else if (DRY_RUN) {
    // The client row does not exist yet, so nothing downstream of it can be
    // looked up. The chain is deterministic, so report it rather than going
    // quiet — a plan that stops at the first missing row is not a plan.
    would(`create ContentEnrollment: Starter 2 videos / 1 session / 2h, ACTIVE, statusManual=true, packageSource=manual`);
    would(`issue a fresh portalToken on that enrollment (new random value, never copied)`);
  }

  let monthId: string | null = null;
  if (client && enrollmentId) {
    const existing = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId, monthKey: MONTH_KEY } } });
    if (!existing && DRY_RUN) would(`create ContentMonth ${MONTH_KEY} on enrollment ${enrollmentId}, status OPEN`);
    else if (!existing) {
      const m = await prisma.contentMonth.create({ data: { enrollmentId, clientId: client.id, monthKey: MONTH_KEY, videosOwed, status: "OPEN" } });
      monthId = m.id;
      console.log(`Month               ${m.id}  ${MONTH_KEY}`);
    } else { monthId = existing.id; console.log(`Month               ${existing.id}  ${MONTH_KEY}`); }
  } else if (DRY_RUN) would(`create ContentMonth ${MONTH_KEY}, status OPEN`);

  // ---- the portal seat ----------------------------------------------------
  const existingUser = await prisma.clientUser.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!existingUser && DRY_RUN) would(`create ClientUser ${EMAIL} (fresh id, no token or membership copied from anyone)`);
  let userId = existingUser?.id ?? null;
  if (!DRY_RUN && client && enrollmentId) {
    const user = await prisma.clientUser.upsert({ where: { email: EMAIL }, create: { email: EMAIL, name: NAME }, update: {} });
    userId = user.id;
    const seat = await prisma.clientMembership.upsert({
      where: { clientUserId_enrollmentId: { clientUserId: user.id, enrollmentId } },
      create: { clientUserId: user.id, enrollmentId, clientId: client.id, role: "OWNER", invitedByAppUserId: null },
      update: { revokedAt: null, revokedBy: null, role: "OWNER" },
    });
    console.log(`ClientUser          ${user.id}  ${EMAIL}`);
    console.log(`Membership          ${seat.id}  OWNER`);
  } else if (DRY_RUN) {
    const seat = userId && enrollmentId
      ? await prisma.clientMembership.findUnique({ where: { clientUserId_enrollmentId: { clientUserId: userId, enrollmentId } }, select: { id: true, role: true } })
      : null;
    if (seat) console.log(`Membership exists   ${seat.id}  ${seat.role}`);
    else would(`create ClientMembership OWNER for ${EMAIL} on this enrollment only (no other client's seat is touched)`);
  }

  if (portalToken) console.log(`\nPortal link: /portal/${portalToken}`);
  else if (DRY_RUN) console.log(`\nPortal link: (issued on apply)`);

  if (WITH_SCENARIOS) {
    if (DRY_RUN) {
      would(`--scenarios: 1 pillar, 5 topics (3 selected for ${MONTH_KEY}), 1 NEEDS_FOLLOWUP interview + 1 thin answer, 3 ClientFacts, 1 strategy proposal, 1 refresh run + 2 PENDING suggestions — all tagged "${SCENARIO_TAG}"`);
    } else if (client && enrollmentId && monthId) {
      await scenarioFixtures(client.id, enrollmentId, monthId, MONTH_KEY);
    }
  }

  if (MONTH_FIXTURE) {
    if (DRY_RUN) {
      would(`--month-fixture=${MONTH_FIXTURE} --variant=${VARIANT}: seed the representative ${MONTH_KEY} (see scripts/_fixtures/representativeMonth.ts), every row marked "${REPRESENTATIVE_MARKER}"`);
    } else if (client && enrollmentId) {
      console.log(`\n--- CP-15 representative month (${MONTH_FIXTURE}, ${VARIANT}) ---`);
      // The fixture writes through the app's functions, which import
      // @/lib/prisma. Handing it THIS client first means both are one
      // connection to one database (lib/prisma.ts reuses globalThis.prisma).
      (globalThis as unknown as { prisma?: PrismaClient }).prisma = prisma;
      const { seedRepresentativeMonth } = await import("./_fixtures/representativeMonth");
      const r = await seedRepresentativeMonth(prisma, { clientId: client.id, monthKey: MONTH_KEY, tier: MONTH_FIXTURE, variant: VARIANT, log: (l) => console.log(l) });
      console.log(`month               ${r.monthId}  ${r.monthKey} (last month ${r.lastMonthKey})`);
      console.log(`topics A–E          ${Object.values(r.topics).join(" ")}`);
      if (r.projectId) console.log(`projects            ${r.projectId} (this month) · ${r.lastProjectId} (last month)`);
      console.log(r.wrote.length ? `${r.wrote.length} step(s) written this run` : "Already seeded — nothing written.");
    }
  }

  // ---- what a test journey may NOT do, stated out loud ---------------------
  reportProviderPosture();

  if (DRY_RUN) {
    console.log(`\n=== DRY RUN COMPLETE — ${plan.length} write${plan.length === 1 ? "" : "s"} withheld, 0 rows changed ===`);
    if (!plan.length) console.log("Everything this script creates already exists. An apply run would be a no-op.");
  }

  // The tail of the log has to agree with the exit code, or the next reader
  // trusts the last line they saw instead of the status a wrapper reads.
  if (process.exitCode) {
    console.log(`\n=== EXIT 1 — the isolation audit above FAILED. This record is not safe for a test journey yet. ===`);
  }
}

/**
 * The fixture calls app modules that import "server-only", which only resolves
 * under the react-server condition. Found out here, before anything is
 * written, rather than half way through a seed.
 */
async function assertServerConditions(): Promise<void> {
  try {
    await import("server-only");
  } catch {
    throw new Error(
      "--month-fixture runs the app's own functions and needs the react-server condition:\n" +
      "  NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/create-test-client.ts … --month-fixture=…",
    );
  }
}

/**
 * §16's isolation requirements, checked against the live row. Read-only, so it
 * runs identically in a dry run and an apply. A FAIL here is a real finding:
 * it means a test record picked up a real client's identity somewhere.
 *
 * Returns the number of failed checks so the caller can set process.exitCode.
 * A dry run reports the row AS IT STANDS — if it says the auto-text switches are
 * on, that is today's truth and the WOULD line above is the fix an apply run
 * would perform.
 */
async function auditIsolation(clientId: string): Promise<number> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, email: true, backupEmail: true, phone: true, aryeoCustomerId: true, autoConfirmationText: true, autoDeliveryText: true, brandAssetsPath: true },
  });
  if (!c) return 0;
  console.log(`\n--- isolation audit  ${c.id} ---`);
  const rows: [string, boolean, string][] = [
    ["not on the never-synthetic list", !isNeverSyntheticClientId(c.id), c.id],
    ["email is a verified Jordan destination", isVerifiedTestDestinationEmail(c.email), c.email ?? "(none)"],
    ["backup email is verified or absent", !c.backupEmail || isVerifiedTestDestinationEmail(c.backupEmail), c.backupEmail ?? "(none)"],
    ["phone is verified or absent", !c.phone || isVerifiedTestDestinationPhone(c.phone), c.phone ?? "(none)"],
    ["no Aryeo customer id reused", c.aryeoCustomerId === null, c.aryeoCustomerId ?? "NULL"],
    ["auto confirmation text OFF", c.autoConfirmationText === false, String(c.autoConfirmationText)],
    ["auto delivery text OFF", c.autoDeliveryText === false, String(c.autoDeliveryText)],
    ["brand assets folder is isolated", !c.brandAssetsPath || c.brandAssetsPath.includes("TEST"), c.brandAssetsPath ?? "(none)"],
  ];
  let failed = 0;
  for (const [label, ok, detail] of rows) { if (!ok) failed++; console.log(`  [${isOk(ok)}] ${label.padEnd(42)} ${detail}`); }

  // Writable rows that must be this record's own, never a real client's.
  const [projects, appts, memberships] = await Promise.all([
    prisma.project.count({ where: { clientId } }),
    prisma.appointment.count({ where: { project: { clientId } } }),
    prisma.clientMembership.count({ where: { clientId } }),
  ]);
  console.log(`  [${isOk(appts === 0)}] no Aryeo-backed appointments               ${appts}`);
  console.log(`  [ok  ] projects on this record                 ${projects}`);
  console.log(`  [ok  ] portal memberships on this record       ${memberships}`);
  if (appts > 0) failed++;
  if (failed) console.log(`  ${failed} isolation check(s) FAILED — do not run a test journey against this record until they are fixed. (exit 1)`);
  return failed;
}

/**
 * The §16 property that matters most, printed so it is not folded into a
 * comment nobody reads: a test enrollment cannot create a real billable session
 * and cannot edit a real client's appointment. Both are decided by
 * providerWriteDecision in src/lib/testClients.ts; this prints the actual
 * verdicts rather than asserting they exist.
 */
function reportProviderPosture(): void {
  console.log(`\n--- provider-write guard (src/lib/testClients.ts) ---`);
  const testClient = { id: "test-row", name: NAME };
  const realClient = { id: "cmqikskt1008u9k9qej9ltjy5", name: "Jordan Spackman" };
  const cases: [string, ReturnType<typeof providerWriteDecision>][] = [
    ["book a session for the test client", providerWriteDecision({ provider: "aryeo", operation: "orders.create", client: testClient })],
    ["reschedule a real client's appointment from a test journey", providerWriteDecision({ provider: "aryeo", operation: "appointments.reschedule", client: realClient, actingAsTestClient: testClient })],
    ["a real client's ordinary staff reschedule", providerWriteDecision({ provider: "aryeo", operation: "appointments.reschedule", client: realClient })],
    ["the same test booking through a sandbox adapter", providerWriteDecision({ provider: "aryeo", operation: "orders.create", client: testClient, sandbox: true })],
  ];
  for (const [label, d] of cases) {
    console.log(`  ${d.allowed ? "ALLOW " : "REFUSE"} ${label}`);
    if (!d.allowed) console.log(`         ${d.reason}`);
  }
  console.log(`  NOTE: the decision function lives here; wiring it into the two Aryeo write`);
  console.log(`  call sites (rescheduleAppointmentAction / cancelAppointmentAction in`);
  console.log(`  src/app/actions.ts) is outside this lane's files and is still open.`);
}

// ---------------------------------------------------------------------------
// §25 FIXTURES. Only the parts this lane owns or can write without reaching
// into another builder's engine: the topic bank and its selections (2, 6), an
// interview left deliberately insufficient (4), three facts with three
// different scopes plus a strategy-change proposal (5), and a pillar for them
// all to hang from. The package change (9) is NOT seeded — it is performed by
// the harness, because the point of that scenario is what the action does.
// ---------------------------------------------------------------------------
async function scenarioFixtures(clientId: string, enrollmentId: string, monthId: string, monthKey: string) {
  console.log(`\n--- §25 fixtures ---`);

  // A pillar to hang topics on.
  let pillar = await prisma.contentPillar.findFirst({ where: { enrollmentId, name: "Acceptance pillar" } });
  if (!pillar) {
    pillar = await prisma.contentPillar.create({
      data: { enrollmentId, clientId, name: "Acceptance pillar", purpose: `${SCENARIO_TAG} a pillar for the §25 walkthrough`, createdBy: "acceptance-fixture" },
    });
  }
  console.log(`pillar              ${pillar.id}`);

  // Scenario 2: FIVE ideas discussed, THREE selected. The other two stay in
  // the bank — they are not deleted, and they must not feed the month.
  const titles = [
    "What a pre-listing inspection saves you",
    "The three questions every seller forgets to ask",
    "Why the first weekend decides your price",
    "A street-level tour of the neighbourhood",
    "What staging actually costs in this market",
  ];
  const topicIds: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    const selected = i < 3;
    const title = `${titles[i]}`;
    let t = await prisma.contentTopic.findFirst({ where: { enrollmentId, title, notes: { contains: SCENARIO_TAG } } });
    if (!t) {
      t = await prisma.contentTopic.create({
        data: {
          enrollmentId, clientId, title, pillarId: pillar.id, pillar: pillar.name,
          concept: "Discussed on the acceptance call.",
          source: "strategy_call", status: selected ? "SELECTED" : "SAVED",
          monthId: selected ? monthId : null,
          notes: `${SCENARIO_TAG} ${selected ? "explicitly chosen on the call" : "raised on the call, NOT chosen — stays in the bank"}`,
          clientVisible: true,
        },
      });
    }
    topicIds.push(t.id);
    if (selected) {
      await prisma.contentTopicSelection.upsert({
        where: { topicId_monthId: { topicId: t.id, monthId } },
        create: { topicId: t.id, monthId, enrollmentId, clientId, status: "SELECTED", rank: i + 1, source: "call", evidenceJson: JSON.stringify([{ speaker: "client", text: "yes, let's do that one" }]) },
        update: {},
      });
    }
  }
  console.log(`topics              5 (3 selected for ${monthKey}, 2 left in the bank)`);

  // Scenario 4: an interview with answers that are NOT sufficient. The month
  // must read "waiting on their answers", not "script ready".
  const thin = await prisma.contentInterview.upsert({
    where: { topicId_monthId: { topicId: topicIds[2], monthId } },
    create: {
      topicId: topicIds[2], enrollmentId, clientId, monthId, sourceKind: "WRITTEN", status: "NEEDS_FOLLOWUP",
      answeredCount: 1,
      sufficiencyJson: JSON.stringify({ sufficient: false, missing: ["a concrete example from their own business", "what the viewer should do next"] }),
      lastActivityAt: new Date(),
    },
    update: { status: "NEEDS_FOLLOWUP", sufficiencyJson: JSON.stringify({ sufficient: false, missing: ["a concrete example from their own business", "what the viewer should do next"] }), submittedAt: null },
  });
  await prisma.contentInterviewAnswer.upsert({
    where: { id: `${thin.id}-fixture-1` },
    create: { id: `${thin.id}-fixture-1`, interviewId: thin.id, questionKey: "audience_problem", questionRole: "AUDIENCE_PROBLEM", questionText: "Who is this for and what are they stuck on?", answerText: "Sellers.", answerKind: "TYPED", sourceKind: "CLIENT" },
    update: {},
  });
  console.log(`interview           ${thin.id}  NEEDS_FOLLOWUP (1 thin answer)`);

  // Scenario 5: three things said on one call, which must be filed three ways.
  const facts: { body: string; category: string; scope: string; fieldKey?: string; projectId?: string | null }[] = [
    { body: `${SCENARIO_TAG} Always cut the intro tight — no slow build.`, category: "PRODUCTION_PREFERENCE", scope: "PERMANENT", fieldKey: "editing.pace" },
    { body: `${SCENARIO_TAG} For the Maple Street shoot only, try the handheld walk-and-talk.`, category: "PRODUCTION_PREFERENCE", scope: "PROJECT" },
    { body: `${SCENARIO_TAG} Wondering whether to speak to first-time buyers instead of move-up sellers.`, category: "PROPOSED_CHANGE", scope: "PERMANENT" },
  ];
  for (const f of facts) {
    const existing = await prisma.clientFact.findFirst({ where: { clientId, body: f.body } });
    if (!existing) {
      await prisma.clientFact.create({
        data: {
          clientId, enrollmentId, category: f.category, body: f.body, source: "call", scope: f.scope, fieldKey: f.fieldKey ?? null,
          // The permanent preference is accepted and AI-allowed; the project
          // one is accepted but scoped; the change of audience is a PROPOSAL
          // and must never reach a generator as a fact.
          status: f.category === "PROPOSED_CHANGE" ? "PROPOSED" : "ACCEPTED",
          aiContext: f.category === "PROPOSED_CHANGE" ? "DENIED" : "ALLOWED",
          factDate: new Date(),
        },
      });
    }
  }
  const proposalSummary = `${SCENARIO_TAG} Change the primary audience from move-up sellers to first-time buyers`;
  const prop = await prisma.contentStrategyProposal.findFirst({ where: { enrollmentId, summary: proposalSummary } });
  if (!prop) {
    await prisma.contentStrategyProposal.create({
      data: { enrollmentId, clientId, kind: "AUDIENCE", summary: proposalSummary, sourceKind: "call", impact: "Every pillar and the topic bank would be re-read against a different audience.", status: "PROPOSED" },
    });
  }
  console.log(`facts               3 (permanent · project-scoped · proposal) + 1 strategy proposal`);

  // Scenario 6: a refresh AFTER approval. Suggestions sit apart from selected
  // work — accepting one is a separate, explicit act.
  let run = await prisma.contentTopicRefreshRun.findFirst({ where: { enrollmentId, kind: "REFRESH", changeSummary: { contains: SCENARIO_TAG } } });
  if (!run) {
    run = await prisma.contentTopicRefreshRun.create({
      data: { enrollmentId, clientId, kind: "REFRESH", status: "SUCCEEDED", requestedBy: "acceptance-fixture", changeSummary: `${SCENARIO_TAG} refresh run after approval`, generatedCount: 2, finishedAt: new Date() },
    });
  }
  for (const title of ["An open-house walkthrough nobody films", "The one paragraph buyers actually read"]) {
    const s = await prisma.contentTopicSuggestion.findFirst({ where: { refreshRunId: run.id, title } });
    if (!s) {
      await prisma.contentTopicSuggestion.create({
        data: { refreshRunId: run.id, enrollmentId, clientId, pillarId: pillar.id, kind: "BANK", title, description: `${SCENARIO_TAG} suggested by a refresh after the month's scripts were approved.`, disposition: "PENDING" },
      });
    }
  }
  console.log(`refresh run         ${run.id}  2 suggestions PENDING (nothing accepted)`);
  console.log(`\nFixtures are idempotent — re-running tops up, never duplicates.`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
