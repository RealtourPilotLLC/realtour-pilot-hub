"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import type { NotifyPrefs } from "@/lib/notifyPrefDefaults";

// ---------------------------------------------------------------------------
// YOUR PROFILE (Oct 30 2026, Jordan: "give everyone on the platform a profile
// page where they can update their timezone, location, profile picture, and
// phone number and any other preferences"). Every action here writes the
// signed-in person's OWN team card and nothing else; the office edits anyone's
// on People → Logins. A "view as" preview reads but never writes.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const NO_CARD = "Your login isn't linked to a team card yet, so there's nowhere to keep this. Ask Jordan to press Team card on your login in People → Logins.";

async function mine() {
  const { authEnforced } = await import("@/lib/auth/guards");
  const me = await getCurrentUser().catch(() => null);
  if (!me) return { ok: false as const, message: authEnforced() ? "Please sign in again." : "Nobody is signed in." };
  if (me.impersonating) return { ok: false as const, message: "You're previewing another user. Exit the preview to change a profile." };
  const { myTeamCard } = await import("@/lib/profile");
  const card = await myTeamCard(me);
  if (!card) return { ok: false as const, message: NO_CARD };
  return { ok: true as const, me, card };
}

async function audit(actor: string, action: string, target: string, detail: string) {
  await prisma.auditLog.create({ data: { actor, action, target, detail } }).catch(() => {});
}

export async function saveMyProfile(input: { phone: string; timezone: string; location: string }): Promise<Result> {
  try {
    const who = await mine();
    if (!who.ok) return who;
    const { me, card } = who;
    const { cleanTeamPhone, isTimeZone } = await import("@/lib/phoneKey");
    const rawPhone = String(input?.phone ?? "").trim();
    const phone = rawPhone ? cleanTeamPhone(rawPhone) : null;
    if (rawPhone && !phone) return { ok: false, message: "That phone number doesn't look right. Outside the US, start with + and the country code (e.g. +63 917 123 4567)." };
    const timezone = String(input?.timezone ?? "").trim() || null;
    if (timezone && !isTimeZone(timezone)) return { ok: false, message: "That time zone isn't one the hub knows. Pick one from the list." };
    const location = String(input?.location ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null;

    const changed: string[] = [];
    if (phone !== card.phone) changed.push(phone ? "phone" : "phone removed");
    if (timezone !== card.timezone) changed.push("time zone");
    if (location !== card.location) changed.push("location");
    if (!changed.length) return { ok: true, message: "Nothing was different from what's on file." };
    await prisma.teamMember.update({ where: { id: card.id }, data: { phone, timezone, location } });
    // An editor's desk and reminders read their clock from the roster.
    if (card.editorKey && timezone !== card.timezone) {
      const { ensureEditorRoster } = await import("@/lib/editorRoster");
      await ensureEditorRoster({ force: true }).catch(() => {});
    }
    await audit(me.email, "profile_update", card.id, changed.join(", "));
    revalidatePath("/profile");
    revalidatePath("/users");

    // SaveStatus already says "Saved"; the message is what changed and what it means.
    const words = changed.join(", ");
    const notes = [`${words.charAt(0).toUpperCase()}${words.slice(1)} updated.`];
    if (phone && phone !== card.phone) {
      const { staffTextNumber } = await import("@/lib/hubSms");
      if (!staffTextNumber(phone)) notes.push(card.slackId ? "The office line can only text US numbers, so hub messages reach you on Slack instead." : "The office line can only text US numbers, so the hub can't text this one.");
    } else if (card.phone) {
      notes.push("With no phone on file, the hub can't text you.");
    }
    return { ok: true, message: notes.join(" ") };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Not saved. Try again." };
  }
}

export async function saveMyPhoto(form: FormData): Promise<Result & { src?: string | null }> {
  try {
    const who = await mine();
    if (!who.ok) return who;
    const file = form.get("photo");
    if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") return { ok: false, message: "Pick a picture first." };
    const { storeTeamPhoto } = await import("@/lib/teamPhotoStore");
    const at = await storeTeamPhoto(who.card.id, new Uint8Array(await (file as Blob).arrayBuffer()));
    await audit(who.me.email, "profile_photo", who.card.id, "photo changed");
    revalidatePath("/", "layout");
    const { teamPhotoSrc } = await import("@/lib/teamPhoto");
    return { ok: true, message: "Photo saved. Your teammates see it next to your name.", src: teamPhotoSrc({ id: who.card.id, photoAt: at }) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The photo wasn't saved. Try again." };
  }
}

export async function removeMyPhoto(): Promise<Result> {
  try {
    const who = await mine();
    if (!who.ok) return who;
    const { clearTeamPhoto } = await import("@/lib/teamPhotoStore");
    await clearTeamPhoto(who.card.id);
    await audit(who.me.email, "profile_photo", who.card.id, "photo removed");
    revalidatePath("/", "layout");
    return { ok: true, message: "Photo removed. Your initials show instead." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Not removed. Try again." };
  }
}

export async function saveMyNotifications(prefs: NotifyPrefs): Promise<Result> {
  try {
    const who = await mine();
    if (!who.ok) return who;
    const { me, card } = who;
    const { parseNotifyPrefs, clearInapplicable, NOTIFY_EVENTS, SELF_MUST_REACH } = await import("@/lib/notifyPrefDefaults");
    const parsed = parseNotifyPrefs(prefs);
    if (!parsed) return { ok: false, message: "Something's off with what was sent. Reload the page and try again." };
    const { notifyGroupFor, saveNotifyPrefs } = await import("@/lib/notifyPrefs");
    const group = await notifyGroupFor(card.id).catch(() => null);
    const clean = group ? clearInapplicable(parsed, group) : parsed;
    const must = group ? SELF_MUST_REACH[group] : undefined;
    if (must) {
      const { staffTextNumber } = await import("@/lib/hubSms");
      const canSlack = !!card.slackId, canSms = !!staffTextNumber(card.phone);
      const reached = (clean[must].slack && canSlack) || (clean[must].sms && canSms);
      if ((canSlack || canSms) && !reached) {
        const label = NOTIFY_EVENTS.find((e) => e.key === must)?.short ?? must;
        return { ok: false, message: `Keep at least one way on for ${label}: it's how new work reaches you. Nothing was saved.` };
      }
    }
    await saveNotifyPrefs(card.id, clean, me.email);
    await audit(me.email, "profile_notifications", card.id, NOTIFY_EVENTS.map((e) => `${e.key}:${clean[e.key].slack ? "S" : ""}${clean[e.key].sms ? "T" : ""}`).join(" "));
    revalidatePath("/profile");
    revalidatePath("/settings");
    return { ok: true, message: "It applies from the next notification." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Not saved. Try again." };
  }
}
