"use server";

import { requireAdmin, requireOwner } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";

export type ActionResult = { ok: boolean; message: string };

// Text a teammate via OpenPhone. Human-initiated (Kyle/Jordan clicks Send) — the
// platform never auto-texts. Used for shoot coordination + morning well-wishes.
export async function sendTeamText(memberId: string, body: string): Promise<ActionResult> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };
  const member = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { phone: true, name: true },
  });
  if (!member?.phone) return { ok: false, message: "No phone number on file for this teammate." };
  const k = phoneKey(member.phone);
  if (k.length !== 10) return { ok: false, message: "Their phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  try {
    await OpenPhone.sendMessage(from, `+1${k}`, text);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send text." };
  }
  revalidatePath(`/team/${memberId}`);
  return { ok: true, message: `Text sent to ${member.name.split(" ")[0]}.` };
}

// Save a creative's pay settings (manually set; drive automatic payroll). The
// home address is geocoded to lat/lng for the mileage radius.
export async function savePaySettings(
  memberId: string,
  form: {
    homeAddress?: string | null;
    payPercent?: number | null;
    payFloor?: number | null;
    mileageRate?: number | null;
    homeRadiusMi?: number | null;
  },
): Promise<ActionResult> {
  await requireOwner();
  const existing = await prisma.teamMember.findUnique({
    where: { id: memberId },
    select: { homeAddress: true, homeLat: true, homeLng: true },
  });
  if (!existing) return { ok: false, message: "Teammate not found." };

  const data: Record<string, unknown> = {
    payPercent: form.payPercent ?? null,
    payFloor: form.payFloor ?? null,
    mileageRate: form.mileageRate ?? 0.65,
    homeRadiusMi: form.homeRadiusMi ?? 35,
  };

  // Geocode the home address only when it changed (or coords are missing).
  const addr = (form.homeAddress ?? "").trim();
  data.homeAddress = addr || null;
  if (!addr) {
    data.homeLat = null;
    data.homeLng = null;
  } else if (addr !== (existing.homeAddress ?? "") || existing.homeLat == null) {
    const { geocodeAddress } = await import("@/lib/travel");
    const geo = await geocodeAddress(addr);
    if (!geo) {
      // Save the rest, but tell the user the address couldn't be located.
      await prisma.teamMember.update({ where: { id: memberId }, data });
      revalidatePath(`/team/${memberId}`);
      return { ok: false, message: "Saved rates, but couldn't locate that home address — check it for mileage to work." };
    }
    data.homeLat = geo.lat;
    data.homeLng = geo.lng;
  }

  await prisma.teamMember.update({ where: { id: memberId }, data });
  // Pay settings affect mileage radius → clear cached mileage for this member.
  // Jordan's per-day mileage corrections survive: those rows just lose their
  // route signature so the computed figure refreshes under the override.
  await prisma.mileageDay.deleteMany({ where: { teamMemberId: memberId, overrideMiles: null } });
  await prisma.mileageDay.updateMany({ where: { teamMemberId: memberId, overrideMiles: { not: null } }, data: { sig: null } });
  revalidatePath(`/team/${memberId}`);
  revalidatePath("/payouts");
  return { ok: true, message: "Pay settings saved." };
}

// ---------------------------------------------------------------------------
// Slack member IDs on People (Jordan, Sep 15: "anytime someone is messaged in
// the Ops Hub a notification gets sent via Slack to whoever was mentioned").
// The roster's TeamMember.slackId is what the notify bridge DMs; these are
// the three ways it gets filled or checked. Owner/admin only — an ID pasted
// on the wrong row would DM the wrong person.
// ---------------------------------------------------------------------------
export async function saveSlackId(memberId: string, slackId: string | null): Promise<ActionResult> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const { SLACK_MEMBER_ID_RE } = await import("@/lib/slackScopes");
  const id = (slackId ?? "").trim().toUpperCase();
  if (id && !SLACK_MEMBER_ID_RE.test(id)) {
    return { ok: false, message: "That doesn't look like a Slack member ID — it starts with U or W (e.g. U07SCBTPDC7). In Slack: click the person → ⋯ → Copy member ID." };
  }
  const member = await prisma.teamMember.findUnique({ where: { id: memberId }, select: { name: true } });
  if (!member) return { ok: false, message: "Teammate not found." };
  const first = member.name.split(/\s+/)[0];
  if (id) {
    const taken = await slackIdTakenBy(id, memberId);
    if (taken) return { ok: false, message: `That ID is already on ${taken}'s row — one Slack account, one person.` };
  }
  await prisma.teamMember.update({ where: { id: memberId }, data: { slackId: id || null } });
  revalidatePath("/users");
  revalidatePath(`/team/${memberId}`);
  return id
    ? { ok: true, message: `Saved — @mentions and replies now DM ${first} on Slack.` }
    : { ok: true, message: `Cleared — ${first}'s mentions ring the bell (and any text fallback) only.` };
}

// slackId has no unique constraint, and the same ID on two rows would DM the
// wrong person (reviewer, Sep 15) — so every save asks who else holds it.
async function slackIdTakenBy(slackId: string, exceptMemberId: string): Promise<string | null> {
  const other = await prisma.teamMember.findFirst({
    where: { slackId, NOT: { id: exceptMemberId } },
    select: { name: true },
  });
  return other?.name ?? null;
}

// Ask Slack for the member's ID by the email on their Team row. The bot token
// installed today lacks users:read.email, so until the app is re-installed
// this answers with the exact fix rather than an ID — the button exists so
// the day the scope is there, the ID is one click.
export async function findSlackIdOnSlack(memberId: string): Promise<ActionResult & { slackId?: string }> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const member = await prisma.teamMember.findUnique({ where: { id: memberId }, select: { name: true, email: true } });
  if (!member) return { ok: false, message: "Teammate not found." };
  const first = member.name.split(/\s+/)[0];
  const { slackLookupByEmail } = await import("@/lib/integrations/slack");
  const { SLACK_SCOPE_FIX } = await import("@/lib/slackScopes");
  const r = await slackLookupByEmail(member.email);
  if (r.ok) {
    const taken = await slackIdTakenBy(r.id, memberId);
    if (taken) {
      return { ok: false, message: `Slack answered ${r.id} for ${member.email}, but that ID is already on ${taken}'s row — one Slack account, one person. Check the two rows' emails.` };
    }
    await prisma.teamMember.update({ where: { id: memberId }, data: { slackId: r.id } });
    revalidatePath("/users");
    revalidatePath(`/team/${memberId}`);
    return { ok: true, message: `Found ${first} on Slack (${r.id}) — saved.`, slackId: r.id };
  }
  if (r.error === "missing_scope") return { ok: false, message: SLACK_SCOPE_FIX };
  if (r.error === "users_not_found") {
    return { ok: false, message: `No Slack account under ${member.email}. Paste the member ID instead — in Slack: click the person → ⋯ → Copy member ID.` };
  }
  if (r.error === "not_connected") return { ok: false, message: "Slack isn't connected — Connections → Slack." };
  return { ok: false, message: `Slack answered "${r.error}". Try again, or paste the member ID by hand.` };
}

// "Send me a test Slack DM" (owner only): proves the bridge end to end for the
// person pressing it — the CURRENT user's own Slack ID, a fixed sentence,
// nothing else. Refuses with the reason when no ID is on file.
export async function sendTestSlackDm(): Promise<ActionResult> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  const select = { name: true, slackId: true } as const;
  let member = me?.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select }) : null;
  if (!member && me?.email) {
    member = await prisma.teamMember.findFirst({ where: { email: { equals: me.email, mode: "insensitive" } }, select });
  }
  if (!member) {
    return { ok: false, message: "Your login isn't linked to a Team row, so there is no Slack ID to test. Link it on Logins & access first." };
  }
  const first = member.name.split(/\s+/)[0];
  if (!member.slackId) {
    return { ok: false, message: `No Slack ID on ${first}'s Team row yet — add it on the card (or press Find on Slack), then try again.` };
  }
  const { slackDmUser } = await import("@/lib/integrations/slack");
  const { appBase } = await import("@/lib/appUrl");
  const ok = await slackDmUser(
    member.slackId,
    `✅ Test from the Ops Hub — Slack DMs for @mentions and replies are wired to this account.\n${appBase()}/users?tab=team`,
  );
  return ok
    ? { ok: true, message: `Sent — check your Slack DMs (${member.slackId}).` }
    : { ok: false, message: "Slack refused the DM — is the bot token still valid? Connections → Slack." };
}
