// PROOF for R03 (an old send must not hide an unsent replacement) and R06 (the
// per-video row lifecycle after the backfill).
//
// Both findings are about what a WRITE does and what a READ says about it, so
// neither can be proved by a pure function and neither may be proved against
// production. This runs the SHIPPED functions —
//   deliverableOutputs.{ensureOutputsForProject, refreshOutputsForProject,
//                        outputsForProject, ensureOutputsSafely, sweepOutputUnits}
//   integrations/aryeo.reconcileDeliverablesToOrder
//   projects/deliverableActions.{waiveDeliverable, unwaiveDeliverable}
// — against an ISOLATED loopback PGlite database, the same belt-and-braces
// scripts/_fix/A/drill-outputs.ts uses: DATABASE_URL is pinned to 127.0.0.1
// before anything imports @/lib/prisma, the drill refuses to continue unless the
// database it reached is empty, and every integration key is stripped from the
// environment so no assertion here can reach a real phone, inbox or Dropbox.
//
//   PATH=<node20>:$PATH npx tsx scripts/_drill/output-lifecycle.ts
//
// BEFORE/AFTER: the drill also materialises the BASELINE copy of
// lib/deliverableOutputs.ts out of git (BASELINE_REF, default HEAD) into a
// temporary module beside this one, runs the SAME steps through it, and prints
// both answers. Run it with BASELINE_REF=<the commit before this change> once
// the change is committed. The temporary file is deleted on the way out.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import Module from "node:module";

// The office's waiver is a "use server" action, and importing that file pulls
// next/cache → the app-router client runtime, which has no React renderer in a
// script. Stubbing THAT ONE import lets the real action body run: the guard,
// the Deliverable write, the timeline line and recomputeAfterWaiver all execute
// exactly as they do in the app — only the cache invalidation, which a script
// cannot have, is a no-op.
const loader = Module as unknown as { _load: (req: string, parent: unknown, isMain: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => { throw new Error(`redirect(${to})`); },
      notFound: () => { throw new Error("notFound()"); },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = Number(process.env.DRILL_PORT ?? 5463);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
if (!URL.includes("127.0.0.1")) throw new Error("refusing to run: the drill's DATABASE_URL is not loopback");
process.env.DATABASE_URL = URL;
process.env.DIRECT_URL = URL;
for (const k of Object.keys(process.env)) {
  if (/^(OPENPHONE|SLACK|GOOGLE|DROPBOX|ARYEO|TOPAZ|STRIPE|PLAID|QBO|BLOB)_/.test(k)) delete process.env[k];
}
delete process.env.AUTH_ENFORCE; // the office actions below run as the office

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (cond) pass++;
  else fail++;
};

const BASELINE_REF = process.env.BASELINE_REF ?? "HEAD";
const BASELINE_PATH = join(process.cwd(), "scripts", "_drill", "_baseline-deliverableOutputs.ts");

async function writeBaseline(): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["show", `${BASELINE_REF}:src/lib/deliverableOutputs.ts`], { maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(BASELINE_PATH, stdout);
    return true;
  } catch (e) {
    console.log(`  (no baseline: ${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    return false;
  }
}

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  const haveBaseline = await writeBaseline();
  try {
    console.log("── schema onto the isolated database");
    await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: URL, DIRECT_URL: URL },
      maxBuffer: 64 * 1024 * 1024,
    });

    const { prisma } = await import("@/lib/prisma");
    const projects = await prisma.project.count();
    ok(
      "drill is on an empty, loopback database — not production",
      (process.env.DATABASE_URL ?? "").includes("127.0.0.1") && projects === 0,
      `${projects} projects`,
    );
    if (projects !== 0) throw new Error("refusing to continue: the database is not empty");

    const { ensureOutputsForProject, refreshOutputsForProject, outputsForProject, ensureOutputsSafely, sweepOutputUnits } =
      await import("@/lib/deliverableOutputs");
    const baseline = haveBaseline
      ? ((await import(BASELINE_PATH)) as typeof import("@/lib/deliverableOutputs"))
      : null;

    const client = await prisma.client.create({ data: { name: "Drill Client" }, select: { id: true } });
    const mkProject = (title: string, extra: Record<string, unknown> = {}) =>
      prisma.project.create({ data: { title, clientId: client.id, ...extra }, select: { id: true, title: true } });

    // =====================================================================
    // R03 — v1 sent → v2 uploaded → v2 approved → v2 sent.
    // =====================================================================
    console.log(`\n══ R03: an old send must not hide an unsent replacement  (baseline = ${BASELINE_REF}${haveBaseline ? "" : ", unavailable"})`);
    const p1 = await mkProject("1 Replacement Row", {
      shootDate: new Date(Date.now() - 3 * 24 * 3600_000),
      promisedDueAt: new Date(Date.now() + 2 * 24 * 3600_000),
      promisedTargetAt: new Date(Date.now() + 1 * 24 * 3600_000),
    });
    const d1 = await prisma.deliverable.create({
      data: { projectId: p1.id, type: "VIDEO", label: "Cinematic Video", quantity: 1 },
      select: { id: true },
    });
    await ensureOutputsForProject(p1.id);

    const show = async (step: string) => {
      await refreshOutputsForProject(p1.id); // exactly what the four cut events do
      const now = (await outputsForProject(p1.id))[0];
      const then = baseline ? (await baseline.outputsForProject(p1.id))[0] : null;
      console.log(`\n  ${step}`);
      if (then) {
        console.log(`    BEFORE  latestSubmission: v${then.round ?? "-"}  displayState: ${then.state}  displayMessage: ${then.detail}`);
      }
      console.log(`    AFTER   latestSubmission: v${now.round ?? "-"}  displayState: ${now.state}  displayMessage: ${now.detail}`);
      return { now, then };
    };

    // v1 uploaded, approved and SENT.
    const v1 = await prisma.reviewSubmission.create({
      data: {
        projectId: p1.id, kind: "video", deliverableId: d1.id, slot: 1, round: 1, status: "APPROVED",
        decidedAt: new Date(Date.now() - 2 * 3600_000), sentToClientAt: new Date(Date.now() - 1 * 3600_000),
        sentToClientBy: "Kyle", fileName: "v1.mp4",
      },
      select: { id: true },
    });
    void v1;
    const s1 = await show("step 1 — v1 approved and sent");
    ok("v1 sent reads as sent", s1.now.state === "sent", s1.now.detail);
    ok("…and the delivery is on the record", !!s1.now.deliveredAt);

    // v2 uploaded — a replacement still awaiting review.
    const v2 = await prisma.reviewSubmission.create({
      data: { projectId: p1.id, kind: "video", deliverableId: d1.id, slot: 1, round: 2, status: "IN_REVIEW", fileName: "v2.mp4" },
      select: { id: true },
    });
    const s2 = await show("step 2 — v2 uploaded, awaiting a verdict");
    ok("the replacement is VISIBLE, not hidden behind v1's send", s2.now.state === "in_review", s2.now.state);
    ok("…and v1's delivery is still stated beside it", s2.now.detail.startsWith("v1 sent;"), s2.now.detail);
    ok("…the client's copy is still on the record", !!s2.now.priorDelivery, String(s2.now.priorDelivery?.round));

    // v2 approved — THE REVIEWER'S OWN INPUTS.
    await prisma.reviewSubmission.update({ where: { id: v2.id }, data: { status: "APPROVED", decidedAt: new Date() } });
    const s3 = await show("step 3 — v2 approved, nobody has sent it  (the reviewer's repro)");
    ok("the reviewer's repro is fixed: NOT 'sent'", s3.now.state === "approved", s3.now.state);
    ok("…and it says which version the client has", s3.now.detail === "v1 sent; v2 approved, awaiting send", s3.now.detail);
    ok("…it counts as owed work (awaitingSend)", s3.now.awaitingSend);
    ok("…the historical deliveredAt was NOT cleared to achieve it", !!s3.now.deliveredAt);
    if (s3.then) ok("…and the baseline said the opposite", s3.then.state === "sent", `baseline: ${s3.then.state} / ${s3.then.detail}`);

    // v2 sent.
    await prisma.reviewSubmission.update({ where: { id: v2.id }, data: { sentToClientAt: new Date(), sentToClientBy: "Kyle" } });
    const s4 = await show("step 4 — v2 sent");
    ok("the current version is with the client", s4.now.state === "sent", s4.now.detail);
    ok("…named by version, so the two sends are distinguishable", s4.now.detail === "v2 sent to the client", s4.now.detail);
    ok("…and nothing is awaiting a send any more", !s4.now.awaitingSend && !s4.now.priorDelivery);

    // The hand-delivery case: the office's stamp with no round at all, then a
    // correction uploaded against it.
    console.log("\n── R03b: a video delivered BY HAND, then corrected");
    const p1b = await mkProject("2 By Hand Ln");
    const d1b = await prisma.deliverable.create({ data: { projectId: p1b.id, type: "VIDEO", quantity: 1 }, select: { id: true } });
    await ensureOutputsForProject(p1b.id);
    await prisma.deliverableOutput.updateMany({
      where: { projectId: p1b.id },
      data: { deliveredAt: new Date(Date.now() - 4 * 3600_000), deliveredBy: "Kyle", deliveredVia: "office-hand" },
    });
    ok("the office's word stands on its own", (await outputsForProject(p1b.id))[0]?.state === "sent");
    await prisma.reviewSubmission.create({
      data: { projectId: p1b.id, kind: "video", deliverableId: d1b.id, slot: 1, round: 1, status: "IN_REVIEW", fileName: "fix.mp4" },
    });
    const hand = (await outputsForProject(p1b.id))[0];
    ok("…a correction against it is owed work again", hand.state === "in_review", hand.detail);
    ok("…and the earlier hand-delivery is still stated", hand.detail.startsWith("Sent once already;"), hand.detail);

    // =====================================================================
    // R06 — the lifecycle: booking, quantity change, waiver, repair sweep.
    // =====================================================================
    console.log("\n══ R06: the output lifecycle after the backfill");
    const { reconcileDeliverablesToOrder } = await import("@/lib/integrations/aryeo");
    type Order = Parameters<typeof reconcileDeliverablesToOrder>[1];
    const order = (n: number): Order =>
      ({
        id: "ord_drill",
        number: 4242,
        items: [{ id: "it_video", title: "Cinematic Video", quantity: n, amount: 45000, is_canceled: false }],
      }) as unknown as Order;

    console.log("\n── a newly booked four-video job, BEFORE any upload");
    const p2 = await mkProject("3 Fresh Booking Blvd", {
      shootDate: new Date(Date.now() + 2 * 24 * 3600_000),
      // The job's editor — what the row's owner is derived from.
      editorVendorKey: "external_agency",
    });
    const r1 = await reconcileDeliverablesToOrder(p2.id, order(4));
    ok("the order's video line created the deliverable", r1.added.length === 1, r1.added.join(","));
    ok("…with no materialisation error", !r1.outputsError, r1.outputsError ?? "");
    const booked = await outputsForProject(p2.id);
    ok("FOUR owed videos have a row of their own, before any upload", booked.length === 4, `${booked.length} rows`);
    ok("…every one of them has an owner", booked.every((b) => !!b.ownerName), booked.map((b) => `${b.index}:${b.ownerName}`).join(" "));
    ok("…and a deadline", booked.every((b) => !!b.promisedAt), booked[0]?.promisedAt?.toISOString() ?? "none");
    ok("…and none of them claims to be started", booked.every((b) => b.state === "not_started"));
    console.log(`    row 1: ${booked[0]?.label} · owner ${booked[0]?.ownerName} (${booked[0]?.ownerFrom}) · due ${booked[0]?.promisedAt?.toISOString()} · ${booked[0]?.detail}`);

    console.log("\n── the office adds two videos to the order");
    const r2 = await reconcileDeliverablesToOrder(p2.id, order(6));
    ok("the quantity change is applied in place", r2.relabeled.length === 1 || r2.changed, JSON.stringify({ relabeled: r2.relabeled, changed: r2.changed }));
    const six = await outputsForProject(p2.id);
    ok("the two new videos have rows IMMEDIATELY", six.filter((r) => r.state !== "removed").length === 6, `${six.length} rows`);

    console.log("\n── and the office's videos-owed number drops to two");
    await prisma.project.update({ where: { id: p2.id }, data: { videosOwedOverride: 2, overrideAt: new Date() } });
    await ensureOutputsSafely(p2.id, "drill-override");
    const two = await outputsForProject(p2.id);
    ok("only two are owed now", two.filter((r) => r.state !== "removed").length === 2, two.map((r) => r.state).join(","));
    ok("…and the other four are RETIRED, not deleted", two.filter((r) => r.state === "removed").length === 4);
    ok("…every row still exists", (await prisma.deliverableOutput.count({ where: { projectId: p2.id } })) === 6);

    console.log("\n── the office waives the row, then un-waives it (the real server actions)");
    const vRow = await prisma.deliverable.findFirstOrThrow({ where: { projectId: p2.id, type: "VIDEO" }, select: { id: true } });
    const { waiveDeliverable, unwaiveDeliverable } = await import("@/app/projects/deliverableActions");
    // revalidatePath() has no request scope in a script; it runs AFTER the
    // materialisation inside recomputeAfterWaiver, so the part under test has
    // already landed either way.
    const waiveRes = await waiveDeliverable(vRow.id, "discounted off the package").catch((e: unknown) => ({ ok: false, message: String(e) }));
    // Two, not six: the four the office's videos-owed number retired above are
    // already off the order and keep THAT stamp (retire, never delete).
    const waivedRows = await prisma.deliverableOutput.count({ where: { projectId: p2.id, waivedAt: { not: null } } });
    ok("waiving the row stamps every OWED video, in the same press", waivedRows === 2, `${waivedRows} of 2 (${waiveRes.message})`);
    ok("…and the project view says so", (await outputsForProject(p2.id)).every((r) => r.state === "waived" || r.state === "removed"));
    const unwaiveRes = await unwaiveDeliverable(vRow.id).catch((e: unknown) => ({ ok: false, message: String(e) }));
    const stillWaived = await prisma.deliverableOutput.count({ where: { projectId: p2.id, waivedAt: { not: null } } });
    ok("un-waiving hands them back, in the same press", stillWaived === 0, `${stillWaived} still waived (${unwaiveRes.message})`);
    ok("…and the two live videos are owed work again", (await outputsForProject(p2.id)).filter((r) => r.state === "not_started").length === 2);

    // ---- the scheduled repair --------------------------------------------
    console.log("\n── the hourly repair picks up a job nothing else reached");
    const p3 = await mkProject("4 Missed Booking Mews", { shootDate: new Date(Date.now() + 3 * 24 * 3600_000) });
    await prisma.deliverable.create({ data: { projectId: p3.id, type: "VIDEO", label: "Cinematic Video", quantity: 3 } });
    ok("the job owes video and has NO rows", (await prisma.deliverableOutput.count({ where: { projectId: p3.id } })) === 0);
    const sweep1 = await sweepOutputUnits({ max: 40, budgetMs: 15_000 });
    ok("the sweep saw it as bare", sweep1.bare >= 1, `bare=${sweep1.bare} checked=${sweep1.checked}`);
    ok("…and gave all three videos their rows", (await outputsForProject(p3.id)).length === 3);
    ok("…reporting no failures", sweep1.failed.length === 0, JSON.stringify(sweep1.failed));

    // ---- a failed sync is VISIBLE ----------------------------------------
    console.log("\n── a failure does not hide: one bad tick is reported, a persistent one is thrown");
    const realFindMany = prisma.deliverableOutput.findMany.bind(prisma.deliverableOutput);
    let injected = false;
    try {
      (prisma.deliverableOutput as unknown as { findMany: unknown }).findMany = ((args: { where?: { projectId?: string } }) => {
        if (args?.where?.projectId === p3.id) return Promise.reject(new Error("injected: the outputs table is unreachable"));
        return realFindMany(args as Parameters<typeof realFindMany>[0]);
      }) as unknown as typeof realFindMany;
      injected = (await prisma.deliverableOutput.findMany({ where: { projectId: p3.id } }).then(() => false, () => true));
    } catch {
      injected = false;
    }
    if (!injected) {
      console.log("  SKIP  fault injection did not take on this Prisma build — the escalation path is unproven here");
    } else {
      const bad1 = await sweepOutputUnits({ max: 40, budgetMs: 15_000 });
      ok("the first failure is REPORTED, not swallowed", bad1.failed.some((f) => f.projectId === p3.id), JSON.stringify(bad1.failed.map((f) => `${f.title}#${f.runs}`)));
      ok("…and it did not take the other jobs down with it", bad1.checked > 1, `checked=${bad1.checked}`);
      let thrown: string | null = null;
      await sweepOutputUnits({ max: 40, budgetMs: 15_000 }).catch((e: unknown) => {
        thrown = e instanceof Error ? e.message : String(e);
      });
      ok("the SECOND consecutive failure is thrown — CronRun error + Slack ping", !!thrown, thrown ?? "nothing thrown");
      ok("…and it names the job", !!thrown && (thrown as string).includes("4 Missed Booking Mews"), thrown ?? "");
    }
    (prisma.deliverableOutput as unknown as { findMany: unknown }).findMany = realFindMany;
    const healed = await sweepOutputUnits({ max: 40, budgetMs: 15_000 });
    ok("with the fault removed the sweep is clean again", healed.failed.length === 0, JSON.stringify(healed.failed));

    console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  } finally {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
    if (existsSync(BASELINE_PATH)) rmSync(BASELINE_PATH);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  if (existsSync(BASELINE_PATH)) rmSync(BASELINE_PATH);
  process.exit(1);
});
