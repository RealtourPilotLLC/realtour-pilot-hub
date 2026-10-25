// ---------------------------------------------------------------------------
// LIVE REPAIR (audit Oct 25 2026, area F): messages filed to a job only
// because a town name looked like its street.
//
// Marcee McMullen's job is 1244 West Chester Pike. Its street core is "West
// Chester", which is also a town: any mail with "West Chester PA" in a
// signature matched it, and the longest core won over a real address in the
// same mail. Kimberly Mazzenga's two Oct 24 replies on "1316 Blair
// Updates/Showcase" (Mike Flatley's job) landed on Marcee that way. The router
// now ranks "number + street" above any bare street (contacts.streetMatchScore).
//
// This re-reads every comms row of the last 30 days filed to a job by a
// street match (not a guess) whose writer is not that job's client, scores the
// row's own words (subject + the message without quoted history) against all
// jobs with the new rule, and re-files the row when a DIFFERENT job now wins
// with a house number. Nothing else changes: no task, no ask, no message.
//
// DRY RUN by default. `--apply` writes.
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct25-F-town-name-refile.ts [--apply]
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
if (!APPLY) process.env.DATABASE_URL += (process.env.DATABASE_URL!.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";

async function main() {
  const { installNextStubs } = await import("../_drill/_harness");
  installNextStubs();
  const { prisma } = await import("../../src/lib/prisma");
  const { streetMatchScore } = await import("../../src/lib/contacts");
  const { stripQuotedReply, clip } = await import("../../src/lib/text");
  const since = new Date(Date.now() - 30 * 864e5);
  const rows = await prisma.commLog.findMany({
    where: { occurredAt: { gte: since }, direction: "in", projectId: { not: null }, projectGuess: false, channel: { in: ["email", "text"] } },
    select: { id: true, clientId: true, clientName: true, contactName: true, projectId: true, subject: true, body: true, channel: true, occurredAt: true },
  });
  const projects = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" } },
    select: { id: true, title: true, addressLine: true, clientId: true, client: { select: { name: true } } },
    orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }, { shootDate: { sort: "desc", nulls: "last" } }],
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  const words = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const changes: { id: string; from: string; to: { projectId: string; clientId: string; clientName: string | null; title: string } }[] = [];
  for (const r of rows) {
    const filed = byId.get(r.projectId!);
    if (!filed) continue;
    // Only rows whose writer is not the filed job's client (their own mail stays theirs).
    const cw = new Set(words(filed.client?.name));
    if (words(r.contactName).some((w) => cw.has(w))) continue;
    const text = `${r.subject ?? ""} ${r.channel === "email" ? clip(stripQuotedReply(r.body), 2000) : r.body}`.toLowerCase();
    const filedScore = streetMatchScore(filed, text);
    let best: { p: (typeof projects)[number]; score: number } | null = null;
    for (const p of projects) {
      const s = streetMatchScore(p, text);
      if (s > (best?.score ?? 0)) best = { p, score: s };
    }
    // Only a row the old router filed by a BARE street (0 < score < 1000):
    // a row filed by a person's repair, a listing link or the team router
    // (score 0 here) or by a number-and-street match stays where it is.
    if (!best || best.p.id === filed.id || best.score < 1000 || filedScore === 0 || filedScore >= 1000 || !best.p.clientId) continue;
    changes.push({ id: r.id, from: `${filed.title} (${filed.client?.name})`, to: { projectId: best.p.id, clientId: best.p.clientId, clientName: best.p.client?.name ?? null, title: best.p.title } });
    console.log(`${r.occurredAt.toISOString().slice(0, 16)} ${r.contactName} "${(r.subject ?? r.body).slice(0, 50)}"\n    from ${filed.title} (${filed.client?.name})\n    to   ${best.p.title} (${best.p.client?.name})`);
  }
  console.log(`\n${changes.length} row(s) ${APPLY ? "re-filed" : "would be re-filed"} (of ${rows.length} street-filed inbound rows in 30 days).`);
  if (APPLY) {
    for (const c of changes) {
      await prisma.commLog.update({ where: { id: c.id }, data: { projectId: c.to.projectId, clientId: c.to.clientId, clientName: c.to.clientName, projectGuess: false } });
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(String(e).slice(0, 900)); process.exit(1); });
