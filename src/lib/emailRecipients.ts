// ---------------------------------------------------------------------------
// WHO AN EMAIL REPLY GOES TO (Kyle, Oct 29 2026: "Add an option to cc or bcc
// on email replies, so that I can add myself to the email chain ... I think
// the email replies to only the person who emailed us, disregarding the
// current email chain (I noticed this when emailing Mike Flatley back)").
//
// He was right: the hub's reply went To the newest outside sender alone, so
// everyone else on Mike's "913 Lakeview" thread fell off it. A reply now goes
// to the whole chain by default, the way Reply all does in Gmail: To the
// person who wrote last, plus everyone they wrote To; Cc everyone they copied.
// Never us (our own domain, the connected mailboxes), never twice, and never
// anyone who was not on that message. A person can add Cc and Bcc addresses
// (and themselves, one tap) before Send.
//
// Pure: no reads, no sends. lib/integrations/google builds the headers from
// this, app/emailActions validates what a person typed with it.
// ---------------------------------------------------------------------------

/** At most this many addresses in each of To (besides the sender), Cc and Bcc. */
export const MAX_EXTRA_RECIPIENTS = 10;

const ADDRESS = /^[^@\s,;<>"'()[\]\\]+@[^@\s,;<>"'()[\]\\]+\.[^@\s,;<>"'()[\]\\]+$/;

/** One clean address, lower case, or null (a header break, a list, a display name, junk). */
export function cleanAddress(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || /[\r\n]/.test(v) || v.length > 254) return null;
  return ADDRESS.test(v) ? v : null;
}

/** The addresses in one To/Cc header ("Mike F" <mike@x.com>, "Doe, Jane" <j@y.com>, a@b.com). */
export function splitAddressList(header: string | null | undefined): string[] {
  const value = (header ?? "").replace(/[\r\n]+/g, " ");
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: string[] = [];
  for (const p of parts) {
    const inAngle = p.match(/<([^>]*)>/);
    const a = cleanAddress(inAngle ? inAngle[1] : p.replace(/"[^"]*"/g, " "));
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

export type ReplyAllRecipients = {
  /** everyone else the message was To (the sender is the reply's own To) */
  alsoTo: string[];
  /** everyone it copied */
  cc: string[];
};

/**
 * Reply all, from the message being answered. `ours`: addresses that are us
 * (the connected mailboxes); anything at `ourDomain` is us too. The sender
 * (`to`) is never repeated. Pure.
 */
export function replyAllRecipients(input: { to: string; toHeader: string; ccHeader: string; ours: string[]; ourDomain: string }): ReplyAllRecipients {
  const ours = new Set(input.ours.map((o) => o.trim().toLowerCase()));
  const isUs = (a: string) => ours.has(a) || a.endsWith(`@${input.ourDomain.toLowerCase()}`);
  const seen = new Set([input.to.trim().toLowerCase()]);
  const take = (list: string[]) => {
    const out: string[] = [];
    for (const a of list) {
      if (isUs(a) || seen.has(a)) continue;
      seen.add(a);
      if (out.length < MAX_EXTRA_RECIPIENTS) out.push(a);
    }
    return out;
  };
  const alsoTo = take(splitAddressList(input.toHeader));
  const cc = take(splitAddressList(input.ccHeader));
  return { alsoTo, cc };
}

/**
 * What a person typed into Cc or Bcc: one address per entry or comma
 * separated. Every one must be an address; the first that isn't is named.
 * Duplicates, and anyone already on the reply (`already`), are dropped.
 */
export function parseTypedRecipients(
  typed: readonly string[] | string | null | undefined,
  already: readonly string[] = [],
): { ok: true; list: string[] } | { ok: false; message: string } {
  const raw = (Array.isArray(typed) ? typed : [typed ?? ""]).flatMap((t) => String(t ?? "").split(/[,;\s]+/)).map((t) => t.trim()).filter(Boolean);
  const have = new Set(already.map((a) => a.toLowerCase()));
  const list: string[] = [];
  for (const t of raw) {
    const a = cleanAddress(t.replace(/^<|>$/g, ""));
    if (!a) return { ok: false, message: `"${t.slice(0, 80)}" isn't an email address. Nothing was sent.` };
    if (have.has(a)) continue;
    have.add(a);
    list.push(a);
  }
  if (list.length > MAX_EXTRA_RECIPIENTS) return { ok: false, message: `That's more than ${MAX_EXTRA_RECIPIENTS} addresses. Nothing was sent.` };
  return { ok: true, list };
}

/** "mike@x.com, cc javier@y.com and kyle@z.com" for the sent line and the job timeline. Pure. */
export function recipientWords(r: { to: string; alsoTo?: readonly string[]; cc?: readonly string[]; bcc?: readonly string[] }): string {
  const to = [r.to, ...(r.alsoTo ?? [])].join(", ");
  const and = (l: readonly string[]) => (l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`);
  return [to, r.cc?.length ? `cc ${and(r.cc)}` : "", r.bcc?.length ? `bcc ${and(r.bcc)}` : ""].filter(Boolean).join(", ");
}
