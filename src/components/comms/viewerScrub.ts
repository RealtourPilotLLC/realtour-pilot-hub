import "server-only";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney, canSeePrices } from "@/lib/auth/access";
import { scrubMoney } from "@/lib/text";

// ---------------------------------------------------------------------------
// THE MONEY RULE ON CLIENT WORDS (Oct 20 2026, audit F7). Kyle never sees a
// dollar amount, and clients' own texts and emails are where pricing turns up
// ("$50 per room"). Messages · Waiting on us already ran them through
// scrubMoney for anyone but the owner; Texts, Email, a conversation and the
// client page's chat replayed the same words raw. Every comms reader now asks
// here. The EFFECTIVE role, so "view as Kyle" previews the scrubbed page; a
// sessionless request sees figures only when enforcement is off (local dev).
// ---------------------------------------------------------------------------
export type Scrub = (s: string) => string;

const keep: Scrub = (s) => s;

// PRICES ARE A SEPARATE ANSWER (Oct 27 2026). Jordan: "Admins can see prices
// of services and billing. I just dont want admin seeing what I pay other team
// members." So an order's price beside a conversation follows seesPrices (the
// owner and admins, canSeePrices). The scrub on client and team words stays
// owner-only: a thread can carry anything, pay talk included, and nothing in
// it is labelled as a price.
export async function viewerMoneyView(): Promise<{ seesMoney: boolean; seesPrices: boolean; clean: Scrub }> {
  const me = await getCurrentUser().catch(() => null);
  const seesMoney = me ? canSeeMoney(me.role) : !authEnforced();
  const seesPrices = me ? canSeePrices(me.role) : !authEnforced();
  return { seesMoney, seesPrices, clean: seesMoney ? keep : scrubMoney };
}
