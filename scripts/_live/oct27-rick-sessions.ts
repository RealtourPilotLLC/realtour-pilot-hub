// ---------------------------------------------------------------------------
// Oct 27 2026 — Rick Schultz's 48-video plan, regrouped at Jordan's ask:
//   "In the first session, we got 31 videos done. All were shot in order,
//    except for video 31 - that's going into today's session. Can you please
//    organize the Dropbox folder names? Also, the editor brief should include
//    31 videos to edit, and the next session (today's) should include the
//    remaining videos to edit. We are finishing filming today."
//
// Session 1 (Oct 20, 1671 N Providence Rd) = videos 1-30 and 32 (31 videos).
// Session 2 (today, Oct 27)                = video 31 and 33-48 (17 videos).
//
// What it does (a dry run without --apply: reads and Dropbox listings only):
//   1. plan places: 9-30 and 32 to session 1; 31 and 33-48 to session 2;
//      the plan is 2 sessions (Nov 3/10/17/24 were never booked).
//   2. James's on-site note "Videos #9-30, #32 filmed as well" stood for those
//      23 videos: its video is archived, its selection removed, its topic
//      archived and the editor slot it held (Video 9) freed. His note is kept
//      on the archived video.
//   3. session 1 records 31 filmed videos: the 23 are confirmed filmed there
//      (dated by the Oct 20 appointment) and bound to editor slots 9-31.
//   4. Dropbox, session 1: James's folders "video 9" ... "video 32" are
//      renamed to the plan names ("09 Check Around First [tag]"); the empty
//      "09 Videos #9-30, #32 filmed as well" folder goes.
//   5. Dropbox, today's session: the 16 empty folders made for videos 1-16
//      go (only if still empty); the 17 for today's videos are made, numbered
//      by the plan ("31 Start With This Call, Not a Listing [tag]").
//   6. the "filmed beyond the plan" review task is closed with the reason.
// Nothing is sent to anyone. No script is touched.
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const PLAN_ID = "cmva9fo3800009kqgdhda0ds1";
const MONTH_ID = "cmup0bq3r00qejg049llw9vti";
const S1 = "cmv88mh2500h0if067baesczl";
const S2 = "cmv88p3zk00xyif06tr30vscr";
const EXTRA = {
  video: "cmvhaz8hd000el0078dxkeupw",
  topic: "cmvhaz8ai0002l007i1sx1yrw",
  selection: "cmvhaz8cl0004l0077hlxufkf",
  output: "cmvhaz8lg000xl007e7f9xywc",
  task: "cmvhaz9f6000zl007c5rgte25",
};
const S1_RANKS = [...Array.from({ length: 30 }, (_, i) => i + 1), 32];
const S2_RANKS = [31, ...Array.from({ length: 16 }, (_, i) => i + 33)];
const MOVED_TO_S1 = S1_RANKS.filter((r) => r >= 9);
const WHO = { name: "Jordan Spackman", email: "info@realtourpilot.com" };
const WHY = "Jordan, Oct 27 2026: session 1 filmed videos 1-30 and 32; video 31 and 33-48 are today's session";

async function main() {
  const prisma = await db();
  const { dropboxListFolder, dropboxMoveFolder, dropboxDelete } = await import("../../src/lib/integrations/dropbox");
  const { actualFolderPaths, topicFolderName, topicFolderTag, ensureTopicFolders } = await import("../../src/lib/dropboxFolders");
  const { recordTopicEvent } = await import("../../src/lib/contentTopics");
  const { confirmFilmedTopics } = await import("../../src/lib/filmedTopics");
  const { bindTopicVideosToSlots, filmingBriefFor } = await import("../../src/lib/deliverableOutputs");
  const { updateBulkPlan, bulkBoardForMonth } = await import("../../src/lib/bulkPlan");

  // ---- read everything first -------------------------------------------------
  const sels = await prisma.contentTopicSelection.findMany({
    where: { monthId: MONTH_ID, status: { in: ["SELECTED", "RECONCILED", "CARRIED"] } },
    select: { id: true, topicId: true, rank: true, sessionNo: true },
  });
  const byRank = new Map(sels.filter((s) => s.rank != null && s.rank <= 48).map((s) => [s.rank as number, s]));
  for (let r = 1; r <= 48; r++) if (!byRank.has(r)) throw new Error(`plan number ${r} is not on the plan`);
  const titles = new Map((await prisma.contentTopic.findMany({ where: { id: { in: sels.map((s) => s.topicId) } }, select: { id: true, title: true } })).map((t) => [t.id, t.title]));
  const extraSel = sels.find((s) => s.id === EXTRA.selection);
  console.log(`plan: 48 numbered scripts; the note selection is ${extraSel ? `live (rank ${extraSel.rank})` : "already gone"}`);

  const confirmedElsewhere = await prisma.contentVideo.findMany({
    where: { monthId: MONTH_ID, topicId: { in: [...byRank.values()].map((s) => s.topicId) }, filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" } },
    select: { topicId: true, projectId: true },
  });
  const filmedAt = new Map(confirmedElsewhere.map((v) => [v.topicId, v.projectId]));
  for (const r of S2_RANKS) if (filmedAt.has(byRank.get(r)!.topicId)) throw new Error(`video ${r} is already recorded filmed — it can't be planned for today`);
  for (const r of MOVED_TO_S1) {
    const at = filmedAt.get(byRank.get(r)!.topicId);
    if (at && at !== S1) throw new Error(`video ${r} is recorded filmed at another shoot (${at})`);
  }

  const projects = await prisma.project.findMany({
    where: { id: { in: [S1, S2] } },
    select: { id: true, title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, videosFilmed: true, client: { select: { name: true } } },
  });
  const p1 = projects.find((p) => p.id === S1)!, p2 = projects.find((p) => p.id === S2)!;
  const raw1 = actualFolderPaths(p1).rawVideo, raw2 = actualFolderPaths(p2).rawVideo;

  // Dropbox, session 1: James's "video N" folders.
  const tree1 = await dropboxListFolder(raw1, { recursive: true });
  const kids1 = tree1.filter((e) => e.tag === "folder" && e.path.slice(0, e.path.lastIndexOf("/")).toLowerCase() === raw1.toLowerCase());
  const filesUnder = (tree: typeof tree1, dir: string) => tree.filter((e) => e.tag === "file" && e.path.toLowerCase().startsWith(`${dir.toLowerCase()}/`)).length;
  const renames: { from: string; to: string; rank: number; files: number }[] = [];
  for (const r of MOVED_TO_S1) {
    const sel = byRank.get(r)!;
    const want = topicFolderName(r, titles.get(sel.topicId) ?? `Video ${r}`, sel.topicId);
    const tagged = kids1.find((k) => k.name.toLowerCase().endsWith(topicFolderTag(sel.topicId).toLowerCase()));
    if (tagged) { console.log(`  s1 folder for ${r} already named: ${tagged.name}`); continue; }
    const hand = kids1.filter((k) => k.name.trim().toLowerCase() === `video ${r}`);
    if (hand.length !== 1) throw new Error(`session 1 has ${hand.length} folders named "video ${r}" — not guessing`);
    renames.push({ from: hand[0].path, to: `${raw1}/${want}`, rank: r, files: filesUnder(tree1, hand[0].path) });
  }
  if (kids1.some((k) => k.name.trim().toLowerCase() === "video 31")) throw new Error(`session 1 has a "video 31" folder — Jordan said 31 was not filmed there`);
  const noteFolder = kids1.find((k) => k.name.toLowerCase().endsWith(topicFolderTag(EXTRA.topic).toLowerCase()));
  const noteFolderFiles = noteFolder ? filesUnder(tree1, noteFolder.path) : 0;
  console.log(`\nsession 1 Dropbox (${raw1}):`);
  for (const x of renames) console.log(`  rename  ${x.from.slice(raw1.length + 1)}  ->  ${x.to.slice(raw1.length + 1)}   (${x.files} clips)`);
  console.log(noteFolder ? `  remove  ${noteFolder.name}  (${noteFolderFiles} files${noteFolderFiles ? " — KEPT, it is not empty" : ""})` : "  the note's folder is already gone");

  // Dropbox, session 2: what is there today.
  const tree2 = await dropboxListFolder(raw2, { recursive: true });
  const kids2 = tree2.filter((e) => e.tag === "folder" && e.path.slice(0, e.path.lastIndexOf("/")).toLowerCase() === raw2.toLowerCase());
  const todayTags = new Set(S2_RANKS.map((r) => topicFolderTag(byRank.get(r)!.topicId).toLowerCase()));
  const stale2 = kids2.filter((k) => ![...todayTags].some((t) => k.name.toLowerCase().endsWith(t)));
  const files2 = tree2.filter((e) => e.tag === "file").length;
  console.log(`\ntoday's Dropbox (${raw2}): ${kids2.length} folders, ${files2} files`);
  for (const k of stale2) console.log(`  remove  ${k.name}  (${filesUnder(tree2, k.path)} files)`);
  for (const r of S2_RANKS) {
    const sel = byRank.get(r)!;
    console.log(`  make    ${topicFolderName(r, titles.get(sel.topicId) ?? `Video ${r}`, sel.topicId)}`);
  }

  console.log(`\nsession 1 videos owed: ${p1.videosFilmed} -> 31; today's: set when James submits (17 planned)`);
  const moves = [...S1_RANKS.map((r) => [r, 1] as const), ...S2_RANKS.map((r) => [r, 2] as const)].filter(([r, n]) => byRank.get(r)!.sessionNo !== n);
  console.log(`plan places to change: ${moves.length} (${moves.map(([r, n]) => `${r}->s${n}`).join(", ")})`);

  if (!APPLY) {
    console.log("\ndry run: nothing written. Re-run with --apply.");
    return;
  }

  // ---- 1. plan places --------------------------------------------------------
  const actor = { kind: "STAFF" as const, staffUserId: WHO.email };
  for (const [r, n] of moves) {
    const sel = byRank.get(r)!;
    await prisma.contentTopicSelection.update({ where: { id: sel.id }, data: { sessionNo: n } });
    await recordTopicEvent(sel.topicId, (await prisma.contentBulkPlan.findUniqueOrThrow({ where: { id: PLAN_ID }, select: { enrollmentId: true } })).enrollmentId, "CARRIED", actor, {
      monthId: MONTH_ID,
      note: `Bulk plan: moved from session ${sel.sessionNo ?? "none"} to session ${n}. ${WHY}.`,
    }).catch(() => {});
  }
  await updateBulkPlan(PLAN_ID, { sessionsPlanned: 2 }, { email: WHO.email, name: WHO.name } as never);
  console.log(`1. plan: ${moves.length} places changed; 2 sessions`);

  // ---- 2. the note stood for 23 videos ----------------------------------------
  const plan = await prisma.contentBulkPlan.findUniqueOrThrow({ where: { id: PLAN_ID }, select: { enrollmentId: true } });
  const now = new Date();
  const ev = await prisma.contentVideo.findUnique({ where: { id: EXTRA.video }, select: { status: true, notes: true, currentSubmissionId: true } });
  if (ev?.currentSubmissionId) throw new Error("the note's video has a cut on it — stopping before touching it");
  const jamesNote = "We did skip #31 for this session, so will need to remember that it's #31 and then #33-48 for the next session.";
  if (ev && ev.status !== "ARCHIVED") {
    await prisma.contentVideo.update({
      where: { id: EXTRA.video },
      data: {
        status: "ARCHIVED",
        outputId: null,
        slot: null,
        notes: `Archived Oct 27 2026: James's on-site note "Videos #9-30, #32 filmed as well" stood for plan videos 9-30 and 32, each now recorded as its own video. His note: ${jamesNote}`,
      },
    });
  }
  await prisma.contentTopicSelection.updateMany({
    where: { id: EXTRA.selection, status: { not: "REMOVED" } },
    data: { status: "REMOVED", rank: null, sessionNo: null, removedAt: now, removedBy: WHO.email, removedReason: "FOLDED_INTO_PLAN: the on-site note stood for plan videos 9-30 and 32" },
  });
  await prisma.contentTopic.updateMany({
    where: { id: EXTRA.topic, status: { not: "ARCHIVED" } },
    data: { status: "ARCHIVED", archiveReason: "An on-site note, not a video: it stood for plan videos 9-30 and 32 (Oct 27 2026)" },
  });
  await recordTopicEvent(EXTRA.topic, plan.enrollmentId, "ARCHIVED", actor, { monthId: MONTH_ID, note: `${WHY}. The note's 23 videos are recorded one by one.` }).catch(() => {});
  await prisma.deliverableOutput.updateMany({ where: { id: EXTRA.output, topicId: EXTRA.topic }, data: { topicId: null, filmingNote: null } });
  console.log("2. the note: video archived, selection removed, topic archived, Video 9 slot freed");

  // ---- 3. session 1 = 31 filmed videos ------------------------------------------
  await prisma.project.update({ where: { id: S1 }, data: { videosFilmed: 31 } });
  const report = await prisma.contentFilmingReport.findFirst({ where: { projectId: S1, state: "APPLIED" }, orderBy: { createdAt: "asc" }, select: { appointmentId: true } });
  const confirm = await confirmFilmedTopics(S1, MOVED_TO_S1.map((r) => byRank.get(r)!.topicId), WHO.name, {
    byEmail: WHO.email,
    appointmentId: report?.appointmentId ?? null,
  });
  console.log(`3. confirmed filmed at session 1: ${confirm.confirmed} new, ${confirm.alreadyConfirmed} already; ignored ${confirm.ignored.length}; filmed ${confirm.filmedAtISO}${confirm.dateUnverified ? " (DATE UNVERIFIED)" : ""}`);
  const bind = await bindTopicVideosToSlots(S1);
  console.log(`   bound to editor slots: ${bind.bound}; unbound: ${bind.unbound.join(", ") || "none"}`);

  // ---- 4. Dropbox, session 1 ----------------------------------------------------
  for (const x of renames) {
    const ok = await dropboxMoveFolder(x.from, x.to);
    console.log(`4. ${ok ? "renamed" : "NOT renamed (something is already there)"}: ${x.from.slice(raw1.length + 1)} -> ${x.to.slice(raw1.length + 1)}`);
  }
  if (noteFolder) {
    const again = await dropboxListFolder(noteFolder.path, { recursive: true });
    if (!again.some((e) => e.tag === "file")) {
      await dropboxDelete(noteFolder.path);
      await prisma.contentTopicFolder.deleteMany({ where: { projectId: S1, topicId: EXTRA.topic } });
      console.log(`   removed the empty folder ${noteFolder.name}`);
    } else console.log(`   KEPT ${noteFolder.name}: it has files now`);
  }
  const f1 = await ensureTopicFolders(S1);
  console.log(`   session 1 topic folders: ${JSON.stringify(f1)}`);

  // ---- 5. Dropbox, today's session --------------------------------------------
  const again2 = await dropboxListFolder(raw2, { recursive: true });
  for (const k of stale2) {
    const n = again2.filter((e) => e.tag === "file" && e.path.toLowerCase().startsWith(`${k.path.toLowerCase()}/`)).length;
    if (n) { console.log(`5. KEPT ${k.name}: ${n} file(s) arrived`); continue; }
    await dropboxDelete(k.path);
    const tag = k.name.match(/\[([a-z0-9]{8})\]$/i)?.[1]?.toLowerCase();
    if (tag) {
      const rows = await prisma.contentTopicFolder.findMany({ where: { projectId: S2 }, select: { id: true, topicId: true, label: true } });
      const ids = rows.filter((row) => row.topicId.slice(-8).toLowerCase() === tag && row.label === k.name).map((row) => row.id);
      if (ids.length) await prisma.contentTopicFolder.deleteMany({ where: { id: { in: ids } } });
    }
    console.log(`5. removed empty ${k.name}`);
  }
  const f2 = await ensureTopicFolders(S2);
  console.log(`   today's topic folders: ${JSON.stringify(f2)}`);

  // ---- 6. the review task, and the record on both jobs --------------------------
  const task = await prisma.smartTask.findUnique({ where: { id: EXTRA.task }, select: { status: true, description: true } });
  if (task && !["COMPLETED", "CANCELLED"].includes(task.status)) {
    await prisma.smartTask.update({
      where: { id: EXTRA.task },
      data: { status: "COMPLETED", completedAt: now, description: `${task.description ?? ""}\n\nClosed Oct 27 2026: not an extra video. James's note stood for plan videos 9-30 and 32, now recorded one by one on this job (31 videos). ${WHY}.`.slice(0, 4000) },
    });
  }
  await prisma.activity.create({ data: { projectId: S1, type: "NOTE", body: `${WHY}. This job now has 31 videos to edit (plan videos 1-30 and 32). James's "video N" Dropbox folders were renamed to the plan names, e.g. "09 Check Around First".` } });
  await prisma.activity.create({ data: { projectId: S2, type: "NOTE", body: `${WHY}. Today's list is 17 videos: 31 and 33-48. Their Dropbox folders are numbered by the plan, e.g. "31 Start With This Call, Not a Listing".` } });
  console.log("6. review task closed; a note on both jobs");

  // ---- check ----------------------------------------------------------------------
  const board = await bulkBoardForMonth(MONTH_ID);
  for (const s of board?.sessions ?? []) console.log(`   session ${s.no}: ${s.items.length} planned, ${s.filmed} filmed (${s.items.map((x) => x.rank).join(",")})`);
  const brief = await filmingBriefFor(S1);
  console.log(`   session 1 editor brief: ${brief?.rows.length ?? 0} videos; ${brief?.slotsWithoutTopic ?? "?"} slots without a topic`);
  console.log(`   session 1 brief rows: ${brief?.rows.map((r) => `${(r as { slot?: number }).slot ?? "?"}:${(r as { title?: string }).title ?? ""}`).join(" | ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
