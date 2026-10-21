// ---------------------------------------------------------------------------
// DRILL: ONE COMMS SCAN, SLICED (Oct 21 2026, audit F4).
//
// The Messages screen read the comms log three times per request: the
// Waiting on us board's phone and email scans and the Texts queue's own phone
// scan. unansweredComms now scans once (scanWaiting) and slices; with
// `shared` the board and the Texts queue slice the request's one scan. This
// pins that the slices are the SAME cards the separate scans produced:
//   1. the two-family board (unansweredCommsBoards) = the phone board + the
//      email board, card for card, an owed question past the window included;
//   2. the shared Texts queue = the unscoped queue with test clients filtered
//      out (what the screen did), thank-yous and our own team under the fold;
//   3. the board's two families are one scan: one walk, each family read to
//      its own cap (two reads, not four with the ledger's lookback).
//
// ISOLATION: PGlite via the shared harness; nothing leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6982);
installNextStubs();
const fence = fenceFetch(async () => null);
const HOUR = 3_600_000;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { unansweredCommsBoard, unansweredCommsBoards } = await import("@/lib/commsBoard");
  const { replyQueue } = await import("@/lib/replyQueue");
  try {
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * HOUR);
    let n = 0;
    const log = (o: { channel?: string; direction?: "in" | "out"; clientId?: string | null; contactName?: string | null; phone?: string | null; subject?: string | null; body: string; at: Date; source?: string }) =>
      prisma.commLog.create({ data: {
        channel: o.channel ?? "text", direction: o.direction ?? "in", clientId: o.clientId ?? null, clientName: null, contactName: o.contactName ?? null,
        fromPhone: o.phone ?? null, subject: o.subject ?? null, body: o.body, occurredAt: o.at, source: o.source ?? (o.channel === "email" ? "gmail" : "openphone"), externalId: `drill-${++n}`,
      } });
    const A = await prisma.client.create({ data: { name: "Nadia Osborne", phone: "(215) 555-0101" } });
    const B = await prisma.client.create({ data: { name: "Marisol Greaves", phone: "(215) 555-0202" } });
    const C = await prisma.client.create({ data: { name: "Curtis Ayodele", phone: "(215) 555-0505" } });
    const T = await prisma.client.create({ data: { name: "Drill Agent TEST", phone: "(215) 555-0909" } });
    await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", phone: "(215) 555-0777", role: "PHOTOGRAPHER" } });
    // A: a real question by text, and an email thread.
    await log({ clientId: A.id, contactName: "Nadia Osborne", phone: "2155550101", body: "Can we move Thursday's shoot to the afternoon?", at: ago(5) });
    await log({ channel: "email", clientId: A.id, contactName: "Nadia Osborne", subject: "Question about the twilight photos", body: "Hi, could the twilight photos include the back deck too? Let me know what works.", at: ago(7) });
    // B: answered, then only a thank-you (courtesy only).
    await log({ clientId: B.id, contactName: "Marisol Greaves", phone: "2155550202", body: "When will the photos be ready?", at: ago(30) });
    await log({ direction: "out", clientId: B.id, contactName: "Us", phone: "2155550202", body: "Tomorrow by noon.", at: ago(29) });
    await log({ clientId: B.id, contactName: "Marisol Greaves", phone: "2155550202", body: "Thanks!", at: ago(28) });
    // A test client, an unmatched number, and our own photographer.
    await log({ clientId: T.id, contactName: "Drill Agent TEST", phone: "2155550909", body: "Testing the inbox, please ignore", at: ago(3) });
    await log({ contactName: null, phone: "2155550333", body: "Hi, do you shoot condos in Ardmore?", at: ago(9) });
    await log({ contactName: "Harrison Wells", phone: "2155550777", body: "Photos uploaded for Spring Ln", at: ago(2) });
    // C: an obligation written down 20 days ago, its message long out of the window.
    await log({ clientId: C.id, contactName: "Curtis Ayodele", phone: "2155550505", body: "Can you send the floor plan again?", at: ago(20 * 24) });
    await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Reply to the latest message", summary: "Curtis Ayodele wrote in: “Can you send the floor plan again?”", description: "Can you send the floor plan again?", source: "openphone", clientId: C.id, dedupeKey: `${C.id}|noproject|client_reply`, createdAt: ago(20 * 24) } });
    const ex = [T.id];

    // =======================================================================
    c.head("1 · the two-family board is the two boards, card for card");
    {
      const [phone, email, both] = await Promise.all([unansweredCommsBoard("phone", now, { excludeClientIds: ex }), unansweredCommsBoard("email", now, { excludeClientIds: ex }), unansweredCommsBoards(now, { excludeClientIds: ex })]);
      c.ok("phone: identical", JSON.stringify(both.phone) === JSON.stringify(phone), `${both.phone.map((g) => g.clientName).join(", ")} vs ${phone.map((g) => g.clientName).join(", ")}`);
      c.ok("email: identical", JSON.stringify(both.email) === JSON.stringify(email), `[${both.email.map((g) => g.clientName).join(", ")}]`);
      c.ok("…and they are the right cards: Nadia's text, Curtis's owed question from 20 days ago; no thank-you, test client, stranger or teammate", phone.map((g) => g.clientName).sort().join("|") === "Curtis Ayodele|Nadia Osborne" && email.length === 1 && email[0].clientName === "Nadia Osborne", phone.map((g) => `${g.clientName}${g.fromLedger ? " (ledger)" : ""}`).join(", "));
    }

    // =======================================================================
    c.head("2 · the shared Texts queue is the screen's old queue, test client filtered");
    {
      const old = await replyQueue({ now });
      const hidden = new Set(ex);
      const realOnly = (x: { clientId: string | null }) => !x.clientId || !hidden.has(x.clientId);
      const before = { cards: old.cards.filter(realOnly), handled: old.handled.filter(realOnly) };
      const shared = await replyQueue({ now, excludeClientIds: ex, shared: true });
      const keys = (xs: { key: string }[]) => xs.map((x) => x.key).join(",");
      c.ok("the waiting cards: identical, in order", keys(shared.cards) === keys(before.cards), keys(shared.cards));
      c.ok("the fold (thank-yous, our own team): identical", keys(shared.handled) === keys(before.handled), keys(shared.handled));
      c.ok("…the stranger waits, Marisol's thank-you and Harrison's upload are under the fold, the test client is gone",
        shared.cards.some((x) => x.phone === "2155550333") && shared.handled.some((x) => x.clientId === B.id) && shared.handled.some((x) => x.isTeam) && ![...shared.cards, ...shared.handled].some((x) => x.clientId === T.id));
      c.ok("the counts agree", shared.clientCount === before.cards.filter((x) => x.isClient).length && shared.oldestHours === before.cards.reduce((m, x) => Math.max(m, x.hoursWaiting), 0), `${shared.clientCount} clients, oldest ${shared.oldestHours}h`);
    }

    // =======================================================================
    c.head("3 · the board's two families are one scan");
    {
      const realLog = prisma.commLog.findMany.bind(prisma.commLog);
      const realTeam = prisma.teamMember.findMany.bind(prisma.teamMember);
      let logReads = 0, teamReads = 0;
      prisma.commLog.findMany = ((args: Parameters<typeof realLog>[0]) => { logReads++; return realLog(args); }) as unknown as typeof prisma.commLog.findMany;
      prisma.teamMember.findMany = ((args: Parameters<typeof realTeam>[0]) => { teamReads++; return realTeam(args); }) as unknown as typeof prisma.teamMember.findMany;
      try {
        await Promise.all([unansweredCommsBoard("phone", now, { excludeClientIds: ex }), unansweredCommsBoard("email", now, { excludeClientIds: ex })]);
        const separate = { logReads, teamReads };
        logReads = 0; teamReads = 0;
        await unansweredCommsBoards(now, { excludeClientIds: ex });
        c.ok("each family is still read to its own cap (the window and the owed lookback, per family)", logReads === separate.logReads, `one board: ${logReads} comms reads · two boards: ${separate.logReads}`);
        c.ok("…in ONE walk: the walk's own reads happen once, not once per family", teamReads * 2 === separate.teamReads && teamReads > 0, `one board: ${teamReads} team reads · two boards: ${separate.teamReads}`);
      } finally {
        prisma.commLog.findMany = realLog as typeof prisma.commLog.findMany;
        prisma.teamMember.findMany = realTeam as typeof prisma.teamMember.findMany;
      }
    }

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
