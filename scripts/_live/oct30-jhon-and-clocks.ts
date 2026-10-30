// ---------------------------------------------------------------------------
// LIVE: Jhon's name and the editors' clocks (Oct 30 2026). Jordan: "She is in
// the Philippines so is Jhon and Kim. Can we also fix Johns name to be Jhon?"
//
//   npx tsx scripts/_live/oct30-jhon-and-clocks.ts           plan only, writes nothing
//   npx tsx scripts/_live/oct30-jhon-and-clocks.ts --apply   make the changes
//   npx tsx scripts/_live/oct30-jhon-and-clocks.ts --undo    put back what --apply changed
//
// 1. Kim's, Jhon's and Reychelle's team cards: clock Asia/Manila (Reychelle's
//    said US Eastern, copied from her Slack profile).
// 2. "John Mark" → "Jhon Mark" on his team card and his login, and on the
//    name each past record kept of who did it (checks, receipts, work events,
//    notes, messages, cuts, fixes, activity). Those columns are labels, never
//    keys: no code matches a person by them (checked Oct 30). Message bodies
//    and other prose are left as they were written.
//
// Run --apply AFTER the deploy that renames him in code: until then the
// running code finds his desk from the name "John Mark".
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const UNDO = path.resolve(__dirname, "oct30-jhon-and-clocks.undo.json");
const OLD = "John Mark", NEW = "Jhon Mark", TZ = "Asia/Manila";
const CARDS = [
  { id: "cmqiiczo600039k2mab5itghl", name: "Kim Miguel" },
  { id: "cmsxb95bl00009k9tgwtotaxj", name: OLD },
  { id: "cmvv7186700009kfcshrwrxi4", name: "Reychelle" },
];
const JHON_CARD = "cmsxb95bl00009k9tgwtotaxj";
const JHON_LOGIN = "john@realtourpilot.com";
// table.column holding a display name (every table here has an `id` key)
const HISTORY: [string, string][] = [
  ["CutSelfCheck", "actorName"], ["EditorBriefReceipt", "actorName"], ["EditorWorkEvent", "actorName"],
  ["MediaNote", "authorName"], ["ProjectMessage", "authorName"], ["ReviewSubmission", "submittedByName"],
  ["RevisionIssue", "addressedBy"], ["RevisionIssueEvent", "actorName"], ["UsageEvent", "name"],
];

type Undo = {
  clocks: { id: string; timezone: string | null }[];
  card: boolean;
  login: boolean;
  history: { table: string; column: string; ids: string[] }[];
};

async function main() {
  const apply = process.argv.includes("--apply"), undo = process.argv.includes("--undo");
  if (undo) {
    const u = JSON.parse(fs.readFileSync(UNDO, "utf8")) as Undo;
    for (const c of u.clocks) await prisma.teamMember.update({ where: { id: c.id }, data: { timezone: c.timezone } });
    if (u.card) await prisma.teamMember.update({ where: { id: JHON_CARD }, data: { name: OLD } });
    if (u.login) await prisma.appUser.update({ where: { email: JHON_LOGIN }, data: { name: OLD } });
    for (const h of u.history) {
      if (h.ids.length) await prisma.$executeRawUnsafe(`UPDATE "${h.table}" SET "${h.column}" = $1 WHERE id = ANY($2::text[]) AND "${h.column}" = $3`, OLD, h.ids, NEW);
    }
    console.log("undone");
    return;
  }

  const u: Undo = { clocks: [], card: false, login: false, history: [] };
  for (const c of CARDS) {
    const tm = await prisma.teamMember.findUnique({ where: { id: c.id }, select: { name: true, timezone: true } });
    if (!tm || (tm.name !== c.name && tm.name !== NEW)) { console.log(`SKIP ${c.name}: card not found as expected`); continue; }
    if (tm.timezone === TZ) { console.log(`ok   ${tm.name} already ${TZ}`); continue; }
    console.log(`${apply ? "SET " : "plan"} ${tm.name}: clock ${tm.timezone ?? "(none)"} → ${TZ}`);
    u.clocks.push({ id: c.id, timezone: tm.timezone });
  }
  const card = await prisma.teamMember.findUnique({ where: { id: JHON_CARD }, select: { name: true, email: true } });
  if (card?.name === OLD && card.email === JHON_LOGIN) { console.log(`${apply ? "SET " : "plan"} team card name ${OLD} → ${NEW}`); u.card = true; }
  else console.log(`ok   team card reads "${card?.name}"`);
  const login = await prisma.appUser.findUnique({ where: { email: JHON_LOGIN }, select: { name: true } });
  if (login?.name === OLD) { console.log(`${apply ? "SET " : "plan"} login name ${OLD} → ${NEW}`); u.login = true; }
  else console.log(`ok   login reads "${login?.name}"`);
  for (const [table, column] of HISTORY) {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${table}" WHERE "${column}" = $1`, OLD);
    console.log(`${apply ? "SET " : "plan"} ${table}.${column}: ${rows.length} record(s)`);
    u.history.push({ table, column, ids: rows.map((r) => r.id) });
  }
  if (!apply) return;

  // The undo record is written before the first change, so a run that stops
  // half way can still be put back.
  fs.writeFileSync(UNDO, JSON.stringify(u, null, 2));
  for (const c of u.clocks) await prisma.teamMember.update({ where: { id: c.id }, data: { timezone: TZ } });
  if (u.card) await prisma.teamMember.update({ where: { id: JHON_CARD }, data: { name: NEW } });
  if (u.login) await prisma.appUser.update({ where: { email: JHON_LOGIN }, data: { name: NEW } });
  for (const h of u.history) {
    if (h.ids.length) await prisma.$executeRawUnsafe(`UPDATE "${h.table}" SET "${h.column}" = $1 WHERE id = ANY($2::text[]) AND "${h.column}" = $3`, NEW, h.ids, OLD);
  }
  await prisma.auditLog.create({ data: { actor: "claude:oct30-jhon-and-clocks", action: "teammate_rename", target: JHON_LOGIN, detail: `${OLD} → ${NEW}; clocks ${TZ} for ${u.clocks.length} card(s)` } }).catch(() => {});
  console.log("applied");
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
