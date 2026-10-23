// @drill-run: engine=postgres needs=tools/realpg timeout=600
// ---------------------------------------------------------------------------
// DRILL: REHEARSE scripts/_live/oct23-remove-test-clients.ts END TO END on a
// disposable real Postgres (Oct 23 2026).
//
//   DRILL_ENGINE=postgres NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct23-remove-test-clients-rehearsal.ts
//
// The live script deletes production rows, so its --apply path is proven here
// first, the script itself run as a child process (exactly the file the lead
// will run) against a seeded copy of the shapes production holds:
//   0. seed: a "Jordan Spackman" holding test jobs + misfiled real mail (a
//      forward of a real client's email, our reply in that thread, the task
//      it raised, Jordan's own note, a "Testing" mail, his own and a test
//      Contact, a teammate folded under him, a setting and a bell item keyed
//      by him); a second "Jordan Spackman" with a delivered real job; Bobby
//      TEST with a content enrollment, month, portal visits, a cut job with a
//      review round and outputs; a John Doe with nothing; a real client whose
//      task points at the test job; an unrelated client.
//   1. DRY RUN: the connection really is read-only (real Postgres honours the
//      startup option), the plan names each decision, and not one row in the
//      database changes.
//   2. --apply with a row nobody can place: REFUSED, nothing changed.
//   3. --apply --accept-unplaced: each decision lands (moves, owner-only,
//      unlinks, deletes, left-alone untouched), the backup file holds every
//      deleted and changed row (0600), the removed-clients record is written,
//      and the unrelated client is untouched.
//   4. UNDO: scripts/restore-content-program.ts --apply on that backup brings
//      every deleted row back and every changed row to its before-image.
//
// ISOLATION: real Postgres on 127.0.0.1:DRILL_PORT (default 5974) through the
// shared harness; every child inherits the boundary. The whole-hub backup step
// is handed a stand-in file (--full-backup), since backup-all's read-only
// proof is its own drill (a02). Nothing is sent; no provider is called.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5974);
const REPO = path.resolve(__dirname, "../..");
const LIVE = path.join(REPO, "scripts/_live/oct23-remove-test-clients.ts");

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  installNextStubs();
  const fence = fenceFetch();
  const drill = await bootDrillDb({ port: PORT, engine: "postgres" });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { Prisma } = await import("@prisma/client");
  const { prisma } = await import("@/lib/prisma");
  const BF = await import("../_lib/backupFormat");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oct23-rehearsal-"));
  const db = prisma as unknown as Record<string, { create: (a: unknown) => Promise<Row>; count: (a?: unknown) => Promise<number>; findMany: (a?: unknown) => Promise<Row[]> }>;

  // A row of any model with only what the test cares about: every other
  // required column gets a plain value from the datamodel.
  const models = Prisma.dmmf.datamodel.models as unknown as { name: string; fields: { name: string; kind: string; type: string; isRequired: boolean; isList: boolean; hasDefaultValue: boolean; isUpdatedAt?: boolean; relationFromFields?: readonly string[] }[] }[];
  const enums = new Map((Prisma.dmmf.datamodel.enums as unknown as { name: string; values: { name: string }[] }[]).map((e) => [e.name, e.values[0].name]));
  let seq = 0;
  const make = async (model: string, data: Row): Promise<Row> => {
    const m = models.find((x) => x.name === model)!;
    const fk = new Set(m.fields.flatMap((f) => (f.kind === "object" && f.relationFromFields?.length ? [...f.relationFromFields] : [])));
    const full: Row = { ...data };
    for (const f of m.fields) {
      if (f.name in full || !f.isRequired || f.hasDefaultValue || f.isUpdatedAt || f.kind === "object" || f.isList || fk.has(f.name)) continue;
      full[f.name] = f.kind === "enum" ? enums.get(f.type) : f.type === "String" ? `drill-${model}-${f.name}-${++seq}` : f.type === "Int" || f.type === "Float" ? 0 : f.type === "Boolean" ? false : f.type === "DateTime" ? new Date() : null;
    }
    return db[BF.delegateName(model)].create({ data: full });
  };
  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    // (the shared generated client may be ahead of this worktree's schema: a model with no table is skipped)
    const present = new Set((await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()`)).map((r) => r.t));
    for (const m of models) if (present.has((m as { dbName?: string | null }).dbName || m.name)) out[m.name] = await db[BF.delegateName(m.name)].count();
    return out;
  };
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [...process.execArgv, LIVE, ...args], { cwd: REPO, env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 240_000 });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  try {
    // ======================================================================
    c.head("0 · seed");
    const kyle = await make("TeamMember", { name: "Kyle Smith", email: "kyle@realtourpilot.com" });
    const shooter = await make("TeamMember", { name: "Pat Shooter", email: "pat@shooter.invalid" });
    void kyle;
    const alex = await make("Client", { name: "Alex Real", email: "alex@luxe.invalid" });
    const alexJob = await make("Project", { title: "10 Pine Ford Rd, Chester Springs, PA 19425", clientId: alex.id, source: "ARYEO", aryeoOrderId: "ord-alex" });
    const other = await make("Client", { name: "Una Related", email: "una@unrelated.invalid" });
    await make("Project", { title: "5 Elm St, Media, PA 19063", clientId: other.id });
    await make("CommLog", { channel: "email", direction: "in", body: "Hi team", occurredAt: new Date(), source: "gmail", clientId: other.id, clientName: "Una Related", contactName: "Una Related" });

    const j1 = await make("Client", { name: "Jordan Spackman", email: "jspackman215@gmail.com", backupEmail: "bobmike0214@gmail.com", aryeoCustomerId: "2ee9574f-drill-0000-0000-000000000001" });
    const nick = await make("Client", { name: "Nick Buccafuri", email: "nick@realtourpilot.com", parentClientId: j1.id });
    const p1 = await make("Project", { title: "265 Koser Rd, Lititz, 17543", clientId: j1.id, source: "ARYEO", aryeoOrderId: "ord-j1-test", status: "DELIVERED", price: 250, paymentStatus: "UNPAID", balanceAmount: 25000, arRemovedAt: new Date(), arRemovedNote: "test", deliveredAt: new Date() });
    const d1 = await make("Deliverable", { projectId: p1.id });
    const o1 = await make("DeliverableOutput", { deliverableId: d1.id, projectId: p1.id });
    await make("Activity", { projectId: p1.id, body: "Imported from Aryeo (order #1)." });
    const t1 = await make("SmartTask", { title: "Prep shoot — 265 Koser Rd", taskType: "appointment_prep", source: "aryeo", status: "COMPLETED", clientId: j1.id, projectId: p1.id });
    const c1 = await make("CommLog", { channel: "email", direction: "in", source: "gmail", clientId: j1.id, clientName: "Jordan Spackman", projectId: p1.id, contactName: "Jordan Spackman", subject: "Fwd: Pine Ford Zillow Showcase Photo Update", externalId: "gmail-hello@realtourpilot.com:1a0000000000aa01", occurredAt: new Date(), body: "---------- Forwarded message ---------\nFrom: Alex Real <alex@luxe.invalid>\nDate: Thu, Sep 24, 2026\nSubject: Pine Ford\n\nPlease add these photos." });
    const c2 = await make("CommLog", { channel: "email", direction: "out", source: "gmail-sent", clientId: j1.id, clientName: "Jordan Spackman", projectId: p1.id, contactName: "Us", subject: "Re: Pine Ford Zillow Showcase Photo Update", externalId: "gmail-sent-1a0000000000aa01-1a0000000000aa02", occurredAt: new Date(), body: "Hey Alex, done!" });
    const c3 = await make("CommLog", { channel: "email", direction: "in", source: "gmail", clientId: j1.id, clientName: "Jordan Spackman", contactName: "Jordan Spackman", subject: "Team Feedback", externalId: "gmail-hello@realtourpilot.com:1a0000000000aa03", occurredAt: new Date(), body: "Hey team, thanks for the work this week." });
    const c4 = await make("CommLog", { channel: "email", direction: "in", source: "gmail", clientId: j1.id, clientName: "Jordan Spackman", contactName: "Jordan Spackman", subject: "Media request", externalId: "gmail-info@realtourpilot.com:1a0000000000aa04", occurredAt: new Date(), body: "Testing" });
    const t2 = await make("SmartTask", { title: "Photo revision — 265 Koser Rd", taskType: "revision", source: "gmail", sourceDetail: "gmail-thread:hello@realtourpilot.com:1a0000000000aa01", status: "OPEN", clientId: j1.id, projectId: p1.id, outputId: o1.id, description: "Fwd: Pine Ford — From: Alex Real <alex@luxe.invalid>" });
    const t3 = await make("SmartTask", { title: "Alex follow-up", taskType: "todo", source: "system", status: "OPEN", clientId: alex.id, projectId: p1.id });
    const k1 = await make("Contact", { openPhoneId: "op-k1", firstName: "Jordan", lastName: "Spackman", email: "jspackman215@gmail.com", clientId: j1.id });
    const k2 = await make("Contact", { openPhoneId: "op-k2", firstName: "Bobby TEST Michael TEST", email: "bobmike0214@gmail.com", clientId: j1.id });
    await make("AppSetting", { key: `comms-ack-email-${j1.id}:client%3A${j1.id}`, value: "2026-10-21T20:40:53.494Z" });
    await make("Notification", { kind: "system", title: "Delivered — 265 Koser Rd", href: `/projects/${p1.id}`, audience: "[\"OWNER\"]" });

    const j2 = await make("Client", { name: "Jordan Spackman", email: "info@realtorpilot.com" });
    const j2Job = await make("Project", { title: "4 mountain crest drive, Lake Harmony, 18624", clientId: j2.id, source: "ARYEO", aryeoOrderId: "ord-j2-real", status: "DELIVERED", price: 0, paymentStatus: "PAID", balanceAmount: 0, photographerId: shooter.id, shootDate: new Date("2024-09-04T22:00:00Z"), deliveredAt: new Date("2024-10-31T19:25:12Z") });

    const bob = await make("Client", { name: "Bobby TEST Michael TEST", email: "jspackman215+bobbytest@gmail.com", backupEmail: "bobmike0214@gmail.com", aryeoCustomerId: "018f10e1-drill-0000-0000-000000000002" });
    const enr = await make("ContentEnrollment", { clientId: bob.id, package: "Starter", portalToken: "drill-portal-token-bobby" });
    await make("ContentMonth", { clientId: bob.id, enrollmentId: enr.id, monthKey: "2026-10" });
    for (let i = 0; i < 3; i++) await make("PortalVisit", { enrollmentId: enr.id });
    const pb = await make("Project", { title: "TEST Bobby cut job", clientId: bob.id, status: "REVIEW" });
    const db1 = await make("Deliverable", { projectId: pb.id });
    await make("DeliverableOutput", { deliverableId: db1.id, projectId: pb.id });
    await make("ReviewSubmission", { projectId: pb.id, deliverableId: db1.id });
    await make("OutboxMessage", { clientId: bob.id, projectId: pb.id });
    await make("AppSetting", { key: `client-onboarding:${bob.id}`, value: "{}" });
    const john = await make("Client", { name: "John Doe", email: "johndoe@gmail.com", aryeoCustomerId: "0192af76-drill-0000-0000-000000000003" });
    // A row nobody can place: an outside sender the hub does not know.
    const stray = await make("CommLog", { channel: "email", direction: "in", source: "gmail", clientId: j1.id, clientName: "Jordan Spackman", contactName: "stranger@nowhere.invalid", subject: "Quick question", externalId: "gmail-hello@realtourpilot.com:1a0000000000aa09", occurredAt: new Date(), body: "Hello, do you shoot in Ohio?" });
    c.ok("seeded", !!stray.id && !!john.id && !!t1.id && !!d1.id);
    const before = await counts();

    // ======================================================================
    c.head("1 · dry run (read-only)");
    {
      const r = run([]);
      c.ok("exits 0", r.code === 0, r.out.slice(-600));
      c.ok("the read-only connection is proven (25006) before any read", /read-only connection proven \(SQLSTATE 25006/.test(r.out));
      c.ok("targets: both Jordan Spackman rows, Bobby TEST, John Doe", (r.out.match(/^\s+· \S+\s+"(Jordan Spackman|Bobby TEST Michael TEST|John Doe)"/gm) ?? []).length === 4, (r.out.match(/TARGETS[\s\S]{0,800}/) ?? [""])[0]);
      c.ok("the Jordan Spackman with a delivered real job is LEFT ALONE, with evidence", new RegExp(`"Jordan Spackman" ${j2.id}: REAL BUSINESS — LEFT ALONE`).test(r.out) && /delivered real job: "4 mountain crest drive/.test(r.out));
      c.ok("the forward moves to Alex Real by the forwarded sender's address", new RegExp(`CommLog ${c1.id}[^\\n]*\\n\\s+→ Alex Real`).test(r.out));
      c.ok("our reply in that thread follows it", new RegExp(`CommLog ${c2.id}[^\\n]*\\n\\s+→ Alex Real`).test(r.out));
      c.ok("the task raised from that email follows it", new RegExp(`SmartTask ${t2.id}[^\\n]*\\n\\s+→ Alex Real`).test(r.out));
      c.ok("Jordan's own note is owner-only", new RegExp(`CommLog ${c3.id}[^\\n]* — Jordan's own mail`).test(r.out));
      c.ok("the stranger's mail needs a person", /NEEDS A PERSON \(1\)/.test(r.out) && r.out.includes(stray.id as string));
      c.ok("not one row changed", JSON.stringify(await counts()) === JSON.stringify(before));
    }

    // ======================================================================
    c.head("2 · --apply refuses while a row needs a person");
    {
      const fake = path.join(tmp, "full-stand-in.json");
      BF.writeBackupFile(fake, { takenAt: new Date().toISOString(), counts: { Client: 1 } }, { Client: [] });
      const r = run(["--apply", `--full-backup=${fake}`, `--backup-dir=${tmp}`]);
      c.ok("exits non-zero with REFUSED", r.code !== 0 && /REFUSED: 1 row\(s\) need a person/.test(r.out), r.out.slice(-300));
      c.ok("nothing changed", JSON.stringify(await counts()) === JSON.stringify(before));
    }

    // ======================================================================
    c.head("3 · --apply --accept-unplaced");
    let backupFile = "";
    {
      const fake = path.join(tmp, "full-stand-in-2.json");
      BF.writeBackupFile(fake, { takenAt: new Date().toISOString(), counts: { Client: 1 } }, { Client: [] });
      const r = run(["--apply", "--accept-unplaced", `--full-backup=${fake}`, `--backup-dir=${tmp}`]);
      c.ok("exits 0, every group committed", r.code === 0 && !/ROLLED BACK/.test(r.out), r.out.slice(-900));
      backupFile = /WRITTEN: (\S+\.json)/.exec(r.out)?.[1] ?? "";
      const has = async (model: string, id: unknown) => !!(await db[BF.delegateName(model)].findMany({ where: { id } }))[0];
      c.ok("Jordan Spackman (test jobs), Bobby TEST and John Doe are gone", !(await has("Client", j1.id)) && !(await has("Client", bob.id)) && !(await has("Client", john.id)));
      c.ok("the Jordan Spackman with real business is untouched, job and all", (await has("Client", j2.id)) && (await has("Project", j2Job.id)));
      c.ok("their jobs, deliverables, outputs, review rounds, tasks, enrollment, month, visits, outbox are gone",
        !(await has("Project", p1.id)) && !(await has("Project", pb.id)) && !(await has("Deliverable", d1.id)) && !(await has("SmartTask", t1.id)) &&
        (await prisma.deliverableOutput.count()) === 0 && (await prisma.reviewSubmission.count()) === 0 && (await prisma.contentEnrollment.count()) === 0 &&
        (await prisma.contentMonth.count()) === 0 && (await prisma.portalVisit.count()) === 0 && (await prisma.outboxMessage.count()) === 0);
      const m1 = await prisma.commLog.findUnique({ where: { id: c1.id as string } });
      const m2 = await prisma.commLog.findUnique({ where: { id: c2.id as string } });
      const tk2 = await prisma.smartTask.findUnique({ where: { id: t2.id as string } });
      c.ok("the forward, our reply and its task are Alex Real's now (job and output pointers cleared)", m1?.clientId === alex.id && m1?.clientName === "Alex Real" && m1?.projectId === null && m2?.clientId === alex.id && tk2?.clientId === alex.id && tk2?.projectId === null && tk2?.outputId === null);
      const m3 = await prisma.commLog.findUnique({ where: { id: c3.id as string } });
      c.ok("Jordan's own note is kept, owner-only, no client", m3?.clientId === null && m3.minRole === "OWNER");
      c.ok("the 'Testing' mail is deleted", !(await has("CommLog", c4.id)));
      const st = await prisma.commLog.findUnique({ where: { id: stray.id as string } });
      c.ok("the accepted unplaced mail is kept owner-only", st?.clientId === null && st.minRole === "OWNER");
      const tk3 = await prisma.smartTask.findUnique({ where: { id: t3.id as string } });
      c.ok("a REAL client's task that pointed at the test job keeps its client; only the job pointer is cleared", tk3?.clientId === alex.id && tk3?.projectId === null);
      c.ok("Jordan's own Contact is unlinked and kept; the test Contact is deleted", (await prisma.contact.findUnique({ where: { id: k1.id as string } }))?.clientId === null && !(await has("Contact", k2.id)));
      c.ok("the teammate folded under him is kept, unfolded", (await prisma.client.findUnique({ where: { id: nick.id as string } }))?.parentClientId === null);
      c.ok("settings and bell items keyed by the removed rows are gone", (await prisma.appSetting.count({ where: { key: { contains: j1.id as string } } })) === 0 && (await prisma.appSetting.count({ where: { key: { contains: bob.id as string } } })) === 0 && (await prisma.notification.count()) === 0);
      const rec = await prisma.appSetting.findUnique({ where: { key: "clients:removed" } });
      const entries = rec ? (JSON.parse(rec.value) as { entries: { clientId: string; aryeoCustomerIds: string[]; aryeoOrderIds: string[]; emails: string[] }[] }).entries : [];
      const e1 = entries.find((e) => e.clientId === j1.id);
      c.ok("the removed-clients record lists each removed client with its Aryeo customer, emails and orders", entries.length === 3 && !!e1 && e1.aryeoCustomerIds[0] === j1.aryeoCustomerId && e1.aryeoOrderIds.includes("ord-j1-test") && e1.emails.includes("jspackman215@gmail.com"));
      c.ok("…and no email another client still holds (info@realtorpilot.com stays with the left-alone row)", !entries.some((e) => e.emails.includes("info@realtorpilot.com")));
      c.ok("Alex Real's own job and the unrelated client are untouched", (await has("Project", alexJob.id)) && (await prisma.commLog.count({ where: { clientId: other.id as string } })) === 1);
      c.ok("the backup file exists, mode 600", !!backupFile && fs.existsSync(backupFile) && (fs.statSync(backupFile).mode & 0o777) === 0o600, backupFile);
      const back = await BF.readBackup(backupFile);
      c.ok("it holds the removed clients and every changed row's before-image", (back.data.Client ?? []).some((r) => r.id === j1.id) && (back.data.CommLog ?? []).some((r) => r.id === c1.id && r.clientId === j1.id) && (back.data.Client ?? []).some((r) => r.id === nick.id && r.parentClientId === j1.id));
    }

    // ======================================================================
    c.head("4 · undo: restore-content-program --apply on the backup");
    {
      const r = spawnSync(process.execPath, [...process.execArgv, path.join(REPO, "scripts/restore-content-program.ts"), backupFile, "--apply"], { cwd: REPO, env: process.env, encoding: "utf8", timeout: 240_000 });
      c.ok("the restore exits 0", r.status === 0, `${r.stdout}${r.stderr}`.slice(-600));
      const now = await counts();
      const diff = Object.keys(before).filter((m) => m !== "AppSetting" && now[m] !== before[m]);
      c.ok("every model's row count is back to the seed (AppSetting +1: the removed-clients record stays until removed by hand)", diff.length === 0 && now.AppSetting === before.AppSetting + 1, diff.map((m) => `${m} ${before[m]}→${now[m]}`).join(", "));
      const m1 = await prisma.commLog.findUnique({ where: { id: c1.id as string } });
      const n2 = await prisma.client.findUnique({ where: { id: nick.id as string } });
      c.ok("changed rows are back to their before-images", m1?.clientId === j1.id && m1?.projectId === p1.id && n2?.parentClientId === j1.id);
    }
    c.ok("fence: nothing left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    c.summary();
    quiet.restore();
    fence.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
