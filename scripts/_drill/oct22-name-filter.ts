// ---------------------------------------------------------------------------
// DRILL: the "other client's name" filter (Oct 22 2026, the listening fix).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct22-name-filter.ts
//
// THE BUG. contentGeneration's filter dropped every line naming another
// enrolled client by full name or first two words. "Jordan Spackman TEST" (the
// test account, enrolled Sep 22 2026) put "Jordan Spackman" on the list, so
// every line Jordan said was deleted from every client's calls, and on
// transcripts exported before mid-2026 (both speakers run together on one
// stored line) the whole conversation went: Marcee's Jan 26 call reached the
// writer as Gemini's notes alone. The live writer, the call's quotable lines,
// the planning reader and the strategy drafter all read through it.
//
//   1. the names: a test client and a member of staff are never "another
//      client"; a real enrolled client still is
//   2. the NEW format (one turn per line, Marcee's Oct 15 call shape): every
//      Jordan line kept, only the turn naming a real other client goes
//   3. the OLD format (turns run together on one line, her Jan 26 shape): the
//      conversation survives, split one turn per line; only the offending
//      turn goes; Gemini's notes that name Jordan stay
//   4. the line filters (facts, excerpts, the planning reader) use the same
//      names: Jordan's name passes, a real other client's does not
//   5. a confidential marker still takes its whole stored line
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness; no model, no network.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 7783);
installNextStubs();

const CLIENT = "Marcee Drill TEST";

// Marcee-shaped, one speaker turn per line (the Oct 15 2026 export).
const NEW_FORMAT = [
  "📝 Notes",
  "",
  "Jordan Spackman and Marcee McMullen chose three topics for November.",
  "",
  "📖 Transcript",
  "",
  "01:03:54",
  "",
  "Jordan Spackman: tell me a little bit about that backstory, how did you transition into real estate?",
  "Marcee McMullen: So, when I was a sales and marketing director for a local retirement community, I helped people choose apartments or cottages.",
  "Jordan Spackman: Mhm.",
  "Marcee McMullen: And I really, really loved it.",
  "Marcee McMullen: My friend Erica Walker told me her listing sold in two days, which is not normal anymore.",
  "Jordan Spackman: I couldn't have said it any better. We'll break that down into a good script.",
].join("\n");

// Marcee-shaped, both speakers run together on one stored line per block (the Jan 26 2026 export).
const OLD_FORMAT = [
  "📝 Notes",
  "",
  "Summary",
  "",
  "Jordan Spackman met with Marcee McMullen to gather information for a content strategy.",
  "",
  "📖 Transcript",
  "",
  "Jan 26, 2026",
  "",
  "00:13:48",
  "",
  " Jordan Spackman: What do buyers tell you?Marcee McMullen: Buyers often share with me that they feel lost and kind of on their own or uncertain what to do.Jordan Spackman: Okay.Marcee McMullen: First-time home buyers like me because I'm very good at keeping them on track.Jordan Spackman: That's great.",
  "",
  "00:32:27",
  "",
  " Jordan Spackman: And the market?Marcee McMullen: I still see a lot of sellers thinking that they're in 2022.Jordan Spackman: Right.Marcee McMullen: Erica Walker had the same problem with her own listing last month.Jordan Spackman: Interesting. So what do you tell them?Marcee McMullen: I tell them the truth even if it's not something they want to hear.",
].join("\n");

async function main() {
  const fence = fenceFetch();
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const gen = await import("@/lib/contentGeneration");
  const scrub = await import("@/lib/scriptWriter/transcriptScrub");
  try {
    const f = await buildContentMonth(prisma, { name: CLIENT, package: "Pro", monthKey: "2026-10", topics: [] });
    const enroll = async (name: string) => { const cl = await prisma.client.create({ data: { name } }); await prisma.contentEnrollment.create({ data: { clientId: cl.id, package: "Pro", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2 } }); return cl; };
    const testAccount = await enroll("Jordan Spackman TEST");
    const erica = await enroll("Erica Walker");
    // A real client row that carries a staff member's name (production's two "Jordan Spackman" rows are Jordan himself).
    await prisma.teamMember.create({ data: { name: "Kyle Drillwright", email: "kyle.drill@example.test" } });
    await enroll("Kyle Drillwright");
    await enroll("Jordan Spackman");
    void testAccount; void erica;

    // =======================================================================
    c.head("1 · who is \"another client\"");
    {
      const names = scrub.namesToScrub([
        { id: "t", name: "Jordan Spackman TEST" }, { id: "e", name: "Erica Walker" }, { id: "k", name: "Kyle Drillwright" }, { id: "j", name: "Jordan Spackman" }, { id: "b", name: "Bobby TEST Michael TEST" },
      ], ["Kyle Drillwright"]);
      c.ok("a real enrolled client is: her full name", names.includes("Erica Walker"), names.join(", "));
      c.ok("a test client never is (\"Jordan Spackman TEST\", \"Bobby TEST\"), nor its first two words", !names.some((n) => /test|jordan spackman|bobby/i.test(n)), names.join(", "));
      c.ok("a member of staff never is, even on a client row (Kyle Drillwright; Jordan Spackman by name)", !names.some((n) => /kyle drillwright|jordan spackman/i.test(n)));
      c.ok("\"Testa\" is a surname, not the TEST word: a real client named Testa still counts", scrub.namesToScrub([{ id: "x", name: "Maria Testa" }]).includes("Maria Testa"));
    }

    // =======================================================================
    c.head("2 · the new export: one turn per line (Oct 15 shape)");
    {
      const r = await gen.scrubTranscriptForGeneration(f.clientId, NEW_FORMAT);
      const jordanIn = NEW_FORMAT.split("\n").filter((l) => l.startsWith("Jordan Spackman:"));
      c.ok("every line Jordan said is kept (his question, his \"Mhm.\", his framing)", jordanIn.length === 3 && jordanIn.every((l) => r.text.includes(l)), `${jordanIn.filter((l) => r.text.includes(l)).length} of ${jordanIn.length}`);
      c.ok("…and the Gemini notes that name him", r.text.includes("Jordan Spackman and Marcee McMullen chose three topics"));
      c.ok("only the turn naming a real other client goes; her lines around it stay", !r.text.includes("Erica Walker") && r.text.includes("And I really, really loved it.") && r.text.includes("sales and marketing director") && r.reasons.otherClient === 1 && r.stripped === 1, JSON.stringify(r.reasons));
    }

    // =======================================================================
    c.head("3 · the old export: turns run together on one line (Jan 26 shape)");
    {
      const r = await gen.scrubTranscriptForGeneration(f.clientId, OLD_FORMAT);
      const lines = r.text.split("\n");
      c.ok("the conversation survives, one turn per line", lines.includes("Jordan Spackman: What do buyers tell you?") && lines.includes("Marcee McMullen: Buyers often share with me that they feel lost and kind of on their own or uncertain what to do.") && lines.includes("Marcee McMullen: I still see a lot of sellers thinking that they're in 2022."), lines.slice(0, 16).join(" ⏎ "));
      c.ok("every one of Jordan's turns is kept", ["Jordan Spackman: Okay.", "Jordan Spackman: That's great.", "Jordan Spackman: And the market?", "Jordan Spackman: Right.", "Jordan Spackman: Interesting. So what do you tell them?"].every((t) => lines.includes(t)));
      c.ok("only the turn naming Erica Walker goes; the answer after it stays", !r.text.includes("Erica Walker") && lines.includes("Marcee McMullen: I tell them the truth even if it's not something they want to hear.") && r.reasons.otherClient === 1, JSON.stringify(r.reasons));
      c.ok("timestamps and the notes are untouched", r.text.includes("00:13:48") && r.text.includes("00:32:27") && r.text.includes("Jordan Spackman met with Marcee McMullen"));
      const P = await import("@/lib/scriptWriter/passages");
      const seg = P.segmentTranscript(r.text);
      c.ok("…so a passage finder reads her turns with their speaker and time", seg.some((l) => l.speaker === "Marcee McMullen" && l.time === "00:13:48" && /feel lost/.test(l.text)) && seg.some((l) => l.speaker === "Jordan Spackman" && l.time === "00:32:27"));
      c.ok("speaker labels found: the glued one too, a one-off \"Summary\" is not", JSON.stringify(scrub.speakerLabels(OLD_FORMAT).sort()) === JSON.stringify(["Jordan Spackman", "Marcee McMullen"]), JSON.stringify(scrub.speakerLabels(OLD_FORMAT)));
      c.ok("splitTurns cuts a glued label (\"do.Jordan Spackman:\"), never a line without one", scrub.splitTurns("A.Jordan Spackman: B.Marcee McMullen: C", ["Marcee McMullen", "Jordan Spackman"]).join("|") === "A.|Jordan Spackman: B.|Marcee McMullen: C" && scrub.splitTurns("No labels here.", ["Jordan Spackman"]).join("|") === "No labels here.");
    }

    // =======================================================================
    c.head("4 · the line filters read the same names");
    {
      const lines = ["Jordan Spackman agreed to film the seniors story first", "Erica Walker referred her last spring", "Kyle Drillwright confirmed the shoot", "She left senior living for real estate"];
      const r = await gen.scrubOtherClients(f.clientId, lines);
      c.ok("scrubOtherClients: Jordan's and staff lines pass, a real other client's line goes", r.kept.join("|") === [lines[0], lines[2], lines[3]].join("|") && r.stripped === 1, r.kept.join(" | "));
      const m = await gen.otherClientScrubbers([f.clientId]);
      c.ok("otherClientScrubbers (the planning reader): the same answer", m.get(f.clientId)?.(lines).join("|") === [lines[0], lines[2], lines[3]].join("|"));
    }

    // =======================================================================
    c.head("5 · confidentiality is unchanged");
    {
      const r = await gen.scrubTranscriptForGeneration(f.clientId, " Jordan Spackman: Okay.Marcee McMullen: Between you and me, my brokerage is moving.Jordan Spackman: Got it.\nMarcee McMullen: Next topic please.");
      c.ok("a private phrase still takes its whole stored line (the private part can run across turns)", !r.text.includes("brokerage") && !r.text.includes("Got it.") && r.text.includes("Next topic please.") && r.reasons.phrase === 1, JSON.stringify(r.reasons));
    }

    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
