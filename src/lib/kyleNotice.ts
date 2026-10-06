import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// A NOTICE KYLE HAS TO ACT ON, ADDRESSED TO HIM (Oct 5 2026).
//
// Several delivery problems used to be an OWNER/ADMIN bell and nothing else: a
// 1080p file held for a listen, a skipped or failed pass on a portal video, the
// Topaz balance running out, a client's notes sent along with an approval. A
// role bell is a row Kyle may not open for a day. These go to him by name:
//   · one bell row addressed to his roster row (bell-only kinds, so the bell
//     bridge never sends a second DM), and
//   · his Slack DM through the existing staff helper (notify.notifyStaffSms):
//     Slack first, at any hour — the Oct 5 overnight hold is gone (Oct 6 2026,
//     Jordan: "Anyone on the team can get pinged anytime. Just not Jordan on
//     Saturday until 7:30PM."); only a quiet time saved for him holds it — and
//     the ops relay if nothing could reach him.
// WHO "KYLE" IS (Oct 5 night): the program's DELIVERY duty owner — the same
// lookup the delivery-ready alerts use (deliveryReadyNotify
// .deliveryOwnerTeamMemberId: the owner's login → its roster link → the roster
// row with the login's exact email → the one active row with exactly its
// name). It used to be "the one active roster row whose name contains Kyle",
// which a second Kyle on the roster would have silenced. When nothing resolves
// the reason is logged and returned, and the bell goes to the office role —
// a person is never guessed.
// Deduped on the bell row, and the bell row IS the claim: it is inserted
// first, and only the call whose insert wins sends the DM. Two sweeps racing
// on the same notice used to both read "not seen yet" and both DM him.
// Never throws — the record that triggered it (the job, the task) is the truth.
// ---------------------------------------------------------------------------

export type KyleNotice = {
  /** Bell kind. Keep it bell-only (not in notifyPrefs.KIND_TO_EVENT) so the DM below is the only DM. */
  kind: string;
  title: string;
  body: string;
  href: string;
  dedupeKey: string;
  /** The Slack DM, plain words, with the link. */
  slack: string;
};

/** The DELIVERY duty owner's roster row, or the reason there isn't one. */
export async function deliveryOwner(): Promise<{ id: string; error: null } | { id: null; error: string }> {
  try {
    // Imported here, not at the top: deliveryReadyNotify reads the delivery
    // board, which reads the 1080p lane, which imports this file.
    const { deliveryOwnerTeamMemberId } = await import("@/lib/deliveryReadyNotify");
    return { id: await deliveryOwnerTeamMemberId(), error: null };
  } catch (e) {
    return { id: null, error: e instanceof Error ? e.message : "The delivery owner could not be read." };
  }
}

/** Kept under its old name for the callers that ask "who is Kyle": the
 *  DELIVERY duty owner's roster row, or null (never a guess). */
export async function kyleTeamMemberId(): Promise<string | null> {
  return (await deliveryOwner()).id;
}

export async function noticeForKyle(n: KyleNotice): Promise<{ bell: boolean; slack: string | null; error?: string }> {
  try {
    const { notifyInApp, notifyStaffSms, logDelivery } = await import("@/lib/notify");
    const owner = await deliveryOwner();
    const kyle = owner.id;
    if (!kyle) {
      console.error(`noticeForKyle: ${owner.error} — "${n.title}" went to the office's bell instead.`);
      await notifyInApp({ kind: n.kind, title: n.title, body: n.body, href: n.href, targets: [{ roles: ["ADMIN"] }], dedupeKey: n.dedupeKey });
      return { bell: true, slack: null, error: owner.error ?? "No delivery owner." };
    }
    // The same row notifyInApp writes for a person target (these kinds are
    // bell-only, so its bridge would add nothing), written here so its unique
    // dedupeKey can say whether THIS call is the one that announces it.
    const row = await prisma.notification
      .create({
        data: { kind: n.kind, title: n.title.slice(0, 90), body: n.body ? n.body.slice(0, 140) : null, href: n.href, audience: JSON.stringify(["ADMIN"]), userKey: `tm:${kyle}`, dedupeKey: `${n.dedupeKey}-0` },
        select: { id: true },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string } | null)?.code === "P2002") return null; // already announced — by this call's twin, or earlier
        throw e;
      });
    if (!row) return { bell: false, slack: null };
    await logDelivery({ notificationId: row.id, teamMemberId: kyle, kind: n.kind, channel: "bell", status: "sent" });
    const out = await notifyStaffSms([kyle], n.slack, n.kind);
    return { bell: true, slack: out[0]?.outcome ?? null };
  } catch (e) {
    console.warn("noticeForKyle failed", n.kind, e);
    return { bell: false, slack: null };
  }
}
