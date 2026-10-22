// ---------------------------------------------------------------------------
// DRILL: WHO TAKES PROGRAM SESSIONS (Oct 22 2026). Jordan: "make sure Jordan is
// not able to be scheduled. Just James Livingston for now."
//   · with no hub list, Aryeo's assignment decides (both people bookable);
//   · with program_session_creatives naming James, only James is bookable and
//     Jordan carries a plain reason; the match ignores case and spaces;
//   · a broken setting falls back to Aryeo's list rather than offering nobody.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => {
  if (!url.startsWith("https://api.aryeo.com/")) return null;
  if (url.includes("/products")) return json({ data: [{ id: "prod-acc", title: "Video Accelerator", providers: [{ id: "tm-jordan" }, { id: "tm-james" }] }], meta: { current_page: 1, last_page: 1 } });
  if (url.includes("/company-team-members")) return json({ data: [
    { id: "tm-jordan", is_service_provider: true, company_user: { id: "u-j", full_name: "Jordan Spackman", email: "info@realtourpilot.com", status: "active" } },
    { id: "tm-james", is_service_provider: true, company_user: { id: "u-l", full_name: "James Livingston", email: "James@RealtourPilot.com", status: "active" } },
  ], meta: { current_page: 1, last_page: 1 } });
  return json({ data: [] });
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6821) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    const A = await import("@/lib/integrations/aryeo");

    c.head("1 · no hub list: Aryeo's assignment decides");
    A.resetProductProviderCache();
    c.ok("both people are bookable", (await A.bookableProviderIdsFor("prod-acc")).sort().join(",") === "tm-james,tm-jordan");

    c.head("2 · the hub list names James");
    await prisma.appSetting.create({ data: { key: A.SESSION_CREATIVES_KEY, value: JSON.stringify({ emails: [" james@realtourpilot.com "] }), updatedBy: "drill" } });
    A.resetProductProviderCache();
    const rows = await A.productProvidersFor("prod-acc");
    c.ok("only James is bookable (case and spaces ignored)", (await A.bookableProviderIdsFor("prod-acc")).join(",") === "tm-james");
    const jordan = rows.find((r) => r.teamMemberId === "tm-jordan");
    c.ok("Jordan carries a plain reason", jordan?.bookable === false && /Not taking program sessions/.test(jordan.reason ?? ""), jordan?.reason ?? "");

    c.head("3 · a broken setting does not offer nobody");
    await prisma.appSetting.update({ where: { key: A.SESSION_CREATIVES_KEY }, data: { value: "not json" } });
    A.resetProductProviderCache();
    c.ok("falls back to Aryeo's list", (await A.bookableProviderIdsFor("prod-acc")).length === 2);

    c.head("isolation");
    c.ok("only the faked Aryeo was called", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
