// ---------------------------------------------------------------------------
// DRILL: B6 — REVIEW ROOM ATTRIBUTION (Jordan, Sep 28 2026: "I'd like to make
// sure that in the review room, we know who left the review comments and
// requested the revision.")
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b6-review-attribution.ts
//
// Every step runs the SHIPPED code — the Review Room's server actions under a
// stubbed getCurrentUser, the portal's clientDecisions, the comms revision
// path, the Editing Room's queue-add, the Room's reads and the editor queue —
// and the display words through the one pure vocabulary the screens use
// (lib/reviewAttribution). The OLD code is pinned to 3de6023 and loaded from
// git (its `@/` imports aimed at this tree):
//
//   0  OLD: a client's send-back on a cut the office approved is handed to the
//      editor's page as the APPROVER's, at the approval's time; a nameless
//      login signs notes with its email; no login id on notes or verdicts; no
//      name on the timeline; James answering a thread leaves it "unanswered";
//      a portal work order credits every note to whoever pressed Submit; "view
//      as" with auth off writes under the previewed person; the office's
//      queue-add says "The owner" and its clock row says "the office".
//   1  Gap 1: the client's send-back reads as the client's, at their time.
//   2  Office notes: author (roster name before email) + login id + time; replies timed.
//   3  Verdict names on the row, the timeline, the bell, the edit card and the
//      earlier rounds; the round block stays idempotent whoever presses.
//   4  Portal: each bullet carries its author when they differ; requester
//      kinds CLIENT and CLIENT_STAFF on the brief; the Review Room's client
//      notes with authors, "on behalf of", replies and times; the emailed
//      link's two browsers told apart (gap 21).
//   5  Office reopen: the signed-in person on the card, the timeline and the
//      clock row (OFFICE); the queue pill's round names its presser.
//   6  Requester kinds EMAIL / TEXT / PHONE; the sender as the task's person.
//   7  statusBy / statusAt on resolve, reopen and mark-fixed.
//   8  "View as" is refused on every write — auth OFF and auth ON — and writes nothing.
//   9  Unanswered replies: any review-desk author answers a thread.
//  10  A cover is visible: "Covered by Kyle Cabrera · <when>".
//  11  The editor queue's Revisions row names who sent it back.
//  12  Guard rails: the delivered stamp agrees, the editor's feedback stays
//      scoped, the photographer lens carries no cover line, money is still
//      scrubbed from a creative's brief, the client's own page is unchanged.
//  13  The Sep 28 review's findings, through the SHIPPED callers: an
//      assistant's text, call and (already-answered) email name her, not the
//      agent (OpenPhone receiver, fake Gmail scan); a bare From address is not
//      a name; the queue-add flags nobody and a later ask carries no stale
//      flag; an office reopen is worded as the office's; a desk seat who shot
//      the job is the creative on his own thread; the link's top-level note
//      carries its visitor; a sent-then-resolved note says who resolved it;
//      "Fixed" on /shoot stamps who and when; dating a reopen is not
//      requesting it; the project page names the real asker; the hand-close
//      signs with the roster name; a retried round is not appended twice.
//
// §5 and §6 were MOVED to the review's law (never loosened): the queue-add no
// longer sets flaggedBy, and a caller that names no sender names nobody.
//
// ISOLATION: PGlite on 127.0.0.1:5861 (the harness); production is never
// opened; every non-loopback call is fenced (no provider, no Slack, no model).
// THE CLOCK IS PINNED to Mon Sep 28 2026 10:00 ET and moved by hand. A row's
// @default(now()) comes from the database's own clock, not the pinned one, so
// those times are compared with themselves, never with a pinned instant.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5861);
const BASE = "3de6023"; // pinned: the tree this batch starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ---------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 8, 28, 14, 0, 0); // Mon Sep 28 2026, 10:00 EDT
let offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
/** Move the drill clock forward by whole minutes. */
const advance = (minutes: number) => { offset += minutes * 60_000; };

// ---- the login, stubbed at the one seam every guard reads -------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) =>
    new Proxy(loaded as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k === "getCurrentUser") return async () => viewer;
        return t[k];
      },
    }),
);
installNextStubs();

// ---- a fake Gmail (§13: the real email caller) -------------------------------
// One mailbox, the messages §13 puts in GMAIL, and a thread per message that
// is "answered" (our reply last) or not. Refresh tokens are built at run time.
const b64 = (x: string) => Buffer.from(x, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const gjson = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GMAIL: Record<string, { from: string; subject: string; body: string; thread: string; answered: boolean }> = {};
const fence = fenceFetch((url) => {
  if (url === "https://oauth2.googleapis.com/token") return gjson(200, { access_token: ["tok", "b6", "drill"].join("-"), expires_in: 3600 });
  const m = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me(\/[^?]*)(\?.*)?$/.exec(url);
  if (!m) return null;
  const p = m[1];
  if (p === "/messages") return gjson(200, { messages: Object.keys(GMAIL).map((id) => ({ id })) });
  const one = /^\/messages\/([^/]+)$/.exec(p);
  if (one && GMAIL[one[1]]) {
    const x = GMAIL[one[1]];
    return gjson(200, {
      id: one[1], threadId: x.thread, snippet: x.body, internalDate: String(Date.now() - 60_000),
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: x.from }, { name: "Subject", value: x.subject }], body: { data: b64(x.body) } },
    });
  }
  const th = /^\/threads\/([^/]+)$/.exec(p);
  if (th) {
    const x = Object.values(GMAIL).find((g) => g.thread === th[1]);
    const msgs: unknown[] = [{ id: `${th[1]}-in`, internalDate: String(Date.now() - 60_000), payload: { headers: [{ name: "From", value: x?.from ?? "someone@clients.invalid" }] } }];
    if (x?.answered) msgs.push({ id: `${th[1]}-us`, internalDate: String(Date.now() - 30_000), payload: { headers: [{ name: "From", value: "Kyle Cabrera <hello@realtourpilot.com>" }, { name: "To", value: x.from }, { name: "Subject", value: `Re: ${x.subject}` }] } });
    return gjson(200, { messages: msgs });
  }
  return gjson(404, { error: "no such fake" });
});

/** 3de6023's copies, their `@/` imports aimed at this tree. */
function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b6-attribution-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = (name: string, f: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, point(show(f)));
    return p;
  };
  return {
    dir,
    actions: out("reviewActions.base.ts", "src/app/review/actions.ts"),
    reviewRoom: out("reviewRoom.base.ts", "src/lib/reviewRoom.ts"),
    clientDecisions: out("clientDecisions.base.ts", "src/lib/clientDecisions.ts"),
    editing: out("editingActions.base.ts", "src/app/editing/actions.ts"),
    portalActions: out("portalActions.base.ts", "src/app/portal/actions.ts"),
    projectReview: out("projectReviewActions.base.ts", "src/app/projects/reviewActions.ts"),
    // Read as text only: a page and a client component are not callable here.
    editPageSrc: show("src/app/edit/[id]/page.tsx"),
    panelSrc: show("src/components/review/CutReviewPanel.tsx"),
  };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { putSetting } = await import("@/lib/settings");
  const rr = await import("@/app/review/actions");
  const editing = await import("@/app/editing/actions");
  const cd = await import("@/lib/clientDecisions");
  const room = await import("@/lib/reviewRoom");
  const at = await import("@/lib/reviewAttribution");
  const { streamUrlFor, DELIVERED_STAMP } = await import("@/lib/reviewCuts");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { getRevisionBriefs } = await import("@/lib/revisionBrief");
  const { raiseRevision, raiseRevisionDetailed } = await import("@/lib/comms");
  const { addRoundToEditCard } = await import("@/lib/tasks");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { REVISION_FLAG_PREFIX } = await import("@/lib/debrief");
  const base = writeBaseCopies();
  const old = {
    actions: (await import(base.actions)) as typeof rr,
    room: (await import(base.reviewRoom)) as typeof room,
    cd: (await import(base.clientDecisions)) as typeof cd,
    editing: (await import(base.editing)) as typeof editing,
    portalActions: (await import(base.portalActions)) as typeof import("@/app/portal/actions"),
    projectReview: (await import(base.projectReview)) as typeof import("@/app/projects/reviewActions"),
  };
  type PortalViewer = import("@/lib/portal").PortalViewer;

  console.log(`drill clock: ${new Date().toISOString()} (pinned — Mon Sep 28 2026, 10:00 ET)`);

  // ---- the cast --------------------------------------------------------------
  type TeamRole = "ADMIN" | "MANAGER" | "SALES" | "PHOTOGRAPHER" | "EDITOR" | "VA";
  const member = (name: string, email: string, role: TeamRole) =>
    prisma.teamMember.create({ data: { name, email, role, active: true }, select: { id: true, name: true } });
  const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER");
  const kyle = await member("Kyle Cabrera", "kyle@drill.invalid", "MANAGER");
  const james = await member("James Rivera", "james@drill.invalid", "PHOTOGRAPHER");
  const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER");
  const kim = await member("Kim Miguel", "kim@drill.invalid", "EDITOR");
  const login = (email: string, name: string | null, role: string, tm: string, extra: Record<string, unknown> = {}) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
  const uJordan = await login("jordan@drill.invalid", "Jordan Spackman", "OWNER", jordan.id);
  // Kyle's login has NO name — the roster has it (gap 16).
  const uKyle = await login("kyle@drill.invalid", null, "ADMIN", kyle.id);
  const uJames = await login("james@drill.invalid", "James Rivera", "ADMIN", james.id);
  const uHarrison = await login("harrison@drill.invalid", "Harrison Wells", "PHOTOGRAPHER", harrison.id);
  const uKim = await login("kim@drill.invalid", "Kim Miguel", "EDITOR", kim.id, { editorKey: "kim" });
  const as = (id: string, email: string, name: string | null, role: string, tm: string | null, over: Partial<Viewer> = {}): Viewer => ({
    id, email, name, role, permissions: null, status: "ACTIVE", teamMemberId: tm, editorKey: role === "EDITOR" ? "kim" : null,
    notificationsSeenAt: null, impersonating: false, realRole: role, realName: name, ...over,
  });
  const V = {
    jordan: as(uJordan.id, "jordan@drill.invalid", "Jordan Spackman", "OWNER", jordan.id),
    kyle: as(uKyle.id, "kyle@drill.invalid", null, "ADMIN", kyle.id),
    james: as(uJames.id, "james@drill.invalid", "James Rivera", "ADMIN", james.id),
    harrison: as(uHarrison.id, "harrison@drill.invalid", "Harrison Wells", "PHOTOGRAPHER", harrison.id),
    kim: as(uKim.id, "kim@drill.invalid", "Kim Miguel", "EDITOR", kim.id),
    // Jordan previewing Kim: effective = Kim, real = OWNER.
    preview: as(uKim.id, "kim@drill.invalid", "Kim Miguel", "EDITOR", kim.id, { impersonating: true, realRole: "OWNER", realName: "Jordan Spackman" }),
  };
  await putSetting("editor_routing", { standardVideo: "kim", premiumVideo: "kim", personalBranding: "kim" });
  await putSetting("review_room", {
    discoverFromDropbox: false, keepUploadsDays: 90,
    creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id,
    coverOfferHours: 9, coverTransferHours: null,
  });

  // ---- jobs and cuts -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Gary Mercer" }, select: { id: true } });
  const mkJob = async (street: string, status: "REVIEW" | "DELIVERED" | "EDITING" = "REVIEW") => {
    const p = await prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status, addressLine: street, photographerId: harrison.id,
        ...(status === "DELIVERED" ? { deliveredAt: new Date(Date.now() - 3 * 86_400_000) } : {}),
      },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
    return { id: p.id, deliverableId: d.id, street };
  };
  let seq = 0;
  const mkCut = async (job: { id: string; deliverableId: string | null }, round: number, over: Record<string, unknown> = {}) => {
    seq++;
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: job.id, deliverableId: job.deliverableId, slot: 1, round, kind: "video", source: "upload", status: "PENDING",
        fileName: `cut-${seq}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel", createdAt: new Date(Date.now() + seq), ...over,
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
    return row.id;
  };
  const sub = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
  const ET = (d: Date | string) => at.whenET(d);

  // ---- a content client with a portal ----------------------------------------
  const contentWorld = async (label: string, person: string) => {
    const slug = person.toLowerCase().replace(/[^a-z]+/g, "");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: `${label} TEST`, package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10", owner: { email: `${slug}@example.com`, name: person },
    });
    await ensureOutputsForProject(f.projectId!);
    const videos: string[] = [];
    for (let slot = 1; slot <= 4; slot++) {
      const v = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot, status: "EDITING", title: `Video ${slot}` }, select: { id: true } });
      videos.push(v.id);
    }
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    const owner = { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: `${slug}@example.com`, name: person, membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as PortalViewer;
    const cut = async (slot: number, round = 1) => {
      seq++;
      const row = await prisma.reviewSubmission.create({
        data: { projectId: f.projectId!, deliverableId: f.deliverableId, slot, round, status: "PENDING", fileName: `video${slot}-v${round}.mp4`, source: "upload", submittedByKey: "kim", submittedByName: "Kim Miguel", videoId: videos[slot - 1], createdAt: new Date(Date.now() + seq) },
        select: { id: true },
      });
      await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
      return row.id;
    };
    const note = (submissionId: string, body: string, who: { clientUserId?: string | null; staffUserId?: string | null }, timeSec: number | null = 7) =>
      prisma.portalComment.create({ data: { submissionId, projectId: f.projectId!, enrollmentId: f.enrollmentId, timeSec, body, status: "OPEN", clientUserId: who.clientUserId ?? null, staffUserId: who.staffUserId ?? null }, select: { id: true } });
    return { f, videos, enrollment, owner, cut, note };
  };
  const approveAs = async (v: Viewer, id: string, api: typeof rr = rr) => {
    viewer = v;
    const r = await api.approveCut(id);
    if (!r.ok) throw new Error(`approve ${id}: ${r.message}`);
  };
  // Oct 5 2026 — THE PORTAL PUBLICATION GATE (a60424b, Oct 2). The office's
  // approval of a MONTHLY cut is no longer its release: the client sees the
  // version once its checked 1080p file is published to the portal
  // (contentVideos.publishApprovedCutToLibrary → the monthly handoff), and
  // until then the portal answers "That video isn't on your page." — which is
  // what §0(d), §1, §4 and §13 read, since their clients act on a cut the
  // office approved. That path needs Topaz and Dropbox (fenced here), so this
  // records the part these sections are about, exactly as the shared review
  // fixture does (scripts/_fixtures/reviewWorld.ts publish): the release to
  // the client, its review window, and the round answered. Attribution is what
  // is asserted; the gate itself is drilled in monthly-portal-approval-gate.
  const publish = async (id: string) => {
    await prisma.reviewSubmission.update({ where: { id }, data: { clientReleasedAt: new Date(), clientReleasedBy: "Portal publication" } });
    const { openReviewWindow } = await import("@/lib/reviewWindows");
    await openReviewWindow(id, { by: "Portal publication" });
    const row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
    const { correctedCutApproved } = await import("@/lib/reviewCuts");
    await correctedCutApproved(row.projectId, { cutCreatedAt: row.createdAt, round: row.round, cut: { id: row.id, deliverableId: row.deliverableId, slot: row.slot, assetPath: row.assetPath } });
  };
  /** The office approves a monthly cut, then it is published to the client's portal. */
  const approveAndPublish = async (v: Viewer, id: string) => { await approveAs(v, id); await publish(id); };

  try {
    // =========================================================================
    c.head(`0 · THE OLD CODE (${BASE}): stored, not shown — and one wrong person`);
    // =========================================================================
    {
      // (a) gap 1 — the office approves, the client sends it back two hours later.
      const W = await contentWorld("Olive Old", "Olive Old");
      const cut = await W.cut(1);
      await approveAs(V.james, cut, old.actions);
      const approvedAt = (await sub(cut)).decidedAt!;
      advance(120);
      await W.note(cut, "Brighten the kitchen", { clientUserId: W.f.clientUserId });
      viewer = null;
      const req = await old.cd.requestChangesOnCut(W.owner, cut, "");
      const row = await sub(cut);
      c.ok("OLD: the client's request lands (the row flips back, stamped with the client)", req.ok && row.status === "CHANGES_REQUESTED" && row.clientRequestedBy === "Olive Old", `${req.message} · ${row.status} · ${row.clientRequestedBy}`);
      const ws = await old.room.getCutWorkspace(W.f.projectId!, cut);
      const s0 = ws?.submissions.find((s) => s.id === cut) as unknown as Record<string, unknown> | undefined;
      c.ok("OLD: the workspace hands the page the OFFICE APPROVER and the approval's time", s0?.decidedBy === "James Rivera" && s0?.decidedAt === approvedAt.toISOString(), `${s0?.decidedBy} @ ${s0?.decidedAt}`);
      c.ok("OLD: …and nothing about the client's send-back reaches it", !!s0 && !("clientRequestedBy" in s0) && !("verdict" in s0), Object.keys(s0 ?? {}).join(","));
      const oldPage = base.editPageSrc;
      c.ok("OLD: the edit page builds the revision block from decidedBy and never selects the client's stamp", /sentBackBy: s\.decidedBy/.test(oldPage) && !/clientRequestedAt/.test(oldPage));
      // What the old card printed, by its own formula (RevisionBriefCard at BASE).
      const oldLine = `sent back ${at.whenET(approvedAt)} by ${s0?.decidedBy}`;
      c.ok("OLD: so the editor read the approver as the sender, at the approval's time", oldLine === `sent back ${ET(approvedAt)} by James Rivera`, oldLine);

      // (b) gap 16 / 17 / 18 / 7 — old writes.
      const J = await mkJob("1 Old Note Ln");
      const k0 = await mkCut(J, 1);
      viewer = V.kyle;
      const n0 = await old.actions.addCutNote({ projectId: J.id, submissionId: k0, body: "Tighten the intro", lane: "EDITOR", kind: "fix", timeSec: 4 });
      const note0 = await prisma.mediaNote.findFirst({ where: { projectId: J.id, parentId: null } });
      c.ok("OLD: a login with no name signs its note with its EMAIL", n0.ok && note0?.authorName === "kyle@drill.invalid", note0?.authorName ?? "none");
      await old.actions.setCutNoteStatus(note0!.id, "RESOLVED");
      const note0b = await prisma.mediaNote.findUniqueOrThrow({ where: { id: note0!.id } });
      c.ok("OLD: resolving records no person (statusBy / statusAt stay empty)", note0b.status === "RESOLVED" && note0b.statusBy === null && note0b.statusAt === null);
      const k1 = await mkCut(await mkJob("2 Old Verdict Ln"), 1);
      await approveAs(V.james, k1, old.actions);
      const r1 = await sub(k1);
      const line1 = await prisma.activity.findFirst({ where: { projectId: r1.projectId, body: { startsWith: "Cut approved in review" } } });
      c.ok("OLD: the verdict carries a name but no login id", r1.decidedBy === "James Rivera" && r1.decidedByUserId === null);
      c.ok("OLD: the timeline line names nobody and has no author", line1?.body === "Cut approved in review (round 1)." && line1.authorId === null, line1?.body ?? "none");
      c.ok("OLD: the Room's note list rendered the words without the author or the time", !/n\.createdAt/.test(base.panelSrc) && !/byLine/.test(base.panelSrc));

      // (c) gap 20 — auth off + "view as": the old desk wrote under the previewed person.
      delete process.env.AUTH_ENFORCE;
      viewer = V.preview;
      const k2 = await mkCut(await mkJob("3 Old Preview Ln"), 1);
      const before = await prisma.mediaNote.count();
      const pw = await old.actions.addCutNote({ projectId: (await sub(k2)).projectId, submissionId: k2, body: "written in a preview", lane: "EDITOR", kind: "fix", timeSec: null });
      const leaked = await prisma.mediaNote.findFirst({ where: { body: "written in a preview" } });
      c.ok("OLD: with auth off, a preview's note is WRITTEN, under the previewed editor's name", pw.ok && (await prisma.mediaNote.count()) === before + 1 && leaked?.authorName === "Kim Miguel", `${pw.ok} · ${leaked?.authorName}`);
      process.env.AUTH_ENFORCE = "true";

      // (d) gap 9 — the old portal work order credits every note to the sender.
      const P = await contentWorld("Patty Old", "Patty Old");
      const casey = await prisma.clientUser.create({ data: { email: "casey-old@example.com", name: "Casey Old", status: "ACTIVE" }, select: { id: true } });
      await prisma.clientMembership.create({ data: { clientUserId: casey.id, enrollmentId: P.f.enrollmentId, clientId: P.f.clientId, role: "COLLABORATOR", acceptedAt: new Date() } });
      const pc = await P.cut(1);
      await approveAndPublish(V.james, pc);
      await P.note(pc, "Swap the song", { clientUserId: casey.id }, 3);
      await P.note(pc, "Crop the logo", { clientUserId: P.f.clientUserId }, 9);
      viewer = null;
      await old.cd.requestChangesOnCut(P.owner, pc, "");
      const oldBrief = await prisma.revisionBrief.findFirst({ where: { projectId: P.f.projectId!, sourceDetail: { startsWith: "decision:" } } });
      c.ok("OLD: the work order credits both notes to whoever pressed Submit", !!oldBrief && /by Patty Old/.test(oldBrief.originalText) && !/Casey Old/.test(oldBrief.originalText), oldBrief?.originalText.replace(/\n/g, " | "));

      // (e) gap 19 — James answering a creative still reads "unanswered".
      const T = await mkJob("4 Old Thread Ln");
      const tc = await mkCut(T, 1);
      viewer = V.james;
      await rr.addCutNote({ projectId: T.id, submissionId: tc, body: "Which driveway?", lane: "EDITOR", kind: "fix", timeSec: 2 });
      const root = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: T.id, parentId: null } });
      viewer = V.kim;
      await rr.replyCutNote(root.id, "The one on the left?");
      advance(1);
      viewer = V.james;
      await rr.replyCutNote(root.id, "Yes, the left one.");
      const oq = await old.room.getReviewQueue();
      const oldFollow = oq.followUps.find((f) => f.projectId === T.id && f.lane === "EDITOR");
      c.ok("OLD: James answered last, and the thread still counts as unanswered", oldFollow?.awaitingReply === 1, `awaitingReply=${oldFollow?.awaitingReply}`);
      const nq = await room.getReviewQueue();
      const newFollow = nq.followUps.find((f) => f.projectId === T.id && f.lane === "EDITOR");
      c.ok("NEW: the same thread is answered — James is the review desk (gap 19)", newFollow?.awaitingReply === 0, `awaitingReply=${newFollow?.awaitingReply}`);

      // (f) gap 12 — the office's queue-add.
      const D = await mkJob("5 Old Reopen Ln", "DELIVERED");
      await mkCut(D, 1, { status: "APPROVED", decidedAt: new Date(Date.now() - 4 * 86_400_000), decidedBy: "James Rivera" });
      viewer = V.kyle;
      const qa = await old.editing.addToEditorQueue(D.id, "kim", "Swap the music");
      const oldTask = await prisma.smartTask.findFirst({ where: { projectId: D.id, taskType: "revision" } });
      const oldClock = await prisma.revisionBrief.findFirst({ where: { projectId: D.id, source: "office" } });
      c.ok("OLD: Kyle's queue-add says \"The owner\" and nobody is flagged", qa.ok && /^The owner queued/.test(oldTask?.summary ?? "") && !oldTask?.flaggedBy, oldTask?.summary?.slice(0, 40));
      // (The old action reaches TODAY's clock writer, which files a nameless
      // reopen as the hub's — the old action itself never passed a person.)
      c.ok("OLD: the reopen's clock row says \"the office\" and names no person", !!oldClock && /Reopened by the office/.test(oldClock.originalText) && oldClock.requestedBy === null, `${oldClock?.originalText} · ${oldClock?.requestedByKind}`);
    }

    // =========================================================================
    c.head("1 · GAP 1: the client's send-back reads as the client's, at their time");
    // =========================================================================
    {
      const W = await contentWorld("Nora New", "Nora New");
      const cut = await W.cut(1);
      await approveAndPublish(V.james, cut);
      const approvedAt = (await sub(cut)).decidedAt!;
      advance(120);
      await W.note(cut, "Brighten the kitchen", { clientUserId: W.f.clientUserId });
      viewer = null;
      const req = await cd.requestChangesOnCut(W.owner, cut, "");
      const row = await sub(cut);
      c.ok("the request lands; the office's approval is still on the row as its QC record", req.ok && row.status === "CHANGES_REQUESTED" && row.decidedBy === "James Rivera" && row.decidedAt?.getTime() === approvedAt.getTime(), `${req.ok ? "" : `refused: ${req.message} · `}${row.status} · ${row.decidedBy} @ ${row.decidedAt?.toISOString()}`);
      const v = at.verdictOf(row);
      c.ok("the verdict is the CLIENT's, at the client's time", v?.source === "client" && v.by === "Nora New" && v.atISO === row.clientRequestedAt?.toISOString(), JSON.stringify(v));
      c.ok("…and reads \"Client changes by Nora New · <the client's time>\"", at.verdictLine(v) === `Client changes by Nora New · ${ET(row.clientRequestedAt!)}` && ET(row.clientRequestedAt!) !== ET(approvedAt), at.verdictLine(v) ?? "");
      const ws = await room.getCutWorkspace(W.f.projectId!, cut);
      const s1 = ws?.submissions.find((s) => s.id === cut);
      c.ok("the workspace carries the client's stamp and the same verdict to every screen", s1?.clientRequestedBy === "Nora New" && s1.verdict?.source === "client" && s1.verdict.by === "Nora New", JSON.stringify(s1?.verdict));
      const q = await room.getReviewQueue();
      const qrow = q.waitingOnEditor.find((s) => s.id === cut);
      c.ok("the queue's In-revisions row says it was the client", qrow?.verdict?.source === "client" && at.verdictLine(qrow.verdict)?.startsWith("Client changes by Nora New") === true, at.verdictLine(qrow?.verdict) ?? "no row");
      const page = fs.readFileSync(path.join(REPO, "src/app/edit/[id]/page.tsx"), "utf8");
      // Oct 5 2026: a60424b (Oct 2) folded the per-round revision block into
      // each version's panel on the edit page — the verdict now rides as
      // EditorCutPanel's verdict={verdictOf(s)}, the same pure rule.
      c.ok("the edit page now selects the client's stamp and hands each version's panel the verdict",
        /clientRequestedAt: true, clientRequestedBy: true/.test(page) && /<EditorCutPanel\b[^>]*?verdict=\{verdictOf\(s\)\}/.test(page.replace(/\s+/g, " ")));
      // The rule's other half: the office rules AFTER the client → the office's.
      const later = at.verdictOf({ status: "CHANGES_REQUESTED", decidedAt: new Date(Date.now() + 60_000), decidedBy: "Kyle Cabrera", clientRequestedAt: row.clientRequestedAt, clientRequestedBy: "Nora New" });
      c.ok("an office verdict given after the client's reads as the office's", later?.source === "office" && later.by === "Kyle Cabrera");
      c.ok("the ET format itself: 16:05 UTC on Sep 28 prints \"Mon, Sep 28, 12:05 PM\"", at.byLine("James Rivera", new Date(Date.UTC(2026, 8, 28, 16, 5))) === "James Rivera · Mon, Sep 28, 12:05 PM");
      c.ok("a delivered stamp reads as the hub's, never as a person", at.verdictLine(at.verdictOf({ status: "APPROVED", decidedAt: new Date(), decidedBy: DELIVERED_STAMP }))?.startsWith("Marked approved when the job was delivered") === true);
    }

    // =========================================================================
    c.head("2 · Office notes: who and when, roster name before email");
    // =========================================================================
    const J2 = await mkJob("20 Note Author Rd");
    const c2 = await mkCut(J2, 1);
    {
      advance(5);
      viewer = V.james;
      await rr.addCutNote({ projectId: J2.id, submissionId: c2, body: "Logo is soft at the end", lane: "EDITOR", kind: "fix", timeSec: 41 });
      advance(1);
      viewer = V.kyle;
      await rr.addCutNote({ projectId: J2.id, submissionId: c2, body: "Music is too loud", lane: "EDITOR", kind: "fix", timeSec: 12 });
      advance(1);
      viewer = V.harrison;
      const ask = await rr.askCutChange({ projectId: J2.id, submissionId: c2, body: "That is the neighbour's driveway", timeSec: 14 });
      const notes = await prisma.mediaNote.findMany({ where: { projectId: J2.id, parentId: null }, orderBy: { createdAt: "asc" } });
      const byBody = (b: string) => notes.find((n) => n.body === b);
      c.ok("James's note: his name and his login", byBody("Logo is soft at the end")?.authorName === "James Rivera" && byBody("Logo is soft at the end")?.authorUserId === uJames.id);
      c.ok("Kyle's login has no name → the ROSTER name, never the email (gap 16)", byBody("Music is too loud")?.authorName === "Kyle Cabrera" && byBody("Music is too loud")?.authorUserId === uKyle.id, byBody("Music is too loud")?.authorName ?? "");
      c.ok("the photographer's ask carries his login too", ask.ok && byBody("That is the neighbour's driveway")?.authorUserId === uHarrison.id);
      viewer = V.kim;
      const kimNote = byBody("Music is too loud")!;
      advance(2);
      const rep = await rr.replyCutNote(kimNote.id, "Lowered it 6 dB");
      const reply = await prisma.mediaNote.findFirst({ where: { parentId: kimNote.id } });
      c.ok("Kim's reply: her name, her login", rep.ok && reply?.authorName === "Kim Miguel" && reply.authorUserId === uKim.id);
      const ws = await room.getCutWorkspace(J2.id, c2);
      const wNote = ws?.notes.find((n) => n.id === byBody("Logo is soft at the end")!.id);
      const jNote = byBody("Logo is soft at the end")!;
      c.ok("the Review Room's note list carries author + time: \"James Rivera · <when>\"", !!wNote && at.byLine(wNote.authorName, wNote.createdAt) === `James Rivera · ${ET(jNote.createdAt)}`, wNote ? at.byLine(wNote.authorName, wNote.createdAt) : "none");
      const wKyle = ws?.notes.find((n) => n.id === kimNote.id);
      // (Row times come from the database's own clock, not the pinned one.)
      c.ok("replies carry their time (gap 3)", !!wKyle?.replies[0] && at.whenET(wKyle.replies[0].createdAt) === ET(reply!.createdAt) && /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/.test(ET(reply!.createdAt)) /* Oct 5 2026: was "Mon, Sep 28" — the database's own clock, i.e. the day it ran; the format is the claim */, wKyle?.replies[0]?.createdAt);
      const panel = fs.readFileSync(path.join(REPO, "src/components/review/CutReviewPanel.tsx"), "utf8");
      c.ok("the panel prints byLine(author, createdAt) on every note and the time on every reply", /byLine\(n\.authorName \?\? "Someone", n\.createdAt\)/.test(panel) && /whenET\(r\.createdAt\)/.test(panel));
      const fb = await room.getEditorFeedback(J2.id, "kim");
      c.ok("the editor's own feedback list gets the same author + time (gap 4)", fb.length >= 3 && fb.every((n) => !!n.authorName && !!n.createdAt), fb.map((n) => n.authorName).join(", "));
    }

    // =========================================================================
    c.head("3 · Verdicts named: the row, the timeline, the bell, the edit card, earlier rounds");
    // =========================================================================
    {
      advance(3);
      viewer = V.kyle;
      const back = await rr.requestCutChanges(c2);
      const r = await sub(c2);
      c.ok("Kyle sends it back: his roster name and his login on the verdict (gap 17)", back.ok && r.decidedBy === "Kyle Cabrera" && r.decidedByUserId === uKyle.id, back.message);
      const card = await prisma.smartTask.findFirstOrThrow({ where: { dedupeKey: `edit-video-${J2.id}` } });
      const desc = card.description ?? "";
      c.ok("the edit card's round names the sender and the moment", desc.includes(`· by Kyle Cabrera, ${ET(r.decidedAt!)}`) && /^Round 2 — sent back from the Review Room /m.test(desc), desc.split("\n\n").find((x) => x.startsWith("Round 2"))?.split("\n")[0]);
      // Mixed authors: every line is named — the sender's own too — so the
      // editor never has to guess which bare line is whose.
      c.ok("each note in the bundle carries its author (gap 6)", /Logo is soft at the end — James Rivera/.test(desc) && /neighbour's driveway — Harrison Wells/.test(desc) && /Music is too loud — Kyle Cabrera$/m.test(desc), desc.replace(/\n/g, " | "));
      c.ok("the card's summary names the sender too", /by Kyle Cabrera\)/.test(card.summary ?? ""), card.summary ?? "");
      const tl = await prisma.activity.findFirst({ where: { projectId: J2.id, body: { startsWith: "Changes requested on the round-1 cut" } } });
      c.ok("the timeline line names Kyle and is authored by his roster row (gap 7)", tl?.body === "Changes requested on the round-1 cut (3 notes) by Kyle Cabrera." && tl.authorId === kyle.id, tl?.body);
      const bell = await prisma.notification.findFirst({ where: { kind: "review_changes", dedupeKey: { startsWith: `review-changes-${c2}` }, audience: { contains: "ADMIN" } } });
      c.ok("the bell names the sender", !!bell?.body && bell.body.startsWith("Kyle Cabrera sent back 3 notes"), bell?.body ?? "none");
      // Idempotent whoever presses: the same round's same notes don't append twice.
      const roundBlock = desc.split("\n\n").find((b) => b.startsWith("Round 2 —")) ?? "";
      const [roundHeader, ...roundLines] = roundBlock.split("\n");
      const roundReason = roundHeader.replace(/^Round 2 — /, "").replace(/ · by .*$/, "");
      await addRoundToEditCard(J2.id, { round: 2, notes: roundLines, reason: roundReason, by: { name: "James Rivera" } });
      const again = (await prisma.smartTask.findUniqueOrThrow({ where: { id: card.id } })).description ?? "";
      c.ok("re-adding the same round under another name does not append it twice", (again.match(/^Round 2 — /gm) ?? []).length === 1, `${(again.match(/^Round 2 — /gm) ?? []).length} blocks`);

      // Round 2 in, James approves.
      advance(30);
      const c2b = await mkCut(J2, 2);
      await approveAs(V.james, c2b);
      const r2 = await sub(c2b);
      c.ok("James approves: name + login on the verdict", r2.decidedBy === "James Rivera" && r2.decidedByUserId === uJames.id);
      const tl2 = await prisma.activity.findFirst({ where: { projectId: J2.id, body: { startsWith: "Cut approved in review (round 2)" } } });
      c.ok("…the timeline line names him", tl2?.body === "Cut approved in review (round 2) by James Rivera." && tl2.authorId === james.id, tl2?.body);
      const bell2 = await prisma.notification.findFirst({ where: { kind: "review_approved", dedupeKey: { startsWith: `review-approved-${c2b}` }, audience: { contains: "ADMIN" } } });
      c.ok("…and so does the bell", bell2?.body?.startsWith("Approved by James Rivera.") === true, bell2?.body ?? "none");
      const ws = await room.getCutWorkspace(J2.id, c2b);
      const v1 = ws?.submissions.find((s) => s.id === c2)?.verdict;
      const v2 = ws?.submissions.find((s) => s.id === c2b)?.verdict;
      c.ok("earlier rounds: \"Sent back by Kyle Cabrera · <when>\"", at.verdictLine(v1) === `Sent back by Kyle Cabrera · ${ET(r.decidedAt!)}`, at.verdictLine(v1) ?? "");
      c.ok("the current round: \"Approved by James Rivera · <when>\"", at.verdictLine(v2) === `Approved by James Rivera · ${ET(r2.decidedAt!)}`, at.verdictLine(v2) ?? "");
      const q = await room.getReviewQueue();
      const qa = q.recentlyApproved.find((s) => s.id === c2b);
      c.ok("the queue row names who approved it", at.verdictLine(qa?.verdict) === `Approved by James Rivera · ${ET(r2.decidedAt!)}`, at.verdictLine(qa?.verdict) ?? "no row");
      const pq = await room.getPhotographerReviewQueue(harrison.id);
      c.ok("the photographer's own queue reads the same line", at.verdictLine(pq.decided.find((s) => s.id === c2b)?.verdict) === at.verdictLine(qa?.verdict));
      // The tracker's round history and the editor's pills read the same verdictOf.
      const tracker = fs.readFileSync(path.join(REPO, "src/components/editing/EditTracker.tsx"), "utf8");
      c.ok("the tracker prints each round's verdict line (it used to drop decidedBy)", /r\.verdictLine && /.test(tracker) && /verdictLine: verdictLine\(verdictOf\(s\)\)/.test(fs.readFileSync(path.join(REPO, "src/app/edit/[id]/page.tsx"), "utf8")));
    }

    // =========================================================================
    c.head("4 · Portal: every note's author on the work order; the Room's client notes");
    // =========================================================================
    {
      const P = await contentWorld("Pat Client", "Pat Client");
      const casey = await prisma.clientUser.create({ data: { email: "casey@example.com", name: "Casey Collab", status: "ACTIVE" }, select: { id: true } });
      await prisma.clientMembership.create({ data: { clientUserId: casey.id, enrollmentId: P.f.enrollmentId, clientId: P.f.clientId, role: "COLLABORATOR", acceptedAt: new Date() } });
      const p1 = await P.cut(1);
      const p2 = await P.cut(2);
      const p3 = await P.cut(3);
      for (const id of [p1, p2, p3]) await approveAndPublish(V.james, id);
      viewer = null;
      advance(10);
      const casNote = await P.note(p1, "Swap the song", { clientUserId: casey.id }, 3);
      await P.note(p1, "Crop the logo", { clientUserId: P.f.clientUserId }, 9);
      const r1 = await cd.requestChangesOnCut(P.owner, p1, "");
      const b1 = await prisma.revisionBrief.findFirst({ where: { projectId: P.f.projectId!, sourceDetail: { startsWith: "decision:" }, submissionId: p1 } });
      c.ok("mixed authors: each bullet names its own (gap 9)", r1.ok && !!b1 && /Swap the song — Casey Collab/.test(b1.originalText) && /Crop the logo — Pat Client/.test(b1.originalText), b1?.originalText.replace(/\n/g, " | "));
      c.ok("the brief's requester: the sender, CLIENT, their login (gap 10)", b1?.requestedBy === "Pat Client" && b1.requestedByKind === "CLIENT" && b1.requestedByUserId === P.f.clientUserId, `${b1?.requestedBy} · ${b1?.requestedByKind}`);
      const issues = await prisma.revisionIssue.findMany({ where: { projectId: P.f.projectId!, sourceKind: "BRIEF_ITEM" } });
      c.ok("the issues from it are raised by Pat, not by \"Client\" (gap 13)", issues.length > 0 && issues.every((i) => i.raisedByName === "Pat Client"), issues.map((i) => i.raisedByName).join(", "));
      const task = await prisma.smartTask.findFirst({ where: { id: b1?.taskId ?? "" } });
      c.ok("the revision task's person is the sender (gap 11)", task?.contactName === "Pat Client", task?.contactName ?? "none");
      const bell = await prisma.notification.findFirst({ where: { kind: "revision_raised", dedupeKey: { startsWith: "portal-round-" }, body: { startsWith: "Pat Client:" } } });
      c.ok("the portal revision's bell leads with who asked", !!bell, bell?.body ?? "none");

      // One author only → bare bullets (the header already names them).
      advance(5);
      await P.note(p2, "Slower cuts please", { clientUserId: P.f.clientUserId }, 4);
      await cd.requestChangesOnCut(P.owner, p2, "");
      const b2 = await prisma.revisionBrief.findFirst({ where: { submissionId: p2, sourceDetail: { startsWith: "decision:" } } });
      c.ok("one author: the bullets stay bare, the header names her", !!b2 && /by Pat Client/.test(b2.originalText) && /• \[0:04\] Slower cuts please$/m.test(b2.originalText), b2?.originalText.replace(/\n/g, " | "));

      // Staff on the client's behalf (the owner iframe).
      advance(5);
      const staff = { enrollment: P.enrollment, actor: { kind: "STAFF", staffUserId: uJordan.id, staffName: "Jordan Spackman", staffRole: "OWNER" }, access: "FULL", via: "STAFF" } as PortalViewer;
      await P.note(p3, "Add the phone number at the end", { staffUserId: uJordan.id }, 20);
      const r3 = await cd.requestChangesOnCut(staff, p3, "");
      const b3 = await prisma.revisionBrief.findFirst({ where: { submissionId: p3, sourceDetail: { startsWith: "decision:" } } });
      c.ok("staff for the client: requester CLIENT_STAFF, \"on behalf of\", Jordan's login", r3.ok && b3?.requestedBy === `Jordan Spackman (on behalf of ${P.f.clientName})` && b3.requestedByKind === "CLIENT_STAFF" && b3.requestedByUserId === uJordan.id, `${b3?.requestedBy} · ${b3?.requestedByKind}`);
      c.ok("…and the brief card's line says so", at.requesterLine({ requestedBy: b3?.requestedBy, requestedByKind: b3?.requestedByKind, at: b3?.createdAt }) === `Asked by Jordan Spackman (on behalf of ${P.f.clientName}) · ${ET(b3!.createdAt)}`);
      const briefs = await getRevisionBriefs(P.f.projectId!, true);
      c.ok("getRevisionBriefs hands every brief card its requester", briefs.filter((b) => b.sourceDetail?.startsWith("decision:")).every((b) => !!b.requestedBy && !!b.requestedByKind));

      // A reply from Pat under Casey's note, and two browsers on the emailed link.
      advance(2);
      await cd.replyToComment(P.owner, casNote.id, "Any upbeat track is fine");
      const token = { enrollment: P.enrollment, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" } as PortalViewer;
      advance(1);
      await cd.replyToComment(token, casNote.id, "From the link, first browser");
      // Through the module loader, so it is the harness's stub jar — the one
      // clientDecisions' static import of next/headers was handed.
      const headers = Module.createRequire(__filename)("next/headers") as { cookies: () => Promise<{ get: (n: string) => { value: string } | undefined; delete: (n: string) => void }> };
      const jar = await headers.cookies();
      const cookie1 = jar.get("rtp_lv")?.value ?? "";
      jar.delete("rtp_lv");
      advance(1);
      await cd.replyToComment(token, casNote.id, "From the link, second browser");
      const cookie2 = jar.get("rtp_lv")?.value ?? "";
      const visits = await prisma.portalVisit.count({ where: { enrollmentId: P.f.enrollmentId, via: "TOKEN", path: { startsWith: "/portal/comment/" } } });
      c.ok("the link's two browsers each got their own visitor id, recorded beside the note (gap 21)", /^[A-Za-z0-9_-]{12}$/.test(cookie1) && /^[A-Za-z0-9_-]{12}$/.test(cookie2) && cookie1 !== cookie2 && visits === 2, `${visits} visits`);
      const groups = await cd.clientNotesForReviewRoom(P.f.projectId!);
      const all = groups.flatMap((g) => g.notes);
      const cas = all.find((n) => n.id === casNote.id);
      c.ok("the Room's client notes are grouped by cut (gap 8)", groups.length === 3 && groups.every((g) => g.notes.every((n) => n.submissionId === g.submissionId)), `${groups.length} groups`);
      c.ok("…each with its author and time: \"Casey Collab · <when>\"", cas?.author === "Casey Collab" && at.byLine(cas.author, cas.createdAtISO) === `Casey Collab · ${ET(cas.createdAtISO)}` && /^Casey Collab · [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/.test(at.byLine(cas.author, cas.createdAtISO)) /* Oct 5 2026: was "Mon, Sep 28" — the database's own clock; the format is the claim */, cas ? at.byLine(cas.author, cas.createdAtISO) : "none");
      c.ok("…a sent note says so, not \"new\"", cas?.status === "SENT");
      const repliesAuthors = cas?.replies.map((r) => r.author) ?? [];
      c.ok("replies nest under their note, each named — Pat, then link visitors 1 and 2", repliesAuthors.length === 3 && repliesAuthors[0] === "Pat Client" && repliesAuthors[1] === `${P.f.clientName} (portal), link visitor 1` && repliesAuthors[2] === `${P.f.clientName} (portal), link visitor 2`, repliesAuthors.join(" | "));
      const staffNote = all.find((n) => n.body === "Add the phone number at the end");
      c.ok("our staff's note is flagged as on the client's behalf", staffNote?.onBehalf === true && staffNote.author === `Jordan Spackman (on behalf of ${P.f.clientName})`, staffNote?.author);
      // The client's own page is unchanged: staff read "(RealTour Pilot)".
      const mine = await cd.commentsForSubmissions(P.owner, [p3]);
      c.ok("the client's own page still reads our staff as \"Jordan Spackman (RealTour Pilot)\"", mine.get(p3)?.[0]?.author === "Jordan Spackman (RealTour Pilot)", mine.get(p3)?.[0]?.author);
    }

    // =========================================================================
    c.head("5 · The office's reopen names the signed-in person");
    // =========================================================================
    {
      const D = await mkJob("50 Reopen Way", "DELIVERED");
      await mkCut(D, 1, { status: "APPROVED", decidedAt: new Date(Date.now() - 4 * 86_400_000), decidedBy: "James Rivera" });
      advance(10);
      viewer = V.kyle;
      const qa = await editing.addToEditorQueue(D.id, "kim", "Swap the music");
      const task = await prisma.smartTask.findFirst({ where: { projectId: D.id, taskType: "revision" } });
      const clock = await prisma.revisionBrief.findFirst({ where: { projectId: D.id, source: "office" } });
      const tl = await prisma.activity.findFirst({ where: { projectId: D.id, body: { startsWith: "Queued a new cut" } } });
      // MOVED TO THE REVIEW'S LAW (Sep 28): the builder made Kyle the task's
      // flagger (flaggedBy), which is "Flagged for immediate review" on his and
      // Kim's home and stayed on the row over the client's next ask. The
      // presser is named by the card's own sentence instead (officeReopenOf).
      c.ok("the card says Kyle queued it — and flags nobody (no home-banner flag)", qa.ok && /^Kyle Cabrera queued a new edit/.test(task?.summary ?? "") && task?.flaggedBy === null && task.flaggedAt === null && at.officeReopenOf(task)?.by === "Kyle Cabrera", `${task?.summary?.slice(0, 50)} · flaggedBy=${task?.flaggedBy}`);
      c.ok("the reopen's clock row: requester Kyle, OFFICE, his login; words name him", clock?.requestedBy === "Kyle Cabrera" && clock.requestedByKind === "OFFICE" && clock.requestedByUserId === uKyle.id && /^Reopened by Kyle Cabrera, not a client request/.test(clock.originalText), clock?.originalText);
      c.ok("the timeline line names him", /^Queued a new cut \(as a revision\) by Kyle Cabrera/.test(tl?.body ?? ""), tl?.body);
      c.ok("the Room's banner line for it: \"Put back by Kyle Cabrera (the office)\"", at.officeReopenLine(at.officeReopenOf(task)!) === "Put back by Kyle Cabrera (the office)", at.officeReopenOf(task) ? at.officeReopenLine(at.officeReopenOf(task)!) : "not an office reopen");
      // The queue pill's flip reaches addRoundToEditCard with no name: the session is the presser.
      const P2 = await mkJob("51 Pill Flip Way");
      await mkCut(P2, 1, { status: "APPROVED", decidedAt: new Date(), decidedBy: "James Rivera" });
      viewer = V.james;
      await addRoundToEditCard(P2.id, { round: 2, notes: ["Flipped to Revisions on the Editing Room queue"], reason: "flipped to Revisions on the queue" });
      const pill = await prisma.smartTask.findFirst({ where: { dedupeKey: `edit-video-${P2.id}` } });
      c.ok("the pill's round names its presser from the session", /Round 2 — flipped to Revisions on the queue · by James Rivera, /.test(pill?.description ?? ""), pill?.description?.split("\n")[0]);
      viewer = null;
      const P3 = await mkJob("52 Cron Way");
      await addRoundToEditCard(P3.id, { round: 2, notes: ["x"], reason: "hourly repair" });
      const cron = await prisma.smartTask.findFirst({ where: { dedupeKey: `edit-video-${P3.id}` } });
      c.ok("no session (a cron) names nobody", /^Round 2 — hourly repair$/m.test(cron?.description ?? ""), cron?.description?.split("\n")[0]);
    }

    // =========================================================================
    c.head("6 · Requester kinds for email, text and calls");
    // =========================================================================
    {
      const E = await mkJob("60 Email Ct", "DELIVERED");
      await raiseRevision({ projectId: E.id, clientId: client.id, clientName: "Gary Mercer", note: "Can you brighten the video intro please", source: "gmail" });
      const be = await prisma.revisionBrief.findFirst({ where: { projectId: E.id } });
      const te = await prisma.smartTask.findFirst({ where: { projectId: E.id, taskType: "revision" } });
      // MOVED TO THE REVIEW'S LAW (Sep 28): a caller that names no sender used
      // to get the ACCOUNT client as its asker — which is the agent when an
      // assistant wrote. Now nobody is named; the channel still is.
      c.ok("an email ask with no sender given: nobody named (not the account client), EMAIL", be?.requestedBy === null && be.requestedByKind === "EMAIL", `${be?.requestedBy} · ${be?.requestedByKind}`);
      c.ok("…and the task carries no separate person", te?.contactName === null);
      const fe = await prisma.activity.findFirst({ where: { projectId: E.id, body: { startsWith: REVISION_FLAG_PREFIX } } });
      c.ok("the timeline flag still starts with the field-flag filter's prefix, and names nobody it was not told", !!fe && fe.body.startsWith(`${REVISION_FLAG_PREFIX}gmail): `), fe?.body.slice(0, 60));
      const T = await mkJob("61 Text Ct", "DELIVERED");
      await raiseRevisionDetailed({ projectId: T.id, clientId: client.id, clientName: "Gary Mercer", note: "Please remove the drone clip from the reel", source: "openphone", requestedBy: { name: "Olivia Assistant", kind: "TEXT" } });
      const bt = await prisma.revisionBrief.findFirst({ where: { projectId: T.id } });
      const tt = await prisma.smartTask.findFirst({ where: { projectId: T.id, taskType: "revision" } });
      c.ok("an assistant's text: TEXT, named, and the task's person", bt?.requestedByKind === "TEXT" && bt.requestedBy === "Olivia Assistant" && tt?.contactName === "Olivia Assistant");
      const bellT = await prisma.notification.findFirst({ where: { kind: "revision_raised", body: { startsWith: "Olivia Assistant:" } } });
      c.ok("…and the bell leads with her", !!bellT, bellT?.body ?? "none");
      const C = await mkJob("62 Call Ct", "DELIVERED");
      await raiseRevision({ projectId: C.id, clientId: client.id, clientName: "Gary Mercer", note: "On the call: swap the song on the reel", source: "openphone-call" });
      const bc = await prisma.revisionBrief.findFirst({ where: { projectId: C.id } });
      c.ok("a call: PHONE", bc?.requestedByKind === "PHONE", bc?.requestedByKind ?? "");
      c.ok("the words for each kind", [
        at.requesterWords("EMAIL", "Gary Mercer") === "Gary Mercer, by email",
        at.requesterWords("TEXT", "Olivia Assistant") === "Olivia Assistant, by text",
        at.requesterWords("PHONE", "Gary Mercer") === "Gary Mercer, on a call",
        at.requesterWords("OFFICE", "Kyle Cabrera") === "Kyle Cabrera (the office)",
        at.requesterWords("SYSTEM", null) === "the hub, automatically",
        at.requesterWords("CLIENT", null) === null,
      ].every(Boolean));
    }

    // =========================================================================
    c.head("7 · statusBy / statusAt: who resolved, reopened or fixed a note");
    // =========================================================================
    {
      const J = await mkJob("70 Status Ln");
      const k = await mkCut(J, 1);
      viewer = V.james;
      await rr.addCutNote({ projectId: J.id, submissionId: k, body: "Colour is off", lane: "EDITOR", kind: "fix", timeSec: 3 });
      const n = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: J.id, parentId: null } });
      advance(4);
      viewer = V.kim;
      const fx = await rr.setCutNoteStatus(n.id, "FIXED");
      let row = await prisma.mediaNote.findUniqueOrThrow({ where: { id: n.id } });
      c.ok("Kim marks it fixed: \"Marked fixed by Kim Miguel · …\"", fx.ok && at.statusLine(row) === `Marked fixed by Kim Miguel · ${ET(row.statusAt!)}`, at.statusLine(row) ?? "");
      advance(4);
      viewer = V.james;
      await rr.setCutNoteStatus(n.id, "RESOLVED");
      row = await prisma.mediaNote.findUniqueOrThrow({ where: { id: n.id } });
      c.ok("James resolves it: statusBy + statusAt, resolvedAt the same moment", row.statusBy === "James Rivera" && !!row.statusAt && row.resolvedAt?.getTime() === row.statusAt.getTime() && at.statusLine(row)?.startsWith("Resolved by James Rivera") === true, at.statusLine(row) ?? "");
      advance(4);
      viewer = V.kyle;
      await rr.setCutNoteStatus(n.id, "OPEN");
      row = await prisma.mediaNote.findUniqueOrThrow({ where: { id: n.id } });
      c.ok("Kyle reopens it: \"Reopened by Kyle Cabrera\"", at.statusLine(row)?.startsWith("Reopened by Kyle Cabrera · ") === true && row.resolvedAt === null, at.statusLine(row) ?? "");
      const ws = await room.getCutWorkspace(J.id, k);
      c.ok("the Room's note carries it to the status dot", ws?.notes[0]?.statusBy === "Kyle Cabrera" && !!ws.notes[0].statusAt);
    }

    // =========================================================================
    c.head("8 · \"View as\" writes nothing — auth OFF and auth ON");
    // =========================================================================
    for (const mode of ["off", "on"] as const) {
      if (mode === "off") delete process.env.AUTH_ENFORCE;
      else process.env.AUTH_ENFORCE = "true";
      const J = await mkJob(`80 Preview ${mode} Ln`);
      const k = await mkCut(J, 1);
      viewer = V.james;
      await rr.addCutNote({ projectId: J.id, submissionId: k, body: "a real note", lane: "EDITOR", kind: "fix", timeSec: 1 });
      const n = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: J.id, parentId: null } });
      const D = await mkJob(`81 Preview ${mode} Ln`, "DELIVERED");
      const snapshot = async () => JSON.stringify({
        notes: await prisma.mediaNote.count(),
        subs: (await prisma.reviewSubmission.findMany({ where: { projectId: { in: [J.id, D.id] } }, select: { status: true, reviewerTeamMemberId: true } })),
        note: await prisma.mediaNote.findUnique({ where: { id: n.id }, select: { status: true, statusBy: true } }),
        tasks: await prisma.smartTask.count(),
        events: await prisma.cutReviewerEvent.count(),
        away: await prisma.appSetting.count({ where: { key: { startsWith: "review-away:" } } }),
      });
      const before = await snapshot();
      viewer = V.preview;
      const results = {
        addCutNote: await rr.addCutNote({ projectId: J.id, submissionId: k, body: "preview note", lane: "EDITOR", kind: "fix", timeSec: 1 }),
        askCutChange: await rr.askCutChange({ projectId: J.id, submissionId: k, body: "preview ask", timeSec: 1 }),
        replyCutNote: await rr.replyCutNote(n.id, "preview reply"),
        resolve: await rr.setCutNoteStatus(n.id, "RESOLVED"),
        fixed: await rr.setCutNoteStatus(n.id, "FIXED"),
        approveCut: await rr.approveCut(k),
        requestCutChanges: await rr.requestCutChanges(k),
        claimCutReview: await rr.claimCutReview(k),
        reassignCutReviewer: await rr.reassignCutReviewer(k, kyle.id),
        setCutReviewerAway: await rr.setCutReviewerAway(james.id, "2026-10-02"),
        submitCutForReview: await rr.submitCutForReview(J.id),
        addToEditorQueue: await editing.addToEditorQueue(D.id, "kim", "preview"),
      };
      const refused = Object.entries(results).filter(([, r]) => r.ok || !/previewing/i.test(r.message ?? ""));
      c.ok(`auth ${mode}: every one of ${Object.keys(results).length} writes is refused as a preview`, refused.length === 0, refused.map(([k2, r]) => `${k2}: ${r.ok} ${r.message}`).join(" | "));
      c.ok(`auth ${mode}: and nothing was written`, (await snapshot()) === before);
    }
    process.env.AUTH_ENFORCE = "true";

    // =========================================================================
    c.head("9 · A creative's reply is unanswered until the desk answers — any seat");
    // =========================================================================
    {
      const J = await mkJob("90 Thread Ave");
      const k = await mkCut(J, 1);
      viewer = V.kyle;
      await rr.addCutNote({ projectId: J.id, submissionId: k, body: "Which bedroom?", lane: "EDITOR", kind: "fix", timeSec: 2 });
      const root = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: J.id, parentId: null } });
      viewer = V.kim;
      advance(1);
      await rr.replyCutNote(root.id, "The second one?");
      const follow = async () => (await room.getReviewQueue()).followUps.find((f) => f.projectId === J.id && f.lane === "EDITOR")?.awaitingReply;
      c.ok("the editor spoke last → 1 unanswered", (await follow()) === 1);
      viewer = V.kyle;
      advance(1);
      await rr.replyCutNote(root.id, "Yes, the second.");
      c.ok("Kyle (an ADMIN by his roster key) answers → 0", (await follow()) === 0);
      // A review SEAT on a narrower login is the desk too; a photographer who
      // holds no seat is not.
      const { reviewDeskAuthorKeys } = await import("@/lib/actorName");
      await prisma.appUser.update({ where: { id: uJames.id }, data: { role: "PHOTOGRAPHER" } });
      const keys = await reviewDeskAuthorKeys();
      await prisma.appUser.update({ where: { id: uJames.id }, data: { role: "ADMIN" } });
      c.ok("James on a PHOTOGRAPHER login is still the desk (his seat); Harrison is not", keys.has(`tm:${james.id}`) && !keys.has(`tm:${harrison.id}`) && keys.has("owner") && keys.has(`tm:${kyle.id}`), [...keys].join(", "));
    }

    // =========================================================================
    c.head("10 · A cover is visible: who covered, and when");
    // =========================================================================
    {
      const J = await mkJob("100 Cover Blvd");
      const k = await mkCut(J, 1, { reviewerTeamMemberId: james.id, reviewerRole: "PRIMARY", reviewerAssignedAt: new Date() });
      advance(20);
      await approveAs(V.kyle, k);
      const ev = await prisma.cutReviewerEvent.findFirst({ where: { submissionId: k, reason: "COVER" } });
      const ws = await room.getCutWorkspace(J.id, k);
      const mv = ws?.submissions.find((s) => s.id === k)?.reviewerMove;
      c.ok("Kyle ruling on James's cut is recorded as a cover", !!ev && ev.actorName === "Kyle Cabrera", ev?.actorName);
      c.ok("…and the Room says \"Covered by Kyle Cabrera · <when>\" (gap 15)", !!mv && `${mv.words} by ${at.byLine(mv.by, mv.atISO)}` === `Covered by Kyle Cabrera · ${ET(ev!.at)}`, mv ? `${mv.words} by ${at.byLine(mv.by, mv.atISO)}` : "none");
      const lens = await room.getCutWorkspace(J.id, k, { kind: "photographer", memberId: harrison.id });
      c.ok("the photographer's lens carries no cover line (it is the desk's business)", lens?.submissions.every((s) => s.reviewerMove === null) === true);
    }

    // =========================================================================
    c.head("11 · The editor queue's Revisions row names who sent it back");
    // =========================================================================
    {
      const J = await mkJob("110 Queue St");
      const k = await mkCut(J, 1);
      viewer = V.james;
      await rr.addCutNote({ projectId: J.id, submissionId: k, body: "Cut the last shot", lane: "EDITOR", kind: "fix", timeSec: 30 });
      advance(3);
      viewer = V.kyle;
      await rr.requestCutChanges(k);
      const q = await buildEditorQueue();
      const row = [...q.notDone, ...q.upcoming].find((r) => r.id === J.id);
      c.ok("the row reads Revisions and, under the pill, \"Sent back by Kyle Cabrera · …\"", row?.status === "Revisions" && (row.videoBreakdown ?? "").startsWith("Sent back by Kyle Cabrera · Mon, Sep 28,"), `${row?.status} · ${row?.videoBreakdown}`);
      const other = [...q.notDone, ...q.upcoming].find((r) => r.status !== "Revisions" && (r.videoBreakdown ?? "").includes("Sent back by"));
      c.ok("…and only Revisions rows carry it", !other, other?.street);
    }

    // =========================================================================
    c.head("13 · The review's findings (Sep 28): the real callers, the office's reopen, threads, notes");
    // =========================================================================
    {
      // ---- 13a · finding 1: an assistant's text, call and email name HER ----
      // Through the SHIPPED receivers (OpenPhone webhook, Gmail scan), not a
      // hand-fed requestedBy: the fold assistant → agent happens in them.
      const agent = await prisma.client.create({ data: { name: "Mike Agent", phone: "(610) 555-0111", email: "mike@agent.invalid" }, select: { id: true } });
      await prisma.client.create({ data: { name: "Olivia Aide", phone: "(610) 555-0112", email: "olivia@aide.invalid", parentClientId: agent.id } });
      let agentSeq = 0;
      const agentJob = async (street: string) => {
        agentSeq++;
        const p = await prisma.project.create({
          data: { title: `${street}, Royersford, PA`, clientId: agent.id, status: "DELIVERED", addressLine: street, deliveredAt: new Date(Date.now() - 3 * 86_400_000), orderedAt: new Date(Date.now() - (10 - agentSeq) * 86_400_000) },
          select: { id: true },
        });
        await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 } });
        return p.id;
      };
      const briefOf = (projectId: string) => prisma.revisionBrief.findFirst({ where: { projectId, source: { not: "office" } }, orderBy: { createdAt: "desc" } });
      const revTaskOf = (projectId: string) => prisma.smartTask.findFirst({ where: { projectId, taskType: "revision" } });
      const { processOpenPhoneEvent } = await import("@/lib/webhooks/openphone");
      const LINE = "+12155550100";
      const text = (id: string, from: string, body: string) => processOpenPhoneEvent("message.received", { data: { object: { id, direction: "incoming", from, to: [LINE], text: body } } });

      // The call transcript receiver first: a call names no street, so it lands
      // on the agent's most relevant job — his only one, at this point.
      const quarry = await agentJob("13 Quarry Road");
      await processOpenPhoneEvent("call.transcript.completed", { data: { object: { callId: "CALL-B6-1", direction: "incoming", from: "+16105550112", to: LINE, dialogue: [
        { content: "Hi, it's Olivia. Can you please remove the drone clip from the reel for 13 Quarry Road?", identifier: "+16105550112" },
        { content: "Of course, we'll take care of it.", userId: "US-DRILL", identifier: LINE },
      ] } } });
      const b3 = await briefOf(quarry);
      c.ok("13a · her CALL: the brief names her, on a call — not the agent", b3?.requestedBy === "Olivia Aide" && b3.requestedByKind === "PHONE", `${b3?.requestedBy} · ${b3?.requestedByKind}`);

      const birch = await agentJob("11 Birchwood Lane");
      await text("MSG-B6-1", "+16105550112", "Please remove the drone clip from the reel for 11 Birchwood Lane");
      const b1 = await briefOf(birch);
      const t1 = await revTaskOf(birch);
      c.ok("13a · the assistant texts the line: the brief names HER, by text — not the agent her number folds to", b1?.requestedBy === "Olivia Aide" && b1.requestedByKind === "TEXT", `${b1?.requestedBy} · ${b1?.requestedByKind}`);
      c.ok("…the revision task's person is her, the timeline line and the bell lead with her", t1?.contactName === "Olivia Aide" &&
        !!(await prisma.activity.findFirst({ where: { projectId: birch, body: { startsWith: `${REVISION_FLAG_PREFIX}openphone, Olivia Aide): ` } } })) &&
        !!(await prisma.notification.findFirst({ where: { kind: "revision_raised", body: { startsWith: "Olivia Aide:" } } })), t1?.contactName ?? "none");
      c.ok("…and the Room's ask line reads \"Asked by Olivia Aide, by text\"", at.requesterLine({ requestedBy: b1?.requestedBy, requestedByKind: b1?.requestedByKind })?.startsWith("Asked by Olivia Aide, by text") === true);
      const fox = await agentJob("12 Foxhollow Drive");
      await text("MSG-B6-2", "+16105550111", "Please remove the drone clip from the reel for 12 Foxhollow Drive");
      const b2 = await briefOf(fox);
      c.ok("13a · the agent texts from his own number: him, and no separate person on the task", b2?.requestedBy === "Mike Agent" && b2.requestedByKind === "TEXT" && (await revTaskOf(fox))?.contactName === null, `${b2?.requestedBy} · ${b2?.requestedByKind}`);


      // The Gmail scan: one mailbox, fake Google.
      process.env.GOOGLE_CLIENT_ID = "drill-client";
      process.env.GOOGLE_CLIENT_SECRET = ["drill", "client", "secret"].join("-");
      const { saveSecret } = await import("@/lib/integrations/connections");
      await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": ["rt", "b6", "drill"].join("-") }));
      const tangle = await agentJob("14 Tanglewood Court");
      const mill = await agentJob("15 Millrace Way");
      // (i) the ALREADY-ANSWERED branch, from the assistant's bare address.
      GMAIL["gm-b6-1"] = { from: "olivia@aide.invalid", subject: "14 Tanglewood Court reel", body: "Can you please remove the drone clip from the reel?", thread: "th-b6-1", answered: true };
      // (ii) the unanswered branch, from the agent's own bare address (finding 3).
      GMAIL["gm-b6-2"] = { from: "<mike@agent.invalid>", subject: "15 Millrace Way reel", body: "Can you please remove the drone clip from the reel?", thread: "th-b6-2", answered: false };
      const { syncGmail } = await import("@/lib/integrations/google");
      const scan = await syncGmail().catch((e: unknown) => ({ error: String(e) }));
      const b4 = await briefOf(tangle);
      c.ok("13a · an email Kyle had ALREADY answered, from the assistant: her name (her own row's, before the fold), by email — not the agent's", b4?.requestedBy === "Olivia Aide" && b4.requestedByKind === "EMAIL", `${b4?.requestedBy} · ${b4?.requestedByKind} · ${JSON.stringify(scan).slice(0, 120)}`);
      const b5 = await briefOf(mill);
      const t5 = await revTaskOf(mill);
      c.ok("13c · finding 3: a bare From address is not a name — the client's own email reads as HIM, never \"sarah@…\"", b5?.requestedBy === "Mike Agent" && b5.requestedByKind === "EMAIL" && t5?.contactName === null, `${b5?.requestedBy} · task person ${t5?.contactName}`);
      c.ok("…no brief anywhere names a person by an email address", (await prisma.revisionBrief.count({ where: { requestedBy: { contains: "@" } } })) === 0);

      // ---- 13b · finding 2: the queue-add flags nobody; a later ask carries no stale flag ----
      const { getFlaggedForMe } = await import("@/lib/queries");
      const R = await mkJob("130 Reuse Rd", "DELIVERED");
      await mkCut(R, 1, { status: "APPROVED", decidedAt: new Date(Date.now() - 4 * 86_400_000), decidedBy: "James Rivera" });
      viewer = V.jordan;
      await editing.addToEditorQueue(R.id, "kim", "Swap the music");
      const q0 = await revTaskOf(R.id);
      const kyleHome = () => getFlaggedForMe({ memberId: kyle.id, role: "ADMIN" });
      const kimHome = () => getFlaggedForMe({ assignedKey: "kim", memberId: kim.id, role: "EDITOR" });
      c.ok("13b · Jordan's queue-add: nobody flagged, so neither Kyle's nor Kim's home says \"for immediate review\"", q0?.flaggedBy === null && (await kyleHome()).length === 0 && (await kimHome()).length === 0, `flaggedBy=${q0?.flaggedBy}`);
      c.ok("…it is still named — as the office's reopen, by Jordan", at.officeReopenOf(q0)?.by === "Jordan Spackman");
      // Kim delivers, the task completes; later the client emails a change.
      await prisma.smartTask.update({ where: { id: q0!.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      advance(5);
      await raiseRevision({ projectId: R.id, clientId: client.id, clientName: "Gary Mercer", note: "Can you brighten the video intro please", source: "gmail", requestedBy: { name: "Gary Mercer", kind: "EMAIL" } });
      const q1 = await revTaskOf(R.id);
      c.ok("…the client's ask reuses the row: open, the client's source, no flag, no longer the office's reopen", q1?.id === q0?.id && q1?.status === "OPEN" && q1.source === "gmail" && q1.flaggedBy === null && at.officeReopenOf(q1) === null, `${q1?.status} · ${q1?.source} · ${q1?.flaggedBy}`);
      c.ok("…Kyle's home shows nothing for it", !(await kyleHome()).some((f) => f.taskId === q1?.id));
      // A flag already on a row (any earlier writer) does not survive a re-raise either.
      await prisma.smartTask.update({ where: { id: q1!.id }, data: { status: "COMPLETED", completedAt: new Date(), flaggedBy: "Jordan Spackman", flaggedAt: new Date(Date.now() - 20 * 86_400_000) } });
      await raiseRevision({ projectId: R.id, note: "One more: the logo at the end", source: "openphone" });
      const q2 = await revTaskOf(R.id);
      c.ok("…a stale flag on a closed row is cleared when a new ask reopens it", q2?.status === "OPEN" && q2.flaggedBy === null && q2.flaggedAt === null && !(await kyleHome()).some((f) => f.taskId === q2.id));
      // The "Put back by <flaggedBy>" fallback is gone from every screen that
      // had it, so a nameless later ask cannot be put down to the office.
      const readsFlag = ["src/app/review/[id]/page.tsx", "src/lib/editorQueue.ts", "src/app/edit/[id]/page.tsx"].filter((f) => /\.flaggedBy\b|\bflaggedBy:/.test(fs.readFileSync(path.join(REPO, f), "utf8")));
      c.ok("…and no screen reads flaggedBy for \"who asked\" any more (the Room's banner, the editor queue, the edit page)", readsFlag.length === 0 && at.officeReopenOf(q2) === null, readsFlag.join(", ") || "none");

      // ---- 13c · finding 7: an office reopen is worded as the office's ----
      const O = await mkJob("131 Office Ln", "DELIVERED");
      await mkCut(O, 1, { status: "APPROVED", decidedAt: new Date(Date.now() - 4 * 86_400_000), decidedBy: "James Rivera" });
      viewer = V.kyle;
      await editing.addToEditorQueue(O.id, "kim", "Swap the music");
      const oTask = await revTaskOf(O.id);
      const pageSrc = fs.readFileSync(path.join(REPO, "src/app/review/[id]/page.tsx"), "utf8");
      const uploaderSrc = fs.readFileSync(path.join(REPO, "src/components/editing/CutUploader.tsx"), "utf8");
      const editSrc = fs.readFileSync(path.join(REPO, "src/app/edit/[id]/page.tsx"), "utf8");
      c.ok("13c · the Room's heading for an office reopen is the office's, not \"a client revision\"", !!at.officeReopenOf(oTask) && /The office reopened this job for a new cut/.test(pageSrc) && /officeReopen\s*\?/.test(pageSrc));
      c.ok("…the editor's pill says who reopened it (the edit page passes it), not \"client asked for changes\"", /reopened by \$\{firstName\(officeReopen\.by\) \?\? "the office"\}/.test(uploaderSrc) && /officeReopen=\{officeReopen\}/.test(editSrc) && at.firstName(at.officeReopenOf(oTask)?.by) === "Kyle");

      // ---- 13d · finding 4: a desk seat who SHOT the job is the creative on his own thread ----
      const S = await prisma.project.create({ data: { title: "132 Seat Shot Ave, Royersford, PA", clientId: client.id, status: "REVIEW", addressLine: "132 Seat Shot Ave", photographerId: james.id }, select: { id: true } });
      const sd = await prisma.deliverable.create({ data: { projectId: S.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
      const sc = await mkCut({ id: S.id, deliverableId: sd.id }, 1);
      viewer = V.kyle;
      await rr.addCutNote({ projectId: S.id, submissionId: sc, body: "The bathroom wide is soft", lane: "PHOTOGRAPHER", kind: "fix", timeSec: 6 });
      const sroot = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: S.id, parentId: null } });
      advance(1);
      viewer = V.james;
      await rr.replyCutNote(sroot.id, "Which bathroom do you mean?");
      const photoFollow = async (api: typeof room) => (await api.getReviewQueue()).followUps.find((f) => f.projectId === S.id && f.lane === "PHOTOGRAPHER")?.awaitingReply;
      c.ok(`13d · OLD (${BASE}): James (the photographer here) asking a question is unanswered`, (await photoFollow(old.room)) === 1);
      c.ok("NEW: still unanswered — the thread is ADDRESSED to James, so his reply is the creative's, seat or not", sroot.photographerId === james.id && (await photoFollow(room)) === 1, `awaitingReply=${await photoFollow(room)}`);
      advance(1);
      viewer = V.kyle;
      await rr.replyCutNote(sroot.id, "The one off the primary bedroom.");
      c.ok("…Kyle (another desk key) answers it → 0", (await photoFollow(room)) === 0);

      // ---- 13e · finding 5: the link's top-level note carries its visitor too ----
      const L = await contentWorld("Link Lane", "Lena Link");
      const lc = await L.cut(1);
      await approveAndPublish(V.james, lc);
      viewer = null;
      const portalActions = await import("@/app/portal/actions");
      const headers = Module.createRequire(__filename)("next/headers") as { cookies: () => Promise<{ get: (n: string) => { value: string } | undefined; delete: (n: string) => void }> };
      const jar = await headers.cookies();
      const auth = { token: L.f.portalToken };
      jar.delete("rtp_lv");
      const oldNote = await old.portalActions.portalAddComment(auth, lc, 3, "Old path: a timestamped note from the link");
      jar.delete("rtp_lv");
      const n1 = await portalActions.portalAddComment(auth, lc, 12, "Browser one: the intro is long");
      const r1 = await portalActions.portalAddComment(auth, lc, null, "Browser one again, replying", n1.id);
      jar.delete("rtp_lv");
      const n2 = await portalActions.portalAddComment(auth, lc, 20, "Browser two: the music is loud");
      const lnotes = (await cd.clientNotesForReviewRoom(L.f.projectId!)).flatMap((g) => g.notes);
      const byId = (id?: string) => lnotes.find((n) => n.id === id);
      const who1 = byId(n1.id)?.author;
      c.ok(`13e · OLD (${BASE}): a top-level note from the link carries no visitor tag`, oldNote.ok && byId(oldNote.id)?.author === `${L.f.clientName} (portal)`, byId(oldNote.id)?.author);
      c.ok("NEW: the link's timestamped note is tagged with its browser", n1.ok && /\(portal\), link visitor \d+$/.test(who1 ?? ""), who1);
      c.ok("…one browser keeps ONE label: its reply reads the same", byId(n1.id)?.replies.find((r) => r.id === r1.id)?.author === who1, byId(n1.id)?.replies.map((r) => r.author).join(" | "));
      c.ok("…and a second browser on the same link is a different visitor", !!byId(n2.id)?.author && byId(n2.id)?.author !== who1 && /link visitor \d+$/.test(byId(n2.id)!.author), byId(n2.id)?.author);

      // ---- 13f · finding 9: a SENT note resolved afterwards says so, with who ----
      const P9 = await contentWorld("Resolve Row", "Rhea Resolve");
      const pc9 = await P9.cut(1);
      await approveAndPublish(V.james, pc9);
      const note9 = await P9.note(pc9, "Brighten the kitchen", { clientUserId: P9.f.clientUserId }, 5);
      viewer = null;
      await cd.requestChangesOnCut(P9.owner, pc9, "");
      advance(2);
      await cd.setCommentResolved(P9.owner, note9.id, true);
      const n9 = (await cd.clientNotesForReviewRoom(P9.f.projectId!)).flatMap((g) => g.notes).find((n) => n.id === note9.id);
      c.ok("13f · a sent note the client then resolved: status stays SENT, and the Room now says who resolved it", n9?.status === "SENT" && at.clientNoteStatusWords(n9) === `sent to the editor · resolved by Rhea Resolve, ${ET(n9.resolvedAtISO!)}`, n9 ? at.clientNoteStatusWords(n9) : "none");
      c.ok("…an unresolved sent note still reads \"sent to the editor\"; a new one \"not sent yet\"", at.clientNoteStatusWords({ status: "SENT" }) === "sent to the editor" && at.clientNoteStatusWords({ status: "OPEN" }) === "not sent yet");

      // ---- 13g · finding 6: "Fixed" on /shoot stamps who and when ----
      const F = await mkJob("133 Shoot Fix Ln");
      const fc = await mkCut(F, 1);
      viewer = V.kyle;
      await rr.addCutNote({ projectId: F.id, submissionId: fc, body: "Hold the exterior longer", lane: "PHOTOGRAPHER", kind: "fix", timeSec: 2 });
      const froot = await prisma.mediaNote.findFirstOrThrow({ where: { projectId: F.id, parentId: null } });
      advance(1);
      await rr.setCutNoteStatus(froot.id, "OPEN"); // Kyle reopens it in the Room
      const kyleAt = (await prisma.mediaNote.findUniqueOrThrow({ where: { id: froot.id } })).statusAt!;
      advance(3);
      viewer = V.harrison;
      const oldFix = await old.projectReview.setMediaNoteStatus(froot.id, "FIXED");
      const afterOld = await prisma.mediaNote.findUniqueOrThrow({ where: { id: froot.id } });
      c.ok(`13g · OLD (${BASE}): Harrison's "Fixed" on /shoot leaves the Room naming Kyle, at Kyle's time`, oldFix.ok && at.statusLine(afterOld) === `Marked fixed by Kyle Cabrera · ${ET(kyleAt)}`, at.statusLine(afterOld) ?? "");
      await prisma.mediaNote.update({ where: { id: froot.id }, data: { status: "OPEN" } });
      advance(1);
      const { setMediaNoteStatus } = await import("@/app/projects/reviewActions");
      const newFix = await setMediaNoteStatus(froot.id, "FIXED");
      const afterNew = await prisma.mediaNote.findUniqueOrThrow({ where: { id: froot.id } });
      c.ok("NEW: \"Marked fixed by Harrison Wells · <his time>\"", newFix.ok && afterNew.statusBy === "Harrison Wells" && afterNew.statusAt!.getTime() > kyleAt.getTime() && at.statusLine(afterNew) === `Marked fixed by Harrison Wells · ${ET(afterNew.statusAt!)}`, at.statusLine(afterNew) ?? newFix.message);
      viewer = V.preview;
      const pv = await setMediaNoteStatus(froot.id, "OPEN");
      c.ok("…and a \"view as\" preview moves nothing in anyone's name", !pv.ok && /previewing/i.test(pv.message ?? "") && (await prisma.mediaNote.findUniqueOrThrow({ where: { id: froot.id } })).status === "FIXED");

      // ---- 13h · finding 8: dating reopened work does not make you its requester ----
      const { moveReopenedDue } = await import("@/lib/revisionBrief");
      const M8 = await prisma.project.create({ data: { title: "134 Due Date Way, Royersford, PA", clientId: client.id, status: "EDITING", deliveredAt: new Date(Date.now() - 5 * 86_400_000) }, select: { id: true } });
      const moved = await moveReopenedDue({ projectId: M8.id, dueAt: new Date(Date.now() + 86_400_000), by: "Kyle Cabrera" });
      const drow = await prisma.revisionBrief.findFirst({ where: { projectId: M8.id, source: "office" } });
      c.ok("13h · Kyle dates a reopen with no clock: the row records him as the dater, NOT as who put it back", moved.ok && drow?.dueSetBy === "Kyle Cabrera" && drow.requestedBy === null && drow.requestedByKind === null && at.requesterLine({ requestedBy: drow.requestedBy, requestedByKind: drow.requestedByKind, at: drow.createdAt }) === null, `${drow?.requestedBy} · ${drow?.requestedByKind} · dueSetBy ${drow?.dueSetBy}`);

      // ---- 13i · finding 10: the project page's "who asked" line ----
      // The card's own two reads (StatusEvidenceCard.statusContext's selects,
      // same where/order/take) fed to the pure reading it prints. The card is a
      // server component whose icons need React's client build, so the drill
      // cannot import it; the card itself asserts it calls this function.
      const cardSrc = fs.readFileSync(path.join(REPO, "src/components/project/StatusEvidenceCard.tsx"), "utf8");
      c.ok("13i · the project card prints revisionAskerLabel over its bounces and briefs (and reads the requester columns)", /revisionAskerLabel\(\{ askedAt, client: .*bounces: bounces \?\? \[\], briefs: briefs \?\? \[\] \}\)/.test(cardSrc) && /requestedBy: true, requestedByKind: true/.test(cardSrc) && /clientRequestedAt: true, clientRequestedBy: true/.test(cardSrc));
      const whoOn = async (projectId: string) => {
        const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { revisionRequestedAt: true, client: { select: { name: true } } } });
        const [bounces, briefs] = await Promise.all([
          prisma.reviewSubmission.findMany({ where: { projectId, status: "CHANGES_REQUESTED", withdrawnAt: null }, orderBy: { decidedAt: "desc" }, take: 5, select: { status: true, decidedAt: true, decidedBy: true, clientRequestedAt: true, clientRequestedBy: true } }),
          prisma.revisionBrief.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 10, select: { source: true, createdAt: true, requestedBy: true, requestedByKind: true } }),
        ]);
        return at.revisionAskerLabel({ askedAt: p.revisionRequestedAt, client: p.client?.name ?? null, bounces, briefs });
      };
      c.ok("13i · an assistant's email: \"Olivia Aide asked for changes by email\" (it printed the agent)", (await whoOn(tangle)) === "Olivia Aide asked for changes by email", await whoOn(tangle) ?? "none");
      c.ok("…her text: \"Olivia Aide asked for changes by text\"", (await whoOn(birch)) === "Olivia Aide asked for changes by text", await whoOn(birch) ?? "none");
      const P10 = await contentWorld("Card Client", "Cora Card");
      const p10 = await P10.cut(1);
      await approveAndPublish(V.james, p10);
      advance(30);
      await P10.note(p10, "Swap the song", { clientUserId: P10.f.clientUserId }, 4);
      viewer = null;
      await cd.requestChangesOnCut(P10.owner, p10, "");
      c.ok("…a client's portal send-back is the client's (it read \"Changes requested in the hub\")", (await whoOn(P10.f.projectId!)) === "Cora Card asked for changes on the portal", await whoOn(P10.f.projectId!) ?? "none");
      // A Review Room send-back on a reopened job: the office clock row lands
      // milliseconds after the verdict and used to win with "in the hub".
      const RB = await mkJob("135 Bounce Blvd", "EDITING");
      await prisma.project.update({ where: { id: RB.id }, data: { deliveredAt: new Date(Date.now() - 3 * 86_400_000) } }); // reopened work
      const rbc = await mkCut(RB, 2);
      viewer = V.james;
      await rr.addCutNote({ projectId: RB.id, submissionId: rbc, body: "Trim the last shot", lane: "EDITOR", kind: "fix", timeSec: 9 });
      advance(1);
      viewer = V.kyle;
      const rbBack = await rr.requestCutChanges(rbc);
      const rbClock = await prisma.revisionBrief.findFirst({ where: { projectId: RB.id, source: "office" } });
      c.ok("…a Review Room send-back on a reopened job (its office clock row written just after) names the sender, not \"in the hub\"", rbBack.ok && rbClock?.requestedByKind === "OFFICE" && (await whoOn(RB.id)) === "Kyle Cabrera asked for changes in the Review Room", `${await whoOn(RB.id) ?? "none"} · clock ${rbClock?.requestedByKind}`);

      // ---- 13j · finding 11: the queue pill's hand-close signs with the roster name ----
      const H = await mkJob("136 Hand Close Ct", "DELIVERED");
      await mkCut(H, 1, { status: "APPROVED", decidedAt: new Date(Date.now() - 5 * 86_400_000), decidedBy: "James Rivera" });
      const H0 = await mkJob("137 Hand Close Old Ct", "DELIVERED");
      await mkCut(H0, 1, { status: "APPROVED", decidedAt: new Date(Date.now() - 5 * 86_400_000), decidedBy: "James Rivera" });
      advance(2); // the ask comes AFTER the approved cut, so no cut answers it
      for (const j of [H, H0]) await raiseRevision({ projectId: j.id, clientId: client.id, clientName: "Gary Mercer", note: "Please swap the song on the reel", source: "gmail", requestedBy: { name: "Gary Mercer", kind: "EMAIL" } });
      viewer = V.kyle;
      // setQueueStatus reads the login through a DYNAMIC import of auth/user,
      // which the drill's module stub cannot reach (Node hands an imported
      // CommonJS module its own exports, not the loader's wrapper). So Kyle
      // signs in for real: a session cookie in the stubbed jar, verified by the
      // shipped getCurrentUser — his login has no name, his roster row does.
      const { signSession, SESSION_COOKIE } = await import("@/lib/auth/jwt");
      const sessionJar = (await (Module.createRequire(__filename)("next/headers") as { cookies: () => Promise<{ set: (n: string, v: string) => void; delete: (n: string) => void }> }).cookies());
      sessionJar.set(SESSION_COOKIE, await signSession({ uid: uKyle.id, email: "kyle@drill.invalid", role: "ADMIN", permissions: null }));
      const oldHc = await old.editing.setQueueStatus(H0.id, "Completed");
      const oldLine = await prisma.activity.findFirst({ where: { projectId: H0.id, body: { contains: "marked Completed on the queue" } } });
      c.ok(`13j · OLD (${BASE}): a nameless login signed the hand-close with its email`, /^kyle@drill\.invalid marked Completed/.test(oldLine?.body ?? ""), oldLine?.body?.slice(0, 60) ?? oldHc.message);
      const newHc = await editing.setQueueStatus(H.id, "Completed");
      const newLine = await prisma.activity.findFirst({ where: { projectId: H.id, body: { contains: "marked Completed on the queue" } } });
      const hTask = await revTaskOf(H.id);
      sessionJar.delete(SESSION_COOKIE);
      c.ok("NEW: \"Kyle Cabrera marked Completed on the queue\" — the roster name, on the timeline and the task", /^Kyle Cabrera marked Completed on the queue/.test(newLine?.body ?? "") && /Closed by the office \(Kyle Cabrera\)/.test(hTask?.summary ?? ""), newLine?.body?.slice(0, 60) ?? newHc.message);

      // ---- 13k · finding 12: one round, whoever retries it ----
      const K = await mkJob("138 Retry Row");
      const kc = await mkCut(K, 1);
      viewer = V.kyle;
      await rr.addCutNote({ projectId: K.id, submissionId: kc, body: "Music is too loud", lane: "EDITOR", kind: "fix", timeSec: 12 });
      await rr.addCutNote({ projectId: K.id, submissionId: kc, body: "Logo is soft", lane: "EDITOR", kind: "fix", timeSec: 40 });
      // Kyle's press loses its claim AFTER the round is on the card (a lost
      // race, or a crash between the two): the cut stays PENDING, notes open.
      const subs = prisma.reviewSubmission as unknown as { updateMany: (...a: unknown[]) => Promise<{ count: number }> };
      const realUpdateMany = subs.updateMany;
      let lost = 0;
      subs.updateMany = async (...a: unknown[]) => {
        const arg = a[0] as { where?: { id?: string } } | undefined;
        if (arg?.where?.id === kc && lost === 0) { lost++; return { count: 0 }; }
        return realUpdateMany.apply(prisma.reviewSubmission, a);
      };
      const kyleTry = await rr.requestCutChanges(kc);
      subs.updateMany = realUpdateMany;
      advance(2);
      viewer = V.james;
      const jamesTry = await rr.requestCutChanges(kc);
      const kcard = await prisma.smartTask.findFirst({ where: { dedupeKey: `edit-video-${K.id}` } });
      const blocks = ((kcard?.description ?? "").match(/^Round 2 — /gm) ?? []).length;
      c.ok("13k · Kyle's press lost its claim with the round already on the card (bare bullets: every note his)", lost === 1 && !kyleTry.ok && /• \[0:12\] Music is too loud$/m.test(kcard?.description ?? ""), kyleTry.message.slice(0, 80));
      c.ok("…James presses Send back: the same round is NOT appended again, though his bullets carry Kyle's name", jamesTry.ok && blocks === 1, `${blocks} "Round 2" block(s)`);
    }

    // =========================================================================
    c.head("12 · Guard rails");
    // =========================================================================
    {
      c.ok("the pure file's delivered stamp is reviewCuts.DELIVERED_STAMP", at.DELIVERED_VERDICT === DELIVERED_STAMP);
      c.ok("an editor's feedback stays scoped to their own key", (await room.getEditorFeedback(J2.id, "john")).length === 0);
      const lens = await room.getCutWorkspace(J2.id, c2, { kind: "photographer", memberId: harrison.id });
      c.ok("the photographer's lens still reads only their own lanes", !!lens && lens.notes.every((n) => n.ask || n.lane === "PHOTOGRAPHER") && lens.editorBrief === null);
      // Money stays off a creative's brief, with the requester still on it.
      const M = await mkJob("120 Money Rd", "DELIVERED");
      await raiseRevisionDetailed({ projectId: M.id, clientId: client.id, clientName: "Gary Mercer", note: "Please swap the song on the reel. We paid $50 for the extra round.", source: "gmail", requestedBy: { name: "Gary Mercer", kind: "EMAIL" } });
      const scrubbed = (await getRevisionBriefs(M.id, true))[0];
      c.ok("money is still scrubbed from a creative's copy of the brief — and the asker is still named", !!scrubbed && !/\$50/.test(scrubbed.originalText) && scrubbed.requestedBy === "Gary Mercer", scrubbed?.originalText);
      c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    }
  } finally {
    quiet.restore();
    c.summary();
    try { fs.unlinkSync(path.join(base.dir, "node_modules")); fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* harmless */ }
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
