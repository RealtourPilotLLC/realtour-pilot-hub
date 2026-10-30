// ---------------------------------------------------------------------------
// DRILL: ONBOARDING A NEW EDITOR, AND SHARING EDITS BY WORKLOAD (Oct 30 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct30-editor-onboarding.ts
//
// Jordan, Oct 30: "I just onboarded a new editor her name is Reychelle. I need
// to make sure the ops hub is set up to be able to onboard new editors and new
// users, and add their Slack ID, assignment, etc. ... the dropdown for
// assignment could be a dropdown of checkboxes, and then edits get assigned
// based on current workload, turnaround times, etc."
//
//   §1 the fold (lib/editorBalance rankPool): soonest to clear wins; a new
//      editor counts at the team's pace and the reason says so; anyone marked
//      out is passed over; ties keep the listed order
//   §2 onboarding on People → Logins: an invite as an editor makes the login,
//      the team card, the desk key, the clock and the lanes in one go; a bad
//      Slack ID or phone is refused before anything is written; one Slack
//      account is one person; an editor login with no card (Reychelle's case)
//      is set up from "Set up as editor"; Kim's card takes his built-in key
//   §3 the roster and the routing: the new key is a video editor everywhere
//      the hub asks, the legacy single-name setting is never written, a
//      shared lane goes to whoever owes less, a job already with an editor in
//      the pool stays put
//
// ISOLATION. PGlite on 127.0.0.1:7307 (DRILL_PORT overrides); production is
// never opened; every non-loopback call is fenced, so no Slack lookup leaves.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7307), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct30-editor-onboarding" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { rankPool } = await import("@/lib/editorBalance");
    const { keepOrRoute, isVideoEditorKey, videoEditorChoices, editorMeta } = await import("@/lib/editors");
    const { editorPools, editorRouting } = await import("@/lib/settings");
    const { ensureEditorRoster } = await import("@/lib/editorRoster");
    const { setSession } = await import("@/lib/auth/session");
    const users = await import("@/app/users/actions");

    // §1 ---------------------------------------------------------------------
    c.head("§1 · who gets the next edit");
    type F = { key: string; name: string; owed: number; approved: number; weekdays: number; out: string | null };
    const facts = (...rows: F[]) => new Map(rows.map((r) => [r.key, r]));
    const kim = (p: Partial<F> = {}): F => ({ key: "kim", name: "Kim", owed: 4, approved: 20, weekdays: 10, out: null, ...p });
    const rey = (p: Partial<F> = {}): F => ({ key: "rey", name: "Reychelle", owed: 0, approved: 0, weekdays: 0, out: null, ...p });

    const fresh = rankPool(["kim", "rey"], facts(kim(), rey()));
    c.ok("a new editor with nothing owed gets the next edit over one owing 4 at 2 a day", fresh.pick === "rey", fresh.why);
    c.ok("…at the team's pace, and the reason says so", /Reychelle owes 0 videos at the team's pace \(2 a day/.test(fresh.why));
    const loaded = rankPool(["kim", "rey"], facts(kim(), rey({ owed: 6 })));
    c.ok("once she owes 6 (3.5 days) the edit goes back to Kim (2.5 days)", loaded.pick === "kim", loaded.why);
    const out = rankPool(["kim", "rey"], facts(kim({ owed: 0, out: "Time off until Fri 5:00 PM" }), rey({ owed: 6 })));
    c.ok("someone marked out is passed over while anyone ticked is in", out.pick === "rey" && /out: Time off/.test(out.why), out.why);
    const allOut = rankPool(["kim", "rey"], facts(kim({ owed: 0, out: "Time off" }), rey({ owed: 6, out: "Training" })));
    c.ok("everyone out: by workload anyway, and the reason says so", allOut.pick === "kim" && /Everyone ticked is marked out/.test(allOut.why));
    const tie = rankPool(["rey", "kim"], facts(kim({ owed: 0, approved: 0, weekdays: 0 }), rey()));
    c.ok("a dead tie keeps the order they are listed in", tie.pick === "rey");
    c.ok("one ticked: theirs, said plainly", rankPool(["kim"], facts(kim())).why === "Kim is the only editor ticked for this lane.");
    const none = rankPool([], new Map());
    c.ok("nobody ticked: Needs assigning", none.pick === null && /Needs assigning/.test(none.why));

    // §2 ---------------------------------------------------------------------
    c.head("§2 · onboarding on People → Logins");
    const owner = await prisma.appUser.create({ data: { email: "owner@example.test", name: "Owner Example", role: "OWNER", status: "ACTIVE" } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });

    const badSlack = await users.inviteUser({ email: "reychelle@example.test", name: "Reychelle Example", role: "EDITOR", slackId: "hello" });
    c.ok("a Slack ID that isn't one is refused, and nothing is written", !badSlack.ok && badSlack.outcome === "refused" && /Slack member ID/.test(badSlack.message) && (await prisma.appUser.count({ where: { email: "reychelle@example.test" } })) === 0);
    const badPhone = await users.inviteUser({ email: "reychelle@example.test", name: "Reychelle Example", role: "EDITOR", phone: "12345" });
    c.ok("a phone number that isn't one is refused, and nothing is written", !badPhone.ok && badPhone.outcome === "refused" && (await prisma.appUser.count({ where: { email: "reychelle@example.test" } })) === 0);

    const invited = await users.inviteUser({
      email: "Reychelle@Example.test", name: "Reychelle Example", role: "EDITOR",
      slackId: " u0rey12345 ", phone: "(917) 555-0101", timezone: "Asia/Manila", lanes: ["standardVideo", "premiumVideo"],
    });
    c.ok("the invite as an editor is confirmed with its link", invited.ok && invited.outcome === "confirmed" && !!invited.link, invited.message);
    const card = await prisma.teamMember.findUnique({ where: { email: "reychelle@example.test" } });
    const login = await prisma.appUser.findUnique({ where: { email: "reychelle@example.test" } });
    c.ok("her team card: desk key, Slack ID, phone, clock, editor role", card?.editorKey === "reychelle" && card.slackId === "U0REY12345" && card.phone === "+19175550101" && card.timezone === "Asia/Manila" && card.role === "EDITOR" && card.title === "Video Editor", JSON.stringify(card));
    c.ok("her login is linked to the card and the desk", login?.editorKey === "reychelle" && login.teamMemberId === card?.id);
    c.ok("the receipt says which lanes she takes", /Takes new work on: Standard reels & video, Premium reels/.test(invited.message), invited.message);
    c.ok("…and she is a video editor everywhere the hub asks", isVideoEditorKey("reychelle") && editorMeta("reychelle")?.name === "Reychelle Example" && videoEditorChoices().some((e) => e.key === "reychelle"));
    const pools = await editorPools();
    c.ok("ticked for standard and premium, not personal branding", pools.standardVideo.includes("reychelle") && pools.premiumVideo.includes("reychelle") && !pools.personalBranding.includes("reychelle"), JSON.stringify(pools));
    c.ok("the old single-name routing setting is never written (the deployed code reads it)", (await prisma.appSetting.findUnique({ where: { key: "editor_routing" } })) === null && !!(await prisma.appSetting.findUnique({ where: { key: "editor_pools" } })));

    const dupeUser = await prisma.appUser.create({ data: { email: "someone@example.test", name: "Someone Else", role: "PHOTOGRAPHER", status: "ACTIVE" } });
    const dupe = await users.saveTeammateSetup(dupeUser.id, { slackId: "U0REY12345" });
    c.ok("one Slack account, one person: her ID on someone else is refused", !dupe.ok && dupe.outcome === "refused" && /already on Reychelle Example's card/.test(dupe.message) && (await prisma.teamMember.count({ where: { email: "someone@example.test" } })) === 0);

    // Reychelle's actual case: a login as an editor and no card at all.
    const bare = await prisma.appUser.create({ data: { email: "rey.two@example.test", name: "Reychelle Second", role: "EDITOR", status: "ACTIVE" } });
    const setUp = await users.saveTeammateSetup(bare.id, { lanes: ["personalBranding"] });
    const bareCard = await prisma.teamMember.findUnique({ where: { email: "rey.two@example.test" } });
    c.ok("\"Set up as editor\" on a login with no card makes the card and a free desk key", setUp.ok && bareCard?.editorKey === "reychelle2" && (await prisma.appUser.findUnique({ where: { id: bare.id } }))?.editorKey === "reychelle2", setUp.message);
    c.ok("…on the editors' default clock, with the Slack gap said out loud", bareCard?.timezone === "Asia/Manila" && /No Slack ID yet/.test(setUp.message));

    // Kim: a card that exists without a key takes his built-in one.
    const kimCard = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@example.test", role: "EDITOR" } });
    const kimLogin = await prisma.appUser.create({ data: { email: "kim@example.test", name: "Kim Miguel", role: "EDITOR", status: "ACTIVE", editorKey: "kim", teamMemberId: kimCard.id } });
    const kimSaved = await users.saveTeammateSetup(kimLogin.id, { slackId: "U0KIM00001" });
    const kimAfter = await prisma.teamMember.findUnique({ where: { id: kimCard.id } });
    c.ok("Kim's existing card takes his built-in key, not a new one", kimSaved.ok && kimAfter?.editorKey === "kim" && kimAfter.slackId === "U0KIM00001", kimSaved.message);

    const shooter = await users.inviteUser({ email: "shooter@example.test", name: "Sam Shooter", role: "PHOTOGRAPHER", phone: "+44 7700 900123" });
    const shooterCard = await prisma.teamMember.findUnique({ where: { email: "shooter@example.test" } });
    c.ok("a photographer invite with a phone gets a card and no editor desk", shooter.ok && shooterCard?.role === "PHOTOGRAPHER" && shooterCard.phone === "+447700900123" && shooterCard.editorKey === null);

    const plain = await users.inviteUser({ email: "plain@example.test", name: "Plain Admin", role: "ADMIN" });
    c.ok("an invite with nothing to put on a card makes no card", plain.ok && (await prisma.teamMember.count({ where: { email: "plain@example.test" } })) === 0);

    // §3 ---------------------------------------------------------------------
    c.head("§3 · the roster and the routing");
    const client = await prisma.client.create({ data: { name: "Routing Drill TEST" }, select: { id: true } });
    const job = (title: string) => prisma.project.create({ data: { clientId: client.id, title }, select: { id: true } });
    const [j1, j2] = [await job("1 Busy St, Testville"), await job("2 Busy St, Testville")];
    for (const j of [j1, j2]) {
      await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit the video", status: "OPEN", assignedKey: "john", projectId: j.id } });
    }
    await ensureEditorRoster({ force: true });
    const rules = await editorRouting({ fresh: true });
    c.ok("a shared lane goes to whoever owes less: John owes 2, Reychelle 0", rules.standardVideo === "reychelle" && /Reychelle Example gets it: Reychelle Example owes 0 videos/.test(rules.why.standardVideo), rules.why.standardVideo);
    c.ok("a lane with one editor ticked is theirs", rules.personalBranding === "reychelle2" && rules.why.personalBranding === "Reychelle Second is the only editor ticked for this lane.");
    c.ok("a job already with an editor in the pool stays with them", keepOrRoute("john", "standardVideo", rules, rules.standardVideo) === "john");
    c.ok("a job with an editor no longer ticked for the lane is routed again", keepOrRoute("kim", "standardVideo", rules, rules.standardVideo) === "reychelle");

    await prisma.teamMember.update({ where: { id: card!.id }, data: { active: false } });
    await ensureEditorRoster({ force: true });
    const after = await editorRouting({ fresh: true });
    c.ok("an editor whose card is switched off drops out of every lane", !after.pools.standardVideo.includes("reychelle") && after.standardVideo === "john" && !isVideoEditorKey("reychelle") && isVideoEditorKey("reychelle", { includeDeparted: true }), JSON.stringify(after.pools));

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
