// ---------------------------------------------------------------------------
// DRILL · oct30-options-first: THE SCRIPTING PLATFORM PICKS FIRST (Oct 30 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct30-options-first.ts
//
// Jordan: "Also premium reel scripting API updated" (docs/hub-api.md, platform
// commit 481b386). An intake now ends in 10 to 15 options and no script until
// the producer picks one; a reply carries its own type.
//
//   §1 the hook: chosen_hook once picked, else nothing; never the recommended
//      option (recommended_index counts from 1, and the hub read it from 0)
//   §2 the link: while options wait, the console (admin_url), not the empty
//      creative page
//   §3 the desk: options proposed open "Pick a script option" for the
//      listing-scripts owner; the script closes it and opens "Script ready";
//      the agent's reply is read from client_response.type
//
// ISOLATION: PGlite via the shared harness, every .env key blank (the
// platform is never called: each event's own payload is the snapshot).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5734);
installNextStubs();
const fence = fenceFetch();
const c = makeChecker();

const OPTIONS = [
  { index: 1, archetype: "confession", text: "I almost didn't list this one." },
  { index: 2, archetype: "contrarian", text: "Everyone says buy new. Not here." },
  { index: 3, archetype: "direct", text: "Four bedrooms, a creek, no neighbors." },
];
const LINKS = { creative_url: "https://scripts.invalid/creative/tok", admin_url: "https://scripts.invalid/admin/projects/p1", intake_url: "https://scripts.invalid/intake/tok" };

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    const S = await import("@/lib/integrations/scripting");
    const { processScriptingEvent } = await import("@/lib/webhooks/scripting");

    c.head("1 · The hook is the one that was picked");
    const unpicked = { id: "p1", status: "hooks_proposed", links: LINKS, hooks: { brief: "b", recommended_index: 2, chosen_hook: null, options: OPTIONS }, script: null };
    c.ok("options waiting: no hook", S.studioToRecipe(unpicked as never).hook === undefined && S.studioSnapshot(unpicked).hook === null, JSON.stringify(S.studioSnapshot(unpicked).hook));
    const picked = { ...unpicked, status: "awaiting_review", hooks: { ...unpicked.hooks, chosen_hook: OPTIONS[1].text } };
    c.ok("picked: the chosen hook", S.studioToRecipe(picked as never).hook === OPTIONS[1].text);
    c.ok("never the option after the recommended one", S.studioSnapshot(unpicked).hook !== OPTIONS[2].text);

    c.head("2 · While options wait, the link is the console");
    c.ok("hooks_proposed: admin_url", S.studioBestLink(unpicked) === LINKS.admin_url, String(S.studioBestLink(unpicked)));
    c.ok("generating_hooks: admin_url", S.studioBestLink({ ...unpicked, status: "generating_hooks" }) === LINKS.admin_url);
    c.ok("awaiting_review: the creative page, as before", S.studioBestLink({ ...unpicked, status: "awaiting_review" }) === LINKS.creative_url);
    c.ok("awaiting_intake: the intake form, as before", S.studioBestLink({ ...unpicked, status: "awaiting_intake" }) === LINKS.intake_url);

    c.head("3 · The desk is told to pick");
    const client = await prisma.client.create({ data: { name: "Pat Options TEST" }, select: { id: true } });
    const job = await prisma.project.create({ data: { clientId: client.id, title: "12 Creek Rd, Media, PA", status: "SCHEDULED" }, select: { id: true } });
    const base = { id: "studio-12", external_id: job.id, links: LINKS };
    await processScriptingEvent("project.hooks_proposed", { ...base, status: "hooks_proposed", hooks: unpicked.hooks } as never);
    const pick = await prisma.smartTask.findUnique({ where: { dedupeKey: `scripting-pick-${job.id}` } });
    c.ok("options proposed: an open 'Pick a script option' task", pick?.status === "OPEN" && /^Pick a script option/.test(pick.title), `${pick?.status} ${pick?.title}`);
    const p1 = await prisma.project.findUniqueOrThrow({ where: { id: job.id }, select: { reelHook: true, scriptingUrl: true, scriptingStatus: true } });
    c.ok("no hook mirrored before the pick", p1.reelHook === null, String(p1.reelHook));
    c.ok("the job's link is the console", p1.scriptingUrl === LINKS.admin_url, String(p1.scriptingUrl));
    await processScriptingEvent("project.script_generated", { ...base, status: "awaiting_review", script_version: { version_number: 1 } } as never);
    const pickAfter = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `scripting-pick-${job.id}` } });
    const ready = await prisma.smartTask.findUnique({ where: { dedupeKey: `scripting-script-${job.id}` } });
    c.ok("the script closes the pick task", pickAfter.status === "COMPLETED");
    c.ok("and opens 'Script ready' in today's words", ready?.status === "OPEN" && /Read it, approve it and send it to the agent/.test(ready.summary ?? ""), ready?.summary ?? "none");
    await processScriptingEvent("project.client_responded", { ...base, status: "sent_to_client", client_response: { type: "revision_requested" } } as never);
    const changes = await prisma.smartTask.findUnique({ where: { dedupeKey: `scripting-client-${job.id}` } });
    c.ok("a revision request is read from its type, not the status", changes?.title.startsWith("Client wants script changes") === true && changes.priority === "HIGH", changes?.title);
    const job2 = await prisma.project.create({ data: { clientId: client.id, title: "40 Mill Ln, Media, PA", status: "SCHEDULED" }, select: { id: true } });
    await processScriptingEvent("project.client_responded", { id: "studio-40", external_id: job2.id, status: "client_revision_requested", client_response: { type: "approved" } } as never);
    const ok2 = await prisma.smartTask.findUnique({ where: { dedupeKey: `scripting-client-${job2.id}` } });
    c.ok("an approval is not read as changes", ok2?.title.startsWith("Client responded on script") === true, ok2?.title);
    await processScriptingEvent("project.hooks_proposed", { ...base, status: "hooks_proposed" } as never);
    await processScriptingEvent("project.sent_to_client", { ...base, status: "sent_to_client" } as never);
    c.ok("a send closes a pick task too", (await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `scripting-pick-${job.id}` } })).status === "COMPLETED");
    c.ok("the hourly task reconciler leaves pick tasks alone", /"scripting-pick-"/.test(fs.readFileSync("src/lib/tasks.ts", "utf8").match(/EXTERNAL_KEY_PREFIXES = \[[^\]]*\]/)?.[0] ?? ""));

    c.ok("nothing left the machine", fence.blocked.length === 0, JSON.stringify(fence.blocked.slice(0, 3)));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
