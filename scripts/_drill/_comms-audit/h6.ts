// ---------------------------------------------------------------------------
// DRILL SECTION H6 (Oct 22 2026, comms audit): a booking confirmation must not
// go out while a conflict task is open.
//
// Erica Walker: "Double-booked? James Livingston — Erica Walker" opened at
// 5:20:05 PM and a message telling her the time was set went at 5:20:38 PM.
//
// Proves, against the drill database (its own fixtures, all named TEST):
//   1. the pure detector: booking words AND a day or time; asking is not
//      confirming;
//   2. the conflict reads (lib/bookingConflictHold): a double-booked task on a
//      request is found from the request, its job and its client; a closed
//      task and an unrelated task are not; a clash task by its session key;
//   3. postStaffMessage refuses a confirmation while the task is open (no
//      message row), lets a message that confirms nothing through, lets the
//      confirmation through with overrideConflict, and once the task is
//      completed;
//   4. the confirmation text sweep's hold (clientTextSweeps.
//      confirmationConflictHold, the exact call the sweep makes): held with
//      the reason on the open task, released when the conflict closes;
//   5. the staff text rails' check (staffConfirmationRefusal) and the
//      portal's words: no "Booked" while held.
//
// The parent drill boots PGlite, the next stubs and a fence that blocks all
// network; this section sends nothing and needs no stub.
// ---------------------------------------------------------------------------
import type { Checker } from "../_harness";
import { buildContentMonth } from "../_fixtures/contentMonth";

export async function run(c: Checker): Promise<void> {
  c.head("H6 · no booking confirmation while a double-booked or clash task is open");
  const { prisma } = await import("@/lib/prisma");
  const H = await import("@/lib/bookingConflictHold");
  const { postStaffMessage } = await import("@/lib/programMessages");
  const { confirmationConflictHold } = await import("@/lib/clientTextSweeps");

  // ---- 1 · the pure detector ----
  const yes = [
    "Hi Erica, good news: we were able to schedule your filming for this Thursday, October 29 at 8:30 AM. If you need another time, just let us know!",
    "You're booked for Tuesday at 10am.",
    "Your session is confirmed for Oct 29 at 8:30.",
    "All set for tomorrow at 2 PM, see you then!",
    "We moved your filming to Friday at 11:00 AM.",
    "We have you down for Monday at 9.",
  ];
  const no = [
    "Can we schedule your filming for Thursday?",
    "Can we move your filming to Friday at 11?",
    "What day works best for you next week?",
    "Your scripts are ready to review.",
    "Booked! We'll send the time shortly.",
    "Thanks Erica, we got your message and will look into the scripts today.",
  ];
  c.ok("a message that tells the client a time is set reads as a booking confirmation", yes.every((t) => H.readsAsBookingConfirmation(t)), yes.filter((t) => !H.readsAsBookingConfirmation(t)).join(" | "));
  c.ok("…asking for a time, or a message with no day or time, does not", no.every((t) => !H.readsAsBookingConfirmation(t)), no.filter((t) => H.readsAsBookingConfirmation(t)).join(" | "));
  c.ok("task keys: double-booked, clash (travel / Aryeo conflict) and reassess count; the desk row and an address desk task do not",
    H.conflictKindOfKey("content-session-doublebooked-abc") === "double_booked"
      && H.conflictKindOfKey("program-session-address:appt:x1:travel:v2") === "clash"
      && H.conflictKindOfKey("program-session-address:appt:x1:aryeo-conflict:v1") === "clash"
      && H.conflictKindOfKey("program-reassess:r1") === "reassess"
      && H.conflictKindOfKey("content-session-request-abc") === null
      && H.conflictKindOfKey("program-session-address:appt:x1:desk:v1") === null
      && H.addressTaskSessionKey("program-session-address:appt:x1:travel:v2") === "appt:x1");

  // ---- fixtures: Erica's shape. A booked session (hub-confirmed), a job, a confirmation task. ----
  const at = new Date(Date.now() + 7 * 86_400_000);
  const F = await buildContentMonth(prisma as never, { name: "H6 Erica Double TEST", package: "Starter", appointments: [{ startAt: at, durationMin: 120 }] });
  const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: F.appointmentIds[0] }, select: { aryeoId: true } });
  const req = await prisma.programSessionRequest.create({
    data: {
      enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, slotStart: at, slotEnd: new Date(at.getTime() + 2 * 3_600_000),
      status: "CONFIRMED", bookingState: "SUCCEEDED", projectId: F.projectId, aryeoAppointmentId: appt.aryeoId, confirmedAt: new Date(), confirmedBy: "hub-booking",
      creativeName: "James Livingston", dedupeKey: `h6:${F.enrollmentId}:${at.toISOString()}`,
    },
    select: { id: true },
  });
  const other = await buildContentMonth(prisma as never, { name: "H6 Clear Client TEST", package: "Starter", appointments: [{ startAt: at, durationMin: 120 }] });
  // The task sessionBooking.raiseDoubleBooked writes.
  const dbl = await prisma.smartTask.create({
    data: {
      taskType: "todo", status: "OPEN", source: "content_program", priority: "HIGH", assignedKey: "kyle", clientId: F.clientId,
      dedupeKey: `${H.DOUBLE_BOOKED_TASK_PREFIX}${req.id}`, title: "Double-booked? James Livingston — H6 Erica Double TEST",
    },
    select: { id: true },
  });
  const confirmTask = await prisma.smartTask.create({
    data: { title: "Confirm the filming", taskType: "confirmation_text", status: "OPEN", projectId: F.projectId, clientId: F.clientId, dedupeKey: `h6-confirm-${F.projectId}` },
    select: { id: true },
  });

  // ---- 2 · the reads ----
  const byReq = await H.openConflictFor({ requestId: req.id });
  const byJob = await H.openConflictFor({ projectId: F.projectId });
  const byClient = await H.openConflictFor({ clientId: F.clientId });
  c.ok("the open double-booked task is found from the request, its job and its client", byReq?.taskId === dbl.id && byJob?.taskId === dbl.id && byClient?.taskId === dbl.id && byReq?.kind === "double_booked");
  c.ok("…another client's booking has none", (await H.openConflictFor({ clientId: other.clientId })) === null && (await H.openConflictFor({ projectId: other.projectId })) === null);
  c.ok("…the portal's session key and request are held", (await H.conflictSessionKeys(F.clientId)).has(`appt:${appt.aryeoId}`) && (await H.conflictRequestIds(F.clientId)).has(req.id));

  // ---- 3 · the program conversation ----
  const me = { id: null, name: "Drill Office", email: "office@drill.test" };
  const confirmBody = yes[0];
  const before = await prisma.programMessage.count({ where: { enrollmentId: F.enrollmentId } });
  const refused = await postStaffMessage(F.enrollmentId, me, confirmBody, null, { closeRun: false });
  c.ok("postStaffMessage refuses a confirmation while the double-booked task is open, in plain words",
    !refused.ok && /^A double-booked check is open for this booking \(task: Double-booked\? James Livingston/.test(refused.message) && /Settle it before confirming the time\.$/.test(refused.message) && !/—|--/.test(refused.message.replace(/\(task: [^)]*\)/, "")), refused.message);
  c.ok("…nothing was written to the conversation", (await prisma.programMessage.count({ where: { enrollmentId: F.enrollmentId } })) === before);
  const plain = await postStaffMessage(F.enrollmentId, me, "Thanks Erica, we're looking into your scripts question today.", null, { closeRun: false });
  c.ok("…a message that confirms no time goes through", plain.ok, plain.message);
  const overridden = await postStaffMessage(F.enrollmentId, me, "Your session is confirmed for Thursday at 8:30 AM.", null, { closeRun: false, overrideConflict: true });
  c.ok("…the person who settled it can send it anyway (overrideConflict)", overridden.ok, overridden.message);

  // ---- 4 · the confirmation text sweep's hold ----
  const project = await prisma.project.findUniqueOrThrow({ where: { id: F.projectId! }, select: { id: true, title: true, client: { select: { name: true } } } });
  const note = await confirmationConflictHold(project, [confirmTask.id]);
  const held = await prisma.smartTask.findUniqueOrThrow({ where: { id: confirmTask.id }, select: { status: true, summary: true } });
  c.ok("the confirmation text is held while the conflict is open", !!note && /booking conflict open \(Double-booked\?/.test(note), note ?? "null");
  c.ok("…the reason is on the confirmation task, which stays open for the next tick", held.status === "OPEN" && /^On hold: a booking conflict is open for H6 Erica Double TEST/.test(held.summary ?? "") && /It sends once that task is closed\.$/.test(held.summary ?? ""), held.summary ?? "");
  const otherProject = await prisma.project.findUniqueOrThrow({ where: { id: other.projectId! }, select: { id: true, title: true, client: { select: { name: true } } } });
  c.ok("…a job with no conflict is not held", (await confirmationConflictHold(otherProject, [])) === null);

  // ---- 5 · the staff text rails and the portal's words ----
  c.ok("the staff text rails refuse the same confirmation (Replies, thread, client page, email reply)", /^A double-booked check is open/.test((await H.staffConfirmationRefusal({ clientId: F.clientId, body: "You're booked for Tuesday at 10am." })) ?? ""));
  c.ok("…but not a message that confirms nothing, nor another client's", (await H.staffConfirmationRefusal({ clientId: F.clientId, body: "Got it, thanks!" })) === null && (await H.staffConfirmationRefusal({ clientId: other.clientId, body: "You're booked for Tuesday at 10am." })) === null);
  c.ok("the portal's words while held make no booking claim", !/\bbooked\b/i.test(H.CONFIRMING_WITH_CREATIVE) && /confirming it with your videographer/.test(H.CONFIRMING_WITH_CREATIVE) && !/\bbooked\b/i.test(H.CONFIRMING_LABEL));

  // ---- the conflict closes: everything goes ----
  await prisma.smartTask.update({ where: { id: dbl.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  c.ok("once the double-booked task is completed, no conflict is found", (await H.openConflictFor({ requestId: req.id })) === null && (await H.openConflictFor({ clientId: F.clientId })) === null);
  const after = await postStaffMessage(F.enrollmentId, me, confirmBody, null, { closeRun: false });
  c.ok("…postStaffMessage sends the confirmation", after.ok, after.message);
  c.ok("…the confirmation text is released on the next tick", (await confirmationConflictHold(project, [confirmTask.id])) === null);
  c.ok("…the portal shows the booking again", !(await H.conflictRequestIds(F.clientId)).has(req.id));

  // ---- a clash task found by its session key ----
  const clash = await prisma.smartTask.create({
    data: {
      taskType: "todo", status: "OPEN", source: "content_program", title: "Aryeo reports a clash at the new filming address — H6 Erica Double TEST", clientId: F.clientId, projectId: F.projectId,
      dedupeKey: `program-session-address:appt:${appt.aryeoId}:aryeo-conflict:v1`,
    },
    select: { id: true },
  });
  const cl = await H.openConflictFor({ projectId: F.projectId });
  c.ok("a schedule clash at the new address holds it too (by its session key)", cl?.taskId === clash.id && cl.kind === "clash" && /^A schedule clash check is open/.test(H.conflictRefusal(cl)));
  await prisma.smartTask.update({ where: { id: clash.id }, data: { status: "CANCELLED" } });
}
