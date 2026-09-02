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

export type ShootAddOn = {
  id: string;
  item: string;
  note: string | null;
  addedBy: string | null;
  addedAtISO: string;
  /** The office has closed it out — shown as done, and no longer removable. */
  handled: boolean;
};
