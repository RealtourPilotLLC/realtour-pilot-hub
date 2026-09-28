// ---------------------------------------------------------------------------
// DRILL: NOTES ON A DELIVERED JOB CLOSE THEMSELVES (Jordan, Sep 28 2026: "for
// the editor stuff lets make sure we are up to date and anything completed and
// delivered can be closed out").
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/delivered-notes-close.ts
//
// A one-time clean-up closed 16 such notes in production that morning; this
// is the standing rule, run as a step of the REAL hourly cron (GET
// /api/cron/sync, bearer and all). The OLD code is pinned to ddce2d1 and
// loaded from git, its `@/` imports aimed at this tree:
//
//   0  OLD: the hourly route runs and every note is still open; it has no such
//      step. The follow-through rows carry no cut, and the page links every
//      row to /projects/<id>.
//   1  NEW, through the real hourly route: exactly the EDITOR/EDIT notes on a
//      Review Room cut whose own history answers them — a newer round of the
//      same cut (deliverable+slot, or the same file for a legacy folder row,
//      found by stream URL or by cut:<id>) or an approval after the note — on
//      a job delivered AFTER them, last moved before it, close: statusBy
//      "Closed out: job delivered", resolvedAt/statusAt now, one timeline line
//      per job. A FIXED note's own click after the newer round still closes.
//      LEFT ALONE: a photographer's note, a note written after delivery, a
//      reply, an already-resolved note, a reopened job, a delivered job with
//      no date, a note at the delivery instant — and (review, Sep 28) the
//      photos-first job's photo fixes written while the video was still owed,
//      a gallery note on listing video, a note on the approved cut written
//      after its approval but before the sweep noticed delivery, video 1's
//      post-approval note on a two-video job (video 2's newer round is not
//      video 1's), a legacy file's note answered only by ANOTHER file's round,
//      and a note the desk reopened after the final approval. A linked
//      revision issue is untouched (not VERIFIED, no event) and counted. The
//      CronRun row records the step.
//   2  A second run (the route again) does nothing.
//   2b A person's move after the close-out is kept (review, Sep 28): Jordan
//      reopens a closed-out note, an editor marks another fixed after the
//      delivery; the next hourly run leaves both, names intact, and writes no
//      second timeline line.
//   3  Compare-and-set: a note that moves (even one that ends back at OPEN),
//      or a job reopened, between the read and the write is left alone and
//      counted as raced; the next run leaves the editor's after-delivery
//      "fixed" for the owner's re-look.
//   4  "Feedback follow-through": each row opens the newest cut carrying its
//      notes (/review/<project>?cut=<id>) — a newer cut without them is not
//      it; a cut with no link is found by its cut:<id> key; photo notes fall
//      back to the project page — and that cut's workspace shows the notes.
//
// ISOLATION: PGlite on 127.0.0.1:5961 (DRILL_PORT overrides) through the
// shared harness; production is never opened; every non-loopback call is
// fenced (no provider, no Slack, no model). Nothing is sent. THE CLOCK IS
// PINNED to Mon Sep 28 2026 14:00 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { NextRequest as NextRequestT } from "next/server";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5961);
const BASE = "ddce2d1"; // the code before this change — pinned, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.parse("2026-09-28T18:00:00Z"); // Mon Sep 28 2026, 14:00 EDT
const offset = PINNED - RealDate.now();
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

/** OLD modules, byte for byte from BASE, their `@/` imports aimed at this tree. */
function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivered-notes-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const route = path.join(dir, "syncRoute.base.ts");
  fs.writeFileSync(route, point(show("src/app/api/cron/sync/route.ts")));
  const room = path.join(dir, "reviewRoom.base.ts");
  fs.writeFileSync(room, point(show("src/lib/reviewRoom.ts")));
  const page = show("src/app/review/page.tsx");
  return { dir, route, room, page };
}

async function main() {
  installNextStubs();
  const fence = fenceFetch();
  const c = makeChecker();
  const db = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { NextRequest } = await import("next/server");
  const base = writeBaseCopies();
  const day = (d: number, h = 16) => new Date(Date.UTC(2026, 8, d, h));
  const BY = "Closed out: job delivered";

  // ---- the fixture ---------------------------------------------------------
  // source MANUAL (the default) keeps the status sweep off these jobs, so the
  // statuses below are exactly the ones the rule reads.
  const client = await prisma.client.create({ data: { name: "Joe DRILL" }, select: { id: true } });
  const job = (title: string, status: string, deliveredAt: Date | null) =>
    prisma.project.create({ data: { title: `${title}, Drilltown, PA`, status: status as never, deliveredAt, clientId: client.id }, select: { id: true } }).then((p) => p.id);
  let cutN = 0;
  // A round. Rounds of the SAME cut share a deliverable+slot (uploaded rows)
  // or a file path (legacy folder rows) — reviewCuts.cutKeyOf.
  type CutOpts = { link?: boolean; decidedAt?: Date; deliverableId?: string; slot?: number; path?: string };
  const cut = async (projectId: string, round: number, status: string, createdAt: Date, opts: CutOpts = {}) => {
    cutN++;
    const s = await prisma.reviewSubmission.create({
      data: {
        projectId, kind: "video", round, status, source: opts.deliverableId ? "upload" : "folder", fileName: `cut-${cutN}.mp4`,
        assetPath: opts.path ?? `/final/cut-${cutN}.mp4`, deliverableId: opts.deliverableId ?? null, slot: opts.slot ?? 1,
        assetUrl: opts.link === false ? null : `/api/review/cut/drill-${cutN}/stream`,
        createdAt, decidedAt: status === "PENDING" ? null : (opts.decidedAt ?? new Date(createdAt.getTime() + 3600_000)), decidedBy: status === "PENDING" ? null : "Jordan Spackman",
      },
      select: { id: true, assetUrl: true },
    });
    return { id: s.id, asset: s.assetUrl ?? `cut:${s.id}` };
  };
  const video = (projectId: string, quantity = 1) => prisma.deliverable.create({ data: { projectId, type: "VIDEO", quantity }, select: { id: true } }).then((d) => d.id);
  const note = (projectId: string, asset: string, lane: string, status: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
    prisma.mediaNote.create({
      data: {
        projectId, assetUrl: asset, assetType: asset.startsWith("https://") ? "image" : "video", lane, kind: lane === "PHOTOGRAPHER" ? "coaching" : "fix",
        body: `${lane} note ${createdAt.toISOString().slice(5, 10)}`, status, authorKey: "owner", authorName: "Jordan Spackman", createdAt, ...extra,
      },
      select: { id: true },
    }).then((n) => n.id);

  // J1 · the 439 Lake George shape: one video, sent back Sep 5, round 2 up on
  // Sep 11 and approved Sep 13 18:00, delivered (as the sweep stamped it) Sep 14.
  const J1 = await job("439 Lake George DRILL", "DELIVERED", day(14));
  const d1 = await video(J1);
  const c1 = await cut(J1, 1, "CHANGES_REQUESTED", day(4), { deliverableId: d1 });
  const c2 = await cut(J1, 2, "APPROVED", day(11), { deliverableId: d1, decidedAt: day(13, 18) });
  const n1 = await note(J1, c1.asset, "EDITOR", "OPEN", day(5)); // round 2 came after it
  const n2 = await note(J1, c2.asset, "EDITOR", "FIXED", day(12), { statusBy: "Kim", statusAt: day(12, 20) }); // round 2 approved after it
  const n3 = await note(J1, c2.asset, "EDIT", "OPEN", day(13)); // Kyle's delivery fix, before the approval
  const n7 = await note(J1, c1.asset, "EDITOR", "OPEN", day(6)); // has a revision issue
  const n4 = await note(J1, c1.asset, "PHOTOGRAPHER", "OPEN", day(5)); // capture coaching
  const n5 = await note(J1, c2.asset, "EDITOR", "OPEN", day(20)); // written AFTER delivery
  const n6 = await note(J1, c1.asset, "EDITOR", "RESOLVED", day(5), { statusBy: "Jordan Spackman", statusAt: day(7), resolvedAt: day(7) });
  const r1 = await note(J1, c1.asset, "EDITOR", "OPEN", day(6), { parentId: n1, authorKey: "editor:kim", authorName: "Kim" }); // a reply
  // Sweep lag: on the APPROVED cut, after its approval, after the client had
  // it (the morning of the 14th) and before the sweep noticed (16:00).
  const n16 = await note(J1, c2.asset, "EDIT", "OPEN", day(14, 12));
  // Reopened by the desk AFTER the final approval, before delivery: "still owed".
  const n17 = await note(J1, c1.asset, "EDITOR", "OPEN", day(5, 18), { statusBy: "Jordan Spackman", statusAt: day(13, 20) });
  const issue = await prisma.revisionIssue.create({
    data: { projectId: J1, sourceKind: "REVIEW_NOTE", sourceId: n7, originalText: "Horizon tilts at 0:08", state: "OPEN", raisedOnSubmissionId: c1.id },
    select: { id: true },
  });
  // J2 · delivered Sep 14, then the client reopened it: REVISION again.
  const J2 = await job("Reopened DRILL", "REVISION", day(14));
  const c3 = await cut(J2, 1, "CHANGES_REQUESTED", day(9));
  const n8 = await note(J2, c3.asset, "EDITOR", "OPEN", day(10));
  // J3 · DELIVERED with no delivery date on file: nothing to say it came after.
  const J3 = await job("No Date DRILL", "DELIVERED", null);
  const c4 = await cut(J3, 1, "APPROVED", day(9), { decidedAt: day(11) });
  const n9 = await note(J3, c4.asset, "EDITOR", "OPEN", day(10));
  // J4 · photos: a photo fix is on no cut, so delivery proves nothing about
  // it — Kyle's photo fix stays for a person, like the photographer's coaching.
  const J4 = await job("Photo Fix DRILL", "DELIVERED", day(20));
  const n10 = await note(J4, "https://media.drill.invalid/p1.jpg", "EDIT", "OPEN", day(18));
  const n11 = await note(J4, "https://media.drill.invalid/p2.jpg", "PHOTOGRAPHER", "OPEN", day(18));
  // J5 · a note written at the very instant of delivery is not "before" it
  // (its cut was even approved after it — the instant alone keeps it open).
  const J5 = await job("Same Instant DRILL", "DELIVERED", day(21));
  const c5 = await cut(J5, 1, "APPROVED", day(20), { decidedAt: day(21, 17) });
  const n12 = await note(J5, c5.asset, "EDITOR", "OPEN", day(21));
  // J6 · live edit, three rounds: notes on r1 and r2, r3 (newest) has none.
  const J6 = await job("Live Edit DRILL", "EDITING", null);
  const c6a = await cut(J6, 1, "CHANGES_REQUESTED", day(15));
  const c6b = await cut(J6, 2, "CHANGES_REQUESTED", day(18));
  const c6c = await cut(J6, 3, "PENDING", day(24));
  const n13 = await note(J6, c6a.asset, "EDITOR", "OPEN", day(15, 18));
  const n14 = await note(J6, c6b.asset, "EDITOR", "FIXED", day(18, 18));
  // J7 · a cut with no playback link: its notes key on cut:<id>.
  const J7 = await job("No Link DRILL", "REVIEW", null);
  const c7 = await cut(J7, 1, "CHANGES_REQUESTED", day(22), { link: false });
  const n15 = await note(J7, c7.asset, "EDITOR", "OPEN", day(22, 18));
  // J10 · PHOTOS FIRST (review, Sep 28). The photos went live on Tue Sep 22
  // while the video was still owed, so the job sat in REVIEW; Jordan left 3
  // photo fixes for Kyle that afternoon (and one on the listing's video in
  // the gallery). The video landed Fri Sep 25 and the sweep stamped the job
  // DELIVERED then. The photo fixes were never made: they stay. The editor's
  // note on round 1 of the video, answered by round 2, closes.
  const J10 = await job("Photos First DRILL", "DELIVERED", day(25, 15));
  const d10 = await video(J10);
  const c10a = await cut(J10, 1, "CHANGES_REQUESTED", day(21), { deliverableId: d10 });
  await cut(J10, 2, "APPROVED", day(24), { deliverableId: d10, decidedAt: day(24, 18) });
  const p1 = await note(J10, "https://media.drill.invalid/j10-p1.jpg", "EDIT", "OPEN", day(22, 19));
  const p2 = await note(J10, "https://media.drill.invalid/j10-p2.jpg", "EDIT", "OPEN", day(22, 19));
  const p3 = await note(J10, "https://media.drill.invalid/j10-p3.jpg", "EDIT", "FIXED", day(22, 19), { statusBy: "Kyle", statusAt: day(23, 15) });
  const gv = await note(J10, "https://media.drill.invalid/j10-listing.mp4", "EDIT", "OPEN", day(22, 20), { assetType: "video", timeSec: 12 });
  const n18 = await note(J10, c10a.asset, "EDITOR", "OPEN", day(21, 18));
  // J11 · TWO VIDEOS (one deliverable, quantity 2). Video 1 approved Sep 16
  // and out to the client; video 2 sent back, round 2 up Sep 22, approved
  // Sep 22 18:00; the job DELIVERED Sep 24. A fix note on video 1 written
  // after ITS approval stays — video 2's later round is not video 1's.
  const J11 = await job("Two Videos DRILL", "DELIVERED", day(24));
  const d11 = await video(J11, 2);
  const c11a = await cut(J11, 1, "APPROVED", day(15), { deliverableId: d11, slot: 1, decidedAt: day(16) });
  const c11b = await cut(J11, 1, "CHANGES_REQUESTED", day(17), { deliverableId: d11, slot: 2 });
  await cut(J11, 2, "APPROVED", day(22), { deliverableId: d11, slot: 2, decidedAt: day(22, 18) });
  const n19 = await note(J11, c11a.asset, "EDIT", "OPEN", day(18));
  const n20 = await note(J11, c11b.asset, "EDITOR", "OPEN", day(17, 18));
  // Kim clicked "fixed" after round 2 was up (and approved): the click is not
  // the note's birth, so round 2 still answers it.
  const n21 = await note(J11, c11b.asset, "EDITOR", "FIXED", day(17, 19), { statusBy: "Kim", statusAt: day(22, 20) });
  // J12 · LEGACY FOLDER rows (no deliverable): rounds of a cut share a file
  // path. Round 1 has no link, so its note keys on cut:<id>. A second file,
  // approved before its note, is not answered by the first file's round 2.
  const J12 = await job("Legacy Folder DRILL", "DELIVERED", day(13));
  const LEGACY = "/AutoHDR/Legacy Folder DRILL/05-Final-Video/Finish.mp4";
  const c12a = await cut(J12, 1, "CHANGES_REQUESTED", day(10), { link: false, path: LEGACY });
  await cut(J12, 2, "APPROVED", day(12), { path: LEGACY, decidedAt: day(12, 20) });
  const c12c = await cut(J12, 1, "APPROVED", day(9), { path: "/AutoHDR/Legacy Folder DRILL/05-Final-Video/Vertical.mp4", decidedAt: day(9, 17) });
  const n22 = await note(J12, c12a.asset, "EDITOR", "OPEN", day(10, 18));
  const n23 = await note(J12, c12c.asset, "EDITOR", "OPEN", day(11));

  type NoteState = { status: string; statusBy: string | null; statusAt: Date | null; resolvedAt: Date | null };
  const noteRow = (id: string): Promise<NoteState> => prisma.mediaNote.findUniqueOrThrow({ where: { id }, select: { status: true, statusBy: true, statusAt: true, resolvedAt: true } });
  const states = async (ids: string[]) => Promise.all(ids.map(async (id) => (await noteRow(id)).status));
  const CLOSES = { n1, n2, n3, n7, n18, n20, n21, n22 } as Record<string, string>;
  const WILL_CLOSE = Object.values(CLOSES);
  const STAYS = { n4, n5, n8, n9, n10, n11, n12, n13, n14, n15, r1, n16, n17, p1, p2, p3, gv, n19, n23 } as Record<string, string>;
  const original = new Map<string, string>();
  for (const id of [...WILL_CLOSE, ...Object.values(STAYS), n6]) original.set(id, JSON.stringify(await noteRow(id)));
  const originalStatus = (id: string) => (JSON.parse(original.get(id)!) as NoteState).status;
  const closeLines = async () => prisma.activity.findMany({ where: { type: "SYSTEM", body: { startsWith: "Closed out:" } }, select: { projectId: true, body: true } });

  type Body = Record<string, unknown> & { ms?: Record<string, number>; skipped?: string[] };
  const runRoute = async (mod: { GET: (r: NextRequestT) => Promise<Response> }, label: string) => {
    const t0 = RealDate.now();
    const res = await mod.GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer drill-secret" } }) as NextRequestT);
    const body = (await res.json()) as Body;
    const errs = Object.keys(body).filter((k) => k.endsWith("Error"));
    console.log(`    ${label}: ${res.status} in ${((RealDate.now() - t0) / 1000).toFixed(1)}s · ${Object.keys(body.ms ?? {}).length} steps · errored ${errs.length}${errs.length ? ` (${errs.join(", ")})` : ""} · skipped ${(body.skipped ?? []).join(",") || "none"}`);
    return { status: res.status, body };
  };

  // =========================================================================
  c.head(`0 · OLD (${BASE}): the hourly route leaves every note open; rows link to the project`);
  // =========================================================================
  {
    const oldRoute = (await import(base.route)) as { GET: (r: NextRequestT) => Promise<Response> };
    const r = await runRoute(oldRoute, "old route");
    c.ok("OLD: the route ran (200) and has no step for delivered-job notes", r.status === 200 && !("deliveredNotes" in r.body) && !("deliveredNotes" in (r.body.ms ?? {})), Object.keys(r.body.ms ?? {}).length + " steps");
    const after = await states(WILL_CLOSE);
    c.ok(`OLD: the ${WILL_CLOSE.length} notes owed a close-out are all still open or fixed an hour later`, WILL_CLOSE.every((id, i) => after[i] === originalStatus(id)), after.join(","));
    c.ok("OLD: no close-out line on any timeline", (await closeLines()).length === 0);

    const oldRoom = (await import(base.room)) as typeof import("@/lib/reviewRoom");
    const oq = await oldRoom.getReviewQueue();
    const oRow = oq.followUps.find((f) => f.projectId === J1 && f.lane === "EDITOR");
    c.ok("OLD: 439 Lake George's editor row counts the delivered job's notes as owed (4 open, one post-delivery and one reopened, + 1 fixed)", !!oRow && oRow.open === 4 && oRow.awaitingReReview === 1, JSON.stringify(oRow && { open: oRow.open, fixed: oRow.awaitingReReview }));
    c.ok("OLD: the rows carry no cut to open", oq.followUps.every((f) => !("cutId" in f)));
    c.ok("OLD: the page links every row to /projects/<id>", base.page.includes("href={`/projects/${f.projectId}`}"));
  }

  // =========================================================================
  c.head("1 · NEW, through the real hourly route: exactly the right notes close");
  // =========================================================================
  const { GET } = await import("@/app/api/cron/sync/route");
  const route = { GET: GET as unknown as (r: NextRequestT) => Promise<Response> };
  const t1 = Date.now();
  {
    const r = await runRoute(route, "new route");
    const step = r.body.deliveredNotes as { matched?: number; closed?: number; raced?: number; jobs?: number; byLane?: { EDITOR: number; EDIT: number }; linkedIssuesLeft?: number } | undefined;
    c.ok("the route answered 200 and the deliveredNotes step ran without error", r.status === 200 && !!step && !("deliveredNotesError" in r.body), JSON.stringify(step ?? r.body.deliveredNotesError));
    c.ok("the step closed 8 notes on 4 jobs (EDITOR 7, EDIT 1), none raced", step?.matched === 8 && step.closed === 8 && step.jobs === 4 && step.raced === 0 && step.byLane?.EDITOR === 7 && step.byLane?.EDIT === 1, JSON.stringify(step));
    c.ok("…and counted the 1 linked revision issue it left alone", step?.linkedIssuesLeft === 1);
    const run = await prisma.cronRun.findFirst({ where: { job: "sync" }, orderBy: { startedAt: "desc" }, select: { summary: true, finishedAt: true } });
    const sum = JSON.parse(run?.summary ?? "{}") as Record<string, unknown>;
    console.log(`    CronRun summary: ${(run?.summary ?? "").length} chars${sum.truncated ? " (truncated envelope)" : ""}`);
    c.ok("the CronRun row records the step and its result", !!run?.finishedAt && "deliveredNotes" in ((sum.ms ?? {}) as object) && (sum.truncated === true || JSON.stringify(sum.deliveredNotes) === JSON.stringify(r.body.deliveredNotes)), String(JSON.stringify(sum.deliveredNotes ?? (sum.ms as Record<string, number>)?.deliveredNotes)).slice(0, 160));
  }
  {
    const got = Object.fromEntries(await Promise.all(Object.entries(CLOSES).map(async ([k, id]) => [k, await noteRow(id)] as const))) as Record<string, NoteState>;
    const closed = (...ks: string[]) => ks.every((k) => got[k].status === "RESOLVED");
    const near = (d: Date | null) => !!d && d.getTime() >= t1 - 1000 && d.getTime() <= Date.now() + 1000;
    c.ok("439 Lake George: the editor note on round 1 closes — round 2 came after it", closed("n1"));
    c.ok("439 Lake George: the editor note on round 2 (marked fixed by Kim) closes — round 2 was approved after it", closed("n2"));
    c.ok("439 Lake George: Kyle's delivery-fix note (EDIT) on round 2 closes — written before round 2's approval", closed("n3"));
    c.ok("439 Lake George: the note with a revision issue closes too", closed("n7"));
    c.ok("Photos First: the editor note on the video's round 1 closes — round 2 answered it", closed("n18"));
    c.ok("Two Videos: video 2's round-1 note closes — video 2's round 2 came after it", closed("n20"));
    c.ok("Two Videos: a FIXED note whose editor clicked after round 2 was up and approved still closes (the click is not its birth)", closed("n21"));
    c.ok("Legacy Folder: a note keyed cut:<id> on round 1 of a folder file closes — round 2 of the same file came after it", closed("n22"));
    const rows = Object.values(got);
    c.ok(`every one is signed "${BY}", resolvedAt = statusAt = now`, rows.every((x) => x.statusBy === BY && near(x.resolvedAt) && near(x.statusAt) && +x.resolvedAt! === +x.statusAt!), rows.map((x) => x.statusBy).join(" | "));
    const stay = await Promise.all(Object.entries(STAYS).map(async ([k, id]) => [k, await noteRow(id), original.get(id)!] as const));
    const moved = stay.filter(([, row, was]) => JSON.stringify(row) !== was);
    c.ok("LEFT ALONE, every field: the photographer's coaching (video + photo), the post-delivery note, the reopened job, the undated delivery, the delivery-instant note, both live jobs and the reply", moved.filter(([k]) => ["n4", "n5", "n8", "n9", "n11", "n12", "n13", "n14", "n15", "r1"].includes(k)).length === 0, moved.map(([k, row]) => `${k}=${row.status}/${row.statusBy}`).join(", ") || "all as they were");
    const stays = (...ks: string[]) => ks.every((k) => !moved.some(([m]) => m === k));
    c.ok("PHOTOS FIRST: the 3 photo fixes Jordan wrote on Tue while the video was still owed stay (open, open, fixed-by-Kyle) — the video landing Fri is not their delivery", stays("p1", "p2", "p3"), moved.filter(([k]) => ["p1", "p2", "p3"].includes(k)).map(([k, row]) => `${k}=${row.status}/${row.statusBy}`).join(", "));
    c.ok("…and the gallery note on the listing's video stays (Aryeo media is not a Review Room cut)", stays("gv"));
    c.ok("Photo Fix: Kyle's photo fix note stays — a photo carries no round to prove the fix", stays("n10"));
    c.ok("SWEEP LAG: the note on the approved cut, written after its approval and before the sweep noticed delivery, stays", stays("n16"));
    c.ok("REOPENED before delivery, after the final approval: nothing after the reopen answers it, it stays", stays("n17"));
    c.ok("TWO VIDEOS: video 1's fix note written after video 1's approval stays — video 2's newer round is not video 1's", stays("n19"));
    c.ok("LEGACY FOLDER: a note on a second file, answered only by the FIRST file's round 2, stays", stays("n23"));
    const r6 = await noteRow(n6);
    c.ok("the note Jordan had already resolved keeps his name and his time", r6.status === "RESOLVED" && r6.statusBy === "Jordan Spackman" && +r6.resolvedAt! === +day(7));
    const iss = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id }, select: { state: true, verifiedAt: true, verifiedBy: true } });
    c.ok("the linked revision issue is untouched: still OPEN, never VERIFIED (a delivery is not a checked fix)", iss.state === "OPEN" && !iss.verifiedAt && !iss.verifiedBy, JSON.stringify(iss));
    c.ok("…and no issue event was written", (await prisma.revisionIssueEvent.count()) === 0);
    const lines = await closeLines();
    const byJob = new Map(lines.map((l) => [l.projectId, l.body]));
    c.ok("ONE timeline line per job, only on the four jobs that closed notes (none on Photo Fix)", lines.length === 4 && [J1, J10, J11, J12].every((j) => byJob.has(j)) && !byJob.has(J4), lines.length + " lines");
    c.ok("439 Lake George's line, in the clean-up's words", byJob.get(J1) === "Closed out: the job was delivered on Sep 14, so 4 editor and delivery-fix notes that were still open or awaiting a re-look were marked resolved.", byJob.get(J1));
    c.ok("Photos First's line (one note, singular) counts only the video note", byJob.get(J10) === "Closed out: the job was delivered on Sep 25, so 1 editor note that was still open or awaiting a re-look was marked resolved.", byJob.get(J10));
    c.ok("Two Videos' line (two editor notes)", byJob.get(J11) === "Closed out: the job was delivered on Sep 24, so 2 editor notes that were still open or awaiting a re-look were marked resolved.", byJob.get(J11));
  }

  // =========================================================================
  c.head("2 · a second run does nothing");
  // =========================================================================
  {
    const before = await prisma.mediaNote.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, statusBy: true, statusAt: true, resolvedAt: true } });
    const linesBefore = await prisma.activity.count();
    const r = await runRoute(route, "new route, again");
    const step = r.body.deliveredNotes as { matched?: number; closed?: number; jobs?: number } | undefined;
    c.ok("the step matched and closed nothing", r.status === 200 && step?.matched === 0 && step.closed === 0 && step.jobs === 0, JSON.stringify(step));
    const after = await prisma.mediaNote.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, statusBy: true, statusAt: true, resolvedAt: true } });
    c.ok("every note row is byte-for-byte what it was", JSON.stringify(after) === JSON.stringify(before));
    c.ok("no timeline line was added", (await prisma.activity.count()) === linesBefore && (await closeLines()).length === 4);
  }

  // =========================================================================
  c.head("2b · a person's move after the close-out is kept (review, Sep 28)");
  // =========================================================================
  {
    // Sep 29-ish, as the Room's own toggle writes it (setCutNoteStatus):
    // Jordan disagrees with n1's close-out and reopens it; he reopens n7 too
    // and Kim marks it fixed — a fix made after the client had the cut.
    const at = new Date();
    await prisma.mediaNote.update({ where: { id: n1 }, data: { status: "OPEN", statusBy: "Jordan Spackman", statusAt: at, resolvedAt: null } });
    await prisma.mediaNote.update({ where: { id: n7 }, data: { status: "FIXED", statusBy: "Kim", statusAt: new Date(at.getTime() + 1000), resolvedAt: null } });
    const linesBefore = await closeLines();
    const r = await runRoute(route, "new route, after the hand moves");
    const step = r.body.deliveredNotes as { matched?: number; closed?: number } | undefined;
    c.ok("the next hourly run matches and closes nothing", r.status === 200 && step?.matched === 0 && step.closed === 0, JSON.stringify(step));
    const a = await noteRow(n1);
    c.ok("Jordan's reopen stands: OPEN, his name, his time, no resolvedAt", a.status === "OPEN" && a.statusBy === "Jordan Spackman" && +a.statusAt! === +at && a.resolvedAt === null, `${a.status}/${a.statusBy}`);
    const b = await noteRow(n7);
    c.ok("the editor's after-delivery 'fixed' stands for the owner's re-look: FIXED, Kim's name", b.status === "FIXED" && b.statusBy === "Kim", `${b.status}/${b.statusBy}`);
    const lines = await closeLines();
    c.ok("no second timeline line on 439 Lake George", lines.length === linesBefore.length && lines.filter((l) => l.projectId === J1).length === 1);
  }

  // =========================================================================
  c.head("3 · compare-and-set: what moves under the step is left alone");
  // =========================================================================
  {
    const { closeDeliveredJobNotes } = await import("@/lib/deliveredNotes");
    const J8 = await job("Race Moved DRILL", "DELIVERED", day(24));
    const c8 = await cut(J8, 1, "APPROVED", day(22), { decidedAt: day(23, 12) });
    const moved = await note(J8, c8.asset, "EDITOR", "OPEN", day(22, 18));
    const still = await note(J8, c8.asset, "EDITOR", "OPEN", day(22, 19));
    const touched = await note(J8, c8.asset, "EDITOR", "OPEN", day(22, 20));
    const J9 = await job("Race Reopen DRILL", "DELIVERED", day(24));
    const c9 = await cut(J9, 1, "APPROVED", day(22), { decidedAt: day(23, 18) });
    const reopenedNote = await note(J9, c9.asset, "EDIT", "OPEN", day(23));
    // Between the step's read and its writes: the editor marks one note fixed;
    // another is marked fixed and reopened straight back (OPEN again, but a
    // person has moved it); and the client reopens the other job.
    const p = prisma as unknown as { $queryRaw: (...a: unknown[]) => Promise<unknown> };
    const realRaw = p.$queryRaw;
    let fired = 0;
    p.$queryRaw = async (...a: unknown[]) => {
      const rows = await realRaw.apply(prisma, a);
      if (!fired++) {
        await prisma.mediaNote.update({ where: { id: moved }, data: { status: "FIXED", statusBy: "Kim", statusAt: new Date() } });
        await prisma.mediaNote.update({ where: { id: touched }, data: { status: "FIXED", statusBy: "Kim", statusAt: new Date() } });
        await prisma.mediaNote.update({ where: { id: touched }, data: { status: "OPEN", statusBy: "Jordan Spackman", statusAt: new Date(), resolvedAt: null } });
        await prisma.project.update({ where: { id: J9 }, data: { status: "REVISION" } });
      }
      return rows;
    };
    let r: Awaited<ReturnType<typeof closeDeliveredJobNotes>>;
    try { r = await closeDeliveredJobNotes(); } finally { p.$queryRaw = realRaw; }
    c.ok("the hook fired between the read and the writes", fired === 1);
    c.ok("read 4, closed 1, raced 3", r.matched === 4 && r.closed === 1 && r.raced === 3 && r.jobs === 1, JSON.stringify(r));
    const m = await noteRow(moved);
    c.ok("the note the editor marked fixed in between keeps HIS move", m.status === "FIXED" && m.statusBy === "Kim");
    const t = await noteRow(touched);
    c.ok("the note moved and put back to OPEN in between keeps the person's move (compare-and-set on statusAt)", t.status === "OPEN" && t.statusBy === "Jordan Spackman", `${t.status}/${t.statusBy}`);
    c.ok("the reopened job's note stays open", (await noteRow(reopenedNote)).status === "OPEN");
    c.ok("the untouched note on the delivered job closed", (await noteRow(still)).status === "RESOLVED");
    const l8 = await prisma.activity.findMany({ where: { projectId: J8, type: "SYSTEM" }, select: { body: true } });
    c.ok("the delivered job's line counts only the note that closed", l8.length === 1 && /so 1 editor note that was/.test(l8[0].body), l8.map((x) => x.body).join(" | "));
    c.ok("the reopened job got no line", (await prisma.activity.count({ where: { projectId: J9 } })) === 0);
    const again = await closeDeliveredJobNotes();
    c.ok("the next run closes nothing: the editor's 'fixed' came after the delivery, so it waits for the owner's re-look; the reopen stands",
      again.matched === 0 && again.closed === 0 && (await noteRow(moved)).status === "FIXED" && (await noteRow(touched)).status === "OPEN" && (await noteRow(reopenedNote)).status === "OPEN", JSON.stringify(again));
  }

  // =========================================================================
  c.head("4 · Feedback follow-through: each row opens the cut with its notes");
  // =========================================================================
  {
    const room = await import("@/lib/reviewRoom");
    const q = await room.getReviewQueue();
    const row = (pid: string, lane: string) => q.followUps.find((f) => f.projectId === pid && f.lane === lane);
    const j1e = row(J1, "EDITOR");
    c.ok("439 Lake George's editor row now counts only what a person still owes: the post-delivery note, the one reopened before delivery, Jordan's reopen (open) and Kim's after-delivery fix (fixed)", !!j1e && j1e.open === 3 && j1e.awaitingReReview === 1, JSON.stringify(j1e && { open: j1e.open, fixed: j1e.awaitingReReview }));
    c.ok("…and opens the newest cut those notes are on (round 2)", j1e?.cutId === c2.id && room.followUpHref(j1e) === `/review/${J1}?cut=${c2.id}`, j1e && room.followUpHref(j1e));
    const j1p = row(J1, "PHOTOGRAPHER");
    c.ok("the photographer's coaching on round 1 opens round 1", j1p?.cutId === c1.id && room.followUpHref(j1p) === `/review/${J1}?cut=${c1.id}`, j1p && room.followUpHref(j1p));
    const j6 = row(J6, "EDITOR");
    c.ok("Live Edit: the newest cut CARRYING the notes (round 2), not the newer round 3 with none", j6?.cutId === c6b.id && j6.cutId !== c6c.id && j6.cutId !== c6a.id, j6 && room.followUpHref(j6));
    const j7 = row(J7, "EDITOR");
    c.ok("No Link: a cut with no playback link is found by its cut:<id> key", j7?.cutId === c7.id, j7 && room.followUpHref(j7));
    const j2 = row(J2, "EDITOR");
    c.ok("the reopened job's row opens its cut", j2?.cutId === c3.id);
    const j4 = row(J4, "PHOTOGRAPHER");
    c.ok("photo notes (no cut) fall back to the project page", !!j4 && j4.cutId === null && room.followUpHref(j4) === `/projects/${J4}`, j4 && room.followUpHref(j4));
    const j4e = row(J4, "EDIT");
    c.ok("Photo Fix's EDIT row is still there (a photo fix is a person's call) and opens the project page", !!j4e && j4e.open === 1 && j4e.cutId === null && room.followUpHref(j4e) === `/projects/${J4}`, j4e && room.followUpHref(j4e));
    const j10e = row(J10, "EDIT");
    c.ok("Photos First's EDIT row still owes the photo fixes (3 open incl. the gallery video note, 1 fixed)", !!j10e && j10e.open === 3 && j10e.awaitingReReview === 1 && j10e.cutId === null, JSON.stringify(j10e && { open: j10e.open, fixed: j10e.awaitingReReview }));
    c.ok("a lane with nothing open has no row (Photos First's closed editor note)", !row(J10, "EDITOR"));
    const ws = await room.getCutWorkspace(J6, j6?.cutId ?? null);
    c.ok("the workspace that link opens is that cut, with its note on it", ws?.active?.id === c6b.id && ws.notes.some((n) => n.id === n14), `${ws?.active?.id === c6b.id ? "cut ok" : "wrong cut"} · ${ws?.notes.length ?? 0} notes`);
    const pageSrc = fs.readFileSync(path.join(REPO, "src/app/review/page.tsx"), "utf8");
    c.ok("the page renders each row's href from followUpHref (the /projects/<id> literal is gone)", /href=\{followUpHref\(f\)\}/.test(pageSrc) && !pageSrc.includes("href={`/projects/${f.projectId}`}"));
  }

  // =========================================================================
  c.head("5 · FENCE");
  // =========================================================================
  c.ok("nothing was sent: no text left the queue", (await prisma.pendingSms.count({ where: { sentAt: { not: null } } })) === 0);
  console.log(`    (other cron steps reached for ${fence.blocked.length} provider calls, all blocked at the fence)`);

  c.summary();
  quiet.restore();
  fence.restore();
  try { fs.unlinkSync(path.join(base.dir, "node_modules")); fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  await db.stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
