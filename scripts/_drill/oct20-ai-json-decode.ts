// ---------------------------------------------------------------------------
// DRILL: AI ANSWERS WITH A LIST SENT AS TEXT (Oct 20 2026).
// @drill-run: conditions=react-server
//
// About one run in ten of topic banks, first drafts and script revisions came
// back with a nested list as a JSON STRING ("pillars": "[...]"), and three of
// Erica Walker's and Marcee McMullen's topic refills stored nothing because of
// it. integrations/ai.decodeStringifiedJson decodes it where the schema asks
// for a list or an object, in each shape seen live:
//
//   1. the list as a plain JSON string;
//   2. the string running on with a trailing comma ('[...],');
//   3. the string swallowing the keys after it ('[...], "gaps": [], ...');
//   4. a list nested inside a decoded one, also as a string;
// and leaves alone what it should: text that is not JSON, a string the schema
// wants as a string (even one that starts with "["), and a value already right.
//
// Pure: no database, no provider.
// ---------------------------------------------------------------------------
import { installNextStubs, makeChecker } from "./_harness";

installNextStubs();

async function main() {
  const c = makeChecker();
  const { decodeStringifiedJson } = await import("../../src/lib/integrations/ai");
  const { TOPIC_BANK_OUTPUT_SCHEMA } = await import("../../src/lib/contentPolicy/prompts");
  const decode = (pillars: unknown, extra: Record<string, unknown> = {}) => decodeStringifiedJson({ complete: true, pillars, gaps: [], ...extra }, TOPIC_BANK_OUTPUT_SCHEMA) as { pillars: unknown; gaps: unknown; complete: unknown };
  const list = [{ pillarName: "Buyer Strategy & Education", topics: [{ title: "Pre-approved is not ready \" ] } yet", description: "d", audienceNeed: "a", businessGoal: "b", intendedMessage: "m", sourceRef: null }] }];
  const text = JSON.stringify(list, null, 2);
  const firstTitle = (v: unknown) => (Array.isArray(v) ? (v[0] as { topics: { title: string }[] }).topics?.[0]?.title : undefined);

  c.head("1-4 · the shapes seen live");
  c.ok("a plain JSON string is decoded", firstTitle(decode(text).pillars) === list[0].topics[0].title);
  c.ok("…with a trailing comma (Marcee's Buyer Strategy refill)", firstTitle(decode(`${text},\n`).pillars) === list[0].topics[0].title);
  c.ok("…running on into the object's later keys (Erica's Move-Up refill)", firstTitle(decode(`${text},\n"gaps": [],\n"complete": true`).pillars) === list[0].topics[0].title);
  const nested = decode([{ pillarName: "A", topics: JSON.stringify(list[0].topics) }]);
  c.ok("a list nested in a list, also sent as text", firstTitle(nested.pillars) === list[0].topics[0].title);
  c.ok("the sibling keys are untouched", decode(text).complete === true && Array.isArray(decode(text).gaps));

  c.head("5 · what is left alone");
  c.ok("text that is not JSON stays as sent", decode("not json [").pillars === "not json [");
  const asString = decodeStringifiedJson({ title: "[B-roll] the kitchen" }, { type: "object", properties: { title: { type: "string" } } }) as { title: unknown };
  c.ok("a string the schema wants as a string, even starting with '[', stays a string", asString.title === "[B-roll] the kitchen");
  const right = decode(list);
  c.ok("a value already in the right shape is unchanged", JSON.stringify(right.pillars) === JSON.stringify(list));
  c.ok("an object where the schema wants a list is not forced", decode('{"pillarName": "A"}').pillars === '{"pillarName": "A"}');

  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
