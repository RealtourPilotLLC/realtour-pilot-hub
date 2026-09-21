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

/** The address family staff control. Pre-launch, portal people may only be
 *  created on these — a synthetic client with a real person's inbox is not
 *  synthetic. */
export const STAFF_EMAIL_DOMAIN = "realtourpilot.com";
export const isStaffControlledEmail = (email: string | null | undefined): boolean =>
  /^[^@\s]+@realtourpilot\.com$/i.test((email ?? "").trim());

// ---------------------------------------------------------------------------
// VERIFIED TEST DESTINATIONS (§16, confirmed by Jordan Sep 21 2026).
// Everything a test journey sends must land on one of these two. This is
// narrower than isStaffControlledEmail on purpose: hello@ and james@ are
// staff-controlled but they are other people's inboxes, and a test run should
// not put anything in them.
// ---------------------------------------------------------------------------

export const JORDAN_TEST_EMAIL = "info@realtourpilot.com";
export const JORDAN_TEST_PHONE_DIGITS = "2155348650";

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
 */
export const canonicalInbox = (email: string | null | undefined): string => {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at).split("+")[0];
  return `${local}${trimmed.slice(at)}`;
};

export const isVerifiedTestDestinationEmail = (email: string | null | undefined): boolean =>
  canonicalInbox(email) === JORDAN_TEST_EMAIL;

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
        `(${JORDAN_TEST_EMAIL} / ${JORDAN_TEST_PHONE_DIGITS}). Test sends may not reach anyone else.`,
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

/** Throws unless every supplied destination is one Jordan verified on Sep 21 2026. */
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
