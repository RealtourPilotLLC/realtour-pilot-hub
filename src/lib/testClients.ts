// ---------------------------------------------------------------------------
// TEST CLIENTS — the one definition of "this record is synthetic".
//
// There is no isolated database for the content program (no Neon key, no
// Docker), so every synthetic client lives in PRODUCTION next to real ones.
// Two things keep that honest:
//   · the name carries the word TEST (word-bounded — "Testa" is a real surname
//     and must never be swept up), and
//   · every script and action that MAY ONLY touch synthetic data calls
//     assertTestClient first and throws otherwise.
//
// Pure module on purpose: no prisma, no "server-only", so the roster, the
// portal, the call engine (contentCalls.ts used to hold this regex) and a
// tsx script can all import it.
//
// ---------------------------------------------------------------------------
// Sep 21 2026 — THREE THINGS PHASE 0 MEASURED, AND WHAT EACH ONE ADDS HERE.
//
// 1. F28. "Jordan Spackman" does not match the name regex, so it is not
//    synthetic — correct, and narrower than it sounds, because the §16 account
//    is named "Jordan Spackman TEST" and that DOES match. The real hazard the
//    inventory turned up is the other direction: production already holds TWO
//    live Client rows named exactly "Jordan Spackman" (cmqikskt1008u9k9qej9ltjy5
//    with 9 real Projects, and cmtl9n46u0001la04skvn78nb on the MISSPELLED
//    domain info@realtorpilot.com). A name guard sitting next to two live
//    look-alikes fails open the moment somebody edits a name. So the guard is
//    no longer name-only: NEVER_SYNTHETIC_CLIENT_IDS refuses those rows by id,
//    whatever they are called. Renaming a real row cannot make it writable by
//    synthetic-only code.
//
// 2. DESTINATIONS. Jordan confirmed his test contacts directly on Sep 21:
//    info@realtourpilot.com and 215-534-8650. isStaffControlledEmail (any
//    @realtourpilot.com address) stays exactly as it was — it is the PRE-LAUNCH
//    floor and weakening it was never on the table — but §16 asks for something
//    narrower for the test account itself, so the verified-destination pair
//    below is a second, tighter check that sits on top of it.
//    The 267-827-9038 number is explicitly NOT a test destination: it sits on
//    three different client rows and nobody here has established whose handset
//    it is. Guessing it would be exactly the substitution §16 forbids.
//
// 3. PROVIDER WRITES. Phase 0 found NO guard between a TEST client and an Aryeo
//    appointment or address write. The name guard cannot help there — Aryeo has
//    never heard of the word TEST, and a booking made "for a test" is a real
//    billable session on a real creative's calendar. assertProviderWriteAllowed
//    below is that guard, and it refuses in BOTH directions §16 names: a test
//    client may not have a real provider record written for it, and a test
//    journey may not reach into a real client's provider record.
// ---------------------------------------------------------------------------

/** Word-bounded: "Bobby TEST", "Cara TEST", "John Doe" — never "Testa". */
export const isTestClientName = (name: string | null | undefined): boolean =>
  /\btest\b|\bjohn doe\b/i.test(name ?? "");

/**
 * The §16 account, spelled once. Every tool that stands it up, asserts on it or
 * looks it up reads this constant, so "Jordan Spackman Test", "Jordan TEST" and
 * "Jordan Spackman (test)" never become three half-built accounts.
 */
export const JORDAN_TEST_CLIENT_NAME = "Jordan Spackman TEST";

const squash = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** Exactly the §16 test account — NOT the two real "Jordan Spackman" rows. */
export const isJordanTestClientName = (name: string | null | undefined): boolean =>
  squash(name) === squash(JORDAN_TEST_CLIENT_NAME);

/**
 * Client rows that are REAL, permanently, whatever anybody renames them to.
 * Measured read-only on Sep 21 2026; both are named "Jordan Spackman" today and
 * neither may be reused, renamed, merged into or written by test tooling.
 *   cmqikskt1008u9k9qej9ltjy5  jspackman215@gmail.com, 9 live Projects
 *   cmtl9n46u0001la04skvn78nb  info@realtorpilot.com  (misspelled domain, real row)
 * Retire, never delete: if one of these is ever genuinely merged away, leave the
 * id here with a note rather than dropping the line.
 */
export const NEVER_SYNTHETIC_CLIENT_IDS: readonly string[] = [
  "cmqikskt1008u9k9qej9ltjy5",
  "cmtl9n46u0001la04skvn78nb",
];

export const isNeverSyntheticClientId = (id: string | null | undefined): boolean =>
  !!id && NEVER_SYNTHETIC_CLIENT_IDS.includes(id);

/**
 * A synthetic fixture ROW: the TEST name, and not a never-synthetic id (a real
 * row renamed "… TEST" is still real, and keeps everything real rows get).
 *
 * Read by the Aryeo customer-user syncs (Sep 28 2026), which match hub rows to
 * Aryeo by email alone: since Bobby TEST moved onto jspackman215@gmail.com —
 * also the inbox of Jordan's REAL Aryeo customer — an email hit on a fixture
 * can be a real person's record, so a fixture takes nothing from one.
 */
export const isSyntheticClientRow = (c: { id?: string | null; name: string | null | undefined }): boolean =>
  isTestClientName(c.name) && !isNeverSyntheticClientId(c.id);

/** The address family staff control. Pre-launch, portal people may only be
 *  created on these — a synthetic client with a real person's inbox is not
 *  synthetic. */
export const STAFF_EMAIL_DOMAIN = "realtourpilot.com";
export const isStaffControlledEmail = (email: string | null | undefined): boolean =>
  /^[^@\s]+@realtourpilot\.com$/i.test((email ?? "").trim());

// ---------------------------------------------------------------------------
// VERIFIED TEST DESTINATIONS (§16, confirmed by Jordan Sep 21 2026).
// Everything a test journey sends must land on one of these. This is
// narrower than isStaffControlledEmail on purpose: hello@ and james@ are
// staff-controlled but they are other people's inboxes, and a test run should
// not put anything in them.
// ---------------------------------------------------------------------------

export const JORDAN_TEST_EMAIL = "info@realtourpilot.com";
export const JORDAN_TEST_PHONE_DIGITS = "2155348650";

// ---------------------------------------------------------------------------
// JORDAN'S TEST INBOXES (Sep 28 2026).
//
// WHY. Jordan, Sep 28 2026, about the old fixture: "Bobby TEST Michael TEST was
// just a test account", then "The email for bobby test is my email so that
// works. the test email for bobby test can just be my jspackman215@gmail.com so
// I can see the test emails." Both Gmail inboxes are his own:
// bobmike0214@gmail.com is the address Bobby TEST (cmtl98xl90008jl04yt5zawnv)
// and its Aryeo customer already carry, and jspackman215@gmail.com is the one
// he reads. So a verified EMAIL destination is now exactly this list: the
// Sep 21 inbox plus those two. Nobody else's Gmail, and no other domain.
//
// WHAT DID NOT CHANGE. JORDAN_TEST_EMAIL is still info@ (and stays the default
// invitee and the name every message quotes first); isStaffControlledEmail is
// still @realtourpilot.com only (the pre-launch floor for portal people,
// reminders and script shares); the verified phone and the 267 refusal.
//
// WHAT IT OPENS, AND THE ONE THING IT WOULD HAVE OPENED BY ACCIDENT.
// jspackman215@gmail.com is ALSO the inbox on the real "Jordan Spackman" row
// (cmqikskt1008u9k9qej9ltjy5, 9 live Projects) and on its Aryeo customer. The
// row is already refused by id; its Aryeo customer is now refused by id too
// (NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS below), because "the Aryeo customer reads
// as a test inbox" stopped proving the customer is a test one the moment that
// inbox joined this list.
//
// HOW AN ADDRESS FOLDS ONTO AN INBOX (canonicalInbox), decided deliberately:
//   · "+tag" folds away, as it has since Sep 21 (info+jordantest@ is info@).
//     Folding a stranger's plus-address only yields the stranger's inbox, which
//     is not on the list, so this never admits anyone new.
//   · DOTS fold away on gmail.com ONLY. That is Gmail's own documented rule —
//     j.spackman215@gmail.com is delivered to jspackman215@gmail.com, and Google
//     does not let anyone register a dotted variant of an existing account — so
//     it is the same mailbox, not a lookalike. On realtourpilot.com (Google
//     Workspace) a dot is part of the address, so i.nfo@ is NOT info@.
//   · googlemail.com is NOT treated as gmail.com. Jordan gave gmail.com
//     addresses; the list is what he said, not what Google would also deliver.
//   · A lookalike (jspackman215@gmail.co, jspackman2150@gmail.com, gmai1.com)
//     is a different string after folding and is refused.
// ---------------------------------------------------------------------------

/** The domain whose dots Gmail ignores. Nothing else gets its dots folded. */
const GMAIL_DOMAIN = "gmail.com";

/** Every verified test EMAIL destination, in canonical form. Add to it only on Jordan's word, with the date. */
export const JORDAN_TEST_INBOXES: readonly string[] = [
  JORDAN_TEST_EMAIL, // Sep 21 2026
  "jspackman215@gmail.com", // Sep 28 2026 — Jordan's own Gmail, the one he reads
  "bobmike0214@gmail.com", // Sep 28 2026 — Jordan's own Gmail, on Bobby TEST and its Aryeo customer
];

/** For refusal messages: "info@…, jspackman215@… or bobmike0214@…". */
export const JORDAN_TEST_INBOXES_TEXT =
  JORDAN_TEST_INBOXES.length > 1
    ? `${JORDAN_TEST_INBOXES.slice(0, -1).join(", ")} or ${JORDAN_TEST_INBOXES[JORDAN_TEST_INBOXES.length - 1]}`
    : JORDAN_TEST_INBOXES.join("");

/**
 * The Aryeo customers of the NEVER_SYNTHETIC_CLIENT_IDS rows, as measured
 * read-only on Sep 21 2026 (docs/content-program-checklist.md, "TWO OTHER
 * 'Jordan Spackman' RECORDS"). A fixture linked to one of these is refused
 * whatever email the customer reads as: since Sep 28 the first one's email
 * (jspackman215@gmail.com) is a verified test inbox, and a write "for the
 * fixture" would land on Jordan's real customer with its real orders.
 *   2ee9574f-…  cmqikskt1008u9k9qej9ltjy5  jspackman215@gmail.com, 9 live Projects
 *   1ef935bc-…  cmtl9n46u0001la04skvn78nb  info@realtorpilot.com (misspelled domain)
 * Retire, never delete — the same rule as the client ids.
 */
export const NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS: readonly string[] = [
  "2ee9574f-9b8c-4f04-a23d-75fcf46b9660",
  "1ef935bc-9f89-48ca-b03d-7343ee52c966",
];

export const isNeverSyntheticAryeoCustomerId = (id: string | null | undefined): boolean =>
  !!id && NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS.includes(id.trim().toLowerCase());

/**
 * NOT a test destination, deliberately. 267-827-9038 appears on both real
 * "Jordan Spackman" client rows and on the "Bobby TEST Michael TEST" fixture,
 * and Phase 0 could not establish whose handset it is. It is named here so a
 * future reader sees the refusal was a decision, not an oversight.
 */
export const UNVERIFIED_LOOKALIKE_PHONE_DIGITS = "2678279038";

const last10 = (phone: string | null | undefined): string => {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

/**
 * Fold plus-addressing away: info+jordantest@realtourpilot.com is delivered to
 * info@realtourpilot.com, so it IS a Jordan-controlled destination and the test
 * account can keep its own distinct sign-in address without a second inbox.
 * On gmail.com only, dots in the local part fold away too (Gmail's own rule —
 * see JORDAN'S TEST INBOXES above for why that and nothing wider).
 */
export const canonicalInbox = (email: string | null | undefined): string => {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const domain = trimmed.slice(at + 1);
  const unTagged = trimmed.slice(0, at).split("+")[0];
  const local = domain === GMAIL_DOMAIN ? unTagged.replace(/\./g, "") : unTagged;
  return `${local}@${domain}`;
};

const VERIFIED_INBOXES: ReadonlySet<string> = new Set(JORDAN_TEST_INBOXES.map(canonicalInbox));

export const isVerifiedTestDestinationEmail = (email: string | null | undefined): boolean =>
  VERIFIED_INBOXES.has(canonicalInbox(email));

export const isVerifiedTestDestinationPhone = (phone: string | null | undefined): boolean =>
  last10(phone) === JORDAN_TEST_PHONE_DIGITS;

/** Real operations only: counts, payouts, reminders and reports exclude these. */
export const isOperationalClientName = (name: string | null | undefined): boolean => !isTestClientName(name);

export class NotATestClientError extends Error {
  constructor(name: string | null | undefined) {
    super(`Refusing: "${name ?? "(no name)"}" is not a TEST client. Synthetic-only code paths need the word TEST in the client name.`);
    this.name = "NotATestClientError";
  }
}

export class RealClientError extends Error {
  constructor(id: string, name: string | null | undefined) {
    super(
      `Refusing: client ${id} ("${name ?? "(no name)"}") is on the never-synthetic list. ` +
        `It is a real production row and no test tooling may write to it, whatever it is named.`,
    );
    this.name = "RealClientError";
  }
}

export class NotAVerifiedTestDestinationError extends Error {
  constructor(what: "email" | "phone", value: string | null | undefined) {
    super(
      `Refusing: ${what} "${value ?? "(none)"}" is not one of Jordan's verified test destinations ` +
        `(${what === "email" ? JORDAN_TEST_INBOXES_TEXT : JORDAN_TEST_PHONE_DIGITS}). Test sends may not reach anyone else.`,
    );
    this.name = "NotAVerifiedTestDestinationError";
  }
}

export class ProviderWriteRefusedError extends Error {
  constructor(reason: string) {
    super(`Refusing provider write: ${reason}`);
    this.name = "ProviderWriteRefusedError";
  }
}

/**
 * Throws unless the client is synthetic. Call it FIRST in anything that
 * creates, mutates or signs in as portal people while launch is not
 * authorised, and in every script that seeds data.
 *
 * The id check runs BEFORE the name check (Sep 21 2026): a real row renamed to
 * contain "TEST" must still be refused, and that ordering is the whole point.
 */
export function assertTestClient(client: { id?: string | null; name: string | null | undefined } | null | undefined): void {
  if (!client) throw new NotATestClientError(undefined);
  if (isNeverSyntheticClientId(client.id)) throw new RealClientError(client.id as string, client.name);
  if (!isTestClientName(client.name)) throw new NotATestClientError(client.name);
}

/** Throws unless every supplied destination is one Jordan verified (Sep 21 2026; his two Gmail inboxes added Sep 28). */
export function assertTestDestinations(d: { email?: string | null; phone?: string | null }): void {
  if (d.email !== undefined && d.email !== null && d.email !== "" && !isVerifiedTestDestinationEmail(d.email)) {
    throw new NotAVerifiedTestDestinationError("email", d.email);
  }
  if (d.phone !== undefined && d.phone !== null && d.phone !== "" && !isVerifiedTestDestinationPhone(d.phone)) {
    throw new NotAVerifiedTestDestinationError("phone", d.phone);
  }
}

// ---------------------------------------------------------------------------
// THE PROVIDER-WRITE GUARD (§16, Sep 21 2026).
//
// Aryeo and Stripe have no concept of a test client. An appointment booked "for
// a test" occupies a real creative's calendar, an order created "for a test" is
// a real billable session, and a reschedule aimed at the wrong id edits a real
// client's shoot. Phase 0 found nothing standing between a TEST client and any
// of that, so this is the decision function for it. It is pure and synchronous
// so a server action, a cron job and a tsx drill can all ask the same question.
//
// It refuses in both directions §16 names:
//   · target is a TEST client and no sandbox adapter is in play → refuse,
//     because the write would be a REAL booking/charge under a test name.
//   · a TEST journey is acting and the target is NOT that same test client →
//     refuse, because that is the "edit the source client's appointment" case.
//
// `sandbox: true` is the ONLY way through the first rule and it is a claim about
// credentials, not about intent — pass it only from a code path holding a
// sandbox key, a mock adapter, or a deliberately authorised disposable fixture.
// ---------------------------------------------------------------------------

export type ProviderWriteAttempt = {
  /** Which external system is about to be written. */
  provider: "aryeo" | "stripe" | "openphone" | "dropbox" | "other";
  /** What is about to happen, for the refusal message: "appointments.reschedule". */
  operation: string;
  /** The client the write is FOR, as the hub knows it. Null when nothing links it to a client. */
  client: { id?: string | null; name: string | null | undefined } | null | undefined;
  /** Set when a TEST journey is driving this write; null/absent for ordinary staff work. */
  actingAsTestClient?: { id?: string | null; name: string | null | undefined } | null;
  /** True only when the caller genuinely holds a sandbox credential or mock adapter. */
  sandbox?: boolean;
};

export type ProviderWriteDecision = { allowed: true } | { allowed: false; reason: string };

export function providerWriteDecision(a: ProviderWriteAttempt): ProviderWriteDecision {
  const targetIsTest = isTestClientName(a.client?.name) && !isNeverSyntheticClientId(a.client?.id);
  const acting = a.actingAsTestClient ?? null;
  const actingIsTest = !!acting && isTestClientName(acting.name);

  if (actingIsTest) {
    const sameRow =
      (!!acting?.id && !!a.client?.id && acting.id === a.client.id) ||
      (!acting?.id && !a.client?.id && squash(acting?.name) === squash(a.client?.name));
    if (!sameRow) {
      return {
        allowed: false,
        reason:
          `${a.provider}.${a.operation} for "${a.client?.name ?? "(no client)"}" was requested by the test client ` +
          `"${acting?.name ?? "(unnamed)"}". A test journey may not write to another client's provider record.`,
      };
    }
  }

  if (targetIsTest && !a.sandbox) {
    return {
      allowed: false,
      reason:
        `${a.provider}.${a.operation} is for TEST client "${a.client?.name}". ${a.provider} has no test mode here, ` +
        `so this would be a real billable session on a real calendar. Use a sandbox credential, a mock adapter, ` +
        `or an explicitly authorised disposable fixture.`,
    };
  }

  return { allowed: true };
}

export function assertProviderWriteAllowed(a: ProviderWriteAttempt): void {
  const d = providerWriteDecision(a);
  if (!d.allowed) throw new ProviderWriteRefusedError(d.reason);
}

// ---------------------------------------------------------------------------
// FIXTURE IDENTITY (R02 / A26, unified handoff Sep 25 2026).
//
// A name is a label anybody can type. The fixture list and the TEST word were
// the only two things between a hub write and a real client, and the
// never-synthetic list covers exactly two rows. What a rename CANNOT change is
// where the row's mail goes: a real client renamed "… TEST" still has the real
// person's inbox, and so does the Aryeo customer it is linked to. So a TEST
// fixture may be written for only when BOTH inboxes are Jordan's verified test
// inbox (plus-addressing folded, so info+jordantest@ counts). Pure: the caller
// reads the Aryeo customer's email (integrations/aryeo.ts hubWritePermit) and
// hands it in; "could not read it" is passed as null and refuses.
//
// Sep 28 2026: "Jordan's verified test inbox" is now any of JORDAN_TEST_INBOXES,
// and one of those (jspackman215@gmail.com) is also the email on Jordan's REAL
// Aryeo customer — so the customer is additionally refused by id when it is a
// never-synthetic row's (NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS). The two inboxes
// may differ: Bobby TEST's own email and its Aryeo customer's can be different
// ones of Jordan's inboxes, and both are still his.
// ---------------------------------------------------------------------------

export class FixtureIdentityError extends Error {
  constructor(reason: string) {
    super(`Refusing: ${reason}`);
    this.name = "FixtureIdentityError";
  }
}

export type FixtureIdentityInput = {
  clientEmail: string | null | undefined;
  /** The client's linked Aryeo customer id; a fixture without one has nothing to verify against. */
  aryeoCustomerId: string | null | undefined;
  /** That Aryeo customer's own email as Aryeo reports it; null = not read / not found. */
  aryeoCustomerEmail: string | null | undefined;
};

/** Why this TEST row is not provably a fixture, or null when both inboxes are verified test inboxes. */
export function fixtureIdentityProblem(i: FixtureIdentityInput): string | null {
  if (!isVerifiedTestDestinationEmail(i.clientEmail)) {
    return `the fixture's own email (${i.clientEmail || "none"}) is not the verified test inbox (${JORDAN_TEST_INBOXES_TEXT}), so it may be a real client carrying a TEST name`;
  }
  if (!i.aryeoCustomerId) return "the fixture has no linked Aryeo customer, so there is no customer the hub could prove is a test one";
  if (isNeverSyntheticAryeoCustomerId(i.aryeoCustomerId)) {
    return `the fixture's Aryeo customer ${i.aryeoCustomerId} belongs to a real "Jordan Spackman" row (never-synthetic), so a write for this fixture would reach that real customer's orders`;
  }
  if (!isVerifiedTestDestinationEmail(i.aryeoCustomerEmail)) {
    return `the fixture's Aryeo customer ${i.aryeoCustomerId} reads ${i.aryeoCustomerEmail ? `as ${i.aryeoCustomerEmail}` : "back with no email (or could not be read)"}, not the verified test inbox (${JORDAN_TEST_INBOXES_TEXT})`;
  }
  return null;
}

/** Throws unless the TEST row and its Aryeo customer both belong to the verified test inbox. */
export function assertFixtureIdentity(i: FixtureIdentityInput): void {
  const p = fixtureIdentityProblem(i);
  if (p) throw new FixtureIdentityError(p);
}
