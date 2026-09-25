// ---------------------------------------------------------------------------
// DRILL: CP-12 — the historical library, the identity tool, and downloads
// (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp12-library-delivery.ts
//
// THE DEFECTS. Backfilled months are keyed by their SHOOT month and flagged
// historical, but the library grouped them by that month anyway, and Postgres
// sorts NULLS FIRST on a descending key, so the "Undated" group led page one.
// A delivered Aryeo file paired to its cut by list position could sit under
// the wrong title with nothing flagging it and no tool to fix it, and
// cutEntitlement's `confirmed` could never become true. The kit read a door
// visit — written BEFORE the redirect, staff hits included — as "Downloaded".
// Ended and paused clients kept their downloads but had no way back.
//
// Each section states the OLD answer first where it can still be observed
// (the old query, the old reader, the old rule's input), then drives the
// SHIPPED code: portalVideoList, syncEnrollmentVideos, the identity tool, the
// staff loader, the download door and stream routes with real NextRequests,
// postingKitFor, and the portal actions over a real share-link token.
//
//   L1  sections: recent months kept, older backfill flat in Previous content
//   L2  staff confirmation moves a row back under its month; edits stick
//   L3  reorder: index pairing is recorded and flagged; relink fixes it for good
//   L3b a confirmed pairing is what lets the release rule serve a position-paired file
//   L4  a legacy positional Aryeo row is flagged; its playback is unchanged
//   L5  a filmed topic row survives sync and is adopted onto its cut chain
//   L6  downloads: proxy vs redirect, "started" vs "completed", staff excluded
//   L7  ended: playback and downloads stay, the resubscribe link, the rest refused
//
// ISOLATION. _harness.ts: PGlite on 127.0.0.1:5519, every .env secret blanked,
// fetch AND raw sockets fenced. The hub store's public blob host is answered
// by a canned 5-byte "video" (honouring Range, like the store); nothing else
// may leave. No provider is reached and no message is sent.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";
import type { MediaScope } from "@/lib/portalMedia";

const PORT = Number(process.env.DRILL_PORT ?? 5519);

installNextStubs();

const BYTES = "abcde";
const fence = fenceFetch((url, init) => {
  if (!/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url)) return null;
  const range = (init?.headers as Record<string, string> | undefined)?.Range;
  const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
  if (m) {
    const from = Number(m[1]);
    const part = BYTES.slice(from);
    return new Response(part, { status: 206, headers: { "content-type": "video/mp4", "content-length": String(part.length), "content-range": `bytes ${from}-${BYTES.length - 1}/${BYTES.length}` } });
  }
  return new Response(BYTES, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(BYTES.length) } });
});

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
  const portal = await import("@/lib/portal");
  const { RESUBSCRIBE_URL, etMonthKey } = await import("@/lib/contentProgram");
  const { mediaToken } = await import("@/lib/portalMedia");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { NextRequest } = await import("next/server");
  const downloadRoute = await import("@/app/api/portal/download/[videoId]/route");
  const streamRoute = await import("@/app/api/review/cut/[id]/stream/route");
  const actions = await import("@/app/portal/actions");
  const staffActions = await import("@/app/content/[id]/workspaceActions");
  const { loadContentTab } = await import("@/app/content/[id]/workspaceData");

  // ---- helpers -------------------------------------------------------------
  const nowKey = etMonthKey();
  const BLOB = (id: string) => `https://drillstore.public.blob.vercel-storage.com/review-cuts/${id}.mp4`;
  async function mkCut(o: { projectId: string; deliverableId?: string | null; slot?: number; round?: number; fileName: string; status?: string; decidedAt?: Date | null; createdAt?: Date; completedAt?: Date | null; blob?: boolean }): Promise<string> {
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: o.projectId, deliverableId: o.deliverableId ?? null, slot: o.slot ?? 1, round: o.round ?? 1, fileName: o.fileName, status: o.status ?? "APPROVED",
        decidedBy: o.status === "PENDING" ? null : "Jordan", decidedAt: o.decidedAt === undefined ? (o.status === "PENDING" ? null : new Date()) : o.decidedAt,
        completedAt: o.completedAt ?? null, source: "upload", sizeBytes: BYTES.length, finalPath: `/Final/${o.fileName}`, ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), ...(o.blob === false ? {} : { blobUrl: BLOB(row.id), blobPathname: `review-cuts/${row.id}.mp4` }) } });
    return row.id;
  }
  const viewerOf = (f: { enrollmentId: string; clientId: string; clientName: string; videosPerMonth: number; sessionsPerMonth: number; clientUserId: string | null; membershipId: string | null }, status = "ACTIVE") => ({
    enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status, videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
    actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "owner@example.com", name: f.clientName, membershipId: f.membershipId!, membershipRole: "OWNER" },
    access: status === "ACTIVE" ? "FULL" : "READ_ONLY", via: "LOGIN",
  }) as PortalViewer;
  const videoOfCut = async (subId: string) => {
    const s = await prisma.reviewSubmission.findUnique({ where: { id: subId }, select: { videoId: true } });
    return prisma.contentVideo.findUniqueOrThrow({ where: { id: s!.videoId! } });
  };
  const door = (videoId: string, scope: MediaScope) =>
    downloadRoute.GET(new NextRequest(`http://127.0.0.1/api/portal/download/${videoId}?m=${encodeURIComponent(mediaToken(videoId, scope))}`), { params: Promise.resolve({ videoId }) });
  const streamAt = (subId: string, url: string, headers?: Record<string, string>) => streamRoute.GET(new NextRequest(url, { headers }), { params: Promise.resolve({ id: subId }) });
  const errorOf = async (r: Response) => ((await r.clone().json().catch(() => ({}))) as { error?: string }).error ?? "";
  const staffUser = await prisma.appUser.create({ data: { email: "kyle@drill.invalid", name: "Kyle", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const staffScope: MediaScope = { kind: "staff", id: staffUser.id };

  // =========================================================================
  c.head("L1 · sections — recent months kept, older backfill flat in Previous content");
  // =========================================================================
  const ada = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Ada Library TEST", package: "Starter", monthKey: nowKey, project: false, owner: { email: "ada@example.com", name: "Ada" } });
  const adaEnr = { id: ada.enrollmentId, clientId: ada.clientId };
  const oct = await prisma.contentMonth.create({ data: { enrollmentId: ada.enrollmentId, clientId: ada.clientId, monthKey: "2025-10", videosOwed: 2, status: "IMPORTED", historical: true }, select: { id: true } });
  const nov = await prisma.contentMonth.create({ data: { enrollmentId: ada.enrollmentId, clientId: ada.clientId, monthKey: "2025-11", videosOwed: 2, status: "IMPORTED", historical: true }, select: { id: true } });
  const mkVideo = (title: string, monthId: string | null, monthKey: string | null, deliveredAt: Date | null, filmedAt: Date | null = null) =>
    prisma.contentVideo.create({ data: { enrollmentId: ada.enrollmentId, clientId: ada.clientId, monthId, monthKey, title, status: "DELIVERED", deliveredAt, filmedAt, source: "backfill" }, select: { id: true } }).then((r) => r.id);
  const hOct = await mkVideo("October market recap", oct.id, "2025-10", new Date("2025-10-20T15:00:00Z"));
  const hNov1 = await mkVideo("Staging tips", nov.id, "2025-11", new Date("2025-11-15T15:00:00Z"));
  const hNov2 = await mkVideo("Holiday listing push", nov.id, "2025-11", new Date("2025-12-01T15:00:00Z"));
  const undated = await mkVideo("Old testimonial", null, null, new Date("2025-06-01T15:00:00Z"));
  const cur1 = await mkVideo("First weekend pricing", ada.monthId, nowKey, new Date(), new Date(Date.now() - 3 * 86_400_000));
  const cur2 = await mkVideo("Neighborhood walk", ada.monthId, nowKey, null, new Date(Date.now() - 2 * 86_400_000));
  {
    // BEFORE: the list query as it shipped (orderBy monthKey desc, every month a year).
    const old = await prisma.contentVideo.findMany({ where: { enrollmentId: ada.enrollmentId, status: { not: "ARCHIVED" } }, orderBy: [{ monthKey: "desc" }, { filmedAt: "desc" }, { createdAt: "desc" }], select: { id: true, monthKey: true } });
    c.ok("BEFORE: the old order put the month-less row FIRST (Postgres NULLS FIRST)", old[0]?.monthKey === null && old[0]?.id === undated, `first=${old[0]?.monthKey}`);
    const oldYears = [...new Set(old.map((v) => v.monthKey?.slice(0, 4)).filter(Boolean))];
    c.ok("BEFORE: the old year chips included the backfilled 2025 shoot months", oldYears.includes("2025"), oldYears.join(","));

    const p = await cv.portalVideoList(adaEnr, { perPage: 6 });
    const secs = p.rows.map((r) => r.section);
    c.ok("page one: the two current-month rows first, RECENT", secs[0] === "RECENT" && secs[1] === "RECENT" && p.rows.slice(0, 2).every((r) => r.monthKey === nowKey), secs.join(","));
    c.ok("  …then four PREVIOUS rows", secs.slice(2).every((s) => s === "PREVIOUS") && secs.length === 6, secs.join(","));
    c.ok("  …the current month in filmed-date order", p.rows[0].id === cur2 && p.rows[1].id === cur1);
    const prevIds = p.rows.slice(2).map((r) => r.id);
    c.ok("PREVIOUS ordered by delivery date, newest first", JSON.stringify(prevIds) === JSON.stringify([hNov2, hNov1, hOct, undated]), prevIds.join(","));
    c.ok("  …the month-less row is among them, and not first", prevIds.includes(undated) && prevIds[0] !== undated);
    c.ok("years come from RECENT rows only", JSON.stringify(p.years) === JSON.stringify([Number(nowKey.slice(0, 4))]), JSON.stringify(p.years));
    c.ok("previousTotal = 4, total = 6", p.previousTotal === 4 && p.total === 6, `${p.previousTotal}/${p.total}`);
    const only = await cv.portalVideoList(adaEnr, { perPage: 6, section: "previous" });
    c.ok("section 'previous' returns exactly the four", only.rows.length === 4 && only.rows.every((r) => r.section === "PREVIOUS") && only.section === "previous", `${only.rows.length}`);
    const y2025 = await cv.portalVideoList(adaEnr, { perPage: 6, year: 2025 });
    c.ok("a year that is only backfill is not a filter (no chip, whole list)", y2025.year === null && y2025.total === 6, `${y2025.year}/${y2025.total}`);
    c.ok("pure rule: no month at all is always Previous, even once confirmed", cv.librarySection({ monthKey: null, identityConfirmedAt: new Date() }, false) === "PREVIOUS");
  }

  // =========================================================================
  c.head("L2 · staff confirmation — back under its month, and the edit sticks");
  // =========================================================================
  {
    const r = await cv.correctVideoIdentity(ada.enrollmentId, hOct, { title: "Pricing myths", confirmMonth: true }, "kyle@drill.invalid", "checked against the Oct 2025 invoice");
    c.ok("correctVideoIdentity(title + confirmMonth) succeeds", r.ok === true && r.changed === 2, r.message);
    const rows = await prisma.contentVideoCorrection.findMany({ where: { videoId: hOct }, orderBy: { field: "asc" } });
    c.ok("  …two ContentVideoCorrection rows: the title and the month", rows.length === 2 && rows.some((x) => x.field === "title" && x.fromValue === "October market recap" && x.toValue === "Pricing myths") && rows.some((x) => x.field === "monthConfirmed" && x.toValue === "2025-10"), rows.map((x) => `${x.field}:${x.fromValue}->${x.toValue}`).join(" | "));
    c.ok("  …each carries who and why", rows.every((x) => x.by === "kyle@drill.invalid" && x.reason === "checked against the Oct 2025 invoice"));
    const p = await cv.portalVideoList(adaEnr, { perPage: 6 });
    const row = p.rows.find((x) => x.id === hOct);
    c.ok("the row is RECENT now, under 2025-10, titled as corrected", row?.section === "RECENT" && row.monthKey === "2025-10" && row.title === "Pricing myths", `${row?.section}/${row?.monthKey}/${row?.title}`);
    c.ok("  …2025 is a year chip now; three rows left in Previous", p.years.includes(2025) && p.previousTotal === 3, `${JSON.stringify(p.years)}/${p.previousTotal}`);
    const t = await cv.correctVideoIdentity(ada.enrollmentId, hNov1, { title: "Staging tips (2025)" }, "kyle@drill.invalid");
    const still = (await cv.portalVideoList(adaEnr, { perPage: 6 })).rows.find((x) => x.id === hNov1);
    c.ok("a title fix alone on a backfilled month does NOT move it out of Previous", t.ok && still?.section === "PREVIOUS" && still.title === "Staging tips (2025)", `${still?.section}`);

    // Another client's topic is refused, and nothing is written.
    const other = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Other Client TEST", package: "Starter", monthKey: nowKey, project: false, owner: false, topics: [{ title: "Not yours" }] });
    const before = await prisma.contentVideoCorrection.count();
    const x = await cv.correctVideoIdentity(ada.enrollmentId, hNov2, { topicId: other.topicIds[0] }, "kyle@drill.invalid");
    c.ok("a topic from another enrollment is refused", x.ok === false && /isn't on this client's program/.test(x.message), x.message);
    c.ok("  …and no correction row was written", (await prisma.contentVideoCorrection.count()) === before);
    const y = await cv.correctVideoIdentity(other.enrollmentId, hNov2, { title: "Hijack" }, "kyle@drill.invalid");
    c.ok("a video of another enrollment cannot be corrected through this one", y.ok === false && (await prisma.contentVideo.findUniqueOrThrow({ where: { id: hNov2 } })).title === "Holiday listing push", y.message);
    const k = await cv.correctVideoIdentity(ada.enrollmentId, cur2, { kind: "LISTING" }, "kyle@drill.invalid", "listing shoot");
    const kr = await prisma.contentVideo.findUniqueOrThrow({ where: { id: cur2 } });
    c.ok("kind → LISTING takes it out of the allowance, recorded twice (kind + allowance)", k.ok && kr.kind === "LISTING" && kr.countsTowardAllowance === false && kr.mappedBy === "kyle@drill.invalid" && k.changed === 3, `${k.changed} ${kr.kind}/${kr.countsTowardAllowance}`);
  }

  // =========================================================================
  c.head("L3 · reorder — index pairing is recorded, flagged, and fixed for good");
  // =========================================================================
  const bea = await buildContentMonth(prisma as unknown as PrismaClient, {
    name: "Bea Tours TEST", package: "Accelerator", monthKey: nowKey,
    project: { status: "SCHEDULED", shootDate: new Date(Date.now() - 10 * 86_400_000) },
    owner: { email: "bea@example.com", name: "Bea Tours" },
  });
  const beaEnr = { id: bea.enrollmentId, clientId: bea.clientId };
  const beaViewer = viewerOf(bea);
  const beaSeat: MediaScope = { kind: "membership", id: bea.membershipId! };
  const cutA = await mkCut({ projectId: bea.projectId!, deliverableId: bea.deliverableId!, slot: 1, fileName: "Tour A v1.mp4" });
  const cutB = await mkCut({ projectId: bea.projectId!, deliverableId: bea.deliverableId!, slot: 2, fileName: "Tour B v1.mp4" });
  c.ok("the client approves both cuts", (await cd.approveCut(beaViewer, cutA, "NONE")).ok && (await cd.approveCut(beaViewer, cutB, "NONE")).ok);
  // Aryeo lists them in the OTHER order, under titles that name neither — so
  // pairing falls back to list position and binds B's file to A.
  await prisma.portalVideo.create({ data: { enrollmentId: bea.enrollmentId, monthId: bea.monthId, projectId: bea.projectId!, title: "Social Video 1", playback: "https://cdn.aryeo.example/b.m3u8", download: "https://cdn.aryeo.example/b.mp4", source: "aryeo", externalKey: "aryeo:bea-listing:1f0c9a7e-b", deliveredAt: new Date(Date.now() - 2 * 86_400_000) } });
  await prisma.portalVideo.create({ data: { enrollmentId: bea.enrollmentId, monthId: bea.monthId, projectId: bea.projectId!, title: "Social Video 2", playback: "https://cdn.aryeo.example/a.m3u8", download: "https://cdn.aryeo.example/a.mp4", source: "aryeo", externalKey: "aryeo:bea-listing:1f0c9a7e-a", deliveredAt: new Date(Date.now() - 1 * 86_400_000) } });
  await cv.syncEnrollmentVideos(beaEnr);
  const vA = await videoOfCut(cutA);
  const vB = await videoOfCut(cutB);
  const srcB = await prisma.contentVideoSource.findFirstOrThrow({ where: { kind: "PORTAL_VIDEO", ref: "aryeo:bea-listing:1f0c9a7e-b" } });
  const srcA = await prisma.contentVideoSource.findFirstOrThrow({ where: { kind: "PORTAL_VIDEO", ref: "aryeo:bea-listing:1f0c9a7e-a" } });
  {
    c.ok("BEFORE (the pairing itself, unchanged): B's file was bound to video A by position", srcB.videoId === vA.id && srcA.videoId === vB.id, `${srcB.videoId === vA.id}/${srcA.videoId === vB.id}`);
    c.ok("both Aryeo sources now record matchBasis 'index'", srcA.matchBasis === "index" && srcB.matchBasis === "index", `${srcA.matchBasis}/${srcB.matchBasis}`);
    const cutSrc = await prisma.contentVideoSource.findFirstOrThrow({ where: { kind: "REVIEW_CUT", ref: cutA } });
    c.ok("the review cut's own source records 'cut'", cutSrc.matchBasis === "cut", `${cutSrc.matchBasis}`);
    const tab = await loadContentTab(bea.enrollmentId, bea.clientId, null);
    const fa = tab.rows.find((r) => r.id === vA.id)?.identity;
    const fb = tab.rows.find((r) => r.id === vB.id)?.identity;
    c.ok("staff Content tab flags both videos 'check pairing'", !!fa?.flags.includes("check pairing") && !!fb?.flags.includes("check pairing"), `${fa?.flags}/${fb?.flags}`);
    c.ok("  …and offers each the other as a relink target", fa?.relinkTargets.some((t) => t.id === vB.id) === true && fb?.relinkTargets.some((t) => t.id === vA.id) === true);
    c.ok("  …with the tool's pickers for this enrollment", tab.identity?.enrollmentId === bea.enrollmentId);

    const res = await door(vA.id, beaSeat);
    const loc = res.headers.get("location") ?? "";
    c.ok("the door for video A 302s to cut A — the approved cut is preferred over the mis-paired file", res.status === 302 && loc.includes(`/api/review/cut/${cutA}/stream`), `${res.status} ${loc.slice(0, 70)}`);

    // Refusals first.
    const noWhy = await staffActions.relinkDeliveredFileAction(bea.enrollmentId, srcB.id, vB.id, "  ");
    c.ok("relink without a reason is refused (it changes what the client downloads)", noWhy.ok === false && /Say why/.test(noWhy.message), noWhy.message);
    const otherShoot = await prisma.project.create({ data: { clientId: bea.clientId, title: "Bea — another shoot", status: "SCHEDULED", contentMonthId: bea.monthId }, select: { id: true } });
    const stranger = await prisma.contentVideo.create({ data: { enrollmentId: bea.enrollmentId, clientId: bea.clientId, monthId: bea.monthId, monthKey: nowKey, title: "Other shoot video", projectId: otherShoot.id, status: "PLANNED" }, select: { id: true } });
    const cross = await cv.relinkDeliveredFile(bea.enrollmentId, srcB.id, stranger.id, "kyle@drill.invalid", "x");
    c.ok("relink to a video of a different shoot is refused", cross.ok === false && /different shoot/.test(cross.message), cross.message);
    const foreign = await cv.relinkDeliveredFile(ada.enrollmentId, srcB.id, hNov2, "kyle@drill.invalid", "x");
    c.ok("relink through another enrollment is refused", foreign.ok === false, foreign.message);

    const r1 = await staffActions.relinkDeliveredFileAction(bea.enrollmentId, srcB.id, vB.id, "Aryeo listed them in the other order");
    const r2 = await staffActions.relinkDeliveredFileAction(bea.enrollmentId, srcA.id, vA.id, "Aryeo listed them in the other order");
    c.ok("relinkDeliveredFile swaps them", r1.ok && r2.ok, `${r1.message} | ${r2.message}`);
    const after = await prisma.contentVideoSource.findMany({ where: { id: { in: [srcA.id, srcB.id] } } });
    const a2 = after.find((s) => s.id === srcA.id)!;
    const b2 = after.find((s) => s.id === srcB.id)!;
    c.ok("  …A's file under A, B's under B, both matchBasis 'staff' and confirmed", a2.videoId === vA.id && b2.videoId === vB.id && a2.matchBasis === "staff" && b2.matchBasis === "staff" && !!a2.confirmedAt && !!b2.confirmedAt);
    const pvs = await prisma.portalVideo.findMany({ where: { enrollmentId: bea.enrollmentId }, select: { externalKey: true, videoId: true } });
    c.ok("  …the PortalVideo rows point the same way", pvs.find((p) => p.externalKey.endsWith("-a"))?.videoId === vA.id && pvs.find((p) => p.externalKey.endsWith("-b"))?.videoId === vB.id);
    c.ok("  …ledgered on both videos", (await prisma.contentVideoCorrection.count({ where: { videoId: { in: [vA.id, vB.id] }, field: "file" } })) === 4);
    await cv.syncEnrollmentVideos(beaEnr);
    await cv.syncEnrollmentVideos(beaEnr);
    const again = await prisma.contentVideoSource.findMany({ where: { id: { in: [srcA.id, srcB.id] } } });
    c.ok("two more syncs leave both links and their 'staff' basis unchanged", again.every((s) => s.matchBasis === "staff" && !!s.confirmedAt) && again.find((s) => s.id === srcA.id)?.videoId === vA.id && again.find((s) => s.id === srcB.id)?.videoId === vB.id);
    const tab2 = await loadContentTab(bea.enrollmentId, bea.clientId, null);
    c.ok("no 'check pairing' flag remains", tab2.rows.every((r) => !r.identity?.flags.includes("check pairing")), tab2.rows.map((r) => r.identity?.flags.join("+")).join(" | "));

    // L2's "edits stick" on a video the sync actually rebuilds.
    const t = await cv.correctVideoIdentity(bea.enrollmentId, vA.id, { title: "Tour of 12 Oak Lane" }, "kyle@drill.invalid");
    await cv.syncEnrollmentVideos(beaEnr);
    await cv.syncEnrollmentVideos(beaEnr);
    const vA2 = await prisma.contentVideo.findUniqueOrThrow({ where: { id: vA.id } });
    c.ok("a corrected title survives two syncs (the sync never writes titles)", t.ok && vA2.title === "Tour of 12 Oak Lane", `${vA2.title}`);
    c.ok("  …and on a live month the row reads as person-checked (the relink stamped it)", !!vA2.identityConfirmedAt && !!vA2.identityConfirmedBy);
  }

  // =========================================================================
  c.head("L3b · a person's confirmation is what lets the rule serve a position-paired file");
  // =========================================================================
  const cal = await buildContentMonth(prisma as unknown as PrismaClient, {
    name: "Cal Pairing TEST", package: "Starter", monthKey: nowKey,
    project: { status: "SCHEDULED", shootDate: new Date(Date.now() - 12 * 86_400_000) },
    owner: { email: "cal@example.com", name: "Cal" },
  });
  const calEnr = { id: cal.enrollmentId, clientId: cal.clientId };
  const calViewer = viewerOf(cal);
  const internal = await mkCut({ projectId: cal.projectId!, deliverableId: cal.deliverableId!, fileName: "Kitchen reveal v1.mp4", status: "PENDING" });
  await prisma.portalVideo.create({ data: { enrollmentId: cal.enrollmentId, monthId: cal.monthId, projectId: cal.projectId!, title: "Social Video 1", playback: "https://cdn.aryeo.example/k.m3u8", download: "https://cdn.aryeo.example/k.mp4", source: "aryeo", externalKey: "aryeo:cal-listing:7d1e-k", deliveredAt: new Date(Date.now() - 86_400_000) } });
  // A legacy positional row on a second shoot of the same month (L4).
  const legacyShoot = await prisma.project.create({ data: { clientId: cal.clientId, title: "Cal — legacy listing", status: "DELIVERED", deliveredAt: new Date("2026-08-20T15:00:00Z"), contentMonthId: cal.monthId, packageName: "Video Starter" }, select: { id: true } });
  await prisma.portalVideo.create({ data: { enrollmentId: cal.enrollmentId, monthId: cal.monthId, projectId: legacyShoot.id, title: "Listing film", thumb: "https://cdn.aryeo.example/l9.jpg", playback: "https://cdn.aryeo.example/l9.m3u8", download: "https://cdn.aryeo.example/l9.mp4", source: "aryeo", externalKey: "aryeo:L9:0", deliveredAt: new Date("2026-08-20T15:00:00Z") } });
  await cv.syncEnrollmentVideos(calEnr);
  const kv = await videoOfCut(internal);
  const kSrc = await prisma.contentVideoSource.findFirstOrThrow({ where: { kind: "PORTAL_VIDEO", ref: "aryeo:cal-listing:7d1e-k" } });
  {
    c.ok("the file was paired to the internal-only chain by position: matchBasis 'index'", kSrc.videoId === kv.id && kSrc.matchBasis === "index", `${kSrc.matchBasis}`);
    const e0 = await ce.videoEntitlement(kv);
    c.ok("BEFORE (confirmed was always false): UNCONFIRMED_PAIRING — the file is held back", e0.basis === "NONE" && e0.blockedBy === "UNCONFIRMED_PAIRING", `${e0.basis}/${e0.blockedBy}`);
    const r = await staffActions.confirmPairingAction(cal.enrollmentId, kSrc.id);
    c.ok("staff confirm the pairing", r.ok, r.message);
    const e1 = await ce.videoEntitlement(kv);
    c.ok("cutEntitlement reads the confirmation: DELIVERED_OUTSIDE_PORTAL, the Aryeo file served", e1.basis === "DELIVERED_OUTSIDE_PORTAL" && e1.file?.kind === "delivered" && e1.file.url === "https://cdn.aryeo.example/k.mp4", `${e1.basis}/${e1.blockedBy}`);
    const kvRow = await prisma.contentVideo.findUniqueOrThrow({ where: { id: kv.id } });
    c.ok("  …and the sync's cache agrees (status DELIVERED, final file the Aryeo URL)", kvRow.status === "DELIVERED" && kvRow.finalFileRef === "https://cdn.aryeo.example/k.mp4", `${kvRow.status}/${kvRow.finalFileRef}`);
    c.ok("  …the pairing keeps its 'index' basis, now confirmed (the record says how, and who stood behind it)", (await prisma.contentVideoSource.findUniqueOrThrow({ where: { id: kSrc.id } })).matchBasis === "index");
    const kit = await pk.postingKitFor(calViewer, kvRow);
    const kPv = await prisma.portalVideo.findFirstOrThrow({ where: { externalKey: "aryeo:cal-listing:7d1e-k" } });
    c.ok("the kit offers the file, in redirect mode (an Aryeo CDN file this page cannot read)", kit.access.download === true && kit.download?.mode === "redirect" && kit.download.ref === `portal-video:${kPv.id}`, `${kit.download?.mode}/${kit.download?.ref}`);
  }

  // =========================================================================
  c.head("L4 · a legacy positional Aryeo row is flagged; its playback is unchanged");
  // =========================================================================
  {
    const lSrc = await prisma.contentVideoSource.findFirstOrThrow({ where: { kind: "PORTAL_VIDEO", ref: "aryeo:L9:0" } });
    c.ok("the legacy row is linked to its own video ('own')", lSrc.matchBasis === "own", `${lSrc.matchBasis}`);
    const tab = await loadContentTab(cal.enrollmentId, cal.clientId, null);
    const li = tab.rows.find((r) => r.id === lSrc.videoId)?.identity;
    c.ok("staff see it flagged 'unverified legacy row'", !!li?.flags.includes("unverified legacy row") && li.files[0]?.legacyKey === true, `${li?.flags}`);
    const pv = await prisma.portalVideo.findFirstOrThrow({ where: { externalKey: "aryeo:L9:0" } });
    const list = await cv.portalVideoList(calEnr, { perPage: 24 });
    c.ok("the client still sees it, with its thumbnail and playback untouched", list.rows.some((r) => r.id === lSrc.videoId && r.thumb === "https://cdn.aryeo.example/l9.jpg") && pv.playback === "https://cdn.aryeo.example/l9.m3u8");
    const e = await ce.videoEntitlement(await prisma.contentVideo.findUniqueOrThrow({ where: { id: lSrc.videoId } }));
    c.ok("  …and still downloads it (a flag for staff, never a lock on the client)", e.file?.kind === "delivered", `${e.basis}`);
    await staffActions.confirmPairingAction(cal.enrollmentId, lSrc.id);
    const tab2 = await loadContentTab(cal.enrollmentId, cal.clientId, null);
    c.ok("confirming it clears the flag", !tab2.rows.find((r) => r.id === lSrc.videoId)?.identity?.flags.includes("unverified legacy row"));
  }

  // =========================================================================
  c.head("L5 · a filmed topic row survives sync and is adopted onto its cut chain");
  // =========================================================================
  {
    const dan = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: "Dan Topics TEST", package: "Starter", monthKey: nowKey,
      project: { status: "SCHEDULED", shootDate: new Date(Date.now() - 9 * 86_400_000) },
      owner: false, topics: [{ title: "Why pricing high backfires", selection: "SELECTED" }],
    });
    const danEnr = { id: dan.enrollmentId, clientId: dan.clientId };
    const topicRow = await prisma.contentVideo.create({
      data: {
        enrollmentId: dan.enrollmentId, clientId: dan.clientId, monthId: dan.monthId, monthKey: nowKey, kind: "PROGRAM", title: "Why pricing high backfires",
        topicId: dan.topicIds[0], selectionId: dan.selectionIds[0], projectId: dan.projectId!, status: "FILMED", source: "upload_portal",
        filmedAt: new Date(Date.now() - 9 * 86_400_000), filmedConfirmedAt: new Date(Date.now() - 9 * 86_400_000), filmedConfirmedBy: "harrison@example.com", filmedSource: "upload_portal",
      },
      select: { id: true },
    });
    const img = await mkCut({ projectId: dan.projectId!, deliverableId: dan.deliverableId!, fileName: "IMG_4471 v1.mp4" });
    await cv.syncEnrollmentVideos(danEnr);
    const chain = await videoOfCut(img);
    const t0 = await prisma.contentVideo.findUniqueOrThrow({ where: { id: topicRow.id } });
    c.ok("the topic row (topic, project, filming confirmation, no source) survives sync", t0.status !== "ARCHIVED", t0.status);
    c.ok("BEFORE the tool: the cut lives under the editor's file name, with no topic", chain.id !== topicRow.id && chain.title === "IMG 4471" && chain.topicId === null, `${chain.title}/${chain.topicId}`);
    const counts0 = (await cv.programCountsByMonth(dan.enrollmentId, [nowKey])).get(nowKey)!;
    c.ok("  …and the month counts the one real video twice", counts0.total === 2, JSON.stringify(counts0));
    const tab = await loadContentTab(dan.enrollmentId, dan.clientId, null);
    const ti = tab.rows.find((r) => r.id === topicRow.id)?.identity;
    c.ok("staff see 'filmed topic not linked to a cut', offering the chain", !!ti?.flags.includes("filmed topic not linked to a cut") && ti.adoptInto.some((x) => x.id === chain.id), `${ti?.flags}`);
    const refused = await cv.adoptTopicVideo(dan.enrollmentId, topicRow.id, chain.id, "kyle@drill.invalid");
    c.ok("adopting the wrong way round is refused (the cut row holds files)", refused.ok === false, refused.message);
    const r = await staffActions.adoptTopicVideoAction(dan.enrollmentId, chain.id, topicRow.id);
    c.ok("adoptTopicVideo(chain, topic) succeeds", r.ok, r.message);
    const c1 = await prisma.contentVideo.findUniqueOrThrow({ where: { id: chain.id } });
    const t1 = await prisma.contentVideo.findUniqueOrThrow({ where: { id: topicRow.id } });
    c.ok("  …the chain video now carries the topic, selection and the topic's title", c1.topicId === dan.topicIds[0] && c1.selectionId === dan.selectionIds[0] && c1.title === "Why pricing high backfires", `${c1.title}`);
    c.ok("  …and the photographer's filming confirmation", c1.filmedConfirmedBy === "harrison@example.com" && !!c1.filmedConfirmedAt);
    c.ok("  …the topic row is ARCHIVED (kept) with a note naming the chain", t1.status === "ARCHIVED" && (t1.notes ?? "").includes(`merged into ${chain.id}`), `${t1.status} ${t1.notes}`);
    const counts1 = (await cv.programCountsByMonth(dan.enrollmentId, [nowKey])).get(nowKey)!;
    c.ok("the double count is gone: total 2 → 1, delivered unchanged", counts1.total === 1 && counts1.delivered === counts0.delivered, `${JSON.stringify(counts0)} → ${JSON.stringify(counts1)}`);
    await cv.syncEnrollmentVideos(danEnr);
    const c2 = await prisma.contentVideo.findUniqueOrThrow({ where: { id: chain.id } });
    c.ok("a later sync keeps the adopted topic and title", c2.topicId === dan.topicIds[0] && c2.title === "Why pricing high backfires");
  }

  // =========================================================================
  c.head("L6 · downloads — proxy vs redirect, 'started' vs 'completed', staff excluded");
  // =========================================================================
  {
    const vAr = await prisma.contentVideo.findUniqueOrThrow({ where: { id: vA.id } });
    const kit0 = await pk.postingKitFor(beaViewer, vAr);
    c.ok("a hub-held cut (in the store, 5 bytes ≤ 400 MB) downloads in 'proxy' mode", kit0.download?.mode === "proxy" && kit0.download.ref === cutA && kit0.download.sizeBytes === BYTES.length, JSON.stringify(kit0.download));
    c.ok("  …L3's client door hit reads as started; nothing completed yet", !!kit0.downloadStartedAtISO && kit0.downloadCompletedAtISO === null);

    // BEFORE: the old reader counted any visit on the path, staff included.
    const staffHit = await door(vB.id, staffScope);
    c.ok("a staff-scope door hit on video B: 302, recorded as STAFF", staffHit.status === 302 && (await prisma.portalVisit.count({ where: { via: "STAFF", path: { startsWith: `/portal/download/${vB.id}` } } })) === 1, `${staffHit.status}`);
    const oldRead = await prisma.portalVisit.findFirst({ where: { enrollmentId: bea.enrollmentId, path: { startsWith: `/portal/download/${vB.id}` } } });
    c.ok("BEFORE: the old kit query read that staff hit as the client's 'Downloaded'", !!oldRead);
    const kitB = await pk.postingKitFor(beaViewer, await prisma.contentVideo.findUniqueOrThrow({ where: { id: vB.id } }));
    c.ok("now: a staff hit is not the client's 'started'", kitB.downloadStartedAtISO === null, `${kitB.downloadStartedAtISO}`);

    // The proxy path the button follows: the door, then its same-origin 302.
    const res = await door(vA.id, beaSeat);
    const loc = res.headers.get("location") ?? "";
    const target = new URL(loc);
    c.ok("the client's door hit: 302 to the same-origin stream route", res.status === 302 && /^(localhost|127\.0\.0\.1)$/.test(target.hostname) && target.pathname === `/api/review/cut/${cutA}/stream`, loc.slice(0, 60));
    const body = await streamAt(cutA, loc);
    c.ok("  …which serves the bytes with a Content-Length (what the progress bar reads)", body.status === 200 && body.headers.get("content-length") === String(BYTES.length) && (await body.text()) === BYTES, `${body.status} ${body.headers.get("content-length")}`);
    const resumed = await streamAt(cutA, loc, { range: "bytes=2-" });
    c.ok("  …and 'Try again' resumes with Range: 206 with the rest", resumed.status === 206 && (await resumed.text()) === "cde" && resumed.headers.get("content-range") === "bytes 2-4/5", `${resumed.status} ${resumed.headers.get("content-range")}`);
    const kit1 = await pk.postingKitFor(beaViewer, vAr);
    c.ok("the door hit is 'Download started' — not completed", !!kit1.downloadStartedAtISO && kit1.downloadCompletedAtISO === null);

    const auth = { token: bea.portalToken };
    const wrongRef = await actions.portalDownloadCompleted(auth, vA.id, cutB);
    c.ok("a completion naming another file is refused", wrongRef.ok === false, wrongRef.message);
    const done1 = await actions.portalDownloadCompleted(auth, vA.id, cutA);
    c.ok("portalDownloadCompleted records the completion", done1.ok === true, done1.message);
    const doneRows = await prisma.portalVisit.findMany({ where: { enrollmentId: bea.enrollmentId, path: { contains: "done=1" } } });
    c.ok("  …one PortalVisit ending &done=1, on the exact file", doneRows.length === 1 && doneRows[0].path === `/portal/download/${vA.id}?cut=${cutA}&done=1` && doneRows[0].via === "TOKEN", doneRows.map((d) => d.path).join(","));
    await actions.portalDownloadCompleted(auth, vA.id, cutA);
    c.ok("  …a second beacon inside ten minutes adds nothing", (await prisma.portalVisit.count({ where: { enrollmentId: bea.enrollmentId, path: { contains: "done=1" } } })) === 1);
    const kit2 = await pk.postingKitFor(beaViewer, vAr);
    c.ok("the kit now reports both, as two facts from two rows", !!kit2.downloadStartedAtISO && !!kit2.downloadCompletedAtISO && kit2.downloadStartedAtISO === kit1.downloadStartedAtISO, `${kit2.downloadStartedAtISO} / ${kit2.downloadCompletedAtISO}`);

    // A video the client may not download yet.
    const cutC = await mkCut({ projectId: bea.projectId!, deliverableId: bea.deliverableId!, slot: 3, fileName: "Tour C v1.mp4" });
    await cv.syncEnrollmentVideos(beaEnr);
    const vC = await videoOfCut(cutC);
    const refused = await actions.portalDownloadCompleted(auth, vC.id, cutC);
    c.ok("a completion beacon for a non-entitled video (awaiting approval) is refused", refused.ok === false && (await prisma.portalVisit.count({ where: { path: { contains: `${vC.id}?cut=` } } })) === 0, refused.message);
    const foreignVid = await actions.portalDownloadCompleted(auth, kv.id, `portal-video:x`);
    c.ok("  …and one for another client's video", foreignVid.ok === false, foreignVid.message);

    // The 90-day prune: the cut is now only in Dropbox.
    await prisma.reviewSubmission.update({ where: { id: cutA }, data: { blobUrl: null, blobPathname: null } });
    const kit3 = await pk.postingKitFor(beaViewer, vAr);
    c.ok("after the prune (Dropbox-held) the same cut downloads in 'redirect' mode", kit3.download?.mode === "redirect" && kit3.access.download === true, JSON.stringify(kit3.download));
    await prisma.reviewSubmission.update({ where: { id: cutA }, data: { blobUrl: BLOB(cutA), blobPathname: `review-cuts/${cutA}.mp4` } });
    // A big one, approved at its real size (the size is part of the approval's identity).
    const cutD = await mkCut({ projectId: bea.projectId!, deliverableId: bea.deliverableId!, slot: 4, fileName: "Tour D v1.mp4" });
    await prisma.reviewSubmission.update({ where: { id: cutD }, data: { sizeBytes: pk.PROXY_MAX_BYTES + 1 } });
    await cd.approveCut(beaViewer, cutD, "NONE");
    await cv.syncEnrollmentVideos(beaEnr);
    const kit4 = await pk.postingKitFor(beaViewer, await videoOfCut(cutD));
    c.ok("a hub-held cut over 400 MB is 'redirect' too (a phone would hold it in memory)", kit4.access.download && kit4.download?.mode === "redirect", JSON.stringify(kit4.download));
    const kit5 = await pk.postingKitFor(beaViewer, await prisma.contentVideo.findUniqueOrThrow({ where: { id: vC.id } }));
    c.ok("a video with no entitled file has no download plan", kit5.download === null && kit5.access.download === false);
  }

  // =========================================================================
  c.head("L7 · ended — playback and downloads stay, the way back is offered, the rest refused");
  // =========================================================================
  {
    // A historical delivery on Bea's account (imported month, pre-gate cut).
    const old = await prisma.contentMonth.create({ data: { enrollmentId: bea.enrollmentId, clientId: bea.clientId, monthKey: "2025-11", videosOwed: 4, status: "IMPORTED", historical: true }, select: { id: true } });
    const oldJob = await prisma.project.create({ data: { clientId: bea.clientId, title: "Bea — Nov 2025", status: "DELIVERED", deliveredAt: new Date("2025-11-21T15:00:00Z"), contentMonthId: old.id, packageName: "Video Accelerator" }, select: { id: true } });
    const oldReel = await prisma.deliverable.create({ data: { projectId: oldJob.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", quantity: 4 }, select: { id: true } });
    const hCut = await mkCut({ projectId: oldJob.id, deliverableId: oldReel.id, fileName: "Old listing tour v1.mp4", decidedAt: new Date("2025-11-20T15:00:00Z"), completedAt: new Date("2025-11-20T15:05:00Z"), createdAt: new Date("2025-11-19T15:00:00Z") });
    await cv.syncEnrollmentVideos(beaEnr);
    const hv = await videoOfCut(hCut);
    const listed = (await cv.portalVideoList(beaEnr, { perPage: 24 })).rows.find((r) => r.id === hv.id);
    c.ok("the historical delivery sits in Previous content", listed?.section === "PREVIOUS", `${listed?.section}`);

    await prisma.contentEnrollment.update({ where: { id: bea.enrollmentId }, data: { status: "ENDED" } });
    const link: MediaScope = { kind: "enrollment", id: bea.enrollmentId };
    const rA = await door(vA.id, link);
    const rH = await door(hv.id, link);
    c.ok("ENDED: the approved video's door still 302s", rA.status === 302, `${rA.status} ${await errorOf(rA)}`);
    c.ok("ENDED: the historical video's door still 302s", rH.status === 302, `${rH.status} ${await errorOf(rH)}`);
    const r = await portal.resolvePortalViewer({ token: bea.portalToken });
    c.ok("ENDED: the link still resolves, read-only", r.ok && r.viewer.access === "READ_ONLY");

    const n = portal.readOnlyNotice("ENDED");
    c.ok("readOnlyNotice('ENDED') links to the resubscribe page", n.cta.href === RESUBSCRIBE_URL && RESUBSCRIBE_URL === "https://realtourpilot.com/content-program" && n.cta.label === "Restart your program", JSON.stringify(n.cta));
    const p = portal.readOnlyNotice("PAUSED");
    c.ok("readOnlyNotice('PAUSED') says resume, same link", p.cta.label === "Resume your program" && p.cta.href === RESUBSCRIBE_URL && /paused/.test(p.title));
    c.ok("  …and both say delivered work stays", /watch and download/.test(n.body) && /watch and download/.test(p.body));

    const auth = { token: bea.portalToken };
    const ended = "Your program has ended, so this is view-only — your finished content stays here for you.";
    const sess = await actions.portalRequestSession(auth, { monthId: bea.monthId, location: "12 Oak Lane" });
    c.ok("ENDED: portalRequestSession refuses with the ended sentence", sess.ok === false && sess.message === ended, sess.message);
    const cap = await actions.portalDraftCaption(auth, vA.id);
    c.ok("ENDED: portalDraftCaption refuses with the ended sentence", cap.ok === false && cap.message === ended, cap.message);
    const doneH = await actions.portalDownloadCompleted(auth, hv.id, hCut);
    c.ok("ENDED: recording a completed download still works (downloads are theirs)", doneH.ok === true, doneH.message);
  }

  // =========================================================================
  c.head("L8 · 'finished' is recorded only once the file has left the page (review, Sep 24 2026)");
  // =========================================================================
  // The download button is a client component: read, not rendered. The page
  // used to send the completion as soon as every byte was in memory — before
  // an iPhone's second tap — so closing the share sheet left "Saved" on record
  // over nothing. (DownloadButton is new in this batch; there is no older one.)
  {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const repo = pathMod.resolve(__dirname, "../..");
    const src = fsMod.readFileSync(pathMod.join(repo, "src/components/portal/DownloadButton.tsx"), "utf8").replace(/\/\/.*$/gm, "");
    const calls = src.split("portalDownloadCompleted(").length - 1;
    const finishedBody = /const finished = \(\) => \{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? "";
    c.ok("the beacon is sent from ONE place (finished)", calls === 1 && finishedBody.includes("portalDownloadCompleted("), `${calls} call(s)`);
    const runBody = /const run = async \(\) => \{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? "";
    const readyAt = runBody.indexOf('setState({ kind: "ready"');
    const beforeReady = runBody.slice(0, readyAt);
    c.ok("  not when the bytes arrive (nothing before the 'Share / save' state calls it)", readyAt > 0 && !/finished\(\)|portalDownloadCompleted/.test(beforeReady));
    const shareBody = /const share = \(file: File\) => \{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? "";
    c.ok("  but when the share sheet resolves, or the file is handed to the browser's save", /\(\) => \{ finished\(\); setState\(\{ kind: "saved", how: "share" \}\)/.test(shareBody) && /saveAsFile\(file\);\s*finished\(\);/.test(src));
    c.ok("  and closing the sheet records nothing", /AbortError"\) return;/.test(shareBody));
    const panel = fsMod.readFileSync(pathMod.join(repo, "src/components/portal/PostingKitPanel.tsx"), "utf8");
    c.ok("the posting kit says 'Download finished', never 'Saved'", /Download finished \{fmt\(downloadCompletedAtISO\)\}/.test(panel) && !/>Saved \{fmt\(downloadCompletedAtISO\)/.test(panel));
  }

  // =========================================================================
  c.head("isolation");
  // =========================================================================
  c.ok("no outbound call left the process", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("the only 'network' was the canned hub-store file", fence.faked.every((u) => /public\.blob\.vercel-storage\.com/.test(u)), `${fence.faked.length} canned reads`);
  c.ok("no Prisma error was logged", quiet.count === 0, `${quiet.count}`);
  quiet.restore();

  c.summary();
  await stop();
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(async (e) => {
  console.error(e);
  process.exit(1);
});
