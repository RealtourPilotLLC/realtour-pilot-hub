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

// "Send test DM" on a People row (owner/admin — Sep 15, replacing the owner-
// only self test): proves the bridge end to end for THAT person — their
// roster Slack ID, one fixed sentence, nothing else. No id passed = the
// person pressing it (their linked Team row). Refuses with the reason when
// no ID is on file, and hands back Slack's own words when the DM bounces:
// "channel_not_found" + "missing_scope" means the bot has never talked to
// them and the token has no im:write — a re-install, not a different ID.
export async function sendTestSlackDm(teamMemberId?: string): Promise<ActionResult> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const select = { name: true, slackId: true } as const;
  let member: { name: string; slackId: string | null } | null = null;
  if (teamMemberId) {
    member = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select });
    if (!member) return { ok: false, message: "Teammate not found." };
  } else {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const me = await getCurrentUser().catch(() => null);
    member = me?.teamMemberId ? await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select }) : null;
    if (!member && me?.email) {
      member = await prisma.teamMember.findFirst({ where: { email: { equals: me.email, mode: "insensitive" } }, select });
    }
    if (!member) {
      return { ok: false, message: "Your login isn't linked to a Team row, so there is no Slack ID to test. Link it on Logins & access first." };
    }
  }
  const first = member.name.split(/\s+/)[0];
  if (!member.slackId) {
    return { ok: false, message: `No Slack ID on ${first}'s Team row yet — add it on the card (or press Find on Slack / Sync from the workspace), then try again.` };
  }
  const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
  const r = await slackDmUserDetailed(
    member.slackId,
    "⚙️ Test from the Ops Hub — you'll get pings here for tags and messages on your jobs.",
  );
  if (r.ok) return { ok: true, message: `Sent — ${first} should see it in their Slack DMs (${member.slackId}).` };
  const scopeHint = /missing_scope|channel_not_found|not_in_channel/.test(r.error)
    ? ` The bot has never DMed ${first} and the token can't open a DM on its own — re-install the Ops Hub Slack app with the im:write scope (Connections → Slack), or have ${first} send the bot one message first.`
    : " Is the bot token still valid? Connections → Slack.";
  return { ok: false, message: `Slack refused the DM: ${r.error}.${scopeHint}` };
}

// "Sync Slack IDs from the workspace" (owner/admin, Sep 15): fill every
// roster row that has no Slack ID from the workspace directory — read with
// Jordan's own user token, since the bot's has no users:read — when exactly
// ONE human matches, by the email on the Team row first, else by a first
// name / display name that is unique in the workspace. Anything ambiguous
// or absent is reported, never guessed: an ID on the wrong row would DM the
// wrong person. Rows that already carry an ID are left alone. Idempotent.
export type SlackSyncReport = ActionResult & {
  set: { name: string; slackId: string; by: "email" | "name" }[];
  skipped: { name: string; reason: string }[];
};
export async function syncSlackIdsFromWorkspace(): Promise<SlackSyncReport> {
  try { await requireAdmin(); } catch (e) { return { ok: false, message: (e as Error).message, set: [], skipped: [] }; }
  const { slackWorkspaceUsers } = await import("@/lib/integrations/slack");
  const ws = await slackWorkspaceUsers();
  if (!ws.ok) {
    const why =
      ws.error === "user_token_not_connected"
        ? "the Slack history (user) token isn't connected — Connections → Slack history."
        : `Slack answered "${ws.error}".`;
    return { ok: false, message: `Couldn't read the workspace directory: ${why}`, set: [], skipped: [] };
  }
  const roster = await prisma.teamMember.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, slackId: true },
  });
  const takenIds = new Map<string, string>(); // slackId → roster name (any row, active or not)
  for (const t of await prisma.teamMember.findMany({ where: { slackId: { not: null } }, select: { name: true, slackId: true } })) {
    if (t.slackId) takenIds.set(t.slackId, t.name);
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const firstOf = (s: string) => norm(s).split(/\s+/)[0] ?? "";
  const set: SlackSyncReport["set"] = [];
  const skipped: SlackSyncReport["skipped"] = [];
  for (const row of roster) {
    if (row.slackId) continue;
    const first = row.name.split(/\s+/)[0];
    // 1. The email on the Team row.
    const byEmail = ws.users.filter((u) => !!u.email && norm(u.email) === norm(row.email));
    let hit: { id: string; by: "email" | "name" } | null = null;
    if (byEmail.length === 1) hit = { id: byEmail[0].id, by: "email" };
    else if (byEmail.length === 0) {
      // 2. A first name / display name that is unique across the workspace's
      //    humans ("Kim" ↔ "Kim Miguel"; "Harrison W" ↔ "Harrison Wells").
      const wantFirst = firstOf(row.name);
      const wantFull = norm(row.name);
      const byName = ws.users.filter(
        (u) => firstOf(u.name) === wantFirst || norm(u.displayName) === wantFirst || norm(u.name) === wantFull || norm(u.displayName) === wantFull,
      );
      if (byName.length === 1) hit = { id: byName[0].id, by: "name" };
      else if (byName.length > 1) {
        skipped.push({ name: row.name, reason: `${byName.length} people on Slack could be ${first} — paste the member ID by hand.` });
        continue;
      }
    } else {
      skipped.push({ name: row.name, reason: `${byEmail.length} Slack accounts share ${row.email} — paste the member ID by hand.` });
      continue;
    }
    if (!hit) {
      skipped.push({ name: row.name, reason: `no Slack account under ${row.email} and no unique "${first}" in the workspace — paste the member ID by hand.` });
      continue;
    }
    const holder = takenIds.get(hit.id);
    if (holder) {
      skipped.push({ name: row.name, reason: `Slack's match (${hit.id}) is already on ${holder}'s row — one Slack account, one person.` });
      continue;
    }
    await prisma.teamMember.update({ where: { id: row.id }, data: { slackId: hit.id } });
    takenIds.set(hit.id, row.name);
    set.push({ name: row.name, slackId: hit.id, by: hit.by });
  }
  if (set.length) {
    revalidatePath("/users");
    for (const s of set) {
      const id = roster.find((r) => r.name === s.name)?.id;
      if (id) revalidatePath(`/team/${id}`);
    }
  }
  const already = roster.filter((r) => r.slackId).length;
  const message =
    set.length === 0 && skipped.length === 0
      ? `Nothing to do — every active teammate already has a Slack ID (${already}).`
      : `${set.length ? `Set ${set.length}: ${set.map((s) => `${s.name.split(/\s+/)[0]} (${s.slackId}, by ${s.by})`).join(", ")}.` : "Nothing new to set."}${
          skipped.length ? ` Couldn't place ${skipped.length}: ${skipped.map((s) => s.name.split(/\s+/)[0]).join(", ")}.` : ""
        }`;
  return { ok: true, message, set, skipped };
}
