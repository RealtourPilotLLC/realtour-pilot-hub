// ---------------------------------------------------------------------------
// DRILL: CP-02/03 hardening — the Sep 24 review's findings on review windows
// and client decisions, each driven through the SHIPPED code.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp02b-review-hardening.ts
//
// The buggy code these fix was never committed (batch A was reviewed in the
// working tree), so there is no BASE to load. Where the old answer can still
// be observed it is: the old query or predicate is run inline on the same
// rows (the repair's capped scan, the unguarded pointer write, the old
// early-return). Where it cannot, the PRECONDITION the bug needed is asserted
// instead, then the new behaviour.
//
//   R2   the window repair finds a missed cut behind the windowed ones it
//        used to re-read for ever (the old max×3 cap, at max 2)
//   R1   a late window opens in the state the cut's decisions say
//   R4   an approve that never wrote its row: approveCut finishes it; the
//        repair gives an orphaned APPROVED / AUTO_APPROVED window back
//   R8   the request repair points at a written decision / restores an
//        approval; the request's pointer write is guarded
//   R11  a round that will not record: retried once, else the request is
//        undone (decision withdrawn, window given back)
//   R16  addenda: a note is required, one per request per two minutes, six
//        an hour, never a model call; staff are not throttled
//   R3   a staff reopen refused by the note or fee check leaves the
//        client's approval exactly as it was
//   R17  past the deadline a late APPROVAL is still accepted (server side of
//        the portal fix) and unlocks the download
//   R7   a cut Kyle marked as sent is never expired into a task nor chased
//
// Failures are forced with PGlite triggers (plpgsql) scoped to one cut, so
// the real statements fail the real way.
//
// ISOLATION: PGlite on 127.0.0.1:5506 (DRILL_PORT overrides) via the shared
// harness; production is never opened; every outbound call is fenced and
// counted; the model is stubbed and counted.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5506);

installNextStubs();
const fence = fenceFetch();

// The model, counted: an addendum must never cost a call.
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson" && k !== "aiJsonWithUsage") return t[k];
      return async () => {
        aiCalls++;
        throw new Error("drill: no model");
      };
    },
  }),
);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const rw = await import("@/lib/reviewWindows");
  const cd = await import("@/lib/clientDecisions");
  const ce = await import("@/lib/cutEntitlement");
  const rr = await import("@/app/review/actions");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { DELIVERED_STAMP, streamUrlFor } = await import("@/lib/reviewCuts");
  type PortalViewer = import("@/lib/portal").PortalViewer;

  // ---- the world ----------------------------------------------------------
  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  const staffUser = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const HOUR = 3_600_000, MIN = 60_000;
  let seq = 0;

  type World = { f: ContentMonthFixture; viewer: PortalViewer; staff: PortalViewer; token: PortalViewer; videos: string[] };
  const world = async (name: string): Promise<World> => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: `${name} TEST`, package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10", owner: { email: `${slug}@realtourpilot.com`, name },
    });
    await ensureOutputsForProject(f.projectId!);
    const videos: string[] = [];
    for (let slot = 1; slot <= 10; slot++) {
      const v = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot, status: "EDITING", title: `Video ${slot}` }, select: { id: true } });
      videos.push(v.id);
    }
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    return {
      f, videos,
      viewer: { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: `${slug}@realtourpilot.com`, name, membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as PortalViewer,
      staff: { enrollment, actor: { kind: "STAFF", staffUserId: staffUser.id, staffName: "Kyle Drill", staffRole: "ADMIN" }, access: "FULL", via: "STAFF" } as PortalViewer,
      token: { enrollment, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" } as PortalViewer,
    };
  };
  /** A cut the editor handed in: PENDING, playable (blob-held), on its video. */
  const mkCut = async (w: World, slot: number, round: number, over: Record<string, unknown> = {}) => {
    const row = await prisma.reviewSubmission.create({
      data: { projectId: w.f.projectId!, deliverableId: w.f.deliverableId, slot, round, status: "PENDING", fileName: `${w.f.clientName.split(" ")[0].toLowerCase()}-video${slot}-v${round}.mp4`, source: "upload", submittedByKey: "kim", sizeBytes: 5, videoId: w.videos[slot - 1], createdAt: new Date(Date.now() - 1000 + seq++), ...over },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), blobUrl: `https://drill.invalid/${row.id}.mp4`, blobPathname: `review-cuts/${row.id}.mp4` } });
    return row.id;
  };
  /** Jordan's QC approve in the Review Room — which is the release. */
  const release = async (id: string) => {
    const r = await rr.approveCut(id);
    if (!r.ok) throw new Error(`release ${id}: ${r.message}`);
  };
  /** What the Review Room's approve did BEFORE this deploy: the verdict, and no window. */
  const approveInRoomOld = (id: string, at = new Date()) => prisma.reviewSubmission.update({ where: { id }, data: { status: "APPROVED", decidedAt: at, decidedBy: "Jordan" } });
  const note = (w: World, sub: string, body: string) =>
    prisma.portalComment.create({ data: { submissionId: sub, projectId: w.f.projectId!, enrollmentId: w.f.enrollmentId, timeSec: 12, body, status: "OPEN", clientUserId: w.f.clientUserId }, select: { id: true } });
  const windowOf = (sub: string) => prisma.contentReviewWindow.findUnique({ where: { submissionId: sub } });
  const setSwitch = async (key: string, enabled: boolean, enabledAt = new Date(Date.now() - HOUR), configJson: string | null = null) => {
    await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt, configJson }, update: { enabled, enabledAt, configJson } });
  };
  const entitlementOf = async (sub: string) => {
    const s = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: sub }, select: { videoId: true } });
    return ce.videoEntitlement(await prisma.contentVideo.findUniqueOrThrow({ where: { id: s.videoId! } }));
  };
  const cardOf = async (w: World, sub: string) => (await cd.cutHistory(w.viewer, sub)).find((h) => h.submissionId === sub);

  // Forced failures, scoped to the cuts named in drill_fail (plpgsql triggers).
  await prisma.$executeRawUnsafe(`CREATE TABLE drill_fail (sub text NOT NULL, mode text NOT NULL)`);
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE drill_once`);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION drill_round_fail() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM drill_fail WHERE sub = NEW."submissionId" AND mode = 'round-always') THEN RAISE EXCEPTION 'drill: the round insert failed'; END IF;
      IF EXISTS (SELECT 1 FROM drill_fail WHERE sub = NEW."submissionId" AND mode = 'round-once') THEN
        IF nextval('drill_once') = 1 THEN RAISE EXCEPTION 'drill: the round insert failed once'; END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER drill_round_fail BEFORE INSERT ON "ContentRevisionRound" FOR EACH ROW EXECUTE FUNCTION drill_round_fail()`);
  // "The repair gave the window back while this request stalled": right as the
  // request's decision lands, its window is moved from under it.
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION drill_steal_window() RETURNS trigger AS $$
    BEGIN
      IF NEW."decision" = 'REQUEST_CHANGES' AND EXISTS (SELECT 1 FROM drill_fail WHERE sub = NEW."submissionId" AND mode = 'give-back-open') THEN
        UPDATE "ContentReviewWindow" SET "state" = 'OPEN', "decisionId" = NULL WHERE "id" = NEW."windowId";
      END IF;
      IF NEW."decision" = 'REQUEST_CHANGES' AND EXISTS (SELECT 1 FROM drill_fail WHERE sub = NEW."submissionId" AND mode = 'give-back-approved') THEN
        UPDATE "ContentReviewWindow" SET "state" = 'APPROVED', "decisionId" = NULL WHERE "id" = NEW."windowId";
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER drill_steal_window AFTER INSERT ON "ClientDecision" FOR EACH ROW EXECUTE FUNCTION drill_steal_window()`);
  const failOn = (sub: string, mode: string) => prisma.$executeRawUnsafe(`INSERT INTO drill_fail (sub, mode) VALUES ($1, $2)`, sub, mode);
  const clearFail = (sub: string) => prisma.$executeRawUnsafe(`DELETE FROM drill_fail WHERE sub = $1`, sub);

  // =========================================================================
  c.head("R2 · the window repair finds a missed cut behind the windowed ones");
  // =========================================================================
  {
    const W = await world("Rhea Repair");
    for (let slot = 1; slot <= 7; slot++) await release(await mkCut(W, slot, 1));
    const missed = await mkCut(W, 8, 1);
    await approveInRoomOld(missed, new Date(Date.now() + MIN));
    // The OLD scan at max 2: the oldest max×3 approved cuts, filtered AFTER the cap.
    const oldCands = await prisma.reviewSubmission.findMany({
      where: { status: "APPROVED", decidedAt: { gte: rw.REVIEW_WINDOW_EPOCH }, assetUrl: { not: null }, OR: [{ decidedBy: null }, { decidedBy: { not: DELIVERED_STAMP } }], project: { contentMonthId: { not: null } } },
      orderBy: { decidedAt: "asc" }, take: 2 * 3, select: { id: true },
    });
    const have = new Set((await prisma.contentReviewWindow.findMany({ where: { submissionId: { in: oldCands.map((x) => x.id) } }, select: { submissionId: true } })).map((x) => x.submissionId));
    c.ok("BEFORE: the capped scan saw only windowed cuts — it would open 0 and look healthy", oldCands.length === 6 && oldCands.every((x) => have.has(x.id)) && !oldCands.some((x) => x.id === missed));
    const rep = await rw.repairReviewWindows({ max: 2 });
    const mw = await windowOf(missed);
    c.ok("NEW: the missed cut gets its window (REPAIR), found by the query itself", rep.opened === 1 && rep.checked === 1 && mw?.source === "REPAIR", JSON.stringify(rep));
    const rep2 = await rw.repairReviewWindows({ max: 2 });
    c.ok("  …and a second run has nothing to look at", rep2.checked === 0 && rep2.opened === 0, JSON.stringify(rep2));
  }

  // =========================================================================
  c.head("R1 · a late window opens in the state the cut's decisions say");
  // =========================================================================
  {
    const W = await world("Ines Interval");
    // Released after the epoch but before the deploy, and approved by the
    // client under the old code: an APPROVE on file, no window.
    const x1 = await mkCut(W, 1, 1);
    await approveInRoomOld(x1);
    const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: x1 } });
    const a = await cd.recordClientApproval({ enrollmentId: W.f.enrollmentId, clientId: W.f.clientId, cut, actor: { clientUserId: W.f.clientUserId, staffUserId: null, actorLabel: "Ines Interval", membershipRole: "OWNER", resolvedByKind: "CLIENT" } });
    c.ok("the gap state: a live client APPROVE and no window", a.ok && !(await windowOf(x1)));
    await rw.repairReviewWindows();
    const w1 = await windowOf(x1);
    c.ok("NEW: the repair opens it APPROVED, pointing at that approval (not OPEN)", w1?.source === "REPAIR" && w1.state === "APPROVED" && w1.decisionId === (a.ok ? a.decisionId : "-"), `${w1?.source}/${w1?.state}`);
    await note(W, x1, "change the music");
    const r = await cd.requestChangesOnCut(W.viewer, x1, "");
    c.ok("NEW: a change request on it is refused — the approval stands", !r.ok && /already approved/.test(r.message), r.message);
    c.ok("  …no REQUEST_CHANGES was written, and the download stays", (await prisma.clientDecision.count({ where: { submissionId: x1, decision: "REQUEST_CHANGES" } })) === 0 && (await entitlementOf(x1)).basis === "CLIENT_APPROVED");

    // The same gap met first by the client's own action: ensureWindow's REPAIR branch.
    const x2 = await mkCut(W, 2, 1);
    await approveInRoomOld(x2);
    const cut2 = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: x2 } });
    await cd.recordClientApproval({ enrollmentId: W.f.enrollmentId, clientId: W.f.clientId, cut: cut2, actor: { clientUserId: W.f.clientUserId, staffUserId: null, actorLabel: "Ines Interval", membershipRole: "OWNER", resolvedByKind: "CLIENT" } });
    await note(W, x2, "stale tab note");
    const r2 = await cd.requestChangesOnCut(W.viewer, x2, "");
    const w2 = await windowOf(x2);
    c.ok("NEW: ensureWindow's REPAIR branch reads the decisions too — APPROVED, the request refused", !r2.ok && w2?.source === "REPAIR" && w2.state === "APPROVED", `${w2?.state} · ${r2.message}`);
    // A fresh release has no decisions and still opens OPEN.
    const x3 = await mkCut(W, 3, 1);
    await release(x3);
    c.ok("a fresh release still opens OPEN", (await windowOf(x3))?.state === "OPEN");
  }

  // =========================================================================
  c.head("R4 · a window claimed APPROVED with no approval behind it");
  // =========================================================================
  {
    const W = await world("Otto Orphan");
    const o1 = await mkCut(W, 1, 1);
    await release(o1);
    // What a writer that died between the CAS and the row leaves behind.
    const ow = (await windowOf(o1))!;
    await rw.claimWindow(ow.id, ["OPEN"], "APPROVED", {}, { closedAt: new Date(), closedReason: "CLIENT" });
    const oldAnswer = ow.decisionId ?? (await prisma.clientDecision.findUnique({ where: { dedupeKey: `sub:${o1}:approve` }, select: { id: true } }))?.id ?? "";
    c.ok("BEFORE: the old early return answered 'Already approved' with decisionId '' — every press, for ever", oldAnswer === "" && (await entitlementOf(o1)).blockedBy === "AWAITING_DECISION");
    const r = await cd.approveCut(W.viewer, o1, "NONE");
    const dec = await prisma.clientDecision.findFirst({ where: { submissionId: o1, decision: "APPROVE" } });
    c.ok("NEW: the press finishes the approval — a real row, not a duplicate", r.ok && !r.duplicate && !!dec && r.decisionId === dec.id, r.message);
    c.ok("  …the window points at it, and the download opens", (await windowOf(o1))?.decisionId === dec?.id && (await entitlementOf(o1)).basis === "CLIENT_APPROVED");
    const again = await cd.approveCut(W.viewer, o1, "NONE");
    c.ok("  …a second press is the duplicate, with the real id", again.ok && again.duplicate && again.decisionId === dec?.id);

    // Nobody presses: the repair gives an orphan back after two minutes.
    const o2 = await mkCut(W, 2, 1);
    await release(o2);
    const w2 = (await windowOf(o2))!;
    await prisma.contentReviewWindow.update({ where: { id: w2.id }, data: { state: "APPROVED", closedAt: new Date(), closedReason: "CLIENT", updatedAt: new Date(Date.now() - 10 * MIN) } });
    const o3 = await mkCut(W, 3, 1);
    await release(o3);
    const w3 = (await windowOf(o3))!;
    await prisma.contentReviewWindow.update({ where: { id: w3.id }, data: { state: "AUTO_APPROVED", closedAt: new Date(), closedReason: "AUTO_EXPIRY", expiryClaimedAt: new Date(), updatedAt: new Date(Date.now() - 10 * MIN) } });
    // A fresh claim (a writer still inside its two minutes) is left alone.
    const o4 = await mkCut(W, 4, 1);
    await release(o4);
    await rw.claimWindow((await windowOf(o4))!.id, ["OPEN"], "APPROVED", {}, {});
    const rep = await rw.repairReviewWindows();
    const [a2, a3, a4] = [await windowOf(o2), await windowOf(o3), await windowOf(o4)];
    c.ok("NEW: the repair gives the orphaned APPROVED window back to OPEN", a2?.state === "OPEN" && a2.decisionId === null && a2.closedAt === null, `${a2?.state} · ${JSON.stringify(rep)}`);
    c.ok("NEW: …and an orphaned AUTO_APPROVED one back to the sweep (lease and outcome cleared)", a3?.state === "OPEN" && a3.expiryClaimedAt === null && a3.expiryOutcome === null, `${a3?.state}`);
    c.ok("  …a claim younger than two minutes is untouched", a4?.state === "APPROVED");
    c.ok("  …and o1, whose approval exists, is untouched", (await windowOf(o1))?.state === "APPROVED" && rep.orphansReleased === 2, JSON.stringify(rep));
  }

  // =========================================================================
  c.head("R8 · the request's window pointer, and the repair that gives windows back");
  // =========================================================================
  {
    const W = await world("Pia Pointer");
    // (a) The repair meets a window whose request DID write its decision.
    const p1 = await mkCut(W, 1, 1);
    await release(p1);
    const pw1 = (await windowOf(p1))!;
    await rw.claimWindow(pw1.id, ["OPEN"], "CHANGES_REQUESTED", {}, { updatedAt: new Date(Date.now() - 10 * MIN) });
    const written = await prisma.clientDecision.create({
      data: { submissionId: p1, projectId: W.f.projectId!, enrollmentId: W.f.enrollmentId, clientId: W.f.clientId, round: 1, decision: "REQUEST_CHANGES", actorLabel: "Pia Pointer", clientUserId: W.f.clientUserId, receiptState: "RECEIVED", dedupeKey: `sub:${p1}:changes:open`, windowId: pw1.id, basis: "CLIENT", note: "fix the logo", decidedAt: new Date(Date.now() - MIN) },
      select: { id: true },
    });
    const stale = (await windowOf(p1))!;
    c.ok("BEFORE: the old repair released any CHANGES_REQUESTED window with no pointer older than two minutes", stale.decisionId === null && stale.updatedAt.getTime() < Date.now() - 2 * MIN);
    await cd.repairPortalRevisionRequests();
    const after = (await windowOf(p1))!;
    c.ok("NEW: it points the window at the written request instead of releasing it", after.state === "CHANGES_REQUESTED" && after.decisionId === written.id, `${after.state}/${after.decisionId}`);

    // (b) A staff reopen that died: the approval it reopened is still live.
    const p2 = await mkCut(W, 2, 1);
    await release(p2);
    const ap = await cd.approveCut(W.viewer, p2, "NONE");
    await prisma.contentReviewWindow.update({ where: { submissionId: p2 }, data: { state: "CHANGES_REQUESTED", decisionId: null, closedAt: null, updatedAt: new Date(Date.now() - 10 * MIN) } });
    await cd.repairPortalRevisionRequests();
    const w2 = (await windowOf(p2))!;
    c.ok("NEW: a window over a live approval goes back to APPROVED, never OPEN", w2.state === "APPROVED" && w2.decisionId === (ap.ok ? ap.decisionId : "-"), `${w2.state}`);

    // (c) The request stalls past the repair: its window is given back under it.
    const p3 = await mkCut(W, 3, 1);
    await release(p3);
    await failOn(p3, "give-back-open");
    await note(W, p3, "trim the ending");
    const r3 = await cd.requestChangesOnCut(W.viewer, p3, "");
    const w3 = (await windowOf(p3))!;
    const d3 = await prisma.clientDecision.findFirst({ where: { submissionId: p3, decision: "REQUEST_CHANGES" } });
    c.ok("NEW: given back to OPEN with nobody deciding meanwhile — the request takes it again", r3.ok && w3.state === "CHANGES_REQUESTED" && w3.decisionId === d3?.id, `${w3.state} · ${r3.message}`);
    await clearFail(p3);

    const p4 = await mkCut(W, 4, 1);
    await release(p4);
    await failOn(p4, "give-back-approved");
    await note(W, p4, "brighter please");
    const r4 = await cd.requestChangesOnCut(W.viewer, p4, "");
    const w4 = (await windowOf(p4))!;
    const d4 = await prisma.clientDecision.findFirst({ where: { submissionId: p4, decision: "REQUEST_CHANGES" } });
    c.ok("BEFORE: the unguarded pointer write (where: { id }) would have landed on that APPROVED window", (await prisma.contentReviewWindow.count({ where: { id: w4.id } })) === 1 && w4.state === "APPROVED");
    c.ok("NEW: decided meanwhile — the request does not happen: refused, window untouched", !r4.ok && w4.state === "APPROVED" && w4.decisionId === null, `${w4.state} · ${r4.message}`);
    c.ok("  …its decision is withdrawn (superseded, key freed), no round, no editor task", d4?.receiptState === "SUPERSEDED" && d4.dedupeKey === null
      && (await prisma.contentRevisionRound.count({ where: { submissionId: p4 } })) === 0
      && (await prisma.revisionBrief.count({ where: { submissionId: p4 } })) === 0);
    await clearFail(p4);
  }

  // =========================================================================
  c.head("R11 · a revision round that will not record");
  // =========================================================================
  {
    const W = await world("Rory Round");
    const r1 = await mkCut(W, 1, 1);
    await release(r1);
    await failOn(r1, "round-once");
    await note(W, r1, "tighten the first five seconds");
    const ok = await cd.requestChangesOnCut(W.viewer, r1, "");
    c.ok("a failure on the first insert is retried: the request lands WITH its round", ok.ok && (await prisma.contentRevisionRound.count({ where: { submissionId: r1 } })) === 1, ok.message);
    await clearFail(r1);

    const r2 = await mkCut(W, 2, 1);
    await release(r2);
    await failOn(r2, "round-always");
    const n = await note(W, r2, "new music");
    const bad = await cd.requestChangesOnCut(W.viewer, r2, "");
    const d = await prisma.clientDecision.findFirst({ where: { submissionId: r2, decision: "REQUEST_CHANGES" } });
    const w = (await windowOf(r2))!;
    c.ok("NEW: it will not record — the client is told to try again", !bad.ok && /try again/.test(bad.message), bad.message);
    c.ok("  …nothing half-sent: decision withdrawn, window OPEN with no pointer", d?.receiptState === "SUPERSEDED" && d.dedupeKey === null && w.state === "OPEN" && w.decisionId === null, `${d?.receiptState}/${w.state}`);
    c.ok("  …the note stays OPEN, no brief, no editor task, no fee card", (await prisma.portalComment.findUniqueOrThrow({ where: { id: n.id } })).status === "OPEN"
      && (await prisma.revisionBrief.count({ where: { submissionId: r2 } })) === 0
      && (await prisma.smartTask.count({ where: { projectId: W.f.projectId!, taskType: "revision_fee" } })) === 0);
    await clearFail(r2);
    const retry = await cd.requestChangesOnCut(W.viewer, r2, "");
    c.ok("  …and the retry goes through, as round 1 of that video", retry.ok && (await prisma.contentRevisionRound.findFirst({ where: { submissionId: r2 } }))?.ordinal === 1, retry.message);
  }

  // =========================================================================
  c.head("R16 · addenda are throttled, need a note, and never call the model");
  // =========================================================================
  {
    const W = await world("Ada Addendum");
    const a1 = await mkCut(W, 1, 1);
    await release(a1);
    await note(W, a1, "The intro drags");
    const first = await cd.requestChangesOnCut(W.viewer, a1, "");
    const req = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: a1, decision: "REQUEST_CHANGES" } });
    const briefs = () => prisma.revisionBrief.count({ where: { decisionId: req.id } });
    const b0 = await briefs();
    c.ok("the request is open and briefed", first.ok && b0 >= 1, first.message);

    const x = await cd.requestChangesOnCut(W.token, a1, "x");
    c.ok("NEW: a one-character 'note' on the open request is refused, no brief", !x.ok && /Add a note/.test(x.message) && (await briefs()) === b0, x.message);

    await note(W, a1, "also the logo is small");
    const add1 = await cd.requestChangesOnCut(W.token, a1, "");
    c.ok("an addendum with a real note joins the request (one new brief)", add1.ok && (await briefs()) === b0 + 1, add1.message);

    const held = await note(W, a1, "and the colour");
    const bellsBefore = await prisma.notification.count({ where: { kind: "revision_addendum" } });
    const add2 = await cd.requestChangesOnCut(W.token, a1, "");
    c.ok("NEW: a second one inside two minutes is held — the note stays saved, no brief, no bell", !add2.ok && /couple of minutes/.test(add2.message)
      && (await prisma.portalComment.findUniqueOrThrow({ where: { id: held.id } })).status === "OPEN" && (await briefs()) === b0 + 1
      && (await prisma.notification.count({ where: { kind: "revision_addendum" } })) === bellsBefore, add2.message);

    await prisma.revisionBrief.updateMany({ where: { decisionId: req.id, sourceDetail: { contains: ":addendum:" } }, data: { createdAt: new Date(Date.now() - 3 * MIN) } });
    const calls = aiCalls;
    const long = "Please also rework the whole middle section so the kitchen gets more time on screen, the pool shot lands on the beat, the drone reveal is slower, and the captions match the brand font we sent over last month. The outro card should use the new phone number too.";
    const add3 = await cd.requestChangesOnCut(W.token, a1, long);
    c.ok("two minutes on it goes through, carrying the held note", add3.ok && (await briefs()) === b0 + 2 && (await prisma.portalComment.findUniqueOrThrow({ where: { id: held.id } })).status === "SENT", add3.message);
    c.ok("NEW: a long addendum makes NO model call (its pinned items are the work order)", aiCalls === calls, `${aiCalls - calls} call(s)`);

    // Six an hour, counted on the request — every one of them older than the
    // two-minute spacing, so it is the hourly cap that holds the seventh.
    for (let i = 0; i < 4; i++) {
      await prisma.revisionBrief.create({ data: { projectId: W.f.projectId!, source: "portal", sourceDetail: `decision:${req.id}:addendum:${90 + i}`, originalText: "earlier addendum", decisionId: req.id, submissionId: a1, createdAt: new Date(Date.now() - 10 * MIN) } });
    }
    await prisma.revisionBrief.updateMany({ where: { decisionId: req.id, sourceDetail: { contains: ":addendum:" }, createdAt: { gt: new Date(Date.now() - 3 * MIN) } }, data: { createdAt: new Date(Date.now() - 3 * MIN) } });
    await note(W, a1, "one more thing");
    const capped = await cd.requestChangesOnCut(W.token, a1, "");
    c.ok("NEW: the seventh addendum inside the hour is held", !capped.ok && /couple of minutes/.test(capped.message), capped.message);
    const staffAdd = await cd.requestChangesOnCut(W.staff, a1, "office note: keep the old music");
    c.ok("staff are never throttled", staffAdd.ok, staffAdd.message);

    // Contrast: a FIRST request of that length is analysed (the counter works).
    const a2 = await mkCut(W, 2, 1);
    await release(a2);
    const before = aiCalls;
    await cd.requestChangesOnCut(W.viewer, a2, long);
    c.ok("(a first request that long IS analysed — the counter sees the model)", aiCalls === before + 1, `${aiCalls - before}`);
  }

  // =========================================================================
  c.head("R3 · a staff reopen refused by a check leaves the approval as it was");
  // =========================================================================
  {
    const W = await world("Sam Stale");
    const s1 = await mkCut(W, 1, 1);
    await release(s1);
    const ap = await cd.approveCut(W.viewer, s1, "NONE");
    const approvalId = ap.ok ? ap.decisionId : "-";
    const intact = async () => {
      const w = (await windowOf(s1))!;
      const d = await prisma.clientDecision.findUniqueOrThrow({ where: { id: approvalId } });
      const card = await cardOf(W, s1);
      const e = await entitlementOf(s1);
      return w.state === "APPROVED" && w.decisionId === approvalId && d.receiptState === "DONE" && d.dedupeKey === `sub:${s1}:approve` && d.supersededById === null
        && card?.clientState === "YOU_APPROVED" && e.basis === "CLIENT_APPROVED"
        && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: s1 } })).clientApprovedDecisionId === approvalId;
    };
    c.ok("the client approved: window APPROVED, approval live, download open", await intact());
    // A stale owner tab: "Send to the editor" with nothing to send.
    const empty = await cd.requestChangesOnCut(W.staff, s1, "");
    c.ok("NEW: the empty staff reopen is refused ('Add a note')", !empty.ok && /Add a note/.test(empty.message), empty.message);
    c.ok("NEW: …and NOTHING moved — window, approval, dedupe key, caches, page and download all as they were", await intact());

    // The fee check: revision policy on, no round included, no acknowledgement.
    await setSwitch("revision_policy", true, new Date(Date.now() - HOUR), JSON.stringify({ includedRounds: 0 }));
    await note(W, s1, "office: swap the b-roll");
    const fee = await cd.requestChangesOnCut(W.staff, s1, "");
    c.ok("NEW: the fee refusal (needsFeeAck) moves nothing either", !fee.ok && fee.needsFeeAck === true && (await intact()), fee.message);
    const go = await cd.requestChangesOnCut(W.staff, s1, "", { acknowledgeExtraFee: true });
    const req = await prisma.clientDecision.findFirst({ where: { submissionId: s1, decision: "REQUEST_CHANGES" } });
    const old = await prisma.clientDecision.findUniqueOrThrow({ where: { id: approvalId } });
    const w = (await windowOf(s1))!;
    c.ok("with the acknowledgement the reopen lands in ONE step: window APPROVED → CHANGES_REQUESTED", go.ok && w.state === "CHANGES_REQUESTED" && w.decisionId === req?.id, `${w.state} · ${go.message}`);
    c.ok("  …the approval superseded BY that request (receipt, key and pointer together)", old.receiptState === "SUPERSEDED" && old.dedupeKey === null && old.supersededById === req?.id);
    c.ok("  …so the page and the download agree: changes requested, nothing to download", (await cardOf(W, s1))?.clientState === "YOU_REQUESTED_CHANGES" && (await entitlementOf(s1)).blockedBy === "CHANGES_REQUESTED");
    await setSwitch("revision_policy", true);
  }

  // =========================================================================
  c.head("R17 · past the deadline a late APPROVAL is still accepted");
  // =========================================================================
  {
    const W = await world("Lou Late");
    const l1 = await mkCut(W, 1, 1);
    await release(l1);
    await prisma.contentReviewWindow.update({ where: { submissionId: l1 }, data: { deadlineAt: new Date(Date.now() - MIN) } });
    const panel = await rw.reviewPanelFor(W.viewer, l1);
    c.ok("the portal panel reads closed (the page used to hide Approve with it)", panel?.closed === true, JSON.stringify(panel && { closed: panel.closed, state: panel.state }));
    await note(W, l1, "too late for this?");
    const req = await cd.requestChangesOnCut(W.viewer, l1, "");
    c.ok("a late REQUEST is refused, with Kyle's number", !req.ok && req.message.includes("(215) 645-4889"), req.message);
    const ap = await cd.approveCut(W.viewer, l1, "INCLUDE");
    c.ok("a late APPROVAL is accepted — the control the page now keeps", ap.ok, ap.message);
    c.ok("  …and it unlocks the download", (await entitlementOf(l1)).basis === "CLIENT_APPROVED");
  }

  // =========================================================================
  c.head("R7 · a cut Kyle marked as sent is never expired into a task, nor chased");
  // =========================================================================
  {
    const W = await world("Kay Sent");
    await prisma.client.update({ where: { id: W.f.clientId }, data: { name: "Kay Sent" } });
    const k1 = await mkCut(W, 1, 1);
    await release(k1);
    // markVideoSent: the link-token client got it by text.
    await prisma.reviewSubmission.update({ where: { id: k1 }, data: { sentToClientAt: new Date() } });
    const kw = (await windowOf(k1))!;
    const sweepAt = new Date(kw.deadlineAt.getTime() + HOUR);
    const oldDue = await prisma.contentReviewWindow.count({ where: { id: kw.id, state: "OPEN", deadlineAt: { lte: sweepAt }, expiryOutcome: null } });
    const lane0 = await prisma.contentReviewWindow.count({ where: { projectId: W.f.projectId!, state: "OPEN", source: { not: "LAZY" } } });
    c.ok("BEFORE: the old sweep and the old review lane both took it (open, past its deadline)", oldDue === 1 && lane0 === 1);
    const s = await rw.sweepReviewWindows({ now: sweepAt, max: 100 });
    c.ok("NEW: the sweep settles it as sent — no 'review window closed' task for Kyle", (await windowOf(k1))?.expiryOutcome === "SENT_OUTSIDE_PORTAL"
      && (await prisma.smartTask.count({ where: { clientId: W.f.clientId, taskType: "content_review_expired" } })) === 0, JSON.stringify(s));
    c.ok("  …the window stays OPEN (the client can still ask for changes)", (await windowOf(k1))?.state === "OPEN");
    const lane = await rw.reviewLaneFacts([W.f.projectId!]);
    c.ok("NEW: the review reminder lane does not count it", lane.count === 0, JSON.stringify(lane));
    const panel = await rw.reviewPanelFor(W.viewer, k1);
    c.ok("NEW: the portal shows no review deadline on a video they already have", panel !== null && panel.deadlineISO === null && panel.closed === false);
  }

  c.head("isolation");
  c.ok("no provider was reached — every outbound attempt was fenced", fence.faked.length === 0, `blocked ${fence.blocked.length}: ${[...new Set(fence.blocked.map((u) => u.replace(/^(\w+:\/\/[^/]+).*/, "$1")))].join(", ")}`);
  console.log(`  (prisma error lines swallowed: ${quiet.count}; model calls stubbed: ${aiCalls})`);

  c.summary();
  quiet.restore();
  await stop();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
