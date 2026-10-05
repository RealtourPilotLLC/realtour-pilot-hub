import "server-only";
import { prisma } from "@/lib/prisma";
import { readyToSend } from "@/lib/readyToSend";
import { notifyInApp } from "@/lib/notify";
import { appBase } from "@/lib/appUrl";
import { isSyntheticClientRow } from "@/lib/testClients";
import { deliveryReadyMessage } from "@/lib/deliveryReadyMessage";

/** Staff-only reminders. Never uploads media, releases a portal, or sends to clients. */
export async function notifyKyleDeliveryReady() {
  const people = await prisma.teamMember.findMany({
    where: { active: true, name: { contains: "Kyle", mode: "insensitive" } },
    select: { id: true },
  });
  if (people.length !== 1) throw new Error("Delivery alerts require exactly one active Kyle in the roster");
  const clients = await prisma.client.findMany({ select: { id: true, name: true } });
  const board = await readyToSend({
    excludeClientIds: clients.filter(isSyntheticClientRow).map(c => c.id),
    recordFollowUpHealth: false,
    includeNoticeIncidents: false,
  });
  const notificationKeys: string[] = [];
  for (const video of board.ready) {
    const message = deliveryReadyMessage(video, appBase());
    // Existing bridge dedupes successful delivery, retries failed sends, and honors
    // the recipient's saved channel/quiet-hours preferences. No new retry loop.
    notificationKeys.push(`${message.dedupeKey}-0`);
    await notifyInApp({
      kind: "topaz_ready", title: message.title, body: message.body,
      href: message.href, dedupeKey: message.dedupeKey,
      targets: [{ roles: ["ADMIN"], userKey: `tm:${people[0].id}`,
        href: message.href, slackDm: message.slackDm }],
    });

  }
  const notifications = await prisma.notification.findMany({
    where: { dedupeKey: { in: notificationKeys }, userKey: `tm:${people[0].id}` },
    select: { id: true },
  });
  const receipts = await prisma.notificationDelivery.findMany({
    where: { notificationId: { in: notifications.map(n => n.id) }, channel: "slack", status: "sent" },
    select: { notificationId: true }, distinct: ["notificationId"],
  });
  // Includes previous successful sweeps; never infer success from a bell row.
  return { ready: board.ready.length, slackConfirmed: receipts.length };
}
