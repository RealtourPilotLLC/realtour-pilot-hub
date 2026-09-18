// READ-ONLY probe against the live database: what does the obligation ledger
// actually hold today, and what does turning it on change on the boards?
// Nothing here writes. Run:
//   NODE_OPTIONS="--conditions=react-server --require ./scripts/_drill/_drill-preload.cjs" \
//     npx tsx scripts/_fix/R07/probe-ledger.ts
import { unansweredComms, openObligations } from "@/lib/replyQueue";
import { prisma } from "@/lib/prisma";

const fmt = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const now = new Date();

  const obligations = await openObligations({ now });
  console.log(`\nOPEN OBLIGATIONS (no window, no row cap): ${obligations.length}`);
  for (const o of obligations) {
    console.log(
      `  ${o.beyondWindow ? "OUTSIDE" : "inside "} window · ${String(o.daysWaiting).padStart(3)}d · ${o.family.padEnd(5)} · ${o.kind.padEnd(12)} · ${o.displayName}` +
        `\n      last inbound ${fmt(o.lastInboundAt)}: ${JSON.stringify(o.lastInboundText.slice(0, 90))}` +
        `\n      next action: ${JSON.stringify(o.nextAction)} · followUpAt=${o.followUpAt ? fmt(o.followUpAt) : "null"} · blockedReason=${o.blockedReason ?? "null"}`,
    );
  }
  const beyond = obligations.filter((o) => o.beyondWindow);
  console.log(`\n  ${beyond.length} of them are OLDER than the 7-day message window — the rows that used to age out.`);

  for (const family of ["phone", "email"] as const) {
    const before = await unansweredComms({ now, families: [family], includeUnmatched: false, includeTeam: false });
    const after = await unansweredComms({ now, families: [family], includeUnmatched: false, includeTeam: false, includeOwed: true });
    const added = after.filter((a) => !before.some((b) => b.key === a.key));
    console.log(`\n${family.toUpperCase()} board: ${before.length} → ${after.length} (${added.length} recovered)`);
    for (const a of added) console.log(`  + ${a.displayName} · waiting ${Math.round(a.hoursWaiting / 24)}d · task ${a.openTaskId}`);
  }

  const unmatched = await unansweredComms({ now, families: ["phone"], includeOwed: true });
  const strangers = unmatched.filter((t) => !t.clientId);
  console.log(`\nUNMATCHED phone conversations on the Replies tab: ${strangers.length}`);
  for (const s of strangers) {
    console.log(`  ${s.displayName}${s.isTeam ? " [our own team]" : ""} · waiting ${Math.round(s.hoursWaiting / 24)}d · lead to-do: ${s.openTaskId ?? "NONE"}${s.fromLedger ? " (from ledger)" : ""}`);
  }
  const orphans = strangers.filter((s) => !s.openTaskId && !s.isTeam);
  console.log(`  ${orphans.length} of them are NOT our own team and still have no to-do behind them.`);

  // How big is the ledger's unbounded read, really?
  const openRows = await prisma.smartTask.count({ where: { taskType: { in: ["client_reply", "lead"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } } });
  console.log(`\nledger read size: ${openRows} open client_reply/lead row(s) — the findMany that has no take.`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
