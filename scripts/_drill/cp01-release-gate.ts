// ---------------------------------------------------------------------------
// DRILL: CP-01 — one release rule for review, approval, download and captions
// (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp01-release-gate.ts
//
// THE DEFECT. "A completed production file and a client-approved video are
// different facts", and the portal treated them as one. resolveFinalFile
// served `finalSubmissionId ?? approvedSubmissionId`; the sync set
// finalSubmissionId to the newest cut with completedAt, which the Review
// Room's own approve stamps. So an internally approved cut the client never
// decided on downloaded and captioned, a replacement round inherited the lot,
// the stream route's `dl=1` was a second ungated door, a client's change
// request on a finished cut still read DELIVERED with "Download and post", and
// every approval's identity hash included the blob URL the 90-day prune clears.
//
// Each section states the OLD answer first — reproduced on the same fixture by
// the pre-change rule, copied inline below from the removed source — then
// drives the SHIPPED code: the routes' GET handlers with real NextRequests,
// the portal library readers, approveCut, and the caption draft/save paths.
//
//   T1  internal approval only: playable, not downloadable, not captionable
//   T2  client approval unlocks download (door → stream 200 attachment) + captions
//   T3  a replacement needs its own decision; the old approval is superseded
//   T4  a client change request never reads DELIVERED / "Download and post"
//   T5  identity survives the storage prune; a changed file is HASH_DRIFT (409)
//   T6  historical and outside-the-portal deliveries stay downloadable, ENDED too
//   T7  legacy file-name chains: the older round cannot be approved
//   T8  staff scope sees the client's truth; hub staff playback/download ungated
//   T9  the Sep 24 review: pre-gate finished cuts on an open project, paused
//       and ended programs, list-position pairing on old deliveries, legacy
//       approvals after the store cutover, a dangling library pointer
//   P   the pure rule's remaining branches (pairing by list position)
//
// ISOLATION. _harness.ts: PGlite on 127.0.0.1:5501, every .env secret blanked,
// fetch AND raw sockets fenced. The hub store's public blob host is answered
// by a canned 5-byte "video" and counted; the model is stubbed at
// aiJsonWithUsage, so the run ledger and the caption rows are the real code.
// No provider is reached and no message is sent.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";
import type { MediaScope } from "@/lib/portalMedia";

const PORT = Number(process.env.DRILL_PORT ?? 5501);

installNextStubs();

// The model, and only the model: runAiJson's ledger and the caption rows are real.
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async () => {
        aiCalls++;
        return {
          result: { caption: "The first weekend decides your price. Here's why.", shorterCaption: "Price it right on day one.", ctaOptions: ["Save this for your listing day"], coverTitles: ["First weekend"], captionCta: null, gaps: [] },
          usage: { inputTokens: 900, outputTokens: 120 }, model: "drill-stub",
        };
      };
    },
  }),
);

// The hub store's public host answers with a canned 5-byte file; everything else is blocked.
const fence = fenceFetch((url) =>
  /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url)
    ? new Response("abcde", { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" } })
    : null,
);

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const ce = await import("@/lib/cutEntitlement");
  const cv = await import("@/lib/contentVideos");
  const cd = await import("@/lib/clientDecisions");
  const pk = await import("@/lib/postingKit");
  const { mediaToken } = await import("@/lib/portalMedia");
  const { cutIdentityHash } = await import("@/lib/cutTranscripts");
  const { cutKeyOf, streamUrlFor } = await import("@/lib/reviewCuts");
  const { NextRequest } = await import("next/server");
  const downloadRoute = await import("@/app/api/portal/download/[videoId]/route");
  const streamRoute = await import("@/app/api/review/cut/[id]/stream/route");
  const { portalDraftCaption } = await import("@/app/portal/actions");

  // ---- helpers -------------------------------------------------------------
  const BLOB = (id: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${id}.mp4`;
  async function mkCut(o: {
    projectId: string; deliverableId?: string | null; slot?: number; round: number; fileName: string; status?: string;
    decidedAt?: Date | null; completedAt?: Date | null; createdAt?: Date; sentToClientAt?: Date | null; clientRequestedAt?: Date | null;
    blob?: boolean; assetPath?: string | null; finalPath?: string | null;
  }): Promise<string> {
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: o.projectId, deliverableId: o.deliverableId ?? null, slot: o.slot ?? 1, round: o.round, fileName: o.fileName, status: o.status ?? "APPROVED",
        decidedBy: "Jordan", decidedAt: o.decidedAt === undefined ? new Date() : o.decidedAt, completedAt: o.completedAt ?? null, source: "upload", sizeBytes: 5,
        assetPath: o.assetPath ?? null, finalPath: o.finalPath === undefined ? `/Final/${o.fileName}` : o.finalPath, sentToClientAt: o.sentToClientAt ?? null,
        clientRequestedAt: o.clientRequestedAt ?? null, ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({
      where: { id: row.id },
      data: { assetUrl: streamUrlFor(row.id), ...(o.blob === false ? {} : { blobUrl: BLOB(row.id), blobPathname: `review-cuts/${row.id}.mp4` }) },
    });
    return row.id;
  }
  const videoOfCut = async (subId: string) => {
    const s = await prisma.reviewSubmission.findUnique({ where: { id: subId }, select: { videoId: true } });
    return prisma.contentVideo.findUniqueOrThrow({ where: { id: s!.videoId! } });
  };
  const door = (videoId: string, scope: MediaScope) =>
    downloadRoute.GET(new NextRequest(`http://127.0.0.1/api/portal/download/${videoId}?m=${encodeURIComponent(mediaToken(videoId, scope))}`), { params: Promise.resolve({ videoId }) });
  const streamAt = (subId: string, url: string) => streamRoute.GET(new NextRequest(url), { params: Promise.resolve({ id: subId }) });
  const stream = (subId: string, scope: MediaScope | null, dl: boolean) =>
    streamAt(subId, `http://127.0.0.1${streamUrlFor(subId)}?${scope ? `m=${encodeURIComponent(mediaToken(subId, scope))}` : "x=1"}${dl ? "&dl=1" : ""}`);
  const errorOf = async (r: Response) => ((await r.clone().json().catch(() => ({}))) as { error?: string }).error ?? "";
  const disposition = (r: Response) => r.headers.get("content-disposition") ?? "";

  // THE OLD RULE, copied from the removed code so each section can show what
  // it would have answered on this very fixture (pre-CP-01 postingKit
  // resolveFinalFile + contentVideos deriveStatus/stateOf, with the old sync's
  // pointer choices: final = newest completedAt, approved = newest released
  // cut carrying clientApprovedDecisionId).
  async function oldServed(anyCutId: string): Promise<{ submissionId: string; hashOk: boolean } | null> {
    const chain = await ce.cutChainOf(anyCutId);
    const rows = await prisma.reviewSubmission.findMany({ where: { id: { in: chain.map((r) => r.id) } }, orderBy: [{ round: "asc" }, { createdAt: "asc" }] });
    const finalCut = [...rows].reverse().find((r) => r.completedAt) ?? null;
    const approvedCut = [...rows].reverse().find((r) => cv.cutReleasedAt(r) && r.clientApprovedDecisionId) ?? null;
    const sub = rows.find((r) => r.id === (finalCut?.id ?? approvedCut?.id));
    if (!sub?.assetUrl || !(sub.assetPath || sub.blobUrl)) return null;
    const approval = approvedCut?.id === sub.id ? await prisma.clientDecision.findFirst({ where: { submissionId: sub.id, decision: "APPROVE" }, orderBy: { decidedAt: "desc" } }) : null;
    return { submissionId: sub.id, hashOk: !approval?.contentHash || approval.contentHash === cutIdentityHash(sub) };
  }
  async function oldListState(anyCutId: string, enrollmentId: string): Promise<string> {
    const chain = await ce.cutChainOf(anyCutId);
    const rows = await prisma.reviewSubmission.findMany({ where: { id: { in: chain.map((r) => r.id) } }, orderBy: [{ round: "asc" }, { createdAt: "asc" }] });
    const released = rows.filter((r) => cv.cutReleasedAt(r));
    const latest = released[released.length - 1];
    const delivered = rows.some((r) => r.completedAt);
    const status = latest?.clientApprovedDecisionId && delivered ? "DELIVERED" : latest?.clientApprovedDecisionId ? "APPROVED" : delivered ? "DELIVERED" : latest ? (latest.status === "CHANGES_REQUESTED" ? "EDITING" : "CLIENT_REVIEW") : "EDITING";
    const current = latest?.id ?? null;
    const approvedId = [...released].reverse().find((r) => r.clientApprovedDecisionId)?.id ?? null;
    const decided = current ? (await prisma.clientDecision.count({ where: { enrollmentId, submissionId: current } })) > 0 : false;
    if (status === "DELIVERED" && (approvedId || !current || decided)) return "DELIVERED";
    if (approvedId && approvedId === current) return "APPROVED";
    if (status === "EDITING" && current) return "CHANGES_IN_PROGRESS";
    if (current && !decided) return "FOR_REVIEW";
    return status === "DELIVERED" ? "DELIVERED" : current ? "CHANGES_IN_PROGRESS" : "IN_PRODUCTION";
  }

  // ---- the fixture -----------------------------------------------------------
  const ada = await buildContentMonth(prisma as unknown as PrismaClient, {
    name: "Ada Vance TEST", package: "Starter", monthKey: "2026-09",
    project: { status: "SCHEDULED", shootDate: new Date("2026-09-10T14:00:00Z") },
    owner: { email: "ada@example.com", name: "Ada Vance" },
  });
  await prisma.programAutomation.create({ data: { key: "caption_assistant", enabled: true, enabledBy: "drill", enabledAt: new Date() } });
  const enrollment = { id: ada.enrollmentId, clientId: ada.clientId };
  const viewer = {
    enrollment: { id: ada.enrollmentId, clientId: ada.clientId, clientName: ada.clientName, status: "ACTIVE", videosPerMonth: ada.videosPerMonth, sessionsPerMonth: ada.sessionsPerMonth },
    actor: { kind: "CLIENT", clientUserId: ada.clientUserId!, email: "ada@example.com", name: "Ada Vance", membershipId: ada.membershipId!, membershipRole: "OWNER" },
    access: "FULL", via: "LOGIN",
  } as PortalViewer;
  const seat: MediaScope = { kind: "membership", id: ada.membershipId! };
  const owner = await prisma.appUser.create({ data: { email: "jordan@drill.invalid", name: "Jordan", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
  const staff: MediaScope = { kind: "staff", id: owner.id };
  const project = ada.projectId!;
  const reel = ada.deliverableId!;
  const sync = () => cv.syncEnrollmentVideos(enrollment);
  const rowOf = async (videoId: string) => (await cv.portalVideoList(enrollment, { perPage: 60 })).rows.find((r) => r.id === videoId);

  // =========================================================================
  c.head("T1 · internal approval only — playable for review, nothing else");
  // =========================================================================
  const v1 = await mkCut({ projectId: project, deliverableId: reel, round: 1, fileName: "ada-reel-v1.mp4", completedAt: new Date() });
  {
    const old = await oldServed(v1);
    c.ok("BEFORE: the old rule served v1 with no client decision at all", old?.submissionId === v1 && old.hashOk === true, JSON.stringify(old));
  }
  await sync();
  const video = await videoOfCut(v1);
  {
    // A released script on the video, so a caption has something factual to be drafted from once it is allowed.
    await prisma.contentScript.create({ data: { enrollmentId: ada.enrollmentId, clientId: ada.clientId, monthId: ada.monthId, videoId: video.id, title: "First weekend", body: "Your first weekend decides your price.\nPrice it right and buyers compete.\nThat's the whole game.", status: "CLIENT_VISIBLE", releaseState: "released" } });
    const e = await ce.videoEntitlement(video);
    c.ok("entitlement: NONE, awaiting the client's decision", e.basis === "NONE" && e.blockedBy === "AWAITING_DECISION", `${e.basis}/${e.blockedBy}`);
    c.ok("  …on the decisive round v1", e.current?.submissionId === v1 && e.current.state === "AWAITING");
    const row = await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } });
    c.ok("ContentVideo cache: finalSubmissionId null, status CLIENT_REVIEW", row.finalSubmissionId === null && row.status === "CLIENT_REVIEW", `${row.finalSubmissionId}/${row.status}`);
    c.ok("  …and no 'delivered' date from the internal Dropbox copy", row.deliveredAt === null);
    const lr = await rowOf(video.id);
    c.ok("library row: FOR_REVIEW, not downloadable", lr?.state === "FOR_REVIEW" && lr.downloadable === false && lr.hasFinalFile === false, `${lr?.state}/${lr?.downloadable}`);
    const att = await cv.libraryAttention(enrollment);
    c.ok("Home: 1 to review, 0 ready to use", att.needReview === 1 && att.readyToUse === 0 && att.readyWithFile === 0, JSON.stringify(att));

    const res = await door(video.id, seat);
    c.ok("download door: 403", res.status === 403, `${res.status} ${await errorOf(res)}`);
    c.ok("  …saying to approve first", (await errorOf(res)) === ce.WHY.AWAITING);
    c.ok("  …and no 'Downloaded' fact was written", (await prisma.portalVisit.count({ where: { enrollmentId: ada.enrollmentId } })) === 0);

    const play = await stream(v1, seat, false);
    c.ok("stream v1 without dl: 200 inline — review playback intact", play.status === 200 && disposition(play).startsWith("inline"), `${play.status} ${disposition(play)}`);
    const side = await stream(v1, seat, true);
    c.ok("BEFORE the side door answered dl=1 with an attachment; now 403", side.status === 403, `${side.status} ${await errorOf(side)}`);

    const d = await pk.draftCaptionForVideo(viewer, video.id);
    c.ok("caption draft refused with the approval sentence (switch is ON)", d.ok === false && d.message === ce.WHY.AWAITING, d.message);
    c.ok("  …before any model call: 0 ProgramAiRun rows, 0 model calls", (await prisma.programAiRun.count()) === 0 && aiCalls === 0);
    const s = await pk.saveCaptionEdit(viewer, video.id, { kind: "CAPTION", body: "My own caption" });
    c.ok("caption save refused too", s.ok === false && s.message === ce.WHY.AWAITING, s.message);
    const kit = await pk.postingKitFor(viewer, video);
    c.ok("posting kit: access closed, with the reason", kit.access.download === false && kit.access.captions === false && kit.access.why === ce.WHY.AWAITING && kit.final === null);
    const linkKit = await pk.postingKitFor({ ...viewer, actor: { kind: "TOKEN" }, via: "TOKEN" } as PortalViewer, video);
    c.ok("  …and to the emailed link, which cannot approve, it says who can", linkKit.access.why === ce.WHY.AWAITING_OWNER && linkKit.finalNote === ce.WHY.AWAITING_OWNER, linkKit.access.why ?? "");
    c.ok("no outbound call attempted", fence.blocked.length === 0, fence.blocked.join(", "));
  }

  // =========================================================================
  c.head("T8 · staff see the client's truth at the door; hub staff are ungated");
  // =========================================================================
  {
    const res = await door(video.id, staff);
    c.ok("download door with a STAFF scope, same state: 403", res.status === 403, `${res.status}`);
    const hub = await stream(v1, null, true);
    c.ok("hub-session stream with dl=1 (no m, no t): 200 attachment — Ready card unchanged", hub.status === 200 && disposition(hub).startsWith("attachment"), `${hub.status} ${disposition(hub)}`);
    const staffTok = await stream(v1, staff, true);
    c.ok("staff media token with dl=1: 200 — not a portal proof", staffTok.status === 200, `${staffTok.status}`);
  }

  // =========================================================================
  c.head("T2 · the client's approval unlocks download and captions");
  // =========================================================================
  {
    const r = await cd.approveCut(viewer, v1, "NONE");
    c.ok("approveCut(v1) succeeds", r.ok === true, r.message);
    const dec = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: v1, decision: "APPROVE" } });
    c.ok("the decision records a storage-independent identity (ident2:)", dec.contentHash?.startsWith("ident2:") === true, dec.contentHash ?? "null");
    const e = await ce.videoEntitlement(video);
    c.ok("entitlement: CLIENT_APPROVED on v1", e.basis === "CLIENT_APPROVED" && e.file?.submissionId === v1, `${e.basis}`);

    const res = await door(video.id, seat);
    const loc = res.headers.get("location") ?? "";
    c.ok("download door: 302 to the cut's stream with dl=1", res.status === 302 && loc.includes(`/api/review/cut/${v1}/stream?m=`) && loc.endsWith("&dl=1"), `${res.status} ${loc.slice(0, 80)}`);
    const got = await streamAt(v1, loc);
    c.ok("  …following it: 200, Content-Disposition attachment", got.status === 200 && disposition(got).startsWith("attachment"), `${got.status} ${disposition(got)}`);
    c.ok("  …and 'Downloaded' is recorded against the exact cut", (await prisma.portalVisit.count({ where: { path: `/portal/download/${video.id}?cut=${v1}` } })) === 1);

    const t = await ce.captionTarget(viewer, video);
    c.ok("captionTarget names v1", t.ok === true && t.ref === v1);
    const s = await pk.saveCaptionEdit(viewer, video.id, { kind: "CAPTION", body: "My own caption" });
    const saved = s.id ? await prisma.contentCaptionDraft.findUnique({ where: { id: s.id } }) : null;
    c.ok("a saved caption is tied to v1", s.ok === true && saved?.submissionId === v1, s.message);
    const d = await pk.draftCaptionForVideo(viewer, video.id);
    const drafts = await prisma.contentCaptionDraft.findMany({ where: { videoId: video.id, authorKind: "AI" } });
    c.ok("caption draft runs, once, and every AI draft is tied to v1", d.ok === true && aiCalls === 1 && drafts.length > 0 && drafts.every((x) => x.submissionId === v1), `${d.message} · ${drafts.length} drafts`);

    await sync();
    const row = await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } });
    c.ok("after sync: finalSubmissionId v1, approvedSubmissionId v1, status APPROVED", row.finalSubmissionId === v1 && row.approvedSubmissionId === v1 && row.status === "APPROVED", `${row.finalSubmissionId}/${row.status}`);
    const lr = await rowOf(video.id);
    c.ok("library row: APPROVED and downloadable", lr?.state === "APPROVED" && lr.downloadable === true);
    const att = await cv.libraryAttention(enrollment);
    c.ok("Home: 1 ready to use", att.readyToUse === 1 && att.readyWithFile === 1 && att.needReview === 0, JSON.stringify(att));
  }

  // =========================================================================
  c.head("T3 · a replacement needs its own decision");
  // =========================================================================
  const v2 = await mkCut({ projectId: project, deliverableId: reel, round: 2, fileName: "ada-reel-v2.mp4", completedAt: new Date() });
  // What startDropboxCopy does to the round it replaces.
  await prisma.reviewSubmission.update({ where: { id: v1 }, data: { completedAt: null, finalPath: "/Final/superseded/ada-reel-v1.mp4" } });
  {
    const old = await oldServed(v2);
    c.ok("BEFORE: the old rule served the replacement v2 under nobody's approval", old?.submissionId === v2 && old.hashOk === true, JSON.stringify(old));
    await sync();
    const e = await ce.videoEntitlement(video);
    // Jordan, Sep 24 2026 (KEEP_PRIOR_APPROVED_VERSION): v1 stays downloadable
    // until v2 is approved — but v2 inherits nothing.
    c.ok("entitlement: v2 is current and AWAITING the client", e.current?.submissionId === v2 && e.current.state === "AWAITING", `${e.current?.submissionId === v2}/${e.current?.state}`);
    c.ok("  …v2 does NOT inherit v1's approval: the file served is v1, marked as the prior version", e.file?.submissionId === v1 && e.priorVersion === true && e.basis === "CLIENT_APPROVED", `${e.file?.submissionId === v1}/${e.priorVersion}/${e.basis}`);
    c.ok("  …and the client is told which version it is", e.why === ce.WHY.PRIOR);
    const dres = await door(video.id, seat);
    c.ok("download door: 302 to v1, never v2", dres.status === 302 && (dres.headers.get("location") ?? "").includes(`/api/review/cut/${v1}/stream`), `${dres.status} ${dres.headers.get("location")}`);
    c.ok("stream dl=1 for v2: 403", (await stream(v2, seat, true)).status === 403);
    c.ok("stream dl=1 for the previously approved v1: allowed", (await stream(v1, seat, true)).status === 200);
    const cache = await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } });
    c.ok("ContentVideo cache: CLIENT_REVIEW (v2's standing), final file v1, approvedSubmissionId NOT v1", cache.status === "CLIENT_REVIEW" && cache.finalSubmissionId === v1 && cache.approvedSubmissionId !== v1, `${cache.status}/${cache.finalSubmissionId === v1}/${cache.approvedSubmissionId}`);
    const again = await cd.approveCut(viewer, v1, "NONE");
    c.ok("approveCut(v1) now refused: a newer version replaced it", again.ok === false && /newer version/i.test(again.message), again.message);
    const r = await cd.approveCut(viewer, v2, "NONE");
    c.ok("approveCut(v2) succeeds", r.ok === true, r.message);
    const e2 = await ce.videoEntitlement(video);
    c.ok("entitlement: CLIENT_APPROVED on v2", e2.basis === "CLIENT_APPROVED" && e2.file?.submissionId === v2);
    const d1 = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: v1, decision: "APPROVE" } });
    c.ok("v1's approval now reads SUPERSEDED, pointing at v2's", d1.receiptState === "SUPERSEDED" && d1.supersededById === (r.ok ? r.decisionId : "-"), `${d1.receiptState}/${d1.supersededById}`);
    await pk.postingKitFor(viewer, await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } }));
    const v1Drafts = await prisma.contentCaptionDraft.findMany({ where: { videoId: video.id, submissionId: v1 } });
    c.ok("v1's captions are STALE ('cut changed')", v1Drafts.length > 0 && v1Drafts.every((x) => x.status === "STALE"), v1Drafts.map((x) => x.status).join(","));
  }

  // =========================================================================
  c.head("T4 · a client change request is never 'Delivered'");
  // =========================================================================
  const v3 = await mkCut({ projectId: project, deliverableId: reel, round: 3, fileName: "ada-reel-v3.mp4", completedAt: new Date(), status: "CHANGES_REQUESTED", clientRequestedAt: new Date() });
  await prisma.reviewSubmission.update({ where: { id: v2 }, data: { completedAt: null } });
  {
    const v3row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v3 } });
    await prisma.clientDecision.create({
      data: {
        submissionId: v3, projectId: project, videoId: video.id, enrollmentId: ada.enrollmentId, clientId: ada.clientId, round: 3,
        contentHash: ce.stableCutIdentity(v3row), decision: "REQUEST_CHANGES", actorLabel: "Ada Vance", clientUserId: ada.clientUserId, membershipRole: "OWNER",
        receiptState: "ROUTED", dedupeKey: `sub:${v3}:changes:open`,
      },
    });
    const oldState = await oldListState(v3, ada.enrollmentId);
    c.ok("BEFORE: the old library read DELIVERED for the cut the client sent back", oldState === "DELIVERED", oldState);
    const old = await oldServed(v3);
    c.ok("BEFORE: …and the old door served that rejected cut", old?.submissionId === v3 && old.hashOk, JSON.stringify(old));
    await sync();
    const lr = await rowOf(video.id);
    c.ok("library row: CHANGES_IN_PROGRESS — never 'Delivered'", lr?.state === "CHANGES_IN_PROGRESS", `${lr?.state}/${lr?.downloadable}`);
    const res = await door(video.id, seat);
    c.ok("download door: the rejected v3 is NEVER served", !(res.headers.get("location") ?? "").includes(v3), `${res.status} ${res.headers.get("location")}`);
    c.ok("  …the version they approved (v2) still is (KEEP_PRIOR_APPROVED_VERSION)", res.status === 302 && (res.headers.get("location") ?? "").includes(`/api/review/cut/${v2}/stream`), `${res.status}`);
    const row = await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } });
    c.ok("ContentVideo cache: EDITING (v3 is back with the editor), final file v2", row.status === "EDITING" && row.finalSubmissionId === v2, `${row.status}/${row.finalSubmissionId === v2}`);
  }

  // =========================================================================
  c.head("T5 · identity survives the storage prune; a changed file does not pass");
  // =========================================================================
  {
    const w1 = await mkCut({ projectId: project, deliverableId: reel, slot: 2, round: 1, fileName: "ada-reel-2.mp4", completedAt: new Date() });
    await sync();
    const wv = await videoOfCut(w1);
    const r = await cd.approveCut(viewer, w1, "NONE");
    c.ok("approveCut(w1) succeeds", r.ok === true, r.message);
    const before = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: w1 } });
    // What pruneReviewUploads does 90 days after completion.
    await prisma.reviewSubmission.update({ where: { id: w1 }, data: { blobUrl: null, blobPathname: null, assetPath: before.finalPath } });
    const after = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: w1 } });
    c.ok("BEFORE: the old identity hash changed with the prune (the door would have 409'd)", cutIdentityHash(before) !== cutIdentityHash(after));
    const e = await ce.videoEntitlement(wv);
    c.ok("after the prune: still CLIENT_APPROVED, served from the filed copy", e.basis === "CLIENT_APPROVED" && e.file?.submissionId === w1, `${e.basis}/${e.blockedBy}`);
    c.ok("  …and the door still answers 302", (await door(wv.id, seat)).status === 302);

    // A legacy `ident:` approval (recorded before today), then the prune.
    const x1 = await mkCut({ projectId: project, deliverableId: reel, slot: 3, round: 1, fileName: "ada-reel-3.mp4", completedAt: new Date() });
    await sync();
    const xv = await videoOfCut(x1);
    const xRow = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: x1 } });
    await prisma.clientDecision.create({
      data: { submissionId: x1, projectId: project, videoId: xv.id, enrollmentId: ada.enrollmentId, clientId: ada.clientId, round: 1, contentHash: cutIdentityHash(xRow), decision: "APPROVE", actorLabel: "Ada Vance", clientUserId: ada.clientUserId, receiptState: "DONE", dedupeKey: `sub:${x1}:approve` },
    });
    c.ok("a legacy ident: approval matches before the prune", (await ce.videoEntitlement(xv)).basis === "CLIENT_APPROVED");
    await prisma.reviewSubmission.update({ where: { id: x1 }, data: { blobUrl: null, blobPathname: null, assetPath: xRow.finalPath } });
    c.ok("  …and after it (a storage release does not void an old approval)", (await ce.videoEntitlement(xv)).basis === "CLIENT_APPROVED");

    // A different file behind the same row.
    await prisma.reviewSubmission.update({ where: { id: w1 }, data: { sizeBytes: 6 } });
    const drift = await ce.videoEntitlement(wv);
    c.ok("size changed → HASH_DRIFT", drift.basis === "NONE" && drift.blockedBy === "HASH_DRIFT", `${drift.blockedBy}`);
    const res = await door(wv.id, seat);
    c.ok("  …door: 409, never a different file", res.status === 409 && (await errorOf(res)) === ce.WHY.DRIFT, `${res.status}`);
    const cap = await pk.draftCaptionForVideo(viewer, wv.id);
    c.ok("  …caption draft refused with the drift sentence", cap.ok === false && cap.message === ce.WHY.DRIFT, cap.message);
    await prisma.reviewSubmission.update({ where: { id: w1 }, data: { sizeBytes: 5, fileName: "ada-reel-2-RECUT.mp4" } });
    c.ok("name changed → HASH_DRIFT", (await ce.videoEntitlement(wv)).blockedBy === "HASH_DRIFT");
    await prisma.reviewSubmission.update({ where: { id: w1 }, data: { fileName: "ada-reel-2.mp4" } });
    c.ok("restored → CLIENT_APPROVED again", (await ce.videoEntitlement(wv)).basis === "CLIENT_APPROVED");
  }

  // =========================================================================
  c.head("T6 · historical and outside-the-portal deliveries stay downloadable — ENDED too");
  // =========================================================================
  {
    const cal = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: "Cal Archive TEST", package: "Starter", monthKey: "2026-09",
      project: { status: "SCHEDULED", shootDate: new Date("2026-09-08T14:00:00Z") },
      owner: { email: "cal@example.com", name: "Cal Archive" },
    });
    const calSeat: MediaScope = { kind: "membership", id: cal.membershipId! };
    const calEnr = { id: cal.enrollmentId, clientId: cal.clientId };
    // (a) An imported 2025-11 month: the project was delivered, the cut decided
    // 2025-11-20, no portal decision (no client had a seat then).
    const nov = await prisma.contentMonth.create({ data: { enrollmentId: cal.enrollmentId, clientId: cal.clientId, monthKey: "2025-11", videosOwed: 2, status: "IMPORTED", historical: true }, select: { id: true } });
    const novProject = await prisma.project.create({ data: { clientId: cal.clientId, title: "Cal — Nov 2025", status: "DELIVERED", deliveredAt: new Date("2025-11-21T15:00:00Z"), contentMonthId: nov.id, packageName: "Video Starter" }, select: { id: true } });
    const novReel = await prisma.deliverable.create({ data: { projectId: novProject.id, type: "SOCIAL_REEL", label: "Video Starter", productTitle: "Video Starter", quantity: 2 }, select: { id: true } });
    const h1 = await mkCut({ projectId: novProject.id, deliverableId: novReel.id, round: 1, fileName: "cal-nov-v1.mp4", decidedAt: new Date("2025-11-20T15:00:00Z"), completedAt: new Date("2025-11-20T15:05:00Z"), createdAt: new Date("2025-11-19T15:00:00Z") });
    // (b) An Aryeo-only delivery on the current month.
    const aryProject = await prisma.project.create({ data: { clientId: cal.clientId, title: "Cal — listing", status: "DELIVERED", deliveredAt: new Date("2026-09-05T15:00:00Z"), contentMonthId: cal.monthId }, select: { id: true } });
    await prisma.portalVideo.create({ data: { enrollmentId: cal.enrollmentId, monthId: cal.monthId, projectId: aryProject.id, title: "Spring Market Update", playback: "https://cdn.aryeo.example/spring.m3u8", download: "https://cdn.aryeo.example/spring.mp4", source: "aryeo", externalKey: "aryeo:cal-listing:1", deliveredAt: new Date("2026-09-05T15:00:00Z") } });
    // (c) A post-gate cut Kyle marked as sent.
    const s1 = await mkCut({ projectId: cal.projectId!, deliverableId: cal.deliverableId!, round: 1, fileName: "cal-sept-v1.mp4", completedAt: new Date(), sentToClientAt: new Date() });
    await cv.syncEnrollmentVideos(calEnr);

    const hv = await videoOfCut(h1);
    const sv = await videoOfCut(s1);
    const src = await prisma.contentVideoSource.findFirstOrThrow({ where: { kind: "PORTAL_VIDEO", ref: "aryeo:cal-listing:1" } });
    const av = await prisma.contentVideo.findUniqueOrThrow({ where: { id: src.videoId } });
    const eh = await ce.videoEntitlement(hv);
    const ea = await ce.videoEntitlement(av);
    const es = await ce.videoEntitlement(sv);
    c.ok("2025-11 imported month, delivered project, no decision → HISTORICAL_DELIVERY", eh.basis === "HISTORICAL_DELIVERY" && eh.file?.submissionId === h1, `${eh.basis}/${eh.blockedBy}`);
    c.ok("Aryeo-only video → DELIVERED_OUTSIDE_PORTAL", ea.basis === "DELIVERED_OUTSIDE_PORTAL" && ea.file?.kind === "delivered", `${ea.basis}/${ea.blockedBy}`);
    c.ok("post-gate cut with Mark-as-sent → DELIVERED_OUTSIDE_PORTAL", es.basis === "DELIVERED_OUTSIDE_PORTAL" && es.file?.submissionId === s1, `${es.basis}/${es.blockedBy}`);
    const att = await cv.libraryAttention(calEnr);
    c.ok("Home counts all three as ready to use", att.readyToUse === 3, JSON.stringify(att));

    await prisma.contentEnrollment.update({ where: { id: cal.enrollmentId }, data: { status: "ENDED" } });
    const rh = await door(hv.id, calSeat);
    const ra = await door(av.id, calSeat);
    const rs = await door(sv.id, calSeat);
    c.ok("ENDED: the historical cut still 302s", rh.status === 302, `${rh.status} ${await errorOf(rh)}`);
    c.ok("ENDED: the Aryeo file still 302s, to its CDN URL", ra.status === 302 && ra.headers.get("location") === "https://cdn.aryeo.example/spring.mp4", `${ra.status} ${ra.headers.get("location")}`);
    c.ok("ENDED: the marked-as-sent cut still 302s", rs.status === 302, `${rs.status}`);
    const got = await streamAt(h1, rh.headers.get("location") ?? "");
    c.ok("ENDED: following the historical redirect → 200 attachment", got.status === 200 && disposition(got).startsWith("attachment"), `${got.status}`);
    const byLink = await door(hv.id, { kind: "enrollment", id: cal.enrollmentId });
    c.ok("ENDED: the emailed link's scope downloads it too", byLink.status === 302, `${byLink.status}`);
    const cap = await portalDraftCaption({ token: cal.portalToken }, sv.id);
    c.ok("ENDED: caption drafting says the program has ended", cap.ok === false && /program has ended/i.test(cap.message), cap.message);
  }

  // =========================================================================
  c.head("T7 · legacy file-name chains: the older round cannot be approved");
  // =========================================================================
  {
    const legacy = await prisma.project.create({ data: { clientId: ada.clientId, title: "Ada — legacy cuts", status: "SCHEDULED", contentMonthId: ada.monthId }, select: { id: true } });
    const t0 = new Date(Date.now() - 3600_000);
    const l1 = await mkCut({ projectId: legacy.id, round: 1, fileName: "Mike Video 2 v1.mov", assetPath: "/Legacy/Mike Video 2 v1.mov", decidedAt: t0, createdAt: t0, blob: false });
    const l2 = await mkCut({ projectId: legacy.id, round: 1, fileName: "Mike Video 2 v2.mov", assetPath: "/Legacy/Mike Video 2 v2.mov", decidedAt: new Date(t0.getTime() + 60_000), createdAt: new Date(t0.getTime() + 60_000), blob: false });
    const rows = await prisma.reviewSubmission.findMany({ where: { id: { in: [l1, l2] } } });
    c.ok("BEFORE: the Review Room key split them into two 'current' chains", cutKeyOf(rows[0]) !== cutKeyOf(rows[1]));
    c.ok("  …the library's key (videoCutKey) makes them one video", cv.videoCutKey(rows[0]) === cv.videoCutKey(rows[1]));
    await sync();
    const a1 = await cd.approveCut(viewer, l1, "NONE");
    c.ok("approveCut(v1.mov) refused — v2.mov replaced it", a1.ok === false && /newer version/i.test(a1.message), a1.message);
    const a2 = await cd.approveCut(viewer, l2, "NONE");
    c.ok("approveCut(v2.mov) succeeds", a2.ok === true, a2.message);
    const hist = await cd.cutHistory(viewer, l2);
    c.ok("cutHistory lists both rounds, v2.mov current and approved", hist.length === 2 && hist[1].submissionId === l2 && hist[1].isCurrent && hist[1].clientState === "YOU_APPROVED" && hist[0].clientState === "SUPERSEDED", hist.map((h) => `${h.fileName}:${h.clientState}`).join(" | "));
  }

  // =========================================================================
  c.head("T9 · the Sep 24 review — what the first version of this rule locked");
  // =========================================================================
  {
    const { can } = await import("@/lib/portalAccess");
    const { URGENT_CONTACT } = await import("@/lib/reviewWindows");
    const seatOf = (f: { membershipId: string | null }): MediaScope => ({ kind: "membership", id: f.membershipId! });
    const viewerOf = (f: { enrollmentId: string; clientId: string; clientName: string; videosPerMonth: number; sessionsPerMonth: number; clientUserId: string | null; membershipId: string | null }, status: string) => ({
      enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status, videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
      actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "x@example.com", name: f.clientName, membershipId: f.membershipId!, membershipRole: "OWNER" },
      access: status === "ACTIVE" ? "FULL" : "READ_ONLY", via: "LOGIN",
    }) as PortalViewer;

    // (13) A September video finished and approved in the Review Room BEFORE
    // the gate, on a month still in EDITING (one video outstanding), and the
    // program then ENDED. Kyle texted it; the project never reached DELIVERED.
    const gus = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: "Gus Pregate TEST", package: "Starter", monthKey: "2026-09",
      project: { status: "EDITING", shootDate: new Date("2026-09-05T14:00:00Z") }, owner: { email: "gus@example.com", name: "Gus Pregate" },
    });
    const g1 = await mkCut({ projectId: gus.projectId!, deliverableId: gus.deliverableId!, round: 1, fileName: "gus-reel-v1.mp4", decidedAt: new Date("2026-09-10T15:00:00Z"), completedAt: new Date("2026-09-10T15:05:00Z"), createdAt: new Date("2026-09-09T15:00:00Z") });
    await cv.syncEnrollmentVideos({ id: gus.enrollmentId, clientId: gus.clientId });
    const gv = await videoOfCut(g1);
    c.ok("BEFORE (9defa7a): the old door served it (newest cut with completedAt)", (await oldServed(g1))?.submissionId === g1);
    const gp = await prisma.project.findUniqueOrThrow({ where: { id: gus.projectId! }, select: { status: true } });
    const gm = await prisma.contentMonth.findUniqueOrThrow({ where: { id: gus.monthId }, select: { historical: true, status: true } });
    c.ok("BEFORE (the first CP-01 rule): a pre-gate round counted as delivered only on a DELIVERED project or a historical month — neither here, so AWAITING_DECISION", gp.status !== "DELIVERED" && !gm.historical && gm.status !== "IMPORTED", `${gp.status}/${gm.status}`);
    const eg = await ce.videoEntitlement(gv);
    c.ok("NEW: a pre-gate round the Review Room approved and finished → HISTORICAL_DELIVERY, project status aside", eg.basis === "HISTORICAL_DELIVERY" && eg.file?.submissionId === g1, `${eg.basis}/${eg.blockedBy}`);
    await prisma.contentEnrollment.update({ where: { id: gus.enrollmentId }, data: { status: "ENDED" } });
    const gd = await door(gv.id, seatOf(gus));
    c.ok("NEW: …and on the ENDED account the door still 302s", gd.status === 302, `${gd.status} ${await errorOf(gd)}`);

    // (5, 21) A post-gate cut, released and never decided, on a program that
    // is then PAUSED: nobody (staff included) can approve on a read-only page.
    const pax = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: "Pax Paused TEST", package: "Starter", monthKey: "2026-10",
      project: { status: "DELIVERED", shootDate: new Date("2026-09-20T14:00:00Z") }, owner: { email: "pax@example.com", name: "Pax Paused" },
    });
    await prisma.project.update({ where: { id: pax.projectId! }, data: { deliveredAt: new Date() } });
    const p1 = await mkCut({ projectId: pax.projectId!, deliverableId: pax.deliverableId!, round: 1, fileName: "pax-reel-v1.mp4", completedAt: new Date() });
    await prisma.reviewSubmission.update({ where: { id: p1 }, data: { clientReleasedAt: new Date() } });
    // A second one on a job Aryeo has NOT delivered.
    const openJob = await prisma.project.create({ data: { clientId: pax.clientId, title: "Pax — second shoot", status: "EDITING", contentMonthId: pax.monthId }, select: { id: true } });
    const openReel = await prisma.deliverable.create({ data: { projectId: openJob.id, type: "SOCIAL_REEL", label: "Video Starter", productTitle: "Video Starter", quantity: 1 }, select: { id: true } });
    const p2 = await mkCut({ projectId: openJob.id, deliverableId: openReel.id, round: 1, fileName: "pax-second-v1.mp4", completedAt: new Date() });
    await prisma.reviewSubmission.update({ where: { id: p2 }, data: { clientReleasedAt: new Date() } });
    await cv.syncEnrollmentVideos({ id: pax.enrollmentId, clientId: pax.clientId });
    const pv = await videoOfCut(p1);
    const pv2 = await videoOfCut(p2);
    c.ok("while ACTIVE, the delivered project's cut still waits on the client (the gate holds)", (await ce.videoEntitlement(pv)).blockedBy === "AWAITING_DECISION");
    await prisma.contentEnrollment.update({ where: { id: pax.enrollmentId }, data: { status: "PAUSED" } });
    const paused = viewerOf(pax, "PAUSED");
    c.ok("PAUSED: no seat can approve — can(approveEdits) is false even for the OWNER", can(paused, "approveEdits") === false);
    const ep = await ce.videoEntitlement(pv);
    c.ok("NEW (5): PAUSED, the Aryeo-delivered project's cut counts as delivered → downloadable", ep.basis === "DELIVERED_OUTSIDE_PORTAL" && ep.file?.submissionId === p1, `${ep.basis}/${ep.blockedBy}`);
    c.ok("  …through the door too", (await door(pv.id, seatOf(pax))).status === 302);
    await cv.syncEnrollmentVideos({ id: pax.enrollmentId, clientId: pax.clientId });
    c.ok("  …and the library sync writes the same answer (downloadable, not CLIENT_REVIEW)", (await prisma.contentVideo.findUniqueOrThrow({ where: { id: pv.id } })).finalSubmissionId === p1);
    const e2 = await ce.videoEntitlement(pv2);
    c.ok("the undelivered job's cut stays locked while paused (nothing says it reached them)", e2.blockedBy === "AWAITING_DECISION");
    const kit = await pk.postingKitFor(paused, pv2);
    const oldWhy = e2.blockedBy === "AWAITING_DECISION" && !can(paused, "approveEdits") ? ce.WHY.AWAITING_OWNER : e2.why;
    c.ok("BEFORE (21): the kit promised 'once the account owner approves' — which nobody can", oldWhy === ce.WHY.AWAITING_OWNER);
    c.ok("NEW (21): it says the program is paused and gives Kyle's number instead", /paused/.test(kit.finalNote ?? "") && (kit.finalNote ?? "").includes(URGENT_CONTACT) && kit.access.why === kit.finalNote && !/account owner approves/.test(kit.finalNote ?? ""), kit.finalNote ?? "null");

    // (15) An August job delivered through Aryeo before the gate: the editor's
    // cut never went through the Review Room, and the delivered file's title
    // does not match the editor's file name — the sync pairs them by position.
    const aug = await prisma.contentMonth.create({ data: { enrollmentId: ada.enrollmentId, clientId: ada.clientId, monthKey: "2026-08", videosOwed: 1, status: "OPEN" }, select: { id: true } });
    const augJob = await prisma.project.create({ data: { clientId: ada.clientId, title: "Ada — August", status: "DELIVERED", deliveredAt: new Date("2026-08-20T15:00:00Z"), contentMonthId: aug.id, packageName: "Video Starter" }, select: { id: true } });
    const augReel = await prisma.deliverable.create({ data: { projectId: augJob.id, type: "SOCIAL_REEL", label: "Video Starter", productTitle: "Video Starter", quantity: 1 }, select: { id: true } });
    const m1 = await mkCut({ projectId: augJob.id, deliverableId: augReel.id, round: 1, fileName: "Mike Ciunci Reel 1 v2.mov", status: "PENDING", decidedAt: null, createdAt: new Date("2026-08-15T15:00:00Z") });
    await prisma.portalVideo.create({ data: { enrollmentId: ada.enrollmentId, monthId: aug.id, projectId: augJob.id, title: "Social Video 1", playback: "https://cdn.aryeo.example/aug.m3u8", download: "https://cdn.aryeo.example/aug.mp4", source: "aryeo", externalKey: "aryeo:ada-aug:1", deliveredAt: new Date("2026-08-20T15:00:00Z") } });
    await sync();
    const mv = await videoOfCut(m1);
    c.ok("the sync paired the Aryeo file by list position only", ce.aryeoMatchBasis("Social Video 1", [{ fileName: "Mike Ciunci Reel 1 v2.mov" }]) === "index");
    const mChain = await ce.cutChainOf(m1);
    c.ok("BEFORE (the first CP-01 rule): chain non-empty, nothing ever sets `confirmed`, pairing by position → UNCONFIRMED_PAIRING, for ever", mChain.length === 1 && ce.aryeoMatchBasis("Social Video 1", mChain) === "index");
    const em = await ce.videoEntitlement(mv);
    c.ok("NEW (15): delivered before the gate → the client's own Aryeo file is served", em.basis === "DELIVERED_OUTSIDE_PORTAL" && em.file?.kind === "delivered" && em.file.url === "https://cdn.aryeo.example/aug.mp4", `${em.basis}/${em.blockedBy}`);

    // (10) A legacy `ident:` approval, then the public→private store cutover
    // (scripts/_fix/R05/migrate-cut-store.ts): URL and pathname rewritten, the
    // old identity pinned onto contentHash.
    const y1 = await mkCut({ projectId: project, deliverableId: reel, slot: 4, round: 1, fileName: "ada-reel-4.mp4", completedAt: new Date() });
    await sync();
    const yv = await videoOfCut(y1);
    const yRow = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: y1 } });
    const legacyIdent = cutIdentityHash(yRow);
    await prisma.clientDecision.create({
      data: { submissionId: y1, projectId: project, videoId: yv.id, enrollmentId: ada.enrollmentId, clientId: ada.clientId, round: 1, contentHash: legacyIdent, decision: "APPROVE", actorLabel: "Ada Vance", clientUserId: ada.clientUserId, receiptState: "DONE", dedupeKey: `sub:${y1}:approve` },
    });
    await prisma.reviewSubmission.update({ where: { id: y1 }, data: { blobUrl: `https://privstore.private.blob.vercel-storage.com/review-cuts/${y1}.mp4`, blobPathname: `review-cuts/private/${y1}.mp4`, contentHash: legacyIdent } });
    const moved = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: y1 } });
    c.ok("BEFORE: the recompute (new URL) no longer matches the legacy ident: — the old check said HASH_DRIFT", cutIdentityHash({ ...moved, contentHash: null }) !== legacyIdent && !!moved.blobUrl);
    const ey = await ce.videoEntitlement(yv);
    c.ok("NEW (10): the migration's pin is honoured → still CLIENT_APPROVED", ey.basis === "CLIENT_APPROVED" && ey.file?.submissionId === y1, `${ey.basis}/${ey.blockedBy}`);
    c.ok("  …and a NEW approval on a migrated row (it records the pinned value) matches too", ce.decisionMatchesCut(ce.stableCutIdentity(moved), moved));

    // (12) v1 approved, v2 released and synced, then v2 taken back (removeCut
    // deletes the row; the cached pointer still names it until a sync).
    const z1 = await mkCut({ projectId: project, deliverableId: reel, slot: 5, round: 1, fileName: "ada-reel-5-v1.mp4", completedAt: new Date() });
    await prisma.reviewSubmission.update({ where: { id: z1 }, data: { clientReleasedAt: new Date() } });
    await sync();
    const za = await cd.approveCut(viewer, z1, "NONE");
    const z2 = await mkCut({ projectId: project, deliverableId: reel, slot: 5, round: 2, fileName: "ada-reel-5-v2.mp4", completedAt: new Date() });
    await sync();
    const zv0 = await videoOfCut(z1);
    c.ok("the library points at v2 after the sync", za.ok && zv0.currentSubmissionId === z2);
    await prisma.reviewSubmission.delete({ where: { id: z2 } });
    await prisma.reviewSubmission.update({ where: { id: z1 }, data: { status: "PENDING" } }); // restorePriorCutRound
    const zv = await prisma.contentVideo.findUniqueOrThrow({ where: { id: zv0.id } });
    c.ok("BEFORE: the dangling pointer found no anchor — the old loader read an EMPTY chain (NONE / NO_FILE)", zv.currentSubmissionId === z2 && (await prisma.reviewSubmission.count({ where: { id: z2 } })) === 0);
    const ez = (await ce.entitlementsForVideos([zv])).get(zv.id)!;
    c.ok("NEW (12): the loader falls back past it — CLIENT_APPROVED on v1, before any sync", ez.basis === "CLIENT_APPROVED" && ez.file?.submissionId === z1, `${ez.basis}/${ez.blockedBy}`);
    c.ok("  …and the stream door's per-cut check agrees", await ce.cutDownloadableFor({ id: ada.enrollmentId, clientId: ada.clientId }, z1));
  }

  // =========================================================================
  c.head("P · the pure rule's other branches");
  // =========================================================================
  {
    const base = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v1 }, select: ce.CHAIN_SELECT });
    const internal = { ...base, status: "PENDING", decidedAt: null, decidedBy: null, clientReleasedAt: null, sentToClientAt: null };
    const facts = (over: Partial<Parameters<typeof ce.decideEntitlement>[0]>) => ({ chain: [internal], approvals: new Map(), changeRequests: new Set<string>(), projectDelivered: false, projectDeliveredAt: null, monthHistorical: false, aryeoFinal: null, ...over });
    const aryeo = (matchBasis: "name" | "index") => ({ portalVideoId: "pv1234567890", url: "https://cdn.aryeo.example/x.mp4", title: "x", deliveredAt: new Date(), matchBasis, confirmed: false });
    c.ok("internal-only chain + Aryeo file paired by NAME → the Aryeo file", ce.decideEntitlement(facts({ aryeoFinal: aryeo("name") })).basis === "DELIVERED_OUTSIDE_PORTAL");
    c.ok("internal-only chain + Aryeo file paired only by POSITION → UNCONFIRMED_PAIRING", ce.decideEntitlement(facts({ aryeoFinal: aryeo("index") })).blockedBy === "UNCONFIRMED_PAIRING");
    c.ok("internal-only chain, nothing else → NO_FILE", ce.decideEntitlement(facts({})).blockedBy === "NO_FILE");
    {
      // KEEP_PRIOR_APPROVED_VERSION, as a pure rule.
      const r1 = { ...base, id: "cr1aaaaaaaaaaaa1", round: 1, clientReleasedAt: new Date("2026-09-25T12:00:00Z"), decidedAt: new Date("2026-09-25T12:00:00Z") };
      const r2 = { ...base, id: "cr2aaaaaaaaaaaa2", round: 2, clientReleasedAt: new Date("2026-09-26T12:00:00Z"), decidedAt: new Date("2026-09-26T12:00:00Z") };
      const appr = (sid: string, row: typeof r1) => new Map([[sid, { id: `d-${sid}`, actorLabel: "Ada", decidedAt: new Date("2026-09-25T13:00:00Z"), contentHash: ce.stableCutIdentity(row) }]]);
      const awaiting = ce.decideEntitlement(facts({ chain: [r1, r2], approvals: new Map(), priorApprovals: appr(r1.id, r1) }));
      c.ok("pure: v1 approved, v2 awaiting → v1 served, v2 current", awaiting.file?.submissionId === r1.id && awaiting.current?.submissionId === r2.id && awaiting.priorVersion === true);
      const sentBack = ce.decideEntitlement(facts({ chain: [r1, r2], approvals: new Map(), changeRequests: new Set([r2.id]), priorApprovals: appr(r1.id, r1) }));
      c.ok("pure: v1 approved, v2 sent back → v1 still served", sentBack.file?.submissionId === r1.id && sentBack.current?.state === "CHANGES_REQUESTED");
      const onlyRejected = ce.decideEntitlement(facts({ chain: [r2], approvals: new Map(), changeRequests: new Set([r2.id]) }));
      c.ok("pure: a lone round the client sent back → nothing served (CHANGES_REQUESTED)", onlyRejected.file === null && onlyRejected.blockedBy === "CHANGES_REQUESTED");
      const drifted = ce.decideEntitlement(facts({ chain: [r1, r2], approvals: new Map(), priorApprovals: new Map([[r1.id, { id: "d", actorLabel: "Ada", decidedAt: new Date(), contentHash: "ident2:not-this-file" }]]) }));
      c.ok("pure: a prior approval whose file changed is NOT served", drifted.file === null && drifted.blockedBy === "AWAITING_DECISION");
    }
    c.ok("a round decided before the gate on a delivered project → HISTORICAL_DELIVERY", ce.decideEntitlement(facts({ chain: [{ ...base, decidedAt: new Date("2026-09-01T12:00:00Z") }], projectDelivered: true })).basis === "HISTORICAL_DELIVERY");
    c.ok("the same round decided AFTER the gate → awaits the client", ce.decideEntitlement(facts({ chain: [{ ...base, decidedAt: new Date("2026-09-25T12:00:00Z") }], projectDelivered: true })).blockedBy === "AWAITING_DECISION");
    c.ok("…unless the program is paused or ended: then the delivered project counts", ce.decideEntitlement(facts({ chain: [{ ...base, decidedAt: new Date("2026-09-25T12:00:00Z") }], projectDelivered: true, enrollmentActive: false })).basis === "DELIVERED_OUTSIDE_PORTAL");
    c.ok("…and paused with NO delivery fact it still waits", ce.decideEntitlement(facts({ chain: [{ ...base, decidedAt: new Date("2026-09-25T12:00:00Z") }], enrollmentActive: false })).blockedBy === "AWAITING_DECISION");
    c.ok("a pre-gate round the Review Room approved, project NOT delivered → HISTORICAL_DELIVERY", ce.decideEntitlement(facts({ chain: [{ ...base, decidedAt: new Date("2026-09-01T12:00:00Z") }] })).basis === "HISTORICAL_DELIVERY");
    const oldInternal = { ...internal, createdAt: new Date("2026-08-01T12:00:00Z") };
    c.ok("position-only pairing on a historical month → served", ce.decideEntitlement(facts({ chain: [oldInternal], aryeoFinal: aryeo("index"), monthHistorical: true })).basis === "DELIVERED_OUTSIDE_PORTAL");
    c.ok("position-only pairing on a project delivered before the gate → served", ce.decideEntitlement(facts({ chain: [internal], aryeoFinal: aryeo("index"), projectDelivered: true, projectDeliveredAt: new Date("2026-09-01T12:00:00Z") })).basis === "DELIVERED_OUTSIDE_PORTAL");
    c.ok("position-only pairing on a post-gate delivery of a post-gate chain → still held", ce.decideEntitlement(facts({ chain: [internal], aryeoFinal: aryeo("index"), projectDelivered: true, projectDeliveredAt: new Date("2026-09-30T12:00:00Z") })).blockedBy === "UNCONFIRMED_PAIRING");
    c.ok("gate constant is 2026-09-24T04:00Z", ce.CLIENT_APPROVAL_GATE_SINCE.toISOString() === "2026-09-24T04:00:00.000Z");
  }

  c.head("isolation");
  c.ok("no outbound call left the process", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("the only 'network' was the canned hub-store file", fence.faked.every((u) => u.includes(".public.blob.vercel-storage.com/")), `${fence.faked.length} canned reads`);
  c.ok("no Prisma error was logged", quiet.count === 0, `${quiet.count}`);

  quiet.restore();
  c.summary();
  await stop();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { fence.restore(); process.exit(process.exitCode ?? 0); });
