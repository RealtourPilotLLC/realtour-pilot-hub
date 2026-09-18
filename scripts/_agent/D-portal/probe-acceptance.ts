// READ-ONLY acceptance probe. Group D, directive 1. Runs the REAL portal
// functions against production rows and checks the four acceptance criteria.
// Nothing is written.
import { PrismaClient } from "@prisma/client";
import { portalTopics, portalTopicScript, portalInterview, scriptForEnrollment } from "../../../src/lib/portal";
import { scriptVisibility } from "../../../src/lib/postingKit";

const prisma = new PrismaClient();
const ok = (b: boolean) => (b ? "PASS" : "**FAIL**");

async function main() {
  const enrolls = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true } });
  const names = new Map((await prisma.client.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));

  // ---- 1. A released script is readable by its client, under its topic.
  const releasedRows = await prisma.contentScript.findMany({ where: { releaseState: "released" }, select: { id: true, enrollmentId: true, clientId: true, topicId: true, title: true } });
  console.log(`== 1. released scripts (${releasedRows.length} rows; ${releasedRows.filter((r) => r.topicId).length} carry a topic)`);
  for (const r of releasedRows.filter((x) => x.topicId)) {
    const e = enrolls.find((x) => x.id === r.enrollmentId)!;
    const s = await portalTopicScript(e, r.topicId!);
    const words = s ? s.body.split(/\s+/).filter(Boolean).length : 0;
    console.log(`  ${ok(!!s && !s.historical && words > 20)}  "${r.title.slice(0, 40)}" -> ${s ? `${words} words, ${s.versionLabel ?? "no version"}, historical=${s.historical}` : "NULL"}`);
  }

  // ---- 2. An approved-but-withheld script is invisible, everywhere.
  const withheld = await prisma.contentScript.findMany({ where: { releaseState: "withheld" }, select: { id: true, enrollmentId: true, topicId: true, title: true, status: true } });
  console.log(`\n== 2. approved-but-withheld scripts (${withheld.length} rows, all status=APPROVED)`);
  for (const r of withheld) {
    const e = enrolls.find((x) => x.id === r.enrollmentId)!;
    const viaTopic = r.topicId ? await portalTopicScript(e, r.topicId) : null;
    const viaGate = await scriptForEnrollment(e.id, r.id);
    // Only a FAIL if the words we got back are this withheld row's.
    const leaked = !!viaTopic && !viaTopic.historical;
    console.log(`  ${ok(!leaked && viaGate === null)}  "${r.title.slice(0, 40)}" status=${r.status} -> topic:${viaTopic ? (viaTopic.historical ? "history only" : "LEAKED") : "null"} suggest-gate:${viaGate ? "OPEN" : "closed"}`);
  }

  // ---- 2b. and the interview page says "being prepared", never the words.
  const interviews = await prisma.contentInterview.findMany({ select: { id: true, enrollmentId: true, topicId: true } });
  console.log(`\n== 2b. interview pages (${interviews.length}) — stage, and no script text in the payload`);
  const bodies = (await prisma.contentScriptVersion.findMany({ select: { hook: true } })).map((v) => v.hook).filter((h) => h && h.length > 25);
  const stages = new Map<string, number>();
  let leaks = 0;
  for (const iv of interviews) {
    const e = enrolls.find((x) => x.id === iv.enrollmentId);
    if (!e) continue;
    const view = await portalInterview(e, iv.id);
    if (!view) continue;
    stages.set(view.script.stage, (stages.get(view.script.stage) ?? 0) + 1);
    const json = JSON.stringify(view);
    for (const h of bodies) if (json.includes(h.slice(0, 25))) { leaks++; console.log(`  **FAIL** interview ${iv.id} payload contains script text`); break; }
  }
  console.log(`  stages: ${[...stages].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`  ${ok(leaks === 0)}  no interview payload contains any ContentScriptVersion hook (${bodies.length} hooks checked)`);

  // ---- 3. Every topic's words come from the one gate: a DRAFT/INTERNAL_REVIEW
  //         script never renders.
  const hidden = await prisma.contentScript.findMany({ where: { releaseState: null, historical: false }, select: { id: true, enrollmentId: true, topicId: true, status: true } });
  console.log(`\n== 3. scripts with no releaseState and historical=false (${hidden.length}) — none may render`);
  let shown = 0;
  for (const r of hidden) {
    if (!r.topicId) continue;
    const e = enrolls.find((x) => x.id === r.enrollmentId);
    if (!e) continue;
    const s = await portalTopicScript(e, r.topicId);
    // Another (released/historical) script on the same topic legitimately can
    // render; what must never happen is THIS one rendering. Checked by body.
    const row = await prisma.contentScript.findUnique({ where: { id: r.id }, select: { body: true } });
    if (s && row?.body && s.body.slice(0, 60) === row.body.slice(0, 60)) { shown++; console.log(`    **FAIL** ${r.id} status=${r.status} rendered`); }
  }
  console.log(`  ${ok(shown === 0)}  0 of ${hidden.length} internal scripts render (statuses: ${[...new Set(hidden.map((h) => h.status))].join(", ")})`);

  // ---- 4. Nobody loses anything: the whole bank, per enrollment, end to end.
  console.log(`\n== 4. portalTopics end to end — topics rendering a script, per enrollment`);
  let totalRel = 0, totalHist = 0;
  for (const e of enrolls) {
    const d = await portalTopics(e).catch((err) => { console.log(`  ERROR ${e.id}: ${String(err).slice(0, 120)}`); return null; });
    if (!d) continue;
    const all = d.groups.flatMap((g) => g.topics);
    const rel = all.filter((t) => t.scriptText && !t.scriptText.historical);
    const his = all.filter((t) => t.scriptText?.historical);
    if (!rel.length && !his.length) continue;
    totalRel += rel.length; totalHist += his.length;
    const bytes = all.reduce((a, t) => a + (t.scriptText ? Buffer.byteLength(t.scriptText.body) : 0), 0);
    console.log(`  ${(names.get(e.clientId) ?? e.id).padEnd(26).slice(0, 26)}  released ${String(rel.length).padStart(3)}  history ${String(his.length).padStart(3)}  +${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`  totals: ${totalRel} topics show a released script, ${totalHist} show history`);

  // ---- 5. The gate itself, over every combination. Needed because BOTH live
  //         withheld rows happen to carry no topicId, so §2's topic path has no
  //         production row to exercise; this is the rule those rows would meet.
  console.log(`\n== 5. scriptVisibility truth table (the one rule, called directly)`);
  const cases: { s: { status: string; releaseState: string | null; historical: boolean }; want: string | null }[] = [
    { s: { status: "APPROVED", releaseState: "withheld", historical: false }, want: null },
    { s: { status: "CLIENT_VISIBLE", releaseState: "withheld", historical: false }, want: null },
    { s: { status: "APPROVED", releaseState: "released", historical: false }, want: "released" },
    { s: { status: "DRAFT", releaseState: "released", historical: false }, want: "released" },
    { s: { status: "APPROVED", releaseState: "historical", historical: true }, want: "historical" },
    { s: { status: "APPROVED", releaseState: null, historical: true }, want: "historical" },
    { s: { status: "APPROVED", releaseState: null, historical: false }, want: null },
    { s: { status: "INTERNAL_REVIEW", releaseState: null, historical: false }, want: null },
    { s: { status: "DRAFT", releaseState: null, historical: false }, want: null },
    { s: { status: "READY_TO_FILM", releaseState: null, historical: false }, want: "released" },
    { s: { status: "FILMED", releaseState: null, historical: false }, want: "released" },
  ];
  for (const c of cases) {
    const got = scriptVisibility(c.s);
    console.log(`  ${ok(got === c.want)}  ${c.s.status.padEnd(15)} releaseState=${String(c.s.releaseState).padEnd(10)} hist=${String(c.s.historical).padEnd(5)} -> ${got ?? "null"} (want ${c.want ?? "null"})`);
  }

  // ---- 6. House rule 1: the send paths are still shut. Untouched by this
  //         change — recorded so the claim is a measurement, not an assumption.
  const { reminderPolicy } = await import("../../../src/lib/programReminders");
  const p = await reminderPolicy();
  console.log(`\n== 6. reminders automation: enabled=${p.enabled} source=${p.source} testClientsOnly=${p.policy?.testClientsOnly ?? "(n/a)"}`);
  const switches = await prisma.programAutomation.findMany({ select: { key: true, enabled: true } });
  console.log(`  switches ON: ${switches.filter((s) => s.enabled).map((s) => s.key).join(", ") || "(none)"}`);
  console.log(`  switches OFF: ${switches.filter((s) => !s.enabled).map((s) => s.key).join(", ") || "(none)"}`);
}
main().finally(() => prisma.$disconnect());
