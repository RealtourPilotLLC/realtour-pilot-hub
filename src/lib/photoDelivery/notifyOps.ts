import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// PHOTO DELIVERY ALERTS → JORDAN AND KYLE (docs/photo-delivery/01 §5.5).
//
// One call, two people, three channels:
//   · a bell row addressed to each of them (the row IS the claim: its unique
//     dedupeKey decides which call announces it, so two sweeps racing on the
//     same event never double-DM anyone),
//   · their Slack DM / text through notify.notifyStaffSms, which already
//     knows each person's channel, logs every leg, and holds only inside a
//     person's own quiet time (Jordan: Saturday until 7:30 PM, Oct 6 2026:
//     "Anyone on the team can get pinged anytime. Just not Jordan on
//     Saturday until 7:30PM."). A held alert is kept and sent later, never
//     dropped.
// Who "Kyle" is: the delivery duty owner (kyleNotice.deliveryOwner), never a
// guess by name. Who "Jordan" is: the OWNER login's roster row.
// Plain text, no em dashes, the address and a hub link only (never a photo:
// privacy findings must not leave the hub as images).
// ---------------------------------------------------------------------------

export type OpsAlert = {
  kind: string;
  title: string;
  body?: string;
  href: string;
  /** Unique per event; suffixed per recipient. */
  dedupeKey: string;
  /** The Slack DM / text, plain words, link included. */
  text: string;
  /** Who gets it: both (default), or only one of them. */
  to?: "both" | "owner" | "kyle";
};

async function ownerTeamMemberId(): Promise<string | null> {
  const login = await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } }, select: { teamMemberId: true } }).catch(() => null);
  if (login?.teamMemberId) return login.teamMemberId;
  const byName = await prisma.teamMember.findFirst({ where: { name: { startsWith: "Jordan" }, active: true }, select: { id: true } }).catch(() => null);
  return byName?.id ?? null;
}

export async function opsRecipients(): Promise<{ ownerId: string | null; kyleId: string | null }> {
  const [ownerId, kyle] = await Promise.all([
    ownerTeamMemberId(),
    import("@/lib/kyleNotice").then((m) => m.deliveryOwner()).catch(() => ({ id: null })),
  ]);
  return { ownerId, kyleId: kyle.id ?? null };
}

const noLongDashes = (s: string) => s.replace(/\s*[–—]\s*/g, ", ");

/** Returns how many people this call announced to (0 when already announced). */
export async function alertOwnerAndKyle(a: OpsAlert): Promise<{ announced: number; outcomes: string[] }> {
  const outcomes: string[] = [];
  let announced = 0;
  try {
    const { ownerId, kyleId } = await opsRecipients();
    const want = a.to ?? "both";
    const people: Array<{ id: string; role: "OWNER" | "ADMIN"; slot: number }> = [];
    // Addressed to Kyle but no delivery owner resolves: the owner gets it
    // rather than an ops channel nobody reads (a person, never silence).
    if (ownerId && (want !== "kyle" || !kyleId)) people.push({ id: ownerId, role: "OWNER", slot: 0 });
    if (kyleId && kyleId !== ownerId && want !== "owner") people.push({ id: kyleId, role: "ADMIN", slot: 1 });
    const { notifyStaffSms, logDelivery, opsAlert } = await import("@/lib/notify");
    const title = noLongDashes(a.title).slice(0, 90);
    const body = a.body ? noLongDashes(a.body).slice(0, 140) : null;
    const text = noLongDashes(a.text);
    if (!people.length) {
      // Nobody resolvable: the ops channel, never silence.
      await opsAlert(text).catch(() => false);
      return { announced: 0, outcomes: ["ops-relay"] };
    }
    for (const p of people) {
      const row = await prisma.notification
        .create({
          data: { kind: a.kind, title, body, href: a.href, audience: JSON.stringify([p.role]), userKey: `tm:${p.id}`, dedupeKey: `${a.dedupeKey}-${p.slot}` },
          select: { id: true },
        })
        .catch((e: unknown) => {
          if ((e as { code?: string } | null)?.code === "P2002") return null;
          throw e;
        });
      if (!row) continue;
      announced++;
      await logDelivery({ notificationId: row.id, teamMemberId: p.id, kind: a.kind, channel: "bell", status: "sent" }).catch(() => {});
      const out = await notifyStaffSms([p.id], text, a.kind).catch(() => []);
      outcomes.push(`${p.role}:${out[0]?.outcome ?? "none"}`);
    }
  } catch (e) {
    console.warn("alertOwnerAndKyle failed", a.kind, (e as Error).message);
  }
  return { announced, outcomes };
}
