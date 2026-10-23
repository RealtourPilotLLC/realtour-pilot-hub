// ---------------------------------------------------------------------------
// RECONCILE KYLE'S OLD TASKS AGAINST THEIR SOURCES: A DRY RUN (Oct 23 2026).
//
// Jordan's revision of Kyle's dashboard: "Old tasks: do NOT auto-close or
// auto-re-date to shrink counts. Reconcile them against their source records
// (which are actually done at the source → propose resolve; duplicates →
// merge; the rest keep with a reason). Report; never apply."
//
// This script ONLY READS. It forces default_transaction_read_only=on on the
// connection and proves it with a refused write before the first read; there
// is no --apply. For every open task of Kyle's that is past its date (and every
// undated one more than a week old) it reads the record the task came from and
// proposes one of:
//   · RESOLVE  the work is done at the source (the job was delivered or
//              cancelled, the corrected version went out, the client was
//              answered, the photos were delivered, the lead got a reply or
//              booked, the shoot the note was for has happened);
//   · MERGE    the same task twice (same words, same job or client): keep the
//              oldest, merge the rest into it;
//   · KEEP     still open at the source, or nothing to check it against, with
//              the reason.
// A person decides each proposal on the task itself (Done / Not needed /
// New date). Figures are taken out of the titles (Kyle never sees money).
//
//   npx tsx scripts/_live/oct23-reconcile-old-tasks.ts [--env /path/to/.env] [--all]
// --all prints every task; without it, the summary and the first lines of each.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

const argEnv = (() => { const i = process.argv.indexOf("--env"); return i > 0 ? process.argv[i + 1] : null; })();
let url = process.env.DATABASE_URL ?? "";
if (!url) {
  const file = argEnv ?? path.resolve(__dirname, "../../.env");
  const m = fs.existsSync(file) ? fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m) : null;
  if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
}
if (!url) throw new Error("DATABASE_URL not found (pass --env <path to .env>): refusing to run without the read-only guard.");
{
  const u = new URL(url);
  u.searchParams.set("options", [u.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = u.toString();
}

type Proposal = "RESOLVE" | "MERGE" | "KEEP";
type Row = { id: string; title: string; taskType: string; ageDays: number | null; proposal: Proposal; reason: string };

const DAY = 86_400_000;
// The words that make a task what it is: case and punctuation fold, numbers stay
// (a phone number or a house number is what tells two tasks apart).
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  let refused = false;
  try {
    await prisma.appSetting.updateMany({ where: { key: "__oct23_reconcile_readonly_probe__" }, data: { value: "x" } });
  } catch (e) {
    refused = String(e).includes("read-only") || String(e).includes("25006");
  }
  if (!refused) throw new Error("The read-only guard is NOT proven: refusing to continue.");
  console.log("dry run: the connection is read-only (a write was refused). Nothing here can write.\n");

  // The libraries mark themselves server-only; this is a plain script (the drills' own neutraliser).
  (await import("node:module")).createRequire(__filename)("../_drill/_client-drill-preload.cjs");
  const { personTaskWhere, chaseDate, shootNoteExpires, WEEK_OLD_DAYS } = await import("../../src/lib/taskAging");
  const { scrubMoney } = await import("../../src/lib/text");
  const { etDayStartUtc } = await import("../../src/lib/datetime");
  const now = new Date();
  const startToday = etDayStartUtc(now);
  const kyle = await prisma.teamMember.findFirst({ where: { name: { startsWith: "Kyle" }, active: true }, select: { id: true, name: true } });
  if (!kyle) throw new Error("Kyle's team member row was not found.");
  const person = { key: "kyle", teamMemberId: kyle.id };

  const open = await prisma.smartTask.findMany({
    where: { status: { notIn: ["COMPLETED", "CANCELLED"] }, AND: [personTaskWhere(person)] },
    select: {
      id: true, title: true, taskType: true, source: true, status: true, reasonCreated: true, flaggedAt: true, assignedManually: true,
      dueAt: true, followUpAt: true, createdAt: true, projectId: true, clientId: true, dedupeKey: true,
      project: { select: { status: true, shootDate: true, deliveredAt: true, title: true } },
    },
    take: 1000,
  });
  // Old: past its date (any age), or undated and more than a week old.
  const old = open.filter((t) => {
    const at = chaseDate(t);
    return at ? at < startToday : now.getTime() - t.createdAt.getTime() >= WEEK_OLD_DAYS * DAY;
  });

  const projectIds = [...new Set(old.map((t) => t.projectId).filter((x): x is string => !!x))];
  const clientIds = [...new Set(old.map((t) => t.clientId).filter((x): x is string => !!x))];
  const [photoJobs, cuts, outs, orders] = await Promise.all([
    projectIds.length ? prisma.photoJob.findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, stage: true, deliveredAt: true } }) : [],
    projectIds.length ? prisma.reviewSubmission.findMany({ where: { projectId: { in: projectIds }, sentToClientAt: { not: null } }, select: { projectId: true, sentToClientAt: true } }) : [],
    clientIds.length ? prisma.commLog.findMany({ where: { clientId: { in: clientIds }, direction: "out", channel: { in: ["text", "email", "call"] } }, select: { clientId: true, occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 5000 }) : [],
    clientIds.length ? prisma.project.findMany({ where: { clientId: { in: clientIds } }, select: { clientId: true, createdAt: true } }) : [],
  ]);
  const photoOf = new Map(photoJobs.map((j) => [j.projectId, j]));
  const lastSent = (projectId: string) => cuts.filter((c) => c.projectId === projectId).map((c) => c.sentToClientAt!).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const repliedAfter = (clientId: string | null, at: Date) => !!clientId && outs.some((o) => o.clientId === clientId && o.occurredAt > at);
  const bookedAfter = (clientId: string | null, at: Date) => !!clientId && orders.some((o) => o.clientId === clientId && o.createdAt > at);
  const d = (x: Date) => x.toISOString().slice(0, 10);

  // Duplicates first: the same words on the same job (or client), the oldest kept.
  const merged = new Map<string, string>();
  const groups = new Map<string, typeof old>();
  for (const t of open) {
    // Only on the same job or client: two unlinked tasks are never assumed to be one.
    if (!t.projectId && !t.clientId) continue;
    const key = `${norm(t.title)}|${t.projectId ?? t.clientId}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    for (const t of list) if (t.id !== keep.id) merged.set(t.id, keep.id);
  }

  const rows: Row[] = old.map((t) => {
    const at = chaseDate(t);
    const ageDays = at ? Math.floor((now.getTime() - at.getTime()) / DAY) : null;
    const base = { id: t.id, title: scrubMoney(t.title), taskType: t.taskType, ageDays };
    if (merged.has(t.id)) return { ...base, proposal: "MERGE", reason: `the same task as ${merged.get(t.id)} (older), on the same ${t.projectId ? "job" : "client"}` };
    const p = t.project;
    const pj = t.projectId ? photoOf.get(t.projectId) ?? null : null;
    const sent = t.projectId ? lastSent(t.projectId) : null;
    if (p?.status === "CANCELLED") return { ...base, proposal: "RESOLVE", reason: "the job was cancelled" };
    if (shootNoteExpires({ ...t, project: p ? { status: p.status, shootDate: p.shootDate } : null }, now)) return { ...base, proposal: "RESOLVE", reason: `a note for the shoot, which happened ${p?.shootDate ? d(p.shootDate) : "already"}` };
    switch (t.taskType) {
      case "revision":
        if (sent && sent > t.createdAt) return { ...base, proposal: "RESOLVE", reason: `the corrected video went out ${d(sent)}: confirm with the client, then close` };
        if (pj?.deliveredAt && pj.deliveredAt > t.createdAt) return { ...base, proposal: "RESOLVE", reason: `the corrected photos were delivered ${d(pj.deliveredAt)}: confirm with the client, then close` };
        return { ...base, proposal: "KEEP", reason: "no corrected version has gone out since the change was asked" };
      case "edit_video":
        if (sent && sent > t.createdAt) return { ...base, proposal: "RESOLVE", reason: `the video was sent ${d(sent)}` };
        return { ...base, proposal: "KEEP", reason: "the edit has not been sent" };
      case "media_qa":
        if (pj?.stage === "DELIVERED") return { ...base, proposal: "RESOLVE", reason: `the photos were delivered ${pj.deliveredAt ? d(pj.deliveredAt) : ""}`.trim() };
        return { ...base, proposal: "KEEP", reason: pj ? `the photos are still ${pj.stage.toLowerCase().replace(/_/g, " ")}` : "no photo job to check against" };
      case "client_reply":
        if (repliedAfter(t.clientId, t.createdAt)) return { ...base, proposal: "RESOLVE", reason: "the client has been answered since" };
        return { ...base, proposal: "KEEP", reason: "no reply to the client since" };
      case "lead":
        if (bookedAfter(t.clientId, t.createdAt)) return { ...base, proposal: "RESOLVE", reason: "the lead booked a job since" };
        if (repliedAfter(t.clientId, t.createdAt)) return { ...base, proposal: "RESOLVE", reason: "the lead was answered since" };
        return { ...base, proposal: "KEEP", reason: t.clientId ? "no reply or booking since" : "not linked to a client, so nothing to check against" };
      default:
        if (p?.status === "DELIVERED" && p.deliveredAt && p.deliveredAt > t.createdAt) return { ...base, proposal: "RESOLVE", reason: `the job was delivered ${d(p.deliveredAt)} after this was asked: check it was done, then close` };
        if (!t.projectId && !t.clientId) return { ...base, proposal: "KEEP", reason: "not linked to a job or client, so nothing to check against: a person decides" };
        if (p?.status === "DELIVERED") return { ...base, proposal: "KEEP", reason: "asked after the job was delivered, so the delivery does not answer it: a person decides" };
        return { ...base, proposal: "KEEP", reason: p ? `the job is not finished yet (${p.status.toLowerCase().replace(/_/g, " ")})` : "linked to a client only; nothing there closes it: a person decides" };
    }
  });

  const count = (p: Proposal) => rows.filter((r) => r.proposal === p).length;
  const byType = (p: Proposal) => Object.entries(rows.filter((r) => r.proposal === p).reduce<Record<string, number>>((m, r) => ({ ...m, [r.taskType]: (m[r.taskType] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(", ");
  const weekOld = rows.filter((r) => r.ageDays == null || r.ageDays >= WEEK_OLD_DAYS).length;
  console.log(`Kyle's open tasks: ${open.length}. Old (past their date, or undated over a week): ${old.length} (${weekOld} a week or more).`);
  console.log(`  RESOLVE (done at the source): ${count("RESOLVE")}${count("RESOLVE") ? `  [${byType("RESOLVE")}]` : ""}`);
  console.log(`  MERGE (duplicates):           ${count("MERGE")}${count("MERGE") ? `  [${byType("MERGE")}]` : ""}`);
  console.log(`  KEEP (with a reason):         ${count("KEEP")}${count("KEEP") ? `  [${byType("KEEP")}]` : ""}`);
  const reasons = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [`${r.proposal}: ${r.reason.replace(/\d{4}-\d{2}-\d{2}/g, "<date>").replace(/ (\S+) \(older\)/, " another (older)")}`]: (m[`${r.proposal}: ${r.reason.replace(/\d{4}-\d{2}-\d{2}/g, "<date>").replace(/ (\S+) \(older\)/, " another (older)")}`] ?? 0) + 1 }), {});
  console.log("\nBy reason:");
  for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
  const all = process.argv.includes("--all");
  for (const p of ["RESOLVE", "MERGE", "KEEP"] as Proposal[]) {
    const list = rows.filter((r) => r.proposal === p).sort((a, b) => (b.ageDays ?? 999) - (a.ageDays ?? 999));
    if (!list.length) continue;
    console.log(`\n${p}:`);
    for (const r of all ? list : list.slice(0, 8)) console.log(`  ${r.id}  ${r.ageDays == null ? "undated" : `${r.ageDays}d`}  ${r.taskType.padEnd(20)} ${r.title.slice(0, 70)}  →  ${r.reason}`);
    if (!all && list.length > 8) console.log(`  … ${list.length - 8} more (--all prints every one)`);
  }
  console.log("\nNothing was changed. Each proposal is decided on the task itself (Done / Not needed / New date).");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
