// ---------------------------------------------------------------------------
// LIVE, Oct 30 2026: Erica Walker's editing preferences stop saying "no text
// over B-roll".
//
// Jordan, Oct 30 2026: "Also Erica walkers editing preferences we do not skip
// text over B-roll. That should not be on there". The line was the AI working
// profile's reading of one past caption question ("Captions should appear only
// while the subject is on screen speaking, not over b-roll ..."), with two
// lines built on it (make two caption versions for her to pick). The sort
// copied them into her editor brief.
//
//   1. profileJson: those lines leave editing.prefs and dos (nothing else).
//   2. clientPreferences (empty today): the house rule, in Jordan's words, so
//      the nightly profile rebuild reads it and does not grow the line back.
//   3. Her preferences are sorted again (one model call, labelled claude:).
//
// The old values go to oct30-erica-text-over-broll.undo.json. Nothing is sent.
//
//   dry run:  npx tsx --require ./scripts/_drill/_client-drill-preload.cjs scripts/_live/oct30-erica-text-over-broll.ts
//   apply:    … --apply
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { prisma } from "@/lib/prisma";

const CLIENT_ID = "cmqikslcr00999k9q5809i927"; // Erica Walker
const RULE = "Text and captions run over B-roll too, like every video. Never captions only while she is on screen speaking, and no second caption version for her to pick. (Jordan, Oct 30 2026)";
const UNDO = "scripts/_live/oct30-erica-text-over-broll.undo.json";
const GONE = /over b-?roll|captions or text placement/i;

async function main() {
  const apply = process.argv.includes("--apply");
  const c = await prisma.client.findUniqueOrThrow({ where: { id: CLIENT_ID }, select: { name: true, profileJson: true, clientPreferences: true } });
  const profile = JSON.parse(c.profileJson ?? "{}") as { editing?: { prefs?: string[] }; dos?: string[] };
  const prefsOut = (profile.editing?.prefs ?? []).filter((p) => GONE.test(p));
  const dosOut = (profile.dos ?? []).filter((p) => GONE.test(p));
  console.log(`${c.name}\nleaving editing.prefs:`, prefsOut, "\nleaving dos:", dosOut, "\nclientPreferences now:", c.clientPreferences);
  if (!apply) { console.log("\nDry run. Pass --apply to change it."); return; }
  if (c.clientPreferences?.trim()) throw new Error("clientPreferences is no longer empty; look before writing.");

  fs.writeFileSync(UNDO, JSON.stringify({ clientId: CLIENT_ID, profileJson: c.profileJson, clientPreferences: c.clientPreferences }, null, 1));
  if (profile.editing?.prefs) profile.editing.prefs = profile.editing.prefs.filter((p) => !GONE.test(p));
  if (profile.dos) profile.dos = profile.dos.filter((p) => !GONE.test(p));
  await prisma.client.update({ where: { id: CLIENT_ID }, data: { profileJson: JSON.stringify(profile), clientPreferences: RULE } });

  const { buildSortedWorkingPrefs } = await import("@/lib/workingPrefs");
  const r = await buildSortedWorkingPrefs(CLIENT_ID, "claude: oct30 Erica text over B-roll");
  console.log("sort:", r.ok, r.message);
  for (const e of r.prefs?.editing ?? []) console.log(`  [${e.topic}] ${e.text}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
