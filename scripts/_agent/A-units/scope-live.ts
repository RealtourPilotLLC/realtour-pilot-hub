// Does the analyser actually NAME the video now? Reads a real multi-video job's
// cut list (read-only) and runs ONE model call over a made-up client message
// that talks about two of them by position. Writes NOTHING — no brief row is
// created or updated, no task, no message.
import { prisma } from "@/lib/prisma";
import { analyzeRevisionText, briefCutsFor } from "@/lib/revisionBrief";

async function main() {
  const id = process.argv[2];
  const project = id
    ? await prisma.project.findUnique({ where: { id }, select: { id: true, title: true } })
    : await prisma.project.findFirst({ where: { title: { contains: "893 S Matlack" } }, select: { id: true, title: true } });
  if (!project) { console.log("no project"); return; }
  const cuts = await briefCutsFor(project.id);
  console.log(`${project.title}: ${cuts.length} owed cuts`);
  for (const [i, c] of cuts.slice(0, 6).entries()) console.log(`  V${i + 1} ${c.label} — ${c.fileName ?? "nothing uploaded"} [${c.key}]`);
  if (cuts.length < 2) { console.log("not a multi-video job — nothing to prove here"); return; }

  const text = [
    "Hey! Just watched the batch you sent over. A few things:",
    "The second video — the music is way too loud over my voice at the start, can you bring it down?",
    "Also on the fourth one the address text is spelled wrong, it says Matlak instead of Matlack.",
    "Everything else looks great, love the pacing on all of them, don't change that.",
    "Oh and across all the videos can you make the logo a bit smaller at the end.",
  ].join(" ");

  const a = await analyzeRevisionText({ text, twoSided: false, clientName: "Test", propertyAddress: project.title, cuts });
  console.log(`\nheadline: ${a.headline}`);
  for (const i of a.items) {
    const names = (i.cuts ?? []).map((k) => cuts.find((c) => c.key === k)?.label ?? k);
    console.log(`  [${i.scope}] ${i.ask}\n        videos: ${names.length ? names.join(" · ") : "—"}`);
  }
  console.log(`\nkeep: ${a.keep.join(" | ")}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
