export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026). Jordan: "yes set Bernadette to Mix and close
// Kyle's task. Re do Erica's scripts with the new script writing, and re do all
// of bernadettes scripts with the new script writing."
//   1. Kyle's open "Scripts not approved before filming — John Collins" task is
//      dismissed the office's way (dismissTask, as Jordan, "not needed").
//   2. Bernadette Rabel: Mix with 2 skits a month, her husband on the skit cast,
//      her two skit topics (Animals, Scumbags) marked Skit (programStyle,
//      contentTopics.setTopicFormat).
//   3. The new writer is switched on for Erica Walker and Bernadette Rabel only
//      (script_writer_v2 {on, enrollmentIds}).
//   4. Every unshared, unapproved draft of theirs gets a new version through
//      generateScriptForTopic (the hub's own path: a talking-to-camera topic is
//      written by the new writer, a skit by the skit writer, which the new
//      writer does not cover yet). The current version stays in history.
//      A script that is approved, shared or client-approved is never touched.
// Dry run by default; --apply does it.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const ERICA = "cmt7h6b0300059kcj990r34x7";
const BERN = "cmt7h6b0u00069kcjdq8xi0le";
const SKIT_TOPICS = ["cmv7eb40n001r9kgdks3nnnz9", "cmt7nuj9p00o29kgnvxp73xve"]; // Animals, Scumbags
let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../src/lib/prisma");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  const by = owner.email;

  // 1
  const tasks = await prisma.smartTask.findMany({ where: { title: { contains: "Scripts not approved before filming" }, AND: [{ title: { contains: "John Collins" } }], status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { id: true, title: true, status: true } });
  console.log(`1. Kyle's task(s): ${tasks.map((t) => `${t.title} [${t.status}]`).join(" | ") || "none open"}`);

  // 2
  const PS = await import("../../src/lib/programStyle");
  console.log(`2. Bernadette style now: ${await PS.videoStyleOf(BERN)}; cast: ${JSON.stringify(await PS.skitCastOf(BERN))}`);
  const topics = await prisma.contentTopic.findMany({ where: { id: { in: SKIT_TOPICS } }, select: { id: true, title: true, enrollmentId: true } });
  console.log(`   skit topics: ${topics.map((t) => `${t.title} (${t.enrollmentId === BERN ? "hers" : "NOT HERS"})`).join(" | ")}`);

  // 4 (listing)
  const scripts = await prisma.contentScript.findMany({ where: { enrollmentId: { in: [ERICA, BERN] }, historical: false, sharedAt: null, approvedAt: null, clientApprovedAt: null, status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, topicId: { not: null } }, select: { id: true, title: true, enrollmentId: true, topicId: true, monthId: true, callRecordId: true, currentVersionId: true } });
  const real = [];
  for (const s of scripts) {
    const mon = s.monthId ? await prisma.contentMonth.findUnique({ where: { id: s.monthId }, select: { monthKey: true } }) : null;
    if (mon && mon.monthKey < "2026-10") continue; // October and later only
    real.push({ ...s, monthKey: mon?.monthKey ?? "bank" });
  }
  console.log(`4. drafts to redo (${real.length}): ${real.map((s) => `${s.enrollmentId === ERICA ? "Erica" : "Bernadette"}: ${s.title} (${s.monthKey})`).join(" | ")}`);
  if (!apply) { console.log("dry run: nothing written (add --apply)"); process.exit(0); }

  // 1
  const { dismissTask } = await import("../../src/app/actions");
  for (const t of tasks) console.log(`   dismissed: ${JSON.stringify(await dismissTask(t.id, "not needed"))}`);
  // 2
  console.log(`   style: ${JSON.stringify(await PS.setVideoStyle(BERN, "MIX", by, { skitsPerMonth: 2 }))}`);
  const cast = await PS.skitCastOf(BERN);
  if (!cast.some((c) => /husband/i.test(c.role))) console.log(`   cast: ${JSON.stringify(await PS.setSkitCast(BERN, { add: { name: null, role: "Her husband", note: "A voice impressionist (has been on Howard Stern). Happy to act in her skits." } }, by))}`);
  const { setTopicFormat } = await import("../../src/lib/contentTopics");
  for (const t of topics) if (t.enrollmentId === BERN) console.log(`   ${t.title}: ${JSON.stringify(await setTopicFormat(t.id, "SKIT", { kind: "STAFF", staffUserId: owner.id }))}`);
  // 3
  const { WRITER_SWITCH_KEY, writerSwitch } = await import("../../src/lib/scriptWriter/pipeline");
  const sw = await writerSwitch();
  const ids = [...new Set([...(sw.enrollmentIds ?? []), ERICA, BERN])];
  const value = JSON.stringify({ on: true, enrollmentIds: ids });
  await prisma.appSetting.upsert({ where: { key: WRITER_SWITCH_KEY }, create: { key: WRITER_SWITCH_KEY, value, updatedBy: `${by} (via Claude)` }, update: { value, updatedBy: `${by} (via Claude)` } });
  console.log(`3. writer switch: ${value}`);
  // 4
  const { generateScriptForTopic } = await import("../../src/lib/contentGeneration");
  for (const s of real) {
    const fresh = await prisma.contentScript.findUnique({ where: { id: s.id }, select: { sharedAt: true, approvedAt: true, clientApprovedAt: true } });
    if (fresh?.sharedAt || fresh?.approvedAt || fresh?.clientApprovedAt) { console.log(`   SKIP (now approved/shared): ${s.title}`); continue; }
    try {
      const r = await generateScriptForTopic({ topicId: s.topicId!, monthId: s.monthId, requestedBy: by, unattended: false, callRecordId: s.callRecordId });
      const v = await prisma.contentScriptVersion.findUnique({ where: { id: r.versionId }, select: { versionNo: true, spokenWordCount: true, source: true } });
      console.log(`   ${s.title}: v${v?.versionNo} ${v?.spokenWordCount}w ${r.ok ? "ok" : "flagged"} (same script: ${r.scriptId === s.id})`);
    } catch (e) { console.log(`   FAILED ${s.title}: ${String(e).slice(0, 200)}`); }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
