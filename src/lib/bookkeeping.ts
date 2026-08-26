import "server-only";
import { prisma } from "@/lib/prisma";
import { vendorName, STRIPE_CONNECT_ACCOUNTS } from "@/lib/financeCategories";

// ---------------------------------------------------------------------------
// Bookkeeping engine — turn the raw QuickBooks ledger into a P&L you can trust.
//
// The problem this solves: QuickBooks reports income that isn't income. The same
// dollar arrives as an auto-generated SalesReceipt AND again as its bank-feed
// twin. Money moving between Jordan's personal ...0942 account and business
// checking gets coded to Media Services. Stripe payouts are recorded as deposits
// even though the underlying charges are already counted on the Stripe rail.
//
// Design rule: NEVER guess silently. A row we cannot classify with evidence gets
// needsReview = true and a plain-English reviewNote saying what we saw and what
// we could not tell. Filing something wrong quietly is worse than asking.
// ---------------------------------------------------------------------------

/** What a transaction actually is, once the noise is stripped out. */
export type Category =
  // Money in
  | "REVENUE"            // genuine customer money, counted once
  | "ALREADY_COUNTED"    // real revenue, but recognised on another rail (Stripe)
  | "DUPLICATE"          // the second copy of a dollar counted elsewhere
  // Not income at all
  | "TRANSFER"           // moving own money between own accounts
  | "OWNER_DRAW"         // business -> personal. A distribution, NOT an expense
  | "OWNER_CONTRIBUTION" // personal -> business. NOT income
  | "FEE_REFUND"         // bank fee reversals, ACH reversals
  // Money out
  | "COST_OF_SALES"      // contractors, editing, per-job costs
  | "OPERATING"          // software, office, professional services
  | "VEHICLE"            // auto, fuel, travel
  | "FINANCING"          // loan principal — NOT deductible, see reviewNote
  | "UNCATEGORISED";

export type Verdict = {
  category: Category;
  confidence: number;      // 0..1
  needsReview: boolean;
  reviewNote?: string;
  personal?: boolean;
  duplicateOf?: string;    // qboId of the row we keep
};

const PERSONAL_ACCT = /0942/;
const RX = {
  stripe: /\bSTRIPE\b/i,
  venmo: /\bVENMO\b/i,
  qbPay: /QUICKBOOKS PAYMENTS|INTUIT/i,
  autoGen: /AUTO-?GENERATED/i,
  feeish: /\b(NSF|OD FEE|OVERDRAFT|REFUND|REVERSE|REVERSAL)\b/i,
};

// Expense buckets keyed off QuickBooks' own account name. Deliberately small and
// explicit: an unknown account is UNCATEGORISED and gets reviewed, rather than
// being swept into a bucket that quietly distorts the P&L.
// Matched against the LINE-level account name first, and against the raw bank
// description as a fallback (which is how a vendor buried in an Owner Draw line
// still gets recognised). Vendor names are listed alongside the account names
// they should map to.
const EXPENSE_MAP: [RegExp, Category][] = [
  [/contract labor|contractor|1099/i, "COST_OF_SALES"],
  [/editing|editor/i, "COST_OF_SALES"],
  [/cost of goods|cogs|purchases/i, "COST_OF_SALES"],
  [/dues|subscription|software/i, "OPERATING"],
  // Vendors that are unambiguously business tooling.
  [/midjourney|adobe|dropbox|openai|anthropic|vercel|github|slack|zoom|canva|aryeo|frame\.?io/i, "OPERATING"],
  [/office|supplies|staples|amazon|best buy/i, "OPERATING"],
  [/professional|legal|account/i, "OPERATING"],
  [/bank charge|merchant|payments fee/i, "OPERATING"],
  [/auto|fuel|gas|mileage|shell|exxon|sunoco|mobil/i, "VEHICLE"],
  [/travel|meals|hotel|airbnb|uber|lyft/i, "VEHICLE"],
  [/loan|financing|capital/i, "FINANCING"],
];

// ---------------------------------------------------------------------------
// Vendor intelligence. Matched against the FULL bank description (payee +
// PrivateNote + line text) — which is where the vendor actually lives, because
// the `memo` column is frequently empty. This is where "what is this
// transaction" gets decided for the recurring vendors a person recognises on
// sight. Ordered: first match wins, so high-signal rules come first. Vendor
// identities tagged (researched) were confirmed by web lookup on 2026-07-21.
// ---------------------------------------------------------------------------
type VendorRule = { rx: RegExp; category: Category; personal?: boolean; review?: boolean; note?: string };
const VENDOR_RULES: VendorRule[] = [
  // QuickBooks Payments' own "system-recorded fee" is a duplicate of the bank
  // ACH debit to Intuit that actually moves the money — count each fee once.
  { rx: /system-recorded fee for quickbooks/i, category: "DUPLICATE", review: false,
    note: "QuickBooks' internal fee record; the same fee is also the bank ACH debit to Intuit (the one counted). Excluded so the processing fee isn't double-counted." },
  // Personal income tax (IRS, PA individual) + consumer tax prep = owner draws,
  // NOT deductible business expenses, even when routed through QB Payments.
  { rx: /usataxpymt|\birs\b|paindivltx|commwlthofpa|dept.*revenue|\btreasury\b|turbotax/i,
    category: "OWNER_DRAW", personal: true, review: true,
    note: "Income-tax payment or personal tax prep — a personal owner draw, not a deductible business expense. Confirm with your accountant." },
  // Not a P&L item — credit-card payments + money moved between own accounts.
  // Anchor to bank-feed fee signals only; do NOT match the literal account name
  // "Credit Card Payments" (which would sweep unrelated rows into TRANSFER).
  { rx: /crcardpmt|cardmember serv|cardpmt|capital one.*(crcard|pmt|payment)/i,
    category: "TRANSFER", review: true,
    note: "Credit-card payment — pays down a card balance, not itself an expense. Confirm whether the card is a BUSINESS card (its charges belong in the P&L) or personal (an owner draw)." },
  // NOTE: "money transfer" / "visa direct" are deliberately NOT here — on a
  // Purchase those strings are Venmo contractor payouts ("VENMO *<name> Visa
  // Direct"), which are real COST_OF_SALES, not transfers. Only genuine
  // account-to-account moves belong here.
  { rx: /\bonline transfer\b|book transfer|wire transfer/i,
    category: "TRANSFER", review: true,
    note: "Transfer between accounts — not income or expense on its own until the other side is identified." },
  // Funding your own Stripe balance to run payroll (bank → Stripe). This is
  // money in transit, NOT a cost — the actual contractor pay is counted on the
  // Stripe transfers OUT to James/Harrison, so counting this too would double it.
  { rx: /realtour ?pilo|www\.realtour/i,
    category: "TRANSFER", review: false,
    note: "Top-up of your own Stripe balance to fund contractor payroll. Funding, not an expense — the real cost is the Stripe payout to the contractor." },
  // Financing / cash-advance / BNPL — only the fee is deductible, never principal.
  { rx: /\bempower\b|\btilt\b|sunbit|affirm|klarna|afterpay|\bsezzle\b|stripe capital|cash advance/i,
    category: "FINANCING", review: true,
    note: "Loan / cash-advance / buy-now-pay-later repayment (researched: Empower→Tilt and Sunbit are consumer lenders). Principal is NOT deductible — only the fee. Confirm what was financed." },
  // Household / family paid via Venmo — PERSONAL, not business contractors.
  // Must come before the contractor rule so a family name isn't read as a shooter.
  { rx: /katie ?macintyre/i, category: "OWNER_DRAW", personal: true,
    note: "The family nanny — personal, not a business cost (confirmed by Jordan)." },
  { rx: /lauren spackman|laurie spackman/i, category: "OWNER_DRAW", personal: true, review: true,
    note: "Spackman family member paid via Venmo — treated as personal/family. If this is real paid business work, tell me and I'll move it to contractors." },
  // Contractors & editing — per-shoot production cost.
  { rx: /cliffside cuts|nguyen|cameron barr|harrison wells|matthew bertsch|bertsch|james livingston|\bphotographer\b|photography|\bgostaff\b|staffify|\bupwork\b|\bfiverr\b|\beditor\b|editing|post[- ]?production|retouch|virtual stag/i,
    category: "COST_OF_SALES",
    note: "Contractor / editing / photographer — a per-shoot production cost (researched: Cliffside Cuts is a real-estate video-editing service; Nguyen is an editor; Harrison/Matthew/James are shooters paid via Venmo)." },
  { rx: /\bwise\b|transferwise/i, category: "COST_OF_SALES", review: true,
    note: "Wise transfer — usually a contractor payment (the bank note often names the shoot). Confirm the payee." },
  // Business software / SaaS the agency runs on.
  { rx: /anthropic|openai|chatgpt|midjourney|eleven ?labs|elevenlabs|seaart|star cluster|descript|runwayml|\bkling\b|topaz|adobe|dropbox|\bvercel\b|github|\bcanva\b|matterport|cubicasa|aryeo|frame\.?io|\bslack\b|\bzoom\b|\bnotion\b|\bfigma\b|godaddy|namecheap|squarespace|mailchimp|calendly|brookssolutions|intuit \*?q|quickbooks/i,
    category: "OPERATING",
    note: "Business software / subscription (AI content, editing, or ops tooling)." },
  // Vehicle / travel to shoots.
  { rx: /\bpspt\b|parking|\bprk\b|\btolls?\b|e-?zpass|\buber\b|\blyft\b|enterprise rent|\bhertz\b|\bavis\b|exxon|\bshell\b|sunoco|\bmobil\b|\bgulf\b|marathon|turkey hill|autozone|auto zone|advance auto|napa auto|o'?reilly auto/i,
    category: "VEHICLE",
    note: "Auto / fuel / parking / travel to shoots." },
  // Personal spending — the big bucket miscoded as Owner Draw.
  { rx: /doordash|grubhub|uber ?eats|postmates|\bdd \*|ezcater/i, category: "OWNER_DRAW", personal: true, note: "Food delivery — personal." },
  { rx: /netflix|\bhulu\b|disney ?\+?|hbo ?max|\bhbo\b|prime video|spotify|youtube ?premium|paramount|peacock|apple\.com\/bill|\bitunes\b|audible/i, category: "OWNER_DRAW", personal: true, note: "Streaming / personal media subscription." },
  { rx: /taco bell|mcdonald|wendy|burger king|chick-?fil|\bpanera\b|starbucks|dunkin|chipotle|\bsubway\b|\bkfc\b|popeyes|chophouse|steakhouse|\bgrill\b|\bpizza\b|\bcafe\b|\bdiner\b|restaurant|\btst\*|bombergers/i, category: "OWNER_DRAW", personal: true, note: "Restaurant / prepared food — personal." },
  { rx: /amazon|\bamzn\b|\btarget\b|wal-?mart|walmart|costco|\bbj'?s\b|dollar general|dollar tree|\bikea\b|best buy|home depot|lowe'?s/i, category: "OWNER_DRAW", personal: true, note: "General retail — treated as a personal owner draw unless it was a specific business purchase." },
  { rx: /sheetz|\bwawa\b|city convenience|convenience|circle k|\b7-?eleven\b|quiktrip|royal farms/i, category: "OWNER_DRAW", personal: true, note: "Convenience store / snacks / drinks — personal." },
  { rx: /stauffers|reiff|farm market|\baldi\b|\bgiant\b|\bweis\b|whole foods|trader joe|wegmans|\bkroger\b|grocery/i, category: "OWNER_DRAW", personal: true, note: "Groceries — personal." },
  { rx: /barber|\bsalon\b|haircut|\bnails\b|\bcarpe\b|mycarpe|rythm ?health|good ?and ?beautiful|goodandbeautiful|littlepoppyco|little poppy|pmusa|\bsmoke\b|\bvape\b|dispensary|brick llc|getbrick|whitetail disposal|pathkeepers/i, category: "OWNER_DRAW", personal: true, note: "Personal care / household / family / lifestyle (researched: Carpe, Rythm Health, Good & Beautiful, Little Poppy Co, Brick, Whitetail are personal)." },
  { rx: /atm withdrawal|atm transaction fee|cash withdrawal|\batm fee\b/i, category: "OWNER_DRAW", personal: true, note: "Cash withdrawal — recorded as an owner draw." },
  // Handwritten checks — no payee in the bank feed, must be identified by the owner.
  { rx: /^\s*check\s*#?\s*\d|\bcheck\s+\d{3,}\b/i, category: "UNCATEGORISED", review: true,
    note: "Handwritten check with no payee in the bank feed — tell me who each check was written to and I'll categorize it." },
];

// Best-available human description of a stored row: payee + bank memo (PrivateNote)
// + line descriptions. The classifier reads THIS, not the frequently-empty `memo`.
function describe(r: { raw: string | null; memo: string | null }): string {
  let payee = "", note = "", lines = "";
  try {
    const raw = JSON.parse(r.raw ?? "null");
    if (raw) {
      payee = raw.EntityRef?.name ?? "";
      note = raw.PrivateNote ?? "";
      lines = (Array.isArray(raw.Line) ? raw.Line : []).map((l: { Description?: string }) => l?.Description).filter(Boolean).join(" ");
    }
  } catch { /* malformed raw — fall back to memo */ }
  return [payee, note, lines, r.memo ?? ""].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

type Row = {
  qboId: string; type: string; txnDate: Date; amount: number;
  memo: string | null; accountName: string | null; customerName: string | null;
  linkedCount: number;
};

/**
 * Classify one row. `peers` are same-period Payments/SalesReceipts used for
 * duplicate detection; `payouts` are Stripe payout amounts+dates used to prove a
 * personal-account deposit was really a payout that took a detour.
 */
export function classify(
  r: Row,
  peers: { qboId: string; amount: number; txnDate: Date }[],
  payouts: { amount: number; at: Date }[],
): Verdict {
  const memo = r.memo ?? "";
  const days = (a: Date, b: Date) => Math.abs(+a - +b) / 864e5;

  // ---- Expenses -----------------------------------------------------------
  if (r.type === "Purchase") {
    const acct = r.accountName ?? "";
    // `memo` here is the FULL description (payee + PrivateNote + line text),
    // assembled by describe() before classify runs — so the vendor is visible
    // even when QuickBooks left the memo column blank.
    const hay = `${memo} ${acct}`;

    // Staffify is really Remar & Kyle's editing labor (cost of sales) — EXCEPT
    // the recurring $1,500, which is Jordan's monthly consulting calls with Paul
    // (Staffify's owner), an operating cost, not editing. Split by that amount.
    if (/staffify/i.test(hay)) {
      if (Math.abs(r.amount - 1500) < 0.01) {
        return { category: "OPERATING", confidence: 0.7, needsReview: false,
          reviewNote: "Staffify $1,500 — monthly consulting with Paul (Staffify's owner), not editing labor." };
      }
      return { category: "COST_OF_SALES", confidence: 0.85, needsReview: false,
        reviewNote: "Staffify — Remar & Kyle editing labor." };
    }

    // Vendor intelligence FIRST: a recognised vendor is classified with
    // confidence (personal OR business), which is what lets the huge "Owner
    // Draw" pile resolve into real owner draws vs. hidden business costs instead
    // of all being flagged. Only unrecognised rows fall through to review.
    for (const vr of VENDOR_RULES) {
      if (vr.rx.test(hay)) {
        return {
          category: vr.category,
          confidence: vr.review ? 0.55 : 0.85,
          needsReview: !!vr.review,
          personal: vr.personal,
          reviewNote: vr.note,
        };
      }
    }

    // "Owner Draw" is the biggest bucket in the file (1,031 lines) and it is NOT
    // trustworthy. Real business spend is sitting in it — a $10.60 Midjourney
    // subscription, for one. Because Owner Draw is an equity account it never
    // reaches the P&L, which is a large part of why 2026 expenses looked absent.
    // So: recognise the vendor from the bank text where we can and propose the
    // correct category, but ALWAYS flag it. A wrong draw understates expenses,
    // overstates profit, and inflates the tax bill.
    if (/owner\s*draw|retained earnings|opening balance/i.test(acct)) {
      const guess = EXPENSE_MAP.find(([rx]) => rx.test(memo));
      return {
        category: guess ? guess[1] : "UNCATEGORISED",
        confidence: guess ? 0.5 : 0.15,
        needsReview: true,
        reviewNote: guess
          ? `Coded to "${acct}" in QuickBooks, but the description looks like a real business expense. Owner Draw is an equity account, so this never reaches your P&L — if it is business spend it is silently inflating your profit and your tax.`
          : `Coded to "${acct}". If this is genuinely money you took out, it is correct. If it is business spend it is being hidden from the P&L entirely.`,
      };
    }

    if (PERSONAL_ACCT.test(memo) || PERSONAL_ACCT.test(acct)) {
      return {
        category: "OWNER_DRAW", confidence: 0.9, needsReview: false, personal: true,
        reviewNote: "Transfer to the personal ...0942 account. Recorded as an owner draw, not an expense — it must not reduce profit.",
      };
    }
    for (const [rx, cat] of EXPENSE_MAP) {
      if (rx.test(acct)) {
        // Loan principal is not deductible; only the financing fee is. Always ask.
        if (cat === "FINANCING") {
          return {
            category: "FINANCING", confidence: 0.6, needsReview: true,
            reviewNote: "Looks like loan repayment. Only the financing FEE is deductible — principal is not. Confirm the split with your accountant.",
          };
        }
        return { category: cat, confidence: 0.85, needsReview: false };
      }
    }
    return {
      category: "UNCATEGORISED", confidence: 0.2, needsReview: true,
      reviewNote: acct ? `No rule matches the account "${acct}".` : "No account on this expense.",
    };
  }

  // ---- Deposits: where every ambiguity lives ------------------------------
  if (r.type === "Deposit") {
    // Bank fee reversals are not sales.
    if (RX.feeish.test(memo) && !RX.stripe.test(memo)) {
      return { category: "FEE_REFUND", confidence: 0.85, needsReview: false,
        reviewNote: "Bank fee reversal or refund — not customer revenue." };
    }

    // Account-to-account money movement dressed up as a deposit (a QuickBooks/
    // Intuit instant transfer, a VISA Direct, an online transfer) is NOT a new
    // customer sale — counting it as revenue double-books money already earned.
    // A Stripe or Venmo instant payout also arrives as a "VISA MONEY TRANSFER",
    // but those are handled below (Stripe → already counted, Venmo → revenue),
    // so exclude them here or they'd be mislabeled as generic transfers.
    if (/money transfer|visa direct|book transfer/i.test(memo) && r.linkedCount === 0 && !RX.stripe.test(memo) && !RX.venmo.test(memo)) {
      return { category: "TRANSFER", confidence: 0.5, needsReview: true,
        reviewNote: "Looks like an account-to-account transfer (e.g. a QuickBooks/Intuit instant transfer or VISA Direct), not a new customer sale. Confirm before counting as revenue." };
    }

    // Personal-account movement. Per Jordan: this is EITHER a payout that landed
    // in ...0942 and was forwarded, OR a round trip of his own money. Only an
    // exact amount+date tie to a Stripe payout settles it, and in practice that
    // matches a small minority — so everything else is flagged, never guessed.
    if (PERSONAL_ACCT.test(memo)) {
      const tie = payouts.find((p) => Math.abs(p.amount - r.amount) < 0.02 && days(p.at, r.txnDate) <= 6);
      if (tie) {
        return {
          category: "ALREADY_COUNTED", confidence: 0.9, needsReview: false,
          reviewNote: "Stripe payout that landed in ...0942 and was forwarded to business checking. The revenue is already counted on the Stripe rail — counting this deposit again would double it.",
        };
      }
      return {
        category: "TRANSFER", confidence: 0.35, needsReview: true, personal: true,
        reviewNote: "From the personal ...0942 account with no matching Stripe payout. Could be a forwarded payout (already counted), a round trip of your own money, or an owner contribution. Treated as NOT revenue until you confirm — the safe direction.",
      };
    }

    // A deposit that settles real customer Payments/SalesReceipts is revenue.
    if (r.linkedCount > 0) return { category: "REVENUE", confidence: 0.95, needsReview: false };

    // Unlinked + matches a receipt/payment nearby = the classic double count.
    const twin = peers.find((p) => Math.abs(p.amount - r.amount) < 0.005 && days(p.txnDate, r.txnDate) <= 4);
    if (twin) {
      return {
        category: "DUPLICATE", confidence: 0.8, needsReview: true, duplicateOf: twin.qboId,
        reviewNote: `Same amount as a sales receipt/payment ${days(twin.txnDate, r.txnDate).toFixed(0)} day(s) away, with nothing linking it to a customer. This looks like the same dollar counted twice.`,
      };
    }

    // Stripe payouts are the Stripe rail arriving in the bank — already counted.
    if (RX.stripe.test(memo)) {
      return { category: "ALREADY_COUNTED", confidence: 0.9, needsReview: false,
        reviewNote: "Stripe payout. The underlying charges are already counted on the Stripe rail." };
    }
    // Venmo (Stephen Kennedy) reaches no other rail, so it IS the revenue record.
    if (RX.venmo.test(memo)) {
      return { category: "REVENUE", confidence: 0.8, needsReview: false,
        reviewNote: "Venmo, via the personal Venmo account. Real revenue and counted nowhere else — but the commingling is worth raising with your accountant." };
    }
    if (RX.qbPay.test(memo) || RX.autoGen.test(memo)) {
      return { category: "REVENUE", confidence: 0.75, needsReview: false };
    }
    return {
      category: "UNCATEGORISED", confidence: 0.25, needsReview: true,
      reviewNote: memo ? `Unrecognised deposit: "${memo.slice(0, 90)}"` : "Deposit with no description and no customer link.",
    };
  }

  // Invoices / Payments / SalesReceipts are customer-facing by construction.
  return { category: "REVENUE", confidence: 0.9, needsReview: false };
}

/** Classify every stored transaction and persist the verdicts. */
export async function categoriseBooks(opts: { sinceKey?: string } = {}): Promise<{
  scanned: number; flagged: number; byCategory: Record<string, { n: number; amount: number }>;
}> {
  const since = new Date(`${opts.sinceKey ?? "2024-01-01"}T00:00:00Z`);
  const rows = await prisma.qboTransaction.findMany({ where: { txnDate: { gte: since } } });
  const peers = rows
    .filter((r) => r.type === "SalesReceipt" || r.type === "Payment")
    .map((r) => ({ qboId: r.qboId, amount: r.amount, txnDate: r.txnDate }));
  const payouts = (await prisma.stripeTransaction.findMany({ where: { type: "payout" } }))
    .map((p) => ({ amount: Math.abs(p.gross), at: p.createdAt }));

  const byCategory: Record<string, { n: number; amount: number }> = {};
  let flagged = 0;

  for (const r of rows) {
    // A row the owner has explicitly reviewed is FINAL — its category is a human
    // decision (e.g. "those checks are rent") and must survive every re-run.
    // Only tally it; never re-classify or overwrite it.
    if (r.reviewedAt) {
      const cat = r.category ?? "UNCATEGORISED";
      byCategory[cat] ||= { n: 0, amount: 0 };
      byCategory[cat].n++;
      byCategory[cat].amount += r.amount;
      continue;
    }
    // Feed the classifier the FULL bank description (payee + PrivateNote + line
    // text), not the often-empty memo column, so vendors are actually visible.
    const text = describe(r);
    const v = classify({ ...r, memo: text || r.memo } as Row, peers, payouts);
    byCategory[v.category] ||= { n: 0, amount: 0 };
    byCategory[v.category].n++;
    byCategory[v.category].amount += r.amount;
    if (v.needsReview) flagged++;
    // Skip the write when nothing changed — this loop was ~1,300 UPDATE
    // round-trips against production every night for mostly identical verdicts
    // (audit).
    const same =
      r.category === v.category &&
      r.needsReview === v.needsReview &&
      (r.reviewNote ?? null) === (v.reviewNote ?? null) &&
      (r.personal ?? false) === (v.personal ?? false) &&
      (r.duplicateOf ?? null) === (v.duplicateOf ?? null);
    if (same) continue;
    await prisma.qboTransaction.update({
      where: { id: r.id },
      data: {
        category: v.category,
        confidence: v.confidence,
        needsReview: v.needsReview,
        reviewNote: v.reviewNote ?? null,
        personal: v.personal ?? false,
        duplicateOf: v.duplicateOf ?? null,
      },
    });
  }
  return { scanned: rows.length, flagged, byCategory };
}

// ---------------------------------------------------------------------------
// VENMO — the one rail with no API and no reliable record anywhere.
//
// Stephen Kennedy is the only client who pays this way, into Jordan's PERSONAL
// Venmo — which is NOT connected to the business QuickBooks. (The business
// checking feed IS live: 110 deposits, $244,513, through 2026-07. But ZERO of
// them carry a VENMO memo — the money lands in a personal account the business
// books never see.) Aryeo invoice totals are a decent proxy but ran ~5% light
// ($12,425 vs the real $13,125).
//
// So this list is transcribed from Venmo itself and is AUTHORITATIVE for the
// window it covers. It is manual by necessity, not by choice: add new charges
// here, or the Venmo rail silently under-reports.
//
// Covers 2026-01-01 onward. Before that, bank-feed deposits are used instead
// (2025 = $22,698), and the two must never both be counted.
// ---------------------------------------------------------------------------
export const VENMO_COVERAGE_FROM = "2026-01-01";

export const VENMO_CHARGES: { date: string; amount: number; note: string }[] = [
  { date: "2026-01-05", amount: 600, note: "2308 Christian St — photos, video, drone" },
  { date: "2026-01-12", amount: 600, note: "449 Delmar + 7331 E Walnut" },
  { date: "2026-01-26", amount: 775, note: "5449 Malcom, 5612 Haddington, 1971 Ashley" },
  // No February charges — a genuine gap, not missing data.
  { date: "2026-03-05", amount: 300, note: "7413 Sommers Rd — pics + 3 virtual staging" },
  { date: "2026-03-13", amount: 275, note: "1526 S LeCount — pics + 2 staging" },
  { date: "2026-03-20", amount: 400, note: "317 N Carlisle + 244 E Sydney" },
  { date: "2026-03-28", amount: 225, note: "1725 W Berks — pics" },
  { date: "2026-04-06", amount: 1050, note: "Mohican, Rugby, Provident, Spruce" },
  { date: "2026-04-13", amount: 825, note: "2210 Hobson, 5430 Addison, 1406 S Allison" },
  { date: "2026-04-17", amount: 225, note: "7529 Forrest — pics" },
  { date: "2026-04-19", amount: 575, note: "1722 N Redfield + 723 S 53rd" },
  { date: "2026-05-04", amount: 1300, note: "437 S 50th, 6028 Osage, 7109 Broad, 5754 W Oxford" },
  { date: "2026-05-08", amount: 225, note: "6128 Grays Ferry" },
  { date: "2026-05-18", amount: 2000, note: "2155 66th Ave, 1128 E Upsal, 2822 Maxwell, 512 S Yewdall" },
  { date: "2026-06-03", amount: 500, note: "1719 N 62nd + 5430 Addison St" },
  { date: "2026-06-08", amount: 825, note: "1609 S 18th (photo/video/drone) + 865 N 47th" },
  { date: "2026-06-12", amount: 225, note: "236 Stearly — pics + 2 staging" },
  { date: "2026-06-19", amount: 300, note: "4150 Terrace — pics + 3 virtual" },
  { date: "2026-06-22", amount: 275, note: "6332 Limekiln Pike — pics + 2 virtual" },
  { date: "2026-06-24", amount: 850, note: "5753 Catharine + 5130 N Carlisle" },
  { date: "2026-07-04", amount: 500, note: "5540 Windsor St + 1201 W Chelten Ave" },
  { date: "2026-07-16", amount: 275, note: "1429 N 62nd — pics + 2 staging" },
];

/**
 * Revenue counted AT THE PROCESSOR, which is the only place it is unambiguous.
 *
 * Money reaches this business on exactly three rails: QuickBooks Payments,
 * Stripe, and Venmo (one client, Stephen Kennedy). Counting at the processor
 * makes the entire bank-deposit problem disappear — duplicates, personal-account
 * detours through ...0942, and payout deposits are all just MOVEMENT of money
 * already counted, so they are never counted at all.
 *
 * Deliberately does NOT read Deposits or Invoices. A deposit is cash arriving
 * somewhere it already was; an invoice is a bill, not money.
 *
 * Verified no overlap between rails: of 12 manually-recorded "Credit Card"
 * payments in QuickBooks, ZERO matched a Stripe charge within 5 days.
 */
export async function revenueByProcessor(startKey: string, endKey: string) {
  const from = new Date(`${startKey}T00:00:00Z`);
  const to = new Date(`${endKey}T23:59:59Z`);

  // Rail 1 — QuickBooks Payments: customer money recorded in QuickBooks itself.
  // Payment = settles an invoice, SalesReceipt = paid at point of sale (bundles,
  // prepaid packages). Together they are every dollar QuickBooks collected.
  const qboRows = await prisma.qboTransaction.findMany({
    where: { type: { in: ["Payment", "SalesReceipt"] }, txnDate: { gte: from, lte: to } },
  });
  let quickbooks = qboRows.reduce((s, r) => s + r.amount, 0);
  // 2026-02-13 VIDEO PRO $1,999 payment was clawed back on 2026-05-07 (bank
  // shows "*7828 DEPOSIT INTUIT" debit; owner confirmed it was a refund). The
  // QBO Payment row still exists, so subtract it whenever the window covers it.
  if (from <= new Date("2026-02-13T23:59:59Z") && to >= new Date("2026-02-13T00:00:00Z")) {
    quickbooks -= 1999;
  }

  // Rail 2 — Stripe: charges net of refunds, GROSS of fees. Fees are a cost and
  // belong in expenses; netting them here would understate the top line.
  const stripeRows = await prisma.stripeTransaction.findMany({
    where: { type: { in: ["charge", "payment", "refund"] }, createdAt: { gte: from, lte: to } },
  });
  const stripe = stripeRows.reduce((s, r) => s + r.gross, 0);
  const stripeFees = stripeRows.reduce((s, r) => s + r.fee, 0);

  // Rail 3 — Venmo, counted at RECEIPT from the statement pseudo-account's
  // client-inflow rows (imported from Jordan's Venmo statements, category
  // "Venmo revenue (client)"). This is the complete truth: it includes client
  // money spent straight from the Venmo balance that never cashed out to a
  // bank, and it's gross (the ~1.75% instant-transfer fee is a cost, not a
  // revenue reduction). The old method counted bank cash-out credits — the
  // July 2026 crosscheck showed that missed every balance-funded dollar and
  // recorded the rest net of fees. Bank cash-outs are just the settlement leg
  // of money already counted here, so they are no longer summed. Fallbacks
  // (bank credits, then the transcribed list) only fire in a fresh env with no
  // statement import.
  const coverFrom = new Date(`${VENMO_COVERAGE_FROM}T00:00:00Z`);
  const VENMO_EXCLUDED_CENTS = new Set([297500, 124322]);
  let venmoListed = 0;
  if (to >= coverFrom) {
    const bankFrom = from > coverFrom ? from : coverFrom;
    const inflows = await prisma.plaidTransaction.findMany({
      where: { date: { gte: bankFrom, lte: to }, amount: { lt: 0 }, account: { mask: "venmo" }, financeCategory: "Venmo revenue (client)" },
      select: { amount: true },
    });
    if (inflows.length > 0) {
      venmoListed = inflows.reduce((s, c) => s + Math.abs(c.amount), 0);
    } else {
      const credits = await prisma.plaidTransaction.findMany({
        where: { date: { gte: bankFrom, lte: to }, amount: { lt: 0 }, pending: false, name: { contains: "venmo", mode: "insensitive" } },
        select: { amount: true },
      });
      if (credits.length > 0) {
        venmoListed = credits
          .filter((c) => !VENMO_EXCLUDED_CENTS.has(Math.round(Math.abs(c.amount) * 100)))
          .reduce((s, c) => s + Math.abs(c.amount), 0);
      } else {
        venmoListed = VENMO_CHARGES
          .map((c) => ({ at: new Date(`${c.date}T12:00:00Z`), amount: c.amount }))
          .filter((c) => c.at >= from && c.at <= to)
          .reduce((s, c) => s + c.amount, 0);
      }
    }
  }

  // Bank-feed Venmo (QBO memos), only for the pre-coverage part of the window.
  const feedTo = to < coverFrom ? to : new Date(coverFrom.getTime() - 1);
  const venmoRows = feedTo >= from
    ? await prisma.qboTransaction.findMany({ where: { type: "Deposit", txnDate: { gte: from, lte: feedTo } } })
    : [];
  const venmoFeed = venmoRows.filter((d) => /VENMO/i.test(d.memo ?? "")).reduce((s, d) => s + d.amount, 0);

  const venmo = venmoListed + venmoFeed;
  return {
    start: startKey, end: endKey,
    quickbooks, stripe, venmo, stripeFees,
    venmoListed, venmoFeed, venmoCharges: VENMO_CHARGES.length,
    total: quickbooks + stripe + venmo,
  };
}

/** True revenue / expense / profit, with the noise removed. */
// ---------------------------------------------------------------------------
// WHO YOU PAY — resolve the person + the rail for each contractor payment.
// The bank text carries both; the P2P rails (Venmo/Zelle/Wise/PayPal) ride ON
// TOP of a debit-card/ACH line, so they must be tested BEFORE the generic
// card/ACH catch-alls or every Venmo payout reads as "debit card".
// ---------------------------------------------------------------------------
export function paymentChannel(text: string): string {
  const t = text.toUpperCase();
  if (/\bVENMO\b/.test(t)) return "Venmo";
  if (/\bZEL(LE)?\b|ZEL TO/.test(t)) return "Zelle";
  if (/\bWISE\b|TRANSFERWISE/.test(t)) return "Wise";
  if (/\bPAYPAL\b/.test(t)) return "PayPal";
  if (/RECURRING DEBIT CARD|DEBIT CARD PURCHASE|POS DEBIT|POS PURCHASE/.test(t)) return "Debit card";
  if (/CORPORATE ACH|ACH WEB|\bACH\b/.test(t)) return "ACH";
  if (/\bCHECK\s*#?\s*\d/.test(t)) return "Check";
  if (/WITHDRAWAL/.test(t)) return "Cash";
  if (/\bWIRE\b/.test(t)) return "Wire";
  return "Other";
}

// Friendly identity for vendor entities that are really our people. Applied in
// resolvePayee so every surface (People tab, per-job) reads the same name.
const PAYEE_ALIASES: [RegExp, string][] = [
  [/cliffside cuts/i, "Kim · Cliffside Cuts"],
  [/staffify/i, "Remar & Kyle · Staffify"],
  [/nguyen ?cao|nguyencaong/i, "Nguyen Cao (editor)"],
  [/auto ?hdr/i, "AutoHDR"],
  [/\bwise\b|transferwise/i, "Wise (editing)"],
];

// What KIND of payee this is, so "who I pay" can group creatives vs editors vs
// software vs staff. Ordered: first match wins.
export const PAYEE_GROUPS = ["Creative specialists", "Editors", "Software & tools", "Staff & VA", "Marketing", "Other"] as const;
export function payeeGroup(text: string, payee: string): string {
  const t = `${payee} ${text}`.toLowerCase();
  // "livingsto" (not "livingston") — the bank feed truncates the last name.
  if (/harrison|matthew bertsch|livingsto|katie ?macintyre|\bphotographer\b|photography/.test(t)) return "Photographers";
  // Editors incl. our people: Kim (Cliffside), Remar & Kyle (Staffify).
  if (/luma|cliffside|\bkim\b|staffify|\bremar\b|\bkyle\b|nguyen|ta thi|dawar|eric visuals|\bwise\b|\beditor\b|editing|post[- ]?production|retouch|autohdr|pixlmob|pixel film|final cut|capcut|\bpop\b/.test(t)) return "Editors";
  if (/base44|cardinal camera|flylisted|adobe|dropbox|anthropic|openai|midjourney|elevenlabs|seaart|matterport|cubicasa|aryeo|frame\.?io|\bcanva\b|topaz|descript|software|subscription|\bapp\b/.test(t)) return "Software & tools";
  if (/\bva\b|virtual assistant|\bstaff\b/.test(t)) return "Staff & VA";
  if (/social pros|social media|marketing|\bads\b|\bseo\b/.test(t)) return "Marketing";
  return "Other";
}

// Merge "Harrison Wells Photographer" ≈ "VENMO *Harrison Wells" → "Harrison Wells".
function normalizePayee(name: string): string {
  const cleaned = name
    .replace(/\bvisa direct\b.*$/i, "")
    .replace(/\b(photographer|photography|videographer|video ?editor|editor|editing)\b/gi, "")
    .replace(/\b(llc|inc\.?|co\.?)\b/gi, "")
    .replace(/\s+(new york|ny|pa|nj|ca|md|de|va)\s*$/i, "")
    .replace(/[^a-z0-9 &'.-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

/** Best-effort person/vendor for a contractor payment: QBO payee, else the note. */
export function resolvePayee(raw: { EntityRef?: { name?: string } } | null, text: string): string {
  const entity = raw?.EntityRef?.name;
  const hay = `${entity ?? ""} ${text}`;
  for (const [rx, alias] of PAYEE_ALIASES) if (rx.test(hay)) return alias;
  if (entity) return normalizePayee(entity) || entity;
  let m = text.match(/VENMO \*?(.+?) Visa Direct/i); if (m) return normalizePayee(m[1]) || m[1];
  m = text.match(/ZEL(?:LE)? TO ([A-Za-z0-9 .'&-]+?)(?:\s{2,}|$)/i); if (m) return normalizePayee(m[1]) || m[1];
  m = text.match(/ACH WEB \S+ (.+?) (?:IAT|NGUYE|PAYPAL)/i); if (m) return normalizePayee(m[1]) || m[1];
  m = text.match(/DEBIT CARD PURCHASE x+\d{2,} (.+?) [A-Z]{2}\b/i); if (m) return normalizePayee(m[1]) || m[1];
  if (/\bWISE\b/i.test(text)) return "Wise (editing)";
  const snippet = normalizePayee(text.slice(0, 24));
  return snippet || "Unknown";
}

export type PayeeRow = {
  payee: string; group: string; total: number; count: number;
  channels: Record<string, number>; primaryChannel: string;
  months: Record<string, number>; lastAt: Date;
};

/** Every person/vendor paid as a cost of sales, grouped by payee and channel. */
// Categories that represent paying a person or production vendor, mapped to the
// People-tab group they belong to. Fees, gear-store runs, insurance and tolls
// are business costs but not "people" — they stay on the Categories tab only.
const PEOPLE_CATS: Record<string, string> = {
  "Creative specialist pay": "Creative specialists",
  "Video editing": "Editors",
  "Photo editing": "Editors",
  "Consulting (Paul)": "Staff & VA",
  "Social media mgmt (resold)": "Marketing",
  "Marketing & networking": "Marketing",
  "Software & subscriptions": "Software & tools",
  "Floorplans (CubiCasa)": "Other",
};

// One person = one row. The audited ledger names Venmo payouts per recipient and
// Stripe transfers per split, so the same human's rails merge here.
const PERSON_CANON: [RegExp, string][] = [
  [/harrison/i, "Harrison Wells"],
  [/james livingston/i, "James Livingston"],
];

function payChannel(name: string, mask: string | null | undefined): string {
  if (mask === "venmo") return "Venmo";
  const hay = name || "";
  if (/paypal/i.test(hay)) return "PayPal";
  if (/\bwise\b|invoice wise/i.test(hay)) return "Wise";
  if (/corporate ach|ach web|ach pmt|\bach\b/i.test(hay)) return "ACH";
  if (/\bcheck\b/i.test(hay)) return "Check";
  if (mask === "9323" || mask === "1686" || mask === "6526") return "Credit card";
  return "Debit card";
}

// Who you actually paid, across EVERY account — the same audited Plaid ledger
// the Categories tab sums, so the two tabs agree by construction. The old
// version read only QuickBooks (= business checking) + Stripe and silently
// missed anything funded from personal accounts, cards, or the Venmo balance —
// the July 2026 crosscheck found Harrison $10.9k short and Paul absent.
export async function peoplePayments(startKey: string, endKey: string): Promise<{
  list: PayeeRow[]; total: number; count: number;
  channelTotals: Record<string, number>; monthTotals: Record<string, number>;
  groupTotals: Record<string, number>;
}> {
  const from = new Date(`${startKey}T00:00:00Z`);
  const to = new Date(`${endKey}T23:59:59Z`);
  const rows = await prisma.plaidTransaction.findMany({
    where: {
      date: { gte: from, lte: to }, amount: { gt: 0 },
      financeKind: "BUSINESS", financeCategory: { in: Object.keys(PEOPLE_CATS) },
    },
    select: { amount: true, date: true, name: true, merchantName: true, financeCategory: true, account: { select: { mask: true } } },
  });

  const people: Record<string, PayeeRow> = {};
  const channelTotals: Record<string, number> = {};
  const monthTotals: Record<string, number> = {};
  const add = (payee: string, group: string, channel: string, amount: number, at: Date) => {
    const p = (people[payee] ||= { payee, group, total: 0, count: 0, channels: {}, primaryChannel: channel, months: {}, lastAt: at });
    p.total += amount; p.count++;
    p.channels[channel] = (p.channels[channel] || 0) + amount;
    const m = at.toISOString().slice(0, 7);
    p.months[m] = (p.months[m] || 0) + amount;
    if (at > p.lastAt) p.lastAt = at;
    channelTotals[channel] = (channelTotals[channel] || 0) + amount;
    monthTotals[m] = (monthTotals[m] || 0) + amount;
  };

  for (const r of rows) {
    let payee = r.financeCategory === "Consulting (Paul)"
      ? "Paul — consulting"
      : vendorName(r.name || r.merchantName || "");
    for (const [rx, canon] of PERSON_CANON) if (rx.test(payee)) { payee = canon; break; }
    add(payee, PEOPLE_CATS[r.financeCategory!] ?? "Other", payChannel(r.name || "", r.account?.mask), r.amount, r.date);
  }

  // Stripe Connect transfers (off the bank rail) — attributed EXACTLY per
  // transfer via the destination account (stamped by syncStripe) and MERGED
  // into each person's row. Unstamped rows show combined, never guessed.
  const stripeTransfers = await prisma.stripeTransaction.findMany({
    where: { type: "transfer", createdAt: { gte: from, lte: to } },
  });
  for (const r of stripeTransfers) {
    const person = (r.destination && STRIPE_CONNECT_ACCOUNTS[r.destination]) || "James & Harrison (Stripe, unattributed)";
    add(person, "Creative specialists", "Stripe", Math.abs(r.gross), r.createdAt);
  }

  // Keep the roster readable: sub-$100 software vendors roll into one line.
  const list: PayeeRow[] = [];
  const rollup: PayeeRow = { payee: "Smaller subscriptions (rolled up)", group: "Software & tools", total: 0, count: 0, channels: {}, primaryChannel: "Debit card", months: {}, lastAt: from };
  for (const p of Object.values(people)) {
    if (p.group === "Software & tools" && p.total < 100) {
      rollup.total += p.total; rollup.count += p.count;
      for (const [ch, amt] of Object.entries(p.channels)) rollup.channels[ch] = (rollup.channels[ch] || 0) + amt;
      for (const [m, amt] of Object.entries(p.months)) rollup.months[m] = (rollup.months[m] || 0) + amt;
      if (p.lastAt > rollup.lastAt) rollup.lastAt = p.lastAt;
      continue;
    }
    list.push(p);
  }
  if (rollup.total > 0) list.push(rollup);
  list.sort((a, b) => b.total - a.total);

  const groupTotals: Record<string, number> = {};
  for (const p of list) {
    p.primaryChannel = Object.entries(p.channels).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
    groupTotals[p.group] = (groupTotals[p.group] || 0) + p.total;
  }
  return { list, total: list.reduce((s, p) => s + p.total, 0), count: list.length, channelTotals, monthTotals, groupTotals };
}

// ---------------------------------------------------------------------------
// PERSONAL SPENDING — the owner-draw side, bucketed into human categories.
// ---------------------------------------------------------------------------
const PERSONAL_BUCKETS: [RegExp, string][] = [
  [/doordash|grubhub|uber ?eats|postmates|taco bell|mcdonald|wendy|burger king|chick-?fil|\bpanera\b|starbucks|dunkin|chipotle|\bsubway\b|\bkfc\b|popeyes|chophouse|steakhouse|\bgrill\b|\bpizza\b|\bcafe\b|\bdiner\b|restaurant|\btst\*|kole/i, "Dining & delivery"],
  [/stauffers|reiff|farm market|\baldi\b|\bgiant\b|\bweis\b|whole foods|trader joe|wegmans|\bkroger\b|grocery/i, "Groceries"],
  [/sheetz|\bwawa\b|city convenience|convenience|circle k|7-?eleven|turkey hill/i, "Convenience & snacks"],
  [/amazon|\bamzn\b|\btarget\b|wal-?mart|walmart|costco|dollar general|dollar tree|best buy|home depot|lowe'?s|\bikea\b/i, "Shopping"],
  [/netflix|\bhulu\b|disney|hbo|prime video|spotify|youtube|paramount|peacock|apple\.com\/bill|audible|elevenlabs|seaart|anthropic|openai/i, "Subscriptions & streaming"],
  [/\bcheck\s*#?\s*\d|\brent\b|mortgage/i, "Rent & housing"],
  [/barber|\bsalon\b|haircut|\bnails\b|carpe|rythm ?health|dentist|pharmacy|\bcvs\b|walgreens/i, "Personal care & health"],
  [/katie ?macintyre|lauren spackman|laurie spackman|\bnanny\b|good ?and ?beautiful|goodandbeautiful|little ?poppy|littlepoppyco/i, "Family & childcare"],
  [/whitetail|disposal|verizon|comcast|\bpeco\b|\bppl\b|electric|water authority|\butilit/i, "Utilities"],
  [/atm withdrawal|cash withdrawal|\batm\b/i, "Cash & ATM"],
  [/sunbit|\btilt\b|empower|affirm|klarna|afterpay/i, "Loans & financing"],
  [/exxon|\bshell\b|sunoco|\bmobil\b|\bgulf\b|\bfuel\b|\bpspt\b|parking/i, "Fuel & auto"],
];
function personalBucket(text: string): string {
  for (const [rx, b] of PERSONAL_BUCKETS) if (rx.test(text)) return b;
  return "Other";
}

/** Personal (owner-draw) spending bucketed by category, month, and top vendor. */