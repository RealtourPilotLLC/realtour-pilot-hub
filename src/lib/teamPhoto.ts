// ---------------------------------------------------------------------------
// A TEAMMATE'S PHOTO, AS A URL (Oct 30 2026, Jordan: "give everyone on the
// platform a profile page where they can update their timezone, location,
// profile picture, and phone number"). Client-safe: any avatar that has the
// team card's id and photoAt can draw the face; without a photo it is null
// and <Avatar> keeps the initials disc. The stamp is in the URL so a new photo
// is a new address and the browser never shows the old one.
// ---------------------------------------------------------------------------

/** The largest file the profile page will send (it shrinks the picture in the browser first). */
export const TEAM_PHOTO_MAX_BYTES = 4 * 1024 * 1024;
/** The square side the stored photo is cut to. */
export const TEAM_PHOTO_SIDE = 256;

export function teamPhotoSrc(m: { id: string; photoAt?: Date | string | null } | null | undefined): string | null {
  if (!m?.photoAt) return null;
  const t = new Date(m.photoAt).getTime();
  return Number.isFinite(t) ? `/api/team-photo/${encodeURIComponent(m.id)}?v=${t.toString(36)}` : null;
}
