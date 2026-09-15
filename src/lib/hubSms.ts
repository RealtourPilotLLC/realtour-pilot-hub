// The one marker every automated staff text carries. Dependency-free on
// purpose: the sender (notify.ts) and the OpenPhone receiver (the echo guard
// in the webhook) both read it, and neither should pull the other in.
//
// "⚙️ RealTour Hub:" is what tells a teammate — and the webhook — that the
// hub wrote the text, not Kyle from the same number. Sep 11: the receiver now
// keys on it too, so the echo of a text the hub sent its own people is never
// logged as a conversation, never closes a task, and never counts as "we
// replied" on that teammate's thread.
export const HUB_SMS_PREFIX = "⚙️ RealTour Hub";

export function isHubSms(text: string | null | undefined): boolean {
  return (text ?? "").trimStart().startsWith(HUB_SMS_PREFIX);
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
