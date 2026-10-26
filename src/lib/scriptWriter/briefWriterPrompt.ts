// ---------------------------------------------------------------------------
// SUMMARY -> SCRIPT, THE WAY JORDAN'S SCRIPTING GPT DID IT (Oct 26 2026).
// Jordan: "do the call, have chatGPT analyze the transcript, and extract the
// video topics chosen, and a detailed summary of what the agent said about each
// one. And then I would copy that summary, and send it to my custom Scripting
// GPT, and it would create the script for each one." His scripts from that
// flow (Erica Walker, October 2026) ran 69 to 73 spoken words: a hook, three
// talking points (re-hook, build-up, payoff), a close, a caption CTA. That is
// the length to be near (Jordan: "It doesnt need to be a set 69-73 words ...
// that's not a firm rule; I just want them to be less than 100 words"): about
// 70, shown to the writer as his own five scripts
// (houseReference.JORDAN_GPT_SCRIPTS); only a script of 100 words or more goes
// back to be cut (briefWriter.fitToLength).
//
// The writer reads ONE topic's summary (briefFormat.ts), never the raw call,
// with the GPT's own instructions and files as the standard
// (houseReference.ts). The hub's standing rules that came after the GPT are
// added at the end and win where they differ: no dashes, under 100 spoken
// words (about 70 is the feel), close = a call to action or a callback,
// nothing invented. Shared by
// the server only through briefWriter.ts.
// ---------------------------------------------------------------------------
import { ANATOMY_OF_THE_SCRIPT, GPT_CONFIGURATION, GPT_SYSTEM_INSTRUCTIONS, HOUSE_EXAMPLE_SCRIPTS, SCRIPTING_SUCCESS, TEN_LAWS_OF_BRANDING } from "./houseReference";

/**
 * Jordan's length: under 100 spoken words (hook + three talking points +
 * close), "not a firm rule" beyond that; his Scripting GPT's scripts (about 70)
 * are the feel. Only a script of 100 or more is sent back to be cut.
 */
export const LENGTH = { aim: 70, max: 99 } as const;

export const BRIEF_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "category", "hook", "points", "close", "captionCta", "production"],
  properties: {
    title: { type: "string", description: "The video's title." },
    category: { type: "string", description: "The video's category (the client's pillar, or a short category in the style of the examples)." },
    hook: { type: "string", description: "HOOK: the scroll-stopping first line(s), spoken." },
    points: {
      type: "array",
      items: { type: "string" },
      description: "Exactly three talking points, spoken: 1 the re-hook (adds something new, never restates the hook), 2 the build-up, 3 the payoff.",
    },
    close: { type: "string", description: "CLOSE: a call to action or a callback to the hook, whichever the message calls for. Spoken." },
    captionCta: { type: ["string", "null"], description: "Optional caption CTA (written under the post, not spoken)." },
    production: { type: ["string", "null"], description: "Optional one-line production note (visuals, B-roll) when the summary or the strategist suggested one; null otherwise. Never spoken." },
  },
} as const;

export const SKIT_NOTE = `THIS VIDEO IS A SKIT. Write it as the scene the client acts out, in the same five parts: the HOOK is the opening line or moment of the bit; the three talking points are its beats (set-up, escalation, turn), each the line(s) spoken, with the speaker named when someone else speaks ("Husband (off camera): ..."); the CLOSE lands the point in the client's own voice. Keep the bit to one clear premise and near the length of the talking-to-camera scripts: under 100 spoken words, counting only the lines said out loud (speaker names and stage directions do not count). The point of the skit is the trust and value message the summary gives; the comedy carries it.`;

export function briefWriterSystem(): string {
  return [
    "You are Realtour Pilot's Scripting GPT, as configured by Jordan Spackman. Your configuration and instructions follow, then the files you were given. They are the standard for every script.",
    `=== YOUR CONFIGURATION ===\n${GPT_CONFIGURATION}`,
    `=== YOUR SYSTEM INSTRUCTIONS ===\n${GPT_SYSTEM_INSTRUCTIONS}`,
    `=== FILE: THE ANATOMY OF THE SCRIPT ===\n${ANATOMY_OF_THE_SCRIPT}`,
    `=== FILE: SCRIPTING SUCCESS ===\n${SCRIPTING_SUCCESS}`,
    `=== FILE: 10 LAWS OF BRANDING ===\n${TEN_LAWS_OF_BRANDING}`,
    `=== FILE: EXAMPLE SCRIPTS (Matthew Hutton, March 2026, as sent) ===\n${HOUSE_EXAMPLE_SCRIPTS}`,
    `=== HOW THIS RUNS NOW (these win where they differ from the above) ===
- You are given ONE chosen topic's summary of what the agent said (from their strategy call or their written answers), the agent's strategy and voice, and a few scripts Jordan approved and sent. Write that one script from the summary. Topic extraction already happened: the topic is chosen.
- These are monthly personal-brand videos, not listing videos. Use the files' craft (the hook, the re-hook, the middle, story, the close), never a property tour, a price list of features or a "private tour" close.
- Format: Title, Category, HOOK, exactly three talking points (re-hook, build-up, payoff), CLOSE, optional Caption CTA. The Matthew Hutton example file shows four talking points and runs longer; here it is three, at the length below.
- Choose. A summary holds more than one video's worth: it is a menu, not a checklist. Build the script on the single strongest idea in it and the one real example or detail that proves it, the way a strategist would; leave the rest out. Three named items at most in any list.
- Length: under 100 spoken words (hook + three talking points + close), always. Beyond that it is not a set count: Jordan's own scripts from this workflow, shown as "what good looks like", ran about 70, and that tight feel is the aim; let the idea decide. The hook is one sentence of about 8 to 15 words. Each talking point is one sentence of about 10 to 17 words (two only when both are very short). The close is one or two short sentences, about 12 to 22 words. A real story fits by telling only the beats that matter. Short but empty is as wrong as long and padded: every line moves the viewer forward.
- Use what the agent actually said: their point, the specific things they named, their real story with its real details, their own words where they are strong. A summary item marked as the strategist's idea is not the agent's experience: use it only as an idea, never as something that happened to them. Never invent a story, a number, an outcome, a motivation or a market claim the summary does not give; what the summary lists as not established stays out. A guess stays a guess.
- Personal stories keep their real order of events. Leave out what a buyer or seller does not need to hear (a live client's name, an address, commission terms).
- If the summary flags an overlap with another video, make this one's angle the distinct one it names.
- The close is a call to action or a callback to the hook, whichever this message calls for.
- Never write an em dash or an en dash. Never mention the video's length or seconds. No greetings, no "Hi, I'm", no "In this video".`,
  ].join("\n\n");
}

export function briefWriterUser(o: {
  clientName: string;
  briefText: string;
  strategy: string | null;
  voice: string | null;
  /** Jordan's Scripting GPT scripts from this workflow (never the client's own). */
  good: { title: string; text: string }[];
  examples: { title: string; text: string }[];
  otherTopics: string[];
  skit: boolean;
}): string {
  return [
    `CLIENT: ${o.clientName}`,
    o.strategy ? `THEIR CONTENT STRATEGY (for audience, market, positioning and pillars):\n${o.strategy}` : "",
    o.voice ? `HOW THEY SOUND:\n${o.voice}` : "",
    o.good.length ? `WHAT GOOD LOOKS LIKE: SCRIPTS JORDAN'S SCRIPTING GPT WROTE FROM THIS SAME WORKFLOW FOR ANOTHER AGENT (about 70 spoken words each; this tightness, this shape and this plain, direct voice; never reuse their content):\n${o.good.map((e, i) => `${i + 1}. ${e.title}\n${e.text}`).join("\n\n")}` : "",
    o.examples.length ? `SCRIPTS JORDAN APPROVED AND SENT TO OTHER CLIENTS (voice only; never reuse their content):\n${o.examples.map((e, i) => `${i + 1}. ${e.title}\n${e.text}`).join("\n\n")}` : "",
    o.otherTopics.length ? `THE OTHER VIDEOS IN THIS MONTH (stay distinct from them):\n${o.otherTopics.map((t) => `- ${t}`).join("\n")}` : "",
    o.skit ? SKIT_NOTE : "",
    `THE SUMMARY OF WHAT ${o.clientName.toUpperCase()} SAID ABOUT THIS TOPIC:\n${o.briefText}`,
    "Write the script for this topic.",
  ].filter(Boolean).join("\n\n");
}

/** A script as the writer reads it back (the fit and revise prompts). */
export function scriptAsText(o: { title?: string | null; hook: string; points: string[]; close: string; captionCta?: string | null }): string {
  return [o.title ? `Title: ${o.title}` : "", `HOOK: ${o.hook}`, ...o.points.map((p, i) => `TALKING POINT ${i + 1}: ${p}`), `CLOSE: ${o.close}`, o.captionCta ? `Caption CTA: ${o.captionCta}` : ""].filter(Boolean).join("\n");
}

/** The second pass when a script runs 100 words or more: the same writer, its own script, its count, under 100. */
export function fitInstruction(words: number, skit: boolean): string {
  const counted = `${words} spoken words (hook, three talking points and close${skit ? "; speaker names and stage directions not counted" : ""})`;
  return `YOUR SCRIPT ABOVE IS ${counted}. It must be under 100, nearer ${LENGTH.aim} like Jordan's. Cut it: keep the one idea and the strongest real detail, tighten every line, drop what repeats, explains or lists. Keep the hook's idea and the close's job.`;
}
