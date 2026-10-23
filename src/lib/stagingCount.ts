// ---------------------------------------------------------------------------
// HOW MANY STAGED PHOTOS WERE ORDERED (Oct 23 2026). Pure; safe anywhere.
//
// Jordan: "Virtual staging should have a qty amount unless its a custom item
// saying virtual staging and how many."
//
// The photo audit (M11) had assumed one Virtual Staging line buys 3 staged
// photos. It does not. Per order line that is virtual staging:
//   · the catalog product "Virtual Staging": its quantity;
//   · a custom line whose title says how many ("Virtual Staging - 5 photos",
//     "5 virtually staged photos", "Virtual Staging (5)"): that number;
//   · a custom line with no number: its quantity when it is more than 1, and
//     NOT KNOWN when it is 1. The office is asked; the hub never guesses.
// Virtual Decluttering is not staging. The order's lines (OrderItem, Aryeo's
// commercial truth) are read first; a job with none falls back to its
// VIRTUAL_STAGING deliverables (merged one row per type, so they are second
// best). A staging deliverable the office waived or pulled from the order,
// with nothing live for it, means staging is not owed.
//
// Every place that counts staged photos reads this: the photo part of a
// client's message (briefPhotoAsks.officeWhy), the "Virtual Staging needed"
// hold (photoDelivery/addOns), what was ordered on the photo job
// (photoDelivery/jobs.expectedFor: the coverage panel, the free check's
// add-on suggestions, the order check).
// ---------------------------------------------------------------------------

/** A line that is virtual staging ("Virtual Staging", "5 virtually staged photos", "Digital staging"). */
export const STAGING_LINE = /\b(?:virtual(?:ly)?|digital(?:ly)?)[\s_-]*stag/i;
/** Virtual Decluttering is its own product, even where it was mapped to VIRTUAL_STAGING. */
const DECLUTTER = /declutter/i;
/** Aryeo's catalog product (Settings → Products: "Virtual Staging", an add-on): sold by quantity. */
const CATALOG_PRODUCT = /^\s*virtual\s+staging\s*$/i;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = `(\\d{1,2}|${Object.keys(WORDS).join("|")})`;
const STAGED_NOUN = `(?:(?:virtual(?:ly)?|digital(?:ly)?)[\\s_-]*)?(?:stag\\w*[\\s_-]*)?(?:photos?|images?|pics?|pictures?|rooms?|stag\\w*)`;
/** "5 photos", "5 virtually staged photos", "3 virtual staging", "5 staged rooms", "x5 photos". */
const COUNT_BEFORE = new RegExp(`(?:^|[^\\w$.,])${NUM}\\s*(?:x\\s*)?${STAGED_NOUN}\\b`, "i");
/** "Virtual Staging - 5", "Virtual Staging (5)", "Virtual Staging x5", "Virtual Staging: 5 photos", "Virtual Staging #5". */
const COUNT_AFTER = new RegExp(`stag\\w*(?:\\s+(?:photos?|images?|rooms?))?\\s*(?:[-–:(#]|\\bx\\b|×|x(?=\\d))\\s*${NUM}\\b(?!\\s*[%.,]\\d)`, "i");

const toN = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()] ?? null);

/** The count a line's title states, or null (pure). Money ("$25") and street numbers are never read as a count. */
export function countInTitle(title: string): number | null {
  const t = title.replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, " ");
  const m = COUNT_BEFORE.exec(t) ?? COUNT_AFTER.exec(t);
  const n = m ? toN(m[1]) : null;
  return n && n > 0 ? n : null;
}

export type StagingLine = {
  title: string;
  quantity: number;
  /** Staged photos this line buys; null = the line does not say. */
  count: number | null;
  how: "quantity" | "title" | "not stated";
};
export type StagingOrdered = {
  /** Staging is on the order (a live line or deliverable). */
  ordered: boolean;
  /** Staged photos ordered; null = staging is ordered but a line does not say how many. 0 when not ordered. */
  count: number | null;
  /** What the lines that do say add up to. */
  known: number;
  lines: StagingLine[];
};

/** Is this line virtual staging? (pure) A deliverable of that type with no title of its own is. */
export function isStagingLine(title: string | null | undefined, type?: string | null): boolean {
  const t = (title ?? "").trim();
  if (t) return STAGING_LINE.test(t) && !DECLUTTER.test(t);
  return type === "VIRTUAL_STAGING";
}

/** How many staged photos one line buys (pure). */
export function stagingLine(title: string, quantity: number | null | undefined): StagingLine {
  const q = Math.max(1, quantity ?? 1);
  const t = title.trim();
  if (!t || CATALOG_PRODUCT.test(t)) return { title: t || "Virtual Staging", quantity: q, count: q, how: "quantity" };
  const n = countInTitle(t);
  if (n) return { title: t, quantity: q, count: n, how: "title" };
  if (q > 1) return { title: t, quantity: q, count: q, how: "quantity" };
  return { title: t, quantity: q, count: null, how: "not stated" };
}

type OrderLine = { title: string; quantity?: number | null; isCanceled?: boolean | null };
type DeliverableLine = { type: string; productTitle?: string | null; label?: string | null; quantity?: number | null; removedFromOrderAt?: Date | null; waivedAt?: Date | null };

/**
 * The staged photos this order buys (pure). The order's live staging lines
 * first; with none, its live VIRTUAL_STAGING deliverables. A staging
 * deliverable waived or pulled from the order, with nothing live for it,
 * means not ordered (the office's call beats the line).
 */
export function stagedPhotosOrdered(orderItems: OrderLine[], deliverables: DeliverableLine[]): StagingOrdered {
  const none: StagingOrdered = { ordered: false, count: 0, known: 0, lines: [] };
  // The product's own title decides ("Virtual Decluttering" labelled "Virtual
  // Staging" is decluttering); a row with none goes by its label, then its type.
  const titleOf = (d: DeliverableLine) => (d.productTitle?.trim() && isStagingLine(d.productTitle) ? d.productTitle.trim() : d.label?.trim() || "");
  const isMine = (d: DeliverableLine) => {
    const product = d.productTitle?.trim();
    if (product && DECLUTTER.test(product)) return false;
    if (product && isStagingLine(product)) return true;
    // No product title of its own, or a package's: its label, then its type.
    return isStagingLine(d.label, d.type);
  };
  const mine = deliverables.filter(isMine);
  const live = mine.filter((d) => !d.removedFromOrderAt && !d.waivedAt);
  if (mine.length && !live.length) return none;
  const items = orderItems.filter((i) => !i.isCanceled && isStagingLine(i.title));
  const lines = items.length ? items.map((i) => stagingLine(i.title, i.quantity)) : live.map((d) => stagingLine(titleOf(d), d.quantity));
  if (!lines.length) return none;
  const known = lines.reduce((s, l) => s + (l.count ?? 0), 0);
  return { ordered: true, count: lines.some((l) => l.count == null) ? null : known, known, lines };
}

/** "1 staged photo", "5 staged photos", "how many staged photos is not on the order" (pure; Kyle's screens, no money). */
export function stagedCountWords(s: Pick<StagingOrdered, "count">): string {
  if (s.count == null) return "how many staged photos is not on the order";
  return `${s.count} staged photo${s.count === 1 ? "" : "s"}`;
}
