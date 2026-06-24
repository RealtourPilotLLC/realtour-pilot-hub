import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";

// Safety audit: catch any extracted knowledge that should be OWNER-only but got
// tagged ADMIN/CREATIVE. Keyword pre-filter finds candidates, then Claude judges
// each, and confirmed-sensitive items are bumped to OWNER. Only audits the
// machine-extracted set (playbook + hub-guide are hand-verified).
//   npx tsx --env-file=.env scripts/auditOwnerTier.ts

const MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = 6;
// Signals that an item MIGHT be owner-sensitive (money, pay, strategy, people, personal).
const SENSITIVE = /\$\s?\d|\d+\s?%|margin|profit|revenue|cost|costs|\bpay\b|payout|payroll|commission|salary|wage|rate per|per mile|mileage|vendor|luma|competitor|compet|flight risk|underperform|under-perform|\bfire\b|fired|firing|strike|quit|leaving|equity|investor|net income|bank|\bdebt\b|\bowe|profit margin|pricing strategy|markup|wholesale|our cost|takehome|take-home|personal|divorce|health|family|tax|llc|liabilit/i;

let key: string | null = null;

async function judge(title: string, body: string): Promise<{ owner: boolean; reason: string } | null> {
  const system = `You are a confidentiality auditor for a real estate media agency. Decide if ONE knowledge item contains OWNER-ONLY information that must NOT be visible to a photographer/editor (creative) or an operations admin (the VA, Kyle).

OWNER-ONLY = the agency's own finances, revenue, profit, margins, internal costs, contractor or employee PAY rates, vendor costs, internal pricing strategy/logic, growth targets, strategic plans, personnel assessments (who underperforms or might leave), legal/HR matters, or anything personal/private about the owner.

NOT owner-only = client-facing prices and standard published fees (admins quote those to clients), general SOPs, shoot/edit craft, comms tone, scheduling. A client paying us is fine for admin. Be precise: only flag genuine internal/sensitive financial, strategic, personnel, or personal content.

Return ONLY JSON: {"owner": true|false, "reason": "<short>"}.`;
  const user = `Title: ${title}\nBody: ${body}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1200));
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 200, system, messages: [{ role: "user", content: user }] }),
      });
    } catch { continue; }
    if (res.status === 429 || res.status === 529 || res.status >= 500) continue;
    const j = (await res.json().catch(() => ({}))) as { content?: { text?: string }[] };
    const m = (j.content?.[0]?.text ?? "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
  return null;
}

async function main() {
  key = await getSecret("ai");
  if (!key) { console.error("AI not connected"); process.exit(1); }

  const items = await prisma.knowledgeItem.findMany({
    where: { source: "chatgpt-export", minRole: { in: ["ADMIN", "CREATIVE"] }, archived: false },
    select: { id: true, title: true, body: true, minRole: true, category: true },
  });
  const candidates = items.filter((it) => SENSITIVE.test(`${it.title} ${it.body}`));
  console.log(`${items.length} ADMIN/CREATIVE extracted items; ${candidates.length} flagged for review.`);

  const bumped: { title: string; from: string; reason: string }[] = [];
  let idx = 0, judged = 0;
  async function worker() {
    while (idx < candidates.length) {
      const it = candidates[idx++];
      const verdict = await judge(it.title, it.body);
      judged++;
      if (verdict?.owner) {
        await prisma.knowledgeItem.update({ where: { id: it.id }, data: { minRole: "OWNER" } });
        bumped.push({ title: it.title, from: it.minRole, reason: verdict.reason });
      }
      if (judged % 50 === 0) console.log(`  judged ${judged}/${candidates.length} (bumped ${bumped.length})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\nAudit complete. Bumped ${bumped.length} items to OWNER:`);
  for (const b of bumped.slice(0, 40)) console.log(`  • (${b.from}→OWNER) ${b.title}  [${b.reason}]`);
  const byRole = await prisma.knowledgeItem.groupBy({ by: ["minRole"], _count: { _all: true } });
  console.log("\nFinal KB by role:", byRole.map((r) => `${r.minRole}:${r._count._all}`).join("  "));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
