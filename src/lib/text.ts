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

/**
 * Slack mrkdwn escape for text WE compose into a DM: Slack reads a bare "<"
 * as link/mention markup and "&" as an entity start, so a client's "<3" or
 * "photos & video" quoted into a mention DM would otherwise arrive mangled
 * (Sep 15). Only these three; everything else Slack shows as typed.
 */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

// ---------------------------------------------------------------------------
// OUR MONEY, NOT THE MARKET'S (Oct 5 2026).
//
// The rule is "creatives never see OUR pricing" — what a client paid us, our
// fees, invoices, refunds and discounts. The old test dropped every sentence
// with "price", "pricing", "payment" or any "$<digit>" in it, and our clients
// are real estate agents: their approved scripts, topics and strategies talk
// about list prices, pricing strategy, down payments and "$1M price points"
// all day (87 times in the imported strategies alone). A client-approved hook
// — "The first weekend decides your price." — reached the editor as an empty
// Hook. So this drops only a sentence in OUR billing language.
//
// ALWAYS ours, whatever else the sentence says:
//   · invoice / refund / discount / billing / "bill her", owe / owes / owed,
//     "quoted her…", a deposit (not an earnest-money, security or escrow one),
//     "pay for / pay us", "paid us / paid in full", a balance due, a price
//     list, a payment app or card, what a client has spent with us;
//   · our own price words: "our pricing", "VIP pricing", "friends and family
//     rates", and "N% off" / "N percent off".
// Ours UNLESS the sentence is about the market (HOA, closing costs, a list or
// asking price, a down payment, a mortgage, rent, property tax, earnest money,
// a price point, "$2M homes"):
//   · a fee or a charge (not an HOA or closing fee, "in charge of", "charge
//     up"), paid / unpaid (not "paid off"), a payment (not a down, mortgage or
//     monthly payment);
//   · a money figure BELOW real-estate scale ($750, $1.5k, 175 dollars) — a
//     listing's $450,000 or $1.2M is the market's number — or any figure tied
//     to a package, plan, subscription, retainer or bundle, or billed per
//     month / per year ("the $12,000/yr deal");
//   · a bare number right after price / pricing / total / deposit / balance /
//     cost / rate below that scale ("Price: 325", "total 450") — never a count
//     ("total of 45 photos"), a percentage or a timestamp ("balance at 0:12").
// Callers decide WHAT to scrub: client-approved script text and topic titles
// are never passed through here at all (edit page, portal, outputBriefs).
// ---------------------------------------------------------------------------
const OUR_BILLING_ALWAYS: RegExp[] = [
  /\binvoic(?:e|es|ed|ing)\b/i,
  /\brefund(?:s|ed|ing|able)?\b/i,
  /\bdiscount(?:s|ed)?\b/i,
  /\bbill(?:ing|ed)\b|\bbill\s+(?:her|him|them|the\s+client|it|for)\b/i,
  /\bow(?:e|es|ed|ing)\b(?!\s+it\s+to\b)(?!\s+(?:on|against)\s+(?:the|their|your|his|her)\s+(?:mortgage|loan|house|home)\b)/i,
  /\bquot(?:ed|ing)\b(?=\s+(?:her|him|them|you|us|the\s+client|a\s+price|at\b|for\b|[$€£\d]))|\b(?:price|our)\s+quote\b/i,
  /(?<!\b(?:earnest|money|security|escrow|faith|rental|rent)\s)\bdeposits?\b/i,
  /\bpay(?:s|ing)?\s+(?:for|you|us|extra|more|the\s+(?:fee|invoice|bill|balance|difference))\b/i,
  /\bpaid\s+(?:us|you|in\s+full|the\s+(?:invoice|bill|balance|deposit))\b/i,
  /\bbalance\s+(?:due|owed|owing|left|remaining)\b|\b(?:outstanding|remaining|open|account|unpaid)\s+balance\b/i,
  /\b(?:price|pricing)\s+(?:list|sheet|menu)\b/i,
  /\b(?:our|my|vip|special|discounted|package|bundle|member|loyalty|returning[- ]client|new[- ]client|family|founding)\s+(?:pricing|prices?|rates?)\b/i,
  /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent|per\s?cent)\s+off\b/i,
  /\b(?:venmo|zelle|paypal|stripe|quickbooks|cash\s?app|credit\s+card|debit\s+card|card\s+on\s+file|receipts?)\b/i,
  /\bspen[dt]\w*\b.{0,40}\bwith (?:us|you)\b|\blifetime\s+(?:spend|value)\b|\brevenue\b/i,
];
const OUR_BILLING_SOFT: RegExp[] = [
  /(?<!\b(?:hoa|closing|condo|association|transfer|lender|origination|attorney|title|escrow|mortgage|application)\s)\bfees?\b/i,
  /(?<!\b(?:in|take|took|takes|taking)\s)\b(?:sur)?charge[ds]?\b(?!\s+(?:of|up)\b)/i,
  /\b(?:un|pre)?paid\b(?!\s+off\b)/i,
  /(?<!\b(?:down|mortgage|monthly|house|home|rent|rental|loan|car|lower|higher|interest|principal|escrow|hoa)\s)\bpayments?\b/i,
];
/** The sentence is about the MARKET's money — a home, a loan, the HOA. */
const MARKET_MONEY = /\b(?:hoa|closing\s+costs?|list(?:ing)?\s+prices?|asking\s+prices?|sales?\s+prices?|sold\s+(?:for|at)|down\s+payments?|mortgages?|earnest\s+money|property\s+tax(?:es)?|interest\s+rates?|rent|rents|rental|price\s+points?|appraise[ds]?|appraisal)\b/i;
/** Below this a money figure is ours (a reel, a rush fee, a package); at or above it, the market's. */
const OUR_MONEY_CEILING = 10_000;
const MONEY_FIGURES: RegExp[] = [
  // $750 · $1,250.50 · $1.5k · $1.2M · £300 · $450 thousand
  /[$€£]\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|m|mm|mil|million|thousand|b|bn|billion)\b)?/gi,
  // 175 dollars · 2k USD · 50 bucks
  /\b(\d[\d,]*(?:\.\d+)?)\s?(k|m|million|thousand)?\s?(?:dollars?|usd|bucks)\b/gi,
  // USD 750 · US$ 750
  /\b(?:usd|us\$)\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|m|million|thousand)\b)?/gi,
  // 750$
  /\b(\d[\d,]*(?:\.\d+)?)()\s?\$(?!\d)/g,
];
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
/** Our products. "marketing plan", "floor plan", "business plan" and "game plan" are not. */
const OUR_PRODUCT_WORDS = /\b(?:packages?|(?<!\b(?:marketing|floor|business|game|staging)\s)plans?|subscriptions?|retainers?|bundles?)\b/i;
/** Right after a figure: the market's ("$2M homes", "the $750K range"). */
const MARKET_AFTER_FIGURE = /^\s*(?:\+\s*)?(?:homes?|houses?|listings?|properties|condos?|townhomes?|townhouses?|price\s+points?|range|market|sales?)\b/i;
/** Right after a figure: billed again and again ("/yr", "a month", "monthly"). */
const RECURRING_AFTER_FIGURE = /^\s*(?:\/\s?(?:yr|year|mo|mth|month|wk|week)\b|(?:per|a|an|each|every)\s+(?:year|month|week)\b|monthly\b|annually\b|yearly\b|weekly\b)/i;
// "Price: 325", "total 450", "cost is 95", "balance of 300" — a bare figure
// right after one of OUR words. Not a count ("total of 45 photos"), not a
// percentage ("rate of 6.5%"), not a timestamp ("balance at 0:12").
const WORD_THEN_FIGURE = new RegExp(
  `\\b(?:price[ds]?|pricing|total|deposit|balance|costs?|rate)\\b(?:\\s+(?:of|is|was|will\\s+be|would\\s+be|for|at|to|about|around|comes\\s+to|came\\s+to))?(?:\\s*[:=]\\s*|\\s+)(?:[$€£]\\s?)?` +
    `(\\d[\\d,]*(?:\\.\\d+)?)(\\s?[kK](?![a-z]))?\\b` +
    `(?![:.]\\d)(?!\\s*(?:%|percent|per\\s?cent|photos?|pics?|pictures?|images?|videos?|clips?|reels?|shoots?|listings?|files?|jobs?|photographers?|editors?|clients?|bed(?:room)?s?|bath(?:room)?s?|sq|square|acres?|batter(?:y|ies)|cards?|drives?|min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?|years?|am|pm|st|nd|rd|th)\\b)`,
  "gi",
);

/** Does this sentence talk OUR money (see the block above)? Exported so the rule can be tested as one. */
export function mentionsOurBilling(sentence: string): boolean {
  if (OUR_BILLING_ALWAYS.some((re) => re.test(sentence))) return true;
  // Everything below is ours only when the sentence is not about the market.
  if (MARKET_MONEY.test(sentence)) return false;
  if (OUR_BILLING_SOFT.some((re) => re.test(sentence))) return true;
  for (const re of MONEY_FIGURES) {
    re.lastIndex = 0;
    for (let m = re.exec(sentence); m; m = re.exec(sentence)) {
      const value = Number((m[1] ?? "").replace(/,/g, "")) * (SCALE[(m[2] ?? "").toLowerCase()] ?? 1);
      if (!Number.isFinite(value)) continue;
      const after = sentence.slice(m.index + m[0].length);
      if (MARKET_AFTER_FIGURE.test(after)) continue;
      if (value < OUR_MONEY_CEILING || OUR_PRODUCT_WORDS.test(sentence) || RECURRING_AFTER_FIGURE.test(after)) return true;
    }
  }
  WORD_THEN_FIGURE.lastIndex = 0;
  for (let m = WORD_THEN_FIGURE.exec(sentence); m; m = WORD_THEN_FIGURE.exec(sentence)) {
    const value = Number((m[1] ?? "").replace(/,/g, "")) * (m[2] ? 1e3 : 1);
    if (Number.isFinite(value) && value < OUR_MONEY_CEILING) return true;
  }
  return false;
}

/**
 * Drop the sentences that talk OUR money — used when client-originated free
 * text (an order note, a revision message, the Aryeo customer note) or an
 * office instruction lands on a creative's screen. Real-estate talk stays;
 * see mentionsOurBilling. Never call this on a client-approved script.
 */
export function stripMoneySentences(s: string): string {
  // Line by line, so a multi-line note keeps its headings, bullets and blank
  // lines — joining every sentence with a space turned the editor's copy of
  // a 3,000-character brief into one blob (Jordan, Sep 10: 632 Greenridge).
  return s
    .split("\n")
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((p) => !mentionsOurBilling(p)).join(" ").replace(/[ \t]{2,}/g, " ").trimEnd())
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
