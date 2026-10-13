// ---------------------------------------------------------------------------
// DID THE CLIENT ASK FOR IT TO BE PRIVATE? (Oct 14 2026)
//
// Jordan, Oct 13: "Nothing in the content strategy should be confidential.
// The only thing that should be confidential is if they say so on the
// strategy call." Most facts marked confidential were marked because they
// sounded sensitive (a deal, money, a market), not because the client asked.
// This is the one test for "they asked": a fact's body, or the call excerpt
// it was quoted from, carries an explicit request. Pure, so the fix script
// (scripts/_fix/oct14/unmark-confidential-facts.ts) and its drill share it.
// ---------------------------------------------------------------------------

const APOS = "['’]?";

/** An explicit request to keep something private or off camera, in the words people use. */
export const EXPLICIT_PRIVATE_REQUEST_RE = new RegExp(
  [
    `\\bdon${APOS}t share\\b`,
    "\\bdo not share\\b",
    "\\boff the record\\b",
    "\\bbetween us\\b",
    "\\bkeep (?:this|it) (?:private|between)\\b",
    "\\bconfidential",
    "\\bnot for (?:the )?(?:video|camera|content)\\b",
    `\\bdon${APOS}t put (?:this|that) (?:in|on)\\b`,
  ].join("|"),
  "i",
);

/** The texts of a fact's stored excerpt (excerptJson: [{ text }]), tolerant of any shape. */
export function excerptTexts(excerptJson: string | null | undefined): string[] {
  if (!excerptJson) return [];
  try {
    const v = JSON.parse(excerptJson) as unknown;
    const list = Array.isArray(v) ? v : [v];
    return list.map((e) => (e && typeof e === "object" && typeof (e as { text?: unknown }).text === "string" ? (e as { text: string }).text : "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** The phrase that shows the client asked for privacy, in the body or an excerpt, or null. */
export function explicitPrivateRequest(body: string, excerptJson?: string | null): string | null {
  for (const t of [body, ...excerptTexts(excerptJson)]) {
    const m = EXPLICIT_PRIVATE_REQUEST_RE.exec(t);
    if (m) return m[0];
  }
  return null;
}
