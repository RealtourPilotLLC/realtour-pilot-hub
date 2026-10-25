// ---------------------------------------------------------------------------
// VENMO STATEMENTS, PURE HALF (Oct 24 2026). Venmo has no API: the monthly
// CSV statement (venmo.com → Statements → Download CSV) is the only record of
// who each Venmo payment went to. The bank feed shows every Venmo debit as
// "Venmo" and the finance engine books those EXCLUDE ("see Venmo rows"), so a
// month whose statement isn't imported is a month of contractor pay, nanny
// pay and Stephen Kennedy's revenue counted nowhere. Jordan sent Jul–Oct on
// Oct 24; Jul 17–Oct 23 had been invisible (~$19.5k of creative pay, ~$8.1k
// of client revenue).
//
// This file parses the CSV (quote-aware: notes carry commas and newlines) and
// decides each row by WHO it moved money with, using the rules the owner set
// on Jul 22–23 (reference-finance-dashboard):
//   Harrison / James / any creative on the roster → BUSINESS "Creative specialist pay"
//   Katie MacIntyre → PERSONAL "Childcare / nanny"
//   Lauren ↔ Jordan → EXCLUDE (household money moving between them)
//   a client paying (Stephen Kennedy) → INCOME "Venmo revenue (client)"
//   Instant Add Funds from his own card → EXCLUDE self-transfer
//   Instant / standard transfers to the bank → not imported (the bank's
//     "Venmo cash-out" line carries them); their FEE is imported
//   friends paying back → EXCLUDE; anyone else paid → REVIEW (the owner decides)
// No prisma, no server-only.
// ---------------------------------------------------------------------------

export type VenmoOwner = { handle: string; me: string; accountId: string; idPrefix: string; via: string | null };
export const VENMO_OWNERS: VenmoOwner[] = [
  { handle: "Jordan-Spackman-1", me: "Jordan Spackman", accountId: "venmo-jordan", idPrefix: "venmo", via: null },
  { handle: "Lspackman1", me: "Lauren Spackman", accountId: "venmo-lauren", idPrefix: "venmo-l", via: "Lauren" },
];
const HOUSEHOLD = /^(jordan|lauren|laurie) spackman$/i;
const NANNY = /katie ?mac/i;

/** Quote-aware CSV: fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** "- $1,500.00" → -1500; "+ $25.53" → 25.53; "" → 0 */
export function money(v: string | undefined): number {
  const t = (v ?? "").replace(/\s+/g, "");
  if (!t) return 0;
  const n = Number(t.replace(/[+$,-]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return t.startsWith("-") ? -n : n;
}

export type StatementRow = {
  venmoId: string; at: string; type: string; status: string; note: string;
  from: string; to: string; amount: number; fee: number; funding: string; destination: string;
};
export type Statement = {
  owner: VenmoOwner | null; handle: string | null;
  rows: StatementRow[];
  beginning: number | null; ending: number | null; feesThisPeriod: number | null;
  periodStart: string | null; periodEnd: string | null;
};

export function readStatement(text: string): Statement {
  const all = parseCsv(text);
  const handle = (all[0]?.[0] ?? "").match(/\(@([^)]+)\)/)?.[1]?.trim() ?? null;
  const owner = VENMO_OWNERS.find((o) => o.handle.toLowerCase() === handle?.toLowerCase()) ?? null;
  const hi = all.findIndex((r) => r.includes("ID") && r.includes("Datetime") && r.includes("Amount (total)"));
  const out: Statement = { owner, handle, rows: [], beginning: null, ending: null, feesThisPeriod: null, periodStart: null, periodEnd: null };
  if (hi < 0) return out;
  const h = all[hi];
  const col = (name: string) => h.indexOf(name);
  const C = { id: col("ID"), at: col("Datetime"), type: col("Type"), status: col("Status"), note: col("Note"), from: col("From"), to: col("To"), amt: col("Amount (total)"), fee: col("Amount (fee)"), fund: col("Funding Source"), dest: col("Destination"), beg: col("Beginning Balance"), end: col("Ending Balance"), fees: col("Statement Period Venmo Fees") };
  for (const r of all.slice(hi + 1)) {
    if (C.beg >= 0 && r[C.beg]?.trim() && out.beginning == null) out.beginning = money(r[C.beg]);
    if (C.end >= 0 && r[C.end]?.trim()) out.ending = money(r[C.end]);
    if (C.fees >= 0 && r[C.fees]?.trim()) out.feesThisPeriod = Math.abs(money(r[C.fees]));
    const at = (r[C.at] ?? "").trim();
    const id = (r[C.id] ?? "").trim();
    if (!id || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) continue;
    out.rows.push({
      venmoId: id, at, type: (r[C.type] ?? "").trim(), status: (r[C.status] ?? "").trim(), note: (r[C.note] ?? "").replace(/\s+/g, " ").trim(),
      from: (r[C.from] ?? "").trim(), to: (r[C.to] ?? "").trim(), amount: money(r[C.amt]), fee: Math.abs(money(r[C.fee])),
      funding: (r[C.fund] ?? "").trim(), destination: (r[C.dest] ?? "").trim(),
    });
  }
  const days = out.rows.map((r) => r.at.slice(0, 10)).sort();
  out.periodStart = days[0] ?? null;
  out.periodEnd = days[days.length - 1] ?? null;
  return out;
}

/** The statement's own arithmetic: beginning + what moved through the balance = ending. */
export function balanceCheck(st: Statement): { ok: boolean; computed: number | null; words: string } {
  if (st.beginning == null || st.ending == null) return { ok: false, computed: null, words: "The statement has no beginning or ending balance to check against." };
  let bal = st.beginning;
  for (const r of st.rows) {
    if (r.status && !/complete/i.test(r.status)) continue;
    // A payment or charge funded by a card or bank never touches the Venmo balance.
    const outsideFunded = r.amount < 0 && !!r.funding && !/venmo balance/i.test(r.funding);
    const outsidePaid = r.amount > 0 && !!r.destination && !/venmo balance/i.test(r.destination);
    if (outsideFunded || outsidePaid) continue;
    // A transfer's fee comes out of what reaches the bank, not out of the balance.
    bal += r.amount;
  }
  const computed = Math.round(bal * 100) / 100;
  const ok = Math.abs(computed - st.ending) < 0.01;
  return { ok, computed, words: ok ? `Ties: $${st.beginning.toFixed(2)} start → $${st.ending.toFixed(2)} end.` : `Doesn't tie: rows give $${computed.toFixed(2)}, the statement says $${st.ending.toFixed(2)}.` };
}

export type VenmoDecision = {
  /** null = not imported (a transfer to the bank: the bank feed carries it) */
  kind: "BUSINESS" | "PERSONAL" | "EXCLUDE" | "INCOME" | "REVIEW" | null;
  category: string | null;
  /** Plaid convention: positive = money out, negative = money in */
  amount: number;
  counterparty: string;
  direction: "in" | "out";
  name: string;
};

export function decideRow(r: StatementRow, owner: VenmoOwner, known: { clients: Set<string>; creatives: Set<string> }): VenmoDecision {
  const direction: "in" | "out" = r.amount >= 0 ? "in" : "out";
  const counterparty = (r.from && r.from !== owner.me ? r.from : r.to) || (r.funding || r.destination || "own account");
  const lc = counterparty.toLowerCase();
  const via = owner.via ? ` (via ${owner.via})` : "";
  const amount = -r.amount;
  const note = r.note ? `: ${r.note}` : "";
  if (/transfer/i.test(r.type) && !/add funds/i.test(r.type)) {
    return { kind: null, category: null, amount, counterparty: r.destination || "bank", direction, name: `Transfer to ${r.destination || "bank"}` };
  }
  if (/add funds/i.test(r.type)) {
    return { kind: "EXCLUDE", category: "Self-transfer (own accounts)", amount, counterparty: r.funding || "own card", direction, name: `Instant Add Funds ← own ${r.funding || "card"}` };
  }
  const name = direction === "in" ? `Received ← ${counterparty}${via}${note}` : `Venmo → ${counterparty}${via}${note}`;
  const base = { amount, counterparty, direction, name: name.slice(0, 240) };
  if (HOUSEHOLD.test(counterparty)) return { ...base, kind: "EXCLUDE", category: owner.via ? "Self-transfer (own accounts)" : "Transfer to wife (household)" };
  if (direction === "in") {
    if (known.clients.has(lc)) return { ...base, kind: "INCOME", category: "Venmo revenue (client)" };
    return { ...base, kind: "EXCLUDE", category: "Paid back by friends or family" };
  }
  if (known.creatives.has(lc)) return { ...base, kind: "BUSINESS", category: "Creative specialist pay" };
  if (NANNY.test(counterparty)) return { ...base, kind: "PERSONAL", category: "Childcare / nanny" };
  return { ...base, kind: "REVIEW", category: "Venmo payment (who is this?)" };
}

/** Venmo's fee on an instant transfer to the bank: business when it moved client money. */
export function feeDecision(r: StatementRow, clientInflowBefore: boolean): { kind: "BUSINESS" | "PERSONAL"; category: string } | null {
  if (!(r.fee > 0) || !/transfer/i.test(r.type) || /add funds/i.test(r.type)) return null;
  return clientInflowBefore ? { kind: "BUSINESS", category: "Venmo transfer fees" } : { kind: "PERSONAL", category: "Other personal" };
}
