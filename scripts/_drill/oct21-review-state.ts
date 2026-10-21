// ---------------------------------------------------------------------------
// DRILL: the portal's review state follows the OPEN version (Oct 21 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct21-review-state.ts
//
// Jordan: "Make sure if a video is open for review it changes the delivered
// status on their portal to needs your review and that the proper videos are
// getting replaced." And, on Bernadette Rabel: "I think we made revisions
// after she approved."
//
// The live shapes, rebuilt on fixtures (the live database is never opened):
//   A  Mike Ciunci "Video 2": v1 approved in the portal and sent Oct 5, he
//      asked for changes BY TEXT (a reopen that writes no decision), v2 sent
//      back internally, v3 approved, run through the 1080p pass and published
//      → Needs your review ("Updated version"), plays v3, v1's Aryeo frame is
//      not its poster, "Download the version you approved (v1)", not counted
//      delivered in the month; Mike approves v3 → v3 is the final everywhere.
//   B  Bernadette Rabel "Video 4": v1 published, the office recorded changes
//      on her behalf, v2 published → Needs your review, nothing to download.
//   B2 Bernadette "Video 2" (revisions after she approved): v1 approved by her,
//      the office then recorded changes on her behalf, v2 published → Needs
//      your review, Updated version, her approval stays on record and v1 stays
//      downloadable, v2 never counts as approved.
//   C  "Video 5": v1 published, no decision → Needs your review.
//   D  "Video 3": v1 approved in the portal → Approved.
//   R  Recording a client's approval given outside the portal: staff only,
//      with a required note, written as "<staff> (on behalf of <client>)",
//      audited; refused on the client's own login and on the shared link.
//   L  Library duplicates: a re-delivered file of the same video joins it.
//
// ISOLATION: PGlite via the shared harness, every .env key blank, every
// outbound call fenced (the hub store answers with a canned 5-byte file), the
// model stubbed to refuse. No provider is reached and no message is sent.
// ---------------------------------------------------------------------------
import Module from "node:module";
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";
import type { MediaScope } from "@/lib/portalMedia";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7527);

// lucide-react builds its icons on React.createContext and next/link is a
// client module; the portal's server components are CALLED here and their
// element trees read, so both only have to exist (as ui01-portal-ia does).
{
  const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const realLoad = loader._load;
  const icons = new Map<string, () => null>();
  const icon = (k: string) => {
    if (!icons.has(k)) { const f = () => null; Object.defineProperty(f, "name", { value: `Icon${k}` }); icons.set(k, f); }
    return icons.get(k);
  };
  function Link(p: unknown) { return p; }
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, { get: (_t, k) => (k === "__esModule" ? true : typeof k === "string" && k !== "then" ? icon(k) : undefined) });
    if (request === "next/link") return { __esModule: true, default: Link };
    return realLoad.call(this, request, parent, isMain);
  };
}
installNextStubs();
// THE SIGNED-IN VISITOR. resolvePortalViewer reads its cookies through a
// dynamic import("next/headers") the harness stub cannot reach, so the portal
// actions are handed this jar whenever the caller passed none (as cp06 does):
// a client seat's cookie, or a staff login beside the shared link (the iframe).
const jar = new Map<string, string>();
interceptModule(
  (r) => r === "@/lib/portal" || /[\\/]src[\\/]lib[\\/]portal$/.test(r),
  (loaded) => {
    const m = loaded as { resolvePortalViewer: (i: { token?: string | null; enrollmentId?: string | null; cookies?: unknown }) => Promise<unknown> };
    return { ...m, resolvePortalViewer: (i: Parameters<typeof m.resolvePortalViewer>[0]) => m.resolvePortalViewer({ ...i, cookies: i.cookies ?? { get: (n: string) => jar.get(n) } }) };
  },
);
const fence = fenceFetch((url) =>
  /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url)
    ? new Response("abcde", { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" } })
    : null,
);
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson" && k !== "aiJsonWithUsage") return t[k];
      return async () => { aiCalls++; throw new Error("drill: no model"); };
    },
  }),
);

// ---- element trees ------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function find(n: any, name: string, out: El[] = []): El[] {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) { n.forEach((x) => find(x, name, out)); return out; }
  if (!isEl(n)) return out;
  if (typeName(n.type) === name) out.push(n);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") find(v, name, out);
  return out;
}
/** The words a tree puts on screen, expanding the hook-free components that print props. */
const EXPAND = new Set(["VideoRowV2", "StatusChip"]);
function words(n: any, out: string[] = []): string[] {
  if (n === null || n === undefined || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (!isEl(n)) return out;
  if (typeof n.type === "function" && EXPAND.has(n.type.name)) return words(n.type(n.props), out);
  return words(n.props.children, out);
}
const say = (tree: any) => words(tree).join("").replace(/\s+/g, " ");
/* eslint-enable @typescript-eslint/no-explicit-any */

const c = makeChecker();
const DAY = (iso: string) => new Date(`${iso}T15:00:00Z`);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const cv = await import("@/lib/contentVideos");
  const ce = await import("@/lib/cutEntitlement");
  const cd = await import("@/lib/clientDecisions");
  const pk = await import("@/lib/postingKit");
  const rw = await import("@/lib/reviewWindows");
  const reopen = await import("@/lib/cutReopen");
  const mp = await import("@/lib/monthProgress");
  const actions = await import("@/app/portal/actions");
  const { PortalPage } = await import("@/components/portal/PortalPage");
  const { LibraryV2, VideoDetailV2 } = await import("@/components/portal/tabs/VideosTab");
  const { loadContentTab } = await import("@/app/content/[id]/workspaceData");
  const { mediaToken } = await import("@/lib/portalMedia");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { signSession, SESSION_COOKIE } = await import("@/lib/auth/jwt");
  const { signClientSession, CLIENT_COOKIE } = await import("@/lib/auth/clientSession");
  const { NextRequest } = await import("next/server");
  const downloadRoute = await import("@/app/api/portal/download/[videoId]/route");

  // ---- the world ------------------------------------------------------------
  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });

  const BLOB = (id: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${id}.mp4`;
  async function mkCut(o: {
    projectId: string; deliverableId: string; slot: number; round: number; fileName: string; createdAt: Date;
    status?: string; decidedAt?: Date | null; decidedBy?: string; clientReleasedAt?: Date | null; sentToClientAt?: Date | null; portalPublicationRequiredAt?: Date | null;
  }): Promise<string> {
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: o.projectId, deliverableId: o.deliverableId, slot: o.slot, round: o.round, fileName: o.fileName, status: o.status ?? "APPROVED",
        decidedBy: o.decidedBy ?? "Jordan", decidedAt: o.decidedAt === undefined ? o.createdAt : o.decidedAt, source: "upload", sizeBytes: 5,
        finalPath: `/Final/${o.fileName}`, createdAt: o.createdAt, clientReleasedAt: o.clientReleasedAt ?? null, sentToClientAt: o.sentToClientAt ?? null,
        portalPublicationRequiredAt: o.portalPublicationRequiredAt ?? null,
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), blobUrl: BLOB(row.id), blobPathname: `review-cuts/${row.id}.mp4` } });
    return row.id;
  }
  /** Published the way the portal publication does it: released, sent, the handoff marker, the window. */
  async function publish(id: string, at: Date) {
    await prisma.reviewSubmission.update({ where: { id }, data: { clientReleasedAt: at, sentToClientAt: at } });
    await prisma.auditLog.create({ data: { id: `monthly-portal-handoff:${id}`, actor: "system", action: "monthly_portal_handoff", target: id, detail: "{}" } });
    await rw.openReviewWindow(id, { by: "Portal publication" });
  }
  const aryeoRow = (f: { enrollmentId: string; monthId: string; projectId: string }, key: string, title: string, createdAt: Date) =>
    prisma.portalVideo.create({
      data: {
        enrollmentId: f.enrollmentId, monthId: f.monthId, projectId: f.projectId, title, source: "aryeo", externalKey: `aryeo:L-${key}:${key}`, deliveredAt: createdAt, createdAt,
        thumb: `https://image.mux.com/${key}/thumbnail.jpg`, playback: `https://cdn.aryeo.example/${key}.mp4`, download: `https://cdn.aryeo.example/${key}.mp4`,
      },
      select: { id: true },
    });
  const viewerOf = (f: { enrollmentId: string; clientId: string; clientName: string; videosPerMonth: number; sessionsPerMonth: number }, actor: PortalViewer["actor"]): PortalViewer =>
    ({ enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth }, actor, access: "FULL", via: actor.kind === "CLIENT" ? "LOGIN" : actor.kind } as PortalViewer);
  const videoOf = async (subId: string) => {
    const s = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: subId }, select: { videoId: true } });
    return prisma.contentVideo.findUniqueOrThrow({ where: { id: s.videoId! } });
  };
  const door = (videoId: string, scope: MediaScope) =>
    downloadRoute.GET(new NextRequest(`http://127.0.0.1/api/portal/download/${videoId}?m=${encodeURIComponent(mediaToken(videoId, scope))}`), { params: Promise.resolve({ videoId }) });
  const href = (tab: string, extra?: string) => `?tab=${tab}${extra ? `&${extra}` : ""}`;

  // Mike: five videos a month; the October job reads DELIVERED (Oct 5).
  const mike = await buildContentMonth(prisma as unknown as PrismaClient, {
    name: "Mike Ciunci TEST", package: "Accelerator", videosPerMonth: 5, monthKey: "2026-10",
    project: { status: "DELIVERED", shootDate: DAY("2026-10-01") }, owner: { email: "mike@example.com", name: "Mike Ciunci" },
  });
  await prisma.project.update({ where: { id: mike.projectId! }, data: { deliveredAt: DAY("2026-10-05") } });
  const mikePair = { id: mike.enrollmentId, clientId: mike.clientId };
  const mikeOwner = viewerOf(mike, { kind: "CLIENT", clientUserId: mike.clientUserId!, email: "mike@example.com", name: "Mike Ciunci", membershipId: mike.membershipId!, membershipRole: "OWNER" } as PortalViewer["actor"]);
  const mikeStaff = viewerOf(mike, { kind: "STAFF", staffUserId: kyle.id, staffName: "Kyle Drill", staffRole: "ADMIN" } as PortalViewer["actor"]);
  const mikeSeat: MediaScope = { kind: "membership", id: mike.membershipId! };
  const MP = mike.projectId!, MD = mike.deliverableId!;
  const mf = { enrollmentId: mike.enrollmentId, monthId: mike.monthId, projectId: MP };
  const mikeSync = () => cv.syncEnrollmentVideos(mikePair);
  const mikeRow = async (videoId: string) => (await cv.portalVideoList(mikePair, { perPage: 60 })).rows.find((r) => r.id === videoId);

  // Video 1 and Video 4: Kyle sent them Oct 5 (delivered outside the portal).
  const m1 = await mkCut({ projectId: MP, deliverableId: MD, slot: 1, round: 1, fileName: "Mike Video 1 v1.mov", createdAt: DAY("2026-10-02"), decidedAt: DAY("2026-10-03"), clientReleasedAt: DAY("2026-10-03"), sentToClientAt: DAY("2026-10-05") });
  await mkCut({ projectId: MP, deliverableId: MD, slot: 4, round: 1, fileName: "Mike Video 4 v1.mov", createdAt: DAY("2026-10-02"), decidedAt: DAY("2026-10-03"), clientReleasedAt: DAY("2026-10-03"), sentToClientAt: DAY("2026-10-05") });
  // A: Video 2 v1, released Oct 3, with its Aryeo copy (v1's Mux frame) from Oct 5.
  const a1 = await mkCut({ projectId: MP, deliverableId: MD, slot: 2, round: 1, fileName: "Mike Video 2 v1.mov", createdAt: DAY("2026-10-02"), decidedAt: DAY("2026-10-03"), clientReleasedAt: DAY("2026-10-03") });
  await aryeoRow(mf, "MIKE-V2-V1", "Mike Video 2", DAY("2026-10-05"));
  // D: Video 3, released Oct 7.
  const d1 = await mkCut({ projectId: MP, deliverableId: MD, slot: 3, round: 1, fileName: "Mike Video 3 v1.mov", createdAt: DAY("2026-10-06"), decidedAt: DAY("2026-10-07"), clientReleasedAt: DAY("2026-10-07") });
  // C: Video 5, released Oct 19, no decision.
  const c1 = await mkCut({ projectId: MP, deliverableId: MD, slot: 5, round: 1, fileName: "Mike Video 5 v1.mov", createdAt: DAY("2026-10-18"), decidedAt: DAY("2026-10-19"), clientReleasedAt: DAY("2026-10-19") });
  for (const id of [m1, a1, d1, c1]) await rw.openReviewWindow(id, { by: "drill" });
  await mikeSync();

  // =========================================================================
  c.head("D · Video 3: approved in the portal reads Approved and is the client's");
  // =========================================================================
  {
    const r = await cd.approveCut(mikeOwner, d1, "NONE");
    c.ok("Mike approves v1 of Video 3", r.ok, r.message);
    await mikeSync();
    const v = await videoOf(d1);
    const row = await mikeRow(v.id);
    c.ok("list: Approved, downloadable, not an updated version", row?.state === "APPROVED" && row.downloadable && !row.updated, `${row?.state}/${row?.downloadable}/${row?.updated}`);
    c.ok("counted delivered in the month (the one rule)", cv.isDeliveredProgramVideo(v), v.status);
  }

  // =========================================================================
  c.head("A1 · Video 2 v1: approved, sent, then reopened BY TEXT → Changes in progress");
  // =========================================================================
  const aVideo = (await videoOf(a1)).id;
  {
    const r = await cd.approveCut(mikeOwner, a1, "NONE");
    c.ok("Mike approves v1 of Video 2 in the portal", r.ok, r.message);
    await prisma.reviewSubmission.update({ where: { id: a1 }, data: { sentToClientAt: DAY("2026-10-05") } });
    await mikeSync();
    const before = await mikeRow(aVideo);
    c.ok("…then Kyle sent it Oct 5: Delivered", before?.state === "DELIVERED", before?.state);
    const ro = await reopen.reopenApprovedCut(a1, { by: "Mike Ciunci", why: "Asked by text for a new song.", source: "text" });
    c.ok("his text reopens v1 for revisions (no client decision is written)", ro.ok && ro.reopened, ro.message);
    const approvalRow = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: a1, decision: "APPROVE" } });
    c.ok("  …his approval is set aside the reopen's way: receipt SUPERSEDED, nothing replacing it", approvalRow.receiptState === "SUPERSEDED" && approvalRow.supersededById === null, `${approvalRow.receiptState}/${approvalRow.supersededById}`);
    await mikeSync();
    const row = await mikeRow(aVideo);
    // BEFORE (Oct 20 code): the set-aside approval still read live, so the
    // list said Approved/Delivered while the editor re-cut it, and the video
    // page offered "Approve" on a version the server would refuse.
    c.ok("list: Changes in progress (was Approved/Delivered while re-cut)", row?.state === "CHANGES_IN_PROGRESS", row?.state);
    c.ok("  …no new version yet, so not an 'Updated version'", row?.updated === false);
    const e = await ce.videoEntitlement(await prisma.contentVideo.findUniqueOrThrow({ where: { id: aVideo } }));
    c.ok("release rule: v1 stands at CHANGES_REQUESTED, and v1 (approved) stays his to download", e.current?.submissionId === a1 && e.current.state === "CHANGES_REQUESTED" && e.file?.submissionId === a1 && e.priorVersion === true && e.basis === "CLIENT_APPROVED", `${e.current?.state}/${e.file?.submissionId === a1}/${e.basis}`);
    c.ok("  …and says so in plain words", e.why === ce.priorWhy(true, "CHANGES_REQUESTED", true) && /^This is the version you approved\. You asked for changes/.test(e.why ?? ""), e.why ?? "");
    const hist = await cd.cutHistory(mikeOwner, a1);
    c.ok("video page: v1 reads 'Changes requested', not 'Awaiting your review'", hist.find((h) => h.isCurrent)?.clientState === "YOU_REQUESTED_CHANGES", hist.find((h) => h.isCurrent)?.clientState);
    c.ok("not counted delivered while it is being re-cut", !cv.isDeliveredProgramVideo(await prisma.contentVideo.findUniqueOrThrow({ where: { id: aVideo } })));
  }

  // =========================================================================
  c.head("A2 · v2 sent back internally, v3 approved and in its 1080p pass: nothing new shown yet");
  // =========================================================================
  const a2 = await mkCut({ projectId: MP, deliverableId: MD, slot: 2, round: 2, fileName: "Mike Video 2 v2.mov", createdAt: DAY("2026-10-15"), status: "CHANGES_REQUESTED", decidedBy: "James", decidedAt: DAY("2026-10-16") });
  const a3at = new Date(Date.now() - 3_600_000);
  const a3 = await mkCut({ projectId: MP, deliverableId: MD, slot: 2, round: 3, fileName: "Mike Video 2 v3.mov", createdAt: DAY("2026-10-20"), decidedAt: a3at, portalPublicationRequiredAt: a3at });
  await prisma.topazJob.create({ data: { projectId: MP, submissionId: a3, state: "done", finalPath: "/Final/Mike Video 2 v3 - FINAL (Topaz).mp4", savedAt: a3at, outputCheck: "verified" } });
  {
    await mikeSync();
    const row = await mikeRow(aVideo);
    c.ok("v3 waits for publication: the list still shows v1, changes in progress", row?.state === "CHANGES_IN_PROGRESS" && row.currentSubmissionId === a1, `${row?.state}/${row?.currentSubmissionId === a1}`);
    c.ok("v2 (sent back internally) is never the client's", row?.currentSubmissionId !== a2);
  }

  // =========================================================================
  c.head("A3 · v3 published: Needs your review, the right file plays and downloads");
  // =========================================================================
  await publish(a3, new Date(Date.now() - 1_800_000));
  // The job reads delivered again (as Mike's did): the month's pipeline still says 5.
  await prisma.project.update({ where: { id: MP }, data: { status: "DELIVERED" } });
  await mikeSync();
  {
    const v = await prisma.contentVideo.findUniqueOrThrow({ where: { id: aVideo } });
    c.ok("the row is the live shape: CLIENT_REVIEW, current v3, final v1, delivered date kept", v.status === "CLIENT_REVIEW" && v.currentSubmissionId === a3 && v.finalSubmissionId === a1 && !!v.deliveredAt, `${v.status}/${v.currentSubmissionId === a3}/${v.finalSubmissionId === a1}/${v.deliveredAt?.toISOString()}`);
    const row = await mikeRow(aVideo);
    c.ok("list: Needs your review, needs a decision, an Updated version", row?.state === "FOR_REVIEW" && row.needsDecision && row.updated, `${row?.state}/${row?.needsDecision}/${row?.updated}`);
    c.ok("  …never 'approved' (v3 has no approval of its own)", row?.approved === false);
    c.ok("thumbnail: NOT v1's Aryeo frame (was the list's poster over v3)", row?.thumb === null, row?.thumb ?? "null");
    c.ok("one card for Video 2 (v1, v2, v3 and the Aryeo copy are one video)", (await cv.portalVideoList(mikePair, { perPage: 60 })).rows.filter((r) => /Video 2/.test(r.title)).length === 1);

    const e = await ce.videoEntitlement(v);
    c.ok("release rule: v3 is current and AWAITING; v1 (approved) is the file", e.current?.submissionId === a3 && e.current.state === "AWAITING" && e.file?.submissionId === a1 && e.priorVersion === true, `${e.current?.state}/${e.file?.submissionId === a1}`);
    c.ok("  …told 'This is the version you approved. The newer version is waiting…'", e.why === ce.WHY.PRIOR);
    c.ok("v3 cannot be downloaded before it is approved; v1 can", !(await ce.cutDownloadableFor(mikePair, a3)) && (await ce.cutDownloadableFor(mikePair, a1)));
    const res = await door(aVideo, mikeSeat);
    c.ok("download door: 302 to v1's file, never v3", res.status === 302 && (res.headers.get("location") ?? "").includes(`/api/review/cut/${a1}/stream`), `${res.status} ${res.headers.get("location")}`);

    const kit = await pk.postingKitFor(mikeOwner, v);
    c.ok("posting kit: the prior version, approved by him, v1", kit.prior?.version === 1 && kit.prior.approved === true && kit.final?.submissionId === a1, JSON.stringify(kit.prior));
    c.ok("  …its cover is v1's own frame (the file handed over IS v1)", kit.cover === "https://image.mux.com/MIKE-V2-V1/thumbnail.jpg", kit.cover ?? "null");

    const hist = await cd.cutHistory(mikeOwner, a3);
    const cur = hist.find((h) => h.isCurrent);
    c.ok("the player plays v3 ('Version 2' to him: v2 never left the building)", cur?.submissionId === a3 && !!cur.assetUrl && cur.clientVersion === 2 && cur.clientState === "AWAITING_YOUR_DECISION", `${cur?.clientVersion}/${cur?.clientState}`);
    c.ok("  …v1 is listed as replaced, with his approval kept on record", hist.find((h) => h.submissionId === a1)?.clientState === "SUPERSEDED" && hist.find((h) => h.submissionId === a1)!.decisions.some((d) => d.decision === "APPROVE"));
    const files = await ce.clientCutFiles([a3]);
    c.ok("  …and the stream hands a portal viewer v3's verified 1080p file", files.get(a3)?.kind === "processed");

    // Every surface the client reads.
    const att = await cv.libraryAttention(mikePair);
    c.ok("Home: Video 2 and Video 5 wait on him (2 to review)", att.needReview === 2, JSON.stringify(att));
    const counts = (await cv.programCountsByMonth(mike.enrollmentId, ["2026-10"])).get("2026-10")!;
    c.ok("month count: Video 2 is NOT delivered while v3 is open (Videos 1, 3, 4 are)", counts.delivered === 3 && counts.total === 5, JSON.stringify(counts));
    const prog = (await mp.monthProgress(mike.enrollmentId, mike.monthId))!;
    c.ok("month progress: 3 delivered, 2 awaiting him, the count is known (not 'still adding')", prog.production.delivered === 3 && prog.production.awaitingClient === 2 && prog.production.known, `${prog.production.delivered}/${prog.production.awaitingClient}/${prog.production.known}`);
    const home = mp.clientMonthProgress(prog);
    c.ok("Home's month card: 3 of 5 delivered, 2 in production or review", home.production.delivered === 3 && home.production.inProduction === 2, JSON.stringify(home.production));

    // The pages themselves.
    const detailTree = await PortalPage({ viewer: mikeOwner, path: "/portal/me", query: { tab: "videos", v: aVideo } });
    const detail = find(detailTree, "VideoDetailV2")[0]?.props.d;
    c.ok("video page data: Needs your review, updated, no stale poster", detail?.video.state === "FOR_REVIEW" && detail.video.updated === true && detail.poster === null, `${detail?.video.state}/${detail?.video.updated}/${detail?.poster}`);
    const shown = say(VideoDetailV2({ d: detail, href }));
    c.ok("video page words: 'Needs your review' and 'Updated version', never 'Delivered'", /Needs your review/.test(shown) && /Updated version/.test(shown) && !/Delivered/.test(shown), shown.slice(0, 220));
    const kitPanel = find(VideoDetailV2({ d: detail, href }), "PostingKitPanel")[0]?.props;
    c.ok("download button: 'Download the version you approved (v1)'", kitPanel?.finalLabel === "the version you approved (v1)" && !!kitPanel.downloadHref, kitPanel?.finalLabel);
    const review = find(VideoDetailV2({ d: detail, href }), "CutReview")[0]?.props;
    c.ok("the review panel plays v3, with no poster, and is not the staff panel", review?.versions.find((x: { isCurrent: boolean }) => x.isCurrent)?.submissionId === a3 && review.poster === null && review.staff === false);

    const libTree = await PortalPage({ viewer: mikeOwner, path: "/portal/me", query: { tab: "videos" } });
    const lib = find(libTree, "LibraryV2")[0]?.props.d;
    const libWords = say(LibraryV2({ d: lib, failed: false, href }));
    c.ok("Library: Video 2 under 'Needs your review' as an Updated version", lib?.view.review.some((r: { id: string }) => r.id === aVideo) && /Updated version/.test(libWords), `${lib?.view.review.length} in review`);
    const v2Row = say(LibraryV2({ d: { ...lib, view: { ...lib.view, review: lib.view.review.filter((r: { id: string }) => r.id === aVideo), rows: [] } }, failed: false, href }));
    c.ok("  …its row never says 'Delivered'", !/Delivered/.test(v2Row), v2Row.slice(0, 200));

    const homeTree = await PortalPage({ viewer: mikeOwner, path: "/portal/me", query: { tab: "home" } });
    const homeV2 = find(homeTree, "HomeV2")[0]?.props;
    c.ok("Home's next step asks him to review (2 waiting)", homeV2?.actions.primary?.kind === "REVIEW_VIDEOS" && homeV2.actions.primary.count === 2, `${homeV2?.actions.primary?.kind} ${homeV2?.actions.primary?.count}`);
    c.ok("Home's month meter reads 3 delivered", homeV2?.d.program?.delivered === 3, JSON.stringify(homeV2?.d.program));

    // The office's two windows on the same video.
    const staffTree = await PortalPage({ viewer: mikeStaff, path: "/portal/[token]", query: { tab: "videos", v: aVideo } });
    const staffDetail = find(staffTree, "VideoDetailV2")[0]?.props.d;
    c.ok("staff iframe: the same 'Needs your review' + Updated version", staffDetail?.video.state === "FOR_REVIEW" && staffDetail.video.updated === true && staffDetail.staff === true);
    const tab = await loadContentTab(mike.enrollmentId, mike.clientId, null);
    const officeRow = tab.rows.find((r) => r.id === aVideo);
    c.ok("office content workspace: 'client sees: Needs your review · updated version'", officeRow?.clientSees?.label === "Needs your review" && officeRow.clientSees.updated === true, JSON.stringify(officeRow?.clientSees));
  }

  // =========================================================================
  c.head("C · Video 5: released, no decision → Needs your review, nothing to download");
  // =========================================================================
  {
    const v = await videoOf(c1);
    const row = await mikeRow(v.id);
    c.ok("list: Needs your review, not updated, not downloadable", row?.state === "FOR_REVIEW" && !row.updated && !row.downloadable, `${row?.state}/${row?.updated}/${row?.downloadable}`);
    const kit = await pk.postingKitFor(mikeOwner, v);
    c.ok("posting kit: closed, with the approve sentence", !kit.access.download && kit.access.why === ce.WHY.AWAITING && kit.prior === null);
  }

  // =========================================================================
  c.head("A4 · Mike approves v3: it is the final everywhere and replaces v1");
  // =========================================================================
  {
    const cap = await pk.saveCaptionEdit(mikeOwner, aVideo, { kind: "CAPTION", body: "Caption written for v1" });
    c.ok("(a caption he wrote against v1 while v3 waited)", cap.ok, cap.message);
    const r = await cd.approveCut(mikeOwner, a3, "NONE");
    c.ok("Mike approves v3", r.ok, r.message);
    await mikeSync();
    const v = await prisma.contentVideo.findUniqueOrThrow({ where: { id: aVideo } });
    c.ok("row: APPROVED, approved and final = v3", v.status === "APPROVED" && v.approvedSubmissionId === a3 && v.finalSubmissionId === a3, `${v.status}/${v.approvedSubmissionId === a3}/${v.finalSubmissionId === a3}`);
    const row = await mikeRow(aVideo);
    c.ok("list: Approved, downloadable, no longer an updated version", row?.state === "APPROVED" && row.downloadable && !row.updated, `${row?.state}/${row?.updated}`);
    const e = await ce.videoEntitlement(v);
    c.ok("the file is v3, its verified 1080p render, labelled as approved", e.file?.submissionId === a3 && !!e.file.processed && e.file.label === "v2 (approved)" && !e.priorVersion, `${e.file?.label}/${!!e.file?.processed}`);
    const res = await door(aVideo, mikeSeat);
    c.ok("download door: 302 to v3", res.status === 302 && (res.headers.get("location") ?? "").includes(`/api/review/cut/${a3}/stream`), res.headers.get("location") ?? "");
    c.ok("v1 is no longer handed out", !(await ce.cutDownloadableFor(mikePair, a1)));
    const kit = await pk.postingKitFor(mikeOwner, v);
    c.ok("posting kit: no 'earlier version' label; captions follow v3", kit.prior === null && kit.final?.submissionId === a3 && kit.access.captions);
    const v1Caps = await prisma.contentCaptionDraft.findMany({ where: { videoId: aVideo, submissionId: a1 } });
    c.ok("the caption written for v1 is STALE ('cut changed')", v1Caps.length === 1 && v1Caps[0].status === "STALE", v1Caps.map((x) => x.status).join(","));
    c.ok("the cover is not v1's frame any more", kit.cover === null, kit.cover ?? "null");
    const counts = (await cv.programCountsByMonth(mike.enrollmentId, ["2026-10"])).get("2026-10")!;
    c.ok("the month counts Video 2 delivered again (4 of 5)", counts.delivered === 4, JSON.stringify(counts));
    c.ok("still one card for Video 2", (await cv.portalVideoList(mikePair, { perPage: 60 })).rows.filter((r) => /Video 2/.test(r.title)).length === 1);

    // v3 later delivered to Aryeo too: the new file joins the same video.
    const before = await prisma.contentVideo.count({ where: { enrollmentId: mike.enrollmentId, status: { not: "ARCHIVED" } } });
    await aryeoRow(mf, "MIKE-V2-V3", "Mike Video 2 V3", new Date());
    await mikeSync();
    const after = await prisma.contentVideo.count({ where: { enrollmentId: mike.enrollmentId, status: { not: "ARCHIVED" } } });
    c.ok("v3 delivered on Aryeo later: no second card", after === before, `${before} → ${after}`);
    c.ok("  …and its own frame is now the poster", (await mikeRow(aVideo))?.thumb === "https://image.mux.com/MIKE-V2-V3/thumbnail.jpg", (await mikeRow(aVideo))?.thumb ?? "null");
  }

  // =========================================================================
  // Bernadette
  // =========================================================================
  const ber = await buildContentMonth(prisma as unknown as PrismaClient, {
    name: "Bernadette Rabel TEST", package: "Accelerator", monthKey: "2026-10",
    project: { status: "EDITING", shootDate: DAY("2026-10-06") }, owner: { email: "bernadette@example.com", name: "Bernadette Rabel" },
  });
  const berPair = { id: ber.enrollmentId, clientId: ber.clientId };
  const berOwner = viewerOf(ber, { kind: "CLIENT", clientUserId: ber.clientUserId!, email: "bernadette@example.com", name: "Bernadette Rabel", membershipId: ber.membershipId!, membershipRole: "OWNER" } as PortalViewer["actor"]);
  const berStaff = viewerOf(ber, { kind: "STAFF", staffUserId: kyle.id, staffName: "Kyle Drill", staffRole: "ADMIN" } as PortalViewer["actor"]);
  const BP = ber.projectId!, BD = ber.deliverableId!;
  const berSync = () => cv.syncEnrollmentVideos(berPair);
  const berRow = async (videoId: string) => (await cv.portalVideoList(berPair, { perPage: 60 })).rows.find((r) => r.id === videoId);
  const b1 = await mkCut({ projectId: BP, deliverableId: BD, slot: 4, round: 1, fileName: "Bernadette Video 4 v1.mov", createdAt: DAY("2026-10-08"), decidedAt: DAY("2026-10-09"), clientReleasedAt: DAY("2026-10-09") });
  const e1 = await mkCut({ projectId: BP, deliverableId: BD, slot: 2, round: 1, fileName: "Bernadette Video 2 v1.mov", createdAt: DAY("2026-10-08"), decidedAt: DAY("2026-10-09"), clientReleasedAt: DAY("2026-10-09") });
  for (const id of [b1, e1]) await rw.openReviewWindow(id, { by: "drill" });
  await berSync();

  // =========================================================================
  c.head("B · Bernadette Video 4: the office records changes for her, v2 is published");
  // =========================================================================
  const bVideo = (await videoOf(b1)).id;
  let b2 = "";
  {
    const r = await cd.requestChangesOnCut(berStaff, b1, "She called: shorten the intro.");
    c.ok("the office sends changes on v1 'on behalf of' her", r.ok, r.message);
    const d = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: b1, decision: "REQUEST_CHANGES" } });
    c.ok("  …recorded as Kyle (on behalf of Bernadette)", d.staffUserId === kyle.id && d.actorLabel === `Kyle Drill (on behalf of ${ber.clientName})`, d.actorLabel);
    await berSync();
    c.ok("while the editor works: Changes in progress", (await berRow(bVideo))?.state === "CHANGES_IN_PROGRESS");
    b2 = await mkCut({ projectId: BP, deliverableId: BD, slot: 4, round: 2, fileName: "Bernadette Video 4 v2.mov", createdAt: DAY("2026-10-14"), decidedAt: DAY("2026-10-15"), clientReleasedAt: DAY("2026-10-15") });
    await rw.openReviewWindow(b2, { by: "drill" });
    await berSync();
    const row = await berRow(bVideo);
    c.ok("v2 published: Needs your review", row?.state === "FOR_REVIEW" && row.currentSubmissionId === b2, row?.state);
    c.ok("  …not an updated version, nothing to download (she never had v1)", !row?.updated && !row?.downloadable);
    const kit = await pk.postingKitFor(berOwner, await prisma.contentVideo.findUniqueOrThrow({ where: { id: bVideo } }));
    c.ok("  …the kit stays closed with the approve sentence", !kit.access.download && kit.prior === null && kit.access.why === ce.WHY.AWAITING);
  }

  // =========================================================================
  c.head("B2 · Bernadette Video 2: revisions AFTER she approved (Jordan's case)");
  // =========================================================================
  const eVideo = (await videoOf(e1)).id;
  let e2 = "";
  {
    const a = await cd.approveCut(berOwner, e1, "NONE");
    c.ok("Bernadette approves v1", a.ok, a.message);
    const r = await cd.requestChangesOnCut(berStaff, e1, "Revisions after her approval: swap the closing shot.");
    c.ok("the office then records changes on the approved v1 for her (a reopen)", r.ok, r.message);
    const approval = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: e1, decision: "APPROVE" } });
    c.ok("  …her approval is set aside, pointing at the request", !!approval.supersededById && approval.receiptState === "SUPERSEDED");
    await berSync();
    const mid = await berRow(eVideo);
    c.ok("while the editor works: Changes in progress, and v1 still hers to download", mid?.state === "CHANGES_IN_PROGRESS" && mid.downloadable, `${mid?.state}/${mid?.downloadable}`);
    e2 = await mkCut({ projectId: BP, deliverableId: BD, slot: 2, round: 2, fileName: "Bernadette Video 2 v2.mov", createdAt: DAY("2026-10-16"), decidedAt: DAY("2026-10-17"), clientReleasedAt: DAY("2026-10-17") });
    await rw.openReviewWindow(e2, { by: "drill" });
    await berSync();
    const v = await prisma.contentVideo.findUniqueOrThrow({ where: { id: eVideo } });
    const row = await berRow(eVideo);
    c.ok("v2 published: Needs your review, an Updated version", row?.state === "FOR_REVIEW" && row.updated && row.needsDecision, `${row?.state}/${row?.updated}`);
    c.ok("v2 is NEVER silently approved: no approval pointer, list not approved, status CLIENT_REVIEW", v.approvedSubmissionId === null && row?.approved === false && v.status === "CLIENT_REVIEW", `${v.approvedSubmissionId}/${v.status}`);
    const e = await ce.videoEntitlement(v);
    c.ok("release rule: v2 AWAITING, v1 (her approval) is the file", e.current?.submissionId === e2 && e.current.state === "AWAITING" && e.file?.submissionId === e1 && e.basis === "CLIENT_APPROVED" && e.priorVersion === true, `${e.current?.state}/${e.basis}`);
    c.ok("  …(the Oct 20 rule dropped it: her latest word on v1 was the request)", ce.foldDecisions([{ id: approval.id, submissionId: e1, decision: "APPROVE", actorLabel: "x", decidedAt: approval.decidedAt, contentHash: approval.contentHash }, { id: "zzzzzzzzzzzz", submissionId: e1, decision: "REQUEST_CHANGES", actorLabel: "x", decidedAt: new Date(approval.decidedAt.getTime() + 1000), contentHash: null }]).approvals.has(e1) === false);
    c.ok("v2 cannot be downloaded; v1 can", !(await ce.cutDownloadableFor(berPair, e2)) && (await ce.cutDownloadableFor(berPair, e1)));
    const kit = await pk.postingKitFor(berOwner, v);
    c.ok("kit: 'the version you approved (v1)'", kit.prior?.version === 1 && kit.prior.approved && kit.final?.approvedByLabel === "Bernadette Rabel", `${JSON.stringify(kit.prior)} ${kit.final?.approvedByLabel}`);
    c.ok("her approval stays on record in the version history", !!(await cd.cutHistory(berOwner, e2)).find((h) => h.submissionId === e1)?.decisions.some((d) => d.decision === "APPROVE" && d.actorLabel === "Bernadette Rabel"));
    c.ok("not counted delivered, not counted client-approved", !cv.isDeliveredProgramVideo(v) && (await mp.monthProgress(ber.enrollmentId, ber.monthId))!.production.clientApproved === 0);
  }

  // =========================================================================
  c.head("R · recording a client's approval given outside the portal");
  // =========================================================================
  {
    const none = await cd.approveCut(berStaff, b2, "NONE");
    c.ok("staff with no note: refused, nothing approved", !none.ok && none.message === cd.ON_BEHALF_NOTE_NEEDED, none.message);
    c.ok("  …no decision row was written", (await prisma.clientDecision.count({ where: { submissionId: b2, decision: "APPROVE" } })) === 0);

    // Through the real portal actions, as each kind of visitor.
    jar.set(CLIENT_COOKIE, await signClientSession({ cu: ber.clientUserId!, email: "bernadette@example.com" }));
    const asClient = await actions.portalRecordClientApproval({ enrollmentId: ber.enrollmentId }, b2, "NONE", "by text, Oct 15");
    c.ok("her own login: refused (she approves for herself)", !asClient.ok && /Only our team/.test(asClient.message), asClient.message);
    jar.delete(CLIENT_COOKIE);
    const asLink = await actions.portalRecordClientApproval({ token: ber.portalToken }, b2, "NONE", "by text, Oct 15");
    c.ok("the shared link: refused", !asLink.ok, asLink.message);
    c.ok("  …still no approval on v2", (await prisma.clientDecision.count({ where: { submissionId: b2, decision: "APPROVE" } })) === 0);

    jar.set(SESSION_COOKIE, await signSession({ uid: kyle.id, email: "kyle@realtourpilot.com", role: "ADMIN", permissions: null }));
    const old = await actions.portalApproveCut({ token: ber.portalToken }, b2, "NONE");
    c.ok("staff pressing the old 'Approve this version': refused without a note", !old.ok && old.message === cd.ON_BEHALF_NOTE_NEEDED, old.message);
    const short = await actions.portalRecordClientApproval({ token: ber.portalToken }, b2, "NONE", "yes");
    c.ok("staff with a too-short note: refused", !short.ok && short.message === cd.ON_BEHALF_NOTE_NEEDED, short.message);
    const ok = await actions.portalRecordClientApproval({ token: ber.portalToken }, b2, "NONE", "  By text,   Oct 15 ");
    c.ok("staff with 'by text, Oct 15': recorded", ok.ok, ok.message);
    jar.delete(SESSION_COOKIE);
    const d = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: b2, decision: "APPROVE" } });
    c.ok("the decision: Kyle's login, 'Kyle Drill (on behalf of Bernadette…)', basis STAFF, the note", d.staffUserId === kyle.id && d.clientUserId === null && d.actorLabel === `Kyle Drill (on behalf of ${ber.clientName})` && d.basis === "STAFF" && d.note === "By text, Oct 15", `${d.actorLabel} · ${d.basis} · ${d.note}`);
    const audit = await prisma.auditLog.findFirst({ where: { action: "client_approval_recorded", target: b2 } });
    c.ok("audited: who, which client and version, and how they approved", !!audit && audit.actor === "kyle@realtourpilot.com" && audit.detail.includes(`${ber.clientName}'s approval of version 2`) && audit.detail.includes("By text, Oct 15"), audit?.detail);
    c.ok("  …and on the job's timeline", (await prisma.activity.count({ where: { projectId: BP, body: { contains: "How they approved: By text, Oct 15" } } })) === 1);
    await berSync();
    const row = await berRow(bVideo);
    c.ok("Video 4 now reads Approved and is hers to download", row?.state === "APPROVED" && row.downloadable, `${row?.state}/${row?.downloadable}`);

    // The staff panel offers the recording; the client's page never does.
    const staffTree = await PortalPage({ viewer: berStaff, path: "/portal/[token]", query: { tab: "videos", v: eVideo } });
    const staffReview = find(VideoDetailV2({ d: find(staffTree, "VideoDetailV2")[0]?.props.d, href }), "CutReview")[0]?.props;
    const clientTree = await PortalPage({ viewer: berOwner, path: "/portal/me", query: { tab: "videos", v: eVideo } });
    const clientReview = find(VideoDetailV2({ d: find(clientTree, "VideoDetailV2")[0]?.props.d, href }), "CutReview")[0]?.props;
    const linkTree = await PortalPage({ viewer: viewerOf(ber, { kind: "TOKEN" } as PortalViewer["actor"]), path: "/portal/[token]", query: { tab: "videos", v: eVideo } });
    const linkReview = find(VideoDetailV2({ d: find(linkTree, "VideoDetailV2")[0]?.props.d, href }), "CutReview")[0]?.props;
    c.ok("the staff iframe gets the 'record the client's approval' panel", staffReview?.staff === true && staffReview.perms.approve === true);
    c.ok("  …her own login and the shared link never do", clientReview?.staff === false && linkReview?.staff === false && linkReview.perms.approve === false);
  }

  // =========================================================================
  c.head("L · a re-delivered file of the same video joins it, never a second card");
  // =========================================================================
  {
    const f1 = await mkCut({ projectId: BP, deliverableId: BD, slot: 3, round: 1, fileName: "Bernadette Video 3 v1.mov", createdAt: DAY("2026-10-08"), decidedAt: DAY("2026-10-09"), clientReleasedAt: DAY("2026-10-09") });
    await rw.openReviewWindow(f1, { by: "drill" });
    const bf = { enrollmentId: ber.enrollmentId, monthId: ber.monthId, projectId: BP };
    // Both files are new to the library on the same sync: the original and its re-edit.
    await aryeoRow(bf, "BER-V3-A", "Bernadette Video 3", DAY("2026-10-10"));
    await aryeoRow(bf, "BER-V3-B", "Bernadette Video 3 v2", DAY("2026-10-12"));
    await berSync();
    const vid = (await videoOf(f1)).id;
    const links = await prisma.contentVideoSource.findMany({ where: { kind: "PORTAL_VIDEO", ref: { in: ["aryeo:L-BER-V3-A:BER-V3-A", "aryeo:L-BER-V3-B:BER-V3-B"] } }, select: { videoId: true } });
    c.ok("both delivered files link to the one Video 3 (the second used to be minted as its own card)", links.length === 2 && links.every((l) => l.videoId === vid), links.map((l) => l.videoId === vid).join(","));
    const rows = (await cv.portalVideoList(berPair, { perPage: 60 })).rows.filter((r) => /Video 3/.test(r.title));
    c.ok("  …one card, its poster the newer file's", rows.length === 1 && rows[0].thumb === "https://image.mux.com/BER-V3-B/thumbnail.jpg", `${rows.length} ${rows[0]?.thumb}`);
  }

  // =========================================================================
  c.head("P · the pure rule");
  // =========================================================================
  {
    const base = { projectId: "p", status: "APPROVED", decidedBy: "Jordan", clientRequestedAt: null, completedAt: null, sentToClientAt: null, assetUrl: "/api/review/cut/x/stream", assetPath: null, finalPath: "/Final/x.mov", blobUrl: "https://b/x", blobPathname: "x", sizeBytes: 5, fileName: "x.mov", contentHash: null, deliverableId: "d", slot: 1 };
    const r1 = { ...base, id: "pr1aaaaaaaaaaaa1", round: 1, createdAt: DAY("2026-10-01"), decidedAt: DAY("2026-10-02"), clientReleasedAt: DAY("2026-10-02") };
    const r2 = { ...base, id: "pr2aaaaaaaaaaaa2", round: 2, createdAt: DAY("2026-10-10"), decidedAt: DAY("2026-10-11"), clientReleasedAt: DAY("2026-10-11") };
    const facts = (over: Partial<Parameters<typeof ce.decideEntitlement>[0]>) => ({ chain: [r1, r2], approvals: new Map(), changeRequests: new Set<string>(), projectDelivered: false, projectDeliveredAt: null, monthHistorical: false, aryeoFinal: null, ...over });
    const appr = (row: typeof r1, basis?: string, supersededById?: string) => ce.approvalsOnRecord([{ id: `d-${row.id}`, submissionId: row.id, decision: "APPROVE", actorLabel: "Ada", decidedAt: DAY("2026-10-03"), contentHash: ce.stableCutIdentity(row), basis, supersededById }]);
    const sentBack = ce.decideEntitlement(facts({ changeRequests: new Set([r1.id]), priorApprovals: appr(r1, "CLIENT", "req") }));
    c.ok("approved v1, then changes asked on it, v2 awaiting → v1 served", sentBack.file?.submissionId === r1.id && sentBack.current?.submissionId === r2.id && sentBack.priorVersion === true);
    const lost = ce.decideEntitlement(facts({ changeRequests: new Set([r1.id]), priorApprovals: appr(r1, "AUTO_EXPIRY", "req") }));
    c.ok("an AUTOMATIC approval the client's request replaced is not on record → nothing served", lost.file === null && lost.blockedBy === "AWAITING_DECISION");
    const neverApproved = ce.decideEntitlement(facts({ changeRequests: new Set([r1.id]) }));
    c.ok("a v1 they sent back without approving → nothing served", neverApproved.file === null);
    const reopenedLone = ce.decideEntitlement(facts({ chain: [{ ...r1, status: "CHANGES_REQUESTED" }], approvals: appr(r1) }));
    c.ok("a released v1 back with the editor (reopen) never reads approved", reopenedLone.current?.state === "CHANGES_REQUESTED", reopenedLone.current?.state);
    const sentReopened = ce.decideEntitlement(facts({ chain: [{ ...r1, status: "CHANGES_REQUESTED", sentToClientAt: DAY("2026-10-04") }] }));
    c.ok("a delivered v1 reopened by text: changes in progress, the delivered file stays theirs", sentReopened.current?.state === "CHANGES_REQUESTED" && sentReopened.file?.submissionId === r1.id && sentReopened.why === ce.priorWhy(false, "CHANGES_REQUESTED", true), sentReopened.why ?? "");
    const sentRejected = ce.decideEntitlement(facts({ chain: [{ ...r1, status: "CHANGES_REQUESTED", sentToClientAt: DAY("2026-10-04") }], changeRequests: new Set([r1.id]) }));
    c.ok("…but one the client sent back in the portal is not served (CP-01)", sentRejected.file === null && sentRejected.blockedBy === "CHANGES_REQUESTED");
    c.ok("the earlier-version notes: approved/awaiting is WHY.PRIOR; delivered says so", ce.priorWhy(true, "AWAITING_DECISION", false) === ce.WHY.PRIOR && /^This is the version we delivered to you\./.test(ce.priorWhy(false, "AWAITING_DECISION", false)));
    c.ok("no em dash in any of the client sentences", [true, false].flatMap((a) => (["AWAITING_DECISION", "CHANGES_REQUESTED", "FINISHING"] as const).flatMap((b) => [ce.priorWhy(a, b, false), ce.priorWhy(a, b, true)])).every((s) => !s.includes("—")) && !cd.ON_BEHALF_NOTE_NEEDED.includes("—"));
  }

  c.head("isolation");
  c.ok("no outbound call left the process", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("no Prisma error was logged", quiet.count === 0, `${quiet.count}`);
  console.log(`  (model stub asked ${aiCalls} time${aiCalls === 1 ? "" : "s"}; it answers nothing)`);

  quiet.restore();
  c.summary();
  await stop();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { fence.restore(); process.exit(process.exitCode ?? 0); });
