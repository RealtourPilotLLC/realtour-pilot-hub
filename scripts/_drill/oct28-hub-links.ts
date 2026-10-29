// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Oct 28 2026: HUB PAGES ON MESSAGES (Jordan: "let users add hub pages to
// messages so that when you send a message, it links to a hub job, note,
// editor brief, or whatever we choose ... only pages that are authorized for
// everyone should be shareable"). The pasted-link reader, the picker (offers
// only pages EVERY reader of the conversation can open), the send-time refusal
// that names who can't, and the render-time check (a page the viewer can no
// longer open keeps its title and loses its link). Isolated PGlite database,
// AUTH_ENFORCE on; nothing leaves (fenceFetch).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5646), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct28-hub-links-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { parseHubUrl, sanitizeLinkTargets, hubLinkPath } = await import("@/lib/hubLinks");
    const { checkHubLinks, searchShareableLinks, conversationReaders, canOpenHubLink, hubLinkTitle, hubLinkViews } = await import("@/lib/hubLinkAccess");
    const { postTeamChannelMessage, searchHubPages, checkHubPage } = await import("@/app/projects/teamChannelActions");
    const { postProjectMessage } = await import("@/app/projects/messageActions");
    const { loadTeamChannel } = await import("@/lib/teamChannel");
    const { loadThread } = await import("@/components/comms/TeamMessagesPanel");
    const { MessageAttachments } = await import("@/components/project/ProjectMessages");

    const tm = (name: string, email: string, role: "ADMIN" | "EDITOR" | "PHOTOGRAPHER") => prisma.teamMember.create({ data: { name, email, role } });
    const jordanTm = await tm("Jordan Spackman", "jordan-tm-links@example.test", "ADMIN");
    const kyleTm = await tm("Kyle Smith", "kyle-tm-links@example.test", "ADMIN");
    const jamesTm = await tm("James Hart", "james-tm-links@example.test", "PHOTOGRAPHER");
    const kimTm = await tm("Kim Miguel", "kim-tm-links@example.test", "EDITOR");
    const johnTm = await tm("John Mark", "john-tm-links@example.test", "EDITOR");
    const harrisonTm = await tm("Harrison Lee", "harrison-tm-links@example.test", "PHOTOGRAPHER");
    const login = (email: string, name: string, role: string, extra: { teamMemberId?: string; editorKey?: string } = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", ...extra } });
    const jordan = await login("jordan-links@example.test", "Jordan Spackman", "OWNER", { teamMemberId: jordanTm.id });
    const kyle = await login("kyle-links@example.test", "Kyle Smith", "ADMIN", { teamMemberId: kyleTm.id });
    const james = await login("james-links@example.test", "James Hart", "CREATIVE_MANAGER", { teamMemberId: jamesTm.id });
    const kim = await login("kim-links@example.test", "Kim Miguel", "EDITOR", { teamMemberId: kimTm.id, editorKey: "kim" });
    const john = await login("john-links@example.test", "John Mark", "EDITOR", { teamMemberId: johnTm.id, editorKey: "john" });
    const harrison = await login("harrison-links@example.test", "Harrison Lee", "PHOTOGRAPHER", { teamMemberId: harrisonTm.id });
    // A login that's switched off reads nothing and blocks nothing.
    await prisma.appUser.create({ data: { email: "gone-links@example.test", name: "Gone Person", role: "EDITOR", editorKey: "remar", status: "DISABLED" } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, actingAs });
    const as = async (u: { id: string; email: string; role: string }) => { await signIn(u); return (await getCurrentUser())!; };

    const client = await prisma.client.create({ data: { name: "Lakeview Realty TEST" } });
    // 825 State St: Kim edits it, James shot it. Its thread is read by the
    // owner, the office, the creative manager and Kim.
    const p1 = await prisma.project.create({ data: { clientId: client.id, title: "825 State St, Media PA 19063", addressLine: "825 State St", status: "EDITING", editorId: kimTm.id, photographerId: jamesTm.id } });
    // 17 Pine Rd: Harrison shot it, Kim edits it.
    const p2 = await prisma.project.create({ data: { clientId: client.id, title: "17 Pine Rd, Media PA", addressLine: "17 Pine Rd", status: "EDITING", editorId: kimTm.id, photographerId: harrisonTm.id } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: p1.id, fileName: "Main reel.mp4", round: 2, status: "PENDING" } });
    const photoJob = await prisma.photoJob.create({ data: { projectId: p1.id } });
    const TEAM = { kind: "team" } as const;
    const P1 = { kind: "project", projectId: p1.id } as const;

    c.head("1 · a pasted hub link");
    const parsed = (s: string) => JSON.stringify(parseHubUrl(s));
    c.ok("an editor brief link", parsed(`https://hub.realtourpilot.com/edit/${p1.id}`) === JSON.stringify({ kind: "edit", id: p1.id }));
    c.ok("a job file, a shoot screen, a client file, an upload page (path or full link)",
      parsed(`/projects/${p1.id}`) === JSON.stringify({ kind: "project", id: p1.id }) &&
      parsed(`hub.realtourpilot.com/shoot/${p1.id}`) === JSON.stringify({ kind: "shoot", id: p1.id }) &&
      parsed(`https://hub.realtourpilot.com/clients/${client.id}/`) === JSON.stringify({ kind: "client", id: client.id }) &&
      parsed(`http://localhost:3000/upload/${p1.id}`) === JSON.stringify({ kind: "upload", id: p1.id }));
    c.ok("a Review Room cut keeps its cut", parsed(`https://hub.realtourpilot.com/review/${p1.id}?cut=${cut.id}`) === JSON.stringify({ kind: "review", id: p1.id, cut: cut.id }));
    c.ok("a photo delivery, and a menu page", parsed(`/ops/photo-delivery/${photoJob.id}`) === JSON.stringify({ kind: "photos", id: photoJob.id }) && parsed("https://hub.realtourpilot.com/sales") === JSON.stringify({ kind: "page", id: "sales" }));
    const notHub = parseHubUrl(`https://evil.example.com/edit/${p1.id}`);
    c.ok("another site's link is refused in plain words", "error" in notHub && notHub.error.startsWith("Paste a link to a hub page"));
    const notLinkable = parseHubUrl("https://hub.realtourpilot.com/api/messages/file/abcdefgh");
    c.ok("a hub address that isn't a page is refused", "error" in notLinkable && /can't be added to a message/.test(notLinkable.error));
    c.ok("titles a composer sends are dropped; the server writes them", JSON.stringify(sanitizeLinkTargets([{ kind: "edit", id: p1.id, title: "$4,500 invoice" }, { kind: "bogus", id: "x" }, { kind: "page", id: "nope" }])) === JSON.stringify([{ kind: "edit", id: p1.id }]));

    c.head("2 · card titles come from the hub's records, never an amount");
    c.ok("825 State St · Editor brief", (await hubLinkTitle({ kind: "edit", id: p1.id })) === "825 State St · Editor brief");
    c.ok("a cut names its video and version", (await hubLinkTitle({ kind: "review", id: p1.id, cut: cut.id })) === "825 State St · Video review (Main reel, v2)");
    c.ok("photo delivery, client file, menu page", (await hubLinkTitle({ kind: "photos", id: photoJob.id })) === "825 State St · Photo delivery" && (await hubLinkTitle({ kind: "client", id: client.id })) === "Lakeview Realty TEST · Client file" && (await hubLinkTitle({ kind: "page", id: "training" })) === "Training");
    c.ok("a page whose record is gone has no title", (await hubLinkTitle({ kind: "edit", id: "cknotarealproject000001" })) === null);

    c.head("3 · who reads each conversation");
    const teamReaders = await conversationReaders(TEAM);
    const p1Readers = await conversationReaders(P1);
    c.ok("the team channel: every active login, never a switched-off one", teamReaders.length === 6 && !teamReaders.some((v) => v.email.startsWith("gone")));
    c.ok("825 State St's thread: owner, office, creative manager and its editor, not other editors or photographers", JSON.stringify(p1Readers.map((v) => v.name).sort()) === JSON.stringify(["James Hart", "Jordan Spackman", "Kim Miguel", "Kyle Smith"]));

    c.head("4 · the send-time check refuses by name");
    const sales = await checkHubLinks(TEAM, [{ kind: "page", id: "sales" }]);
    c.ok("Finance in the team channel: refused, naming who can't", !sales.ok && sales.message === "Kim, John and 3 others can't open Finance pages. Remove that page to send.", sales.ok ? "allowed" : sales.message);
    const salesJob = await checkHubLinks(P1, [{ kind: "page", id: "sales" }]);
    c.ok("Finance in 825 State St's thread: Kim, James and Kyle can't", !salesJob.ok && salesJob.message === "Kim, James and Kyle can't open Finance pages. Remove that page to send.", salesJob.ok ? "allowed" : salesJob.message);
    const jobFile = await checkHubLinks(P1, [{ kind: "project", id: p1.id }]);
    c.ok("the job file in its own thread: Kim can't open it", !jobFile.ok && jobFile.message === "Kim can't open “825 State St · Job file”. Remove that page to send.", jobFile.ok ? "allowed" : jobFile.message);
    const brief = await checkHubLinks(P1, [{ kind: "edit", id: p1.id }]);
    c.ok("the editor brief in its own thread: everyone there can open it", brief.ok && brief.refs[0]?.title === "825 State St · Editor brief");
    const briefTeam = await checkHubLinks(TEAM, [{ kind: "edit", id: p1.id }]);
    c.ok("the same brief in the team channel: refused (John and Harrison can't)", !briefTeam.ok && /John and Harrison can't open “825 State St · Editor brief”/.test(briefTeam.message), briefTeam.ok ? "allowed" : briefTeam.message);
    c.ok("a training page in the team channel: allowed", (await checkHubLinks(TEAM, [{ kind: "page", id: "training" }])).ok);
    // Eight asked, six once the repeats go: still one too many.
    const asked: import("@/lib/hubLinks").HubLinkTarget[] = [
      ...["training", "resources", "assistant", "editing", "training", "resources"].map((id) => ({ kind: "page" as const, id })),
      { kind: "edit", id: p1.id },
      { kind: "edit", id: p2.id },
    ];
    const tooMany = await checkHubLinks(TEAM, asked);
    c.ok("more than five pages on a message: refused", !tooMany.ok && /up to 5 pages/.test(tooMany.message));
    const gone = await checkHubLinks(TEAM, [{ kind: "edit", id: "cknotarealproject000001" }]);
    c.ok("a page that no longer exists: refused", !gone.ok && /no longer exists/.test(gone.message));

    c.head("5 · the picker offers only what everyone can open");
    const everyOffer = async (search: Awaited<ReturnType<typeof searchShareableLinks>>, readers: typeof teamReaders) => {
      for (const o of search.offered) for (const v of readers) if (!(await canOpenHubLink(v, o))) return `${v.name} can't open ${o.title}`;
      return true;
    };
    const teamMenu = await searchShareableLinks(TEAM, "");
    const teamKeys = teamMenu.offered.map((o) => o.id).sort();
    c.ok("team channel, no search: the menu pages every login has", JSON.stringify(teamKeys) === JSON.stringify(["assistant", "editing", "resources", "training"]), teamKeys.join(","));
    c.ok("every page offered passes for every reader", (await everyOffer(teamMenu, teamReaders)) === true);
    const financeSearch = await searchShareableLinks(TEAM, "Finance");
    c.ok("searching Finance: not offered, and the picker says who can't open it", financeSearch.offered.length === 0 && financeSearch.hidden.some((h) => h.title === "Finance" && h.why === "Kim, John and 3 others can't open it"));
    const streetSearch = await searchShareableLinks(TEAM, "825 State");
    c.ok("searching an address in the team channel: no job page offered (editors and photographers can't all open them), each listed as hidden",
      !streetSearch.offered.some((o) => o.kind !== "page") && streetSearch.hidden.some((h) => h.title === "825 State St · Editor brief"));
    const ownThread = await searchShareableLinks(P1, "");
    const ownOffered = ownThread.offered.map((o) => `${o.group}|${o.kind}`);
    c.ok("the job's own thread: its editor brief first, under This job", ownThread.offered[0]?.kind === "edit" && ownThread.offered[0]?.group === "This job" && ownThread.offered[0]?.href === `/edit/${p1.id}`, ownOffered.join(" "));
    c.ok("not its job file, shoot screen, review or client file (Kim can't open them), shown as hidden with why",
      !ownThread.offered.some((o) => ["project", "shoot", "review", "client", "upload"].includes(o.kind)) && ownThread.hidden.some((h) => h.title === "825 State St · Job file" && h.why === "Kim can't open it"));
    c.ok("the photo delivery is offered there only if all four can open it (Kim can't)", !ownThread.offered.some((o) => o.kind === "photos"));
    c.ok("every page offered in the job thread passes for its four readers", ownThread.readers === 4 && (await everyOffer(ownThread, p1Readers)) === true);
    await signIn(kim);
    const kimPicks = await searchHubPages("team", "train");
    c.ok("the picker action answers Kim the same way", kimPicks.offered.length === 1 && kimPicks.offered[0].id === "training");
    await signIn(john);
    let johnBlocked = false;
    try { await searchHubPages(`project:${p1.id}`, ""); } catch (e) { johnBlocked = e instanceof Error && /conversations you are in/.test(e.message); }
    c.ok("John can't search pages for a thread he can't read", johnBlocked);
    await signIn(harrison);
    const pasteSales = await checkHubPage("team", "https://hub.realtourpilot.com/sales");
    const pasteTraining = await checkHubPage("team", "hub.realtourpilot.com/training");
    c.ok("pasting Finance into the team channel: refused by name", !pasteSales.ok && /can't open Finance pages/.test(pasteSales.message));
    c.ok("pasting Training: a card ready to send", pasteTraining.ok && pasteTraining.link.title === "Training" && pasteTraining.link.href === "/training");

    c.head("6 · the server refuses on send, whatever the composer sent");
    await signIn(jordan);
    const before = await prisma.teamChannelMessage.count();
    const sendSales = await postTeamChannelMessage("Numbers are in", [], null, { links: [{ kind: "page", id: "sales" }] });
    c.ok("Jordan sending Finance to the team channel: refused, nothing saved", !sendSales.ok && /can't open Finance pages/.test(sendSales.message) && (await prisma.teamChannelMessage.count()) === before);
    const sendTraining = await postTeamChannelMessage("New SOP is up", [], null, { links: [{ kind: "page", id: "training", title: "$900 bonus" }] });
    const trainingMsg = await prisma.teamChannelMessage.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    c.ok("a page everyone can open sends, titled by the hub (the sent title ignored)", sendTraining.ok && trainingMsg.links === JSON.stringify([{ kind: "page", id: "training", title: "Training" }]), trainingMsg.links ?? "");
    const jobRefused = await postProjectMessage(p1.id, null, "See the job file", [], null, { links: [{ kind: "project", id: p1.id }] });
    c.ok("the job file on its own thread: refused with Kim's name", !jobRefused.ok && jobRefused.message === "Kim can't open “825 State St · Job file”. Remove that page to send.");
    await signIn(kim);
    const briefSent = await postProjectMessage(p1.id, null, "", [], null, { links: [{ kind: "edit", id: p1.id }] });
    const briefMsg = await prisma.projectMessage.findFirstOrThrow({ where: { projectId: p1.id }, orderBy: { createdAt: "desc" } });
    c.ok("a page alone (no words) sends on the job thread", briefSent.ok && briefMsg.body === "" && (briefMsg.links ?? "").includes("825 State St · Editor brief"), briefSent.message);

    c.head("7 · the render-time check");
    const kimMe = await as(kim);
    const kimThread = await loadThread(p1.id, kimMe);
    c.ok("Kim sees the brief card with its link", kimThread.at(-1)?.links?.[0]?.href === `/edit/${p1.id}` && kimThread.at(-1)?.links?.[0]?.title === "825 State St · Editor brief");
    // The job moves to John. Kim still reads the thread (she spoke on it) but
    // the brief is no longer hers to open.
    await prisma.project.update({ where: { id: p1.id }, data: { editorId: johnTm.id } });
    const kimAfter = await loadThread(p1.id, await as(kim));
    c.ok("after the job moves to John, Kim's card keeps its title and loses its link", kimAfter.at(-1)?.links?.[0]?.href === null && kimAfter.at(-1)?.links?.[0]?.title === "825 State St · Editor brief");
    const jordanAfter = await loadThread(p1.id, await as(jordan));
    c.ok("Jordan's card still opens", jordanAfter.at(-1)?.links?.[0]?.href === `/edit/${p1.id}`);
    await prisma.appUser.update({ where: { id: harrison.id }, data: { permissions: JSON.stringify({ training: false }) } });
    const harrisonChannel = await loadTeamChannel(await as(harrison));
    const kimChannel = await loadTeamChannel(await as(kim));
    c.ok("a per-person switch turned off: Harrison's Training card has no link, Kim's does", harrisonChannel.at(-1)?.links?.[0]?.href === null && kimChannel.at(-1)?.links?.[0]?.href === "/training");
    const views = await hubLinkViews([{ kind: "edit", id: p1.id, title: "825 State St · Editor brief" }], null);
    c.ok("signed out: no link", views[0].href === null);
    const lockedHtml = renderToStaticMarkup(createElement(MessageAttachments, { files: [], links: [{ title: "825 State St · Editor brief", href: null, kind: "edit" }] }));
    const openHtml = renderToStaticMarkup(createElement(MessageAttachments, { files: [], links: [{ title: "825 State St · Editor brief", href: hubLinkPath({ kind: "edit", id: p1.id }), kind: "edit" }] }));
    c.ok("a locked card draws the title, \"Not open to you\", and no link", lockedHtml.includes("825 State St · Editor brief") && lockedHtml.includes("Not open to you") && !lockedHtml.includes("<a "));
    c.ok("an open card is a link to the page", openHtml.includes(`href="/edit/${p1.id}"`) && openHtml.includes("825 State St · Editor brief"));

    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
    void james;
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
