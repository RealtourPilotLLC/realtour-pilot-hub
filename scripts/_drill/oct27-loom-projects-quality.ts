// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Jordan's Oct 27 2026 Loom, items 6 and 8 (the Media page's Share and
// the editors' first-review number).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-projects-quality.ts
//
//   1  the first-review rule, pure (lib/editorQuality firstReviewOutcome).
//      Jordan: "96.8% passed the first time. I don't think this is accurate."
//      Passed = approved as it was; a version sent back counts as sent back
//      even with no cause recorded yet; a bounce that was all somebody else's
//      is left out, never a pass; anything never judged is left out.
//   2  the card says it in plain words (approved on the first version, how
//      many were sent back and how many still wait on a cause, what is not
//      counted, the window), with no em dash.
//   3  the share link, pure (lib/mediaShareCore): only the client's portal on
//      that one video, a live portal link first, then the sign-in address;
//      never Dropbox, Aryeo, a Blob or a stream route; nothing for a video
//      with no portal home, a revoked program or a video of another client.
//   4  shareLinksFor on seeded rows (PGlite), and the tile: Share beside
//      Download only when there is a link, "Share" until pressed.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT). No
// provider, no client send, nothing written by the readers.
// ---------------------------------------------------------------------------
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} });
navigation.usePathname = () => "/media";

const DASH = /[—–]|&mdash;|&ndash;/;
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5630), env: { APP_SECRET: "oct27-loom-projects-quality", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const c = makeChecker();
  try {
    const eq = await import("@/lib/editorQuality");
    // =========================================================================
    c.head("1 · first review: passed means approved as it was (pure)");
    // =========================================================================
    const dec = new Date("2026-10-20T15:00:00Z");
    const issue = (cause: string, extra: { confirmed?: boolean; state?: string; foundAfterApproval?: boolean; duplicateOfId?: string | null } = {}) => {
      const confirmed = extra.confirmed ?? cause !== "UNCLASSIFIED";
      return { cause, causeConfirmedAt: confirmed ? dec : null, causeConfirmedBy: confirmed ? "James" : null, state: extra.state ?? "OPEN", foundAfterApproval: !!extra.foundAfterApproval, duplicateOfId: extra.duplicateOfId ?? null };
    };
    const o = (status: string, decided: Date | null, issues: ReturnType<typeof issue>[] = []) => eq.firstReviewOutcome({ status, decidedAt: decided }, issues);
    const table: [string, ReturnType<typeof o>, ReturnType<typeof o>][] = [
      ["approved, nothing on it", o("APPROVED", dec), "passed"],
      ["approved with an unclassified note (the review still passed it)", o("APPROVED", dec, [issue("UNCLASSIFIED")]), "passed"],
      ["approved over a confirmed editor error", o("APPROVED", dec, [issue("EDITOR_ERROR")]), "failed"],
      ["approved, a defect found only after approval", o("APPROVED", dec, [issue("EDITOR_ERROR", { foundAfterApproval: true })]), "passed"],
      ["sent back with nothing recorded", o("CHANGES_REQUESTED", dec), "waitingOnCause"],
      ["sent back, issue not classified yet", o("CHANGES_REQUESTED", dec, [issue("UNCLASSIFIED")]), "waitingOnCause"],
      ["sent back, a cause picked but not confirmed by a person", o("CHANGES_REQUESTED", dec, [issue("EDITOR_ERROR", { confirmed: false })]), "waitingOnCause"],
      ["sent back, a client change and one still to classify", o("CHANGES_REQUESTED", dec, [issue("CLIENT_CHANGE"), issue("UNCLASSIFIED")]), "waitingOnCause"],
      ["sent back, a confirmed editor error", o("CHANGES_REQUESTED", dec, [issue("EDITOR_ERROR")]), "failed"],
      ["sent back, a missed instruction (the editor's)", o("CHANGES_REQUESTED", dec, [issue("MISSED_INSTRUCTION")]), "failed"],
      ["sent back, every issue somebody else's", o("CHANGES_REQUESTED", dec, [issue("CLIENT_CHANGE"), issue("BRIEF_GAP"), issue("CAPTURE")]), "notEditors"],
      ["sent back, the only issue a merged duplicate (nothing live left)", o("CHANGES_REQUESTED", dec, [issue("CLIENT_CHANGE", { duplicateOfId: "x" })]), "waitingOnCause"],
      ["waiting on review", o("PENDING", null), "pendingReview"],
      ["replaced before anyone ruled", o("SUPERSEDED", null), "replacedBeforeReview"],
      ["a decided version in another state (never a pass)", o("SUPERSEDED", dec), "notCounted"],
      ["a decided withdrawn version", o("WITHDRAWN", dec), "notCounted"],
    ];
    for (const [label, got, want] of table) c.ok(`${label}: ${want}`, got === want, got);

    // =========================================================================
    c.head("2 · the card in plain words");
    // =========================================================================
    const { EditorQualityCard } = await import("@/components/editing/EditorQualityCard");
    const base: import("@/lib/editorQuality").EditorQualityReport = {
      editorKey: "kim", editorName: "Kim Miguel", fromISO: "2026-09-25T04:00:00.000Z", toISO: "2026-10-27T16:00:00.000Z", trackedSinceISO: "2026-09-25T04:00:00.000Z",
      firstReview: { passed: 5, reviewed: 7, sentBack: 2, waitingOnCause: 1, notEditors: 1, pendingReview: 2, replacedBeforeReview: 0, notCounted: 0, rate: 71.4, thin: false, byProduct: [{ product: "Standard Cinematic", passed: 5, reviewed: 7 }] },
      recurring: { n: 0, thin: true, groups: [], weekly: [] },
      missed: { count: 0, asked: 0, thin: true, examples: [] },
      declaredNotDone: { count: 0, examples: [] },
      turnaround: { n: 0, thin: true, medianHours: null, processingN: 0, medianProcessingHours: null, waitingOnAssetsHours: null, clientWaitN: 0, medianClientWaitHours: null },
      clientVisible: { n: 0, editingFault: 0, reviewMiss: 0, unclassified: 0, other: 0, examples: [] },
      reviewWaiting: { n: 0, thin: true, byReviewer: [], pending: 0, oldestPendingHours: null },
    };
    const card = html(createElement(EditorQualityCard, { report: base }));
    const ct = text(card);
    c.ok("the number reads 'approved on the first version', with its n (5 of 7)", /71\.4% approved on the first version · 5 of 7/.test(ct) && !/passed first time/.test(ct), ct.slice(0, 300));
    c.ok("…how many were sent back, and how many still wait on a cause", ct.includes("2 sent back for changes, 1 of them still waiting on a cause"));
    c.ok("…what is not counted, only the parts that are there", ct.includes("Not counted: 1 sent back for a reason that wasn't the editor's · 2 waiting on review") && !ct.includes("replaced before review"));
    c.ok("…the window: since the day review issues began being recorded", ct.includes("Since Sep 25, when review issues began being recorded. Numbers only, nothing here touches pay."));
    c.ok("no em dash anywhere on the card, and no bare dash for a missing number", !DASH.test(card) && ct.includes("No revision turned around yet.") && ct.includes("Processing (Topaz pass): not recorded"));
    const all = html(createElement(EditorQualityCard, { report: { ...base, fromISO: "2026-10-01T04:00:00.000Z", firstReview: { ...base.firstReview, sentBack: 3, waitingOnCause: 3, reviewed: 8, notEditors: 0, pendingReview: 0, rate: 62.5 } } }));
    c.ok("all bounces waiting on a cause say so; nothing not counted means no 'Not counted' line; a later window reads 'Last 90 days'", text(all).includes("3 sent back for changes, all still waiting on a cause") && !text(all).includes("Not counted") && text(all).includes("Last 90 days, since Oct 1."));
    const thin = html(createElement(EditorQualityCard, { report: { ...base, firstReview: { ...base.firstReview, passed: 2, reviewed: 3, sentBack: 1, waitingOnCause: 0, rate: null, thin: true } } }));
    c.ok("a thin sample shows no percentage", text(thin).includes("Too few yet approved on the first version · 2 of 3") && text(thin).includes("not enough to judge yet") && !/\d+(\.\d)?%/.test(text(thin)));

    // =========================================================================
    c.head("3 · the share link: the client's portal on that video, never Dropbox (pure)");
    // =========================================================================
    const { videoShareLink, isClientSafeShareLink } = await import("@/lib/mediaShareCore");
    const BASE = "https://hub.example.test";
    const now = new Date("2026-10-27T16:00:00Z");
    const vid = "cmvideo0000000001";
    const enr = { id: "cmenroll000000001", clientId: "cmclient000000001", portalToken: "TokTokTokTokTokTokTok_-12", portalTokenExpiresAt: null as Date | null, accessRevokedAt: null as Date | null };
    const facts = (over: Partial<Parameters<typeof videoShareLink>[1]> = {}) => ({ contentVideoId: vid, video: { enrollmentId: enr.id, clientId: enr.clientId }, enrollment: enr, hasSeat: true, ...over });
    c.ok("a live portal link: /portal/<token>?tab=library&v=<video>", videoShareLink(BASE, facts(), now) === `${BASE}/portal/${enr.portalToken}?tab=library&v=${vid}`, String(videoShareLink(BASE, facts(), now)));
    c.ok("an expired portal link and a login: the sign-in address on that video", videoShareLink(BASE, facts({ enrollment: { ...enr, portalTokenExpiresAt: new Date(now.getTime() - 1000) } }), now) === `${BASE}/portal/me?e=${enr.id}&tab=library&v=${vid}`);
    c.ok("no portal link and no login: no Share", videoShareLink(BASE, facts({ enrollment: { ...enr, portalToken: null }, hasSeat: false }), now) === null);
    c.ok("a revoked program: no Share", videoShareLink(BASE, facts({ enrollment: { ...enr, accessRevokedAt: now } }), now) === null);
    c.ok("a listing video (no program video): no Share", videoShareLink(BASE, facts({ contentVideoId: null }), now) === null);
    c.ok("a video of another program or client: no Share", videoShareLink(BASE, facts({ video: { enrollmentId: "cmenroll000000002", clientId: enr.clientId } }), now) === null && videoShareLink(BASE, facts({ video: { enrollmentId: enr.id, clientId: "cmclient000000002" } }), now) === null);
    c.ok("a malformed token is never used (falls to the sign-in address)", videoShareLink(BASE, facts({ enrollment: { ...enr, portalToken: "short" } }), now) === `${BASE}/portal/me?e=${enr.id}&tab=library&v=${vid}`);
    const unsafe = [
      "https://www.dropbox.com/s/abc/video.mp4?dl=0",
      `${BASE}/api/media/video/cmcut0000000001`,
      `${BASE}/api/review/cut/cmcut0000000001/stream`,
      "https://videos.aryeo.com/alpha-reel.mp4",
      "https://abc.public.blob.vercel-storage.com/cut.mp4",
      `${BASE}/portal/login`,
      `https://evil.example.test/portal/${enr.portalToken}?tab=library&v=${vid}`,
      `${BASE}/portal/${enr.portalToken}?tab=library&v=${vid}&next=https://dropbox.com`,
      `${BASE}/listings/cmproject00000001`,
    ];
    c.ok("the last check refuses Dropbox, Aryeo's file, a Blob, the hub's stream routes, another host, extra query, any non-portal page", unsafe.every((u) => !isClientSafeShareLink(u, BASE)), unsafe.filter((u) => isClientSafeShareLink(u, BASE)).join(" | "));
    c.ok("…and passes exactly the two portal shapes", isClientSafeShareLink(`${BASE}/portal/${enr.portalToken}?tab=library&v=${vid}`, BASE) && isClientSafeShareLink(`${BASE}/portal/me?e=${enr.id}&tab=library&v=${vid}`, BASE));

    // =========================================================================
    c.head("4 · shareLinksFor on seeded rows, and the tile");
    // =========================================================================
    const { prisma } = await import("@/lib/prisma");
    const mk = async (name: string, o: { token?: string | null; expires?: Date | null; revoked?: Date | null; seat?: boolean }) => {
      const client = await prisma.client.create({ data: { name } });
      const e = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, portalToken: o.token ?? null, portalTokenExpiresAt: o.expires ?? null, accessRevokedAt: o.revoked ?? null }, select: { id: true } });
      if (o.seat) {
        const u = await prisma.clientUser.create({ data: { email: `${name.split(" ")[0].toLowerCase()}@drill.test`, name, status: "ACTIVE" }, select: { id: true } });
        await prisma.clientMembership.create({ data: { clientUserId: u.id, enrollmentId: e.id, clientId: client.id } });
      }
      const v = await prisma.contentVideo.create({ data: { enrollmentId: e.id, clientId: client.id, title: `${name} video`, kind: "PROGRAM" } as never, select: { id: true } });
      return { clientId: client.id, enrollmentId: e.id, videoId: v.id };
    };
    const tokenOne = await mk("Erica Token", { token: "EricaTokenEricaToken_-99" });
    const seatOne = await mk("Bernadette Seat", { token: null, seat: true });
    const noneOne = await mk("Nora Nothing", { token: null });
    const revokedOne = await mk("Rex Revoked", { token: "RexTokenRexTokenRexTok_1", revoked: new Date(), seat: true });
    const { shareLinksFor } = await import("@/lib/mediaShare");
    const writesBefore = await prisma.contentVideo.count() + await prisma.contentEnrollment.count();
    const links = await shareLinksFor([tokenOne.videoId, seatOne.videoId, noneOne.videoId, revokedOne.videoId, null, "cmnotavideo000001"]);
    c.ok("a live portal link: the token page on that video", links.get(tokenOne.videoId) === `https://hub.example.test/portal/EricaTokenEricaToken_-99?tab=library&v=${tokenOne.videoId}`, JSON.stringify([...links]));
    c.ok("a login only: the sign-in address on that video", links.get(seatOne.videoId) === `https://hub.example.test/portal/me?e=${seatOne.enrollmentId}&tab=library&v=${seatOne.videoId}`);
    c.ok("no portal home, a revoked program, an unknown id: no link", !links.has(noneOne.videoId) && !links.has(revokedOne.videoId) && !links.has("cmnotavideo000001") && links.size === 2);
    c.ok("every link is a portal link, none Dropbox", [...links.values()].every((u) => isClientSafeShareLink(u, "https://hub.example.test") && !/dropbox/i.test(u)));
    c.ok("the reader writes nothing", writesBefore === await prisma.contentVideo.count() + await prisma.contentEnrollment.count() && await prisma.outboxMessage.count() === 0);

    const { VideoTile, VideoModal } = await import("@/components/media/VideoTile");
    const view = {
      key: "cut:cmcut0000000001", title: "The pricing myth", eyebrow: "October 2026", place: "12 Elm St, Malvern, PA", clientId: tokenOne.clientId, clientName: "Erica Token", projectId: null,
      dateText: "Delivered Oct 24, 2026", orientation: "vertical" as const, poster: null, playSrc: "/api/media/video/cmcut0000000001", downloadHref: "/api/media/video/cmcut0000000001?dl=1", durationSec: 42,
      coverHref: null, shareHref: links.get(tokenOne.videoId)!,
    };
    const tile = html(createElement(VideoTile, { video: view, frame: "vertical" }));
    c.ok("the tile: Share beside Download, carrying the portal link, saying 'Share'", tile.includes(`data-share-video="${view.shareHref.replace(/&/g, "&amp;")}"`) && tile.indexOf("data-share-video") > tile.indexOf('aria-label="Download The pricing myth"') && />Share</.test(tile) && tile.includes("Copy a link to this video in the client"), tile.slice(tile.indexOf("Download The"), tile.indexOf("Download The") + 700));
    c.ok("…no Dropbox address, no em dash in the tile", !/dropbox/i.test(tile) && !DASH.test(tile));
    const plain = html(createElement(VideoTile, { video: { ...view, shareHref: null }, frame: "vertical" }));
    c.ok("a video with no portal link has no Share button", !plain.includes("data-share-video") && !/>Share</.test(plain));
    // The player opens in a dialog the static render leaves closed, so read the element tree it returns (it has no hooks).
    const { ShareVideoButton } = await import("@/components/media/ShareVideoButton");
    const shares = (tree: unknown): { href?: string }[] => Array.isArray(tree) ? tree.flatMap(shares)
      : !isValidElement<Record<string, unknown>>(tree) ? []
      : [...(tree.type === ShareVideoButton ? [tree.props as { href?: string }] : []), ...Object.values(tree.props).flatMap(shares)];
    c.ok("the larger player has Share too, with the same link", shares(VideoModal({ video: view, narrow: true, onClose: () => {} })).map((p) => p.href).join() === view.shareHref);
    c.ok("…and none without a link", shares(VideoModal({ video: { ...view, shareHref: null }, narrow: true, onClose: () => {} })).length === 0);
    c.ok("nothing left the machine", fence.blocked.length === 0);
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
