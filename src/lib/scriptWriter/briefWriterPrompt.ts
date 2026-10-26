// ---------------------------------------------------------------------------
// SUMMARY -> SCRIPT, THE WAY JORDAN'S SCRIPTING GPT DID IT (Oct 26 2026).
// Jordan: "do the call, have chatGPT analyze the transcript, and extract the
// video topics chosen, and a detailed summary of what the agent said about each
// one. And then I would copy that summary, and send it to my custom Scripting
// GPT, and it would create the script for each one."
//
// THE STANDARD IS HIS GPT'S OWN RULES (houseReference.PERSONAL_BRANDING_GENERATOR,
// pasted that evening: "The scripting needs to just follow the rules I sent
// earlier today that my custom GPT uses"), with its files (Anatomy of the
// Script, Scripting Success, 10 Laws of Branding) and his GPT's scripts for
// Erica Walker's October as what good looks like (houseReference.JORDAN_GPT_SCRIPTS,
// 69 to 73 words; never shown when writing for Erica herself).
//
// WHY THE HUB'S DRAFTS FELL SHORT (Jordan: "the hub is taking the transcript
// and the agent's words too literally"): Erica's October drafts quoted her
// phrases from the call ("I'll be the calm resource", "Build the church for
// Easter Sunday"), strung every named detail together ("At Helings at Sussex
// ... 6,000 square feet") and ran 82 to 115 words, where his GPT kept her
// stories and opinions and said them in fresh, plain spoken lines. So the
// writer reads the summary for facts and stories, not for wording (the
// agent's verbatim lines are left out of its copy, briefWriter.ts), and only
// the hub's mechanics are added after his rules. Direct to camera only: a
// skit stays on its own writer (contentGeneration.routeScriptDraft). Shared by
// the server only through briefWriter.ts.
// ---------------------------------------------------------------------------
import { ANATOMY_OF_THE_SCRIPT, PERSONAL_BRANDING_GENERATOR, SCRIPTING_SUCCESS, TEN_LAWS_OF_BRANDING } from "./houseReference";

/**
 * Length: his rules target about 55 to 75 spoken words (hook + three talking
 * points + close); Jordan: "I just want them to be less than 100 words". The
 * writer still drafted 78 to 95 from Erica's summaries, so a script over `cut`
 * is sent back once or twice to come in nearer `aim` (briefWriter.fitToLength);
 * `max` is the line it never crosses.
 */
export const LENGTH = { aim: 70, cut: 85, max: 99 } as const;

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
    "You are Realtour Pilot's Scripting GPT, as configured by Jordan Spackman. Your instructions follow, then the files you were given. They are the standard for every script.",
    `=== YOUR INSTRUCTIONS ===\n${PERSONAL_BRANDING_GENERATOR}`,
    `=== FILE: THE ANATOMY OF THE SCRIPT ===\n${ANATOMY_OF_THE_SCRIPT}`,
    `=== FILE: SCRIPTING SUCCESS ===\n${SCRIPTING_SUCCESS}`,
    `=== FILE: 10 LAWS OF BRANDING ===\n${TEN_LAWS_OF_BRANDING}`,
    `=== HOW THE HUB HANDS YOU THE WORK ===
- One video at a time. The strategy call was already processed: the topics are chosen, and for this one you get a summary of what the agent said about it (from the call transcript or their written answers), their content strategy, their stated priority for the month, the month's other chosen videos and scripts Jordan liked. Write that one script; no batch header and no Strategic Batch Notes.
- The summary is your source for facts, stories and opinions, not for wording. Keep the agent's point, their real story and what makes it theirs, then say it the way the scripts under "what good looks like" do: fresh, short, natural spoken lines. Don't copy the agent's sentences from the call, don't string together every detail they mentioned, and leave out names (builders, communities, streets, people) unless the viewer needs one to follow the video.
- An idea the summary marks as Jordan's or the strategist's is not the agent's experience. What it lists as not established stays out.
- These are monthly personal-brand videos, never a listing tour.
- Length: about 55 to 75 spoken words (hook + three talking points + close), and never 100 or more. The shape of the scripts under "what good looks like": a one-sentence hook, each talking point one or two short sentences carrying one idea, a close of one or two lines. A summary holds more than one video needs: use only the details that carry this video's one idea.
- Never write an em dash or an en dash. Never mention the video's length or seconds.
- Answer in the fields given: title, category, hook, points (exactly three: the rehook, the build, the payoff), close, captionCta, production (null unless it is genuinely useful).`,
  ].join("\n\n");
}

export function briefWriterUser(o: {
  clientName: string;
  briefText: string;
  strategy: string | null;
  voice: string | null;
  /** Jordan's Scripting GPT scripts from this workflow (never the client's own). */
  good: { title: string; text: string }[];
  /** The agent's main request for the month (the month summary), for the buyer and seller balance. */
  priority?: string | null;
  examples: { title: string; text: string }[];
  otherTopics: string[];
  skit: boolean;
}): string {
  return [
    `CLIENT: ${o.clientName}`,
    o.strategy ? `THEIR CONTENT STRATEGY (for audience, market, positioning and pillars):\n${o.strategy}` : "",
    o.voice ? `HOW THEY SOUND:\n${o.voice}` : "",
    o.priority ? `THEIR STATED PRIORITY THIS MONTH (buyer and seller balance):\n${o.priority}` : "",
    o.good.length ? `WHAT GOOD LOOKS LIKE: SCRIPTS JORDAN'S SCRIPTING GPT WROTE FOR ANOTHER AGENT FROM HER CALL SUMMARY (69 to 73 spoken words each; this tightness, this shape and this plain, direct voice; never reuse their content):\n${o.good.map((e, i) => `${i + 1}. ${e.title}\n${e.text}`).join("\n\n")}` : "",
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

/** The second pass when a script runs over LENGTH.cut: the same writer, its own script, its count, back nearer the aim. */
export function fitInstruction(words: number, skit: boolean): string {
  const counted = `${words} spoken words (hook, three talking points and close${skit ? "; speaker names and stage directions not counted" : ""})`;
  return `YOUR SCRIPT ABOVE IS ${counted}. That runs long: your instructions aim for about 55 to 75, and it is never ${LENGTH.max + 1} or more. Bring it nearer ${LENGTH.aim}: keep the one idea and the strongest real detail, tighten every line, drop what repeats, explains or lists. Keep the hook's idea and the close's job.`;
}
