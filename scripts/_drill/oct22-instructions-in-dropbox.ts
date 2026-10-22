// ---------------------------------------------------------------------------
// DRILL: "Instructions added to Dropbox" (Oct 22 2026, lib/dropboxInstructions).
//
// Jordan: "add a section to the upload portal that says 'instructions added to
// Dropbox' so the editor knows and we know the instructions are added, just in
// Dropbox, then show that instructions file in the hub for the edit
// instructions section." Joe Sutow's two jobs were chased for "the flow and
// vision for the edit" while the instructions sat in their Dropbox folders.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-instructions-in-dropbox.ts
//
// Isolated PGlite; Dropbox answered in-process from an in-memory tree; nothing
// else may leave.
//   1. Pure: which files count as instructions; which read inline.
//   2. The handoff: the file answers the flow and vision (and the intro, as
//      typed instructions always have); the wrap-up is still owed.
//   3. The world: the picker lists the job folder's documents, never footage;
//      a typed path stays inside the job's folder.
//   4. Set: the job stops being chased for instructions, the team thread says
//      so, the editor packet carries the file; the text reads inline.
//   5. Remove: the gap is back.
//   6. Wired: the upload page, its submit gate, the brief card, the route.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7641);
const REPO = path.resolve(__dirname, "../..");

// ---- a Dropbox in memory -----------------------------------------------------------
type Node = { path: string; id: string; tag: "file" | "folder"; body?: string; modified?: string };
const tree = new Map<string, Node>();
let seq = 0;
function folder(p: string) {
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const seg of parts) {
    cur += `/${seg}`;
    if (!tree.has(cur.toLowerCase())) tree.set(cur.toLowerCase(), { path: cur, id: `id:${++seq}`, tag: "folder" });
  }
}
function file(p: string, body = "", modified = "2026-10-21T20:00:00Z") {
  folder(p.slice(0, p.lastIndexOf("/")));
  tree.set(p.toLowerCase(), { path: p, id: `id:${++seq}`, tag: "file", body, modified });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls: string[] = [];
installNextStubs();
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx", expires_in: 14_400 });
  if (url === "https://content.dropboxapi.com/2/files/download") {
    const arg = JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg") ?? "{}") as { path?: string };
    calls.push(`download ${arg.path}`);
    const n = tree.get((arg.path ?? "").toLowerCase());
    return n?.tag === "file" ? new Response(n.body ?? "", { status: 200 }) : json({ error_summary: "path/not_found/" }, 409);
  }
  if (!url.startsWith("https://api.dropboxapi.com/2/")) return null;
  const ep = url.slice("https://api.dropboxapi.com/2/".length);
  const arg = typeof init?.body === "string" ? (JSON.parse(init.body) as { path?: string; recursive?: boolean }) : {};
  calls.push(`${ep} ${arg.path ?? ""}`);
  if (ep === "users/get_current_account") return json({ root_info: { root_namespace_id: "1", home_namespace_id: "1" } });
  if (ep === "files/list_folder") {
    const dir = (arg.path ?? "").toLowerCase();
    if (tree.get(dir)?.tag !== "folder") return json({ error_summary: "path/not_found/..", error: { ".tag": "path" } }, 409);
    const entries = [...tree.values()]
      .filter((n) => n.path.toLowerCase().startsWith(`${dir}/`) && (arg.recursive || !n.path.slice(dir.length + 1).includes("/")))
      .map((n) => ({ ".tag": n.tag, name: n.path.split("/").pop(), path_display: n.path, id: n.id, ...(n.tag === "file" ? { server_modified: n.modified, size: (n.body ?? "").length } : {}) }));
    return json({ entries, has_more: false });
  }
  if (ep === "files/get_temporary_link") return json({ link: `https://dl.dropbox.example/${encodeURIComponent(arg.path ?? "")}` });
  if (ep === "files/get_metadata") {
    const n = tree.get((arg.path ?? "").toLowerCase());
    return n ? json({ ".tag": n.tag, name: n.path.split("/").pop(), path_display: n.path, id: n.id }) : json({ error_summary: "path/not_found/" }, 409);
  }
  return json({ error_summary: "unsupported in drill" }, 400);
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "isolated-oct22-instructions", DROPBOX_APP_KEY: "drill-key", DROPBOX_APP_SECRET: "drill-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const di = await import("@/lib/dropboxInstructions");
    const { handoffReadiness } = await import("@/lib/handoff");

    // =====================================================================
    c.head("1 · Which files are instructions (pure)");
    // =====================================================================
    const f = (p: string) => ({ path: p, name: p.split("/").pop()!, tag: "file" });
    c.ok("a Word document, a PDF, a text file, a Pages file", ["/J/Edit notes.docx", "/J/brief.pdf", "/J/notes.txt", "/J/Vision.pages"].every((p) => di.isInstructionCandidate(f(p))));
    c.ok("a phone photo of written notes counts when it is named like one", di.isInstructionCandidate(f("/J/02-RAW-Video/edit notes.jpg")));
    c.ok("a raw photo or a clip never counts", !di.isInstructionCandidate(f("/J/01-RAW-Photos/DSC0001.jpg")) && !di.isInstructionCandidate(f("/J/02-RAW-Video/C0001.MP4")) && !di.isInstructionCandidate(f("/J/02-RAW-Video/notes.MP4")));
    c.ok("a picture inside an Instructions folder counts; a folder entry never does", di.isInstructionCandidate(f("/J/Instructions/IMG_2201.HEIC")) && !di.isInstructionCandidate({ path: "/J/Instructions", name: "Instructions", tag: "folder" }));
    c.ok("what reads inline on the brief: txt, md, docx, pdf", di.readableInline("a.txt") && di.readableInline("b.docx") && di.readableInline("c.pdf") && !di.readableInline("d.pages") && !di.readableInline("e.jpg"));

    // =====================================================================
    c.head("2 · The handoff: the file answers the instructions");
    // =====================================================================
    const base = {
      titles: ["Standard Reel with Agent Intro"], hasFullVideo: false, debriefSubmittedAt: null, videoSubmittedAt: null,
      videoInstructions: "COLOR PROFILE: iPhone", editorBrief: null, reelScript: null, reelHook: null, scriptConfirmedAt: null, videosFilmed: null, photographerName: "Harrison Wells",
    };
    const before = handoffReadiness(base);
    const after = handoffReadiness({ ...base, instructionsInDropbox: true });
    c.ok("without it: the flow and vision, the intro and the wrap-up are owed", ["instructions", "intro", "debrief"].every((k) => before.gaps.some((g) => g.key === k)), before.gaps.map((g) => g.key).join(","));
    c.ok("with it: the flow and vision and the intro are answered; the wrap-up is still owed", !after.gaps.some((g) => g.key === "instructions" || g.key === "intro") && after.gaps.some((g) => g.key === "debrief"), after.gaps.map((g) => g.key).join(","));

    // =====================================================================
    c.head("3 · The world: Joe's job, its folder");
    // =====================================================================
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("dropbox", "drill-dropbox-refresh-token");
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", active: true } });
    const joe = await prisma.client.create({ data: { name: "Joe Drill" } });
    const J = "/AutoHDR/2026/Q4/October/538 Onward Ave (Joe Drill)";
    const project = await prisma.project.create({
      data: {
        title: "538 Onward Ave, Philadelphia, PA", addressLine: "538 Onward Ave", clientId: joe.id, status: "SHOT", shootDate: new Date("2026-10-21T12:00:00Z"),
        photographerId: harrison.id, dropboxFolder: J, videoInstructions: "COLOR PROFILE: iPhone",
        deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Reel with Agent Intro", videoStyle: "standard_reel_agent_intro" }] },
      },
    });
    for (let i = 1; i <= 6; i++) file(`${J}/01-RAW-Photos/DSC000${i}.ARW`);
    file(`${J}/02-RAW-Video/C0001.MP4`);
    file(`${J}/02-RAW-Video/Edit notes.docx`, "", "2026-10-21T22:10:00Z");
    file(`${J}/instructions.txt`, "Open on the front door push-in.\nAgent intro first, then kitchen, then the yard.", "2026-10-21T22:30:00Z");
    file(`/AutoHDR/2026/Q4/October/Someone Else (X)/notes.txt`, "not this job");
    const listed = await di.listInstructionCandidates(project.id);
    c.ok("the picker lists the job folder's two documents, newest first", listed?.files.map((x) => x.name).join("|") === "instructions.txt|Edit notes.docx", JSON.stringify(listed?.files.map((x) => x.name)));
    c.ok("…with the subfolder each one is in", listed?.files[1].folder === "02-RAW-Video" && listed?.files[0].folder === "(job folder)");
    c.ok("…and no raw photo, no clip, nothing from another job", !listed?.files.some((x) => /ARW|MP4/i.test(x.name) || x.path.includes("Someone Else")));
    const typed = await di.resolveInstructionPath(project.id, "02-RAW-Video/Edit notes.docx");
    c.ok("a typed path inside the job folder resolves to the full path", "path" in typed && typed.path === `${J}/02-RAW-Video/Edit notes.docx` && typed.name === "Edit notes.docx", JSON.stringify(typed));
    const escape = await di.resolveInstructionPath(project.id, "../Someone Else (X)/notes.txt");
    const elsewhere = await di.resolveInstructionPath(project.id, "/AutoHDR/2026/Q4/October/Someone Else (X)/notes.txt");
    c.ok("a path that leaves the job folder is refused", "error" in escape && "error" in elsewhere, `${JSON.stringify(escape)} ${JSON.stringify(elsewhere)}`);

    // =====================================================================
    c.head("4 · Set: nobody is chased for it, the thread and the editor are told");
    // =====================================================================
    const mi = await import("@/lib/missingInstructions");
    const missBefore = await mi.missingInstructionsFor(project.id);
    c.ok("before: the morning-after nudge would ask for the flow and vision", !!missBefore?.video.includes("the flow and vision for the edit"), JSON.stringify(missBefore));
    await di.setDropboxInstructions(project.id, { path: `${J}/instructions.txt`, name: "instructions.txt" }, { name: "Harrison Wells", tmId: harrison.id, key: null });
    const row = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    c.ok("the job records the file, who and when", row.instructionsDropboxPath === `${J}/instructions.txt` && row.instructionsDropboxName === "instructions.txt" && row.instructionsDropboxBy === "Harrison Wells" && !!row.instructionsDropboxAt);
    const missAfter = await mi.missingInstructionsFor(project.id);
    c.ok("after: no flow and vision, no intro asked for; the wrap-up still is", !missAfter?.video.some((w) => /flow and vision|intro script/.test(w)) && !!missAfter?.video.some((w) => /wrap-up/.test(w)), JSON.stringify(missAfter));
    const line = await prisma.projectMessage.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } });
    c.ok("the team thread says so, as Harrison", line?.body === "Instructions are in Dropbox: instructions.txt" && line.authorName === "Harrison Wells" && line.authorId === harrison.id, line?.body);
    const text = await di.instructionText(`${J}/instructions.txt`, "instructions.txt");
    c.ok("the brief reads the text inline", text === "Open on the front door push-in.\nAgent intro first, then kitchen, then the yard.", String(text));
    c.ok("a Pages file is not read inline (Open only)", (await di.instructionText(`${J}/brief.pages`, "brief.pages")) === null);
    const view = di.dropboxInstructionsOf(row);
    c.ok("the view the pages show", view?.name === "instructions.txt" && view.by === "Harrison Wells" && !!view.atISO);

    // =====================================================================
    c.head("5 · Remove: the gap is back");
    // =====================================================================
    await di.clearDropboxInstructions(project.id);
    const cleared = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const missAgain = await mi.missingInstructionsFor(project.id);
    c.ok("cleared, and the flow and vision is owed again", cleared.instructionsDropboxPath === null && cleared.instructionsDropboxBy === null && !!missAgain?.video.includes("the flow and vision for the edit"));

    // =====================================================================
    c.head("6 · Wired");
    // =====================================================================
    const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
    const portal = read("src/components/upload/UploadPortal.tsx");
    const actions = read("src/app/upload/actions.ts");
    c.ok("the upload page's video step shows the section, and the file answers its instructions", /<DropboxInstructions projectId=\{project\.id\} current=\{dropboxInstructions\} \/>/.test(portal) && /hadPriorBrief \|\| !!dropboxInstructions \|\|/.test(portal));
    c.ok("the submit gate takes the file instead of typed instructions", /!prior\.videoInstructions && !instructionsInDropbox\)/.test(actions) && /instructionsDropboxPath: true/.test(actions));
    const section = read("src/components/upload/DropboxInstructions.tsx");
    c.ok("the section's words: the button and the done line", section.includes("Instructions added to Dropbox") && section.includes("Instructions added to Dropbox:</span>") && /min-h-11/.test(section));
    c.ok("the editor brief shows the file with Open", /<DropboxInstructionsFile projectId=\{projectId\} file=\{brief\.instructionsFile\} \/>/.test(read("src/components/editing/EditInstructionsCard.tsx")) && /instructionsFile:/.test(read("src/app/edit/[id]/page.tsx")));
    const route = read("src/app/api/instructions/[projectId]/route.ts");
    c.ok("the route: the brief's own access rule, a temporary link, never a share link", /canViewProject\(projectId, u\)/.test(route) && /dropboxTemporaryLink/.test(route) && !/create_shared_link|sharedLink/i.test(route));
    c.ok("the editor packet prints it", /Instructions in Dropbox: \$\{manifest\.job\.instructionsFile\}/.test(read("src/lib/editorPacket.ts")));
    c.ok("nothing left but Dropbox and its token", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
