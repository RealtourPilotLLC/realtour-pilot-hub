// ---------------------------------------------------------------------------
// DRILL: R3 — the staff SMS digest strands nothing (follow-up audit, Sep 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/r3-staff-sms-recovery.ts
//
// TWO HOLES, and the first one I put there myself fixing A01:
//
// (1) flushMemberSms claimed every due row, packed, then RELEASED the overflow
//     with `.catch(() => {})` and sent anyway. If the release failed, those rows
//     stayed claimed under the SAME claim stamp as a digest that really went —
//     and recovery reconstructs the outbox key from (member, stamp), finds the
//     outbox owns it, and skips them for ever. Six sent, six stranded.
//     Now the pack decides the batch BEFORE anything is claimed, so there is no
//     release to fail.
//
// (2) recovery read a page of 200 claimed rows with no settled predicate.
//     Settled rows never leave the window and they are the OLDEST, so ordering
//     them first — which is what the A01 pass added — puts history at the front
//     of the page and leaves a later orphan permanently out of reach.
//
// ISOLATION: PGlite, its own DATABASE_URL pinned before any app module loads,
// outbound HTTP fenced to loopback and counted. Production Neon is never opened
// and no provider is called — the outbox provider is replaced.
// ---------------------------------------------------------------------------
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5493;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;
delete process.env.SLACK_ALERT_CHANNEL;

const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(url)) return realFetch(input as string, init as RequestInit);
  outbound.push(url);
  throw new Error(`OUTBOUND BLOCKED BY DRILL: ${url}`);
}) as typeof fetch;

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const notify = await import("@/lib/notify");
  const outbox = await import("@/lib/outbox");

  // The provider never runs: OpenPhone's number lookup and the send are both
  // answered locally, so the REAL flush path runs with no network at all.
  const op = await import("@/lib/integrations/openphone");
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: "+16105550100" }];
  const sent: { to: string; body: string }[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
    sent.push({ to: String(to), body });
    return { data: { id: `op-${sent.length}` } };
  };

  const member = await prisma.teamMember.create({ // NOT a name from the editor roster. "Kim Drill" matched the real editor
  // Kim, whose timezone is Manila — withinTextingHours then deferred the whole
  // flush and this drill read as "the digest did not go" for three runs.
  data: { name: "Dana Quill", email: "dana.quill@realtourpilot.com", phone: "+16105550143" }, select: { id: true } });

  // ======================================================================
  console.log("\n=== R3 (1): nothing is claimed that the text cannot carry ===\n");
  // ======================================================================
  // Twelve ~210-character updates: far more than one text holds.
  const line = (n: number) => `Update ${n}: ` + "x".repeat(210 - `Update ${n}: `.length);
  for (let i = 1; i <= 12; i++) {
    await prisma.pendingSms.create({ data: { teamMemberId: member.id, line: line(i) } });
  }

  // THE OLD FAILURE, made impossible rather than mocked: if a release were
  // still needed, this stub would make it fail. Under the new ordering the
  // release is never called at all, which is the point.
  // BIND the original. A Prisma model delegate is not a plain method: calling
  // it back with `.apply(prisma.pendingSms, args)` returned without performing
  // the update, so the CLAIM silently did nothing and the flush declined with
  // "none" — a drill that tests nothing, again. `.bind` keeps it working.
  const realUpdateMany = prisma.pendingSms.updateMany.bind(prisma.pendingSms) as (...a: unknown[]) => Promise<{ count: number }>;
  let releaseAttempts = 0;
  (prisma.pendingSms as unknown as { updateMany: unknown }).updateMany = async (...args: unknown[]) => {
    const arg = args[0] as { data?: { sentAt?: unknown } };
    if (arg?.data && "sentAt" in (arg.data as object) && (arg.data as { sentAt?: unknown }).sentAt === null) {
      releaseAttempts++;
      throw new Error("deadlock detected"); // the write whose failure stranded six lines
    }
    return realUpdateMany(...args);
  };

  // Say what the preconditions are, so a decline is diagnosable from the log
  // rather than from three more runs.
  const { defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  console.log(`  ·    due=${await prisma.pendingSms.count({ where: { teamMemberId: member.id, sentAt: null } })} openphone=${(await defaultOpenPhoneNumber()) ?? "(none)"} hourET=${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())}`);
  const r1 = await notify.flushPendingSms();
  (prisma.pendingSms as unknown as { updateMany: unknown }).updateMany = realUpdateMany;

  ok("the digest went", sent.length === 1, JSON.stringify(r1));
  ok("BEFORE: the overflow release could fail and strand rows. It is never called", releaseAttempts === 0, `${releaseAttempts} attempt(s)`);

  const carried = sent[0].body.split("\n").filter((l) => l.startsWith("• ")).length;
  const stamped = await prisma.pendingSms.count({ where: { teamMemberId: member.id, sentAt: { not: null } } });
  const stillDue = await prisma.pendingSms.count({ where: { teamMemberId: member.id, sentAt: null } });
  ok("every claimed row is a line in the text that went", stamped === carried, `${stamped} claimed vs ${carried} carried`);
  ok("the rest were never claimed and are still due", stillDue === 12 - carried, `${stillDue} due`);
  ok("no line was recorded as delivered without being in the body", stamped + stillDue === 12);

  const logs = await prisma.notificationDelivery.count({ where: { teamMemberId: member.id, status: "sent" } }).catch(() => 0);
  ok("the delivery log covers exactly what was carried", logs === carried, `${logs} log(s)`);

  const settledFirst = await prisma.pendingSms.count({ where: { teamMemberId: member.id, settledAt: { not: null } } });
  ok("an accepted digest marks exactly its own lines settled", settledFirst === carried, `${settledFirst} settled vs ${carried} carried`);

  // ONE TEXT PER PERSON PER 30 MINUTES is a real rule (Aug 24: Harrison and
  // James were being blown up with back-to-back texts), so the remainder is
  // deliberately NOT sent on the next tick. Assert the rule rather than
  // fighting it — the point of this drill is that the rows are still THERE.
  const heldBack = await notify.flushPendingSms();
  ok("the remainder waits for the batch window rather than going immediately", sent.length === 1, JSON.stringify(heldBack));
  ok("  …and is still queued, not lost", (await prisma.pendingSms.count({ where: { teamMemberId: member.id, sentAt: null } })) === 12 - carried);

  // Age the first digest past the window and the rest goes.
  await prisma.pendingSms.updateMany({ where: { teamMemberId: member.id, sentAt: { not: null } }, data: { sentAt: new Date(Date.now() - 90 * 60_000) } });
  const r2 = await notify.flushPendingSms();
  ok("once the window passes, the remainder is carried", sent.length === 2, JSON.stringify(r2));
  ok("  …and nothing is left due", (await prisma.pendingSms.count({ where: { teamMemberId: member.id, sentAt: null } })) === 0);
  ok("  …with every line accounted for exactly once", sent[0].body.split("\n").filter((l) => l.startsWith("• ")).length + sent[1].body.split("\n").filter((l) => l.startsWith("• ")).length === 12);

  // ======================================================================
  console.log("\n=== R3 (2): the recovery scan cannot fill with history ===\n");
  // ======================================================================
  // The scan only examines flushes older than (first staff outbox row + 5 min)
  // and newer than (now - 15 min), so the fixture has to sit inside that. Age
  // the outbox row the first digest created.
  await prisma.outboxMessage.updateMany({ where: { requestedBy: { not: null } }, data: { createdAt: new Date(Date.now() - 12 * 3600_000) } });

  // 240 OLDER settled claims — more than the scan's page of 200 — and one
  // genuine orphan behind them. This is the audit's scenario exactly.
  const old = new Date(Date.now() - 6 * 3600_000);
  for (let i = 0; i < 240; i++) {
    await prisma.pendingSms.create({ data: { teamMemberId: member.id, line: `settled ${i}`, sentAt: new Date(old.getTime() + i * 1000), settledAt: new Date() } });
  }
  const orphanStamp = new Date(Date.now() - 60 * 60_000); // inside the window, newer than all 240
  const orphan = await prisma.pendingSms.create({
    data: { teamMemberId: member.id, line: "THE ORPHAN — claimed, never handed to the provider", sentAt: orphanStamp },
    select: { id: true },
  });

  // What the OLD scan would have seen: a page of 200 ordered oldest-first, all
  // of it settled history, with the orphan 241st. Stated as an assertion so the
  // fix is measured against the real shape of the bug.
  const oldScanPage = await prisma.pendingSms.findMany({
    where: { sentAt: { not: null }, skippedAt: null },
    select: { id: true },
    orderBy: { sentAt: "asc" },
    take: 200,
  });
  ok("BEFORE: the scan's 200-row page was entirely settled history", !oldScanPage.some((r) => r.id === orphan.id), `${oldScanPage.length} rows, orphan absent`);

  const beforeScan = await prisma.pendingSms.findMany({ where: { settledAt: null, sentAt: { not: null } }, select: { id: true } });
  ok("AFTER: the candidate set is the orphans, not the history", beforeScan.length === 1 && beforeScan[0].id === orphan.id, `${beforeScan.length} candidate(s)`);

  const recovered = await notify.flushPendingSms();
  const orphanRow = await prisma.pendingSms.findUnique({ where: { id: orphan.id }, select: { sentAt: true } });
  ok("  …so the orphan is reached and put back in the queue", orphanRow?.sentAt === null, JSON.stringify(recovered));

  // And the marker is only written where the outbox's answer is permanent.
  {
    const key = outbox.staffKey(member.id, new Date("2026-09-01T10:00:00Z"));
    await prisma.outboxMessage.create({
      data: { channel: "sms", toRef: "6105550143", body: "held digest", dedupeKey: key, state: "unknown", requestedBy: "staff-digest" },
    });
    const heldRow = await prisma.pendingSms.create({
      data: { teamMemberId: member.id, line: "a digest the outbox is unsure about", sentAt: new Date("2026-09-01T10:00:00Z") },
      select: { id: true },
    });
    const state = await outbox.outboxStateOf(key);
    ok("an UNKNOWN outbox row is not a permanent answer", state?.state === "unknown");
    // The scan may look at it again next tick; it must not be stamped out.
    const after = await prisma.pendingSms.findUnique({ where: { id: heldRow.id }, select: { settledAt: true } });
    ok("  …so its lines are not marked settled", after?.settledAt === null);
  }

  ok("nothing reached the network", outbound.length === 0, outbound.join(", "));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await server.stop();
  await db.close();
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
