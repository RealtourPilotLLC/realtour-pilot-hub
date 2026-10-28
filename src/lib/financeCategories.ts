import "server-only";
import { prisma } from "@/lib/prisma";
import { etDayStartUtc, etMonthKey, etYearStartKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// ONE WINDOW RULE FOR THE STRIPE RAIL (Oct 20 2026, audit G9).
//
// Bank, card, Venmo and QuickBooks rows are DATE-ONLY (stored at noon UTC so
// their ET day is unambiguous), so a UTC-midnight window is exact for them.
// Stripe rows carry the real instant of the charge, and a UTC window moved
// every evening Eastern-time sale on the last day of a month (after 8 PM EDT,
// 7 PM EST) into the NEXT month. Stripe reads now use the ET calendar days.
// ---------------------------------------------------------------------------
export function stripeWindow(startKey: string, endKey: string): { from: Date; to: Date } {
  const from = etDayStartUtc(new Date(`${startKey}T12:00:00Z`));
  const dayAfterEnd = new Date(Date.parse(`${endKey}T12:00:00Z`) + 86_400_000);
  const to = new Date(etDayStartUtc(dayAfterEnd).getTime() - 1);
  return { from, to };
}

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

// ---------------------------------------------------------------------------
// THE BUSINESS OPERATING ACCOUNT MOVED (Oct 21 2026, Jordan: "My PNC business
// account was closed, but I still have 0942, which I am currently using as a
// business account").
//
// PNC ··3002 ("Payroll") was business checking until it closed; its last
// transaction posted 2026-09-05. Since then the business runs through ··0942,
// which before that was Jordan's personal account and the "detour" hub
// (memory: reference-account-0942). The same mask therefore means two things:
//   · BEFORE the cutover ··0942 is personal, and its history is classified
//     exactly as it always was (so is all of ··3002's);
//   · FROM the cutover ··0942 is business checking: business merchants and
//     contractors are business costs (the same categories ··3002 produced),
//     transfers to ··4284 and personal spending are owner draws (never a cost),
//     Stripe and QuickBooks Payments deposits are money already counted at the
//     processor (bookkeeping.revenueByProcessor never reads a deposit), round
//     trips between his own accounts are transfers, and a deposit nobody can
//     name waits in REVIEW instead of being guessed as income.
//
// The cutover lives in ONE place: the AppSetting below (a YYYY-MM-DD) when it
// is set, else the day after ··3002's last transaction. It is a fixed date on
// purpose, never re-derived from the data on each run: a straggler posting on
// the closed account (a closing fee, a returned item) would otherwise move the
// line and silently re-sort weeks of ··0942.
// ---------------------------------------------------------------------------
export const CLOSED_BUSINESS_MASK = "3002";
export const OPERATING_MASK = "0942";
export const OPERATING_CUTOVER_DEFAULT = "2026-09-06";
export const OPERATING_CUTOVER_SETTING = "finance:operating-cutover";

/** The cutover day from the AppSetting's stored value (a bare or JSON-quoted
 *  YYYY-MM-DD, or {"date": …}); the default for anything else. Pure. */
export function parseOperatingCutover(raw: string | null | undefined): string {
  let v: unknown = raw ?? null;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { /* a bare date string */ }
  }
  if (v && typeof v === "object" && "date" in v) v = (v as { date?: unknown }).date;
  const s = typeof v === "string" ? v.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s) return s;
  return OPERATING_CUTOVER_DEFAULT;
}

export async function operatingCutover(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: OPERATING_CUTOVER_SETTING }, select: { value: true } }).catch(() => null);
  return parseOperatingCutover(row?.value);
}

/** Is this line ··0942 acting as the business checking account? Pure. */
export function isOperatingLine(mask: string | null | undefined, dateKey: string | null | undefined, cutoverKey: string = OPERATING_CUTOVER_DEFAULT): boolean {
  return mask === OPERATING_MASK && !!dateKey && dateKey >= cutoverKey;
}

/** A ledger row's day. Bank, card and statement rows are stored at noon UTC
 *  precisely so the UTC date IS the posted day. */
export function ledgerDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The REVIEW bucket for money that arrived in the business account and that
 *  no rule can name (a mobile check deposit, a Zelle in, a cash deposit). */
export const DEPOSIT_TO_IDENTIFY = "Deposit to identify";

// Contractors paid straight from the bank (Zelle / ACH / check), not via
// Venmo (the Venmo statement rows carry those) or Stripe Connect (the Stripe
// transfer rows do). The bank feed truncates surnames ("LIVINGSTO").
const CONTRACTOR_PEOPLE = /harrison ?wel|james ?livings|\blivingsto|matthew ?bertsch/i;
// Borrowed money landing in the account is not a sale (a Stripe Capital
// advance once read as $15,533.56 of income).
const LOAN_PROCEEDS = /stripe capital|capital advance|loan proceeds|loan advance|loan disb/i;
// Bank → Stripe funding of the contractor payouts. The cost is counted ONCE,
// on the Stripe side (the Connect transfers to James and Harrison, folded into
// "Creative specialist pay" by categoryBreakdown); booking the funding leg as
// a cost too would double every dollar of it.
const STRIPE_FUNDING = /realtourpilo|realtour ?p\b|realtour ?pilot|\bstripe\b.*\b(top-?up|payroll|funding)\b/i;

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
  // The SAME Capital One card, paid from the phone, arrives as "MOBILE
  // PMTCAPITAL ONE CORPORATE ACH CAPITAL PMT" — no "CRCARDPMT", so the rule
  // above missed it: two rows sat in review and a third was booked as personal
  // SPEND ($1,013 total, Aug 2026 audit). The auto loan is "DIRECTPAY CAPITAL
  // ONE AUTO CORPORATE ACH" and must keep its Car payment category, so this
  // matches the MOBILE PMT wording only.
  { rx: /mobile pmt\s*capital one/i, category: "Credit-card paydown", kind: "EXCLUDE" },
  // Rocket Money's savings sweep moves money to his own savings — not spend.
  { rx: /rocket savings/i, category: "Self-transfer (own accounts)", kind: "EXCLUDE" },
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
  // Fly.io — app hosting for the platform, same bucket as Vercel.
  { rx: /fly\.io/i, category: "Software & subscriptions", kind: "BUSINESS" },
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
  // Bomberger's — local Lititz store; Plaid files it as groceries.
  { rx: /bomberger/i, category: "Groceries", kind: "PERSONAL" },
  { rx: /amazon|\bamzn\b|\btarget\b|wal-?mart|\bwm supercenter\b|walmart|home ?depot|homegoods|home goods|at home|\bikea\b|\bkohls\b|marshalls|petsmart|minno|foot locker|\bdsw\b|old navy|little ?poppy|littlepoppy/i, category: "Shopping & household", kind: "PERSONAL" },
  { rx: /vzwrlss|verizon|\bat&?t\b|t-mobile|tmobile/i, category: "Phone", kind: "PERSONAL" },
  { rx: /ppl electric|elec bill|utilities|\belectric\b|\bgas co\b|\bwater\b|comcast|xfinity|whitetail disposal|disposal/i, category: "Utilities", kind: "PERSONAL" },
  { rx: /lentegrity/i, category: "Car payment", kind: "PERSONAL" },
  { rx: /progressive|geico|state farm|allstate|\bnjm\b|insurance/i, category: "Vehicle insurance", kind: "PERSONAL" },
  { rx: /enterprise rent|hertz|rock auto|\bcba\b|riptide|car wash|jiffy|valvoline|autozone|advance auto|\bptc\b|ez-?pass|e-zpass|turnpike|parking|city dog/i, category: "Vehicle (repair, rental, tolls)", kind: "PERSONAL" },
  // Recurring personal apps that kept landing in review each month.
  { rx: /monarch money|rocket money|pimeyes|kindle unltd|\bkindle\b/i, category: "Subscriptions & entertainment", kind: "PERSONAL" },
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
// Plaid's own category, used ONLY as a last resort when none of our rules match.
// Deliberately limited to buckets that can only ever be PERSONAL: a local coffee
// shop or corner grocery should not sit in review forever waiting to be named,
// but nothing here may invent a BUSINESS cost (that would create a deduction
// nobody approved). Anything ambiguous still falls through to REVIEW.
const PLAID_FALLBACK: [RegExp, string][] = [
  [/^FOOD_AND_DRINK_(COFFEE|FAST_FOOD|RESTAURANT)/i, "Restaurants & food delivery"],
  [/^FOOD_AND_DRINK_GROCERIES/i, "Groceries"],
  [/^ENTERTAINMENT_/i, "Subscriptions & entertainment"],
  [/^PERSONAL_CARE_/i, "Health & personal care"],
];

/** Where and when a line posted. Without it a line is classified as it always
 *  was; with it, ··0942 from the cutover is read as business checking. */
export type ClassifyContext = { dateKey?: string | null; cutoverKey?: string };

// What "INCOME" means on a bank line: customer money ARRIVING in an account.
// It is the cash-in side of finance.getCashPosition's runway, and nothing
// else. The P&L never sums it: revenue is counted where it is processed
// (bookkeeping.revenueByProcessor reads QuickBooks Payments, Stripe and the
// Venmo statements, never a deposit), so a payout deposit can't be counted twice.
export function classifyRow(name: string, amount: number, accountMask?: string, plaidDetail?: string | null, ctx?: ClassifyContext): { category: string; kind: FinanceKind } {
  const hay = name || "";
  // (2026-07-23: Lauren's Venmo statements are now IMPORTED — pseudo-account
  // mask "venmoL" carries her per-payee truth, so her 4284 bank funding debits
  // are excluded like Jordan's. The short-lived ≥$900→nanny bank-proxy rule is
  // retired.) Oct 21 2026: the mask now matters for ··0942 from the cutover.
  const operating = isOperatingLine(accountMask, ctx?.dateKey, ctx?.cutoverKey);
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
    if (operating && LOAN_PROCEEDS.test(hay)) return { category: "Loan proceeds (not income)", kind: "EXCLUDE" };
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
    // In the business account an unnamed deposit could be a client's check,
    // Jordan's own money coming back, or a refund: never guessed as income.
    if (operating) return { category: DEPOSIT_TO_IDENTIFY, kind: "REVIEW" };
    return { category: "Deposit / income", kind: "INCOME" };
  }
  // ··0942 AS BUSINESS CHECKING: people paid straight from the bank. Venmo
  // lines stay with the rule table (the Venmo statement rows carry them).
  if (operating && !/venmo/i.test(hay)) {
    if (CONTRACTOR_PEOPLE.test(hay)) return { category: "Creative specialist pay", kind: "BUSINESS" };
    if (/katie ?mac/i.test(hay)) return { category: "Childcare / nanny", kind: "PERSONAL" };
    // Money to Lauren lands in her account and is counted where she spends it.
    if (/lauren spackman|laurie spackman/i.test(hay)) return { category: "Transfer to wife (household)", kind: "EXCLUDE" };
    if (STRIPE_FUNDING.test(hay)) return { category: "Stripe funding / top-up", kind: "EXCLUDE" };
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
  if (plaidDetail) {
    for (const [rx, category] of PLAID_FALLBACK) if (rx.test(plaidDetail)) return { category, kind: "PERSONAL" };
  }
  return { category: "Other / uncategorized", kind: "REVIEW" };
}

/** One stored ledger line, as the planner reads it. */
export type PlanRow = {
  id: string;
  name: string | null;
  merchantName: string | null;
  amount: number;
  categoryDetail: string | null;
  date: Date;
  mask: string | null;
  financeKind: string | null;
  financeCategory: string | null;
  financeLocked: boolean;
};
export type Planned = { kind: FinanceKind; category: string };

/** What the rules make of every UNLOCKED row: the rule table row by row, then
 *  refunds following their merchant. Pure, so the nightly run, the one-off
 *  re-classification script (scripts/_fix/oct21/reclassify-books.ts) and the
 *  drills all compute the identical answer. Locked rows are never planned. */
export function planPlaidCategories(rows: PlanRow[], cutoverKey: string = OPERATING_CUTOVER_DEFAULT): Map<string, Planned> {
  const plan = new Map<string, Planned>();
  const ctxOf = (r: PlanRow): ClassifyContext => ({ dateKey: ledgerDayKey(r.date), cutoverKey });
  for (const r of rows) {
    if (r.financeLocked) continue;
    plan.set(r.id, classifyRow(r.name || r.merchantName || "", r.amount, r.mask ?? undefined, r.categoryDetail, ctxOf(r)));
  }

  // A REFUND MUST FOLLOW ITS MERCHANT. The rules classify a credit on its name
  // alone, so a T-Mobile refund landed in PERSONAL/"Phone" even though Jordan
  // had hand-retagged every T-Mobile CHARGE to the business — leaving the Phone
  // category showing a nonsense −$170. Here each refund adopts the kind and
  // category its own vendor's charges actually carry (including the owner's
  // manual re-tags), so netting always happens in the right bucket.
  // (Oct 21 2026: computed over the planned state instead of re-read after a
  // first write; the answer is the same, and a dry run can now show it.)
  const tagOf = (r: PlanRow) => (r.financeLocked ? { kind: r.financeKind, category: r.financeCategory } : plan.get(r.id)!);
  // One pass over the charges builds vendor → dominant (kind, category).
  const byVendorTag = new Map<string, Map<string, number>>();
  for (const c of rows) {
    if (!(c.amount > 0)) continue;
    const t = tagOf(c);
    if (t.kind !== "PERSONAL" && t.kind !== "BUSINESS") continue;
    const v = vendorName(c.name || c.merchantName || "");
    if (!v) continue;
    const tally = byVendorTag.get(v) ?? new Map<string, number>();
    const k = `${t.kind}||${t.category ?? ""}`;
    tally.set(k, (tally.get(k) ?? 0) + c.amount);
    byVendorTag.set(v, tally);
  }
  for (const r of rows) {
    if (r.financeLocked || !(r.amount < 0)) continue;
    const p = plan.get(r.id)!;
    const operating = isOperatingLine(r.mask, ledgerDayKey(r.date), cutoverKey);
    // A credit that SAYS it's a merchant return but fell through to income
    // (no spend rule knew the vendor — a BeenVerified POS RETURN sat in
    // "Deposit / income", Aug 2026) gets the same vendor-adoption shot; in the
    // business account that same credit sits in REVIEW instead of income.
    const posReturn = /pos return/i.test(r.name ?? "");
    const candidate = p.kind === "PERSONAL" || p.kind === "BUSINESS"
      || (posReturn && (p.kind === "INCOME" || (operating && p.category === DEPOSIT_TO_IDENTIFY)));
    if (!candidate) continue;
    const vendor = vendorName(r.name || r.merchantName || "");
    const tally = vendor ? byVendorTag.get(vendor) : null;
    // A REFUND CAN ONLY NET AGAINST SPENDING THAT EXISTS. With no charge from
    // this vendor anywhere in the ledger, netting invents a negative category
    // (a $170 T-Mobile credit drove "Phone" to −$170 — every phone charge here
    // is Verizon, hand-locked to the business). Unmatched credits stay income,
    // or, in the business account, wait in review.
    if (!tally || tally.size === 0) {
      plan.set(r.id, operating ? { kind: "REVIEW", category: DEPOSIT_TO_IDENTIFY } : { kind: "INCOME", category: "Deposit / income" });
      continue;
    }
    const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    if (!best) continue;
    const [kind, category] = best[0].split("||");
    plan.set(r.id, { kind: kind as FinanceKind, category });
  }
  return plan;
}

/** Every stored line in the planner's shape (locked rows included: their
 *  owner-set tags feed the refund tallies). */
export async function loadPlanRows(): Promise<PlanRow[]> {
  const rows = await prisma.plaidTransaction.findMany({
    select: {
      id: true, name: true, merchantName: true, amount: true, categoryDetail: true, date: true,
      financeKind: true, financeCategory: true, financeLocked: true, account: { select: { mask: true } },
    },
  });
  return rows.map(({ account, ...r }) => ({ ...r, mask: account?.mask ?? null }));
}

/** (Re)categorize every PlaidTransaction the owner hasn't hand-locked. Only the
 *  rows whose tag actually changes are written, batched by (kind,category),
 *  and each write re-checks `financeLocked: false`, so a row the owner tags
 *  while this runs keeps the owner's tag (Oct 21 2026). */
export async function categorizeAllPlaid(): Promise<{ updated: number; scanned: number }> {
  const [cutoverKey, rows] = await Promise.all([operatingCutover(), loadPlanRows()]);
  const plan = planPlaidCategories(rows, cutoverKey);
  const groups = new Map<string, { kind: FinanceKind; category: string; ids: string[] }>();
  for (const r of rows) {
    const p = plan.get(r.id);
    if (!p || (p.kind === r.financeKind && p.category === r.financeCategory)) continue;
    const key = `${p.kind}||${p.category}`;
    let g = groups.get(key);
    if (!g) { g = { kind: p.kind, category: p.category, ids: [] }; groups.set(key, g); }
    g.ids.push(r.id);
  }
  let updated = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += 500) {
      const chunk = g.ids.slice(i, i + 500);
      const res = await prisma.plaidTransaction.updateMany({
        where: { id: { in: chunk }, financeLocked: false },
        data: { financeKind: g.kind, financeCategory: g.category },
      });
      updated += res.count;
    }
  }
  // RETURNED PAYMENTS ARE NOT SPEND. A "RETRY PYMT" row exists ONLY because an
  // earlier attempt at the same payment bounced — the two share the bank's
  // per-payment reference token at the head of the name ("*5826 BILLPAY …" /
  // "*5826 RETRY PYMT…", "DP0E3F… DIRECTPAY" / "DP0E3F… RETRY PYMT"). The dead
  // attempt must come OFF spend (Jordan, Aug 25: four unfixed August pairs had
  // the car payment double-counted ~$636). Token matching — never amount-only:
  // Capital One pays weekly at the SAME amount, and only the bounced week
  // shares its token with the retry. Chains work too: a retry that itself
  // bounced is excluded by ITS later retry. Locked so the reclassify above
  // never resurrects a dead debit; the owner's drill-in re-tag still wins.
  const nr = await netReturnedPayments();
  const pr = await pairReversalCredits();
  updated += nr.netted + pr.netted;
  return { updated, scanned: rows.length };
}

/** Pair every REVERSE-ACH credit with the debit it reverses — the dead debit
 *  comes off spend too. classifyRow already EXCLUDEs the credit side; without
 *  this the failed debit kept counting (Aug 2026: bounced Staffify editor
 *  pulls ~$3k + Intuit fees + car-payment retries that THEMSELVES bounced).
 *  Nearest-prior pairing with consume-once semantics: N reversal credits of
 *  amount X kill the N nearest prior debits of X on that account — set-wise
 *  right even when two bounces share an amount (the weekly $158.94 problem).
 *  A consumed debit that's already excluded/locked is the same bounce counted
 *  once (or the owner's call) — consumed, never rewritten. */
export async function pairReversalCredits(): Promise<{ netted: number }> {
  const credits = await prisma.plaidTransaction.findMany({
    where: { amount: { lt: 0 }, name: { contains: "REVERSE", mode: "insensitive" }, financeKind: "EXCLUDE" },
    select: { id: true, amount: true, date: true, accountId: true },
    orderBy: { date: "asc" },
  });
  const consumed = new Set<string>();
  let netted = 0;
  for (const cr of credits) {
    const debits = await prisma.plaidTransaction.findMany({
      where: {
        accountId: cr.accountId,
        amount: -cr.amount,
        date: { gte: new Date(cr.date.getTime() - 10 * 864e5), lte: cr.date },
        NOT: { name: { contains: "REVERSE", mode: "insensitive" } },
      },
      select: { id: true, financeKind: true, financeLocked: true },
      orderBy: { date: "desc" }, // nearest prior first
    });
    const pick = debits.find((d) => !consumed.has(d.id));
    if (!pick) continue;
    consumed.add(pick.id);
    if (pick.financeKind === "EXCLUDE" || pick.financeLocked) continue;
    await prisma.plaidTransaction.update({
      where: { id: pick.id },
      data: { financeKind: "EXCLUDE", financeCategory: "ACH reversal (netted)", financeLocked: true },
    });
    netted++;
  }
  return { netted };
}

/** Exclude every payment attempt a later RETRY row proves was returned. */
export async function netReturnedPayments(): Promise<{ netted: number }> {
  const retries = await prisma.plaidTransaction.findMany({
    where: { amount: { gt: 0 }, name: { contains: "RETRY PYMT", mode: "insensitive" } },
    select: { id: true, name: true, amount: true, date: true },
    orderBy: { date: "asc" },
  });
  let netted = 0;
  for (const retry of retries) {
    const token = (retry.name || "").trim().split(/\s+/)[0] ?? "";
    // Only a real per-payment reference qualifies (has digits, not a plain word).
    if (token.length < 4 || !/\d/.test(token)) continue;
    const r = await prisma.plaidTransaction.updateMany({
      where: {
        id: { not: retry.id },
        amount: retry.amount,
        date: { gte: new Date(retry.date.getTime() - 31 * 864e5), lt: retry.date },
        name: { startsWith: `${token} ` },
        financeLocked: false,
        NOT: { financeKind: "EXCLUDE" },
      },
      data: { financeKind: "EXCLUDE", financeCategory: "ACH reversal (netted)", financeLocked: true },
    });
    netted += r.count;
  }
  return { netted };
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
  /** Money that ARRIVED and still needs a call (a deposit in the business
   *  account no rule could name), as positive sums. Kept apart from `review`
   *  so it never nets against the spend still to be tagged (Oct 21 2026). */
  reviewIncoming: CatRow[];
  reviewIncomingTotal: number;
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
  const reviewIn: Record<string, CatRow> = {};
  for (const r of rows) {
    const kind = (r.financeKind as FinanceKind) || "REVIEW";
    if (r.amount < 0 && kind === "REVIEW") {
      const cat = r.financeCategory || DEPOSIT_TO_IDENTIFY;
      const b = (reviewIn[cat] ||= { category: cat, sum: 0, count: 0 });
      b.sum -= r.amount; b.count++;
      continue;
    }
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
  // ET days, like the Stripe revenue they are netted against (stripeWindow).
  const sw = stripeWindow(startKey, endKey);
  const stripe = await prisma.stripeTransaction.findMany({
    where: { createdAt: { gte: sw.from, lte: sw.to }, type: { in: ["transfer", "charge", "payout", "stripe_fee"] } },
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
  const reviewIncoming = sort(reviewIn);
  return {
    business,
    personal,
    excluded: sort(buckets.EXCLUDE),
    review: sort(buckets.REVIEW),
    businessTotal: business.reduce((a, r) => a + r.sum, 0),
    personalTotal: personal.reduce((a, r) => a + r.sum, 0),
    reviewTotal: sort(buckets.REVIEW).reduce((a, r) => a + r.sum, 0),
    reviewIncoming,
    reviewIncomingTotal: reviewIncoming.reduce((a, r) => a + r.sum, 0),
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
  const [rows, cutoverKey] = await Promise.all([
    prisma.plaidTransaction.findMany({
      where: { date: { gte: from, lte: toRaw }, amount: { gt: 0 }, financeCategory: "Credit-card paydown", pending: false },
      select: { amount: true, date: true, name: true, account: { select: { isBusiness: true, mask: true } } },
    }),
    operatingCutover(),
  ]);
  // Which side paid: the account's Business tag, except that ··0942 only
  // became the business account at the cutover (Oct 21 2026). Before it, a
  // card paid from ··0942 was paid with personal money.
  const fromBusinessSide = (r: (typeof rows)[number]) =>
    r.account?.mask === OPERATING_MASK ? isOperatingLine(r.account.mask, ledgerDayKey(r.date), cutoverKey) : !!r.account?.isBusiness;
  const cardOf = (n: string) =>
    /\btilt\b|tiltfin/i.test(n) ? "Tilt Engage"
    : /capital one|crcardpmt|\bcrcard\b/i.test(n) ? "Capital One cards"
    : /credit one/i.test(n) ? "Credit One"
    : "Other cards";
  const byCard: Record<string, { sum: number; count: number }> = {};
  const monthKey = etMonthKey(); // this ET month (Oct 28 2026); the rows' dates are calendar days
  let total = 0, thisMonth = 0, fromBusiness = 0, fromPersonal = 0;
  for (const r of rows) {
    total += r.amount;
    if (r.date.toISOString().slice(0, 7) === monthKey) thisMonth += r.amount;
    if (fromBusinessSide(r)) fromBusiness += r.amount; else fromPersonal += r.amount;
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

// ---------------------------------------------------------------------------
// Rail freshness — how current each money source actually is. The three
// statement-import accounts (business Venmo, Lauren's Venmo, the Tilt card)
// only move when Jordan uploads a fresh export, and they went 6+ weeks stale
// with no warning anywhere (audit Aug 25).
// ---------------------------------------------------------------------------
export const MANUAL_STATEMENT_ACCOUNTS: { mask: string; label: string }[] = [
  { mask: "venmo", label: "Business Venmo" },
  { mask: "venmoL", label: "Lauren's Venmo" },
  { mask: "9323", label: "Tilt card" },
];

export type RailFreshness = {
  /** The newest transaction the QuickBooks ledger holds (what has been entered). */
  quickbooks: Date | null;
  /** When the hub last pulled QuickBooks successfully, and the connection's state. */
  quickbooksPulledAt: Date | null;
  quickbooksStatus: string | null;
  quickbooksError: string | null;
  stripe: Date | null;
  /** The live bank and card feed (Plaid, statement imports excluded): its
   *  newest posted line, the last successful sync, and logins needing a fix. */
  bank: { newest: Date | null; syncedAt: Date | null; erroredItems: number };
  /** Lines still waiting for a call this ET year (the Categories tab's window):
   *  spend to tag and deposits to identify. */
  review: { since: string; lines: number; out: number; in: number; deposits: number };
  manual: { mask: string; label: string; newest: Date | null; daysBehind: number | null }[];
};

export async function railFreshness(): Promise<RailFreshness> {
  const days = (d: Date | null) => (d ? Math.floor((Date.now() - d.getTime()) / 86_400_000) : null);
  const since = etYearStartKey();
  const statementMasks = MANUAL_STATEMENT_ACCOUNTS.map((a) => a.mask);
  // A Plaid account with no mask is still a live account: `notIn` alone would
  // drop it (a NULL never matches a NOT), so it is named on purpose.
  const liveAccount = { OR: [{ mask: null }, { mask: { notIn: statementMasks } }] };
  const liveItem = { status: { not: "DISCONNECTED" }, NOT: { itemId: { startsWith: "stmt-" } } };
  const waiting = { date: { gte: new Date(`${since}T00:00:00Z`) }, OR: [{ financeKind: "REVIEW" }, { financeKind: null }] };
  const [qbo, qboConn, stripe, bankNewest, bankSync, erroredItems, reviewOut, reviewIn, ...manualRows] = await Promise.all([
    prisma.qboTransaction.aggregate({ _max: { txnDate: true } }),
    prisma.connection.findUnique({ where: { provider: "quickbooks" }, select: { lastSyncedAt: true, status: true, lastError: true } }),
    prisma.stripeTransaction.aggregate({ _max: { createdAt: true } }),
    prisma.plaidTransaction.findFirst({ where: { pending: false, account: liveAccount }, orderBy: { date: "desc" }, select: { date: true } }),
    prisma.plaidItem.aggregate({ where: liveItem, _max: { lastSyncedAt: true } }),
    prisma.plaidItem.count({ where: { ...liveItem, status: "ERROR" } }),
    prisma.plaidTransaction.aggregate({ where: { ...waiting, amount: { gt: 0 } }, _sum: { amount: true }, _count: true }),
    prisma.plaidTransaction.aggregate({ where: { ...waiting, amount: { lt: 0 } }, _sum: { amount: true }, _count: true }),
    ...MANUAL_STATEMENT_ACCOUNTS.map((a) =>
      prisma.plaidTransaction.findFirst({ where: { account: { mask: a.mask } }, orderBy: { date: "desc" }, select: { date: true } }),
    ),
  ]);
  return {
    quickbooks: qbo._max.txnDate,
    quickbooksPulledAt: qboConn?.lastSyncedAt ?? null,
    quickbooksStatus: qboConn?.status ?? null,
    quickbooksError: qboConn?.lastError ?? null,
    stripe: stripe._max.createdAt,
    bank: { newest: bankNewest?.date ?? null, syncedAt: bankSync._max.lastSyncedAt ?? null, erroredItems },
    review: {
      since,
      lines: reviewOut._count + reviewIn._count,
      out: round2(reviewOut._sum.amount ?? 0),
      in: round2(Math.abs(reviewIn._sum.amount ?? 0)),
      deposits: reviewIn._count,
    },
    manual: MANUAL_STATEMENT_ACCOUNTS.map((a, i) => ({
      ...a,
      newest: manualRows[i]?.date ?? null,
      daysBehind: days(manualRows[i]?.date ?? null),
    })),
  };
}

// Daily-cron nag: a statement account gone 21+ days stale rings the owner's
// bell once a week until a fresh export lands.
export async function nagStaleStatements(): Promise<{ nagged: number }> {
  const f = await railFreshness();
  let nagged = 0;
  const week = new Date().toISOString().slice(0, 9); // YYYY-MM-D (decade-of-month) ≈ weekly-ish
  for (const m of f.manual) {
    if (m.daysBehind == null || m.daysBehind < 21) continue;
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "system",
      title: `${m.label} statements are ${Math.floor(m.daysBehind / 7)} weeks behind`,
      body: `Newest imported transaction is ${m.newest?.toISOString().slice(0, 10)} — revenue/spend totals are missing everything since. Upload a fresh export.`,
      href: "/sales?tab=overview",
      targets: [{ roles: ["OWNER"] }],
      dedupeKey: `stale-stmt-${m.mask}-${week}`,
    });
    nagged++;
  }
  return { nagged };
}
