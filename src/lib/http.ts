// ---------------------------------------------------------------------------
// fetch WITH A TIME LIMIT (Oct 20 2026, audit H7). Gmail, Stripe, Google
// Calendar and Drive, QuickBooks and Dropbox's token and file calls had none:
// a provider that accepted the connection and never answered held the 5-minute
// comms cron (100 s budget) or the 15-minute jobs until the platform killed
// them, and the step's own timer only stopped WAITING: the request kept running
// underneath. A hung Dropbox token request stalled every Dropbox call behind it.
//
// The limit covers the whole exchange, the body read included, and ends the
// request itself (an AbortSignal, not a race). Running out throws a
// DOMException named "TimeoutError", which the cron's noise filter
// (cronNoise.isTransientProviderError) already reads as a provider blip.
// A caller's own signal still works: either one ends the request.
// ---------------------------------------------------------------------------

/** A provider's ordinary request: a read, a token, a small write. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export function fetchWithTimeout(input: string | URL, init: RequestInit = {}, ms: number = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(Math.max(1_000, Math.round(ms)));
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}
