// Oct 12 2026 (Jordan): "for Arielle, we never had a strategy call for November.
// She signed up August 25th. We had all the calls and stuff in September. We need
// a September content session scheduled for October and an October strategy call
// and content session scheduled for this month as well. She prefers to pick her
// topics on the platform. I attached her September scripts/video topics."
//
// What the hub had:
//   · NOVEMBER: created today by the automatic analysis of her Sep 11 strategy
//     call, which guessed "plannedMonthKey 2026-11" (the call mentions her
//     November anniversary launch) — so November read "strategy call completed"
//     and held that call's two topic proposals and priorities.
//   · AUGUST: an open month owing 4 videos; she signed up Aug 25 and her program
//     (calls, scripts) began in September.
//   · SEPTEMBER: call held Sep 11, no topics or scripts on file, never filmed.
//   · OCTOBER: nothing planned.
//
// What this does (nothing is sent to Arielle):
//   1. Sep 11 call's proposals, topic history and priorities: November → September;
//      November back to "no strategy call yet".
//   2. August: closed as skipped on purpose (nothing owed), like Janice's and Joe's September.
//   3. Her two September scripts (the PDF Jordan attached) filed on September through
//      the hub's own upload ("as written", pillars from her approved strategy). Not
//      released to her portal — Jordan already sent them.
//   4. "Bring September's session into October" with "scripts were sent outside the hub":
//      her portal asks her to book September's session alongside October's.
//   5. October planned by Arielle picking topics in the portal (her preference).
//
//   set -a && source .env; set +a
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct6/arielle-september-october.ts [--apply] <scripts.pdf>
import { readFileSync } from "fs";
import { basename } from "path";
import { prisma } from "@/lib/prisma";

const ENROLLMENT = "cmt7msany000c9kg1ospdeoza";
const CLIENT = "cmt7msalo000b9kg1kuk666hf";
const AUG = "cmt7msaqb000d9kg1ui7ajjh3", SEP = "cmti54uo2004xic049w57b8ek", OCT = "cmup0bq4600qgjg04fi7j19t5", NOV = "cmv5i4dww005gku06jkwxij32";
const CALL = "cmu7g26s3004wl604z4pur5np"; // Sep 11 2026 monthly strategy call

async function main() {
  const apply = process.argv.includes("--apply");
  const pdf = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!pdf) throw new Error("Pass the scripts PDF.");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT }, select: { clientId: true, status: true } });
  const c = await prisma.client.findUnique({ where: { id: CLIENT }, select: { name: true } });
  if (e?.clientId !== CLIENT || c?.name !== "Arielle Roemer") throw new Error("Not Arielle Roemer's program — stopping.");
  const jordan = await prisma.appUser.findFirst({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true } });
  const by = jordan?.name ?? "Jordan Spackman";
  console.log(apply ? "APPLY" : "DRY RUN");
  const { recalcProgramMonth, choosePlanningMode } = await import("@/lib/programMonths");

  // ---- 1. November → September ----------------------------------------------
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: NOV }, select: { id: true, topicId: true, callRecordId: true, status: true } });
  const events = await prisma.contentTopicEvent.findMany({ where: { monthId: NOV }, select: { id: true } });
  const nov = await prisma.contentMonth.findUnique({ where: { id: NOV }, select: { strategyCallStatus: true, prioritiesJson: true, prioritiesSourceRef: true } });
  const sep = await prisma.contentMonth.findUnique({ where: { id: SEP }, select: { prioritiesJson: true } });
  console.log(`1. November: ${sels.length} selection(s), ${events.length} topic event(s), call ${nov?.strategyCallStatus}, priorities from ${nov?.prioritiesSourceRef ?? "-"}`);
  if (apply) {
    for (const s of sels) {
      if (s.callRecordId && s.callRecordId !== CALL) { console.log("   skip (another call)", s.id); continue; }
      const clash = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: s.topicId, monthId: SEP } } });
      if (clash) { console.log("   skip (already on September)", s.topicId); continue; }
      await prisma.contentTopicSelection.update({ where: { id: s.id }, data: { monthId: SEP } });
    }
    await prisma.contentTopicEvent.updateMany({ where: { monthId: NOV }, data: { monthId: SEP } });
    await prisma.contentMonth.update({
      where: { id: SEP },
      data: sep?.prioritiesJson ? {} : { prioritiesJson: nov?.prioritiesJson ?? null, prioritiesSourceRef: nov?.prioritiesSourceRef ?? null },
    });
    await prisma.contentMonth.update({ where: { id: NOV }, data: { strategyCallStatus: "NOT_SCHEDULED", prioritiesJson: null, prioritiesSourceRef: null } });
    await recalcProgramMonth(SEP);
    await recalcProgramMonth(NOV);
  }

  // ---- 2. August: nothing owed ----------------------------------------------------
  const aug = await prisma.contentMonth.findUnique({ where: { id: AUG }, select: { status: true } });
  const augJobs = await prisma.project.count({ where: { contentMonthId: AUG, status: { not: "CANCELLED" } } });
  console.log(`2. August: ${aug?.status}, ${augJobs} linked job(s) → ${augJobs || aug?.status !== "OPEN" ? "left alone" : "SKIPPED (nothing owed)"}`);
  if (apply && !augJobs && aug?.status === "OPEN") await prisma.contentMonth.update({ where: { id: AUG }, data: { status: "SKIPPED" } });

  // ---- 3. September's scripts -------------------------------------------------------
  const already = await prisma.contentScript.count({ where: { monthId: SEP } });
  if (already) console.log(`3. September already has ${already} script(s) — upload skipped`);
  else {
    const { extractDocumentText } = await import("@/lib/documentText");
    const doc = await extractDocumentText(readFileSync(pdf), basename(pdf));
    if (!doc.ok) throw new Error(doc.message);
    const { aiSplitUpload, applyScriptUpload } = await import("@/lib/scriptUpload");
    // The PDF's page width broke sentences mid-line ("feel confident making /
    // them."). Join a line that ends mid-sentence to the lowercase line after it:
    // whitespace only, never a word (the as-written check still compares words).
    const text = doc.text.replace(/([^.!?:"”\n])\n(?=[a-z])/g, "$1 ");
    const preview = await aiSplitUpload({ enrollmentId: ENROLLMENT, monthId: SEP, sources: [{ name: basename(pdf), text }], requestedBy: jordan?.email ?? "info@realtourpilot.com" });
    console.log(`3. Upload preview for ${preview.monthName} (owes ${preview.owed}):`);
    for (const d of preview.drafts) {
      const pillar = preview.pillars.find((p) => p.id === d.pillarId)?.name ?? "none";
      console.log(`   "${d.title}" · topic ${d.topicId ? `matched (${d.matchKind})` : "new"} · pillar ${pillar} · ${d.words} words · speakers ${d.speakers.join("/") || "-"} · shape ${d.shape.join("; ") || "ok"} · as written ${d.asWritten ? JSON.stringify(d.asWritten).slice(0, 80) : "-"}`);
      for (const n of d.notes) console.log(`      note: ${n}`);
    }
    for (const n of preview.notes) console.log(`   ${n}`);
    const bad = preview.drafts.filter((d) => d.isScript && (d.shape.length || d.conflict));
    if (bad.length) throw new Error(`Upload has problems: ${bad.map((d) => `${d.title}: ${[...d.shape, d.conflict].filter(Boolean).join("; ")}`).join(" | ")}`);
    if (apply) {
      const items = preview.drafts.filter((d) => d.isScript).map((d) => ({ text: d.text, title: d.title, topicId: d.topicId, pillarId: d.pillarId, sourceName: d.sourceName, key: d.key }));
      const r = await applyScriptUpload({ enrollmentId: ENROLLMENT, monthId: SEP, fileNames: preview.fileNames, parser: preview.parser, aiRunId: preview.aiRunId, items }, { email: jordan?.email ?? "info@realtourpilot.com", appUserId: jordan?.id ?? null, name: by });
      console.log(`   ${r.message}`);
      await recalcProgramMonth(SEP);
    }
  }

  // ---- 4. September's session, booked in October -----------------------------------
  console.log("4. Bring September's session into October (scripts sent outside the hub)");
  if (apply) {
    const { applyLateSession } = await import("@/lib/monthLateSession");
    try { console.log("   " + (await applyLateSession(OCT, SEP, by, { scriptsSentOutside: true })).message); }
    catch (err) { console.log("   refused: " + (err instanceof Error ? err.message : String(err))); }
  }

  // ---- 5. October: Arielle picks her topics -----------------------------------------
  console.log("5. October planned by the client picking topics in the portal");
  if (apply) {
    const r = await choosePlanningMode(OCT, "WRITTEN", `staff:${jordan?.id ?? "info@realtourpilot.com"}`);
    console.log(`   planning ${r?.after?.planningMode ?? "?"} · call ${r?.after?.strategyCallStatus ?? "?"}`);
  }

  for (const [k, id] of Object.entries({ AUG, SEP, OCT, NOV })) {
    const m = await prisma.contentMonth.findUnique({ where: { id }, select: { monthKey: true, status: true, strategyCallStatus: true, planningMode: true, preparationStatus: true } });
    const n = await prisma.contentTopicSelection.count({ where: { monthId: id, status: { not: "REMOVED" } } });
    const s = await prisma.contentScript.count({ where: { monthId: id } });
    console.log(`   ${k}: ${JSON.stringify(m)} · ${n} topic(s) · ${s} script(s)`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
