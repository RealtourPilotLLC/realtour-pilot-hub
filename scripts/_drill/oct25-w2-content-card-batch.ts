// Oct 25 2026 audit, wave 2 (B9): Jordan's dashboard "Scripts & creative
// decisions" card (contentActions.monthlyContentActions) read the drafting
// reader month by month, ~12 statements a month, ~250 of its ~320. It now
// reads every month in one batched pass (contentDrafting.scriptWorkForMonths;
// scriptWorkForMonth is that pass with one id).
//
// OLD behaviour runs for real: contentDrafting.ts and contentActions.ts at
// 2262747 (the audit's integration base, pinned, never HEAD) are loaded with
// their `@/` imports pointed at this tree (the old card at the old drafting
// reader), and run on the same rows:
//   §1 per month, the old and new scriptWorkForMonth agree item for item, and
//      the batched map agrees with both (carried-out topics, PROPOSED, call
//      excerpts, written route, submitted/with-gaps/follow-up interviews, a
//      script already drafted, an untouched month, a missing id);
//   §2 the card: old and new output deep-equal, with a "Needs N scripts" row;
//   §3 statements: the new card reads far fewer, and the batched reader costs
//      the same for every month as for one.
// Disposable PGlite; nothing leaves.
// @drill-run: conditions=react-server
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch(async () => null);
const BASE = "2262747"; // pinned: the Oct 25 audit's integration base, never HEAD
const REPO = path.resolve(__dirname, "../..");
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "oct25-w2-card-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
/** The file at BASE, its `@/x` imports pointed at this tree, except the ones in `swap` (→ another base copy). */
function writeBase(rel: string, swap: Record<string, string> = {}): string {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, show(rel).replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${swap[p] ?? path.join(REPO, "src", p)}${q}`));
  return file;
}

async function main() {
  // Count every statement: a client that reports its queries, seeded where
  // @/lib/prisma looks for its singleton (before anything imports it).
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5874) });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { PrismaClient: Client } = await import("@prisma/client");
  const counting = new Client({ log: [{ emit: "event", level: "query" }] });
  let statements = 0;
  (counting as unknown as { $on: (e: string, f: () => void) => void }).$on("query", () => { statements++; });
  (globalThis as unknown as { prisma: unknown }).prisma = counting;
  try {
    const { prisma } = await import("@/lib/prisma");
    const prismaAny = prisma as unknown as PrismaClient;
    const { etMonthKey } = await import("@/lib/contentProgram");
    const drafting = await import("@/lib/contentDrafting");
    const { monthlyContentActions, nextMonthKey } = await import("@/lib/contentActions");
    const oldDraftingFile = writeBase("src/lib/contentDrafting.ts");
    const oldDrafting = (await import(oldDraftingFile)) as typeof drafting;
    const oldCard = (await import(writeBase("src/lib/contentActions.ts", { "lib/contentDrafting": oldDraftingFile }))) as { monthlyContentActions: typeof monthlyContentActions };

    const thisMonth = etMonthKey();
    const four = (prefix: string, sel: "SELECTED" | "PROPOSED" = "SELECTED", excerpts: number[] = []) =>
      [1, 2, 3, 4].map((i) => ({ title: `${prefix} topic ${i}`, selection: sel, excerpts: excerpts.includes(i) ? [`Client: my sellers always ask about ${prefix} ${i}, and the answer matters for pricing.`] : undefined }));
    // A held call (our side): two topics with call lines, two without.
    const H = await buildContentMonth(prismaAny, { name: "W2 Held TEST", package: "Accelerator", videosPerMonth: 4, monthKey: thisMonth, project: false, topics: four("Held", "SELECTED", [1, 2]) });
    await prisma.contentMonth.update({ where: { id: H.monthId }, data: { planningMode: "CALL", strategyCallStatus: "COMPLETED", strategyCallAt: new Date(Date.now() - 2 * 864e5) } });
    // The call's proposals, not yet reconciled.
    const P = await buildContentMonth(prismaAny, { name: "W2 Proposed TEST", package: "Accelerator", videosPerMonth: 4, monthKey: thisMonth, project: false, topics: four("Proposed", "PROPOSED") });
    await prisma.contentMonth.update({ where: { id: P.monthId }, data: { planningMode: "CALL", strategyCallStatus: "COMPLETED", strategyCallAt: new Date(Date.now() - 3 * 864e5) } });
    // Interviews in every state the reader branches on, one topic written-route, one script drafted, one carried out.
    const I = await buildContentMonth(prismaAny, { name: "W2 Interviews TEST", package: "Pro", videosPerMonth: 6, monthKey: thisMonth, project: false, topics: [...four("Iv"), { title: "Iv topic 5", selection: "SELECTED" }, { title: "Iv topic 6", selection: "SELECTED" }] });
    const iv = (k: number, status: string, sufficiencyJson: string | null = null) => prisma.contentInterview.create({ data: { topicId: I.topicIds[k], enrollmentId: I.enrollmentId, clientId: I.clientId, monthId: I.monthId, status, sufficiencyJson } });
    await iv(0, "SUBMITTED", JSON.stringify({ sufficient: true, missing: [] }));
    await iv(1, "SUBMITTED");
    await iv(2, "SUBMITTED_WITH_GAPS");
    await iv(3, "NEEDS_FOLLOWUP");
    await prisma.contentTopicSelection.update({ where: { id: I.selectionIds[4]! }, data: { answerRoute: "WRITTEN" } });
    await prisma.contentScript.create({ data: { enrollmentId: I.enrollmentId, clientId: I.clientId, monthId: I.monthId, topicId: I.topicIds[5], title: "Iv topic 6", body: "Drafted.", status: "DRAFT" } });
    const next = await prisma.contentMonth.create({ data: { enrollmentId: H.enrollmentId, clientId: H.clientId, monthKey: nextMonthKey(thisMonth), videosOwed: 4, status: "OPEN" } });
    await prisma.contentScript.create({ data: { enrollmentId: H.enrollmentId, clientId: H.clientId, monthId: next.id, topicId: H.topicIds[3], carriedFromMonthId: H.monthId, title: "Held topic 4", body: "Carried.", status: "DRAFT" } });
    // Next month, touched (a topic chosen), and an untouched one.
    const N = await buildContentMonth(prismaAny, { name: "W2 Next TEST", package: "Accelerator", videosPerMonth: 4, monthKey: nextMonthKey(thisMonth), project: false, topics: four("Next", "SELECTED", [1]) });
    const Q = await buildContentMonth(prismaAny, { name: "W2 Quiet TEST", package: "Accelerator", videosPerMonth: 4, monthKey: thisMonth, project: false, topics: [] });
    const ids = [H.monthId, P.monthId, I.monthId, N.monthId, Q.monthId, next.id];

    c.head("§1 · the drafting reader: old per-month, new per-month, new batched");
    const batched = await drafting.scriptWorkForMonths([...ids, "no-such-month"]);
    for (const [label, id] of [["held call", H.monthId], ["proposed", P.monthId], ["interviews", I.monthId], ["next month", N.monthId], ["no topics", Q.monthId], ["carried into", next.id], ["missing", "no-such-month"]] as const) {
      const before = await oldDrafting.scriptWorkForMonth(id);
      const after = await drafting.scriptWorkForMonth(id);
      const fromMap = batched.get(id) ?? [];
      c.ok(`${label}: old = new = batched (${before.length} items)`, JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(after) === JSON.stringify(fromMap), `${before.map((w) => w.readiness).join(",")} | ${after.map((w) => w.readiness).join(",")} | ${fromMap.map((w) => w.readiness).join(",")}`);
    }
    const held = await drafting.scriptWorkForMonth(H.monthId);
    const ivs = await drafting.scriptWorkForMonth(I.monthId);
    c.ok("the fixture reaches every branch: carried-out topic gone, FROM_CALL, THIN, WAITING_ON_PLANNING, FROM_ANSWERS, THIN_ANSWERS, WAITING_ON_ANSWERS, HAS_SCRIPT",
      held.length === 3 && held.some((w) => w.readiness === "FROM_CALL") && held.some((w) => w.readiness === "THIN")
      && (await drafting.scriptWorkForMonth(P.monthId)).every((w) => w.readiness === "WAITING_ON_PLANNING")
      && ["FROM_ANSWERS", "THIN_ANSWERS", "WAITING_ON_ANSWERS", "HAS_SCRIPT"].every((r) => ivs.some((w) => w.readiness === r)),
      `${held.map((w) => w.readiness)} · ${ivs.map((w) => w.readiness)}`);

    c.head("§2 · the card: old and new say the same thing");
    const now = new Date();
    statements = 0;
    const oldOut = await oldCard.monthlyContentActions({ now });
    const oldStatements = statements;
    statements = 0;
    const newOut = await monthlyContentActions({ now });
    const newStatements = statements;
    c.ok("deep-equal output", JSON.stringify(oldOut) === JSON.stringify(newOut), `${JSON.stringify(oldOut.rows.map((r) => [r.clientName, r.monthKey, r.items.map((i) => i.words)]))}\n vs ${JSON.stringify(newOut.rows.map((r) => [r.clientName, r.monthKey, r.items.map((i) => i.words)]))}`);
    c.ok("…and it is a real card (a 'Needs N scripts' row among several)", newOut.rows.length >= 3 && newOut.rows.some((r) => r.items.some((i) => i.key === "write")), JSON.stringify(newOut.rows.map((r) => [r.clientName, r.items.map((i) => i.words)])));

    c.head("§3 · statements");
    c.ok(`the new card reads fewer statements (${oldStatements} → ${newStatements})`, newStatements < oldStatements, `${oldStatements} → ${newStatements}`);
    statements = 0;
    await drafting.scriptWorkForMonths([H.monthId]);
    const one = statements;
    statements = 0;
    await drafting.scriptWorkForMonths([H.monthId, P.monthId, N.monthId, next.id]);
    const many = statements;
    statements = 0;
    for (const id of [H.monthId, P.monthId, N.monthId, next.id]) await oldDrafting.scriptWorkForMonth(id);
    const oldMany = statements;
    c.ok(`the batched reader costs the same for four months as for one (${one} vs ${many}; month by month it was ${oldMany})`, many === one && oldMany > many, `${one} / ${many} / ${oldMany}`);

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await counting.$disconnect().catch(() => {});
    await db.stop();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
