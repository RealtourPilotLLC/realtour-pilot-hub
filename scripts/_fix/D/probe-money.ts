// READ-ONLY probe. Measures what stripMoneySentences does to CLIENT-facing
// script text (the posting-kit "Script & transcript" card) on production rows.
import { prisma } from "../../../src/lib/prisma";
import { stripMoneySentences } from "../../../src/lib/text";
import { canonicalFromParts, pointsFromJson } from "../../../src/lib/contentScripts";
import { renderScript } from "../../../src/lib/contentPolicy";

const CLIENT_VISIBLE_SCRIPT = ["CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"];
function visible(s: { status: string; releaseState: string | null; historical: boolean }) {
  if (s.releaseState === "withheld") return null;
  if (s.releaseState === "released") return "released";
  if (s.releaseState === "historical" || s.historical) return "historical";
  return CLIENT_VISIBLE_SCRIPT.includes(s.status) ? "released" : null;
}

const sentences = (s: string) => s.split("\n").flatMap((l) => l.split(/(?<=[.!?])\s+/)).map((x) => x.trim()).filter(Boolean);

async function main() {
  const scripts = await prisma.contentScript.findMany({
    select: { id: true, title: true, body: true, status: true, releaseState: true, historical: true, clientId: true, enrollmentId: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true },
  });
  const vis = scripts.filter((s) => visible(s) !== null);
  const clients = new Map((await prisma.client.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const wanted = vis.map((s) => s.sharedVersionId ?? s.approvedVersionId ?? null).filter((x): x is string => !!x);
  const versions = await prisma.contentScriptVersion.findMany({ where: { id: { in: wanted } } });
  const byId = new Map(versions.map((v) => [v.id, v]));

  let loss = 0;
  const examples: string[] = [];
  for (const s of vis) {
    const vid = s.sharedVersionId ?? s.approvedVersionId ?? null;
    const v = vid ? byId.get(vid) : null;
    const body = v
      ? renderScript(canonicalFromParts({ title: v.title, categoryLabel: v.categoryLabel, pillarId: v.pillarId, hook: v.hook, points: pointsFromJson(v.pointsJson), close: v.close, captionCta: v.captionCta }, v.clientId))
      : s.body;
    const after = stripMoneySentences(body);
    if (after !== body) {
      loss++;
      if (examples.length < 6) {
        const gone = sentences(body).filter((t) => !after.includes(t.slice(0, Math.min(40, t.length))));
        examples.push(`  · ${clients.get(s.clientId) ?? s.clientId} — "${s.title}" (${s.id}); ${body.length}->${after.length} chars; e.g. ${gone.slice(0, 2).map((g) => JSON.stringify(g.slice(0, 110))).join(" | ") || "(whitespace only)"}`);
      }
    }
  }
  console.log(`CLIENT-VISIBLE SCRIPTS: ${vis.length} of ${scripts.length} ContentScript rows`);
  console.log(`SCRIPTS THAT LOSE TEXT to stripMoneySentences: ${loss}`);
  console.log(examples.join("\n"));

  const erica = scripts.find((s) => s.id === "cmt7mxsrt001p9kg1mq0gngt3");
  if (erica) {
    const before = erica.body;
    const after = stripMoneySentences(before);
    console.log(`\nNAMED CASE cmt7mxsrt001p9kg1mq0gngt3 — ${clients.get(erica.clientId) ?? erica.clientId} — "${erica.title}"`);
    console.log(`  status=${erica.status} releaseState=${erica.releaseState} historical=${erica.historical} visible=${visible(erica)}`);
    console.log(`  body ${before.length} -> ${after.length} chars (${before.length - after.length} lost)`);
    for (const t of sentences(before)) if (!after.includes(t.slice(0, Math.min(40, t.length)))) console.log(`  DROPPED: ${JSON.stringify(t.slice(0, 170))}`);
  } else {
    console.log("\nNAMED CASE cmt7mxsrt001p9kg1mq0gngt3: not found");
  }

  const trs = await prisma.contentCutTranscript.findMany({ where: { invalidatedAt: null, status: "SUCCEEDED" }, select: { id: true, text: true, correctedText: true } });
  let tLoss = 0;
  for (const t of trs) {
    const txt = t.correctedText || t.text;
    if (txt && stripMoneySentences(txt) !== txt) tLoss++;
  }
  console.log(`\nLIVE CUT TRANSCRIPTS: ${trs.length}; losing text to the same clamp: ${tLoss}`);
}
main().then(() => prisma.$disconnect());
