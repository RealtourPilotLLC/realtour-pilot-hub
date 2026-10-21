// ---------------------------------------------------------------------------
// HOW LONG A SET-PASSWORD LINK LIVES (Oct 20 2026, audit G15).
//
// The /invite/<token> link sets (or resets) a login's password, so it is a
// credential. It used to live forever: `invitedAt` was stored and never read,
// and a link forwarded, screenshotted or left in an old text could still set
// the password months later. A link is now good for INVITE_TTL_DAYS from the
// moment it was minted (`invitedAt`); People → "Copy invite link" mints a
// fresh one once it has lapsed. A token with no mint time is treated as
// lapsed, so an unknown age never counts as fresh.
// ---------------------------------------------------------------------------

export const INVITE_TTL_DAYS = 7;
const TTL_MS = INVITE_TTL_DAYS * 86_400_000;

export function inviteTokenExpired(invitedAt: Date | null | undefined, now: number = Date.now()): boolean {
  if (!invitedAt) return true;
  const t = invitedAt.getTime();
  return !Number.isFinite(t) || now - t > TTL_MS;
}

export const INVITE_EXPIRED_MESSAGE = `This link has expired (links last ${INVITE_TTL_DAYS} days). Ask the owner for a fresh one.`;
