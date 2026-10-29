// ---------------------------------------------------------------------------
// SPECIAL REQUESTS BEFORE SEND (Oct 23 2026, Jordan and Kyle's huddle, item 7).
// Pure and browser-safe: the job page's "Special requests" card, the
// confirmation before Approve and deliver / Approve and upload, and a drill
// all read the same words from here.
//
// Jordan: special requests (lot lines, virtual staging, anything the client
// asked) at the TOP of the job, and before the photos go out the hub confirms
// with Kyle that staging and lot lines were done. If one is not: select the
// photos for it, download them, and upload the finished versions ADDED NEXT TO
// the originals (never replacing them), all on this page. The add-on lines
// are the delivery checklist's (delivery.ts addOnChecks: what was ordered,
// counted by stagingCount.ts, and whether it is done); the upload is the
// page's own Add photos (hubFiles.addPhotosByHand with the add-on and the
// originals), and the hold clears by the version label it writes.
// ---------------------------------------------------------------------------

/** The browser event the send confirmation raises to open an add-on's steps (Oct 28 2026: under its line in the job's Client requests item, HoldingPanel; the Special requests card is gone). */
export const OPEN_ADDON_STEPS = "pd-open-addon-steps";

/** The add-on part of a checklist line (delivery.ts GateCheck). */
export type AddOnLine = { ok: boolean; detail?: string; addOn?: { key: string; need: string; done: string; ordered: string; cleared?: { how: string; photoName: string | null; by: string | null; note: string | null } | null } };

export type AddOnConfirmLine = { key: string; name: string; done: boolean; words: string };

/** "Lot Lines", "Virtual Staging" (the need without "needed"). */
const nameOf = (need: string) => need.replace(/\s+needed$/i, "");

/**
 * The lines the confirmation lists: each add-on asked for or ordered, done or
 * not, in plain words ("Virtual Staging (5 staged photos): not done yet").
 * Empty when the order has none. Pure.
 */
export function addOnConfirmLines(checks: AddOnLine[] | null | undefined): AddOnConfirmLine[] {
  return (checks ?? [])
    .filter((c): c is AddOnLine & { addOn: NonNullable<AddOnLine["addOn"]> } => !!c.addOn)
    .map((c) => {
      const a = c.addOn;
      const ordered = a.ordered && a.ordered !== nameOf(a.need) ? ` (${a.ordered.replace(/^.*?\(([^)]*)\)\s*$/, "$1")})` : "";
      const where = a.cleared?.photoName ? `, on ${a.cleared.photoName}` : a.cleared?.how === "confirmed" && a.cleared.by ? `, confirmed by ${a.cleared.by}` : "";
      return { key: a.key, name: nameOf(a.need), done: c.ok, words: c.ok ? `${a.done}${where}` : `${nameOf(a.need)}${ordered}: not done yet` };
    });
}

/** The plain next step for add-on work that is not done (the confirmation, the card). Pure. */
export function addOnNextStep(names: string[]): string {
  const what = names.join(" and ");
  return `${what} ${names.length === 1 ? "isn't" : "aren't"} done yet. Next: select the photos for it, download them, and upload the finished versions. They are added as new photos next to the originals; the originals stay.`;
}

/**
 * Which original each finished file goes next to (same index as `files`):
 * the original whose name the file's name carries ("DJI_0101-staged.jpg" goes
 * next to DJI_0101.jpg), else, when there are as many files as originals, the
 * one in the same place, else the last original. Pure.
 */
export function pairFinished(files: string[], originals: { id: string; name: string }[]): (string | null)[] {
  if (!originals.length) return files.map(() => null);
  const stem = (n: string) => n.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return files.map((f, i) => {
    const s = stem(f);
    const byName = originals.filter((o) => stem(o.name).length >= 3 && s.includes(stem(o.name))).sort((a, b) => stem(b.name).length - stem(a.name).length)[0];
    if (byName) return byName.id;
    if (files.length === originals.length) return originals[i].id;
    return originals[originals.length - 1].id;
  });
}
