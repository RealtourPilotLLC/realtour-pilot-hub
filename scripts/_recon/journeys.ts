/**
 * THE FOUR STAFF JOURNEYS, walked against production with the real engines.
 * Read-only: every call below is a query or a pure function. Nothing is written,
 * nobody is contacted.
 */
import Module from "module";
// replyQueue → tasks.ts drags next/navigation in at module load, which tsx
// cannot resolve outside a request. Nothing under test touches it.
const __M = Module as unknown as { prototype: { require: (id: string) => unknown } };
const __real = __M.prototype.require;
__M.prototype.require = function (this: unknown, id: string) {
  if (id === "next/navigation" || id === "next/headers") return {};
  return __real.call(this, id);
} as never;
import { prisma } from "@/lib/prisma";

const line = (k: string, v: unknown) => console.log(`    ${k.padEnd(16)} ${v ?? "—"}`);

async function brief(label: string, projectId: string) {
  const { projectBrief } = await import("@/lib/projectBrief");
  const b = await projectBrief(projectId);
  if (!b) return console.log(`\n### ${label} — NOT FOUND`);
  console.log(`\n### ${label}`);
  line("headline", b.tone.headline);
  line("ordered", b.scope.join(" · "));
  line("videos", `${b.outputsDone} of ${b.outputsOwed} with the client` + (b.currentVersion ? ` · furthest: ${b.currentVersion}` : ""));
  line("promise", b.promisedAt ? `${b.promisedAt.toISOString().slice(0, 10)} (${b.promiseSource})${b.overdue ? " — PAST IT" : ""}` : "none");
  line("client asked", b.latestRequest ? `${b.latestRequest.at.toISOString().slice(0, 10)} — ${b.latestRequest.text.slice(0, 80)}` : "nothing open");
  line("blocker", b.blocker);
  line("whose move", `${b.owner.who} — ${b.nextAction}`);
  const rows = b.outputs.slice(0, 6).map((o) => `${o.index}:${o.state}${o.round ? `/v${o.round}` : ""}`).join(" ");
  line("per video", rows + (b.outputs.length > 6 ? ` …+${b.outputs.length - 6}` : ""));
}

async function main() {
  console.log("=".repeat(78));
  console.log("FOUR STAFF JOURNEYS — the real engines, against production, read-only");
  console.log("=".repeat(78));

  // 1 — a standard listing video
  const standard = await prisma.project.findFirst({
    where: { title: { contains: "Spring Ln" } },
    select: { id: true, title: true },
  });
  if (standard) await brief(`1. STANDARD LISTING VIDEO — ${standard.title}`, standard.id);

  // 2 — a multi-video monthly batch
  const batch = await prisma.project.findFirst({ where: { title: { contains: "5642 Limeport" } }, select: { id: true, title: true } });
  if (batch) await brief(`2. MULTI-VIDEO BATCH — ${batch.title}`, batch.id);

  // 3 — a delivered video that needs replacing: an approved+unsent round with an earlier SENT round on the same slot
  const sent = await prisma.reviewSubmission.findMany({
    where: { sentToClientAt: { not: null } },
    select: { projectId: true, deliverableId: true, slot: true, round: true, project: { select: { title: true } } },
  });
  let replacement: { id: string; title: string } | null = null;
  for (const s of sent) {
    const newer = await prisma.reviewSubmission.findFirst({
      where: { projectId: s.projectId, deliverableId: s.deliverableId, slot: s.slot, round: { gt: s.round }, status: "APPROVED", sentToClientAt: null },
      select: { id: true },
    });
    if (newer) { replacement = { id: s.projectId, title: s.project.title }; break; }
  }
  if (replacement) await brief(`3. REPLACEMENT OWED — ${replacement.title}`, replacement.id);
  else console.log("\n### 3. REPLACEMENT OWED — no job in production is in this state today");

  // 4 — an unresolved client request spanning the message window
  const { openObligations } = await import("@/lib/replyQueue");
  const obs = await openObligations({});
  console.log(`\n### 4. UNRESOLVED CLIENT REQUESTS (the persistent ledger) — ${obs.length} open`);
  for (const o of obs.slice(0, 6)) {
    console.log(`    ${(o.displayName ?? "?").padEnd(22)} ${String(o.daysWaiting).padStart(3)}d  ${o.beyondWindow ? "BEYOND the 7-day window" : "inside the window"}  · owner ${o.ownerId ?? "nobody"} · ${o.nextAction.slice(0, 50)}`);
    console.log(`      asked: ${(o.lastInboundText ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
  }

  // 5 — the exceptions board, as Kyle sees it
  const { opsExceptions } = await import("@/lib/opsExceptions");
  const ex = await opsExceptions();
  console.log(`\n### 5. THE EXCEPTIONS BOARD — ${ex.length} rows`);
  for (const e of ex) console.log(`    [${e.severity}] ${e.kind.padEnd(19)} ${e.title.slice(0, 34).padEnd(35)} ${e.owner.slice(0, 28).padEnd(29)} ${e.nextAction.slice(0, 44)}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
