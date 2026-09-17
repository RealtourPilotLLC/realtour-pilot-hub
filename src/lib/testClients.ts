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
// ---------------------------------------------------------------------------

/** Word-bounded: "Bobby TEST", "Cara TEST", "John Doe" — never "Testa". */
export const isTestClientName = (name: string | null | undefined): boolean =>
  /\btest\b|\bjohn doe\b/i.test(name ?? "");

/** The address family staff control. Pre-launch, portal people may only be
 *  created on these — a synthetic client with a real person's inbox is not
 *  synthetic. */
export const STAFF_EMAIL_DOMAIN = "realtourpilot.com";
export const isStaffControlledEmail = (email: string | null | undefined): boolean =>
  /^[^@\s]+@realtourpilot\.com$/i.test((email ?? "").trim());

export class NotATestClientError extends Error {
  constructor(name: string | null | undefined) {
    super(`Refusing: "${name ?? "(no name)"}" is not a TEST client. Synthetic-only code paths need the word TEST in the client name.`);
    this.name = "NotATestClientError";
  }
}

/**
 * Throws unless the client is synthetic. Call it FIRST in anything that
 * creates, mutates or signs in as portal people while launch is not
 * authorised, and in every script that seeds data.
 */
export function assertTestClient(client: { name: string | null | undefined } | null | undefined): void {
  if (!client || !isTestClientName(client.name)) throw new NotATestClientError(client?.name);
}
