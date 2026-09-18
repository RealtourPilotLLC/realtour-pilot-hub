// COVERAGE ACCEPTANCE DRILL (audit WF-06) — runs the SHIPPED code, in an
// ISOLATED database, against the five things the change has to be true of.
//
// Nothing here can touch production, and it is belt and braces:
//   · DATABASE_URL is pinned to a loopback PGlite instance BEFORE anything
//     imports @/lib/prisma, and asserted to be loopback;
//   · .env is never sourced, so there is no OpenPhone key, no Slack token and
//     no way for a drill assertion to put a real message on a real phone.
//
// Usage:
//   PATH=<node20>:$PATH npx tsx scripts/_agent/C-coverage/acceptance.ts
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const PORT = Number(process.env.DRILL_PORT ?? 5441);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
if (!URL.includes("127.0.0.1")) throw new Error("refusing to run: the drill's DATABASE_URL is not loopback");
// Before any import of the app's modules. A real environment variable beats
// the .env Prisma self-loads.
process.env.DATABASE_URL = URL;
process.env.DIRECT_URL = URL;
for (const k of Object.keys(process.env)) {
  if (/^(OPENPHONE|SLACK|GOOGLE|DROPBOX|ARYEO|TOPAZ)_/.test(k)) delete process.env[k];
}

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (cond) pass++; else fail++;
};

// The moments the acceptance criteria name, as real instants.
const SAT_11AM = new Date("2026-09-19T15:00:00.000Z"); // Sat 19 Sep 2026, 11:00 EDT
const WED_2PM = new Date("2026-09-23T18:00:00.000Z"); // Wed 23 Sep 2026, 14:00 EDT
const MON_9AM = new Date("2026-09-21T13:00:00.000Z"); // Mon 21 Sep 2026, 09:00 EDT
// A winter pair, because an hours window that is really a millisecond count
// drifts an hour across the clock change.
const SAT_11AM_EST = new Date("2026-01-17T16:00:00.000Z"); // Sat 17 Jan 2026, 11:00 EST
const MON_9AM_EST = new Date("2026-01-19T14:00:00.000Z"); // Mon 19 Jan 2026, 09:00 EST

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  try {
    console.log("── schema onto the isolated database");
    await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL },
      maxBuffer: 64 * 1024 * 1024,
    });

    const { prisma } = await import("@/lib/prisma");
    // PGlite reports its own internal `port` GUC, not the socket it is served
    // on, so the proof of isolation is the data: production has hundreds of
    // projects and thousands of comms, and a fresh drill database has none.
    const [projects, comms] = await Promise.all([prisma.project.count(), prisma.commLog.count()]);
    ok(
      "drill is on an empty, loopback database — not production",
      (process.env.DATABASE_URL ?? "").includes("127.0.0.1") && projects === 0 && comms === 0,
      `${projects} projects, ${comms} comms`,
    );

    const { withinCoverageAt, nextCoveredMomentAt, routeAlert, describeCoverage } = await import("@/lib/coverage");
    const { DEFAULT_INTERNAL_ALERTS } = await import("@/lib/settings");
    const cover = DEFAULT_INTERNAL_ALERTS.coverage;

    // ---- 4. A weekday 2pm alert is unaffected -----------------------------
    console.log("\n── 4. a weekday 2pm alert is unaffected");
    ok("Wed 2pm ET is inside cover", withinCoverageAt(WED_2PM, cover) === true);
    const wedRoutine = await routeAlert("routine", WED_2PM);
    ok("routine on a Wednesday afternoon sends now", wedRoutine.send === "now", wedRoutine.why);
    const wedUrgent = await routeAlert("urgent", WED_2PM);
    ok("urgent on a Wednesday afternoon sends now, no rota involved", wedUrgent.send === "now" && wedUrgent.toOnCall === null);

    // ---- 1. Saturday 11am ROUTINE defers to Monday 9am --------------------
    console.log("\n── 1. a Saturday 11am routine alert defers to Monday 9am ET");
    ok("Sat 11am ET is outside cover", withinCoverageAt(SAT_11AM, cover) === false);
    const satRoutine = await routeAlert("routine", SAT_11AM);
    ok("routine on a Saturday defers", satRoutine.send === "defer", satRoutine.why);
    const until = satRoutine.send === "defer" ? satRoutine.until : new Date(0);
    ok("…to Monday 9:00 ET", until.getTime() === MON_9AM.getTime(), until.toISOString());
    ok(
      "…and across the winter clock change too (EST, not a 48h millisecond hop)",
      nextCoveredMomentAt(SAT_11AM_EST, cover).getTime() === MON_9AM_EST.getTime(),
      nextCoveredMomentAt(SAT_11AM_EST, cover).toISOString(),
    );

    // The deferral is only real if the flusher cannot see the line until then.
    const { dueSmsWhere } = await import("@/lib/notify");
    const kyle = await prisma.teamMember.create({
      data: { name: "Drill Kyle", email: "kyle@drill.invalid", role: "MANAGER", active: true, phone: "+12155551212", opsAlerts: true },
      select: { id: true },
    });
    const held = await prisma.pendingSms.create({
      data: { teamMemberId: kyle.id, line: "3 jobs shot and photos still not delivered", deferUntil: until },
      select: { id: true },
    });
    const plain = await prisma.pendingSms.create({
      data: { teamMemberId: kyle.id, line: "an ordinary queued line" },
      select: { id: true },
    });
    const dueSat = await prisma.pendingSms.findMany({ where: { teamMemberId: kyle.id, ...dueSmsWhere(SAT_11AM) }, select: { id: true } });
    ok("the flusher cannot see the held line on Saturday", !dueSat.some((r) => r.id === held.id), `${dueSat.length} due`);
    ok("…while an ordinary line in the same queue still flushes", dueSat.some((r) => r.id === plain.id));
    const dueMon = await prisma.pendingSms.findMany({ where: { teamMemberId: kyle.id, ...dueSmsWhere(MON_9AM) }, select: { id: true } });
    ok("the flusher picks it up at Monday 9:00 ET", dueMon.some((r) => r.id === held.id), `${dueMon.length} due`);

    // ---- 3. NOTHING CHANGES WHAT IS CAPTURED ------------------------------
    console.log("\n── 3. nothing changes what is captured");
    const stillThere = await prisma.pendingSms.count({ where: { teamMemberId: kyle.id } });
    ok("the held line is a row the whole time — held, never dropped", stillThere === 2, `${stillThere} rows`);
    const preExisting = await prisma.pendingSms.count({ where: { deferUntil: null, sentAt: null, skippedAt: null } });
    const dueNow = await prisma.pendingSms.count({ where: dueSmsWhere(new Date()) });
    ok("every row written before this change is still due (deferUntil null)", preExisting <= dueNow, `${preExisting} undeferred, ${dueNow} due now`);

    // ---- 2. Saturday 11am URGENT still goes out ---------------------------
    console.log("\n── 2. a Saturday 11am urgent alert still goes out");
    const noRota = await routeAlert("urgent", SAT_11AM);
    ok("with NOBODY named it sends, the old way", noRota.send === "now" && noRota.toOnCall === null, noRota.why);

    const onCall = await prisma.teamMember.create({
      data: { name: "Drill Harrison", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", active: true, phone: "+12155551213" },
      select: { id: true },
    });
    const { putSetting, internalAlertRules } = await import("@/lib/settings");
    await putSetting(
      "internal_alerts",
      { ...DEFAULT_INTERNAL_ALERTS, coverage: { ...cover, onCallTeamMemberId: onCall.id } },
      "drill",
    );
    // getSetting caches 60s per process, so read through the real accessor and
    // only assert once it reflects the row — a stale cache here would make the
    // next assertion a lie.
    for (let i = 0; i < 40 && (await internalAlertRules()).coverage.onCallTeamMemberId !== onCall.id; i++) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    const rules = await internalAlertRules();
    ok("the rota reads back from Settings", rules.coverage.onCallTeamMemberId === onCall.id);
    const withRota = await routeAlert("urgent", SAT_11AM);
    ok("urgent on a Saturday goes to the named on-call", withRota.send === "now" && withRota.toOnCall === onCall.id, withRota.why);
    const routineWithRota = await routeAlert("routine", SAT_11AM);
    ok("naming somebody does NOT start paging them for routine alerts", routineWithRota.send === "defer");

    // ---- 5. Jordan can read what it means ---------------------------------
    console.log("\n── 5. the window, in words");
    const words = describeCoverage(rules.coverage);
    ok("describeCoverage says it in English", words === "Mon–Fri, 9am–6pm ET", words);

    await prisma.$disconnect();
  } finally {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
