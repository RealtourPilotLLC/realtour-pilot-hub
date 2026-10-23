import "server-only";
import { prisma } from "@/lib/prisma";
import { readyToSend } from "@/lib/readyToSend";
import { notifyInApp } from "@/lib/notify";
import { appBase } from "@/lib/appUrl";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { deliveryReadyMessage, hubIsSending } from "@/lib/deliveryReadyMessage";

/**
 * WHO GETS THE DELIVERY ALERTS: the person who owns DELIVERY (Oct 5 2026).
 *
 * This used to be "the one active team member whose name contains Kyle" and
 * threw unless exactly one matched — a second Kyle on the roster (a new hire,
 * a client contact typed in by mistake) would have silenced every alert. The
 * program's DELIVERY duty owner (ProgramOwnerAssignment DEFAULT row; Kyle
 * Smith by default, changeable in Settings) is the answer the rest of the hub
 * already uses. The owner is a login (AppUser); the alerts go to their roster
 * row (TeamMember) — through the login's own link, else the roster row with the
 * login's exact email, else the one active row with exactly the login's name.
 * Nothing resolves → a clear error, never a guess.
 */
export async function deliveryOwnerTeamMemberId(): Promise<string> {
  const read = () => prisma.programOwnerAssignment.findFirst({
    where: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", endedAt: null },
    select: { appUserId: true, teamMemberId: true },
  });
  let duty = await read();
  if (!duty) {
    // The program's own first read mints the default owners (Kyle = DELIVERY);
    // a hub that never opened a program page has not done that read yet.
    await import("@/lib/contentProgram").then((m) => m.ownersFor("", null)).catch(() => null);
    duty = await read();
  }
  if (!duty) throw new Error("Delivery alerts need a delivery owner (Settings → program owners).");
  if (duty.teamMemberId) {
    const member = await prisma.teamMember.findFirst({ where: { id: duty.teamMemberId, active: true }, select: { id: true } });
    if (member) return member.id;
  }
  const user = duty.appUserId ? await prisma.appUser.findUnique({ where: { id: duty.appUserId }, select: { name: true, email: true, teamMemberId: true, status: true } }) : null;
  if (!user || user.status !== "ACTIVE") throw new Error("The delivery owner has no active login. Choose a delivery owner in Settings.");
  if (user.teamMemberId) {
    const member = await prisma.teamMember.findFirst({ where: { id: user.teamMemberId, active: true }, select: { id: true } });
    if (member) return member.id;
  }
  const byEmail = await prisma.teamMember.findFirst({ where: { active: true, email: { equals: user.email.trim(), mode: "insensitive" } }, select: { id: true } });
  if (byEmail) return byEmail.id;
  const name = user.name?.trim();
  const byName = name ? await prisma.teamMember.findMany({ where: { active: true, name: { equals: name, mode: "insensitive" } }, select: { id: true }, take: 2 }) : [];
  if (byName.length === 1) return byName[0].id;
  throw new Error(`The delivery owner (${name || user.email}) is not linked to one active team member. Link their login to their roster entry.`);
}

/** How far back the in-between minutes look for something that moved. Wider
 *  than one tick, so a late or skipped tick still sees it. */
const RECENT_MS = 3 * 60_000;

/**
 * WHETHER THIS MINUTE BUILDS THE BOARD (Oct 20 2026, audit H2/B3).
 *
 * The 1080p lane's cron runs every minute since Oct 19 and this step built the
 * whole Ready-to-send board on every tick, about 1,440 builds a day. Now:
 *   · every fifth minute, the full sweep, the cadence these alerts had before
 *     Oct 19. It catches anything the cheap check below cannot see and retries
 *     a Slack send that failed (notifyInApp);
 *   · the minutes between, only when something that puts a video on the board
 *     moved in the last few minutes: a cut approved, a 1080p pass that
 *     finished, was saved or was held, or an Aryeo upload a person started.
 * Three small counts instead of the board. A failed check builds the board.
 */
export async function deliveryAlertsDue(now: Date = new Date()): Promise<{ due: boolean; why: string }> {
  if (now.getUTCMinutes() % 5 === 0) return { due: true, why: "five-minute sweep" };
  const since = new Date(now.getTime() - RECENT_MS);
  try {
    const { VIDEO_PUSH_PREFIX } = await import("@/lib/videoAryeoPush");
    const [approved, rendered, pushes] = await Promise.all([
      prisma.reviewSubmission.count({ where: { status: "APPROVED", sentToClientAt: null, decidedAt: { gte: since } } }),
      prisma.topazJob.count({ where: { OR: [{ finishedAt: { gte: since } }, { savedAt: { gte: since } }, { heldAt: { gte: since } }] } }),
      prisma.appSetting.count({ where: { key: { startsWith: VIDEO_PUSH_PREFIX }, updatedAt: { gte: since } } }),
    ]);
    if (approved) return { due: true, why: "a cut was approved" };
    if (rendered) return { due: true, why: "a 1080p pass moved" };
    if (pushes) return { due: true, why: "an Aryeo upload moved" };
    return { due: false, why: "nothing moved" };
  } catch {
    return { due: true, why: "the quick check failed" };
  }
}

/** Staff-only reminders. Never uploads media, releases a portal, or sends to clients. */
export async function notifyKyleDeliveryReady() {
  const owner = await deliveryOwnerTeamMemberId();
  const board = await readyToSend({
    excludeClientIds: await syntheticClientIds(),
    recordFollowUpHealth: false,
    includeNoticeIncidents: false,
    // Only `ready` is read here (audit H2/B3): no follow-up lanes.
    readyOnly: true,
  });
  // A pass that skipped or failed on a portal video already told Kyle by name,
  // with the reason (topazJobs.tellSomebody). Its "1080p file needed" row
  // stays on his card but is not DM'd a second time in other words.
  const toldJobs = new Set<string>();
  const retryJobs = board.ready.filter((v) => v.portalStep?.action === "retry-1080p" && v.topazJobId).map((v) => v.topazJobId!);
  if (retryJobs.length) {
    const told = await prisma.notification.findMany({
      where: { userKey: `tm:${owner}`, OR: retryJobs.flatMap((id) => [{ dedupeKey: { startsWith: `topaz-skipped-${id}-kyle-` } }, { dedupeKey: { startsWith: `topaz-failed-${id}-kyle-` } }]) },
      select: { dedupeKey: true },
    });
    for (const id of retryJobs) if (told.some((n) => n.dedupeKey?.startsWith(`topaz-skipped-${id}-kyle-`) || n.dedupeKey?.startsWith(`topaz-failed-${id}-kyle-`))) toldJobs.add(id);
  }
  const notificationKeys: string[] = [];
  for (const video of board.ready) {
    if (video.topazJobId && toldJobs.has(video.topazJobId)) continue;
    // A checked file whose automatic publication has not failed is the hub's
    // job, not Kyle's: it publishes itself (approval, the finished pass, the
    // hourly repair). He hears about it only once a publication says why not.
    if (video.portalStep?.action === "retry-publication" && !video.portalStep.failed) continue;
    // The hub is uploading or delivering this one to Aryeo itself (Oct 19
    // 2026): Kyle hears about it only when it needs him.
    if (hubIsSending(video)) continue;
    // Uploaded only (Oct 23 2026): a person chose to put it on the listing
    // without sending it, so nobody is told to send it. Its row says "On
    // Aryeo, not sent yet" until somebody presses Send now.
    if (video.push?.uploadedOnly) continue;
    const message = deliveryReadyMessage(video, appBase());
    // Existing bridge dedupes successful delivery, retries failed sends, and honors
    // the recipient's saved channel/quiet-hours preferences. No new retry loop.
    notificationKeys.push(`${message.dedupeKey}-0`);
    await notifyInApp({
      kind: "topaz_ready", title: message.title, body: message.body,
      href: message.href, dedupeKey: message.dedupeKey,
      targets: [{ roles: ["ADMIN"], userKey: `tm:${owner}`,
        href: message.href, slackDm: message.slackDm }],
    });

  }
  const notifications = await prisma.notification.findMany({
    where: { dedupeKey: { in: notificationKeys }, userKey: `tm:${owner}` },
    select: { id: true },
  });
  const receipts = await prisma.notificationDelivery.findMany({
    where: { notificationId: { in: notifications.map(n => n.id) }, channel: "slack", status: "sent" },
    select: { notificationId: true }, distinct: ["notificationId"],
  });
  // Includes previous successful sweeps; never infer success from a bell row.
  return { ready: board.ready.length, slackConfirmed: receipts.length };
}
