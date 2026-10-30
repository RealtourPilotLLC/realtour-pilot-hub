// ---------------------------------------------------------------------------
// LIVE: the editors' team cards (Oct 30 2026). Jordan: "I just onboarded a
// new editor her name is Reychelle ... add their Slack ID, assignment, etc."
//
//   npx tsx scripts/_live/oct30-editor-cards.ts            plan only, writes nothing
//   npx tsx scripts/_live/oct30-editor-cards.ts --apply    the cards
//   npx tsx scripts/_live/oct30-editor-cards.ts --link     + Reychelle's login → her desk
//   npx tsx scripts/_live/oct30-editor-cards.ts --undo     put back what --apply/--link changed
//
// --apply is safe before the deploy: the running code never reads
// TeamMember.editorKey or .timezone. It (1) files Kim's and John Mark's cards
// under their built-in desk keys, and (2) makes Reychelle's card: desk key
// "reychelle", her Slack ID (U0CEF2HEL00, looked up on Slack by her hub email
// reychelle@realtourpilot.com) and the clock her Slack profile is set to.
// No lanes are ticked: who takes new work automatically is Jordan's call, on
// Settings → Editor auto-assignment or her card on People → Logins.
//
// --link sets her login's editorKey and team card, the step the new code's
// "Set up as editor" does. Run it with the deploy: before it, the running
// code has no desk called "reychelle" to show her.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const UNDO = path.resolve(__dirname, "oct30-editor-cards.undo.json");
const REY = { email: "reychelle@realtourpilot.com", name: "Reychelle", slackId: "U0CEF2HEL00", timezone: "America/New_York", key: "reychelle" };
const BUILTIN = [
  { id: "cmqiiczo600039k2mab5itghl", name: "Kim Miguel", key: "kim" },
  { id: "cmsxb95bl00009k9tgwtotaxj", name: "John Mark", key: "john" },
];

type Undo = {
  cardKeys: { id: string; editorKey: string | null }[];
  createdCardId: string | null;
  login: { id: string; editorKey: string | null; teamMemberId: string | null } | null;
};

async function main() {
  const apply = process.argv.includes("--apply"), link = process.argv.includes("--link"), undo = process.argv.includes("--undo");
  if (undo) {
    const u = JSON.parse(fs.readFileSync(UNDO, "utf8")) as Undo;
    if (u.login) await prisma.appUser.update({ where: { id: u.login.id }, data: { editorKey: u.login.editorKey, teamMemberId: u.login.teamMemberId } });
    if (u.createdCardId) await prisma.teamMember.delete({ where: { id: u.createdCardId } });
    for (const c of u.cardKeys) await prisma.teamMember.update({ where: { id: c.id }, data: { editorKey: c.editorKey } });
    console.log("undone");
    return;
  }
  const prior: Undo = fs.existsSync(UNDO) ? JSON.parse(fs.readFileSync(UNDO, "utf8")) : { cardKeys: [], createdCardId: null, login: null };

  for (const b of BUILTIN) {
    const tm = await prisma.teamMember.findUnique({ where: { id: b.id }, select: { name: true, editorKey: true } });
    const holder = await prisma.teamMember.findFirst({ where: { editorKey: b.key }, select: { id: true } });
    if (!tm || tm.name !== b.name) { console.log(`SKIP ${b.name}: card not found as expected`); continue; }
    if (tm.editorKey === b.key) { console.log(`ok   ${b.name} already "${b.key}"`); continue; }
    if (holder) { console.log(`SKIP ${b.name}: "${b.key}" is on another card`); continue; }
    console.log(`${apply ? "SET " : "plan"} ${b.name} card → desk "${b.key}"`);
    if (apply) {
      if (!prior.cardKeys.some((c) => c.id === b.id)) prior.cardKeys.push({ id: b.id, editorKey: tm.editorKey });
      await prisma.teamMember.update({ where: { id: b.id }, data: { editorKey: b.key } });
    }
  }

  const login = await prisma.appUser.findUnique({ where: { email: REY.email } });
  if (!login || login.role !== "EDITOR") throw new Error("Reychelle's editor login is not there as expected.");
  let card = await prisma.teamMember.findFirst({ where: { email: { equals: REY.email, mode: "insensitive" } } });
  const slackTaken = await prisma.teamMember.findFirst({ where: { slackId: REY.slackId, ...(card ? { NOT: { id: card.id } } : {}) }, select: { name: true } });
  if (slackTaken) throw new Error(`Her Slack ID is already on ${slackTaken.name}'s card.`);
  if (!card) {
    console.log(`${apply ? "MAKE" : "plan"} Reychelle's card: desk "${REY.key}", Slack ${REY.slackId}, clock ${REY.timezone}, no lanes`);
    if (apply) {
      card = await prisma.teamMember.create({
        data: { name: REY.name, email: REY.email, role: "EDITOR", title: "Video Editor", active: true, slackId: REY.slackId, timezone: REY.timezone, editorKey: REY.key },
      });
      prior.createdCardId = card.id;
    }
  } else {
    console.log(`ok   Reychelle's card exists (${card.id}, desk ${card.editorKey ?? "none"})`);
  }

  if (link && card) {
    console.log(`LINK Reychelle's login → desk "${REY.key}", card ${card.id}`);
    if (!prior.login) prior.login = { id: login.id, editorKey: login.editorKey, teamMemberId: login.teamMemberId };
    await prisma.appUser.update({ where: { id: login.id }, data: { editorKey: REY.key, teamMemberId: card.id } });
  }
  if (!apply && !link) return;
  fs.writeFileSync(UNDO, JSON.stringify(prior, null, 2));
  await prisma.auditLog.create({ data: { actor: "claude:oct30-editor-cards", action: link ? "teammate_setup_link" : "teammate_setup", target: REY.email, detail: [apply && "cards", link && "login linked"].filter(Boolean).join(" + ") } }).catch(() => {});
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
