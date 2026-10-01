// C16: the signed editor's home card uses normal-client quality scope.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { isValidElement } from "react";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { NEVER_SYNTHETIC_CLIENT_IDS } from "../../src/lib/testClients";
import type { EditorQualityReport } from "../../src/lib/editorQuality";

installNextStubs();
const fence = fenceFetch();
function reportOf(tree: unknown): EditorQualityReport | null {
  if (Array.isArray(tree)) return tree.map(reportOf).find(Boolean) ?? null;
  if (!isValidElement<Record<string, unknown>>(tree)) return null;
  const type = tree.type as { name?: string };
  if (type.name === "EditorQualityCard") return tree.props.report as EditorQualityReport;
  return Object.values(tree.props).map(reportOf).find(Boolean) ?? null;
}
async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5842), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-c16-home-quality" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { default: page } = await import("@/app/editing/page");
    const { editorQuality } = await import("@/lib/editorQuality");
    const real = await prisma.client.create({ data: { name: "Real Agent" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST" } });
    const protectedReal = await prisma.client.create({ data: { id: NEVER_SYNTHETIC_CLIENT_IDS[0], name: "Protected TEST" } });
    const kim = await prisma.appUser.create({ data: { name: "Kim", email: "c16-home-kim@example.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const now = new Date();
    for (const client of [real, fixture, protectedReal]) {
      const project = await prisma.project.create({ data: { clientId: client.id, title: "123 TEST Avenue" } });
      await prisma.reviewSubmission.create({ data: { projectId: project.id, kind: "video", submittedByKey: "kim", source: "upload", status: "APPROVED", createdAt: new Date(now.getTime() - 60_000), decidedAt: now } });
    }
    const before = await prisma.reviewSubmission.findMany({ orderBy: { id: "asc" } });
    await setSession({ uid: kim.id, email: kim.email, role: kim.role });
    const report = reportOf(await page());
    c.ok("actual signed editor home card excludes synthetic-only quality", report?.editorKey === "kim" && report.firstReview.reviewed === 2 && report.firstReview.passed === 2, JSON.stringify(report?.firstReview));
    const normal = await editorQuality({ editorKey: "kim", excludeClientIds: [fixture.id] });
    c.ok("home and normal quality reader agree, retaining protected identity and TEST address", report?.firstReview.reviewed === normal.firstReview.reviewed && normal.firstReview.reviewed === 2);
    c.ok("explicit full quality reader still retains fixture results", (await editorQuality({ editorKey: "kim" })).firstReview.reviewed === 3);
    c.ok("quality render preserves stored versions and manual work state", JSON.stringify(before) === JSON.stringify(await prisma.reviewSubmission.findMany({ orderBy: { id: "asc" } })) && await prisma.editorWorkItem.count() === 0 && await prisma.editorWorkEvent.count() === 0);
    c.ok("signed page read makes no provider or client-send calls", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
