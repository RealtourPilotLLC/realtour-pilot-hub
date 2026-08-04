// ---------------------------------------------------------------------------
// Canonical package names.
//
// Aryeo order-item titles are typed by hand per order, so one product arrives
// under a dozen spellings. The monthly-social session products are the worst
// offenders — "Video Accelerator - 4HR Session", "4hr session", "4h session",
// "4 Hour Content Session", "Content Day 4hrs", "4HR Content Session" are all
// the SAME product, and left alone they split one line into six rows that each
// look like a rounding error instead of the retainer business they actually are.
//
// Canonicalising is display-and-grouping only: the stored OrderItem row is never
// rewritten, so nothing here can corrupt the source data.
// ---------------------------------------------------------------------------

const RULES: [RegExp, string][] = [
  // Monthly social-content retainer sessions. The client is billed monthly in
  // QuickBooks; the Aryeo order is a $0 scheduling placeholder so they can book
  // the session without being asked to pay a second time.
  [/video\s*pro\b|\bpro\b.*8\s*h/i, "VIDEO PRO - 8HR Session"],
  [/accelerator/i, "Video Accelerator - 4HR Session"],
  [/video\s*starter|starter.*\b2\s*h/i, "Video Starter - 2HR Session"],
];

/** Collapse an Aryeo order-item title onto the product it really is. */
export function canonicalPackage(title: string): string {
  const t = (title ?? "").trim().replace(/\s+/g, " ");
  for (const [re, name] of RULES) if (re.test(t)) return name;
  return t;
}

/**
 * The monthly-social retainer products. Their Aryeo line is $0 BY DESIGN — the
 * revenue is a recurring QuickBooks invoice, not a per-shoot charge — so any
 * engine that reads Aryeo money has to treat them as a separate rail rather
 * than as a free job.
 */
const RETAINER_PRODUCTS = new Set([
  "VIDEO PRO - 8HR Session",
  "Video Accelerator - 4HR Session",
  "Video Starter - 2HR Session",
]);

export function isRetainerSession(title: string): boolean {
  return RETAINER_PRODUCTS.has(canonicalPackage(title));
}
