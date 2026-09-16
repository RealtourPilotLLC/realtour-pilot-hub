// "Added at the shoot" — the shared shape between the upload portal's server
// actions, the page that lists them back, and the client control.
//
// It lives in its own module because `actions.ts` is a "use server" file and
// those may only export async functions — a constant or a helper exported from
// there is a build error.
//
// Jordan, Sep 2 2026: an agent adds work on site (an extra twilight, a drone
// add-on, a second reel) and the Aryeo order knows nothing about it. The
// photographer names it here and it becomes one task on Kyle's plate to add the
// item to the order.

/**
 * Plain-text (not hashed like lib/tasks.ts `dedupe()`) so the upload page can
 * list a project's add-ons back with a `startsWith` query on `dedupeKey`.
 */
export const SHOOT_ADDON_PREFIX = "shoot-addon-";

/** Every add-on task for one project shares this key prefix. */
export const shootAddonKeyPrefix = (projectId: string) => `${SHOOT_ADDON_PREFIX}${projectId}-`;

/** Stable per-item key: the same item named twice is the same task, never a duplicate. */
export function shootAddonKey(projectId: string, item: string): string {
  const slug = item
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${shootAddonKeyPrefix(projectId)}${slug || "item"}`;
}

/**
 * The task title is what Kyle reads on Ops Day, so it says the job out loud.
 * It is also where the item name lives, so writer and reader share these two.
 */
export const ADD_TO_ORDER_PREFIX = "Add to the order: ";

/** "2410 E Clementine St, Philadelphia, PA 19134" → "2410 E Clementine St". */
export const streetOf = (title: string | null | undefined) =>
  (title || "this job").split(",")[0].trim();

/** Recover the item the photographer typed from the task title. */
export function itemFromTaskTitle(title: string, street: string): string {
  let s = title.startsWith(ADD_TO_ORDER_PREFIX) ? title.slice(ADD_TO_ORDER_PREFIX.length) : title;
  const suffix = ` — ${street}`;
  if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  return s.trim();
}

// ---------------------------------------------------------------------------
// "Kyle added it to the order" — proven by the order, not by a tick.
//
// Sep 16 (Kyle call, 2 Grace Cir): the add-on card is the office's to-do, and
// the thing that finishes it is the line appearing on the Aryeo order. The
// reconcile (integrations/aryeo.ts) creates the deliverable row and closes the
// card whose slug names that category — so the loop shuts on its own instead
// of leaving "Add to the order: 2D Floorplan" open on a job that delivered ten
// days ago. Deliberately conservative: only words that NAME the category
// count, so a vague item ("extra stuff") keeps its card until a human ticks it.
// ---------------------------------------------------------------------------
const ADDON_TYPE_WORDS: Record<string, RegExp> = {
  FLOORPLAN: /\bfloor\s?plans?\b|\b2d\b|cubicasa|iguide/i,
  MATTERPORT_3D: /matterport|3d\s?tour|virtual\s?tour/i,
  ZILLOW_3D: /zillow/i,
  TWILIGHT: /twilight|dusk/i,
  DRONE: /drone|aerial/i,
  HEADSHOT: /headshot|portrait/i,
  VIRTUAL_STAGING: /virtual\s?stag/i,
  SOCIAL_REEL: /\breels?\b|social/i,
  VIDEO: /\bvideo\b|cinematic|walk\s?through/i,
  PHOTOS: /\bphotos?\b|photography|\bhdr\b|gallery|images?/i,
};

/** Does the item slug inside a `shoot-addon-<projectId>-<slug>` key name this
 *  deliverable type? (The slug is the photographer's own words, hyphenated.)
 *
 *  PHOTOS is the fallback, never the first answer: "drone photos" and "twilight
 *  photos" both contain the word, and closing the office's "Add to the order:
 *  Drone Photos" card because a plain photo gallery appeared would tick off a
 *  billing memo for work nobody added (Sep 16 review). A specific add-on word
 *  wins; PHOTOS only matches a slug that names no add-on at all. */
export function addonSlugNamesType(slug: string, type: string): boolean {
  const re = ADDON_TYPE_WORDS[type];
  if (!re) return false;
  const words = slug.replace(/-/g, " ");
  if (!re.test(words)) return false;
  if (type !== "PHOTOS") return true;
  return !Object.entries(ADDON_TYPE_WORDS).some(([t, r]) => t !== "PHOTOS" && r.test(words));
}

export type ShootAddOn = {
  id: string;
  item: string;
  note: string | null;
  addedBy: string | null;
  addedAtISO: string;
  /** The office has closed it out — shown as done, and no longer removable. */
  handled: boolean;
};
