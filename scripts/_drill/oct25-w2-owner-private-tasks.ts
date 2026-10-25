// Oct 25 2026 audit, wave 2 (F7): the owner's books-audit items
// (`finance-audit:*`) and teammates' pay questions (`payflag-*`) are Jordan's
// alone. Kyle's board, its badges, a ?task= deep link, the Done ledger, his two
// Slack digests' reads, a job's open tasks and Ask the Hub's task tools leave
// them out; Jordan's own views are unchanged; a task with no dedupeKey is
// never dropped by the filter (the NULL branch).
// Disposable PGlite; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { isValidElement } from "react";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
function elements(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
// Every string a rendered tree carries, in text or in a child's props (rows ride props).
function strings(tree: unknown, seen = new Set<unknown>()): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (!tree || typeof tree !== "object" || seen.has(tree)) return "";
  seen.add(tree);
  if (Array.isArray(tree)) return tree.map((t) => strings(t, seen)).join(" ");
  if (isValidElement<Record<string, unknown>>(tree)) return strings(Object.values(tree.props), seen);
  if (tree instanceof Date) return "";
  return strings(Object.values(tree as Record<string, unknown>), seen);
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never };
navigation.redirect = (href) => { throw new Redirect(href); };

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5871), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct25-owner-private" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { default: page } = await import("@/app/tasks/page");
    const { BoardView, boardNavigationCounts } = await import("@/components/tasks/BoardView");
    const { DoneView } = await import("@/components/tasks/DoneView");
    const { doneTodayCount } = await import("@/lib/taskHistory");
    const { getMorningBrief, getOverdueTasks, getTaskHistory } = await import("@/lib/queries");
    const { execHubTool } = await import("@/lib/hubTools");
    const { isOwnerPrivateTask, notOwnerPrivateWhere } = await import("@/lib/ownerPrivateTasks");

    const client = await prisma.client.create({ data: { name: "Real client" } });
    const job = await prisma.project.create({ data: { clientId: client.id, title: "5642 Limeport Rd, Coopersburg", status: "DELIVERED", deliveredAt: new Date() } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "w2-kyle@example.test", role: "MANAGER" } });
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "w2-jordan@example.test", role: "MANAGER" } });
    const kyle = await prisma.appUser.create({ data: { name: "Kyle Smith", email: kyleTm.email!, teamMemberId: kyleTm.id, role: "ADMIN", status: "ACTIVE" } });
    const jordan = await prisma.appUser.create({ data: { name: "Jordan Spackman", email: jordanTm.email!, teamMemberId: jordanTm.id, role: "OWNER", status: "ACTIVE" } });
    const yesterday = new Date(Date.now() - 30 * 3_600_000);
    const audit = await prisma.smartTask.create({ data: { title: "Open a personal checking account and pay yourself a set draw", taskType: "finance_audit", source: "finance_audit", assignedKey: "jordan", ownerId: jordanTm.id, dedupeKey: "finance-audit:draw", dueAt: yesterday } });
    const auditDone = await prisma.smartTask.create({ data: { title: "Upload Lauren's Venmo statements", taskType: "finance_audit", source: "finance_audit", assignedKey: "jordan", dedupeKey: "finance-audit:venmo-lauren", status: "COMPLETED", completedAt: new Date() } });
    const pay = await prisma.smartTask.create({ data: { title: "Pay question — James · 5642 Limeport Rd", taskType: "todo", source: "team", assignedKey: "jordan", projectId: job.id, dedupeKey: `payflag-tm1-${job.id}-2026-10-01`, dueAt: yesterday } });
    const jordanPlain = await prisma.smartTask.create({ data: { title: "Call the CPA about the van lease", taskType: "todo", source: "manual", assignedKey: "jordan", dueAt: yesterday } });
    const keyed = await prisma.smartTask.create({ data: { title: "Chase the lockbox code", taskType: "todo", source: "system", assignedKey: "kyle", projectId: job.id, dedupeKey: "access-task-abc", dueAt: yesterday } });
    const plainDone = await prisma.smartTask.create({ data: { title: "Confirmed the Tuesday shoot", taskType: "todo", source: "manual", assignedKey: "kyle", status: "COMPLETED", completedAt: new Date() } });
    const privateIds = [audit.id, auditDone.id, pay.id];
    const before = JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } }));

    c.head("§1 · the rule");
    c.ok("both keys are owner-private; other keys and no key are not", isOwnerPrivateTask(audit) && isOwnerPrivateTask(pay) && !isOwnerPrivateTask(keyed) && !isOwnerPrivateTask(jordanPlain) && !isOwnerPrivateTask({ dedupeKey: null }));
    const kept = await prisma.smartTask.findMany({ where: notOwnerPrivateWhere(), select: { id: true } });
    c.ok("the where keeps every task with no dedupeKey (the NULL branch) and every other key", kept.length === 3 && [jordanPlain, keyed, plainDone].every((t) => kept.some((k) => k.id === t.id)), `${kept.length} kept`);

    const open = (params: Record<string, string> = {}) => page({ searchParams: Promise.resolve(params) });
    const boardRows = async (params: Record<string, string>) => {
      const tree = await open(params);
      const props = elements(tree, "BoardView")[0] as Parameters<typeof BoardView>[0] | undefined;
      if (!props) throw new Error("Expected BoardView");
      const board = await BoardView(props);
      return elements(board, "GroupCard").flatMap((group) => group.items as { id: string }[]);
    };
    const doneRows = async () => {
      const tree = await open({ tab: "done" });
      const props = elements(tree, "DoneView")[0] as Parameters<typeof DoneView>[0];
      return strings(await DoneView(props));
    };

    c.head("§2 · Kyle (the office)");
    await setSession({ uid: kyle.id, email: kyle.email, role: "ADMIN" });
    const kyleAll = await boardRows({ tab: "work", who: "all" });
    c.ok("All work: no books-audit item, no pay question; Jordan's other task and the keyed task stay", !kyleAll.some((r) => privateIds.includes(r.id)) && kyleAll.some((r) => r.id === jordanPlain.id) && kyleAll.some((r) => r.id === keyed.id), `${kyleAll.length} rows`);
    const kyleCounts = await boardNavigationCounts({});
    c.ok("…and the All work badge counts the same rows", kyleCounts.all === kyleAll.length, `${kyleCounts.all} vs ${kyleAll.length}`);
    const deep = await boardRows({ tab: "work", task: pay.id });
    c.ok("a ?task= deep link to the pay question renders nothing of it", !deep.some((r) => r.id === pay.id));
    const kyleDone = await doneRows();
    c.ok("Done ledger: the closed books-audit item is not there; Kyle's own closed task is", !kyleDone.includes("Venmo statements") && kyleDone.includes("Confirmed the Tuesday shoot"));
    c.ok("…and the Done badge counts 1, not 2", (await doneTodayCount({ hideOwnerPrivate: true })) === 1);
    const brief = [...(await getOverdueTasks()), ...(await getMorningBrief())];
    c.ok("Kyle's Slack digest reads: overdue keeps Jordan's plain task, drops both private ones", brief.some((t) => t.id === jordanPlain.id) && !brief.some((t) => privateIds.includes(t.id)), brief.map((t) => t.title).join(" | "));

    c.head("§3 · Ask the Hub as the office");
    const office = { role: "ADMIN", who: "Kyle Smith", office: true };
    const listed = await execHubTool("list_tasks", { scope: "open", limit: 40 }, office) as { tasks: { title: string }[] };
    c.ok("list_tasks leaves both out", !listed.tasks.some((t) => /Pay question|checking account/.test(t.title)) && listed.tasks.some((t) => /van lease/.test(t.title)));
    const day = await execHubTool("day_summary", {}, office) as { completed_tasks: { title: string }[] };
    c.ok("day_summary leaves the closed books-audit item out", !day.completed_tasks.some((t) => /Venmo/.test(t.title)) && day.completed_tasks.some((t) => /Tuesday shoot/.test(t.title)));
    const detail = await execHubTool("get_project_detail", { id: job.id }, office) as { open_tasks: { title: string }[] };
    c.ok("get_project_detail: the job's open tasks without the pay question", !detail.open_tasks.some((t) => /Pay question/.test(t.title)) && detail.open_tasks.some((t) => /lockbox/.test(t.title)));
    const done = await execHubTool("complete_task", { task: "Pay question James Limeport" }, office) as { done?: boolean };
    const assigned = await execHubTool("assign_task", { task: "personal checking account draw", person: "kyle" }, office) as { done?: boolean };
    c.ok("complete_task / assign_task cannot reach them", !done.done && !assigned.done, JSON.stringify([done, assigned]));
    c.ok("…and nothing was written", JSON.stringify(await prisma.smartTask.findMany({ orderBy: { id: "asc" } })) === before);

    c.head("§4 · Jordan (the owner) sees his own");
    await setSession({ uid: jordan.id, email: jordan.email, role: "OWNER" });
    const ownerAll = await boardRows({ tab: "work", who: "all" });
    c.ok("All work holds the books-audit item and the pay question", [audit.id, pay.id].every((id) => ownerAll.some((r) => r.id === id)), ownerAll.map((r) => r.id).join(","));
    const ownerDone = await doneRows();
    c.ok("Done ledger holds the closed books-audit item", ownerDone.includes("Venmo statements"));
    c.ok("unscoped history (the owner) still counts both closed tasks", (await getTaskHistory(1)).length === 2 && (await doneTodayCount({})) === 2);
    const ownerList = await execHubTool("list_tasks", { scope: "open", limit: 40 }, { role: "OWNER", who: "Jordan", office: true }) as { tasks: { title: string }[] };
    c.ok("Ask the Hub for the owner lists them", ownerList.tasks.some((t) => /Pay question/.test(t.title)) && ownerList.tasks.some((t) => /checking account/.test(t.title)));

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
