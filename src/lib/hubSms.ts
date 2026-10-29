// The one marker every automated staff text carries. Dependency-free on
// purpose: the sender (notify.ts) and the OpenPhone receiver (the echo guard
// in the webhook) both read it, and neither should pull the other in.
//
// "⚙️ Realtour Hub:" is what tells a teammate — and the webhook — that the
// hub wrote the text, not Kyle from the same number. Sep 11: the receiver now
// keys on it too, so the echo of a text the hub sent its own people is never
// logged as a conversation, never closes a task, and never counts as "we
// replied" on that teammate's thread.
export const HUB_SMS_PREFIX = "⚙️ Realtour Hub";
// The brand was spelled "RealTour" until Oct 12 2026 (Jordan: "Realtour").
// Every text already sent and logged carries the old tag, so the receiver and
// the reply queue recognise BOTH; only new texts use the new one.
export const HUB_SMS_PREFIXES = [HUB_SMS_PREFIX, "⚙️ RealTour Hub"] as const;

// ---- a team text, laid out for a phone -----------------------------------------
// Jordan, Oct 28 2026, with two screenshots of Harrison's thread (a shoot
// brief that ran as one block, a "Cull before edit —" alert): "make sure text
// messages are formatted nicer for larger team text message notifications".
// Every automated team text passes through here, so the shape is one rule:
//   · no long dashes (the house style). A long dash near the start is the
//     heading's break ("Cut approved — 538 Onward Ave") and becomes a line
//     break; any other becomes ", ";
//   · a client's quoted words ("…") open their own line;
//   · an inline numbered list ("1) … 2) …") puts each item on its own line;
//   · the closing link sits alone on the last line, with its label ("Finish it
//     here:") on the line above, the arrow before it dropped.
// Line breaks the sender already made are kept. `compact` (one item of a
// digest) uses single line breaks; a whole text gets a blank line before the
// link. Pure, no imports.
export function staffTextLayout(text: string, opts: { compact?: boolean } = {}): string {
  const gap = opts.compact ? "\n" : "\n\n";
  let t = (text ?? "").replace(/\r/g, "");
  // The heading's break: the first spaced long dash, within the first 60
  // characters and before any quote or line break.
  // A greeting ("Hey Harrison — …") keeps a comma instead.
  const head = /^([^\n“"]{2,60}?)[ \t]+[—–][ \t]+(?=\S)/.exec(t);
  if (head && !/^(?:hi|hey|hello)\b/i.test(head[1])) t = `${head[1].replace(/[.:,;]$/, "")}\n${t.slice(head[0].length)}`;
  t = t.replace(/[ \t]*—[ \t]*/g, ", ").replace(/[ \t]+–[ \t]+/g, ", ").replace(/–/g, "-").replace(/,\s*([.,:;!?])/g, "$1").replace(/,\s*$/gm, "");
  // A client's quoted words on their own line when a colon or a sentence's
  // end introduces them ("Jane Doe: “…”", "Kim has it.: “…”"); a quote inside
  // a sentence stays where it is.
  t = t.replace(/([^\s.:])(\.?)(:?)[ \t]*“/g, (m, c: string, dot: string, colon: string) => (dot || colon ? `${c}${dot || colon}\n“` : m));
  t = t.replace(/(^|\n)(“[^”\n]*”)[ \t]+(?=\S)/g, "$1$2\n");
  // An inline numbered list, one item a line.
  if (/(?:^|\s)1\) \S/.test(t) && /\s2\) \S/.test(t)) t = t.replace(/[ \t]+(?=\d{1,2}\) \S)/g, "\n");
  else t = t.replace(/:[ \t]+(?=1\) \S)/, ":\n");
  // The closing link alone on the last line, its label above it.
  const link = /[ \t]*(?:→[ \t]*)?(https?:\/\/\S+)\s*$/.exec(t);
  if (link && link.index > 0) {
    const before = t.slice(0, link.index);
    const label = /(^|[.!?)”\n])[ \t]*([^.!?\n“”]{1,48}:)$/.exec(before);
    t = label
      ? `${before.slice(0, label.index + label[1].length).trimEnd()}${gap}${label[2].trim()}\n${link[1]}`
      : `${before.trimEnd()}${gap}${link[1]}`;
  }
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A whole team text: the hub marker, then the words laid out for a phone. */
export function staffText(words: string): string {
  return `${HUB_SMS_PREFIX}: ${staffTextLayout(words)}`;
}

export function isHubSms(text: string | null | undefined): boolean {
  const t = (text ?? "").trimStart();
  return HUB_SMS_PREFIXES.some((p) => t.startsWith(p));
}

// The automated staff texts that predate the prefix — the upload-page digest,
// its 10 PM chaser and the one-time intro (src/lib/uploadDigest.ts, "Hi
// Jordan — RealTour Pilot here…"). They are known by the comms row they log
// right after sending (`source`), not by their wording, so the receiver's
// echo guard and the reply queue treat them exactly like a prefixed text:
// internal, answering nobody (reviewer, Sep 11).
export const HUB_SMS_SOURCES = ["upload-nag", "upload-digest", "upload-intro"] as const;
export function isHubSmsSource(source: string | null | undefined): boolean {
  return (HUB_SMS_SOURCES as readonly string[]).includes(source ?? "");
}

// The comms `source` the OpenPhone receiver stamps on the owner's reply to a
// hub text — "Approved", from his pocket, within two hours of one. Kept for
// the record; the reply queue skips it, because nobody at the office owes it
// an answer (reviewer, Sep 11).
export const HUB_REPLY_SOURCE = "hub-reply";

// The number an automated staff text can go to — a US/Canada line only,
// because the office OpenPhone line can't text anything else: Kim's +63
// roster phone passed the old "last ten digits" check, and her queued lines
// bounced off OpenPhone every five minutes for a week (Sep 3–10; review,
// Sep 15). Ten digits, or eleven starting with 1; anything else is "no
// number" to the sender (notify.ts), the Settings matrix and the save
// message alike, so the three can never disagree about who is textable.
// Returns the E.164 form plus the 10-digit key OpenPhone matching uses.
export function staffTextNumber(phone: string | null | undefined): { to: string; key: string } | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  const key = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null;
  return key ? { to: `+1${key}`, key } : null;
}
