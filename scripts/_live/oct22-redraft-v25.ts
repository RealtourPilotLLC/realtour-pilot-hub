export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026), after writer v2.5 deployed. Jordan: "Re do
// Erica's scripts with the new script writing, and re do all of bernadettes
// scripts with the new script writing." The first redo ran on v2.3; the
// "restart on v2.4" (oct22-restart-redo-v24.ts) only restored those v2.3
// drafts, so no talking-to-camera draft of theirs was ever WRITTEN by v2.4 or
// v2.5. This writes each one fresh through the hub's own path
// (contentGeneration.generateScriptForTopic: the new writer for a
// talking-to-camera topic). A new version is added; every earlier version
// stays in the script's history.
//
// Never touched: a script that is shared, approved or client-approved (the
// pushed-scripts rule), a month before October, and a skit (the skit writer
// already wrote those; the new writer does not cover skits). Re-checked just
// before each write. Dry run by default (read-only connection); --apply writes.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const ERICA = "cmt7h6b0300059kcj990r34x7";
const BERN = "cmt7h6b0u00069kcjdq8xi0le";
const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set: run with node --env-file=.env.");
  if (!/default_transaction_read_only/.test(url)) process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
}

let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { writerSwitch } = await import("../../src/lib/scriptWriter/pipeline");
  const { WRITER_VERSION } = await import("../../src/lib/scriptWriter/rules");
  const { routeScriptDraft, buildClientContext } = await import("../../src/lib/contentGeneration");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };

  const sw = await writerSwitch();
  console.log(`=== ${APPLY ? "APPLY" : "DRY RUN (read-only connection)"} · writer ${WRITER_VERSION} · switch ${JSON.stringify(sw)} ===`);
  if (!sw.on || ![ERICA, BERN].every((id) => (sw.enrollmentIds ?? []).includes(id))) throw new Error("the new writer is not switched on for both clients: nothing written");

  const scripts = await prisma.contentScript.findMany({
    where: { enrollmentId: { in: [ERICA, BERN] }, historical: false, sharedAt: null, approvedAt: null, clientApprovedAt: null, status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, topicId: { not: null } },
    orderBy: [{ enrollmentId: "asc" }, { title: "asc" }],
    select: { id: true, title: true, enrollmentId: true, topicId: true, monthId: true, callRecordId: true, currentVersionId: true },
  });
  const plan: (typeof scripts[number] & { who: string; monthKey: string })[] = [];
  for (const s of scripts) {
    const who = s.enrollmentId === ERICA ? "Erica" : "Bernadette";
    const mon = s.monthId ? await prisma.contentMonth.findUnique({ where: { id: s.monthId }, select: { monthKey: true } }) : null;
    if (mon && mon.monthKey < "2026-10") { console.log(`skip (before October): ${who} · ${s.title}`); continue; }
    const built = await buildClientContext(s.enrollmentId, { monthId: s.monthId });
    const { format, route } = await routeScriptDraft({ topicId: s.topicId!, enrollmentId: s.enrollmentId, ctx: built.ctx });
    const cur = s.currentVersionId ? await prisma.contentScriptVersion.findUnique({ where: { id: s.currentVersionId }, select: { versionNo: true, spokenWordCount: true, hook: true } }) : null;
    const line = `${who.padEnd(10)} ${(mon?.monthKey ?? "bank").padEnd(7)} ${s.title.slice(0, 55).padEnd(55)} now v${cur?.versionNo ?? "?"} ${cur?.spokenWordCount ?? "?"}w`;
    if (route !== "writer") { console.log(`skip (${format}, ${route}): ${line}`); continue; }
    console.log(`REDO: ${line}`);
    plan.push({ ...s, who, monthKey: mon?.monthKey ?? "bank" });
  }
  console.log(`\n${plan.length} to write fresh on ${WRITER_VERSION}.`);
  if (!APPLY) { console.log("DRY RUN: nothing written. Re-run with --apply."); await prisma.$disconnect(); return; }

  const { generateScriptForTopic } = await import("../../src/lib/contentGeneration");
  for (const s of plan) {
    const fresh = await prisma.contentScript.findUnique({ where: { id: s.id }, select: { sharedAt: true, approvedAt: true, clientApprovedAt: true } });
    if (fresh?.sharedAt || fresh?.approvedAt || fresh?.clientApprovedAt) { console.log(`SKIP (approved or shared since): ${s.title}`); continue; }
    try {
      const r = await generateScriptForTopic({ topicId: s.topicId!, monthId: s.monthId, requestedBy: owner.email, unattended: false, callRecordId: s.callRecordId });
      const v = await prisma.contentScriptVersion.findUnique({ where: { id: r.versionId }, select: { versionNo: true, spokenWordCount: true, hook: true } });
      console.log(`${s.who} · ${s.title}: v${v?.versionNo} ${v?.spokenWordCount}w ${r.ok ? "passed" : "flagged"} (same script: ${r.scriptId === s.id}) · hook: "${(v?.hook ?? "").slice(0, 90)}"`);
    } catch (e) { console.log(`FAILED ${s.who} · ${s.title}: ${String(e).slice(0, 240)}`); }
  }
  await prisma.$disconnect();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
