import "server-only";







import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Finance categorization — turns raw bank/card transactions into the "where the
// money goes" breakdown Jordan asked for: every dollar tagged BUSINESS or
// PERSONAL by category, with money-movement (self-transfers, card paydowns,
// Stripe top-ups) EXCLUDED so it never inflates the totals.
//
// Deterministic vendor→category rules so the owner can trust it and re-tag any
// row by hand (financeLocked = never auto-overwrite). Validated 2026-07-22
// against the full 2026 dataset; see [[reference-finance-dashboard]].
// ---------------------------------------------------------------------------

export type FinanceKind = "BUSINESS" | "PERSONAL" | "EXCLUDE" | "REVIEW" | "INCOME";

// Stripe Connect destination accounts → the person behind them. EXACT: each
// transfer row carries `destination` (stamped by syncStripe from /v1/transfers;
// verified 2026-07-23 — per-account sums match the owner's Connect dashboard to
// the penny: James $13,567.46, Harrison $4,377.93). Rows missing a destination
// (not yet stamped) fall back to the combined line, never a guess.
export const STRIPE_CONNECT_ACCOUNTS: Record<string, string> = {
  acct_1TKG7cRqstgTY1BH: "James Livingston",
  acct_1QsbJ32MCrVSS8mb: "Harrison Wells",
};

type Rule = { rx: RegExp; category: string; kind: FinanceKind };

// ---------------------------------------------------------------------------
// FUEL — owner rule (Jordan, 2026-07-24): "make all fuel a business expense …
// Wawa, Exxon, Sheetz and any other fuel/convenience transaction over $25 can
// be counted as business travel/fuel."
//
// The dollar threshold is the proxy for what was actually bought: a >$25 charge
// at a gas station is a tank of fuel driving to a shoot; the small ones are a
// coffee and a snack and stay personal. Costco Gas and Giant Fuel are in the
// list because the 2026 scan found them buried in "Groceries" — they are pump
// purchases, not shopping. Food-delivery orders PLACED FROM a gas station
// ("DOORDASH SHEETZ") are meals, never fuel, so they are excluded here and fall
// through to the restaurant rule.
// ---------------------------------------------------------------------------
const FUEL_MERCHANTS =
  /sheetz|\bwawa\b|turkey hill|speedway|sunoco|\bexxon\b|\bshell\b|\bbp\b|circle k|royal farms|city convenience|\bgulf\b|pmusa|costco gas|giant fuel|\blukoil\b|\bcitgo\b|marathon petro|\bvalero\b|chevron|rutter|get ?go|quiktrip|flying j|pilot travel/i;
const FUEL_DELIVERY = /doordash|\bdd \*|grubhub|uber ?eats|instacart|shipt/i;
export const FUEL_BUSINESS_MIN = 25; // strictly greater than this = business fuel

// Order matters — first match wins. EXCLUDE rules run first (money movement).
const RULES: Rule[] = [
  // ---- EXCLUDE: money movement, not spend ----
  // 4284 is the WIFE's account — real household money leaving, not a self-
  // transfer. Kept out of business/personal sums but shown as its own line.
  { rx: /xxxxx4284/i, category: "Transfer to wife (household)", kind: "EXCLUDE" },
  { rx: /online transfer|transfer to xxxxx|transfer from xxxxx|^transfer\b/i, category: "Self-transfer (own accounts)", kind: "EXCLUDE" },
  // Tilt is a CREDIT CARD — every Tilt bank line is a paydown of purchases we
  // already count on the card, so EXCLUDE (never "debt"). Capital One CARD too.
  { rx: /\btilt\b|tiltfin|capital one card|crcardpmt|\bcrcard\b|card pymt\b/i, category: "Credit-card paydown", kind: "EXCLUDE" },
  { rx: /realtourpilo|realtour p\b|www\.realtourpilo/i, category: "Stripe funding / top-up", kind: "EXCLUDE" },
  { rx: /venmo/i, category: "Venmo (see Venmo rows)", kind: "EXCLUDE" },

  // ---- BUSINESS ----
  // QuickBooks Payments merchant fees ("TRAN FEE INTUIT") — owner-confirmed
  // processing fees, NOT software. Must run before the /intuit/ software rule.
  { rx: /tran fee intuit/i, category: "QuickBooks Payments fees", kind: "BUSINESS" },
  // TurboTax = income-tax filing (personal, like IRS/PA) — before /intuit/.
  { rx: /turbotax/i, category: "Personal taxes", kind: "PERSONAL" },
  // Photo editing (HDR photo processing + Pixlmob). Runs before the video rule.
  { rx: /autohdr|auto hdr|\bhdr\b|pixlmob/i, category: "Photo editing", kind: "BUSINESS" },
  // Video / reel editing — Luma (premium reels), Cliffside/Kim (social),
  // Staffify/Remar, Nguyen, Wise, Flylisted, Ta Thi Vui, Eric Visuals.
  // (Staffify/Flylisted exact-$1,500 rows are Paul's consulting — special-cased
  // in classifyRow before these rules run.)
  { rx: /luma|staffify|cliffside|nguyen|dawarhassan|\bwise\b|invoice wise|flylisted|ta thi vui|eric visuals/i, category: "Video editing", kind: "BUSINESS" },
  { rx: /lanccham|lancaster chamber|facebk|facebook ads|meta ads/i, category: "Marketing & networking", kind: "BUSINESS" },
  // Skywatch = DRONE liability insurance — a real business cost (fleet audit).
  { rx: /skywatch/i, category: "Business insurance (drone)", kind: "BUSINESS" },
  // PTC EZ-Pass tolls = driving to shoots — business travel (owner-confirmed).
  { rx: /\bptc\b|ez-?pass|e-zpass|turnpike/i, category: "Travel & tolls (business)", kind: "BUSINESS" },
  // Social-media management service RE-SOLD to a client (Jamie Achberger) —
  // owner-confirmed cost of doing business; discontinued.
  { rx: /real estate social|realestatesocial/i, category: "Social media mgmt (resold)", kind: "BUSINESS" },
  { rx: /cubicasa/i, category: "Floorplans (CubiCasa)", kind: "BUSINESS" },
  { rx: /aryeo|\bpaddle\b|dropbox|openai|anthropic|\bslack\b|sqsp|squarespace|quo |openphone|base44|base vis|adobe|pixel film|intuit|skool|godaddy|namecheap|vercel|frame\.?io|\bcanva\b|capcut|hubspot|higgsfield|zapier|repuso|mailchimp|musicbed|otter\.?ai|grammarly|turboscribe|infinite creator|wix\.?com|\bloom\b|docusign|calendly|epidemic sound|artlist|matterport|google.{0,3}workspace|gsuite|midjourney|topaz|runway|riverside|\bplaud\b|motionvfx|twilio|railway|neon\.tech|\bionos\b/i, category: "Software & subscriptions", kind: "BUSINESS" },
  { rx: /cardinal camera|b&h|bhphoto|adorama|apple stor|best buy|lensrentals|samys|officemax|office depot/i, category: "Gear & equipment", kind: "BUSINESS" },
  { rx: /overdraft|\bnsf\b|returned item|service charge|monthly service|maintenance fee|wire fee|intl purch|int'l purch|foreign trans/i, category: "Bank, card & overdraft fees", kind: "BUSINESS" },

  // ---- PERSONAL ----
  { rx: /^check\b|check #|check \d|^\s*check/i, category: "Housing / rent (checks)", kind: "PERSONAL" },
  { rx: /paindivltx|commwlthofpa|usataxpymt|\birs\b|dept.*revenue|\btreasury\b|turbotax|path\*/i, category: "Personal taxes", kind: "PERSONAL" },
  // Capital One AUTO = the car loan (owner: $635/mo, paid ~$158.75 weekly). A
  // real recurring personal cost — show it, don't bury it in card paydowns.
  { rx: /capital one auto|capital one au\b|carpay capital one|directpay capital one/i, category: "Car payment", kind: "PERSONAL" },
  { rx: FUEL_MERCHANTS, category: "Fuel & convenience", kind: "PERSONAL" },
  { rx: /doordash|\bdd \*|grubhub|uber ?eats|tequila|taco bell|mcdonald|wendy|chipotle|twocousin|kole|chophouse|panera|starbucks|dunkin|\bcafe\b|coffee|\bgrill\b|\bpizza\b|dominos|buffalo|shakeshac|auntieanne|pretzel|restaurant|\btst\*|chilis|randazzos|infinitos|saltpepp|micksalla|tropicals|greco|daily brew|lynn & gray|linden coffee|joe on the go|cabalar|rooster|kissel/i, category: "Restaurants & food delivery", kind: "PERSONAL" },
  { rx: /\bgiant\b|costco|\baldi\b|\bweis\b|whole foods|trader joe|wegmans|\bkroger\b|grocery|hungryroot|shipt|instacart|fox meadows/i, category: "Groceries", kind: "PERSONAL" },
  { rx: /amazon|\bamzn\b|\btarget\b|wal-?mart|\bwm supercenter\b|walmart|home ?depot|homegoods|home goods|at home|\bikea\b|\bkohls\b|marshalls|petsmart|minno|foot locker|\bdsw\b|old navy|little ?poppy|littlepoppy/i, category: "Shopping & household", kind: "PERSONAL" },
  { rx: /vzwrlss|verizon|\bat&?t\b|t-mobile|tmobile/i, category: "Phone", kind: "PERSONAL" },
  { rx: /ppl electric|elec bill|utilities|\belectric\b|\bgas co\b|\bwater\b|comcast|xfinity|whitetail disposal|disposal/i, category: "Utilities", kind: "PERSONAL" },
  { rx: /lentegrity/i, category: "Car payment", kind: "PERSONAL" },
  { rx: /progressive|geico|state farm|allstate|\bnjm\b|insurance/i, category: "Vehicle insurance", kind: "PERSONAL" },
  { rx: /enterprise rent|hertz|rock auto|\bcba\b|riptide|car wash|jiffy|valvoline|autozone|advance auto|\bptc\b|ez-?pass|e-zpass|turnpike|parking|city dog/i, category: "Vehicle (repair, rental, tolls)", kind: "PERSONAL" },
  { rx: /apple\.?com|itunes|netflix|hulu|disney|\bhbo\b|spotify|prime video|audible|paramount|peacock|youtube ?prem|ring ?ai|ring\.com/i, category: "Subscriptions & entertainment", kind: "PERSONAL" },
  { rx: /align counsel|\bcvs\b|walgreens|rite aid|pharmacy|\bdental\b|\bmedical\b|\bclinic\b|barber|\bsalon\b|\bnails\b|carpe|good ?and ?beautiful|rythm|dutch test|veneer|pop on|foot ?spa/i, category: "Health & personal care", kind: "PERSONAL" },
  { rx: /atm withdrawal|cash withdrawal|\batm\b|withdrawal/i, category: "Cash / ATM", kind: "PERSONAL" },
  { rx: /sunbit|klarna|affirm|afterpay/i, category: "Buy-now-pay-later", kind: "PERSONAL" },
  { rx: /apple cash|gloss|disco cowboy|smoke|vape|dispensary|\bbrick\b|universal athletic/i, category: "Other personal", kind: "PERSONAL" },
  { rx: /annual fee|late fee|membership fee|member fee/i, category: "Other personal", kind: "PERSONAL" },
  // ---- Wife's-account merchants (4284, owner-household) ----
  { rx: /turnpaugh|theliven/i, category: "Health & personal care", kind: "PERSONAL" },
  { rx: /calvary preschool|preschool|daycare/i, category: "Childcare / nanny", kind: "PERSONAL" },
  { rx: /veterin|\bvet\b/i, category: "Other personal", kind: "PERSONAL" },
  { rx: /onstar/i, category: "Vehicle (repair, rental, tolls)", kind: "PERSONAL" },
  { rx: /thrive market|wine and spiri|sam adams/i, category: "Groceries", kind: "PERSONAL" },
  { rx: /kohl'?s|azazie|tarte cosmetic|nationwide studios/i, category: "Shopping & household", kind: "PERSONAL" },
  { rx: /chick.?fil/i, category: "Restaurants & food delivery", kind: "PERSONAL" },
  { rx: /apple com\b/i, category: "Subscriptions & entertainment", kind: "PERSONAL" },
];

/** Classify one bank/card row. Inflows (amount<0) are income/movement, not spend. */
export function classifyRow(name: string, amount: number, accountMask?: string): { category: string; kind: FinanceKind } {
  const hay = name || "";
  // (2026-07-23: Lauren's Venmo statements are now IMPORTED — pseudo-account
  // mask "venmoL" carries her per-payee truth, so her 4284 bank funding debits
  // are excluded like Jordan's. The short-lived ≥$900→nanny bank-proxy rule is
  // retired; accountMask stays as a hook for future per-account rules.)
  void accountMask;
  if (amount < 0) {
    // Bounced-payment reversals: the failed debit and its reversal must BOTH
    // net out (the pairing script locks the dead debit; this catches the credit).
    if (/reverse (corporate )?ach|reverse ach web/i.test(hay)) return { category: "ACH reversal (netted)", kind: "EXCLUDE" };
    // Card-side paydown credits ("Payment - Bank Account", CapOne "Payment
    // received. Thank you!") — the mirror of the bank-side paydown debit, which
    // is already EXCLUDE'd. Not income; without this they pollute the INCOME list.
    // "AUTOPAY PYMT" is the CapOne card-side wording for the same thing — without
    // it the credit fell through and got booked as income (audit Jul 2026 found
    // $326.61 of phantom revenue from exactly one of these).
    if (/payment - (bank account|debit card)|payment received\.?\s*thank|autopay pymt|auto ?pay(ment)? pymt/i.test(hay)) {
      return { category: "Credit-card paydown", kind: "EXCLUDE" };
    }
    if (/xxxxx4284/i.test(hay)) return { category: "Transfer to wife (household)", kind: "EXCLUDE" };
    if (/online transfer|transfer to xxxxx|transfer from xxxxx/i.test(hay)) return { category: "Self-transfer (own accounts)", kind: "EXCLUDE" };
    if (/venmo/i.test(hay)) return { category: "Venmo cash-out", kind: "EXCLUDE" };
    if (/stripe|realtourpilo/i.test(hay)) return { category: "Stripe payout (revenue)", kind: "INCOME" };
    if (/intuit|visa direct|quickbooks/i.test(hay)) return { category: "QuickBooks Payments (revenue)", kind: "INCOME" };
    // MERCHANT REFUNDS ARE NEGATIVE SPEND, NOT INCOME. A credit back from a shop
    // we buy from is a return — it must reduce the category it was charged to,
    // not be booked as money earned. Falling through to the INCOME catch-all
    // left the original purchase counted at full price forever (audit Jul 2026:
    // 15 credits worth $1,146.79 overstated the household total, and Old Navy /
    // Enterprise / Amazon returns showed up as "income"). Matching a spend rule
    // here returns the SAME category with a negative amount, so every total
    // that sums the category nets the refund automatically.
    for (const r of RULES) {
      // "Cash / ATM" can never describe money coming IN — several refunds carry
      // the bank's "ATM DEPOSIT POS" wording and would land in the cash bucket.
      if (r.category === "Cash / ATM") continue;
      if ((r.kind === "PERSONAL" || r.kind === "BUSINESS") && r.rx.test(hay)) {
        return { category: r.category, kind: r.kind };
      }
    }
    return { category: "Deposit / income", kind: "INCOME" };
  }
  // Paul's monthly consulting rides on Staffify/Flylisted pulls at exactly
  // $1,500 (owner-confirmed) — everything else from them is editing labor.
  if (/staffify|flylisted/i.test(hay) && Math.abs(amount - 1500) < 1) {
    return { category: "Consulting (Paul)", kind: "BUSINESS" };
  }
  // FUEL OVER THE THRESHOLD = BUSINESS TRAVEL (owner rule — see FUEL_MERCHANTS).
  // Runs before the rule table so it beats the personal "Fuel & convenience"
  // entry; smaller charges at the same pumps fall through and stay personal.
  if (amount > FUEL_BUSINESS_MIN && FUEL_MERCHANTS.test(hay) && !FUEL_DELIVERY.test(hay)) {
    return { category: "Fuel & travel (business)", kind: "BUSINESS" };
  }
  for (const r of RULES) if (r.rx.test(hay)) return { category: r.category, kind: r.kind };
  return { category: "Other / uncategorized", kind: "REVIEW" };
}

/** (Re)categorize every PlaidTransaction the owner hasn't hand-locked. Batched
 *  by (kind,category) — ~30 updateMany calls, not one round-trip per row. */
export async function categorizeAllPlaid(): Promise<{ updated: number }> {
  const rows = await prisma.plaidTransaction.findMany({
    where: { financeLocked: false },
    select: { id: true, name: true, merchantName: true, amount: true, account: { select: { mask: true } } },
  });
  const groups = new Map<string, { kind: FinanceKind; category: string; ids: string[] }>();
  for (const r of rows) {
    const { category, kind } = classifyRow(r.name || r.merchantName || "", r.amount, r.account?.mask ?? undefined);
    const key = `${kind}||${category}`;
    let g = groups.get(key);
    if (!g) { g = { kind, category, ids: [] }; groups.set(key, g); }
    g.ids.push(r.id);
  }
  let updated = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += 500) {
      const chunk = g.ids.slice(i, i + 500);
      await prisma.plaidTransaction.updateMany({
        where: { id: { in: chunk } },
        data: { financeKind: g.kind, financeCategory: g.category },
      });
      updated += chunk.length;
    }
  }

  // A REFUND MUST FOLLOW ITS MERCHANT. The rules classify a credit on its name
  // alone, so a T-Mobile refund landed in PERSONAL/"Phone" even though Jordan
  // had hand-retagged every T-Mobile CHARGE to the business — leaving the Phone
  // category showing a nonsense −$170. Here each refund adopts the kind and
  // category its own vendor's charges actually carry (including the owner's
  // manual re-tags), so netting always happens in the right bucket.
  const refunds = await prisma.plaidTransaction.findMany({
    where: { amount: { lt: 0 }, financeKind: { in: ["PERSONAL", "BUSINESS"] }, financeLocked: false },
    select: { id: true, name: true, merchantName: true, financeKind: true, financeCategory: true },
  });
  // One pass over the charges builds vendor → dominant (kind, category).
  const charges = await prisma.plaidTransaction.findMany({
    where: { amount: { gt: 0 }, financeKind: { in: ["PERSONAL", "BUSINESS"] } },
    select: { name: true, merchantName: true, amount: true, financeKind: true, financeCategory: true },
  });
  const byVendorTag = new Map<string, Map<string, number>>();
  for (const c of charges) {
    const v = vendorName(c.name || c.merchantName || "");
    if (!v) continue;
    const t = byVendorTag.get(v) ?? new Map<string, number>();
    const k = `${c.financeKind}||${c.financeCategory ?? ""}`;
    t.set(k, (t.get(k) ?? 0) + c.amount);
    byVendorTag.set(v, t);
  }
  for (const r of refunds) {
    const vendor = vendorName(r.name || r.merchantName || "");
    const tally = vendor ? byVendorTag.get(vendor) : null;
    // A REFUND CAN ONLY NET AGAINST SPENDING THAT EXISTS. With no charge from
    // this vendor anywhere in the ledger, netting invents a negative category
    // (a $170 T-Mobile credit drove "Phone" to −$170 — every phone charge here
    // is Verizon, hand-locked to the business). Unmatched credits stay income.
    if (!tally || tally.size === 0) {
      await prisma.plaidTransaction.update({
        where: { id: r.id },
        data: { financeKind: "INCOME", financeCategory: "Deposit / income" },
      });
      updated++;
      continue;
    }
    const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    if (!best) continue;
    const [kind, category] = best[0].split("||");
    if (kind !== r.financeKind || category !== r.financeCategory) {
      await prisma.plaidTransaction.update({
        where: { id: r.id },
        data: { financeKind: kind as FinanceKind, financeCategory: category },
      });
      updated++;
    }
  }
  return { updated };
}

export type CatRow = { category: string; sum: number; count: number };
export type Breakdown = {
  business: CatRow[];
  personal: CatRow[];
  excluded: CatRow[];
  review: CatRow[];
  businessTotal: number;
  personalTotal: number;
  reviewTotal: number;
};

/** Spend breakdown for a period: BUSINESS vs PERSONAL by category (money-out
 *  only), plus the Stripe-Connect contractor pay + Stripe fees that live on the
 *  Stripe rail rather than the bank. Money-movement is surfaced but not summed. */
export async function categoryBreakdown(startKey: string, endKey: string): Promise<Breakdown> {
  const from = new Date(`${startKey}T00:00:00Z`);
  const to = new Date(`${endKey}T23:59:59Z`);
  // Refunds ride in as negative PERSONAL/BUSINESS rows and NET against their own
  // category (a returned purchase is not a cost). Inflow kinds we never total —
  // INCOME and EXCLUDE — are discarded below either way, so dropping the old
  // amount>0 filter changes nothing for them.
  const rows = await prisma.plaidTransaction.findMany({
    where: { date: { gte: from, lte: to } },
    select: { amount: true, financeKind: true, financeCategory: true },
  });

  const buckets: Record<FinanceKind, Record<string, CatRow>> = {
    BUSINESS: {}, PERSONAL: {}, EXCLUDE: {}, REVIEW: {}, INCOME: {},
  };
  for (const r of rows) {
    const kind = (r.financeKind as FinanceKind) || "REVIEW";
    // Money IN only counts where it is a REFUND of a cost we booked (PERSONAL /
    // BUSINESS) — there it nets. Inflows on the money-movement and income rails
    // stay out, so the "Excluded" list keeps showing gross transfer volume.
    if (r.amount < 0 && kind !== "PERSONAL" && kind !== "BUSINESS") continue;
    const cat = r.financeCategory || "Other / uncategorized";
    const b = (buckets[kind][cat] ||= { category: cat, sum: 0, count: 0 });
    b.sum += r.amount; b.count++;
  }

  // Stripe-Connect contractor pay + ALL Stripe fees (business, off the bank
  // rail). Fees = charge fees + instant-payout fees + standalone stripe_fee
  // rows — the audit found $1,399 was missing when only charge fees counted.
  const stripe = await prisma.stripeTransaction.findMany({
    where: { createdAt: { gte: from, lte: to }, type: { in: ["transfer", "charge", "payout", "stripe_fee"] } },
    select: { type: true, gross: true, fee: true },
  });
  const stripeTransfers = stripe.filter((s) => s.type === "transfer").reduce((a, s) => a + Math.abs(s.gross), 0);
  const stripeFees =
    stripe.filter((s) => s.type !== "stripe_fee").reduce((a, s) => a + (s.fee || 0), 0) +
    stripe.filter((s) => s.type === "stripe_fee").reduce((a, s) => a + Math.abs(s.gross), 0);
  // Stripe Connect pay merges into the same "Creative specialist pay" bucket as
  // the Venmo payroll rows — one line for James & Harrison, owner-requested.
  if (stripeTransfers > 0) {
    const b = (buckets.BUSINESS["Creative specialist pay"] ||= { category: "Creative specialist pay", sum: 0, count: 0 });
    b.sum += stripeTransfers;
  }
  if (stripeFees > 0) buckets.BUSINESS["Stripe processing fees"] = { category: "Stripe processing fees", sum: stripeFees, count: 0 };

  const sort = (o: Record<string, CatRow>) => Object.values(o).sort((a, b) => b.sum - a.sum);
  const business = sort(buckets.BUSINESS);
  const personal = sort(buckets.PERSONAL);
  return {
    business,
    personal,
    excluded: sort(buckets.EXCLUDE),
    review: sort(buckets.REVIEW),
    businessTotal: business.reduce((a, r) => a + r.sum, 0),
    personalTotal: personal.reduce((a, r) => a + r.sum, 0),
    reviewTotal: sort(buckets.REVIEW).reduce((a, r) => a + r.sum, 0),
  };
}

// ---------------------------------------------------------------------------
// Vendor grouping — "how much did I pay AutoHDR so far this year, and what's
// my average monthly spend?" Groups every counted dollar by payee brand.
// ---------------------------------------------------------------------------

export type VendorRow = {
  vendor: string;
  kind: "BUSINESS" | "PERSONAL";
  category: string; // the vendor's dominant category
  ytd: number;
  count: number;
  avgMonthly: number;
};

// Named payees first (exact, readable); generic brand-normalizer as fallback.
const VENDOR_NAMES: [RegExp, string][] = [
  [/autohdr|auto hdr/i, "AutoHDR"], [/luma/i, "Luma Visuals"],
  [/staffify/i, "Staffify (Remar & Kyle)"], [/cliffside/i, "Cliffside Cuts (Kim)"],
  [/nguyen/i, "Nguyen Cao"], [/\bwise\b|invoice wise/i, "Wise (contractors)"],
  [/dawarhassan/i, "Dawar Hassan"], [/ta thi vui/i, "Ta Thi Vui"], [/eric visuals/i, "Eric Visuals"],
  [/pixlmob/i, "Pixlmob"], [/flylisted/i, "FlyListed"],
  [/venmo → harrison/i, "Harrison Wells"], [/venmo → james/i, "James Livingston"],
  [/venmo → katie/i, "Katie MacIntyre (nanny)"], [/venmo → (lauren|laurie)/i, "Family (Venmo)"],
  [/cubicasa/i, "CubiCasa"], [/aryeo/i, "Aryeo"], [/adobe/i, "Adobe"],
  [/tran fee intuit/i, "QuickBooks Payments fees"], [/intuit/i, "Intuit / QuickBooks"],
  [/overdraft|\bnsf\b|returned item/i, "Overdraft & NSF fees"],
  [/hubspot/i, "HubSpot"], [/zapier/i, "Zapier"], [/mailchimp/i, "Mailchimp"],
  [/musicbed/i, "Musicbed"], [/skool/i, "Skool.com"], [/openai/i, "OpenAI"],
  [/anthropic/i, "Anthropic"], [/dropbox/i, "Dropbox"], [/\bslack\b/i, "Slack"],
  [/openphone|quo /i, "OpenPhone"], [/vercel/i, "Vercel"], [/higgsfield/i, "Higgsfield"],
  [/real estate social/i, "Real Estate Social Pros"], [/lanccham|lancaster chamber/i, "Lancaster Chamber"],
  [/cardinal camera/i, "Cardinal Camera"], [/apple stor/i, "Apple Store"], [/best buy/i, "Best Buy"],
  [/amazon|\bamzn\b/i, "Amazon"], [/\btarget\b/i, "Target"], [/wal-?mart|wm supercenter/i, "Walmart"],
  [/sheetz/i, "Sheetz"], [/\bwawa\b/i, "Wawa"], [/doordash|\bdd \*/i, "DoorDash"],
  [/capital one auto|carpay|directpay capital one/i, "Car payment (Capital One Auto)"],
  [/progressive/i, "Progressive Insurance"], [/lentegrity/i, "Lentegrity"],
  [/enterprise rent/i, "Enterprise Rent-A-Car"], [/ptc ez|ez-?pass/i, "EZ-Pass / tolls"],
  [/verizon|vzwrlss/i, "Verizon"], [/ppl electric|elec bill/i, "Electric (PPL)"],
  [/^check\b|check #/i, "Rent checks (housing)"], [/apple\.?com/i, "Apple (subscriptions)"],
  [/\bgiant\b/i, "Giant"], [/costco/i, "Costco"], [/home depot/i, "Home Depot"],
  [/cba lititz|cbac/i, "CBA Lititz (vehicle)"], [/riptide/i, "Riptide Car Wash"],
  [/sunbit/i, "Sunbit"], [/shipt/i, "Shipt"], [/hungryroot/i, "Hungryroot"],
];

export function vendorName(name: string): string {
  for (const [rx, label] of VENDOR_NAMES) if (rx.test(name)) return label;
  let t = (name || "").toUpperCase();
  t = t.replace(/VISA MONEY TRANSFER C|VISA DIRECT|CORPORATE ACH|ACH WEB|ACH |POS |DEBIT CARD|RECURRING|PURCH(ASE)?/g, " ");
  t = t.replace(/[#*].*$/, "").replace(/\d+/g, " ").replace(/[^A-Z&' ]/g, " ");
  const words = t.split(/\s+/).filter((w) => w.length > 1 && !["PA", "CA", "WA", "NY", "MD", "DE", "NJ", "WI", "AL", "FL", "GA", "TN", "VIS", "LLC", "INC", "COM", "WWW"].includes(w));
  return words.slice(0, 3).join(" ").trim() || "(unlabeled)";
}

/** The Personal tab's data, from the SAME audited ledger as the Categories tab:
 *  bank-truth personal consumption by category, month, and vendor — replaces the
 *  old QBO owner-draw-only view ($44k) that disagreed with Categories ($98k). */
// Cents-precision rounding for the reconciliation figures below.
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function personalTruth(startKey: string, endKey: string) {
  const from = new Date(`${startKey}T00:00:00Z`);
  const to = new Date(`${endKey}T23:59:59Z`);
  // NO amount>0 filter: refund credits now carry the category they reverse (kind
  // PERSONAL, negative amount), so summing every PERSONAL row NETS returns
  // against the purchase instead of leaving it counted at full price.
  const rows = await prisma.plaidTransaction.findMany({
    where: { date: { gte: from, lte: to }, financeKind: "PERSONAL" },
    select: { amount: true, date: true, name: true, merchantName: true, financeCategory: true },
  });
  const byCat: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  const byVendor: Record<string, { amount: number; count: number }> = {};
  let total = 0;
  for (const r of rows) {
    total += r.amount;
    const c = r.financeCategory || "Other";
    byCat[c] = (byCat[c] || 0) + r.amount;
    const mk = r.date.toISOString().slice(0, 7);
    byMonth[mk] = (byMonth[mk] || 0) + r.amount;
    const v = vendorName(r.name || r.merchantName || "");
    (byVendor[v] ||= { amount: 0, count: 0 });
    byVendor[v].amount += r.amount; byVendor[v].count++;
  }
  // Net transfers to the wife's 4284 account. THIS IS A FUNDING PIPE, NOT SPEND:
  // the money lands in her account and is then counted where it is actually
  // SPENT — her 4284 purchases and her Venmo payments are both already inside
  // `total` above. It is reported only so the household split is legible, and
  // it must NEVER be added to `total` (doing so double-counts every dollar of
  // it — that misread is exactly how a $121.8k household year got quoted as
  // $156.7k, Jul 2026).
  const wifeRows = await prisma.plaidTransaction.findMany({
    where: { date: { gte: from, lte: to }, financeCategory: "Transfer to wife (household)" },
    select: { amount: true },
  });
  const toWife = wifeRows.reduce((s, r) => s + r.amount, 0); // + out, − back

  // The receipts for that claim: where her money re-appears in the ledger. Her
  // two spending surfaces are the 4284 account itself and her Venmo (funded
  // FROM 4284, so the funding leg is EXCLUDE and only the Venmo payment counts).
  const herSpend = await prisma.plaidTransaction.groupBy({
    by: ["financeKind"],
    where: { date: { gte: from, lte: to }, account: { mask: { in: ["4284", "venmoL"] } } },
    _sum: { amount: true },
  });
  const herKind = (k: string) => herSpend.find((g) => g.financeKind === k)?._sum.amount ?? 0;
  const wifeCounted = round2(herKind("PERSONAL")); // already inside `total`
  const wifeInReview = round2(herKind("REVIEW")); // not yet categorised, not in `total`

  return {
    total,
    count: rows.length,
    byBucket: Object.entries(byCat).map(([bucket, amount]) => ({ bucket, amount })).sort((a, b) => b.amount - a.amount),
    byMonth,
    topVendors: Object.entries(byVendor).map(([vendor, d]) => ({ vendor, ...d })).sort((a, b) => b.amount - a.amount).slice(0, 14),
    toWife,
    // Reconciliation of the funding pipe, so any surface can prove the point.
    wifeCounted,
    wifeInReview,
    wifeUnaccounted: round2(toWife - wifeCounted - wifeInReview),
  };
}

/** Credit-card payments — the money actually sent to each card, and which side
 *  (business checking vs personal accounts) funded it. Money-movement, so it
 *  never joins the spend totals (the card purchases themselves are counted);
 *  this is the cash-flow view the owner asked for. Bank-side debits only —
 *  the card-side "payment received" credits are the same money's other leg. */
export async function cardPaydowns(startKey: string, endKey: string): Promise<{
  total: number; thisMonth: number; months: number;
  byCard: { card: string; sum: number; count: number; avgMonthly: number }[];
  fromBusiness: number; fromPersonal: number;
}> {
  const from = new Date(`${startKey}T00:00:00Z`);
  const toRaw = new Date(`${endKey}T23:59:59Z`);
  const now = new Date();
  const to = toRaw < now ? toRaw : now;
  const months = Math.max(0.5, (to.getTime() - from.getTime()) / (30.44 * 864e5));
  const rows = await prisma.plaidTransaction.findMany({
    where: { date: { gte: from, lte: toRaw }, amount: { gt: 0 }, financeCategory: "Credit-card paydown", pending: false },
    select: { amount: true, date: true, name: true, account: { select: { isBusiness: true } } },
  });
  const cardOf = (n: string) =>
    /\btilt\b|tiltfin/i.test(n) ? "Tilt Engage"
    : /capital one|crcardpmt|\bcrcard\b/i.test(n) ? "Capital One cards"
    : /credit one/i.test(n) ? "Credit One"
    : "Other cards";
  const byCard: Record<string, { sum: number; count: number }> = {};
  const monthKey = new Date().toISOString().slice(0, 7);
  let total = 0, thisMonth = 0, fromBusiness = 0, fromPersonal = 0;
  for (const r of rows) {
    total += r.amount;
    if (r.date.toISOString().slice(0, 7) === monthKey) thisMonth += r.amount;
    if (r.account?.isBusiness) fromBusiness += r.amount; else fromPersonal += r.amount;
    const c = cardOf(r.name || "");
    (byCard[c] ||= { sum: 0, count: 0 });
    byCard[c].sum += r.amount; byCard[c].count++;
  }
  return {
    total, thisMonth, months,
    byCard: Object.entries(byCard).map(([card, d]) => ({ card, ...d, avgMonthly: d.sum / months })).sort((a, b) => b.sum - a.sum),
    fromBusiness, fromPersonal,
  };
}

/** YTD + average-monthly spend per vendor, business & personal (counted spend only). */
export async function vendorBreakdown(startKey: string, endKey: string): Promise<{ vendors: VendorRow[]; months: number }> {
  const from = new Date(`${startKey}T00:00:00Z`);
  const toRaw = new Date(`${endKey}T23:59:59Z`);
  const now = new Date();
  const to = toRaw < now ? toRaw : now;
  const months = Math.max(0.5, (to.getTime() - from.getTime()) / (30.44 * 864e5));

  const rows = await prisma.plaidTransaction.findMany({
    // No amount>0: refunds carry their original category as negative rows, so a
    // vendor's YTD nets returns (Target minus what went back to Target).
    where: { date: { gte: from, lte: toRaw }, financeKind: { in: ["BUSINESS", "PERSONAL"] } },
    select: { amount: true, name: true, merchantName: true, financeKind: true, financeCategory: true },
  });

  const byV = new Map<string, { kind: "BUSINESS" | "PERSONAL"; cats: Record<string, number>; sum: number; count: number }>();
  for (const r of rows) {
    // Paul's $1,500/mo consulting rides on Staffify/FlyListed pulls — keep him
    // a separate payee so Remar & Kyle's editing line isn't inflated.
    const v = r.financeCategory === "Consulting (Paul)"
      ? "Paul — consulting (Staffify/FlyListed)"
      : vendorName(r.name || r.merchantName || "");
    const g = byV.get(v) ?? { kind: r.financeKind as "BUSINESS" | "PERSONAL", cats: {}, sum: 0, count: 0 };
    g.sum += r.amount; g.count++;
    const c = r.financeCategory || "—";
    g.cats[c] = (g.cats[c] || 0) + r.amount;
    // A vendor's kind = where most of its dollars sit.
    byV.set(v, g);
  }
  // Stripe-side vendors (not in the bank ledger). Connect transfers attribute
  // EXACTLY by destination account and MERGE into Harrison's / James's existing
  // Venmo vendor rows, so the table shows each creative's true all-rail total.
  const stripe = await prisma.stripeTransaction.findMany({
    where: { createdAt: { gte: from, lte: toRaw }, type: { in: ["transfer", "charge", "payout", "stripe_fee"] } },
    select: { type: true, gross: true, fee: true, createdAt: true, destination: true },
  });
  const transfers = stripe.filter((s) => s.type === "transfer");
  const fSum = stripe.filter((s) => s.type !== "stripe_fee").reduce((a, s) => a + (s.fee || 0), 0)
    + stripe.filter((s) => s.type === "stripe_fee").reduce((a, s) => a + Math.abs(s.gross), 0);
  const addStripe = (vendor: string, amt: number, n: number) => {
    if (amt <= 0) return;
    const g = byV.get(vendor) ?? { kind: "BUSINESS" as const, cats: {}, sum: 0, count: 0 };
    g.sum += amt; g.count += n;
    g.cats["Creative specialist pay"] = (g.cats["Creative specialist pay"] || 0) + amt;
    byV.set(vendor, g);
  };
  for (const t of transfers) {
    const person = (t.destination && STRIPE_CONNECT_ACCOUNTS[t.destination]) || "James & Harrison (Stripe, unattributed)";
    addStripe(person, Math.abs(t.gross), 1);
  }
  if (fSum > 0) byV.set("Stripe fees", { kind: "BUSINESS", cats: { "Stripe processing fees": fSum }, sum: fSum, count: 0 });

  const vendors: VendorRow[] = [...byV.entries()].map(([vendor, g]) => {
    const category = Object.entries(g.cats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
    return { vendor, kind: g.kind, category, ytd: g.sum, count: g.count, avgMonthly: g.sum / months };
  }).sort((a, b) => b.ytd - a.ytd);
  return { vendors, months };
}
