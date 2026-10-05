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
  let slackSent = 0;
  for (const video of board.ready) {
    const message = deliveryReadyMessage(video, appBase());
    // Existing bridge dedupes successful delivery, retries failed sends, and honors
    // the recipient's saved channel/quiet-hours preferences. No new retry loop.
    const result = await notifyInApp({
      kind: "topaz_ready", title: message.title, body: message.body,
      href: message.href, dedupeKey: message.dedupeKey,
      targets: [{ roles: ["ADMIN"], userKey: `tm:${people[0].id}`,
        href: message.href, slackDm: message.slackDm }],
    });
    slackSent += result.bridged.filter(x => x.channel === "slack").length;
  }
  return { ready: board.ready.length, slackSent };
}
