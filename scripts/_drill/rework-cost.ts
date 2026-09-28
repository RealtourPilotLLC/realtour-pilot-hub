// ---------------------------------------------------------------------------
// DRILL: REWORK COST, BESIDE THE MODEL (§10 AU-26 / I4, unified handoff batch
// 5, Sep 26 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/rework-cost.ts
//
//   0. OLD (17df024): a photo job whose raws were never counted carried
//      photoCost 0 — its photo editing silently free, its margin overstated —
//      and nothing said the totals were incomplete.
//      The owner's finance advisor ranked it among the best jobs, as exact.
//   1. NEW: that job's photoCost is null and costComplete false; a video-only
//      job's 0 is a real 0; the totals count uncountedJobs and say incomplete.
//      The advisor leaves it out of best/worst and says the margin is
//      incomplete (review, Sep 26).
//   2. A waived extra-round fee → ONE WAIVED_REVENUE row, still one after
//      three runs; reversed → voided (kept); waived again → the same row back.
//   3. A job with no rows reads null, not $0. A voided row keeps its history
//      and leaves the sum. Rework NEVER moves the modelled margin.
//   4. Evidence: a Stripe refund on the job is offered; attached once it is
//      recorded and no longer offered; the same evidence twice is refused; a
//      round from another job is refused; a waiver can't be typed in.
//   5. Owner only: the admin's entry is refused, the owner's lands.
//   6. packageMargin still reconciles to jobProfit to the penny for the fully
//      costed jobs, and survives the null.
//   7. Cause-tagged rework for the §8 view; untagged stays untagged.
//
// ISOLATION. PGlite on 127.0.0.1:5795 (DRILL_PORT overrides). The payroll
// engine (mileage routing goes over the network) is replaced at the module
// boundary by a fixed ledger. Every outbound call is blocked. AUTH_ENFORCE on.
// THE CLOCK: Saturday Sep 26 2026 19:30 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5795);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
const SIM = RealDate.parse("2026-09-26T19:30:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;

installNextStubs();
const fence = fenceFetch();

// ---- a fixed payroll ledger ---------------------------------------------------
const PAY = new Map<string, number>();
const isMod = (r: string, tail: string) => r === `@/lib/${tail}` || r.endsWith(`/src/lib/${tail}`) || r.endsWith(`/src/lib/${tail}.ts`);
const wrapped = new WeakMap<object, unknown>();
interceptModule(
  (r) => isMod(r, "payroll"),
  (loaded) => {
    const m = loaded as Record<string | symbol, unknown>;
    if (!wrapped.has(m)) {
      wrapped.set(m, new Proxy(m, {
        get: (t, k) =>
          k === "computePayroll"
            ? async () => [{ member: { id: "tm-h", name: "Harrison Drill" }, jobs: [...PAY].map(([projectId, jobTotal]) => ({ projectId, jobTotal })) }]
            : t[k],
      }));
    }
    return wrapped.get(m);
  },
);

function writeBase(from = "src/lib/jobProfit.ts") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rework-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const src = execFileSync("git", ["show", `${BASE}:${from}`], { cwd: REPO, encoding: "utf8" });
  const file = path.join(dir, path.basename(from).replace(/\.ts$/, ".base.ts"));
  fs.writeFileSync(file, src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return file;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Walk a server component's element tree to text, running nested server
 *  components; a client component (hooks) renders as nothing here. */
async function renderText(node: any): Promise<string> {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return (await Promise.all(node.map(renderText))).join("");
  if (typeof node === "object" && typeof node.then === "function") return renderText(await node);
  if (typeof node === "object" && node.type) {
    if (typeof node.type === "function") {
      try { return await renderText(await node.type(node.props)); } catch { return ""; }
    }
    return renderText(node.props?.children);
  }
  return "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
/** lucide-react and next/link create React contexts at load, which the
 *  react-server build of React cannot do; for a text walk an icon is nothing
 *  and a link is its children. Installed just before a component is imported. */
function stubUiModules() {
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  const Icon = () => null;
  const lucide = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : Icon) });
  const link = { __esModule: true, default: ({ children }: { children?: unknown }) => children };
  L._load = function (r: string, p: unknown, m: boolean) {
    if (r === "lucide-react") return lucide;
    if (r === "next/link") return link;
    return prev.call(this, r, p, m);
  };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { jobProfitability } = await import("@/lib/jobProfit");
  const { packageMargins } = await import("@/lib/packageMargin");
  const rw = await import("@/lib/reworkCost");
  const { establishSession } = await import("@/lib/auth/session");
  const { addReworkCostAction } = await import("@/app/projects/reworkActions");

  const client = await prisma.client.create({ data: { name: "Rework Client TEST" } });
  const shot = new Date("2026-09-20T10:00:00-04:00");
  const mk = async (title: string, price: number, deliverables: { type: "PHOTOS" | "VIDEO"; label: string }[], raw: number | null, items: [string, number][]) => {
    const p = await prisma.project.create({
      data: {
        title, clientId: client.id, status: "DELIVERED", shootDate: shot, price, rawPhotoCount: raw, dronePhotoCount: raw == null ? null : 0,
        deliverables: { create: deliverables.map((d) => ({ ...d, quantity: 1 })) },
        orderItems: { create: items.map(([t, a]) => ({ title: t, amount: a, quantity: 1 })) },
      },
    });
    return p.id;
  };
  const counted = await mk("1 Counted Ct", 500, [{ type: "PHOTOS", label: "Photos" }, { type: "VIDEO", label: "Standard Reel" }], 100, [["Bronze Package", 350], ["Standard Reel", 150]]);
  const uncounted = await mk("2 Uncounted Ln", 300, [{ type: "PHOTOS", label: "Photos" }], null, [["Bronze Package", 300]]);
  const videoOnly = await mk("3 Video Way", 400, [{ type: "VIDEO", label: "Standard Reel" }], null, [["Standard Reel", 400]]);
  PAY.set(counted, 150.25).set(uncounted, 100.1).set(videoOnly, 120.33);
  const start = new Date("2026-09-01T00:00:00-04:00");
  const end = new Date("2026-09-26T23:59:00-04:00");

  // =========================================================================
  c.head("0 · OLD (17df024): an uncounted photo job's editing was free");
  {
    const old = (await import(writeBase())) as { jobProfitability: (s: Date, e: Date) => Promise<{ jobs: Record<string, unknown>[] } & Record<string, unknown>> };
    const r = await old.jobProfitability(start, end);
    const u = r.jobs.find((j) => j.id === uncounted)!;
    c.ok("OLD: photoCost 0 on the job whose raws were never counted", u.photoCost === 0);
    c.ok("OLD: its margin was revenue − shooter only (no photo editing at all)", Math.abs((u.margin as number) - (300 - 100.1)) < 1e-9);
    c.ok("OLD: nothing said the totals were incomplete", !("uncountedJobs" in r) && !("costComplete" in u));
    // The owner's finance advisor answers from the same engine (financeTools.ts,
    // unchanged at 17df024): it ranked every job by margin, the uncounted one
    // included, with no word that its photo cost was missing.
    const oldTools = (await import(writeBase("src/lib/financeTools.ts"))) as { execFinanceTool: (n: string, i: Record<string, unknown>) => Promise<unknown> };
    const ot = (await oldTools.execFinanceTool("job_profitability", { days_back: 60 })) as Record<string, unknown> & { best_jobs: { job: string }[] };
    c.ok("OLD advisor: ranks the uncounted job among the best with an exact margin, and says nothing", ot.best_jobs.some((j) => j.job === "2 Uncounted Ln") && !("margin_complete" in ot) && !("uncounted_jobs" in ot), JSON.stringify(ot.best_jobs.map((j) => j.job)));
  }

  // =========================================================================
  c.head("1 · NEW: unknown is not zero");
  const before = await jobProfitability(start, end);
  {
    const u = before.jobs.find((j) => j.id === uncounted)!;
    const v = before.jobs.find((j) => j.id === videoOnly)!;
    const k = before.jobs.find((j) => j.id === counted)!;
    c.ok("the uncounted photo job: photoCost null, costComplete false", u.photoCost === null && u.costComplete === false);
    c.ok("the video-only job owes no photos: a real 0, complete", v.photoCost === 0 && v.costComplete === true);
    c.ok("the counted job: 20 finished × $0.50 = $10 photo, $40 reel", k.photoCost === 10 && k.editingCost === 50 && k.costComplete);
    c.ok("totals: one job uncounted, margin marked incomplete", before.uncountedJobs === 1 && before.marginComplete === false);
    c.ok("no rework recorded anywhere → null, not $0", before.reworkActual === null && before.reworkEstimate === null && before.jobs.every((j) => j.reworkActual === null));
    // The owner's finance advisor (review, Sep 26): the same rule as the Jobs tab.
    const { execFinanceTool } = await import("@/lib/financeTools");
    const t = (await execFinanceTool("job_profitability", { days_back: 60 })) as {
      margin_complete: boolean; uncounted_jobs: number; note?: string;
      best_jobs: { job: string; cost_complete: boolean }[]; worst_jobs: { job: string; cost_complete: boolean }[];
    };
    const ranked = [...t.best_jobs, ...t.worst_jobs];
    c.ok("advisor: the uncounted job is in neither best nor worst", ranked.length > 0 && !ranked.some((j) => j.job === "2 Uncounted Ln"), JSON.stringify(ranked.map((j) => j.job)));
    c.ok("…every job it ranks carries cost_complete: true", ranked.every((j) => j.cost_complete === true));
    c.ok("…and the totals say incomplete, 1 uncounted, in words the model will repeat", t.margin_complete === false && t.uncounted_jobs === 1 && /not counted yet/.test(t.note ?? ""), JSON.stringify({ c: t.margin_complete, u: t.uncounted_jobs, n: t.note }));
  }

  // =========================================================================
  c.head("2 · a waived fee becomes one row, however often it runs");
  const round = await prisma.contentRevisionRound.create({
    data: { videoKey: "vid-1", projectId: counted, enrollmentId: "enr-1", clientId: client.id, submissionId: "sub-1", windowId: "win-1", decisionId: "dec-1", ordinal: 3, includedRounds: 2, included: false, feeCents: 5000, feeDecision: "WAIVE", feeDecidedAt: new Date(), feeDecidedBy: "kyle@drill.invalid" },
  });
  {
    const r1 = await rw.deriveWaivedRevenue();
    await rw.deriveWaivedRevenue();
    await rw.deriveWaivedRevenue();
    const rows = await prisma.reworkCost.findMany({ where: { kind: "WAIVED_REVENUE" } });
    c.ok("first run creates one", r1.created === 1);
    c.ok("three runs → still one row: $50.00 actual, evidence round:<id>", rows.length === 1 && rows[0].amountCents === 5000 && rows[0].basis === "actual" && rows[0].evidenceRef === `round:${round.id}` && rows[0].projectId === counted);
    await prisma.contentRevisionRound.update({ where: { id: round.id }, data: { feeDecision: "CHARGE" } });
    const r2 = await rw.deriveWaivedRevenue();
    const voided = await prisma.reworkCost.findFirst({ where: { kind: "WAIVED_REVENUE" } });
    c.ok("waiver reversed → the row is voided, not deleted", r2.voided === 1 && !!voided?.voidedAt && (await prisma.reworkCost.count()) === 1);
    await prisma.contentRevisionRound.update({ where: { id: round.id }, data: { feeDecision: "WAIVE" } });
    const r3 = await rw.deriveWaivedRevenue();
    const back = await prisma.reworkCost.findFirst({ where: { kind: "WAIVED_REVENUE" } });
    c.ok("waived again → the same row comes back", r3.restored === 1 && back?.id === voided?.id && back?.voidedAt === null && (await prisma.reworkCost.count()) === 1);
  }

  // =========================================================================
  c.head("3 · beside the margin, never inside it");
  {
    const manual = await rw.addReworkCost({ projectId: counted, kind: "EDITOR_LABOR", amountCents: 2000, basis: "actual", evidenceRef: "manual", issueCause: "EDITOR_ERROR", enteredBy: "owner@drill.invalid" });
    await rw.addReworkCost({ projectId: counted, kind: "TRAVEL", amountCents: 1500, basis: "estimate", evidenceRef: "manual", enteredBy: "owner@drill.invalid" });
    let now = await jobProfitability(start, end);
    let k = now.jobs.find((j) => j.id === counted)!;
    const k0 = before.jobs.find((j) => j.id === counted)!;
    c.ok("actual $70 (waiver + labour) and estimate $15, kept apart", k.reworkActual === 70 && k.reworkEstimate === 15, `${k.reworkActual} / ${k.reworkEstimate}`);
    c.ok("the modelled margin did not move", k.margin === k0.margin && now.margin === before.margin);
    c.ok("the video-only job still reads null (nothing recorded)", now.jobs.find((j) => j.id === videoOnly)!.reworkActual === null);
    await rw.voidReworkCost(manual.id!, "owner@drill.invalid");
    now = await jobProfitability(start, end);
    k = now.jobs.find((j) => j.id === counted)!;
    const kept = await prisma.reworkCost.findUnique({ where: { id: manual.id! } });
    c.ok("a voided row leaves the sum ($50 left)…", k.reworkActual === 50);
    c.ok("…and keeps its history (who, when)", !!kept?.voidedAt && kept.voidedBy === "owner@drill.invalid" && kept.amountCents === 2000);
    c.ok("voiding twice is a no", !(await rw.voidReworkCost(manual.id!, "x")).ok);
  }

  // =========================================================================
  c.head("4 · evidence is offered, picked once, and checked");
  {
    await prisma.stripeTransaction.create({ data: { id: "txn_drill_refund_1", type: "refund", gross: -75, fee: 0, net: -75, createdAt: new Date("2026-09-22T12:00:00Z"), projectId: counted } });
    let cands = await rw.evidenceCandidates(counted);
    c.ok("the Stripe refund on the job is offered as REFUND", cands.some((x) => x.ref === "stripe:txn_drill_refund_1" && x.kindHint === "REFUND"));
    c.ok("the waived round is NOT offered again (already recorded)", !cands.some((x) => x.ref === `round:${round.id}`));
    c.ok("nothing was attached on its own", (await prisma.reworkCost.count({ where: { evidenceRef: "stripe:txn_drill_refund_1" } })) === 0);
    const a = await rw.addReworkCost({ projectId: counted, kind: "REFUND", amountCents: 7500, basis: "actual", evidenceRef: "stripe:txn_drill_refund_1", enteredBy: "owner@drill.invalid" });
    const b = await rw.addReworkCost({ projectId: counted, kind: "REFUND", amountCents: 7500, basis: "actual", evidenceRef: "stripe:txn_drill_refund_1", enteredBy: "owner@drill.invalid" });
    c.ok("picked once → recorded", a.ok);
    c.ok("the same refund twice → refused", !b.ok && /already recorded/.test(b.message), b.message);
    cands = await rw.evidenceCandidates(counted);
    c.ok("…and it is no longer offered", !cands.some((x) => x.ref === "stripe:txn_drill_refund_1"));
    const v = await rw.voidReworkCost(a.id!, "owner@drill.invalid");
    const again = await rw.addReworkCost({ projectId: counted, kind: "REFUND", amountCents: 7000, basis: "actual", evidenceRef: "stripe:txn_drill_refund_1", enteredBy: "owner@drill.invalid" });
    const hist = await prisma.reworkCost.findMany({ where: { evidenceRef: { startsWith: "stripe:txn_drill_refund_1" } }, orderBy: { enteredAt: "asc" } });
    c.ok("voided, the same refund can be recorded again with the right figure — both rows kept", v.ok && again.ok && hist.length === 2 && hist.filter((h) => !h.voidedAt).length === 1 && hist.some((h) => h.amountCents === 7500 && !!h.voidedAt));
    const waiverRow = await prisma.reworkCost.findFirst({ where: { kind: "WAIVED_REVENUE" } });
    c.ok("a derived waiver row can't be voided by hand", !(await rw.voidReworkCost(waiverRow!.id, "owner@drill.invalid")).ok);
    const other = await prisma.contentRevisionRound.create({ data: { videoKey: "vid-9", projectId: videoOnly, enrollmentId: "enr-1", clientId: client.id, submissionId: "s9", windowId: "w9", decisionId: "dec-9", ordinal: 1, includedRounds: 2, included: true } });
    c.ok("a round from another job → refused", !(await rw.addReworkCost({ projectId: counted, kind: "EDITOR_LABOR", amountCents: 100, basis: "actual", evidenceRef: `round:${other.id}`, enteredBy: "o" })).ok);
    c.ok("a waiver cannot be typed in", !(await rw.addReworkCost({ projectId: counted, kind: "WAIVED_REVENUE", amountCents: 100, basis: "actual", evidenceRef: "manual", enteredBy: "o" })).ok);
    c.ok("a made-up evidence ref → refused", !(await rw.addReworkCost({ projectId: counted, kind: "OTHER", amountCents: 100, basis: "actual", evidenceRef: "stripe:txn_nope", enteredBy: "o" })).ok);
  }

  // =========================================================================
  c.head("5 · owner only");
  {
    const admin = await prisma.appUser.create({ data: { email: "kyle-rw@drill.invalid", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { email: "owner-rw@drill.invalid", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    await establishSession(admin.id);
    let refused = false;
    try { await addReworkCostAction({ projectId: videoOnly, kind: "TRAVEL", amount: "40", basis: "actual", evidenceRef: "manual" }); } catch { refused = true; }
    c.ok("the admin's entry is refused", refused && (await prisma.reworkCost.count({ where: { projectId: videoOnly } })) === 0);
    await establishSession(owner.id);
    const r = await addReworkCostAction({ projectId: videoOnly, kind: "TRAVEL", amount: "$40.00", basis: "actual", evidenceRef: "manual" });
    const row = await prisma.reworkCost.findFirst({ where: { projectId: videoOnly } });
    c.ok("the owner's lands, in cents, signed by the owner", r.ok && row?.amountCents === 4000 && row.enteredBy === "owner-rw@drill.invalid");
  }

  // =========================================================================
  c.head("6 · packageMargin reconciles to jobProfit, and survives the null");
  {
    const pm = await packageMargins(start, end);
    const jp = await jobProfitability(start, end);
    const priced = jp.jobs.filter((j) => j.costComplete);
    const expected = priced.reduce((s, j) => s + j.photographerCost + j.editingCost, 0);
    // The uncounted job is priced too; its cost is the known part only.
    const all = jp.jobs.reduce((s, j) => s + j.photographerCost + j.editingCost, 0);
    c.ok("three priced jobs costed", pm.jobs === 3, String(pm.jobs));
    c.ok("package cost == job cost to the penny (all three, uncounted's known part)", Math.abs(pm.cost - all) <= 0.01, `${pm.cost} vs ${all}`);
    c.ok("…and the fully costed two carry exactly their own", Math.abs(expected - (150.25 + 50 + 120.33 + 40)) <= 0.01, String(expected));
    c.ok("photoCostKnown reports the gap (1 of 3 counted)", Math.abs(pm.photoCostKnown - 1 / 3) < 1e-9, String(pm.photoCostKnown));
  }

  // =========================================================================
  c.head("7 · cause-tagged rework for the §8 view");
  {
    await rw.addReworkCost({ projectId: counted, kind: "VENDOR", amountCents: 900, basis: "actual", evidenceRef: "manual", issueCause: "PROCESSING", enteredBy: "o" });
    const by = await rw.reworkByCause();
    const get = (k: string) => by.find((b) => b.cause === k);
    c.ok("a tagged cost lands under its cause", get("PROCESSING")?.actualCents === 900);
    c.ok("the voided editor-error row is not counted", !get("EDITOR_ERROR"));
    c.ok("untagged stays UNTAGGED, never guessed", (get("UNTAGGED")?.rows ?? 0) >= 3);
  }

  c.head("8 · the owner's panel renders actual and estimate apart");
  {
    stubUiModules();
    const { ReworkCostPanel } = await import("@/components/project/ReworkCostPanel");
    const text = await renderText(await ReworkCostPanel({ projectId: counted }));
    c.ok("panel shows the actual total and the history, voided rows included", /actual/.test(text) && /Fee waived/.test(text) && /voided/.test(text), text.slice(0, 200));
    const blank = await renderText(await ReworkCostPanel({ projectId: uncounted }));
    c.ok("a job with nothing recorded says unknown, not free", /unknown, not free/.test(blank));
  }
  c.ok("zero outbound calls", fence.blocked.length === 0, fence.blocked.join(", "));
  quiet.restore();
  c.summary();
  await stop();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
