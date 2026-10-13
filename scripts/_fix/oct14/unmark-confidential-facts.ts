// Oct 14 2026 (Jordan, Oct 13): "Lehigh Valley should not be confidential.
// Nothing in the content strategy should be confidential. The only thing that
// should be confidential is if they say so on the strategy call."
//
// What it does, for every client with an ACTIVE or PAUSED program:
//   · each fact marked confidential is UN-MARKED unless its body, or the call
//     excerpt it was quoted from, shows the client explicitly asked for it to
//     be private (lib/explicitConfidential: don't share, do not share, off the
//     record, between us, keep this/it private/between, confidential, not for
//     the video/camera/content, don't put this/that in/on). Those are KEPT;
//   · an un-marked fact's aiContext goes back to the normal default for its
//     status: ACCEPTED → ALLOWED (what acceptFact sets), anything else →
//     DENIED (what a proposed or rejected fact always has);
//   · its status (PROPOSED / ACCEPTED / …) is NOT changed: a proposed fact
//     still waits for a person;
//   · one AuditLog row per fact (action fact_unmark_confidential, target the
//     fact id) in the same transaction as the change.
// Nothing is sent to anybody. Dry run by default; --apply writes.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/unmark-confidential-facts.ts [--apply]
import { prisma } from "@/lib/prisma";
import { explicitPrivateRequest } from "@/lib/explicitConfidential";

const BY = "info@realtourpilot.com";
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ");

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY" : "DRY RUN (pass --apply to write)");
  const enrollments = await prisma.contentEnrollment.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, select: { clientId: true, status: true } });
  const ids = [...new Set(enrollments.map((e) => e.clientId))];
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const facts = await prisma.clientFact.findMany({
    where: { clientId: { in: ids }, confidential: true },
    orderBy: [{ clientId: "asc" }, { createdAt: "asc" }],
    select: { id: true, clientId: true, body: true, excerptJson: true, status: true, aiContext: true, source: true },
  });
  let unmark = 0;
  let keep = 0;
  let current = "";
  for (const f of facts) {
    const name = clients.get(f.clientId) ?? f.clientId;
    if (name !== current) {
      current = name;
      const st = enrollments.find((e) => e.clientId === f.clientId)?.status ?? "?";
      console.log(`\n== ${name} [${st}]`);
    }
    const asked = explicitPrivateRequest(f.body, f.excerptJson);
    if (asked) {
      keep++;
      console.log(`  KEEP    ${f.status.padEnd(9)} "${clip(f.body)}" (they said: "${asked}")`);
      continue;
    }
    const aiContext = f.status === "ACCEPTED" ? "ALLOWED" : "DENIED";
    unmark++;
    console.log(`  UNMARK  ${f.status.padEnd(9)} aiContext ${f.aiContext} → ${aiContext}  "${clip(f.body)}"`);
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      // Only while it is still marked: a fact changed since this run read it is left alone.
      const n = await tx.clientFact.updateMany({ where: { id: f.id, confidential: true }, data: { confidential: false, aiContext } });
      if (n.count === 0) return;
      await tx.auditLog.create({
        data: {
          actor: BY,
          action: "fact_unmark_confidential",
          target: f.id,
          detail: `${name}: un-marked confidential (no explicit request to keep it private in the fact or its excerpt; Jordan, Oct 13 2026). status ${f.status} unchanged; aiContext ${f.aiContext} -> ${aiContext}. "${clip(f.body, 300)}"`,
        },
      });
    });
  }
  console.log(`\n${facts.length} confidential fact(s) on ${new Set(facts.map((f) => f.clientId)).size} client(s): ${unmark} ${apply ? "un-marked" : "would be un-marked"}, ${keep} kept (the client asked).`);
  if (!apply) console.log("Nothing was written.");
}

main().finally(() => prisma.$disconnect());
