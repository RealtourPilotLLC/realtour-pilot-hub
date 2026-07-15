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
  const parts = s.split(/(?<=[.!?\n])\s+/);
  const kept = parts.filter((p) => !MONEY.test(p));
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}
