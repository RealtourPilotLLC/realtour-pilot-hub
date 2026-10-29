// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Oct 28 2026: PHOTOS AND FILES ON TEAM MESSAGES (Jordan: "allow message
// attachments (files or photos)"). What may be sent (type list, 50 MB, six per
// message), the send-time check against the PRIVATE store (only this login's
// own uploads to this conversation; size and type as the store measured
// them), the one download door (only people who can read the conversation),
// and the upload token route (signs nothing outside the sender's own folder,
// nothing at all without a private store). The store is in memory; the token
// is a fake that only signs locally. Nothing leaves (fenceFetch).
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5646), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct28-message-files-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const files = await import("@/lib/messageFiles");
    const { messageFileRefusal, messageFileType, isMessageImage, opensInline, messageFilePrefix, MESSAGE_FILE_TYPES, MESSAGE_FILE_MAX_BYTES } = files;
    const { acceptMessageFiles, __setMessageFileStoreForTests, NO_FILE_STORE, messageFileViews } = await import("@/lib/messageAttachments");
    const { postTeamChannelMessage } = await import("@/app/projects/teamChannelActions");
    const { postProjectMessage } = await import("@/app/projects/messageActions");
    const { latestChannelMessage } = await import("@/lib/teamChannel");
    const fileRoute = await import("@/app/api/messages/file/[id]/route");
    const uploadRoute = await import("@/app/api/messages/upload/route");
    const { NextRequest } = await import("next/server");

    // ---- an in-memory PRIVATE store ---------------------------------------
    type Stored = { bytes: Uint8Array; contentType: string; size?: number };
    const store = new Map<string, Stored>();
    const memStore = {
      async head(p: string) {
        const f = store.get(p);
        return f ? { pathname: p, url: `https://drillstore.private.blob.vercel-storage.com/${p}`, size: f.size ?? f.bytes.length, contentType: f.contentType } : null;
      },
      async read(p: string) {
        const f = store.get(p);
        return f ? { stream: new Response(f.bytes as BodyInit).body as ReadableStream<Uint8Array>, size: f.bytes.length } : null;
      },
    };
    __setMessageFileStoreForTests(memStore);
    const put = (p: string, contentType: string, text = "drill bytes", size?: number) => { store.set(p, { bytes: new TextEncoder().encode(text), contentType, size }); return p; };

    // ---- the team -----------------------------------------------------------
    const tm = (name: string, email: string, role: "ADMIN" | "EDITOR" | "PHOTOGRAPHER") => prisma.teamMember.create({ data: { name, email, role } });
    const jordanTm = await tm("Jordan Spackman", "jordan-tm-files@example.test", "ADMIN");
    const kimTm = await tm("Kim Miguel", "kim-tm-files@example.test", "EDITOR");
    const johnTm = await tm("John Mark", "john-tm-files@example.test", "EDITOR");
    const harrisonTm = await tm("Harrison Lee", "harrison-tm-files@example.test", "PHOTOGRAPHER");
    const login = (email: string, name: string, role: string, extra: { teamMemberId?: string; editorKey?: string } = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", ...extra } });
    const jordan = await login("jordan-files@example.test", "Jordan Spackman", "OWNER", { teamMemberId: jordanTm.id });
    const kim = await login("kim-files@example.test", "Kim Miguel", "EDITOR", { teamMemberId: kimTm.id, editorKey: "kim" });
    const john = await login("john-files@example.test", "John Mark", "EDITOR", { teamMemberId: johnTm.id, editorKey: "john" });
    const harrison = await login("harrison-files@example.test", "Harrison Lee", "PHOTOGRAPHER", { teamMemberId: harrisonTm.id });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, actingAs });
    const client = await prisma.client.create({ data: { name: "Oct28 Files Client TEST" } });
    const job = await prisma.project.create({ data: { clientId: client.id, title: "44 Elm St, Media PA", addressLine: "44 Elm St", status: "EDITING", editorId: kimTm.id } });
    const TEAM = { kind: "team" } as const;
    const JOB = { kind: "project", projectId: job.id } as const;
    const kimTeam = messageFilePrefix(TEAM, kim.id);
    const kimJob = messageFilePrefix(JOB, kim.id);
    const johnTeam = messageFilePrefix(TEAM, john.id);

    c.head("1 · what may be sent");
    c.ok("SVG and HTML can never be sent (they could run script on the hub's address)", !!messageFileRefusal({ name: "plan.svg", size: 10, type: "image/svg+xml" }) && !!messageFileRefusal({ name: "index.html", size: 10, type: "text/html" }) && !MESSAGE_FILE_TYPES.some((t) => /svg|html|javascript/.test(t)));
    c.ok("the refusal is plain words", messageFileRefusal({ name: "plan.svg", size: 10, type: "image/svg+xml" }) === "plan.svg can't be sent. Photos, PDFs, Word, Excel, PowerPoint, text, zip, short videos and audio can.");
    c.ok("over 50 MB is refused with the sizes", messageFileRefusal({ name: "tour.mov", size: 60 * 1024 * 1024, type: "video/quicktime" }) === "tour.mov is 60 MB. The most one file can be is 50 MB.");
    c.ok("an empty file is refused", messageFileRefusal({ name: "blank.pdf", size: 0, type: "application/pdf" }) === "blank.pdf is empty.");
    c.ok("an iPhone HEIC with no browser type is taken (as a file, not a thumbnail)", messageFileRefusal({ name: "IMG_1234.HEIC", size: 2_000_000, type: "" }) === null && messageFileType("IMG_1234.HEIC", "") === "image/heic" && !isMessageImage("image/heic"));
    c.ok("photos and PDFs open in the tab; a zip downloads", opensInline("image/jpeg") && opensInline("application/pdf") && !opensInline("application/zip"));
    c.ok("the cap is 50 MB", MESSAGE_FILE_MAX_BYTES === 50 * 1024 * 1024);

    c.head("2 · the send-time check (the store decides, not the browser)");
    const porch = put(`${kimTeam}a1/porch-x8f2.jpg`, "image/jpeg", "jpeg bytes");
    const notes = put(`${kimTeam}a2/notes-x8f2.pdf`, "application/pdf", "%PDF-1.4");
    const raw = put(`${kimTeam}a3/raw-x8f2.zip`, "application/zip", "PK..");
    const huge = put(`${kimTeam}a4/tour-x8f2.mov`, "video/quicktime", "mov", 60 * 1024 * 1024);
    const page = put(`${kimTeam}a5/page-x8f2.html`, "text/html", "<script>alert(1)</script>");
    const johns = put(`${johnTeam}j1/porch-x8f2.jpg`, "image/jpeg");
    const ok = await acceptMessageFiles(TEAM, kim.id, [{ pathname: porch, name: "porch.jpg" }]);
    c.ok("Kim's own upload to this conversation is taken, type and size from the store", ok.ok && ok.files[0].contentType === "image/jpeg" && ok.files[0].size === "jpeg bytes".length);
    const refused = async (pending: { pathname: string; name: string }[], re: RegExp, conv: typeof TEAM | typeof JOB = TEAM, user: string | null = kim.id) => {
      const r = await acceptMessageFiles(conv, user, pending);
      return !r.ok && re.test(r.message) ? true : `${r.ok ? "accepted" : r.message}`;
    };
    const check = (label: string, r: true | string) => c.ok(label, r === true, r === true ? "" : r);
    check("someone else's upload is refused", await refused([{ pathname: johns, name: "porch.jpg" }], /wasn't uploaded to this conversation/));
    check("a file uploaded to another conversation is refused", await refused([{ pathname: porch, name: "porch.jpg" }], /wasn't uploaded to this conversation/, JOB));
    check("a path that climbs out of the folder is refused", await refused([{ pathname: `${kimTeam}../../${johnTeam}j1/porch-x8f2.jpg`, name: "porch.jpg" }], /wasn't uploaded/));
    check("a file that never landed is refused", await refused([{ pathname: `${kimTeam}zz/missing.jpg`, name: "missing.jpg" }], /didn't finish uploading/));
    check("over 50 MB in the store is refused, whatever the browser said", await refused([{ pathname: huge, name: "tour.mov" }], /The most one file can be is 50 MB/));
    check("an HTML file that slipped into the store is refused", await refused([{ pathname: page, name: "page.html" }], /can't be sent/));
    check("seven files on one message are refused", await refused(Array.from({ length: 7 }, (_, i) => ({ pathname: `${kimTeam}n${i}/p.jpg`, name: `p${i}.jpg` })), /Send up to 6 files/));
    check("signed out, nothing is taken", await refused([{ pathname: porch, name: "porch.jpg" }], /Sign in/, TEAM, null));
    __setMessageFileStoreForTests(null);
    check("no private store connected: refused in plain words, nothing public", await refused([{ pathname: porch, name: "porch.jpg" }], new RegExp(NO_FILE_STORE.slice(0, 30))));
    __setMessageFileStoreForTests(memStore);

    c.head("3 · posting files");
    await signIn(kim);
    const before = await prisma.teamChannelMessage.count();
    const post = await postTeamChannelMessage("", [], null, { files: [{ pathname: porch, name: "porch.jpg" }, { pathname: notes, name: "notes.pdf" }, { pathname: raw, name: "raw.zip" }] });
    const channelMsg = await prisma.teamChannelMessage.findFirstOrThrow({ orderBy: { createdAt: "desc" }, include: { attachments: true } });
    c.ok("files alone (no words) post to the channel", post.ok && channelMsg.body === "" && channelMsg.attachments.length === 3, post.message);
    c.ok("each file row: the team conversation, the uploader, the store's type and size", channelMsg.attachments.every((a) => a.conversation === "team" && a.uploadedByUserId === kim.id && a.pathname.startsWith(kimTeam) && a.size > 0));
    c.ok("the list row says what was sent", (await latestChannelMessage())?.body === "Sent 3 files");
    const sneaky = await postTeamChannelMessage("look", [], null, { files: [{ pathname: johns, name: "porch.jpg" }] });
    c.ok("posting someone else's upload is refused and nothing is saved", !sneaky.ok && (await prisma.teamChannelMessage.count()) === before + 1);
    const crack = put(`${kimJob}b1/crack-x8f2.jpg`, "image/jpeg", "crack jpeg");
    const invoice = put(`${kimJob}b2/invoice-x8f2.pdf`, "application/pdf", "%PDF-invoice");
    const jobPost = await postProjectMessage(job.id, null, "Crack in the drywall, see photo", [], null, { files: [{ pathname: crack, name: "crack.jpg" }, { pathname: invoice, name: "invoice $450.pdf" }] });
    const jobMsg = await prisma.projectMessage.findFirstOrThrow({ where: { projectId: job.id }, orderBy: { createdAt: "desc" }, include: { attachments: true } });
    c.ok("a job thread takes files too, filed under that job", jobPost.ok && jobMsg.attachments.length === 2 && jobMsg.attachments.every((a) => a.conversation === `project:${job.id}`), jobPost.message);
    const wrongConv = await postProjectMessage(job.id, null, "wrong folder", [], null, { files: [{ pathname: porch, name: "porch.jpg" }] });
    c.ok("a channel upload can't ride a job message", !wrongConv.ok);
    __setMessageFileStoreForTests(null);
    const noStore = await postTeamChannelMessage("with a file", [], null, { files: [{ pathname: porch, name: "porch.jpg" }] });
    const wordsOnly = await postTeamChannelMessage("Words still send without a store.");
    c.ok("no store: a file is refused with the plain reason, words still send", !noStore.ok && noStore.message === NO_FILE_STORE && wordsOnly.ok);
    __setMessageFileStoreForTests(memStore);
    const views = await messageFileViews({ projectMessageIds: [jobMsg.id] }, { money: false });
    const ownerViews = await messageFileViews({ projectMessageIds: [jobMsg.id] }, { money: true });
    c.ok("a file name with money in it is scrubbed for people who don't see money", views.get(jobMsg.id)?.some((f) => f.name.includes("[amount]")) === true && ownerViews.get(jobMsg.id)?.some((f) => f.name === "invoice $450.pdf") === true);
    c.ok("a file's address is the hub's own door, never the store's", [...views.values()].flat().every((f) => f.href.startsWith("/api/messages/file/") && !f.href.includes("blob")));

    c.head("4 · the download door: only people in the conversation");
    const porchRow = channelMsg.attachments.find((a) => a.name === "porch.jpg")!;
    const notesRow = channelMsg.attachments.find((a) => a.name === "notes.pdf")!;
    const zipRow = channelMsg.attachments.find((a) => a.name === "raw.zip")!;
    const crackRow = jobMsg.attachments.find((a) => a.name === "crack.jpg")!;
    const fetchFile = (id: string, q = "") => fileRoute.GET(new NextRequest(`https://hub.invalid/api/messages/file/${id}${q}`), { params: Promise.resolve({ id }) });
    await clearSession();
    c.ok("signed out: 401", (await fetchFile(porchRow.id)).status === 401);
    await signIn(kim);
    const kimCrack = await fetchFile(crackRow.id);
    c.ok("Kim (on the job) opens the job's photo, the right bytes", kimCrack.status === 200 && (await kimCrack.text()) === "crack jpeg" && kimCrack.headers.get("content-type") === "image/jpeg");
    c.ok("served private, no-store, nosniff, shown in the tab", kimCrack.headers.get("cache-control") === "private, no-store" && kimCrack.headers.get("x-content-type-options") === "nosniff" && /^inline;/.test(kimCrack.headers.get("content-disposition") ?? ""));
    c.ok("?download=1 downloads a photo under its own name", /^attachment; filename="crack.jpg"/.test((await fetchFile(crackRow.id, "?download=1")).headers.get("content-disposition") ?? ""));
    c.ok("a PDF opens in the tab; a zip downloads", /^inline;/.test((await fetchFile(notesRow.id)).headers.get("content-disposition") ?? "") && /^attachment;/.test((await fetchFile(zipRow.id)).headers.get("content-disposition") ?? ""));
    await signIn(john);
    const johnJob = await fetchFile(crackRow.id);
    c.ok("John (an editor not on this job): 403 on the job's file", johnJob.status === 403 && /Only the people in this conversation/.test(JSON.stringify(await johnJob.json())));
    c.ok("John opens the team channel's file", (await fetchFile(porchRow.id)).status === 200);
    await signIn(harrison);
    c.ok("Harrison (photographer, not his shoot): 403 on the job's file, 200 on the channel's", (await fetchFile(crackRow.id)).status === 403 && (await fetchFile(porchRow.id)).status === 200);
    await prisma.project.update({ where: { id: job.id }, data: { photographerId: harrisonTm.id } });
    c.ok("once it is his shoot, Harrison can open it", (await fetchFile(crackRow.id)).status === 200);
    await prisma.project.update({ where: { id: job.id }, data: { photographerId: null } });
    await signIn(jordan, john.id);
    c.ok("a 'view as John' preview reads as John: 403", (await fetchFile(crackRow.id)).status === 403);
    await signIn(jordan);
    c.ok("an unknown or malformed id: 404", (await fetchFile("cknotarealattachment01")).status === 404 && (await fetchFile("../../etc")).status === 404);
    store.delete(zipRow.pathname);
    c.ok("a file gone from the store: 404, not a crash", (await fetchFile(zipRow.id)).status === 404);
    __setMessageFileStoreForTests(null);
    c.ok("no private store on this server: 503", (await fetchFile(porchRow.id)).status === 503);
    __setMessageFileStoreForTests(memStore);

    c.head("5 · the upload token route");
    const tokenFor = (pathname: string, conversation: string) => uploadRoute.POST(new NextRequest("https://hub.invalid/api/messages/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, clientPayload: JSON.stringify({ conversation }), multipart: false } }),
    }));
    const realToken = process.env.MESSAGE_FILES_BLOB_TOKEN;
    const realCutToken = process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN;
    delete process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN;
    try {
      delete process.env.MESSAGE_FILES_BLOB_TOKEN;
      await signIn(kim);
      const none = await tokenFor(`${kimTeam}t0/porch.jpg`, "team");
      c.ok("no private store token: nothing is signed", none.status === 400 && (await none.json()).error === NO_FILE_STORE);
      process.env.MESSAGE_FILES_BLOB_TOKEN = "vercel_blob_rw_drillstore0001_notarealsecretjustforthedrill";
      const good = await tokenFor(`${kimTeam}t1/porch.jpg`, "team");
      const goodBody = (await good.json()) as { clientToken?: string };
      c.ok("Kim, her own folder in the team channel: a token", good.status === 200 && typeof goodBody.clientToken === "string" && goodBody.clientToken.startsWith("vercel_blob_client_"), JSON.stringify(goodBody).slice(0, 120));
      let terms: { maximumSizeInBytes?: number; allowedContentTypes?: string[]; pathname?: string } = {};
      try {
        const packed = Buffer.from(goodBody.clientToken!.split("_").slice(4).join("_"), "base64").toString("utf8");
        terms = JSON.parse(Buffer.from(packed.slice(packed.indexOf(".") + 1), "base64").toString("utf8"));
      } catch { /* checked below */ }
      c.ok("the token carries the cap, the type list and that one path", terms.maximumSizeInBytes === MESSAGE_FILE_MAX_BYTES && !!terms.allowedContentTypes?.includes("image/jpeg") && !terms.allowedContentTypes?.some((t) => /svg|html/.test(t)) && terms.pathname === `${kimTeam}t1/porch.jpg`, JSON.stringify(terms).slice(0, 160));
      const other = await tokenFor(`${johnTeam}t2/porch.jpg`, "team");
      c.ok("someone else's folder: refused", other.status === 400 && /doesn't belong to you/.test((await other.json()).error));
      const climb = await tokenFor(`${kimTeam}../${johnTeam}t2/porch.jpg`, "team");
      c.ok("climbing out of the folder: refused", climb.status === 400);
      await signIn(john);
      const johnJobToken = await tokenFor(`${messageFilePrefix(JOB, john.id)}t3/porch.jpg`, `project:${job.id}`);
      c.ok("John, a job thread he can't read: refused", johnJobToken.status === 400 && /conversations you are in/.test((await johnJobToken.json()).error));
      await signIn(jordan, kim.id);
      const preview = await tokenFor(`${kimTeam}t4/porch.jpg`, "team");
      c.ok("a 'view as' preview: refused", preview.status === 400 && /previewing/.test((await preview.json()).error));
      await clearSession();
      const out = await tokenFor(`${kimTeam}t5/porch.jpg`, "team");
      c.ok("signed out: refused", out.status === 400 && /Sign in/.test((await out.json()).error));
    } finally {
      if (realToken === undefined) delete process.env.MESSAGE_FILES_BLOB_TOKEN; else process.env.MESSAGE_FILES_BLOB_TOKEN = realToken;
      if (realCutToken !== undefined) process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN = realCutToken;
    }

    c.head("6 · private only, in the source");
    const REPO = path.resolve(__dirname, "..", "..");
    const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
    const board = src("src/components/project/ProjectMessages.tsx");
    c.ok("the composer uploads with access \"private\", never public", board.includes('access: "private"') && !board.includes('access: "public"'));
    const code = (f: string) => src(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    c.ok("no Dropbox in the message-file code (only the comment saying never)", !/dropbox/i.test(code("src/lib/messageAttachments.ts") + code("src/app/api/messages/upload/route.ts") + code("src/app/api/messages/file/[id]/route.ts") + code("src/components/project/ProjectMessages.tsx")));
    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
