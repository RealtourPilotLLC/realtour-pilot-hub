// C18: a named property must not inherit a different guessed order. Isolated
// Postgres and the shared runner's provider/network fence; no live data.
import { bootDrillDb, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

async function main() {
  const { stop } = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5539) });
  const fence = fenceFetch();
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { checkedCommProject } = await import("@/lib/commProject");
  const { recordClientCommunication } = await import("@/lib/comms");
  const { mergeIntoExistingTask } = await import("@/lib/tasks");
  try {
    const client = await prisma.client.create({ data: { name: "C18 fixture" } });
    const stranger = await prisma.client.create({ data: { name: "Other fixture" } });
    const old = await prisma.project.create({ data: { clientId: client.id, title: "3057 N 10th St, Philadelphia", status: "DELIVERED" } });
    const named = await prisma.project.create({ data: { clientId: client.id, title: "3826 Fairmount Ave, Philadelphia", status: "DELIVERED" } });
    const projects = [{ id: old.id, title: old.title }, { id: named.id, title: named.title }];
    c.ok("known address contradicts the guess", checkedCommProject("Save access notes for 3826 Fairmount Ave", projects, old.id).projectId === null);
    c.ok("a property named in the proposed task title catches a context-only contradiction", !!checkedCommProject(["Please save the details.", "Save access for 3826 Fairmount Ave"].join("\n"), projects, old.id).issue);
    c.ok("two named properties stay ambiguous", !!checkedCommProject("Talk about 3826 Fairmount and 3057 N 10th", projects, old.id).issue);
    c.ok("explicit unknown clears an old guess", checkedCommProject("The message has no property", projects, null).projectId === null);
    c.ok("one matching property is safe to link", checkedCommProject("3826 Fairmount", projects, named.id).projectId === named.id);
    c.ok("another client's project is refused", !!checkedCommProject("Please follow up", projects, "other-client-project").issue);

    await recordClientCommunication({ clientId: client.id, clientName: client.name, projectId: old.id, projectStatus: old.status, propertyAddress: old.title, text: "Please save shoot access notes for 3826 Fairmount Ave.", kind: "text", source: "openphone" });
    const created = await prisma.smartTask.findFirst({ where: { clientId: client.id }, orderBy: { createdAt: "desc" } });
    c.ok("contradicted inbound creates a visible task without the wrong project link", !!created && created.projectId === null && created.propertyAddress === null && /Confirm property/.test(created.title), created ? `${created.projectId} · ${created.title}` : "no task");

    const mergeTarget = await prisma.smartTask.create({ data: { clientId: client.id, projectId: old.id, taskType: "todo", title: "Old order task", source: "openphone" } });
    c.ok("merge cannot move an existing task to another property", !(await mergeIntoExistingTask(mergeTarget.id, { clientId: client.id, projectId: named.id, title: "Changed" })));
    c.ok("merge cannot cross client ownership", !(await mergeIntoExistingTask(mergeTarget.id, { clientId: stranger.id, projectId: old.id, title: "Changed" })));
    const unchanged = await prisma.smartTask.findUnique({ where: { id: mergeTarget.id } });
    c.ok("rejected merges preserve task identity and title", unchanged?.projectId === old.id && unchanged?.title === "Old order task");
    c.ok("no outbound provider request", fence.blocked.length === 0, fence.blocked.join(", "));
    const { pass, fail } = c.summary();
    process.exitCode = fail ? 1 : pass ? 0 : 1;
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
