// @drill-run: engine=postgres conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL OCT16-VIDEO-REPEATS — the repeating video problems from #video-editing
// and Jordan's DMs with Kyle, fixed at the source (Oct 16 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct16-video-repeats.ts --logs /private/tmp/oct16-repeats
//
//   §1 Spell these exactly (lib/spellList): names from the client, the address,
//      past corrections (never a caption's grammar fix), the script's proper
//      nouns (never a label, a sentence start or a Title Case hook), the house
//      list of local names
//   §2 the listing flow line, the music rule (licensed over 60 s or for
//      YouTube/MLS, trending for short social reels), the capture shape
//   §3 the final check names this video's own words; its key, labels and
//      server validation are unchanged
//   §4 a logo the notes ask for, and the shoot screen's capture lines
//   §5 the SHIPPED /edit/<id> page, as the editor: the spell box, the flow
//      line, licensed music, the end card says Kyle has been asked, the keep
//      the raws line, the final check's words; Kyle's task raised once, never
//      from a "view as" preview; the file he attaches is named
//   §6 the shoot data carries each video's shape
// Disposable Postgres on 127.0.0.1:6541; every outbound call is fenced.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

const DB_PORT = Number(process.env.DRILL_PORT ?? 6541);
const c = makeChecker();
installNextStubs();
const cjs = createRequire(__filename);
const nav = cjs("next/navigation") as Record<string, unknown>;
nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} });
nav.usePathname = () => "/edit/x";
nav.useSearchParams = () => new URLSearchParams();
nav.useParams = () => ({});
const fence = fenceFetch();

type Props = Record<string, unknown>;
async function resolveTree(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement<Props>(node)) return node;
  const type = node.type as unknown;
  if (typeof type === "function" && (type as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
    return resolveTree(await (type as (p: Props) => Promise<unknown>)(node.props));
  }
  const next: Props = {};
  let changed = false;
  for (const [k, v] of Object.entries(node.props)) {
    if (k === "children" || isValidElement(v) || Array.isArray(v)) {
      next[k] = await resolveTree(v);
      changed = true;
    }
  }
  return changed ? cloneElement(node, next) : node;
}
/** Every element in a resolved tree, with its component name and props. */
function elements(tree: unknown): { name: string; props: Props }[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const name = typeof type === "string" ? type : type?.name ?? "";
  return [{ name, props: tree.props }, ...Object.values(tree.props).flatMap(elements)];
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
function block(html: string, open: RegExp): string {
  const m = open.exec(html);
  if (!m) return "";
  const start = m[0].startsWith("<") ? m.index : html.lastIndexOf("<", m.index);
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))?.[1];
  if (!tag) return "";
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let t = re.exec(html); t; t = re.exec(html)) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index + t[0].length);
  }
  return html.slice(start);
}
const EM_DASH = "—";

async function main() {
  const db = await bootDrillDb({ port: DB_PORT, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: "oct16-video-repeats-isolated-secret" } });
  try {
    const sp = await import("@/lib/spellList");
    const vs = await import("@/lib/videoStyles");
    const sc = await import("@/lib/selfCheck");
    const { notesAskForLogo, LOGO_ASK_SLUG, ensureLogoAsk } = await import("@/lib/logoAsk");
    const { captureGuideFor } = await import("@/components/shoot/ShootScreen");

    // =======================================================================
    c.head("§1 · Spell these exactly");
    // =======================================================================
    // The hub's own review notes (Oct 16 probe): caption grammar, word swaps, a homophone.
    const GRAMMAR = [
      "Baths —> Bath", "“Easier” is the wrong word here. Should be “Know” Easier -> Know", "Typo: clothes —> Close", "“Stress” not “Stressed”",
      "“Shed” instead of “Had”", "“Your” instead of “you’re”", "The —> be", "“Thing” should be “Things” Thing -> Things", "Results --> Result",
      "\"Can\" should be \"Can't\" here", "Small typo - spasso", "work --> \"worked\"", "Videos --> \"video\"", "buyer --> \"buyer's\"",
    ];
    const grammarLeaks = GRAMMAR.flatMap((n) => sp.correctionsIn(n).filter((x) => sp.isNameCorrection(x)).map((x) => `${n} => ${x.right}`));
    c.ok("a caption's grammar or word swap is never a name to spell (14 real notes)", grammarLeaks.length === 0, grammarLeaks.join(" | "));
    const one = (n: string) => sp.correctionsIn(n).find((x) => sp.isNameCorrection(x)) ?? null;
    c.ok("\"Hey Erica → Erika\": Erika, not Erica", one("Hey Erica → Erika")?.right === "Erika" && one("Hey Erica → Erika")?.wrong === "Erica", JSON.stringify(one("Hey Erica → Erika")));
    c.ok("\"Westchester should be two words\": West Chester, from the house list", one("Westchester should be two words")?.right === "West Chester" && one("Westchester should be two words")?.kind === "spacing");
    c.ok("\"Okehocking is spelled wrong\" and it's spelled \"Ridley\"", one("Okehocking is spelled wrong")?.right === "Okehocking" && one("it's spelled \"Ridley\"")?.right === "Ridley");
    c.ok("\"Chester Brook should be one word\" → Chesterbrook; \"Leola, not Liola\" → Leola", one("Chester Brook should be one word")?.right === "Chesterbrook" && one("Leola, not Liola")?.right === "Leola" && one("Leola, not Liola")?.wrong === "Liola");

    const SCRIPT = [
      "Why buyers love West Chester",
      "Category: Market Authority",
      "Hook: 3 Things Every Buyer Should Know About Chester County",
      "Talking Point 1 (Re-hook): On Saturday I toured Okehocking Preserve with the Smiths.",
      "Talking Point 2 (Build-up): Homes near St. Davids Golf Club and Bank of America sell fast in Chester County's best schools.",
      "Close / Call to action: Planning to move? Call me, Erika Walker with Keller Williams.",
      "Caption CTA: DM me WESTCHESTER for the guide",
    ].join("\n");
    const nouns = sp.properNounsIn(SCRIPT);
    c.ok("the script's names: mid-sentence names, a possessive trimmed, abbreviations kept whole", ["West Chester", "Okehocking Preserve", "Smiths", "St. Davids Golf Club", "Bank of America", "Chester County", "Erika Walker", "Keller Williams"].every((n) => nouns.includes(n)), nouns.join(" · "));
    c.ok("…never a section label, a category, a day, a sentence start or a Title Case hook", !nouns.some((n) => /Market Authority|Talking Point|Category|Saturday|Planning|Things|Buyer|Close|Caption|Homes|Hook|WESTCHESTER/.test(n)), nouns.join(" · "));

    const list = sp.buildSpellList({
      clientName: "Erika Walker", brokerage: "Keller Williams", team: "The Walker Team",
      street: "412 Okehocking Ln", town: "West Chester",
      script: "Hi, I'm Erika Walker. Buyers love Westchester. Call The Walker Team at Keller Williams.",
      corrections: ["Hey Erica → Erika", "Westchester → West Chester", "Baths —> Bath", "Leola, not Liola"],
      context: ["Order note: show the barn, then the chest to broke trail"],
    });
    const words = list.entries.map(sp.spellWords);
    c.ok("in order: the client, brokerage, team, then the street and town", JSON.stringify(list.entries.slice(0, 5).map((e) => e.from)) === JSON.stringify(["client", "client", "client", "address", "address"]), JSON.stringify(list.entries.map((e) => e.from)));
    c.ok("a past correction lands on the name it corrects: Erika Walker (not Erica)", words.includes("Erika Walker (not Erica)"), words.join(" | "));
    c.ok("the town carries the house note and the wrong form seen: West Chester (two words, never Westchester)", words.includes("West Chester (two words, never Westchester)"), words.join(" | "));
    c.ok("a past correction on another name is its own entry: Leola (not Liola), said once", words.includes("Leola (not Liola)") && count(words.join("|"), "Liola") === 1);
    c.ok("a mangled house name in the order note promotes it: Chesterbrook (one word, never chest to broke)", words.includes("Chesterbrook (one word, never chest to broke)"), words.join(" | "));
    c.ok("the script's wrong form (\"Westchester\") and names already said are not listed again; a grammar fix never is", !words.some((w) => /^Westchester|^Walker Team|^Bath\b/.test(w)) && count(words.join("|"), "Keller Williams") === 1, words.join(" | "));
    c.ok("the house names this job never mentions stay on the compact line", list.house.map((h) => h.name).join(",") === "Manheim Township,Ridley", list.house.map((h) => h.name).join(","));
    c.ok("the house list holds the six local names from the research", ["West Chester", "Chesterbrook", "Okehocking", "Manheim Township", "Ridley", "Leola"].every((n) => sp.HOUSE_SPELLINGS.some((h) => h.name === n)));
    const long = sp.buildSpellList({ clientName: "A Name", script: Array.from({ length: 12 }, (_, i) => `We met ${["Alder", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo", "Hazel", "Ironwood", "Juniper", "Kapok", "Larch"][i]} Smithers today.`).join(" ") });
    c.ok("the final check's line names the first eight and says how many more are on the brief", /, and \d+ more on the brief$/.test(sp.spellLine(long) ?? ""), sp.spellLine(long) ?? "");
    c.ok("a listing title gives its street and town; a session title gives neither", sp.streetOf("415 Oak Street, Wayne, PA 19087") === "415 Oak Street" && sp.townOf("415 Oak Street, Wayne, PA 19087") === "Wayne" && sp.streetOf("Dana Maple — October content session") === null && sp.townOf("Dana Maple — October content session") === null);

    // =======================================================================
    c.head("§2 · the listing flow, the music rule, the capture shape");
    // =======================================================================
    const LISTING = ["standard_reel", "standard_reel_agent_intro", "standard_cinematic", "premium_social_reel", "premium_cinematic"];
    c.ok("every listing style gets the one Listing flow line", LISTING.every((k) => vs.listingFlowFor(k) === vs.LISTING_FLOW));
    c.ok("…a personal-branding or monthly video does not", vs.listingFlowFor("personal_branding") === null && vs.listingFlowFor("premium_social_reel", { monthly: true }) === null && vs.listingFlowFor(null) === null);
    c.ok("the line says it all: front exterior, inside within 5 seconds, basement last, never end ugly, every named room, ramps land on the room",
      ["front exterior", "inside within 5 seconds", "basement last", "Never end on an unfinished or unflattering space", "every room named in the order notes", "Speed ramps land on the whole room"].every((x) => vs.LISTING_FLOW.includes(x)) && !vs.LISTING_FLOW.includes(EM_DASH));
    c.ok("lengths read off a spec: 90 s, 30–60 s, 45-50 seconds, 2 min, 1:30; an aspect ratio is not a length",
      vs.longestSecondsIn("90 s") === 90 && vs.longestSecondsIn("30–60 s") === 60 && vs.longestSecondsIn("45-50 seconds") === 50 && vs.longestSecondsIn("2 min") === 120 && vs.longestSecondsIn("1:30 max") === 90 && vs.longestSecondsIn("9:16 vertical · 1080×1920") === null);
    const rule = (styleKey: string, specs: string[], monthly = false) => vs.musicRuleFor({ styleKey, monthly, specs });
    c.ok("short social reels keep trending audio (a monthly branding reel at 30–60 s, a standard listing reel)", !rule("personal_branding", [vs.PERSONAL_BRANDING_MAKE_THIS], true).licensed && !rule("standard_reel", [vs.defaultMakeThis("standard_reel")]).licensed);
    c.ok("a horizontal listing video is licensed music only (YouTube and the MLS)", rule("standard_cinematic", [vs.defaultMakeThis("standard_cinematic")]).licensed && rule("premium_cinematic", []).licensed);
    c.ok("anything over 60 seconds, or meant for YouTube or the MLS, is licensed too", rule("premium_social_reel", ["9:16 · 90 s"]).why === "it runs over 60 seconds" && rule("personal_branding", ["16:9 horizontal for YouTube · 1920×1080"], true).why === "it's for YouTube or the MLS");
    c.ok("the shoot shape follows the pinned style, else the type",
      vs.captureShape({ type: "VIDEO", videoStyle: "standard_cinematic" }) === "horizontal" && vs.captureShape({ type: "VIDEO", videoStyle: "personal_branding" }) === "vertical" &&
      vs.captureShape({ type: "VIDEO", videoStyle: "standard_reel_agent_intro" }) === "vertical" && vs.captureShape({ type: "VIDEO" }) === "horizontal" && vs.captureShape({ type: "SOCIAL_REEL" }) === "vertical" && vs.captureShape({ type: "DRONE" }) === null);

    // =======================================================================
    c.head("§3 · the final check names this video's own words");
    // =======================================================================
    const profile = sc.resolveSelfCheckProfile("standard_cinematic");
    const decorated = sc.withVideoFacts(profile, { spell: "Erika Walker (not Erica), West Chester (two words)", endCard: "Logo: their logo, walker-logo.png." });
    const help = (p: typeof profile, k: string) => p.items.find((i) => i.key === k)?.help ?? "";
    c.ok("the captions line names the list; the brand line names the file", help(decorated, "captions_text").includes("Erika Walker (not Erica), West Chester (two words)") && help(decorated, "brand_assets").includes("walker-logo.png"), help(decorated, "captions_text"));
    c.ok("only the help changes: the same key, the same labels, the other lines untouched",
      decorated.checklistKey === profile.checklistKey && JSON.stringify(decorated.items.map((i) => i.label)) === JSON.stringify(profile.items.map((i) => i.label)) &&
      decorated.items.filter((i) => !["captions_text", "brand_assets"].includes(i.key)).every((i) => i.help === profile.items.find((x) => x.key === i.key)?.help));
    const ctx = { isRevision: false, openIssueIds: [] as string[] };
    const allYes = Object.fromEntries(sc.itemsFor(profile, ctx).map((i) => [i.key, { answer: "YES" as const }]));
    c.ok("the server's validation takes the same answers either way", sc.validateSelfCheck(profile, { checklistKey: decorated.checklistKey, answers: allYes }, ctx).ok && sc.validateSelfCheck(decorated, { checklistKey: profile.checklistKey, answers: allYes }, ctx).ok);
    c.ok("no facts, no change; the new words carry no em dash", sc.withVideoFacts(profile, null) === profile && sc.withVideoFacts(profile, {}) === profile && !help(decorated, "captions_text").includes(EM_DASH) && !help(decorated, "brand_assets").includes(EM_DASH));

    // =======================================================================
    c.head("§4 · a logo the notes ask for; the shoot screen's capture lines");
    // =======================================================================
    c.ok("asks: \"Use his logo on every video\", \"Always add her animated logo at the end\", \"end card with her phone number\"", notesAskForLogo(["Use his logo on every video."]) && notesAskForLogo(["Brand colors: #FF0000\nAlways add her animated logo at the end."]) && notesAskForLogo(["Put an end card with her phone number"]));
    c.ok("never an ask: \"No logo on this one please\", \"don't add the end card\", nothing at all", !notesAskForLogo(["No logo on this one please."]) && !notesAskForLogo(["Please don't add the end card"]) && !notesAskForLogo([null, "", "Calm, confident edits."]));
    const video = captureGuideFor({ type: "VIDEO", shape: "horizontal" }, {});
    const reel = captureGuideFor({ type: "SOCIAL_REEL", shape: "vertical" }, {});
    c.ok("the video line leads with \"Horizontal 16:9 only, never vertical\"; the reel line with \"Vertical 9:16\"", video.startsWith("Horizontal 16:9 only, never vertical.") && reel.startsWith("Vertical 9:16.") && !video.includes(EM_DASH) && !reel.includes(EM_DASH), `${video} | ${reel}`);
    c.ok("a reel sold as a VIDEO is still filmed vertical", captureGuideFor({ type: "VIDEO", shape: "vertical" }, {}).startsWith("Vertical 9:16."));
    c.ok("drone with a video booked: \"Grab 2–3 drone video clips while it's up\"; drone alone or a content session: not", captureGuideFor({ type: "DRONE" }, { videoBooked: true }).includes("Grab 2–3 drone video clips while it’s up.") && !captureGuideFor({ type: "DRONE" }, {}).includes("drone video clips") && !captureGuideFor({ type: "DRONE" }, { videoBooked: true, contentSession: true }).includes("drone video clips"));
    c.ok("a content session keeps its topic words", captureGuideFor({ type: "VIDEO", shape: "vertical" }, { contentSession: true }).startsWith("Every topic on the session card"));

    // =======================================================================
    c.head("§5 · the editor's brief, as John Mark reads it");
    // =======================================================================
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
    const { assetKeys, attachAssetReference } = await import("@/lib/assetDependencies");
    const { checkContextsForProject } = await import("@/lib/selfCheckStore");
    const { default: page } = await import("@/app/edit/[id]/page");
    const people: Record<string, { id: string; email: string; role: string; teamMemberId: string }> = {};
    for (const [name, role, editorKey] of [["Jordan", "OWNER", null], ["Kyle", "ADMIN", null], ["John", "EDITOR", "john"]] as const) {
      const email = `${name.toLowerCase()}-oct16repeats@example.test`;
      const member = await prisma.teamMember.create({ data: { name: name === "John" ? "John Mark" : name, email, role: role === "EDITOR" ? "EDITOR" : "MANAGER", active: true } });
      const user = await prisma.appUser.create({ data: { name, email, role, editorKey, teamMemberId: member.id, status: "ACTIVE" } });
      people[name] = { id: user.id, email, role, teamMemberId: member.id };
    }
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: people.Kyle.teamMemberId, backupReviewerTeamMemberId: people.Kyle.teamMemberId }) } });
    const as = (name: string, actingAs?: string) => setSession({ uid: people[name].id, email: people[name].email, role: people[name].role, ...(actingAs ? { actingAs } : {}) });
    const yesterday = new Date(Date.now() - 864e5);
    const due = new Date(Date.now() + 3 * 864e5);

    const erika = await prisma.client.create({ data: { name: "Erika Walker", company: "Keller Williams", aryeoTeamName: "The Walker Team", segment: "regular", autoConfirmationText: false, autoDeliveryText: false, generalNotes: "Please put her logo end card on every video." } });
    // Her earlier video: what came back on it.
    const old = await prisma.project.create({ data: { clientId: erika.id, title: "9 Birch Rd, West Chester, PA 19380", status: "DELIVERED", source: "MANUAL", shootDate: new Date(Date.now() - 30 * 864e5), deliveredAt: new Date(Date.now() - 20 * 864e5) } });
    for (const body of ["Westchester → West Chester", "Hey Erica → Erika", "Baths —> Bath"]) {
      await prisma.mediaNote.create({ data: { projectId: old.id, assetUrl: "/api/review/cut/old/stream", assetType: "video", lane: "EDITOR", editorKey: "john", kind: "fix", body, authorName: "Kyle" } });
    }
    await prisma.revisionIssue.create({ data: { projectId: old.id, sourceKind: "MANUAL", sourceId: "oct16-drill-1", originalText: "Okehocking is spelled wrong in the captions" } });

    const makeListing = async (title: string, slug: string) => {
      const p = await prisma.project.create({ data: {
        clientId: erika.id, title, city: "West Chester", status: "SHOT", source: "MANUAL", shootDate: yesterday, deliveryDue: due, editorId: people.John.teamMemberId, editorManual: true,
        dropboxFolder: `/isolated/oct16/${slug}`, statusEvidence: JSON.stringify({ dropbox: { rawVideo: 30 } }),
      } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Standard Cinematic Video", productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic", quantity: 1 } });
      await ensureOutputsForProject(p.id);
      const o = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: p.id } });
      await prisma.deliverableOutput.update({ where: { id: o.id }, data: { ownerKey: "john", ownerName: "John Mark", ownerSetAt: yesterday, rawInAt: yesterday, promisedAt: due } });
      await prisma.smartTask.create({ data: { projectId: p.id, clientId: erika.id, taskType: "edit_video", title: `Edit ${title}`, assignedKey: "john", assignedManually: true, status: "OPEN", dedupeKey: `edit-video-${p.id}`, dueAt: due, source: "manual" } });
      return { p, o };
    };
    const { p: listing, o: out } = await makeListing("412 Okehocking Ln, West Chester, PA 19382", "okehocking");
    const view = async (who: string, id: string, actingAs?: string) => {
      await as(who, actingAs);
      const tree = await resolveTree(await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
      const { renderToStaticMarkup } = cjs("react-dom/server") as typeof import("react-dom/server");
      return { html: renderToStaticMarkup(tree as ReactNode), els: elements(tree) };
    };
    const logoKey = assetKeys(listing.id, {}, LOGO_ASK_SLUG).retrieval;
    c.ok("before anyone opens the brief, nothing has been asked", (await prisma.smartTask.count({ where: { dedupeKey: logoKey } })) === 0);

    const john = await view("John", listing.id);
    const article = block(john.html, new RegExp(`<article[^>]*id="brief-${out.id}"`));
    const make = block(article, /data-brief-section="make"/);
    const spellBox = text(block(make, /data-spell-list/));
    c.ok("Spell these exactly sits in What to make", !!spellBox && spellBox.includes("Spell these exactly.") && spellBox.includes("auto-transcription"), spellBox.slice(0, 200));
    c.ok("…with her name corrected from her own notes, her brokerage and team, the street and the town", ["Erika Walker (not Erica)", "Keller Williams", "The Walker Team", "412 Okehocking Ln", "West Chester (two words, never Westchester)"].every((x) => spellBox.includes(x)), spellBox);
    c.ok("…Okehocking's \"spelled wrong before\" rides on the street; Bath (a grammar fix) is nowhere", spellBox.includes("412 Okehocking Ln (spelled wrong before)") && !/\bBath\b/.test(spellBox));
    c.ok("…and it is a line, not a new section of the brief", !/data-spell-list[^>]*data-brief-section|data-brief-section[^>]*data-spell-list/.test(article));
    c.ok("the Listing flow line sits under Make this", text(block(make, /data-listing-flow/)).trim() === vs.LISTING_FLOW && make.indexOf("data-listing-flow") > make.indexOf("data-make-this"));
    const music = text(block(article, /data-brief-section="music"/));
    c.ok("music: licensed only, and why; never trending audio", music.includes("licensed music only (it's a listing video for YouTube and the MLS)") && !/trending audio that/.test(music) && music.includes("No trending audio"), music);
    const end = block(make, /data-end-card/);
    c.ok("the end card says plainly there's no logo file and Kyle has been asked, with the way to message him", text(end).includes("Their notes ask for their logo, and there's no logo file yet. Kyle has been asked for it.") && /href="#messages"/.test(end), text(end));
    c.ok("Keep the raw footage and your project file for 30 days after delivery, once", count(text(john.html), "Keep the raw footage and your project file for 30 days after delivery. Revisions come back.") === 1);
    const task = await prisma.smartTask.findUnique({ where: { dedupeKey: logoKey } });
    c.ok("opening the brief asked Kyle: one retrieval task on his list for this job", !!task && task.assignedKey === "kyle" && task.taskType === "asset_dependency" && task.status === "OPEN" && task.projectId === listing.id && /logo or end card/.test(task.title), task?.title);
    await view("John", listing.id);
    await view("Kyle", listing.id);
    c.ok("…reopened by John and opened by Kyle: still one", (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: `asset-dep:${listing.id}:` } } })) === 1);

    const uploader = john.els.find((e) => e.name === "CutUploader");
    const checks = (uploader?.props.checks ?? {}) as Record<string, { profile: { checklistKey: string; items: { key: string; label: string; help?: string }[] } }>;
    const raw = await checkContextsForProject(listing.id);
    const key = Object.keys(raw)[0];
    const cap = checks[key]?.profile.items.find((i) => i.key === "captions_text")?.help ?? "";
    const brand = checks[key]?.profile.items.find((i) => i.key === "brand_assets")?.help ?? "";
    c.ok("the final check's captions line names the same names", cap.includes("Erika Walker (not Erica)") && cap.includes("West Chester (two words, never Westchester)") && cap.includes("412 Okehocking Ln"), cap);
    c.ok("…its brand line says no logo is on file and Kyle has been asked", brand.includes("No logo or end card on file yet. Kyle has been asked for it."), brand);
    c.ok("…and the list the server checks is the same list (key and labels)", !!key && checks[key]?.profile.checklistKey === raw[key].profile.checklistKey && JSON.stringify(checks[key]?.profile.items.map((i) => i.label)) === JSON.stringify(raw[key].profile.items.map((i) => i.label)));

    // A "view as" preview writes nothing.
    const { p: second } = await makeListing("7 Leola Way, West Chester, PA 19382", "leola");
    const preview = await view("Jordan", second.id, people.John.id);
    c.ok("Jordan's \"view as\" John raises nothing, and the brief says to ask Kyle", (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: `asset-dep:${second.id}:` } } })) === 0 && text(block(preview.html, /data-end-card/)).includes("Ask Kyle for it"), text(block(preview.html, /data-end-card/)));
    c.ok("…a read-only ask answers nothing for a job never asked", (await ensureLogoAsk(second.id, { create: false })) === null && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: `asset-dep:${second.id}:` } } })) === 0);

    // Kyle attaches the file: the brief and the final check name it.
    const attached = await attachAssetReference(task!.id, "https://example.test/walker-logo.png", "Kyle");
    const after = await view("John", listing.id);
    const endAfter = block(block(after.html, /data-brief-section="make"/), /data-end-card/);
    const brandAfter = ((after.els.find((e) => e.name === "CutUploader")?.props.checks ?? {}) as typeof checks)[key]?.profile.items.find((i) => i.key === "brand_assets")?.help ?? "";
    c.ok("once Kyle attaches it, the brief links the file he found", attached.ok && text(endAfter).includes("Kyle found it") && endAfter.includes('href="https://example.test/walker-logo.png"'), text(endAfter));
    c.ok("…and the final check names it", brandAfter.includes("the file Kyle attached (https://example.test/walker-logo.png)"), brandAfter);

    // =======================================================================
    c.head("§6 · the shoot data carries each video's shape");
    // =======================================================================
    const shootJob = await prisma.project.create({ data: { clientId: erika.id, title: "30 Ridley Ct, Ridley, PA 19078", status: "SCHEDULED", source: "MANUAL", shootDate: new Date(Date.now() + 864e5) } });
    for (const d of [
      { type: "VIDEO" as const, label: "Standard Cinematic Video", videoStyle: "standard_cinematic" },
      { type: "SOCIAL_REEL" as const, label: "Standard Reel", videoStyle: null },
      { type: "VIDEO" as const, label: "Standard Reel with Agent Intro", videoStyle: "standard_reel_agent_intro" },
      { type: "DRONE" as const, label: "Drone Photos", videoStyle: null },
    ]) await prisma.deliverable.create({ data: { projectId: shootJob.id, quantity: 1, ...d } });
    const { getShoot } = await import("@/lib/shoot");
    const shoot = await getShoot(shootJob.id);
    const shapes = (shoot?.deliverables ?? []).map((d) => `${d.label}:${d.shape}`);
    c.ok("horizontal cinematic, vertical reel, a vertical agent-intro sold as VIDEO, no shape on drone photos", JSON.stringify(shapes) === JSON.stringify(["Standard Cinematic Video:horizontal", "Standard Reel:vertical", "Standard Reel with Agent Intro:vertical", "Drone Photos:null"]), shapes.join(" | "));
    const lines = (shoot?.deliverables ?? []).map((d) => captureGuideFor(d, { videoBooked: true }));
    c.ok("…so the capture list says it per row, and the drone row asks for clips", lines[0].startsWith("Horizontal 16:9 only") && lines[1].startsWith("Vertical 9:16") && lines[2].startsWith("Vertical 9:16") && lines[3].includes("drone video clips"), lines.join(" | "));

    c.ok("nothing was sent: no outbox rows, every outbound call fenced", (await prisma.outboxMessage.count()) === 0);
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
