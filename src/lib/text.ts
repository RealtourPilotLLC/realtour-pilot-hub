// Text hygiene for everything human-readable that flows into tasks, comms
// memory, and notifications. Inbound channels arrive dirty in channel-specific
// ways — Gmail snippets/bodies are HTML-entity-encoded ("&#39;" apostrophes),
// Slack escapes &/</>, Outlook mail carries zero-width BOMs — and the old
// mid-word .slice() caps left quotes ending like "can we make a few cha".
// Every helper here is safe on already-clean text (idempotent in practice).

/** Decode the HTML entities Gmail/Slack leave in message text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip invisible junk: zero-width spaces/joiners, BOMs, soft hyphens. */
export function stripInvisible(s: string): string {
  // U+200B–200D zero-widths, U+2060 word-joiner, U+FEFF BOM, U+00AD soft hyphen.
  return s.replace(/[​-‍⁠﻿­]/g, "");
}

/** One-call cleanup for inbound message text. */
export function cleanText(s: string): string {
  return stripInvisible(decodeEntities(s)).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Cap text at a word boundary with a real ellipsis instead of a mid-word chop.
 * "…make a few cha" → "…make a few…". Returns the text untouched when it fits.
 */
export function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, Math.max(1, max - 1));
  const cut = head.lastIndexOf(" ");
  // Only back up to the space when it doesn't eat most of the budget.
  return (cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd() + "…";
}

// HARD-CUT markers: quoted history below them is NOT line-prefixed, so it
// can't be filtered — everything from the marker down goes. Also covers
// signature/disclaimer boilerplate (its "received this in error" / "remove"
// wording false-triggers the keyword revision classifier).
const CUT_MARKERS: RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}/i, // Outlook
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^From:\s?.+@.+$/i, // Outlook top-posting header block
  /^_{6,}\s*$/, // Outlook divider
  /^-- ?$/, // RFC signature delimiter
  /^(confidentiality notice|disclaimer|notice of confidentiality)\b/i,
  /^this (e-?mail|message)( and any attachments)? (is|are|may contain)/i,
  /\breceived this (e-?mail|message|transmission) in error\b/i,
];
// Gmail attribution line. NOT a hard cut on its own: inline repliers write
// their answers between the "> " lines underneath it.
const GMAIL_ATTRIB = /^On .{5,120} wrote:\s*$/;

/**
 * Keep only the sender's OWN words from an email body. Drops the quoted thread
 * history ("On … wrote:" + "> …" lines, Outlook header blocks), signature /
 * disclaimer boilerplate, and sent-from lines — while PRESERVING inline
 * replies (unquoted answers interleaved with "> " quotes) and bottom-posted
 * replies (own words underneath the quote). Falls back to the full body only
 * when stripping leaves nothing at all.
 */
export function stripQuotedReply(body: string): string {
  let lines = body.split("\n");

  // 1) Hard cut at the first Outlook-style header / signature / disclaimer.
  const cutAt = lines.findIndex((l) => CUT_MARKERS.some((re) => re.test(l.trim())));
  if (cutAt >= 0) lines = lines.slice(0, cutAt);

  // 2) Gmail attribution: if the region below has "> " quotes AND substantial
  //    unquoted lines, it's an inline reply — keep the unquoted answers and
  //    drop only the quoted lines (step 3). Otherwise (plain top-post, or a
  //    client that quotes without ">" prefixes) cut at the attribution line.
  const attribAt = lines.findIndex((l) => GMAIL_ATTRIB.test(l.trim()));
  if (attribAt >= 0) {
    const below = lines.slice(attribAt + 1);
    const hasQuoted = below.some((l) => /^\s*>/.test(l));
    const hasOwnWords = below.some((l) => !/^\s*>/.test(l) && l.trim().length >= 3);
    if (!(hasQuoted && hasOwnWords)) lines = lines.slice(0, attribAt);
    else lines = lines.filter((l) => !GMAIL_ATTRIB.test(l.trim()));
  }

  // 3) Drop classic "> " quoted lines wherever they sit (top-post history,
  //    inline-reply quotes) — the sender's unquoted words survive in order.
  let head = lines.filter((l) => !/^\s*>/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  head = head.replace(/\n(sent from my \S+.*|get outlook for \S+.*)$/i, "").trim();
  // A short head ("Perfect!") IS the message — never replace real own-words
  // with quoted history: that fed our own outbound text to the revision
  // classifier and flipped delivered jobs on praise replies.
  return head.length > 0 ? head : body.trim();
}

/**
 * Drop sentences that talk money (amounts, invoices, refunds) — used when
 * client text lands on an EDITOR-visible task: creatives never see pricing.
 */
export function stripMoneySentences(s: string): string {
  const MONEY = /[$€£]\s?\d|\b(invoice|price|pricing|charge[ds]?|refund|discount|billing|payment|paid|owe[ds]?)\b/i;
  // Line by line, so a multi-line note keeps its headings, bullets and blank
  // lines — joining every sentence with a space turned the editor's copy of
  // a 3,000-character brief into one blob (Jordan, Sep 10: 632 Greenridge).
  return s
    .split("\n")
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((p) => !MONEY.test(p)).join(" ").replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Redact the FIGURE and keep the sentence — for titles and one-line summaries
 * on a non-owner screen, where dropping the whole sentence (above) would leave
 * an empty row. "Send Andrea's updated order with $750 credit applied" reads
 * "… with [amount] credit applied": Kyle still knows what to do, and the dollar
 * figure never lands on an ADMIN screen (audit5 kyle-home §5, Sep 8 — Jordan's
 * standing rule: ADMIN = full operations, no money anywhere). Catches "$750",
 * "$1,200.50", "$1.2k", "750 dollars", "1,200 USD", "50 bucks" — and, since
 * the Sep 8 review, money written without a symbol: "USD 750", "750$",
 * "price is 750", "price: 1,250", "credit of 750", "750 credit". A number
 * after a money word is left alone when a count noun follows it ("invoice
 * for 3 listings", "paid 2 days ago", "total of 45 photos"). Idempotent.
 */
const MONEY_WORD = "credit|refund|discount|price|pricing|charge[ds]?|invoice|owe[ds]?|paid|pay|fee|deposit|balance|cost|quoted?|bill(?:ed)?|total";
// "credit of 750", "price is 750", "price: 1,250", "owes 750" — but not a
// count: "invoice for 3 listings", "paid 2 days ago", "total of 45 photos".
const MONEY_WORD_THEN_NUMBER = new RegExp(
  `\\b((?:${MONEY_WORD})(?:\\s+(?:of|is|was|for|at|to|about|around))?(?:\\s*:\\s*|\\s+))` +
    // \b after the number: without it the engine backtracks "45 photos" to
    // "4" + "5 photos" and slips past the count-noun guard below.
    `\\d[\\d,]*(?:\\.\\d+)?(?:\\s?[kK](?![a-z]))?\\b` +
    `(?!\\s*(?:photos?|pics?|pictures?|images?|videos?|clips?|reels?|shoots?|listings?|files?|jobs?|photographers?|editors?|clients?|batter(?:y|ies)|cards?|drives?|min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?|am|pm|sq|st|nd|rd|th)\\b)`,
  "gi",
);
// "750 credit", "750 refund", "1,250 fee" — the figure in front of the word.
const NUMBER_THEN_MONEY_WORD = /\b\d[\d,]*(?:\.\d+)?(?:\s?[kK](?![a-z]))?(?=\s+(?:credit|refund|discount|fee|deposit|off)\b)/gi;

export function scrubMoney(s: string): string {
  if (!s) return s;
  return s
    .replace(/[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM](?![a-z]))?/g, "[amount]")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|usd|bucks)\b/gi, "[amount]")
    // Symbol or code BEFORE the number ("USD 750", "US$ 750") and AFTER it ("750$").
    .replace(/\b(?:usd|us\$)\s?\d[\d,]*(?:\.\d+)?(?:\s?[kK](?![a-z]))?/gi, "[amount]")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?\$(?!\d)/g, "[amount]")
    .replace(MONEY_WORD_THEN_NUMBER, "$1[amount]")
    .replace(NUMBER_THEN_MONEY_WORD, "[amount]")
    .replace(/(\[amount\])(?:\s*[-–—]\s*\[amount\])+/g, "$1");
}
