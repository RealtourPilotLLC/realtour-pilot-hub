// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, audit C1). Erica Walker's 2:31 PM portal message.
//
// At 2:31 PM ET Erica wrote on her program conversation:
//   "I can't seem to book a time for Oct filming. CAn you help? Also, is
//    jordan uploading the scripts we discussed on the phone the other day? I
//    would like to add the one I had talked about before - Reverse offers for
//    sellers (...)"
// At 5:20 PM the one-off scripts/_live/oct22-erica-booked-message.ts posted
// the office's booking message ("we were able to schedule your filming for
// this Thursday, October 29 at 8:30 AM") through postStaffMessage. Its
// closeRun marked EVERY unanswered client message on the thread as handled
// and completed the desk task, so her scripts question and her "Reverse
// offers for sellers" topic idea went unanswered with nothing left open.
//
// This puts that right:
//   1. the client message(s) the 5:20 PM booking message closed (handledAt
//      equal to that staff message's time) go back to waiting;
//   2. the program-message desk task reopens for Kyle, due the end of the
//      next business day ET (the rule raiseThreadTask uses), saying what is
//      answered (the booking) and what still waits (the scripts question,
//      the topic idea).
// The booking itself, the double-booked task and Erica are not touched.
// Nothing is sent to anyone.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-erica-reopen-message.ts
// Write it:
//   ... scripts/_live/oct22-erica-reopen-message.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const ENROLLMENT = "cmt7h6b0300059kcj990r34x7";
/** The office's 5:20 PM booking message (oct22-erica-booked-message.ts). */
const BOOKING_MESSAGE_START = "Hi Erica, good news: we were able to schedule your filming";

const one = (s: string | null | undefined, n = 160) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { PROGRAM_MESSAGE_TASK_PREFIX } = await import("@/lib/programMessages");
  const { endOfBusinessDaysET, etDateTime } = await import("@/lib/datetime");
  const now = new Date();
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: Erica Walker, enrollment ${ENROLLMENT}\n`);

  const booking = await prisma.programMessage.findFirst({
    where: { enrollmentId: ENROLLMENT, authorKind: "STAFF", body: { startsWith: BOOKING_MESSAGE_START } },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, body: true, authorLabel: true },
  });
  if (!booking) throw new Error("the 5:20 PM booking message is not on the thread");
  console.log(`The booking message: ${booking.id} at ${etDateTime(booking.createdAt)} ET by ${booking.authorLabel}`);
  console.log(`  "${one(booking.body, 200)}"\n`);

  // BEFORE: every client message on the thread, and which ones that message closed.
  const clientRows = await prisma.programMessage.findMany({
    where: { enrollmentId: ENROLLMENT, authorKind: "CLIENT" },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, body: true, refKind: true, refId: true, handledAt: true, handledBy: true, assignedAppUserId: true },
  });
  console.log(`BEFORE: ${clientRows.length} client message(s) on the thread`);
  for (const m of clientRows) {
    const state = m.handledAt ? `handled ${etDateTime(m.handledAt)} ET by ${m.handledBy}` : "WAITING";
    console.log(`  · ${m.id} ${etDateTime(m.createdAt)} ET [${state}]${m.refKind ? ` (${m.refKind} ${m.refId})` : ""}: "${one(m.body, 140)}"`);
  }
  const closedByBooking = clientRows.filter((m) => m.handledAt && m.handledAt.getTime() === booking.createdAt.getTime());
  console.log(`\nClosed by the booking message (handledAt = ${booking.createdAt.toISOString()}): ${closedByBooking.length}`);
  for (const m of closedByBooking) console.log(`  · ${m.id}: "${one(m.body, 400)}"`);

  const dedupeKey = `${PROGRAM_MESSAGE_TASK_PREFIX}${ENROLLMENT}`;
  const task = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, title: true, status: true, assignedKey: true, assignedManually: true, dueAt: true, completedAt: true, description: true } });
  console.log(`\nDesk task: ${task ? `${task.id} "${task.title}" ${task.status}${task.completedAt ? ` (completed ${etDateTime(task.completedAt)} ET)` : ""}, assigned ${task.assignedKey ?? "nobody"}` : "none"}`);

  // Where the two open parts stand today, for Kyle's description.
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT }, select: { clientId: true } });
  const scripts = await prisma.contentScript.findMany({
    where: { enrollmentId: ENROLLMENT, createdAt: { gte: new Date("2026-10-10T00:00:00Z") } },
    select: { id: true, title: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const reverseTopic = await prisma.contentTopic.findFirst({
    where: { enrollmentId: ENROLLMENT, OR: [{ title: { contains: "reverse offer", mode: "insensitive" } }, { title: { contains: "sellers send", mode: "insensitive" } }] } as never,
    select: { id: true, title: true },
  });
  const statusCount = new Map<string, number>();
  for (const s of scripts) statusCount.set(String(s.status), (statusCount.get(String(s.status)) ?? 0) + 1);
  const scriptsLine = scripts.length
    ? `Her scripts drafted since Oct 10: ${scripts.length} (${[...statusCount].map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, " ")}`).join(", ")}).`
    : "No scripts drafted for her since Oct 10.";
  const topicLine = reverseTopic ? `A topic like it is already in her bank: "${reverseTopic.title}".` : `There is no "Reverse offers for sellers" topic in her bank yet.`;

  if (!closedByBooking.length) {
    console.log("\nNothing to reopen: no client message carries the booking message's time. Nothing written.");
    process.exit(0);
  }

  const asked = closedByBooking.map((m) => `• Erica Walker, ${etDateTime(m.createdAt)} ET: ${one(m.body, 600)}`);
  const description = [
    "Erica's message was closed by mistake when the office posted her booking message (Oct 22, 5:20 PM). Only part of it was answered.",
    "",
    ...asked,
    "",
    "Answered: her October filming. She is booked for Thursday, October 29 at 8:30 AM (the 5:20 PM message told her).",
    "Still waiting on a reply:",
    "1. Is Jordan uploading the scripts they discussed on the phone? " + scriptsLine,
    `2. Her topic idea "Reverse offers for sellers" (sellers in this market sending offers to buyers instead of waiting for an offer). ${topicLine} Add it to her topics or tell her when it will be.`,
    "",
    "Reply on Content Program > Messages. This closes itself when you reply there, or when you mark the thread \"No reply needed\".",
  ].join("\n");
  const dueAt = endOfBusinessDaysET(now, 1);

  console.log("\nPLAN:");
  console.log(`  1. set ${closedByBooking.length} client message(s) back to waiting (handledAt null, handledBy null): ${closedByBooking.map((m) => m.id).join(", ")}`);
  console.log(`  2. ${task ? `reopen task ${task.id}` : "create the desk task"} as OPEN, HIGH, assigned kyle${task?.assignedManually ? " (it was reassigned by hand: kept as it is)" : ""}, due ${etDateTime(dueAt)} ET, description:`);
  for (const l of description.split("\n")) console.log(`       ${l}`);

  if (!APPLY) {
    console.log("\nDRY RUN: nothing written. Run with --apply to write it.");
    process.exit(0);
  }

  const reopened = await prisma.programMessage.updateMany({
    where: { id: { in: closedByBooking.map((m) => m.id) }, handledAt: booking.createdAt },
    data: { handledAt: null, handledBy: null },
  });
  const title = "Reply to Erica Walker's message";
  if (task) {
    await prisma.smartTask.update({
      where: { id: task.id },
      data: {
        title, summary: title, description, status: "OPEN", completedAt: null, dueAt, priority: "HIGH",
        ...(task.assignedManually ? {} : { assignedKey: "kyle" }),
      },
    });
  } else {
    await prisma.smartTask.create({
      data: {
        title, summary: title, description,
        taskType: "program_message", status: "OPEN", source: "content_program", priority: "HIGH",
        clientId: enrollment?.clientId ?? null, dedupeKey, assignedKey: "kyle", dueAt,
        reasonCreated: "A client wrote on the program conversation",
      },
    });
  }

  const after = await prisma.programMessage.findMany({ where: { id: { in: closedByBooking.map((m) => m.id) } }, select: { id: true, handledAt: true } });
  const afterTask = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true, status: true, assignedKey: true, dueAt: true } });
  console.log(`\nAFTER: ${reopened.count} message(s) reopened`);
  for (const m of after) console.log(`  · ${m.id}: ${m.handledAt ? "handled" : "WAITING"}`);
  console.log(`  task ${afterTask?.id}: ${afterTask?.status}, assigned ${afterTask?.assignedKey}, due ${afterTask?.dueAt ? etDateTime(afterTask.dueAt) : "-"} ET`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
