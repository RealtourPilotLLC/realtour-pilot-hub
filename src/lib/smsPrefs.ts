import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// The OWNER's text preferences (Jordan, Sep 11: "make sure I get a text when a
// video is in review or I'm mentioned in a chat").
//
// The texts themselves ride the photographers' SMS bridge in notify.ts — same
// PendingSms queue, same 7:00–22:00 ET quiet hours, same 30-minute digest,
// same bell-row dedupe. What lives HERE is only the question "does the owner
// want this kind on his phone?", stored as an AppSetting row
// (`sms-prefs:<teamMemberId>` = {"kinds":[…]}) so a change is a click on
// /settings, not a deploy. NO row means the default — and the default for the
// owner's own team member is ON for both kinds, so the feature works the day
// it ships without anyone writing a preference first.
//
// Who the owner is comes from the login roster (AppUser role OWNER → its
// linked TeamMember, else the TeamMember on the same email) — never a
// hard-coded id, so a change of hands is a roster edit.
//
// Sep 15 (Jordan: "I should be able to manage team notifications in
// settings"): the owner's two switches are now two cells of the Team
// notifications matrix (src/lib/notifyPrefs.ts, store `notify-prefs:<id>`),
// where every active person has a row. What stays here is the owner
// identity (ownerTeamMemberIds / ownerPhoneKeys / ownerActedBy — read by the
// OpenPhone webhook, the Slack sync and the Review Room) and the legacy
// readers, which now answer through the matrix: ownerSmsKinds reads
// notifyPrefsFor, and a `sms-prefs` row is honoured only until a matrix row
// exists for him. notify.ts no longer calls ownerSmsRecipient — the bridge
// decides by the matrix — but the function stays for any other caller.
// ---------------------------------------------------------------------------

/** The two kinds the owner can switch: a cut waiting on his verdict in the
 *  Review Room, and an @mention of him on any note / team-thread surface. */
export type OwnerSmsKind = "review_ready" | "mention";
export const OWNER_SMS_KINDS: OwnerSmsKind[] = ["review_ready", "mention"];

export type SmsPrefs = { kinds: OwnerSmsKind[] };
export const DEFAULT_OWNER_SMS: SmsPrefs = { kinds: ["review_ready", "mention"] };

export const smsPrefsKey = (teamMemberId: string) => `sms-prefs:${teamMemberId}`;

// Bell kinds → the owner's switch. Only the Review Room cut kinds map to
// "review_ready": the photo re-review rollups in reviewActions.ts ring the
// bell under the literal kind `review_ready`, but they are not "a video in
// review", so they stay bell-only.
const BELL_KIND_TO_PREF: Record<string, OwnerSmsKind> = {
  cut_ready: "review_ready",
  review_submitted: "review_ready",
  mention: "mention",
};
export function ownerSmsKindFor(bellKind: string): OwnerSmsKind | null {
  return BELL_KIND_TO_PREF[bellKind] ?? null;
}

// The ACTIVE logins of one role → their roster rows (AppUser.teamMemberId,
// else the active TeamMember on the same email), cached ten minutes per
// lambda per role (the bridge runs on every bell row; the roster changes a
// few times a year). Best-effort: a lookup failure returns the last known
// set, or none — never throws. Sep 16: generalised from the owner-only
// lookup so the office (ADMIN logins) can be addressed the same way.
const loginCache = new Map<string, { at: number; ids: string[] }>();
export async function teamMemberIdsForLoginRole(role: "OWNER" | "ADMIN" | "EDITOR" | "PHOTOGRAPHER"): Promise<string[]> {
  const hit = loginCache.get(role);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ids;
  try {
    const logins = await prisma.appUser.findMany({
      where: { role, status: "ACTIVE" },
      select: { email: true, teamMemberId: true },
    });
    const ids = new Set(logins.map((l) => l.teamMemberId).filter((id): id is string => !!id));
    const emails = logins.map((l) => l.email).filter(Boolean);
    if (emails.length) {
      const byEmail = await prisma.teamMember.findMany({
        where: { email: { in: emails, mode: "insensitive" }, active: true },
        select: { id: true },
      });
      for (const t of byEmail) ids.add(t.id);
    }
    const out = [...ids];
    loginCache.set(role, { at: Date.now(), ids: out });
    return out;
  } catch {
    return loginCache.get(role)?.ids ?? [];
  }
}

// Owner TeamMember ids — the OWNER logins' roster rows.
export async function ownerTeamMemberIds(): Promise<string[]> {
  return teamMemberIdsForLoginRole("OWNER");
}

/**
 * "The office" (Sep 16, Kyle call): the ADMIN logins' roster rows, minus
 * anyone the card files elsewhere — an owner, an editor (Kim's roster role is
 * MANAGER but her key makes her an editor), or a shooter (James logs in as
 * ADMIN but is PHOTOGRAPHER on the roster and hears a job through the
 * photographer leg). Exactly the "Office" group of the Settings card, so what
 * the bridge addresses and what the matrix greys out agree. Kyle today.
 */
export async function officeTeamMemberIds(): Promise<string[]> {
  const [admins, owners] = await Promise.all([teamMemberIdsForLoginRole("ADMIN"), ownerTeamMemberIds()]);
  const candidates = admins.filter((id) => !owners.includes(id));
  if (candidates.length === 0) return [];
  try {
    const { editorKeysByTeamMemberId } = await import("@/lib/notifyPrefs");
    const editors = await editorKeysByTeamMemberId();
    const rows = await prisma.teamMember.findMany({
      where: { id: { in: candidates }, active: true },
      select: { id: true, role: true },
    });
    return rows.filter((r) => String(r.role).toUpperCase() !== "PHOTOGRAPHER" && !editors.has(r.id)).map((r) => r.id);
  } catch {
    return [];
  }
}

/** The 10-digit keys of the owner's own handset(s) — the webhook's echo
 *  guard reads this so a reply the owner sends the hub's text from his
 *  pocket is never minted into a task. */
export async function ownerPhoneKeys(): Promise<Set<string>> {
  const ids = await ownerTeamMemberIds();
  if (ids.length === 0) return new Set();
  try {
    const rows = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { phone: true } });
    return new Set(rows.map((r) => (r.phone ?? "").replace(/\D/g, "").slice(-10)).filter((k) => k.length === 10));
  } catch {
    return new Set();
  }
}

/** What this team member has switched on — since Sep 15 the owner's two
 *  cells of the Team notifications matrix (mention.sms / review_ready.sms),
 *  defaults ON for the owner; a pre-matrix `sms-prefs` row is honoured until
 *  a matrix row exists. Nobody but the owner has these kinds. */
export async function ownerSmsKinds(teamMemberId: string): Promise<Set<OwnerSmsKind>> {
  const owners = await ownerTeamMemberIds();
  if (!owners.includes(teamMemberId)) return new Set();
  const { notifyPrefsFor } = await import("@/lib/notifyPrefs");
  const prefs = await notifyPrefsFor(teamMemberId);
  const kinds = new Set<OwnerSmsKind>();
  if (prefs.mention.sms) kinds.add("mention");
  if (prefs.review_ready.sms) kinds.add("review_ready");
  return kinds;
}

/**
 * LEGACY (pre-Sep 15) — the bridge in notify.ts now decides by the matrix
 * (bridgePerson / bridgeBroadcast) and no longer calls this. Kept for
 * any other caller; it answers through the matrix like ownerSmsKinds.
 * The question: does this bell row earn the owner a text? `tmId` is the
 * row's tm: target (null on a role broadcast); `roles` is the row's audience
 * after the money clamp. Returns the TeamMember to text, or null.
 *   · a row addressed to the owner's own tm: key → him, if the kind is on;
 *   · a broadcast that includes OWNER → the (first) owner, if the kind is on;
 *   · anything else → null (the photographer bridge decides as before).
 * A member with no phone on file is never returned — a queued line with
 * nowhere to go would just sit in PendingSms being re-tried every 5 minutes.
 */
export async function ownerSmsRecipient(
  bellKind: string,
  row: { tmId: string | null; roles: readonly string[] },
): Promise<{ ownerRow: boolean; textTo: string | null }> {
  const none = { ownerRow: false, textTo: null };
  const pref = ownerSmsKindFor(bellKind);
  if (!pref) return none;
  // A mention is only ever person-addressed (mentions.ts and messageActions.ts
  // both write tm: rows). A BROADCAST of kind "mention" would otherwise text
  // the owner about other people's mentions — reviewer, Sep 11.
  if (pref === "mention" && !row.tmId) return none;
  const owners = await ownerTeamMemberIds();
  if (owners.length === 0) return none;
  let target: string | null = null;
  if (row.tmId) {
    if (!owners.includes(row.tmId)) return none;
    target = row.tmId;
  } else if (row.roles.includes("OWNER")) {
    target = owners[0];
  }
  if (!target) return none;
  // ownerRow = "this row IS the owner's" — the caller must not fall through to
  // the photographer bridge for it, whatever the switch says (Jordan is
  // PHOTOGRAPHER on the roster; the switch has to be the only gate).
  if (!(await ownerSmsKinds(target)).has(pref)) return { ownerRow: true, textTo: null };
  try {
    const m = await prisma.teamMember.findUnique({ where: { id: target }, select: { phone: true } });
    if (!m?.phone?.replace(/\D/g, "")) return { ownerRow: true, textTo: null };
  } catch {
    return { ownerRow: true, textTo: null };
  }
  return { ownerRow: true, textTo: target };
}

/**
 * Did the owner do this himself? For the one surface that only carries a
 * NAME — a cut row's submittedByName, because the store's upload-completed
 * callback has no session — matched case-insensitively against the owner
 * logins' names and emails and his roster row's name. Reviewer, Sep 11: the
 * owner uploading a vendor's cut from his own login must not be texted that
 * a video is waiting on him — he just put it there. Best-effort false.
 */
export async function ownerActedBy(name: string | null | undefined): Promise<boolean> {
  const label = (name ?? "").trim().toLowerCase();
  if (!label) return false;
  try {
    const labels = new Set<string>();
    const logins = await prisma.appUser.findMany({
      where: { role: "OWNER", status: "ACTIVE" },
      select: { name: true, email: true },
    });
    for (const l of logins) {
      if (l.name) labels.add(l.name.trim().toLowerCase());
      if (l.email) labels.add(l.email.trim().toLowerCase());
    }
    const ids = await ownerTeamMemberIds();
    if (ids.length) {
      const rows = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { name: true } });
      for (const r of rows) if (r.name) labels.add(r.name.trim().toLowerCase());
    }
    return labels.has(label);
  } catch {
    return false;
  }
}

/** For the Settings card: the signed-in owner's team member, his switches and
 *  the number the texts go to (masked — the page never shows a full number). */
export async function ownerSmsSettings(me: { teamMemberId: string | null; email: string } | null): Promise<{
  teamMemberId: string | null;
  prefs: SmsPrefs;
  phoneMasked: string | null;
}> {
  const owners = await ownerTeamMemberIds();
  let tmId: string | null = null;
  if (me?.teamMemberId && owners.includes(me.teamMemberId)) tmId = me.teamMemberId;
  else if (me?.email) {
    const byEmail = await prisma.teamMember
      .findFirst({ where: { email: { equals: me.email, mode: "insensitive" }, active: true }, select: { id: true } })
      .catch(() => null);
    if (byEmail && owners.includes(byEmail.id)) tmId = byEmail.id;
  }
  // Open mode (local dev, no session) renders as the owner: show his row.
  if (!tmId && !me) tmId = owners[0] ?? null;
  if (!tmId) return { teamMemberId: null, prefs: DEFAULT_OWNER_SMS, phoneMasked: null };
  const [kinds, member] = await Promise.all([
    ownerSmsKinds(tmId),
    prisma.teamMember.findUnique({ where: { id: tmId }, select: { phone: true } }).catch(() => null),
  ]);
  return { teamMemberId: tmId, prefs: { kinds: OWNER_SMS_KINDS.filter((k) => kinds.has(k)) }, phoneMasked: maskPhone(member?.phone) };
}

/** "(•••) •••-8650" — enough to recognise the number, never the number. */
export function maskPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length < 4) return null;
  return `(•••) •••-${d.slice(-4)}`;
}
