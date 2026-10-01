// C01: invoke the actual edit page with signed sessions and isolated DB rows.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// This exercises route code, returned element props, and script sync against
// a fake provider, not HTTP middleware, browser layout, or a live provider.
// Run with _drill-preload.cjs then _client-drill-preload.cjs, without the
// react-server condition, so the page's real client-module graph can load.
import { createRequire } from "node:module";
import { isValidElement } from "react";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

installNextStubs();
const script = "C01 exact stored script: show the neighborhood cafe, then the park.";
let studioScript = script;
let studioReads = 0;
const fence = fenceFetch(async (url, init) => {
  if (!url.startsWith("https://c01-scripting.invalid/api/v1/projects/") || (init?.method ?? "GET") !== "GET") return null;
  studioReads++;
  return new Response(JSON.stringify({ project: { id: "c01-studio-project", status: "approved", script: { raw: studioScript } } }), { status: 200 });
});
const calls: string[] = [];
for (const [moduleName, names] of [
  ["scriptSync", ["autoSyncScript"]],
  ["queries", ["getProject", "getTeam"]],
] as const) {
  interceptModule(
    (r) => r === `@/lib/${moduleName}` || new RegExp(`[\\/]src[\\/]lib[\\/]${moduleName}(\\.ts)?$`).test(r),
    (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
      get(target, name) {
        const value = target[name];
        if (typeof name !== "string" || !(names as readonly string[]).includes(name) || typeof value !== "function") return value;
        return (...args: unknown[]) => { calls.push(name); return value(...args); };
      },
    }),
  );
}

class RouteStop extends Error {
  constructor(readonly kind: "not-found" | "redirect", readonly destination?: string) { super(kind); }
}
const navigation = createRequire(__filename)("next/navigation") as { notFound: () => never; redirect: (href: string) => never };
navigation.notFound = () => { throw new RouteStop("not-found"); };
navigation.redirect = (href) => { throw new RouteStop("redirect", href); };

function elementsNamed(tree: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elementsNamed(part, name));
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  const type = tree.type as string | { name?: string; displayName?: string };
  const found = typeof type !== "string" && (type.displayName ?? type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elementsNamed(part, name))];
}

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5798), env: {
    AUTH_ENFORCE: "true", APP_SECRET: "c01-isolated-session-secret",
    SCRIPTING_BASE_URL: "https://c01-scripting.invalid", SCRIPTING_API_KEY: "c01-fake-script-key",
  } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { default: page } = await import("@/app/edit/[id]/page");
    let submissionReads = 0;
    const readSubmissions = prisma.reviewSubmission.findMany;
    (prisma.reviewSubmission as unknown as { findMany: (...args: unknown[]) => unknown }).findMany = (...args) => {
      submissionReads++;
      return Reflect.apply(readSubmissions, prisma.reviewSubmission, args);
    };
    const client = await prisma.client.create({ data: { name: "C01 route TEST" } });
    const roster = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-roster-c01@example.test", role: "EDITOR" } });
    const kim = await prisma.appUser.create({ data: { email: "kim-c01@example.test", name: "Kim", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const john = await prisma.appUser.create({ data: { email: "john-c01@example.test", name: "John", role: "EDITOR", editorKey: "john", status: "ACTIVE" } });
    const kyle = await prisma.appUser.create({ data: { email: "kyle-c01@example.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { email: "owner-c01@example.test", name: "Owner", role: "OWNER", status: "ACTIVE" } });
    const project = await prisma.project.create({ data: { clientId: client.id, title: "C01 private edit TEST", status: "SHOT", editorId: roster.id, reelScript: script } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Personal Branding Reel", videoStyle: "personal_branding", quantity: 1 } });
    const output = await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: deliverable.id, slot: 1, category: "VIDEO", title: "Cafe and park" } });
    await prisma.projectMessage.create({ data: { projectId: project.id, body: "Keep this brief's chat unread until opened.", authorName: "Kyle" } });
    const open = async () => {
      calls.length = 0; submissionReads = 0;
      try { return { tree: await page({ params: Promise.resolve({ id: project.id }), searchParams: Promise.resolve({}) }), stop: null }; }
      catch (e) { if (e instanceof RouteStop) return { tree: null, stop: e }; throw e; }
    };
    const signIn = (user: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: user.id, email: user.email, role: user.role, actingAs });
    const noSensitiveWork = () => calls.length === 0 && submissionReads === 0;
    const renderedScript = (tree: unknown) => elementsNamed(tree, "ReelScriptCard").some((props) => props.script === script);
    const reachedReadsInOrder = (preview = false) => (preview ? !calls.includes("autoSyncScript") : calls[0] === "autoSyncScript") && calls.includes("getProject") && calls.includes("getTeam") && submissionReads > 0;

    await clearSession();
    const anonymous = await open();
    c.ok("anonymous route redirects to this job's sign-in before sync or content reads", anonymous.stop?.kind === "redirect" && anonymous.stop.destination === `/login?next=/edit/${project.id}` && noSensitiveWork());
    await signIn(john);
    c.ok("unassigned signed editor is not-found before sync/project/team/submissions", (await open()).stop?.kind === "not-found" && noSensitiveWork());
    await signIn(kim);
    const assigned = await open();
    c.ok("assigned signed editor executes actual route and reads the exact stored script", !assigned.stop && renderedScript(assigned.tree) && reachedReadsInOrder());
    c.ok("ordinary assigned editor still syncs through the configured fake provider", studioReads === 1 && !!(await prisma.project.findUnique({ where: { id: project.id } }))?.scriptingSyncedAt);
    c.ok("assigned brief load does not mark chat read or start editing", await prisma.threadRead.count() === 0 && await prisma.editorWorkItem.count() === 0);
    await prisma.appUser.update({ where: { id: kim.id }, data: { status: "DISABLED" } });
    const revoked = await open();
    c.ok("revoked account's still-signed cookie fails before sync/content reads", revoked.stop?.kind === "redirect" && noSensitiveWork());
    await prisma.appUser.update({ where: { id: kim.id }, data: { status: "ACTIVE" } });
    await signIn(kyle);
    const office = await open();
    c.ok("signed ADMIN retains access through the actual route", !office.stop && renderedScript(office.tree) && reachedReadsInOrder());
    await signIn(owner);
    c.ok("signed OWNER retains access through the actual route", !(await open()).stop && reachedReadsInOrder());
    await signIn(owner, john.id);
    c.ok("owner preview of an unassigned editor is not-found before content work", (await open()).stop?.kind === "not-found" && noSensitiveWork());
    await signIn(owner, kim.id);
    await prisma.project.update({ where: { id: project.id }, data: { scriptingSyncedAt: null } });
    studioScript = "Changed provider script that preview must not import.";
    const beforePreviewReads = studioReads;
    const preview = await open();
    const workBar = elementsNamed(preview.tree, "WorkStateBar")[0]?.bar as { mode?: string } | undefined;
    const previewChats = elementsNamed(preview.tree, "ProjectMessages");
    const previewUploads = elementsNamed(preview.tree, "CutUploader");
    const previewReceipts = elementsNamed(preview.tree, "EditorBriefReceiptCard");
    c.ok("owner preview of assigned editor reads saved script without running auto-sync", !preview.stop && renderedScript(preview.tree) && reachedReadsInOrder(true));
    const previewProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    c.ok("configured preview makes zero provider reads or script/timestamp writes", studioReads === beforePreviewReads && previewProject.reelScript === script && previewProject.scriptingSyncedAt === null);
    c.ok("preview tree keeps work/chat/upload/brief receipt controls read-only", workBar?.mode === "view" && previewChats.length === 1 && previewChats[0].readOnly === true && previewUploads.length === 1 && previewUploads[0].canUpload === false && previewReceipts.length === 1 && previewReceipts[0].canAcknowledge === false);
    c.ok("preview has not written chat receipts, assignment receipts or editing work", await prisma.threadRead.count() === 0 && await prisma.editorBriefReceipt.count() === 0 && await prisma.editorWorkItem.count() === 0);
    // Keep later ownership cases independent if the preview regression fails.
    studioScript = script;
    await prisma.project.update({ where: { id: project.id }, data: { reelScript: script, scriptingSyncedAt: null } });
    await prisma.project.update({ where: { id: project.id }, data: { editorId: null } });
    await prisma.deliverableOutput.update({ where: { id: output.id }, data: { ownerKey: "john", ownerName: "John" } });
    await signIn(john);
    const perOutput = await open();
    c.ok("saved current per-video owner can open the actual route", !perOutput.stop && renderedScript(perOutput.tree) && reachedReadsInOrder());
    await prisma.deliverableOutput.update({ where: { id: output.id }, data: { removedFromOrderAt: new Date() } });
    c.ok("retiring the only assigned output closes the route before sync/content reads", (await open()).stop?.kind === "not-found" && noSensitiveWork());
    c.ok("no provider call escaped and exact source script stayed unchanged", fence.blocked.length === 0 && (await prisma.project.findUnique({ where: { id: project.id } }))?.reelScript === script);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
