// ---------------------------------------------------------------------------
// DRILL: EVERYONE'S PROFILE PAGE, AND JHON'S NAME (Oct 30 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct30-profile.ts
//
// Jordan, Oct 30: "She is in the Philippines so is Jhon and Kim. Can we also
// fix Johns name to be Jhon? ... Also give everyone on the platform a profile
// page where they can update their timezone, location, profile picture, and
// phone number and any other preferences"
//
//   §1 contact and location: a person saves their own phone, clock and
//      location; a bad number or zone is refused with nothing written; an
//      editor's clock reaches their desk, Kim's built-in one included
//   §2 the photo: any picture becomes one 256 px JPEG in its own table, the
//      card carries only the stamp, teammates fetch it signed in and nobody
//      else does, and Remove puts the initials back
//   §3 notifications: your own switches only, an editor can't switch off the
//      way new work reaches them, a switch nothing rings is cleared
//   §4 who may write: a "view as" preview and a login with no team card
//      write nothing
//   §5 Jhon: the roster says Jhon Mark and still finds his card and key
//
// ISOLATION. PGlite on 127.0.0.1:7308 (DRILL_PORT overrides); production is
// never opened; every non-loopback call is fenced.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7308), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct30-profile" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { ensureEditorRoster } = await import("@/lib/editorRoster");
    const { editorMeta, editorKeyForTeamName, videoEditorChoices } = await import("@/lib/editors");
    const profile = await import("@/app/profile/actions");
    const { teamPhotoSrc } = await import("@/lib/teamPhoto");
    const { notifyPrefsFor } = await import("@/lib/notifyPrefs");
    const { GET } = await import("@/app/api/team-photo/[id]/route");
    const { NextRequest } = await import("next/server");
    const sharp = (await import("sharp")).default;

    const kimCard = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@example.test", role: "MANAGER", editorKey: "kim", slackId: "U0KIMDRILL1" } });
    const jhonCard = await prisma.teamMember.create({ data: { name: "Jhon Mark", email: "john@example.test", role: "VA", editorKey: "john" } });
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Example", email: "harrison@example.test", role: "PHOTOGRAPHER", phone: "+16105550100" } });
    const login = (email: string, role: string, teamMemberId: string | null, editorKey: string | null = null) =>
      prisma.appUser.create({ data: { email, name: email.split("@")[0], role, status: "ACTIVE", teamMemberId, editorKey } });
    const kim = await login("kim@example.test", "EDITOR", kimCard.id, "kim");
    const har = await login("harrison@example.test", "PHOTOGRAPHER", harrison.id);
    const owner = await login("owner@example.test", "OWNER", null);
    const as = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    // §1 ---------------------------------------------------------------------
    c.head("§1 · contact and location");
    await as(kim);
    const bad = await profile.saveMyProfile({ phone: "12345", timezone: "Asia/Manila", location: "Manila" });
    c.ok("a number that isn't one is refused", !bad.ok && /phone number/.test(bad.message));
    const badZone = await profile.saveMyProfile({ phone: "", timezone: "Mars/Olympus", location: "" });
    c.ok("an unknown time zone is refused", !badZone.ok && /time zone/.test(badZone.message));
    c.ok("…and nothing was written", (await prisma.teamMember.findUniqueOrThrow({ where: { id: kimCard.id } })).location === null);

    await ensureEditorRoster({ force: true });
    c.ok("Kim's desk clock is the built-in Manila before he sets one", editorMeta("kim")?.tz === "Asia/Manila");
    const saved = await profile.saveMyProfile({ phone: "+63 915 394 4459", timezone: "Asia/Tokyo", location: "  Quezon   City, Philippines " });
    const kimAfter = await prisma.teamMember.findUniqueOrThrow({ where: { id: kimCard.id } });
    c.ok("his own card takes the phone (E.164), clock and location", saved.ok && kimAfter.phone === "+639153944459" && kimAfter.timezone === "Asia/Tokyo" && kimAfter.location === "Quezon City, Philippines", saved.message);
    c.ok("a number outside the US is saved, and he's told texts can't reach it", /only text US numbers, so hub messages reach you on Slack/.test(saved.message), saved.message);
    c.ok("an editor's clock reaches the desk at once, built-in editor or not", editorMeta("kim")?.tz === "Asia/Tokyo");
    c.ok("the save is audited as his own", (await prisma.auditLog.count({ where: { action: "profile_update", actor: "kim@example.test", target: kimCard.id } })) === 1);
    const same = await profile.saveMyProfile({ phone: "+639153944459", timezone: "Asia/Tokyo", location: "Quezon City, Philippines" });
    c.ok("saving what's on file changes nothing and writes no second audit row", same.ok && (await prisma.auditLog.count({ where: { action: "profile_update" } })) === 1);
    await profile.saveMyProfile({ phone: "+639153944459", timezone: "", location: "Quezon City, Philippines" });
    await ensureEditorRoster({ force: true });
    c.ok("clearing it puts his desk back on the built-in Manila clock", editorMeta("kim")?.tz === "Asia/Manila");
    c.ok("Harrison's card was never touched", (await prisma.teamMember.findUniqueOrThrow({ where: { id: harrison.id } })).timezone === null);

    // §2 ---------------------------------------------------------------------
    c.head("§2 · the photo");
    const big = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toBuffer();
    const form = new FormData();
    form.append("photo", new Blob([new Uint8Array(big)], { type: "image/png" }), "me.png");
    const up = await profile.saveMyPhoto(form);
    const stored = await prisma.teamPhoto.findUnique({ where: { teamMemberId: kimCard.id } });
    const meta = stored ? await sharp(Buffer.from(stored.bytes)).metadata() : null;
    c.ok("any picture becomes one square 256 px JPEG", up.ok && meta?.format === "jpeg" && meta.width === 256 && meta.height === 256, up.message);
    const withStamp = await prisma.teamMember.findUniqueOrThrow({ where: { id: kimCard.id } });
    c.ok("the card carries only the stamp, and the URL is built from it", !!withStamp.photoAt && up.src === teamPhotoSrc(withStamp));
    const notPicture = new FormData();
    notPicture.append("photo", new Blob([new TextEncoder().encode("not a picture")], { type: "image/png" }), "x.png");
    const refused = await profile.saveMyPhoto(notPicture);
    c.ok("a file that isn't a picture is refused and the old photo stays", !refused.ok && /couldn't be read as a picture/.test(refused.message) && (await prisma.teamMember.findUniqueOrThrow({ where: { id: kimCard.id } })).photoAt?.getTime() === withStamp.photoAt!.getTime());

    const fetchPhoto = (id: string) => GET(new NextRequest(`http://127.0.0.1/api/team-photo/${id}?v=1`), { params: Promise.resolve({ id }) });
    await as(har);
    const seen = await fetchPhoto(kimCard.id);
    c.ok("a teammate signed in gets it, cached for good under its stamp", seen.status === 200 && seen.headers.get("content-type") === "image/jpeg" && /immutable/.test(seen.headers.get("cache-control") ?? ""));
    await clearSession();
    c.ok("nobody signed in gets nothing", (await fetchPhoto(kimCard.id)).status === 401);
    await as(kim);
    const removed = await profile.removeMyPhoto();
    c.ok("Remove deletes the bytes and the stamp: the initials come back", removed.ok && (await prisma.teamPhoto.count()) === 0 && (await prisma.teamMember.findUniqueOrThrow({ where: { id: kimCard.id } })).photoAt === null);

    // §3 ---------------------------------------------------------------------
    c.head("§3 · notifications");
    const off = { slack: false, sms: false };
    const kimPrefs = await notifyPrefsFor(kimCard.id);
    const silent = await profile.saveMyNotifications({ ...kimPrefs, job_ping: off });
    c.ok("an editor can't switch off every way new work reaches him", !silent.ok && /Keep at least one way on for Job pings/.test(silent.message));
    const quiet = await profile.saveMyNotifications({ ...kimPrefs, project_message: off, shoot_change: { slack: true, sms: true } });
    const kimSaved = await notifyPrefsFor(kimCard.id);
    c.ok("he can switch off job messages, and keeps job pings on Slack", quiet.ok && !kimSaved.project_message.slack && kimSaved.job_ping.slack, quiet.message);
    c.ok("a switch nothing rings for an editor is cleared, not stored", !kimSaved.shoot_change.slack && !kimSaved.shoot_change.sms);
    await as(har);
    const harPrefs = await notifyPrefsFor(harrison.id);
    const harOff = await profile.saveMyNotifications({ ...harPrefs, shoot_change: off });
    c.ok("a photographer keeps one way on for shoot changes", !harOff.ok && /Shoot changes/.test(harOff.message));
    const harSlackless = await profile.saveMyNotifications({ ...harPrefs, mention: { slack: true, sms: false }, shoot_change: { slack: false, sms: true } });
    c.ok("…and may move his tags to Slack and keep shoot changes by text", harSlackless.ok && (await notifyPrefsFor(harrison.id)).shoot_change.sms);
    c.ok("Kim's switches were not touched by Harrison's save", (await notifyPrefsFor(kimCard.id)).job_ping.slack);

    // §4 ---------------------------------------------------------------------
    c.head("§4 · who may write");
    await as(owner, kim.id);
    const preview = await profile.saveMyProfile({ phone: "", timezone: "", location: "Anywhere" });
    c.ok("Jordan previewing Kim writes nothing to Kim's card", !preview.ok && /previewing/.test(preview.message) && (await prisma.teamMember.findUniqueOrThrow({ where: { id: kimCard.id } })).location === "Quezon City, Philippines");
    await as(owner);
    const noCard = await profile.saveMyProfile({ phone: "", timezone: "", location: "Malvern" });
    c.ok("a login with no team card is told how to get one, and no card is made", !noCard.ok && /isn't linked to a team card/.test(noCard.message) && (await prisma.teamMember.count({ where: { email: "owner@example.test" } })) === 0);

    // §5 ---------------------------------------------------------------------
    c.head("§5 · Jhon");
    await ensureEditorRoster({ force: true });
    c.ok("the roster names him Jhon Mark", editorMeta("john")?.name === "Jhon Mark");
    c.ok("his card's name still finds his desk key", editorKeyForTeamName(jhonCard.name) === "john");
    c.ok("the pickers list Jhon Mark", videoEditorChoices().some((e) => e.key === "john" && e.name === "Jhon Mark"));
    const { slugForName, listAssignees } = await import("@/lib/assignees");
    c.ok("his first-name key is still john, wherever a key is made from a name", slugForName("Jhon Mark") === "john" && slugForName("Kim Miguel") === "kim");
    c.ok("the assignee list shows Jhon under key john", (await listAssignees()).some((a) => a.key === "john" && a.name === "Jhon"));
    const { loadSlackRoster, rosterLookup } = await import("@/lib/integrations/slackSync");
    const look = rosterLookup(await loadSlackRoster());
    c.ok("a Slack message to Jhon, or with the old spelling, lands on his desk", look.find("Jhon Mark")?.key === "john" && look.find("John Mark")?.key === "john" && look.find("Jhon")?.key === "john");
    c.ok("a card's desk key wins on the Slack roster too", look.find("Kim")?.key === "kim");

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
