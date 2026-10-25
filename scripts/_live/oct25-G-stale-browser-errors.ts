export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 25 2026 audit, area G): the browser errors that have
// stopped happening, off Jordan's daily error report.
//
// The tracker closes a server error itself once it stops recurring, but it
// leaves a BROWSER error open on purpose ("a page nobody has opened since is
// not a fix"). So the 8 open rows on Settings → Errors are all browser rows,
// every morning's report lists them, and none has happened since Oct 22:
//   · 6 × React #418 (the page's first paint differed from the server's) on
//     the dashboard, /editing, /edit/[id], /content/[id], /portal/me and
//     /connections, 41 times between Oct 9 and Oct 22 10:44 PM ET. The dashboard
//     and the desks were rebuilt on Oct 23; the pages have been opened all
//     weekend without one.
//   · 1 × "network error" on /edit/[id] (Oct 14, a dropped connection) and
//     1 × React #419 on the portal (Oct 13, a server render that failed once).
// This marks the rows still OPEN and quiet for 48 hours FIXED, with a note
// saying why. If one happens again, the tracker reopens it on its own and it
// is back in the report. Nothing is deleted; nothing is sent.
//
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct25-G-stale-browser-errors.ts           # dry run (read-only)
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct25-G-stale-browser-errors.ts --apply   # writes
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const QUIET_MS = 48 * 3600_000;
const BROWSER = ["client", "client-portal"];
const NOTE = "audit Oct 25 2026: browser error, not seen in 48 h";

async function main() {
  const prisma = await db();
  const now = new Date();
  const rows = await prisma.errorEvent.findMany({
    where: { status: "OPEN", source: { in: BROWSER } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, source: true, route: true, message: true, count: true, firstSeenAt: true, lastSeenAt: true },
  });
  const quiet = rows.filter((r) => now.getTime() - r.lastSeenAt.getTime() >= QUIET_MS);
  for (const r of rows) {
    const q = quiet.includes(r);
    console.log(`${q ? "CLOSE" : "KEEP "} ${r.id} ${r.source} ${r.route ?? "-"} x${r.count} ${r.firstSeenAt.toISOString().slice(0, 10)}..${r.lastSeenAt.toISOString().slice(0, 16)} ${r.message.replace(/\s+/g, " ").slice(0, 70)}`);
  }
  console.log(`${rows.length} open browser errors; would mark ${quiet.length} fixed, keep ${rows.length - quiet.length}`);
  if (!APPLY) process.exit(0);
  let n = 0;
  for (const r of quiet) {
    // Only while it is still the row we read: a new occurrence since moves lastSeenAt and keeps it open.
    const u = await prisma.errorEvent.updateMany({ where: { id: r.id, status: "OPEN", lastSeenAt: r.lastSeenAt }, data: { status: "FIXED", resolvedAt: now, resolvedBy: NOTE } });
    n += u.count;
  }
  console.log(`marked ${n} fixed`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
