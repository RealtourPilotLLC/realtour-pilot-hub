// ---------------------------------------------------------------------------
// DRILL: CP-06 — account setup, the structured Brand Profile, explicit
// clearing, the team page's data, and the editor alert + brief banner + Kyle
// confirmation task (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp06-brand-setup.ts
//
// What it proves, the OLD behaviour first wherever it can be observed (the
// OLD portal actions and upload route are loaded for real from HEAD, their
// `@/` imports pointed at this tree):
//   0. OLD — clearing a field alone is refused ("Nothing to save."); a mixed
//      save says "Saved" while keeping what the client removed; a portal
//      upload reaches Dropbox and no registry row; a held teammate is gone
//      from the team list the moment it is saved; the prefill came back.
//   1. The setup checklist is derived, skippable, and a skip is never "done".
//   2. A save writes the columns and slots, one history row per field, and the
//      checklist moves.
//   3. The alert: Kyle's task and the brief banner always; the editor's DM
//      only with brand_change_alerts ON — at most one per client per hour —
//      and the changes held while it was off are caught up once.
//   4. Uploads: typed, registered, the path Dropbox actually wrote, Replace =
//      a new version of the client's OWN asset; a forged id never uploads.
//   5-6. Clearing is real (NULL vs ""), and a mixed save reports both halves.
//   7. Nothing of anyone else's changes; staff-owned notes are untouched.
//   8. Permissions: collaborator / paused refused; the link seat allowed.
//   9. The brief reads the registry; "Got it" closes Kyle's task; Kyle
//      closing it by hand clears the banner too.
//  10. A TEST client writes ledger rows only.
//  11. No job → the personal-branding route (Kim); no program → "no editor".
//  12-13. The team: a real client's invitation is HELD, listed and
//      cancellable; a TEST client's seat defaults to full access; the
//      last-owner / self / cross-client stops hold.
//  14. The hourly sweep alerts a stranded row exactly once.
//  15. A staff edit on the Brand tab is recorded and alerted the same way.
//  16. The real hourly cron runs the brandChangeAlerts step.
//
// ISOLATION: PGlite on 127.0.0.1:5511 via the shared harness; production is
// never opened. Slack and Dropbox are answered by fakes at the fetch fence;
// every other outbound call is blocked and counted.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors, interceptModule } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5511);
const REPO = path.resolve(__dirname, "../..");
const BASE = "HEAD";

installNextStubs();

// THE SIGNED-IN CLIENT. resolvePortalViewer reads its cookie through a DYNAMIC
// `import("next/headers")`, which does not pass through the module loader the
// harness stubs — so outside a request it finds no cookie at all. The actions
// are driven as a real signed-in person by handing the resolver this jar
// whenever the caller passed none (a route handler passes req.cookies and is
// unaffected). The OLD copies of the actions import the same module by its
// absolute path, so they get the same jar.
const jar = new Map<string, string>();
interceptModule(
  (r) => r === "@/lib/portal" || /[\\/]src[\\/]lib[\\/]portal$/.test(r),
  (loaded) => {
    const m = loaded as { resolvePortalViewer: (i: { token?: string | null; enrollmentId?: string | null; cookies?: unknown }) => Promise<unknown> };
    return { ...m, resolvePortalViewer: (i: Parameters<typeof m.resolvePortalViewer>[0]) => m.resolvePortalViewer({ ...i, cookies: i.cookies ?? { get: (n: string) => jar.get(n) } }) };
  },
);

// ---- provider fakes at the fence ------------------------------------------
type SlackPost = { channel: string; text: string };
const slackPosts: SlackPost[] = [];
const dbxUploads: string[] = [];
const dbxFiles = new Set<string>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url.startsWith("https://slack.com/api/")) {
    const method = url.slice("https://slack.com/api/".length);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { channel?: string; text?: string }) : {};
    if (method === "chat.postMessage") { slackPosts.push({ channel: body.channel ?? "?", text: body.text ?? "" }); return json({ ok: true }); }
    if (method === "conversations.list") return json({ ok: true, channels: [] });
    return json({ ok: false, error: `drill: unstubbed slack ${method}` });
  }
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dbx-token" });
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const ep = url.slice("https://api.dropboxapi.com/2/".length);
    const arg = typeof init?.body === "string" ? (JSON.parse(init.body) as { path?: string }) : {};
    if (ep === "users/get_current_account") return json({});
    if (ep === "files/create_folder_v2") return json({ metadata: { path_display: arg.path } });
    if (ep === "files/get_temporary_link") return json({ link: `https://dl.drill.invalid${arg.path ?? ""}` });
    if (ep === "files/list_folder") {
      const dir = (arg.path ?? "").toLowerCase();
      const entries = [...dbxFiles].filter((f) => f.toLowerCase().startsWith(`${dir}/`)).map((f) => ({ ".tag": "file", name: f.slice(f.lastIndexOf("/") + 1), path_display: f }));
      return json({ entries, has_more: false });
    }
    return json({ error_summary: `drill: unstubbed dropbox ${ep}` }, 400);
  }
  if (url === "https://content.dropboxapi.com/2/files/upload") {
    const h = new Headers(init?.headers);
    const arg = JSON.parse(h.get("Dropbox-API-Arg") ?? "{}") as { path: string; autorename?: boolean };
    let p = arg.path;
    // autorename, the way Dropbox does it: "logo.png" → "logo (1).png"
    for (let n = 1; dbxFiles.has(p) && arg.autorename; n++) p = arg.path.replace(/(\.[^./]+)?$/, (ext) => ` (${n})${ext ?? ""}`);
    dbxFiles.add(p);
    dbxUploads.push(p);
    return json({ path_display: p });
  }
  return null;
});

/** OLD modules, byte for byte from BASE, their `@/` imports aimed at this tree. */
function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp06-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const actions = path.join(dir, "portalActions.base.ts");
  fs.writeFileSync(actions, point(show("src/app/portal/actions.ts")));
  const upload = path.join(dir, "uploadRoute.base.ts");
  fs.writeFileSync(upload, point(show("src/app/api/portal/upload/route.ts")));
  const page = show("src/components/portal/PortalPage.tsx");
  return { dir, actions, upload, page };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { DROPBOX_APP_KEY: "drill-app-key", DROPBOX_APP_SECRET: "drill-app-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const bp = await import("@/lib/brandProfile");
  const setup = await import("@/lib/portalSetup");
  const team = await import("@/lib/portalTeam");
  const { grantProgramAccess, cancelOwedAccess } = await import("@/lib/portalAccess");
  const { resolvePortalViewer } = await import("@/lib/portal");
  const { signClientSession, CLIENT_COOKIE } = await import("@/lib/auth/clientSession");
  const { NextRequest } = await import("next/server");
  const uploadRoute = await import("@/app/api/portal/upload/route");
  const newActions = await import("@/app/portal/actions");
  const brandAck = await import("@/app/edit/[id]/brand.actions");
  const ws = await import("@/app/content/[id]/workspaceActions");
  const base = writeBaseCopies();
  type PortalViewer = import("@/lib/portal").PortalViewer;
  type Auth = { token?: string | null; enrollmentId?: string | null };
  type R = { ok: boolean; message: string };
  const old = (await import(base.actions)) as {
    portalSaveProfile: (a: Auth, i: { brandColors?: string; videoStyle?: string; preferences?: string }) => Promise<R>;
    portalInviteTeammate: (a: Auth, i: { name: string; email: string; role?: string }) => Promise<R & { held?: boolean }>;
    portalTeamMembers: (a: Auth) => Promise<{ ok: boolean; seats: { email: string }[] }>;
  };
  /** The OLD page's rule, as it read: `if (!prefill.videoStyle) prefill.videoStyle = extracted` — '' is falsy. */
  const oldPrefill = (stored: string, suggested: string) => (stored ? stored : suggested);
  const oldUpload = (await import(base.upload)) as { POST: (req: InstanceType<typeof NextRequest>) => Promise<Response> };

  await saveSecret("slack", "xoxb-drill-not-a-real-token");
  await saveSecret("dropbox", "drill-refresh-not-a-real-token");
  const kim = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim-drill@example.com", role: "EDITOR", slackId: "U-KIM" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com", role: "MANAGER" } });
  // Kim has a hub login, so no "send her a login" nudge lands on Jordan's desk mid-drill.
  await prisma.appUser.create({ data: { email: "kim-drill@example.com", name: "Kim", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
  const setSwitch = (key: string, enabled: boolean) =>
    prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date() }, update: { enabled } });
  const signIn = async (clientUserId: string, email: string) => { jar.set(CLIENT_COOKIE, await signClientSession({ cu: clientUserId, email })); };
  const signOut = () => { jar.delete(CLIENT_COOKIE); };

  /** A real (non-TEST) client on the program, with an owner seat and a link. */
  async function realClient(name: string, opts: { project?: boolean; enrolled?: boolean; ownerEmail?: string } = {}) {
    const client = await prisma.client.create({ data: { name, socialClient: true }, select: { id: true } });
    const token = `tok${Math.random().toString(36).slice(2)}${"x".repeat(24)}`;
    const e = opts.enrolled === false ? null : await prisma.contentEnrollment.create({
      data: { clientId: client.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, portalToken: token, portalTokenIssuedAt: new Date() },
      select: { id: true },
    });
    let projectId: string | null = null;
    if (opts.project !== false) {
      const p = await prisma.project.create({ data: { clientId: client.id, title: `${name} — October content`, status: "EDITING" }, select: { id: true } });
      projectId = p.id;
      await prisma.smartTask.create({ data: { taskType: "edit_video", title: `Edit ${name}`, assignedKey: "kim", projectId: p.id, clientId: client.id, status: "OPEN" } });
    }
    let viewer: PortalViewer | null = null, token_: PortalViewer | null = null, ownerId: string | null = null;
    if (e) {
      const email = opts.ownerEmail ?? `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;
      const person = await prisma.clientUser.create({ data: { email, name, status: "ACTIVE" }, select: { id: true } });
      const seat = await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: e.id, clientId: client.id, role: "OWNER", acceptedAt: new Date() }, select: { id: true } });
      ownerId = person.id;
      const enrollment = { id: e.id, clientId: client.id, clientName: name, status: "ACTIVE", videosPerMonth: 4, sessionsPerMonth: 1 };
      viewer = { enrollment, actor: { kind: "CLIENT", clientUserId: person.id, email, name, membershipId: seat.id, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" };
      token_ = { enrollment, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" };
    }
    return { clientId: client.id, enrollmentId: e?.id ?? null, projectId, token, viewer: viewer!, tokenViewer: token_!, ownerId: ownerId!, name };
  }
  const changesOf = (clientId: string) => prisma.clientBrandChange.findMany({ where: { clientId }, orderBy: { createdAt: "asc" } });
  const kyleTasks = (clientId: string) => prisma.smartTask.findMany({ where: { assignedKey: "kyle", dedupeKey: { startsWith: `brand-ack:${clientId}:` } } });
  const upload = async (auth: { token: string }, file: { name: string; body?: string }, fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("token", auth.token);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("file", new File([file.body ?? "PNGDATA"], file.name, { type: "image/png" }));
    return new NextRequest("http://127.0.0.1/api/portal/upload", { method: "POST", body: form });
  };

  // =========================================================================
  c.head("0 · OLD (HEAD): clearing refused, a mixed save lied, uploads unrecorded, held teammates vanished");
  // =========================================================================
  {
    const o = await realClient("Olive Oldham");
    const auth = { token: o.token };
    const set = await old.portalSaveProfile(auth, { brandColors: "#abcdef" });
    c.ok("OLD: setting a colour works", set.ok, set.message);
    const clearOnly = await old.portalSaveProfile(auth, { brandColors: "" });
    c.ok("OLD: clearing the colours alone is refused — 'Nothing to save.'", !clearOnly.ok && clearOnly.message === "Nothing to save.", clearOnly.message);
    const mixed = await old.portalSaveProfile(auth, { brandColors: "", preferences: "Text me first" });
    const after = await prisma.client.findUnique({ where: { id: o.clientId }, select: { brandColors: true, portalPreferences: true } });
    c.ok("OLD: a mixed save says 'Saved…'", mixed.ok && /^Saved/.test(mixed.message), mixed.message);
    c.ok("  …while the colour the client removed is still on file", after?.brandColors === "#abcdef" && after.portalPreferences === "Text me first", JSON.stringify(after));
    c.ok("OLD: the page's prefill tested truthiness — a cleared '' came back as the suggestion", /if \(!prefill\.videoStyle\)/.test(base.page) && oldPrefill("", "AI read") === "AI read");
    const before = dbxUploads.length;
    const res = await oldUpload.POST(await upload(auth, { name: "old-logo.png" }));
    const bodyOld = (await res.json()) as { ok: boolean };
    c.ok("OLD: an upload reached Dropbox", bodyOld.ok && dbxUploads.length === before + 1, dbxUploads.at(-1));
    c.ok("  …and nothing else: zero ClientAsset rows for the client", (await prisma.clientAsset.count({ where: { clientId: o.clientId } })) === 0);
    await signIn(o.ownerId, `${"olive.oldham"}@example.com`);
    const inv = await old.portalInviteTeammate({ enrollmentId: o.enrollmentId }, { name: "Pat Helper", email: "pat.helper@example.com" });
    const listed = await old.portalTeamMembers({ enrollmentId: o.enrollmentId });
    c.ok("OLD: a real client's invitation is HELD", inv.ok && inv.held === true, inv.message);
    c.ok("  …and the team list does not show it (it vanished on reload, and could not be revoked)", listed.ok && !listed.seats.some((s) => s.email === "pat.helper@example.com"), listed.seats.map((s) => s.email).join(","));
    const nowList = await newActions.portalTeamMembers({ enrollmentId: o.enrollmentId });
    c.ok("NEW: the same action lists it as held", nowList.ok && nowList.seats.some((s) => s.email === "pat.helper@example.com" && s.held), nowList.seats.map((s) => `${s.email}${s.held ? "(held)" : ""}`).join(","));
    signOut();
  }

  // ---- the world the rest shares ------------------------------------------
  const N = await realClient("Nadia Okafor");
  const other = await prisma.client.create({ data: { name: "Other Agent", brandColors: "#000000", editingPreferences: "their note", generalNotes: "their general" }, select: { id: true } });
  await prisma.client.update({ where: { id: N.clientId }, data: { editingPreferences: "STAFF: keep cuts under 60s", clientPreferences: "STAFF: prefers mornings", generalNotes: "STAFF: VIP" } });
  await prisma.agentProfile.create({ data: { clientId: N.clientId, brandJson: JSON.stringify({ colors: "#ff0000" }) } });
  const collab = await prisma.clientUser.create({ data: { email: "cora.collab@example.com", name: "Cora Collab", status: "ACTIVE" }, select: { id: true } });
  const collabSeat = await prisma.clientMembership.create({ data: { clientUserId: collab.id, enrollmentId: N.enrollmentId!, clientId: N.clientId, role: "COLLABORATOR", acceptedAt: new Date() }, select: { id: true } });
  const collabV: PortalViewer = { ...N.viewer, actor: { kind: "CLIENT", clientUserId: collab.id, email: "cora.collab@example.com", name: "Cora Collab", membershipId: collabSeat.id, membershipRole: "COLLABORATOR" } };
  const pausedV: PortalViewer = { ...N.viewer, enrollment: { ...N.viewer.enrollment, status: "PAUSED" }, access: "READ_ONLY" };

  // =========================================================================
  c.head("1 · the setup checklist is derived, skippable, and a skip is never 'done'");
  // =========================================================================
  {
    const s0 = await setup.setupChecklist(N.viewer);
    c.ok("a new account: 0 of 7 done, not complete", s0.done === 0 && s0.total === 7 && !s0.complete, `${s0.done}/${s0.total}`);
    c.ok("the owner sees the optional team item; it never counts toward the total", s0.items.some((i) => i.key === "team" && i.optional) && s0.total === 7);
    const cs = await setup.setupChecklist(collabV);
    c.ok("a collaborator does not get the team item", !cs.items.some((i) => i.key === "team"));
    const sk = await setup.skipSetupItem(N.viewer, "logo", true);
    const s1 = await setup.setupChecklist(N.viewer);
    const logo = s1.items.find((i) => i.key === "logo");
    c.ok("skip logo → skipped, still not done, count unchanged", sk.ok && !!logo?.skippedAtISO && !logo.done && s1.done === 0 && s1.total === 7 && s1.skipped === 1, JSON.stringify(logo));
    c.ok("a collaborator may not skip (brand profile is the owner's)", !(await setup.skipSetupItem(collabV, "music", true)).ok);
    c.ok("an unknown step is refused", !(await setup.skipSetupItem(N.viewer, "tax_id", true)).ok);
  }

  // =========================================================================
  c.head("2 · a save writes columns + slots, one history row each, the checklist moves");
  // =========================================================================
  {
    const r = await bp.saveClientBrandProfile(N.viewer, { brandColors: "#112233", slots: { music: "Upbeat acoustic", website: "https://nadia.example", fonts: "Montserrat" } });
    const client = await prisma.client.findUnique({ where: { id: N.clientId }, select: { brandColors: true } });
    c.ok("saved; brandColors on file", r.ok && client?.brandColors === "#112233", r.message);
    const slots = await prisma.clientAsset.findMany({ where: { clientId: N.clientId, profileKey: { not: null } }, select: { id: true, profileKey: true, type: true } });
    c.ok("3 slot assets: music / website / fonts", slots.length === 3 && ["fonts", "music", "website"].every((k) => slots.some((s) => s.profileKey === k)), slots.map((s) => `${s.profileKey}:${s.type}`).join(","));
    const v1 = await prisma.clientAssetVersion.findMany({ where: { assetId: { in: slots.map((s) => s.id) } } });
    c.ok("each is v1, source client_portal, the person on it", v1.length === 3 && v1.every((v) => v.versionNo === 1 && v.source === "client_portal" && v.uploadedByClientUserId === N.ownerId), v1.map((v) => `${v.versionNo}/${v.source}/${v.uploadedByClientUserId === N.ownerId}`).join(","));
    const ch = await changesOf(N.clientId);
    c.ok("4 ClientBrandChange rows (colours + 3 slots), source client_portal, attributed", ch.length === 4 && ch.every((x) => x.source === "client_portal" && x.clientUserId === N.ownerId), ch.map((x) => `${x.fieldKey}:${x.kind}`).join(","));
    const s = await setup.setupChecklist(N.viewer);
    c.ok("checklist: 4 of 7 (colors, fonts, links, music)", s.done === 4 && ["colors", "fonts", "links", "music"].every((k) => s.items.find((i) => i.key === k)?.done), `${s.done}/${s.total}`);
    const again = await bp.saveClientBrandProfile(N.viewer, { brandColors: "#112233", slots: { music: "Upbeat  acoustic " } });
    c.ok("saving the same values again records nothing", again.ok && again.changeIds.length === 0 && (await changesOf(N.clientId)).length === 4, again.message);
  }

  // =========================================================================
  c.head("3 · the alert: Kyle's task + banner always; the editor's DM only with the switch ON");
  // =========================================================================
  {
    const rows = await changesOf(N.clientId);
    c.ok("switch OFF: every row alerted, channel 'pending', editor 'kim'", rows.every((r) => r.alertedAt && r.alertChannel === "pending" && r.alertEditorKeys === "kim"), rows.map((r) => r.alertChannel).join(","));
    c.ok("switch OFF: zero Slack posts, zero editor bell rows", slackPosts.length === 0 && (await prisma.notification.count({ where: { kind: "brand_updated" } })) === 0, `${slackPosts.length}`);
    const tasks = await kyleTasks(N.clientId);
    c.ok("one OPEN Kyle task, dedupe brand-ack:<client>:", tasks.length === 1 && tasks[0].status === "OPEN" && rows.every((r) => r.taskId === tasks[0].id), tasks.map((t) => t.title).join(" | "));
    c.ok("  …it names Kim, lists the changes, and says she has NOT been messaged", /Kim/.test(tasks[0].title) && /Music: “Upbeat acoustic”/.test(tasks[0].description ?? "") && /have NOT been messaged/.test(tasks[0].description ?? ""), (tasks[0].description ?? "").slice(0, 200));
    const pend = await bp.pendingBrandChanges(N.clientId);
    c.ok("the brief banner has all four", pend.length === 4, pend.map((p) => p.line).join(" | "));

    await setSwitch("brand_change_alerts", true);
    const sw = await bp.sweepBrandChangeAlerts();
    const dms = slackPosts.filter((p) => p.channel === "U-KIM");
    c.ok("switch ON → the hourly sweep catches up: exactly one DM to Kim", sw.caughtUp === 4 && dms.length === 1, `${JSON.stringify(sw)} · ${dms.length} DMs`);
    c.ok("  …it says 'Brand updated' and names the music change", /Brand updated/.test(dms[0]?.text ?? "") && /Music/.test(dms[0]?.text ?? ""), dms[0]?.text.slice(0, 160));
    const leg = await prisma.notificationDelivery.findFirst({ where: { teamMemberId: kim.id, channel: "slack", kind: "brand_updated" } });
    c.ok("NotificationDelivery slack/sent for Kim", leg?.status === "sent", leg?.status);
    c.ok("the rows now say slack", (await changesOf(N.clientId)).every((r) => r.alertChannel === "slack"));
    const sw2 = await bp.sweepBrandChangeAlerts();
    c.ok("a second sweep sends nothing", sw2.caughtUp === 0 && slackPosts.filter((p) => p.channel === "U-KIM").length === 1, JSON.stringify(sw2));

    const r2 = await bp.saveClientBrandProfile(N.viewer, { slots: { music: "Calm piano" } });
    const last = (await changesOf(N.clientId)).at(-1)!;
    c.ok("a second save in the same ET hour: no new DM", r2.ok && slackPosts.filter((p) => p.channel === "U-KIM").length === 1, `${slackPosts.filter((p) => p.channel === "U-KIM").length}`);
    c.ok("  …its row says the hour's message covered it", last.alertChannel === "deduped", last.alertChannel ?? "");
    const t2 = await kyleTasks(N.clientId);
    c.ok("still ONE open Kyle task, now listing both music changes", t2.length === 1 && /Upbeat acoustic/.test(t2[0].description ?? "") && /Calm piano/.test(t2[0].description ?? ""), (t2[0].description ?? "").slice(-160));
    const music = await prisma.clientAsset.findFirst({ where: { clientId: N.clientId, profileKey: "music" } });
    const mv = await prisma.clientAssetVersion.findMany({ where: { assetId: music!.id }, orderBy: { versionNo: "asc" } });
    c.ok("music v2 active, v1 intact", mv.length === 2 && music?.activeVersionId === mv[1].id && mv[0].valueText === "Upbeat acoustic" && mv[1].valueText === "Calm piano");
  }

  // =========================================================================
  c.head("4 · uploads: typed, registered, the path Dropbox wrote; Replace versions the client's OWN file");
  // =========================================================================
  let logoAssetId = "";
  {
    const r = await bp.recordPortalAssetUpload(N.viewer, { kind: "LOGO", fileName: "logo.png", path: "/Clients/Nadia Okafor/logo.png" });
    const a = await prisma.clientAsset.findUnique({ where: { id: r.assetId! } });
    c.ok("recordPortalAssetUpload(LOGO) → a LOGO asset v1", r.ok && a?.type === "LOGO" && a.ownership === "CLIENT", r.message);
    const s = await setup.setupChecklist(N.viewer);
    c.ok("the logo item is done despite the earlier skip", s.items.find((i) => i.key === "logo")?.done === true && s.items.find((i) => i.key === "logo")?.skippedAtISO === null);

    const folder = (await import("@/lib/clientFolders")).brandFolderPath("Nadia Okafor");
    dbxFiles.add(`${folder}/headshot.png`); // already there → Dropbox will autorename
    const res = await uploadRoute.POST(await upload({ token: N.token }, { name: "headshot.png" }, { kind: "HEADSHOT" }));
    const body = (await res.json()) as { ok: boolean; registered?: boolean; assetId?: string; fileName?: string; message: string };
    const hv = body.assetId ? await prisma.clientAssetVersion.findFirst({ where: { assetId: body.assetId } }) : null;
    c.ok("the ROUTE: HEADSHOT uploaded and registered", res.status === 200 && body.ok && body.registered === true, body.message);
    c.ok("  …at the path Dropbox actually wrote (autorenamed), not the one asked for", hv?.fileRef === `${folder}/headshot (1).png` && body.fileName === "headshot (1).png", hv?.fileRef ?? "");
    c.ok("  …via the link seat: no person to stamp, nothing invented", hv?.uploadedByClientUserId === null && hv?.source === "client_portal");
    const rep = await uploadRoute.POST(await upload({ token: N.token }, { name: "logo-2026.png" }, { kind: "LOGO", assetId: r.assetId! }));
    const rb = (await rep.json()) as { ok: boolean; assetId?: string };
    const lv = await prisma.clientAssetVersion.findMany({ where: { assetId: r.assetId! }, orderBy: { versionNo: "asc" } });
    c.ok("Replace → v2 of the SAME logo, v1 kept", rb.ok && rb.assetId === r.assetId && lv.length === 2 && lv[0].fileName === "logo.png" && lv[1].fileName === "logo-2026.png");
    const replaced = (await changesOf(N.clientId)).find((x) => x.kind === "FILE_REPLACED");
    c.ok("  …recorded as FILE_REPLACED logo.png → logo-2026.png", replaced?.fromText === "logo.png" && replaced.toText === "logo-2026.png");
    logoAssetId = r.assetId!;
    const otherAsset = await prisma.clientAsset.create({ data: { clientId: other.id, type: "LOGO", name: "Their logo", ownership: "CLIENT" }, select: { id: true } });
    const before = dbxUploads.length;
    const forged = await uploadRoute.POST(await upload({ token: N.token }, { name: "x.png" }, { kind: "LOGO", assetId: otherAsset.id }));
    c.ok("a Replace naming ANOTHER client's asset: 400, and not one byte uploaded", forged.status === 400 && dbxUploads.length === before, `${forged.status}`);
    const badKind = await uploadRoute.POST(await upload({ token: N.token }, { name: "x.png" }, { kind: "INVOICE" }));
    c.ok("an unknown kind: 400", badKind.status === 400);
    await prisma.clientAsset.delete({ where: { id: otherAsset.id } });
  }

  // =========================================================================
  c.head("5 · clearing is real: '' is a deliberate clear, NULL is 'never set'");
  // =========================================================================
  {
    await bp.saveClientBrandProfile(N.viewer, { videoStyle: "Bright and punchy" });
    const r = await bp.saveClientBrandProfile(N.viewer, { videoStyle: null, slots: { music: null } });
    const cl = await prisma.client.findUnique({ where: { id: N.clientId }, select: { portalVideoStyle: true } });
    c.ok("videoStyle cleared to '' (not NULL)", r.ok && cl?.portalVideoStyle === "", JSON.stringify(cl));
    const music = await prisma.clientAsset.findFirst({ where: { clientId: N.clientId, profileKey: "music" } });
    const mv = await prisma.clientAssetVersion.findMany({ where: { assetId: music!.id }, orderBy: { versionNo: "asc" } });
    const active = mv.find((v) => v.id === music?.activeVersionId);
    c.ok("music: v3 is the active one, valueText null, marked cleared; v1/v2 intact", mv.length === 3 && active?.versionNo === 3 && active.valueText === null && active.valueJson === '{"cleared":true}' && mv[1].valueText === "Calm piano");
    const kinds = (await changesOf(N.clientId)).filter((x) => x.kind === "CLEARED").map((x) => x.fieldKey);
    c.ok("ClientBrandChange CLEARED for both", kinds.includes("portalVideoStyle") && kinds.includes("slot:music"), kinds.join(","));
    c.ok("the message says what was cleared", /Cleared/.test(r.message) && r.cleared.includes("Video style & look") && r.cleared.includes("Music"), r.message);
    c.ok("prefill: '' stays '' — only NULL takes the suggestion", bp.prefillValue("", "AI read") === "" && bp.prefillValue(null, "AI read") === "AI read" && bp.prefillValue("mine", "AI read") === "mine");
    const view = await bp.portalBrandProfileView(N.clientId);
    c.ok("the profile page reads videoStyle '' and music null", view.columns.videoStyle === "" && view.slots.music === null);
    const tomb = await bp.saveClientBrandProfile(N.viewer, { preferences: null });
    const pref = await prisma.client.findUnique({ where: { id: N.clientId }, select: { portalPreferences: true } });
    c.ok("clearing a NEVER-set column stores the '' tombstone (the prefill stays gone), no history row", tomb.cleared.includes("Working preferences") && pref?.portalPreferences === "" && tomb.changeIds.length === 0);
  }

  // =========================================================================
  c.head("6 · a mixed save applies both halves and says so");
  // =========================================================================
  {
    const r = await bp.saveClientBrandProfile(N.viewer, { brandColors: null, preferences: "Text me first" });
    const cl = await prisma.client.findUnique({ where: { id: N.clientId }, select: { brandColors: true, portalPreferences: true } });
    c.ok("both applied", cl?.brandColors === "" && cl.portalPreferences === "Text me first", JSON.stringify(cl));
    c.ok("result.cleared names the colours; the message is not a bare 'Saved'", r.cleared.includes("Brand colors") && r.saved.includes("Working preferences") && /Cleared Brand colors/.test(r.message), r.message);
    const act = await newActions.portalSaveProfile({ token: N.token }, { brandColors: "#445566" });
    c.ok("the portal action (link seat) saves through the same code", act.ok && (await prisma.client.findUnique({ where: { id: N.clientId }, select: { brandColors: true } }))?.brandColors === "#445566", act.message);
  }

  // =========================================================================
  c.head("7 · isolation: staff notes, the AI profile and other clients are untouched");
  // =========================================================================
  {
    const cl = await prisma.client.findUnique({ where: { id: N.clientId }, select: { editingPreferences: true, clientPreferences: true, generalNotes: true } });
    c.ok("editingPreferences / clientPreferences / generalNotes unchanged", cl?.editingPreferences === "STAFF: keep cuts under 60s" && cl.clientPreferences === "STAFF: prefers mornings" && cl.generalNotes === "STAFF: VIP");
    const ap = await prisma.agentProfile.findUnique({ where: { clientId: N.clientId } });
    c.ok("AgentProfile unchanged", ap?.brandJson === JSON.stringify({ colors: "#ff0000" }));
    const o = await prisma.client.findUnique({ where: { id: other.id }, select: { brandColors: true, editingPreferences: true } });
    c.ok("'Other Agent' still #000000, zero assets, zero changes", o?.brandColors === "#000000" && (await prisma.clientAsset.count({ where: { clientId: other.id } })) === 0 && (await prisma.clientBrandChange.count({ where: { clientId: other.id } })) === 0);
    const staffSlot = await bp.saveClientBrandProfile(N.viewer, { slots: { ["editing.pace" as "music"]: "Fast cuts" } });
    c.ok("a staff-only slot sent from the portal is ignored", staffSlot.changeIds.length === 0 && (await prisma.clientAsset.count({ where: { clientId: N.clientId, profileKey: "editing.pace" } })) === 0);
  }

  // =========================================================================
  c.head("8 · permissions: collaborator and paused refused; the link seat allowed");
  // =========================================================================
  {
    const before = await prisma.clientBrandChange.count({ where: { clientId: N.clientId } });
    const a = await bp.saveClientBrandProfile(collabV, { slots: { music: "Jazz" } });
    const b = await bp.saveClientBrandProfile(pausedV, { slots: { music: "Jazz" } });
    const c1 = await bp.recordPortalAssetUpload(collabV, { kind: "LOGO", fileName: "c.png", path: "/x/c.png" });
    const d = await bp.recordPortalAssetUpload(pausedV, { kind: "LOGO", fileName: "d.png", path: "/x/d.png" });
    c.ok("collaborator: save and upload refused", !a.ok && !c1.ok, `${a.message} / ${c1.message}`);
    c.ok("paused: save and upload refused, with the paused sentence", !b.ok && !d.ok && /paused/.test(b.message), b.message);
    c.ok("  …and nothing was written", (await prisma.clientBrandChange.count({ where: { clientId: N.clientId } })) === before);
    const t = await bp.saveClientBrandProfile(N.tokenViewer, { slots: { website: "https://nadia-okafor.example" } });
    const w = await prisma.clientAsset.findFirst({ where: { clientId: N.clientId, profileKey: "website" } });
    const wv = await prisma.clientAssetVersion.findUnique({ where: { id: w!.activeVersionId! } });
    c.ok("the link seat saves, with no person invented", t.ok && wv?.uploadedByClientUserId === null && wv.valueText === "https://nadia-okafor.example");
  }

  // =========================================================================
  c.head("9 · the brief reads the registry; 'Got it' closes Kyle's task; so does Kyle");
  // =========================================================================
  {
    const brief = await bp.brandBriefFor(N.clientId, { projectId: N.projectId, scrub: true });
    c.ok("fonts 'Montserrat', the website, the new logo (latest version) and the headshot", brief.fontNames === "Montserrat" && brief.website === "https://nadia-okafor.example" && brief.files.some((f) => f.type === "LOGO" && f.fileName === "logo-2026.png" && f.versionNo === 2) && brief.files.some((f) => f.type === "HEADSHOT"), JSON.stringify(brief.files.map((f) => `${f.type}:${f.fileName}`)));
    c.ok("the colours on the brief are the ones on file", brief.colors.join(",") === "#445566");
    c.ok("music is cleared, so the brief says nothing", brief.music === null);
    const pending = await bp.pendingBrandChanges(N.clientId);
    c.ok("pending lists the unacknowledged changes", pending.length >= 8, `${pending.length}`);
    const ack = await bp.acknowledgeBrandChanges(N.clientId, "kim");
    const left = await bp.pendingBrandChanges(N.clientId);
    const tasks = await kyleTasks(N.clientId);
    c.ok("acknowledge → every row stamped by kim, Kyle's task COMPLETED, nothing pending", ack.acked === pending.length && ack.tasksClosed === 1 && left.length === 0 && tasks.every((t) => t.status === "COMPLETED"), JSON.stringify(ack));
    c.ok("  …the rows say who and when", (await changesOf(N.clientId)).every((r) => r.ackAt && r.ackBy === "kim"));

    // A new change → a NEW Kyle task (the completed one is not reopened), and
    // Kyle closing it by hand clears the banner.
    await bp.saveClientBrandProfile(N.viewer, { slots: { music: "Soft house" } });
    const t2 = (await kyleTasks(N.clientId)).filter((t) => t.status === "OPEN");
    c.ok("a new change opens a new Kyle task", t2.length === 1);
    await prisma.smartTask.update({ where: { id: t2[0].id }, data: { status: "COMPLETED", completedAt: new Date() } });
    c.ok("Kyle completing it by hand also empties the banner", (await bp.pendingBrandChanges(N.clientId)).length === 0);
    await bp.saveClientBrandProfile(N.viewer, { slots: { music: "Lo-fi beats" } });
    const viaAction = await brandAck.acknowledgeBrandChangesAction(N.projectId!);
    c.ok("the /edit 'Got it' action acknowledges and closes the task", viaAction.ok && (await bp.pendingBrandChanges(N.clientId)).length === 0 && (await kyleTasks(N.clientId)).every((t) => t.status === "COMPLETED"), viaAction.message);
    const refused = await brandAck.acknowledgeBrandChangesAction("not-a-real-id");
    c.ok("the action refuses a job id that isn't one", !refused.ok);
  }

  // =========================================================================
  c.head("10 · a TEST client writes ledger rows only");
  // =========================================================================
  {
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Jordan TEST", owner: { email: "jordan-owner-drill@realtourpilot.com", name: "Jordan" } });
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    const tv: PortalViewer = { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "jordan-owner-drill@realtourpilot.com", name: "Jordan", membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" };
    const posts = slackPosts.length;
    const tasksBefore = await prisma.smartTask.count();
    const r = await bp.saveClientBrandProfile(tv, { brandColors: "#123456", slots: { music: "Test music" } });
    const rows = await changesOf(f.clientId);
    c.ok("rows written, every one skipped_test", r.ok && rows.length === 2 && rows.every((x) => x.alertChannel === "skipped_test"), rows.map((x) => x.alertChannel).join(","));
    c.ok("zero Slack calls, zero SmartTasks", slackPosts.length === posts && (await prisma.smartTask.count()) === tasksBefore);
    c.ok("the banner still shows them (so the TEST journey can be walked)", (await bp.pendingBrandChanges(f.clientId)).length === 2);

    // ---- 13 lives here: the TEST client's team --------------------------
    c.head("13 · a TEST client's seat: full access by default; the three stops hold");
    const inv = await team.inviteTeammate(tv, { name: "Sam Assistant", email: "drill-sam@realtourpilot.com" });
    const samUser = await prisma.clientUser.findUnique({ where: { email: "drill-sam@realtourpilot.com" } });
    const seat = samUser ? await prisma.clientMembership.findFirst({ where: { enrollmentId: f.enrollmentId, clientUserId: samUser.id } }) : null;
    c.ok("a seat is created, role OWNER by default", inv.ok && seat?.role === "OWNER", inv.message);
    c.ok("  …and the message is honest: invitations are off, nobody was emailed", /aren't being sent yet/.test(inv.message) && (await prisma.outboxMessage.count()) === 0, inv.message);
    const role = await team.setTeammateRole(tv, seat!.id, "COLLABORATOR");
    c.ok("setTeammateRole → COLLABORATOR", role.ok && (await prisma.clientMembership.findUnique({ where: { id: seat!.id } }))?.role === "COLLABORATOR");
    const selfOff = await team.revokeTeammate(tv, f.membershipId!);
    c.ok("removing yourself is refused", !selfOff.ok, selfOff.message);
    const demoteLast = await team.setTeammateRole(tv, f.membershipId!, "VIEWER");
    c.ok("demoting the last owner is refused", !demoteLast.ok, demoteLast.message);
    const sam = await prisma.clientUser.findUnique({ where: { email: "drill-sam@realtourpilot.com" } });
    await signIn(sam!.id, sam!.email);
    const cookieSrc = { get: (n: string) => jar.get(n) };
    const before = await resolvePortalViewer({ enrollmentId: f.enrollmentId, cookies: cookieSrc });
    const off = await team.revokeTeammate(tv, seat!.id);
    const after = await resolvePortalViewer({ enrollmentId: f.enrollmentId, cookies: cookieSrc });
    c.ok("revoke → revokedAt set, and the resolver refuses the seat on the next request", before.ok && off.ok && !!(await prisma.clientMembership.findUnique({ where: { id: seat!.id } }))?.revokedAt && !after.ok && after.reason === "no_membership", `${before.ok} → ${after.ok ? "ok" : after.reason}`);
    signOut();
    const nadiaName = (await prisma.clientUser.findUnique({ where: { id: N.ownerId } }))?.name;
    const cross = await team.inviteTeammate(tv, { name: "Somebody Else", email: N.viewer.actor.kind === "CLIENT" ? N.viewer.actor.email : "" });
    c.ok("an address seated on another client is refused, and its name is unchanged", !cross.ok && (await prisma.clientUser.findUnique({ where: { id: N.ownerId } }))?.name === nadiaName, cross.message);
  }

  // =========================================================================
  c.head("11 · no job → the personal-branding route; no program → 'no editor'");
  // =========================================================================
  {
    const e = await realClient("Eve Enrolled", { project: false });
    const posts = slackPosts.filter((p) => p.channel === "U-KIM").length;
    await bp.saveClientBrandProfile(e.viewer, { slots: { fonts: "Lato" } });
    const row = (await changesOf(e.clientId))[0];
    c.ok("enrolled, no open job → Kim (personal branding), messaged (switch is on)", row.alertEditorKeys === "kim" && row.alertChannel === "slack" && slackPosts.filter((p) => p.channel === "U-KIM").length === posts + 1, `${row.alertEditorKeys}/${row.alertChannel}`);
    const u = await realClient("Uma Unenrolled", { project: false, enrolled: false });
    await bp.setProfileSlot({ clientId: u.clientId, key: "website", value: "https://uma.example", source: "staff", actor: { staffEmail: "kyle@realtourpilot.com", label: "kyle@realtourpilot.com" } });
    const out = await bp.alertBrandChanges(u.clientId);
    const t = (await kyleTasks(u.clientId))[0];
    c.ok("no program, no job → alertChannel 'no_editor'", out.channel === "no_editor" && (await changesOf(u.clientId))[0].alertChannel === "no_editor");
    c.ok("  …and Kyle's task says so", !!t && /no editor on their work yet/.test(t.title) && /nobody has been told/.test(t.description ?? ""), t?.title);
  }

  // =========================================================================
  c.head("12 · a real client's invitation is HELD, listed, cancellable (switches OFF)");
  // =========================================================================
  {
    const users = await prisma.clientUser.count();
    const seats = await prisma.clientMembership.count();
    const outbox = await prisma.outboxMessage.count();
    const inv = await team.inviteTeammate(N.viewer, { name: "Sam Assistant", email: "sam@example.com" });
    c.ok("HELD, with the honest sentence", inv.ok && inv.held === true && /Nothing has gone to them yet/.test(inv.message), inv.message);
    c.ok("zero ClientUser, ClientMembership and OutboxMessage rows created", (await prisma.clientUser.count()) === users && (await prisma.clientMembership.count()) === seats && (await prisma.outboxMessage.count()) === outbox);
    const list = await team.teamSeats(N.viewer);
    const held = list.seats.find((s) => s.email === "sam@example.com");
    c.ok("teamSeats lists it {held, pending}, default full access", !!held && held.held && held.pending && held.role === "OWNER" && !list.invitationsOn, JSON.stringify(held));
    const s = await setup.setupChecklist(N.viewer);
    c.ok("the optional team item counts a held teammate as done", s.items.find((i) => i.key === "team")?.done === true);
    const cancel = await team.cancelHeldTeammate(N.viewer, "sam@example.com");
    c.ok("cancelHeldTeammate deletes the held row", cancel.ok && !(await prisma.appSetting.findUnique({ where: { key: `portal-access-owed:${N.enrollmentId}:sam@example.com` } })), cancel.message);
    c.ok("  …and it is gone from the list", !(await team.teamSeats(N.viewer)).seats.some((x) => x.email === "sam@example.com"));
    const welcome = await grantProgramAccess({ enrollmentId: N.enrollmentId!, emailRaw: "payer@example.com", name: "Payer Person", reason: "welcome" });
    const refused = await cancelOwedAccess(N.enrollmentId!, "payer@example.com");
    c.ok("the payer's own held 'welcome' cannot be cancelled", welcome.outcome === "HELD" && !refused.ok && !!(await prisma.appSetting.findUnique({ where: { key: `portal-access-owed:${N.enrollmentId}:payer@example.com` } })), refused.note);
    c.ok("  …and is not listed as a teammate", !(await team.teamSeats(N.viewer)).seats.some((x) => x.email === "payer@example.com"));
    c.ok("the link seat cannot manage the team", !(await team.teamSeats(N.tokenViewer)).ok && !(await team.inviteTeammate(N.tokenViewer, { name: "X Y", email: "x@y.com" })).ok);
  }

  // =========================================================================
  c.head("14 · the hourly sweep alerts a stranded row exactly once");
  // =========================================================================
  {
    const stranded = await prisma.clientBrandChange.create({
      data: { clientId: N.clientId, enrollmentId: N.enrollmentId, fieldKey: "slot:music", label: "Music", kind: "SET", toText: "Stranded value", source: "client_portal", createdAt: new Date(Date.now() - 5 * 60_000) },
    });
    const young = await prisma.clientBrandChange.create({ data: { clientId: other.id, fieldKey: "brandColors", label: "Brand colors", kind: "SET", toText: "#010101", source: "staff" } });
    const a = await bp.sweepBrandChangeAlerts();
    const row = await prisma.clientBrandChange.findUnique({ where: { id: stranded.id } });
    c.ok("the >2-minute-old row is alerted (task, channel)", a.rows >= 1 && !!row?.alertedAt && !!row.taskId && !!row.alertChannel, JSON.stringify(a));
    c.ok("a row younger than two minutes is left for its own inline alert", !(await prisma.clientBrandChange.findUnique({ where: { id: young.id } }))?.alertedAt);
    const b = await bp.sweepBrandChangeAlerts();
    c.ok("a second run handles nothing", b.rows === 0, JSON.stringify(b));
    await prisma.clientBrandChange.delete({ where: { id: young.id } });
  }

  // =========================================================================
  c.head("15 · a staff edit on the Brand tab is recorded and alerted the same way");
  // =========================================================================
  {
    const before = await prisma.clientBrandChange.count({ where: { clientId: N.clientId, source: "staff" } });
    const r = await ws.addAssetVersionAction(N.enrollmentId!, logoAssetId, { fileRef: "/Clients/Nadia Okafor/logo-final.png", fileName: "logo-final.png", note: "from the designer" });
    const rows = await prisma.clientBrandChange.findMany({ where: { clientId: N.clientId, source: "staff" }, orderBy: { createdAt: "desc" } });
    c.ok("a new logo version by staff → a FILE_REPLACED row, source staff", r.ok && rows.length === before + 1 && rows[0].kind === "FILE_REPLACED" && rows[0].toText === "logo-final.png" && rows[0].fromText === "logo-2026.png", `${r.message} · ${rows[0]?.kind}`);
    c.ok("  …alerted: Kyle's task and the editor", !!rows[0].alertedAt && !!rows[0].taskId && rows[0].alertEditorKeys === "kim");
    const rb = await ws.setActiveAssetVersionAction(N.enrollmentId!, logoAssetId, (await prisma.clientAssetVersion.findFirst({ where: { assetId: logoAssetId, versionNo: 2 } }))!.id);
    const last = await prisma.clientBrandChange.findFirst({ where: { clientId: N.clientId, source: "staff" }, orderBy: { createdAt: "desc" } });
    c.ok("a rollback is recorded too (logo-final.png → logo-2026.png)", rb.ok && last?.fromText === "logo-final.png" && last.toText === "logo-2026.png");
    const musicAssets = await prisma.clientAsset.count({ where: { clientId: N.clientId, type: "MUSIC_PREFERENCE" } });
    const tr = await ws.createAssetAction(N.enrollmentId!, { clientId: N.clientId, type: "MUSIC_PREFERENCE", name: "Music", valueText: "Warm jazz" });
    c.ok("'track something new' of type Music writes the client's music SLOT — no second music asset", tr.ok && (await prisma.clientAsset.count({ where: { clientId: N.clientId, type: "MUSIC_PREFERENCE" } })) === musicAssets && (await bp.getSlot(N.clientId, "music"))?.value === "Warm jazz", tr.message);
  }

  // =========================================================================
  // REVIEW FIXES (Sep 24 2026)
  // =========================================================================
  c.head("17 · a logo already in their folder: 'tell us which file', filed where it is, no duplicate");
  // =========================================================================
  {
    const F = await realClient("Folder Olsen");
    const folder = (await import("@/lib/clientFolders")).brandFolderPath("Folder Olsen");
    dbxFiles.add(`${folder}/Olsen Logo.png`); // put there before CP-06 — never registered
    dbxFiles.add(`${folder}/brand-guide.pdf`);
    const plain = await setup.setupChecklist(F.viewer, { folder: false });
    c.ok("OLD reading (registry only): 'Upload your logo' though the logo is in the folder", plain.items.find((i) => i.key === "logo")?.label === "Upload your logo" && !plain.items.find((i) => i.key === "logo")?.done);
    const s0 = await setup.setupChecklist(F.viewer);
    const logo0 = s0.items.find((i) => i.key === "logo");
    c.ok("NEW: the item asks 'Tell us which file is your logo' and points at the folder list", logo0?.label === "Tell us which file is your logo" && logo0.anchor === "files" && !logo0.done, JSON.stringify(logo0));
    c.ok("  the count stays truthful: not done until one is filed", s0.done === plain.done);
    const uploads0 = dbxUploads.length;
    const r = await bp.claimFolderFileForPortal(F.viewer, { name: "olsen logo.PNG", kind: "LOGO" });
    const a = r.assetId ? await prisma.clientAssetVersion.findFirst({ where: { assetId: r.assetId } }) : null;
    c.ok("'This is my logo' files the folder file as the LOGO, at its own path", r.ok && a?.fileRef === `${folder}/Olsen Logo.png`, r.message);
    c.ok("  without uploading anything (no duplicate)", dbxUploads.length === uploads0);
    c.ok("  recorded and alerted like an upload (Kyle's confirmation task)", (await changesOf(F.clientId)).some((x) => x.kind === "FILE_ADDED" && x.toText === "Olsen Logo.png") && (await kyleTasks(F.clientId)).some((t) => t.status === "OPEN"));
    const s1 = await setup.setupChecklist(F.viewer);
    c.ok("  and the logo item is done", s1.items.find((i) => i.key === "logo")?.done === true && s1.done === s0.done + 1);
    c.ok("filing it twice is refused", !(await bp.claimFolderFileForPortal(F.viewer, { name: "Olsen Logo.png", kind: "LOGO" })).ok);
    const forged = await newActions.portalUseFolderFile({ token: F.token }, "../../Other Client/logo.png", "HEADSHOT");
    c.ok("a name that is not a file in THEIR folder is refused", !forged.ok, forged.message);
    c.ok("a collaborator may not file one", !(await bp.claimFolderFileForPortal({ ...F.viewer, actor: { ...(F.viewer.actor as Extract<PortalViewer["actor"], { kind: "CLIENT" }>), membershipRole: "COLLABORATOR" } }, { name: "brand-guide.pdf", kind: "HEADSHOT" })).ok);
  }

  // =========================================================================
  c.head("18 · the account holder's seat: an assistant with full access cannot remove or demote them");
  // =========================================================================
  {
    const h = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Holder TEST", owner: { email: "holder-drill@realtourpilot.com", name: "Holder" } });
    const enrollment = { id: h.enrollmentId, clientId: h.clientId, clientName: h.clientName, status: "ACTIVE", videosPerMonth: h.videosPerMonth, sessionsPerMonth: h.sessionsPerMonth };
    const payerV: PortalViewer = { enrollment, actor: { kind: "CLIENT", clientUserId: h.clientUserId!, email: "holder-drill@realtourpilot.com", name: "Holder", membershipId: h.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" };
    const inv = await team.inviteTeammate(payerV, { name: "Alex Assistant", email: "drill-alex@realtourpilot.com" });
    const alex = await prisma.clientUser.findUniqueOrThrow({ where: { email: "drill-alex@realtourpilot.com" } });
    const alexSeat = await prisma.clientMembership.findFirstOrThrow({ where: { enrollmentId: h.enrollmentId, clientUserId: alex.id } });
    c.ok("(the assistant has the default OWNER seat)", inv.ok && alexSeat.role === "OWNER");
    // OLD (HEAD's actions): signed in as the assistant, remove the payer.
    const oldTeam = (await import(base.actions)) as { portalRevokeTeammate: (a: Auth, id: string) => Promise<R> };
    await signIn(alex.id, alex.email);
    const oldOff = await oldTeam.portalRevokeTeammate({ enrollmentId: h.enrollmentId }, h.membershipId!);
    signOut();
    c.ok("OLD: the assistant could remove the paying client", oldOff.ok && !!(await prisma.clientMembership.findUnique({ where: { id: h.membershipId! } }))?.revokedAt, oldOff.message);
    await prisma.clientMembership.update({ where: { id: h.membershipId! }, data: { revokedAt: null, revokedBy: null } });
    const alexV: PortalViewer = { enrollment, actor: { kind: "CLIENT", clientUserId: alex.id, email: alex.email, name: "Alex Assistant", membershipId: alexSeat.id, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" };
    const off = await team.revokeTeammate(alexV, h.membershipId!);
    c.ok("NEW: removing the account holder is refused, with the office as the way forward", !off.ok && /account holder/.test(off.message) && !(await prisma.clientMembership.findUnique({ where: { id: h.membershipId! } }))?.revokedAt, off.message);
    const demote = await team.setTeammateRole(alexV, h.membershipId!, "VIEWER");
    c.ok("NEW: so is making them view-only", !demote.ok && (await prisma.clientMembership.findUnique({ where: { id: h.membershipId! } }))?.role === "OWNER", demote.message);
    const seats = await team.teamSeats(alexV);
    c.ok("the Settings list marks the holder (no Remove / role controls for them)", seats.seats.find((x) => x.membershipId === h.membershipId)?.accountHolder === true && seats.seats.find((x) => x.membershipId === alexSeat.id)?.accountHolder === false);
    const payerOffAlex = await team.setTeammateRole(payerV, alexSeat.id, "COLLABORATOR");
    c.ok("the holder still manages their assistant", payerOffAlex.ok);
    // A Stripe signup names the payer, whichever seat is older.
    await prisma.programSignup.create({ data: { checkoutId: `cs_drill_${h.enrollmentId}`, email: "DRILL-ALEX@realtourpilot.com", productId: "prod_drill", productName: "Video Accelerator", amount: 1, recurring: true, paidAt: new Date(), enrollmentId: h.enrollmentId, clientId: h.clientId } });
    const holders = await team.accountHolderSeatIds(h.enrollmentId);
    c.ok("with a checkout on file, the holder is the checkout's email", holders.has(alexSeat.id) && !holders.has(h.membershipId!));
  }

  // =========================================================================
  c.head("19 · the editor's brief keeps accepted production preferences behind twenty newer facts");
  // =========================================================================
  {
    const P = await realClient("Pref Harlow");
    const { factsForPrompt, productionFactsForProject } = await import("@/lib/clientFacts");
    await prisma.clientFact.create({ data: { clientId: P.clientId, category: "PRODUCTION_PREFERENCE", body: "Captions in bold yellow, never white", source: "call", status: "ACCEPTED", aiContext: "ALLOWED", factDate: new Date("2026-06-01T12:00:00Z") } });
    for (let i = 0; i < 22; i++) {
      await prisma.clientFact.create({ data: { clientId: P.clientId, category: i % 2 ? "DECISION" : "BRAND_PREFERENCE", body: `A newer non-production fact ${i}`, source: "call", status: "ACCEPTED", aiContext: "ALLOWED", factDate: new Date(Date.UTC(2026, 8, 1 + i)) } });
    }
    const oldRead = (await factsForPrompt(P.clientId, { projectId: P.projectId, take: 20 })).filter((x) => x.category === "PRODUCTION_PREFERENCE");
    c.ok("OLD: the newest 20 of every category, filtered after → the preference was gone", oldRead.length === 0);
    const lines = await productionFactsForProject(P.clientId, P.projectId);
    c.ok("NEW: the preference is read in the query, before the limit", lines.some((l) => /bold yellow/.test(l)), JSON.stringify(lines));
    const brief = await bp.brandBriefFor(P.clientId, { projectId: P.projectId, scrub: true });
    c.ok("  and the /edit brief shows it under 'From their calls'", brief.acceptedPreferences.some((l) => /bold yellow/.test(l)), JSON.stringify(brief.acceptedPreferences));
  }

  const blockedMine = fence.blocked.length;
  c.ok("nothing left the machine: zero blocked outbound calls (Slack and Dropbox answered by the fakes)", blockedMine === 0, fence.blocked.join(", "));

  // =========================================================================
  c.head("16 · the real hourly cron runs the brandChangeAlerts step");
  // =========================================================================
  {
    await prisma.clientBrandChange.create({ data: { clientId: N.clientId, fieldKey: "slot:fonts", label: "Font names", kind: "SET", toText: "Via cron", source: "client_portal", createdAt: new Date(Date.now() - 10 * 60_000) } });
    const { GET } = await import("@/app/api/cron/sync/route");
    const res = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer drill-secret" } }));
    const body = (await res.json()) as Record<string, unknown>;
    const step = body.brandChangeAlerts as { rows?: number } | undefined;
    c.ok("the step ran without error and alerted the stranded row", res.status === 200 && !("brandChangeAlertsError" in body) && (step?.rows ?? 0) >= 1, JSON.stringify(step ?? body.brandChangeAlertsError));
    console.log(`    (other cron steps reached for ${fence.blocked.length - blockedMine} provider calls, all blocked at the fence)`);
  }

  c.summary();
  quiet.restore();
  fence.restore();
  try { fs.unlinkSync(path.join(base.dir, "node_modules")); fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
