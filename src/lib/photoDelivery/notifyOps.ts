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

// ---------------------------------------------------------------------------
// KYLE'S PHOTO BELLS (Oct 23 2026, Jordan and Kyle's huddle, item 11: "kind of
// overloading you with notifications"; 42 photo bells in 7 days, up to 6 on
// one job). Kyle's row, and the Slack DM or text that goes with it, follows
// one rule; Jordan's is unchanged:
//   · NOTHING HE CAN'T ACT ON (KYLE_SKIPS): the hub sending raws to AutoHDR
//     by itself (16 a week), AutoHDR being slow, credits running low (Jordan
//     tops them up), the paid QC's shadow and budget (paid QC is off), the
//     coaching draft and a billing question (Jordan's).
//   · AT MOST ONE PER JOB PER STATE THAT NEEDS HIM (KYLE_BUCKET): the photo
//     check done (a decision or a review), a delivery problem (a mismatch,
//     Aryeo not confirming, holds left open, a cut-off photo, the listing
//     changed after delivery), a photo twice on the listing. Keyed by the job,
//     the kind of state and the job's stage at that moment (its stage and
//     when it entered it): a re-check, a new diff or a second warning about
//     the same state is the same bell, never a second one; the next real
//     state change is a new one.
//   · KEPT AS EVENTS: fixes done (one per fix batch: Kyle asked for it), an
//     AutoHDR batch that failed or earlier raws never sent (he sends them by
//     hand).
// A row already there (the same key) means no second row and no second text.
// ---------------------------------------------------------------------------

/** Kinds Kyle never gets a bell (or a text) for, and why: nothing for him to do. */
export const KYLE_SKIPS: Readonly<Record<string, string>> = {
  photo_autohdr_sent: "the hub sent the raws to AutoHDR by itself",
  photo_autohdr_slow: "AutoHDR is slow: nothing Kyle can do about it (Jordan still hears)",
  autohdr_credits_low: "Jordan tops up the credits in AutoHDR",
  autohdr_credits_critical: "Jordan tops up the credits in AutoHDR",
  photo_qc_shadow: "the paid QC is off; a shadow result asks nothing of Kyle",
  photo_qc_budget: "the paid QC's budget is Jordan's",
  photo_coaching_draft: "the coaching note is Jordan's to approve",
  photo_autohdr_billing: "a billing question for Jordan",
};
/** Kinds that are one bell per job per state (the bucket), keyed by the job's stage at the time. */
export const KYLE_BUCKET: Readonly<Record<string, "review" | "delivery" | "aryeo">> = {
  photo_free_check: "review",
  READY_TO_DELIVER: "review",
  QC_DECISION_NEEDED: "review",
  QC_HOLD: "review",
  photo_after_delivery: "delivery",
  photo_delivered_with_holds: "delivery",
  photo_delivery_mismatch: "delivery",
  photo_delivery_waiting: "delivery",
  photo_delivery_override: "delivery",
  photo_listing_corrupt: "delivery",
  photo_delivery_duplicate: "aryeo",
};

/** The photo job a bell is about, from its link (/ops/photo-delivery/<jobId>). Pure. */
export function jobIdOfHref(href: string): string | null {
  const id = /^\/ops\/photo-delivery\/([A-Za-z0-9_-]{6,64})(?:[/?#]|$)/.exec(href)?.[1] ?? null;
  return id === "credits" || id === "settings" ? null : id;
}

/**
 * Kyle's row key for an alert (pure), or null when he gets none. `stage`: the
 * job's stage and when it entered it, read at the time of the alert.
 */
export function kyleBellKey(a: { kind: string; dedupeKey: string; href: string }, stage: { stage: string; stageChangedAt: Date } | null): string | null {
  if (KYLE_SKIPS[a.kind]) return null;
  const bucket = KYLE_BUCKET[a.kind];
  const jobId = jobIdOfHref(a.href);
  if (!bucket || !jobId || !stage) return a.dedupeKey;
  return `pd-kyle-${jobId}-${bucket}-${stage.stage}-${stage.stageChangedAt.getTime()}`;
}

/** kyleBellKey with the job's stage read now (a read that fails keeps the alert's own key). */
export async function kyleRowKey(a: { kind: string; dedupeKey: string; href: string }): Promise<string | null> {
  if (KYLE_SKIPS[a.kind]) return null;
  const jobId = KYLE_BUCKET[a.kind] ? jobIdOfHref(a.href) : null;
  const stage = jobId ? await prisma.photoJob.findUnique({ where: { id: jobId }, select: { stage: true, stageChangedAt: true } }).catch(() => null) : null;
  return kyleBellKey(a, stage && stage.stageChangedAt ? { stage: stage.stage, stageChangedAt: stage.stageChangedAt } : null);
}

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
      // Oct 23 2026 (huddle item 11): Kyle's row by his own rule (kyleRowKey): none, or one per job per state.
      const key = p.role === "ADMIN" ? await kyleRowKey(a) : a.dedupeKey;
      if (!key) {
        outcomes.push(`${p.role}:skipped`);
        continue;
      }
      const row = await prisma.notification
        .create({
          data: { kind: a.kind, title, body, href: a.href, audience: JSON.stringify([p.role]), userKey: `tm:${p.id}`, dedupeKey: `${key}-${p.slot}` },
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
