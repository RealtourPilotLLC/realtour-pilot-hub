// ---------------------------------------------------------------------------
// BERNADETTE'S THIRD SKIT, A FIRST DRAFT FOR JORDAN (Oct 26 2026).
// Jordan, after the Oct 26 follow-up call: "Yeah that's cool let's do that"
// (my offer: "draft the husband skit ... for you to edit"). The topic "Things
// My Husband Has Overheard Me Say on the Phone That Sound Unhinged Out of
// Context" had no script and no written answers; this is drafted from that
// call (Drive transcript): Jordan's "we need to talk" structure, Jay reading
// the lines back, Bernadette explaining each in one line, and only lines that
// were actually said on the call ("I need a much bigger deposit", "inside his
// house for almost two hours yesterday ... God bless him", listings called by
// the street like Allen Drive, Jay's "oh yeah, of course").
//
// Saved as v1, INTERNAL_REVIEW, created by "Claude" (never Jordan's name),
// for Jordan to Edit / Approve and send. Never shared, never emailed; the
// auto-share sweep only takes drafts created by "cron". Refuses if the topic
// already has a script.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-bernadette-overheard-skit.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const TOPIC = "cmvl7bljo000a9k7l0afw5b4c";
const MONTH = "cmup0bq4d00qhjg042qm8dbii";

const HOOK = `[Cold open. Bernadette is on the phone in the kitchen. Jay walks through behind her.]
BERNADETTE (on the phone): I told them, I need a much bigger deposit.
[Jay stops mid-step. Slowly turns his head. Stares. Keeps walking.]
[SFX: record scratch]
[Cut to the kitchen table. Jay pulls out the chair across from her and sits down. Dead serious.]
JAY: Babe. We need to talk.
[On-screen text: Things my husband has overheard me say on the phone]`;

const RE_HOOK = `JAY: I've been hearing you say some things on the phone. And I need answers.
[He unfolds a sheet of paper. It's a list.]
JAY: Let's start with the deposit.
BERNADETTE: That's earnest money. It shows the seller the buyer is serious.`;

const BUILD = `JAY (reading, deadpan): "I was inside his house for almost two hours yesterday."
BERNADETTE: A listing appointment. [Or whatever it really was.] Two hours. God bless him.`;

const PAYOFF = `JAY (reading): "Allen's huge."
[He lowers the list. Long look.]
JAY: Who is Allen?
BERNADETTE: Allen Drive. It's a listing. I call them by the street.`;

const CLOSE = `JAY: Every time you mention Allen Drive, I just say, "Oh yeah, of course."
BERNADETTE (to camera): Out of context, it sounds unhinged. In context, it's a house getting sold.
JAY (out of frame): Still sounds unhinged.`;

const CAPTION = "Thinking about selling in the Lehigh Valley? DM me SELLER and I'll explain everything. In context.";

const NOTES = `Two set-ups at the house: the cold open (Bernadette on a real-sounding call, Jay crossing behind her and stopping mid-step), then the kitchen table. Film the table with two angles and a little movement, like the Paul and Eric video, and grab Jay's reactions; let him smile through it so people know he's teasing her. Jay reads from a folded handwritten list, not a phone, so it doesn't repeat the phone slide in the scumbags skit. Every line he reads should be something she has really said: these three come from the Oct 26 call, and better ones from her own list can be swapped in. Never a client's real name; keep Allen Drive only if she's happy to name that street. Ad-lib freely and keep the structure.`;

async function main() {
  const prisma = await db();
  const { createScriptVersion } = await import("../../src/lib/contentScripts");
  const { recordTopicEvent } = await import("../../src/lib/contentTopics");
  const { briefSpokenWords } = await import("../../src/lib/scriptWriter/briefWriter");
  const { VERSION_FORMAT_KEY } = await import("../../src/lib/contentPolicy/videoFormat");

  const all = [HOOK, RE_HOOK, BUILD, PAYOFF, CLOSE, CAPTION, NOTES].join("\n");
  if (/[—–]/.test(all)) throw new Error("a dash in the draft");
  const topic = await prisma.contentTopic.findUniqueOrThrow({ where: { id: TOPIC }, select: { id: true, title: true, status: true, monthId: true, enrollmentId: true, pillarId: true } });
  if (topic.monthId !== MONTH) throw new Error(`topic is in month ${topic.monthId}, not ${MONTH}`);
  const pillar = topic.pillarId ? await prisma.contentPillar.findUnique({ where: { id: topic.pillarId }, select: { name: true } }) : null;
  const existing = await prisma.contentScript.findFirst({ where: { topicId: TOPIC, historical: false }, select: { id: true } });
  if (existing) throw new Error(`"${topic.title}" already has a script (${existing.id}); not touching it.`);

  const words = briefSpokenWords({ hook: HOOK.replace(/\[[^\]]*\]/g, " "), points: [RE_HOOK, BUILD, PAYOFF].map((t) => t.replace(/\[[^\]]*\]/g, " ")), close: CLOSE.replace(/\[[^\]]*\]/g, " ") }, true);
  console.log(`"${topic.title}" (${topic.status}), pillar ${pillar?.name ?? "(none)"}: ${words} spoken words`);
  if (!APPLY) { console.log("dry run: nothing written. Re-run with --apply."); return; }

  const r = await createScriptVersion({
    scriptId: null, enrollmentId: topic.enrollmentId, monthId: MONTH, topicId: TOPIC, source: "AI", createdBy: "Claude", status: "INTERNAL_REVIEW",
    parts: {
      title: "Babe, We Need to Talk", categoryLabel: pillar?.name ?? null, pillarId: topic.pillarId ?? null,
      hook: HOOK, points: [{ role: "re-hook", text: RE_HOOK }, { role: "build-up", text: BUILD }, { role: "payoff", text: PAYOFF }], close: CLOSE, captionCta: CAPTION,
      filmingNotes: NOTES, speakerLabels: ["BERNADETTE", "JAY"],
    },
    validation: { ok: true, findings: [], angle: null, [VERSION_FORMAT_KEY]: "SKIT" } as never,
    changeSummary: "First draft by Claude from the Oct 26 call with Bernadette and Jay, for Jordan to edit",
  });
  await prisma.contentTopic.updateMany({ where: { id: TOPIC, status: "SELECTED" }, data: { status: "SCRIPTED" } });
  await recordTopicEvent(TOPIC, topic.enrollmentId, "SCRIPTED", { kind: "AI" }, { monthId: MONTH, sourceRef: `ContentScriptVersion:${r.versionId}` });
  console.log(`written: script ${r.scriptId}, v${r.versionNo} (${r.versionId}), in review, not shared`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
