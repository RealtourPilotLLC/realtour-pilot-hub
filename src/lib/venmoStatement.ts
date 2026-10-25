import "server-only";
import { prisma } from "@/lib/prisma";
import { balanceCheck, decideRow, feeDecision, readStatement, type VenmoDecision } from "@/lib/venmoStatementCore";

// ---------------------------------------------------------------------------
// VENMO STATEMENTS, SERVER HALF (Oct 24 2026). Reads one monthly CSV
// (venmoStatementCore) and writes its rows onto the statement pseudo-account
// (PlaidAccount "venmo-jordan" / "venmo-lauren"), locked, so the categorizer
// never overwrites them. Re-importing a month is safe: a row already on file
// (by its Venmo id, or by day + amount + who for the Jan–Jul imports, which
// keyed outflows by file position) is left as it is. Dry run by default.
// ---------------------------------------------------------------------------

export type ImportLine = { date: string; name: string; amount: number; kind: string | null; category: string | null; state: "new" | "on file" | "not imported" };
export type ImportResult = {
  ok: boolean; message: string;
  account: string | null; period: string | null; tie: string;
  lines: ImportLine[];
  added: number; already: number;
  totals: Record<string, number>;
};

const dayOf = (at: string) => new Date(`${at.slice(0, 10)}T12:00:00Z`);

export async function importVenmoStatement(text: string, opts: { apply?: boolean } = {}): Promise<ImportResult> {
  const st = readStatement(text);
  const empty = { account: null, period: null, tie: "", lines: [], added: 0, already: 0, totals: {} };
  if (!st.owner) return { ok: false, message: st.handle ? `That statement is @${st.handle}'s. The hub reads Jordan's and Lauren's Venmo.` : "That isn't a Venmo statement CSV (venmo.com → Statements → Download CSV).", ...empty };
  if (!st.rows.length) return { ok: false, message: "That statement has no transactions in it.", ...empty };
  const owner = st.owner;
  const acct = await prisma.plaidAccount.findUnique({ where: { accountId: owner.accountId }, select: { accountId: true } });
  if (!acct) return { ok: false, message: `The ${owner.me} Venmo account isn't set up in the books yet.`, ...empty };

  const [clients, creatives] = await Promise.all([
    prisma.client.findMany({ select: { name: true } }),
    prisma.teamMember.findMany({ where: { OR: [{ role: { in: ["PHOTOGRAPHER", "EDITOR"] } }, { creativeManager: true }] }, select: { name: true } }),
  ]);
  const known = {
    clients: new Set(clients.map((c) => c.name.trim().toLowerCase())),
    creatives: new Set(creatives.map((t) => t.name.trim().toLowerCase()).filter((n) => !/spackman/.test(n))),
  };
  const ids = (venmoId: string, d: VenmoDecision) =>
    owner.via ? `${owner.idPrefix}-${d.direction === "in" ? "in-" : ""}${venmoId}` : `venmo-${d.direction === "in" ? "stmt-in" : "out"}-${venmoId}`;

  // Rows already on this account around the statement's dates (for the legacy ids).
  const from = new Date(`${st.periodStart}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 2);
  const to = new Date(`${st.periodEnd}T23:59:59Z`); to.setUTCDate(to.getUTCDate() + 2);
  const onFile = await prisma.plaidTransaction.findMany({ where: { accountId: owner.accountId, date: { gte: from, lte: to } }, select: { id: true, date: true, amount: true, name: true } });
  const claimed = new Set<string>();
  const already = (id: string, d: VenmoDecision, at: string) => {
    const exact = onFile.find((r) => r.id === id);
    if (exact) { claimed.add(exact.id); return true; }
    const day = dayOf(at).getTime();
    const who = d.counterparty.split(/\s+/)[0]?.toLowerCase() ?? "";
    const twin = onFile.find((r) => !claimed.has(r.id) && Math.abs(r.amount - d.amount) < 0.005 && Math.abs(r.date.getTime() - day) <= 1.5 * 86_400_000 && (r.name ?? "").toLowerCase().includes(who));
    if (twin) { claimed.add(twin.id); return true; }
    return false;
  };

  const lines: ImportLine[] = [];
  const writes: { id: string; date: Date; amount: number; name: string; kind: string; category: string }[] = [];
  const clientIns: number[] = [];
  for (const r of st.rows) {
    if (r.status && !/complete/i.test(r.status)) { lines.push({ date: r.at.slice(0, 10), name: `${r.type} (${r.status})`, amount: -r.amount, kind: null, category: null, state: "not imported" }); continue; }
    const d = decideRow(r, owner, known);
    if (d.kind === "INCOME") clientIns.push(Date.parse(r.at));
    if (d.kind) {
      const id = ids(r.venmoId, d);
      const state = already(id, d, r.at) ? "on file" : "new";
      lines.push({ date: r.at.slice(0, 10), name: d.name, amount: d.amount, kind: d.kind, category: d.category, state });
      if (state === "new") writes.push({ id, date: dayOf(r.at), amount: d.amount, name: d.name, kind: d.kind, category: d.category! });
    } else {
      lines.push({ date: r.at.slice(0, 10), name: `${d.name} (the bank's "Venmo" deposit carries it)`, amount: d.amount, kind: null, category: null, state: "not imported" });
    }
    const t = Date.parse(r.at);
    const fee = feeDecision(r, clientIns.some((x) => x <= t && t - x < 3 * 86_400_000));
    if (fee) {
      const id = `${owner.idPrefix}-fee-${r.venmoId}`;
      const fd: VenmoDecision = { kind: fee.kind, category: fee.category, amount: r.fee, counterparty: "Venmo", direction: "out", name: `Venmo instant transfer fee${owner.via ? ` (via ${owner.via})` : ""}` };
      const state = already(id, fd, r.at) ? "on file" : "new";
      lines.push({ date: r.at.slice(0, 10), name: fd.name, amount: r.fee, kind: fee.kind, category: fee.category, state });
      if (state === "new") writes.push({ id, date: dayOf(r.at), amount: r.fee, name: fd.name, kind: fee.kind, category: fee.category });
    }
  }
  const totals: Record<string, number> = {};
  for (const l of lines) if (l.kind) totals[`${l.kind} · ${l.category}`] = Math.round(((totals[`${l.kind} · ${l.category}`] ?? 0) + l.amount) * 100) / 100;
  const tie = balanceCheck(st);
  if (opts.apply && writes.length) {
    await prisma.$transaction(writes.map((w) => prisma.plaidTransaction.upsert({
      where: { id: w.id },
      create: { id: w.id, accountId: owner.accountId, amount: w.amount, isoCurrency: "USD", date: w.date, name: w.name, merchantName: null, pending: false, financeKind: w.kind, financeCategory: w.category, financeLocked: true },
      update: {},
    })));
  }
  const added = opts.apply ? writes.length : 0;
  const alreadyN = lines.filter((l) => l.state === "on file").length;
  const review = lines.filter((l) => l.kind === "REVIEW" && l.state === "new").length;
  return {
    ok: true,
    message: `${owner.me}'s Venmo ${st.periodStart} to ${st.periodEnd}: ${opts.apply ? `${added} added` : `${writes.length} to add`}, ${alreadyN} already on file.${review ? ` ${review} payment${review === 1 ? "" : "s"} to someone the hub doesn't know: pick business or personal on Finance → Categories.` : ""} ${tie.words}`,
    account: owner.accountId, period: `${st.periodStart} to ${st.periodEnd}`, tie: tie.words, lines, added, already: alreadyN, totals,
  };
}
