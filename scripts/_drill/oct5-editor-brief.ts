// @drill-run: engine=postgres conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL OCT5-EDITOR-BRIEF — the editor brief, read the way Kim and John read it
// (Oct 5 2026, the night before Jordan's first content client).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct5-editor-brief.ts --logs /private/tmp/oct5-brief
//
// Renders the SHIPPED /edit/<id> page (the server component, its async
// children resolved, then real react-dom/server for the client components)
// against a disposable Postgres on 127.0.0.1:6501, signed in as Kim on a
// monthly content session and as John Mark on a listing reel, and asserts:
//   §1 the money scrub: a client-approved hook ("The first weekend decides
//      your price.") survives; our billing language in an order note does not
//   §2 the selected video reads header → Make this → Script → Footage →
//      Brand → Client → Music (→ Changes to make, when sent back)
//   §3 one footage link, one link per brand file, ONE labelled deadline
//   §4 every video chip names its topic on the chip
//   §5 none of the audit's jargon reaches an editor
//   §6 the Agent Profile: collapsed (name, brokerage, team, segment, summary),
//      expanded "Style & brand" from the portal AND the Aryeo note, portal wins
//   §7 the listing reel: the shared reel script is THE script, the Studio song
//      is THE music rule, no "No script linked"
//   §8 one "Got it" button (for the video on the page), never "Receive this assignment"
// Every outbound call is fenced; nothing is sent to anybody.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createTestClientShell } from "../_fixtures/representativeMonth";

const DB_PORT = Number(process.env.DRILL_PORT ?? 6501);
const c = makeChecker();
installNextStubs();
const cjs = createRequire(__filename);
// The client components call useRouter() while rendering; the drill renders
// them for real, so the navigation stub answers with an inert router.
const nav = cjs("next/navigation") as Record<string, unknown>;
nav.useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} });
nav.usePathname = () => "/edit/x";
nav.useSearchParams = () => new URLSearchParams();
nav.useParams = () => ({});
const fence = fenceFetch();

type Props = Record<string, unknown>;
/** Resolve the async server components (what Next's RSC renderer does), leaving client components for react-dom/server. */
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
async function render(tree: unknown): Promise<string> {
  const { renderToStaticMarkup } = cjs("react-dom/server") as typeof import("react-dom/server");
  return renderToStaticMarkup((await resolveTree(tree)) as ReactNode);
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** The HTML of the element that opens at the first match of `open` — balanced on its tag name. */
function block(html: string, open: RegExp): string {
  const m = open.exec(html);
  if (!m) return "";
  // The match may be an attribute: the element starts at the "<" before it.
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
const sectionsInOrder = (html: string) => [...html.matchAll(/data-brief-section="([a-z]+)"/g)].map((m) => m[1]);
const externalLinks = (html: string) => [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

const JARGON = [
  "goes by the job", "shared by all", "Chosen logo", "no choice recorded", "output-specific", "Shared job script",
  "Package allowance", "Kyle needs to reconcile", "unpaired", "Editor brief only", "Previewing", "@v1", "personal_branding",
  "Receive this assignment", "(empty)", "No script linked", "Selected video:", "Video briefs", "editor acknowledgment required",
];
const HOOK = "The first weekend decides your price.";

async function main() {
  const db = await bootDrillDb({ port: DB_PORT, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: "oct5-editor-brief-isolated-secret" } });
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { ensureOutputsForProject, saveOutputBrief, outputBriefsFor } = await import("@/lib/deliverableOutputs");
    const { stripMoneySentences, mentionsOurBilling } = await import("@/lib/text");
    const { PERSONAL_BRANDING_MAKE_THIS, defaultMakeThis } = await import("@/lib/videoStyles");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const { default: page } = await import("@/app/edit/[id]/page");

    // ---- people ------------------------------------------------------------
    const people: Record<string, { id: string; email: string; role: string; teamMemberId: string }> = {};
    for (const [name, role, editorKey] of [["Jordan", "OWNER", null], ["Kyle", "ADMIN", null], ["James", "ADMIN", null], ["Kim", "EDITOR", "kim"], ["John", "EDITOR", "john"]] as const) {
      const email = `${name.toLowerCase()}-oct5brief@example.test`;
      const member = await prisma.teamMember.create({ data: { name: name === "John" ? "John Mark" : name, email, role: role === "EDITOR" ? "EDITOR" : "MANAGER", active: true } });
      const user = await prisma.appUser.create({ data: { name, email, role, editorKey, teamMemberId: member.id, status: "ACTIVE" } });
      people[name] = { id: user.id, email, role, teamMemberId: member.id };
    }
    const as = (name: string) => setSession({ uid: people[name].id, email: people[name].email, role: people[name].role });
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: people.James.teamMemberId, backupReviewerTeamMemberId: people.Kyle.teamMemberId }) } });
    const yesterday = new Date(Date.now() - 864e5);
    const due = new Date(Date.now() + 10 * 864e5);

    // ---- the content client: portal brand + an Aryeo customer note ---------
    const shell = await createTestClientShell(prisma, { name: "Dana Maple TEST", slug: "oct5brief" });
    await prisma.client.update({
      where: { id: shell.clientId },
      data: {
        name: "Dana Maple", company: "Maple & Co Realty", aryeoTeamName: "The Maple Group", segment: "vip",
        brandColors: "#0B3D2E, #C9A227", // the portal's explicit colours
        portalVideoStyle: "Calm, confident, no flashy transitions.",
        // The Aryeo customer note: its colour loses to the portal's, its fonts win (the portal has none), and the fee never shows.
        generalNotes: "Brand colors: #FF0000\nFonts: Montserrat and Lora\nAlways add her animated logo at the end.\nShe paid a $175 add-on fee for the drone last time.",
        profileJson: JSON.stringify({ v: 2, segment: "vip", stats: { totalOrders: 9, revisions: 1, inboundMsgs: 4 }, summary: "", touchLevel: "low", workingStyle: "", communication: "", revisions: { summary: "", commonTypes: [] }, brandStyle: "", shootNotes: [], aboutThem: [], dos: [], donts: [], editing: { summary: "Dana likes calm, confident edits and rarely asks for changes. Keep captions clean and on brand.", prefs: [], customerNotes: [], dos: [], donts: [] } }),
      },
    });
    const monthKey = etMonthKey(new Date());
    const month = await prisma.contentMonth.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, monthKey, videosOwed: 4 } });
    const titles = ["Why the first weekend decides your price", "A Saturday morning on Main Street", "What a pre-listing inspection saves you", "What days on market really tell a buyer"];
    const topics = [];
    for (const title of titles) topics.push(await prisma.contentTopic.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, monthId: month.id, title, status: "FILMED" } }));
    // Script A: approved before filming — a real-estate script that talks prices.
    const bodyA = [
      titles[0],
      "Category: Market Authority",
      `Hook: ${HOOK}`,
      "Talking Point 1 (Re-hook): Most sellers learn the pricing lesson after the listing has already gone live.",
      "Talking Point 2 (Build-up): At a $1M price point, buyers read the first weekend as a signal.",
      "Talking Point 3 (Payoff): Price it right on day one and the down payment math works for the buyer too.",
      "Close / Call to action: Planning to sell this year? Call me and we will plan your first weekend together.",
      "Caption CTA:",
    ].join("\n");
    const scriptA = await prisma.contentScript.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, topicId: topics[0].id, title: titles[0], body: bodyA } });
    const verA = await prisma.contentScriptVersion.create({ data: { scriptId: scriptA.id, enrollmentId: shell.enrollmentId, clientId: shell.clientId, versionNo: 1, title: titles[0], hook: HOOK, pointsJson: "[]", close: "Planning to sell this year?", body: bodyA, source: "MANUAL", creativeDirection: "Warm grade. The client paid a $150 rush fee on this one." } });
    // Script B: shared with the client, not approved yet.
    const bodyB = [titles[1], "Category: Neighborhood Life", "Hook: Buyers decide on the walk to the coffee shop.", "Talking Point 1 (Re-hook): The listing tells you about the house, and nothing about the street."].join("\n");
    const scriptB = await prisma.contentScript.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, topicId: topics[1].id, title: titles[1], body: bodyB } });
    const verB = await prisma.contentScriptVersion.create({ data: { scriptId: scriptB.id, enrollmentId: shell.enrollmentId, clientId: shell.clientId, versionNo: 1, title: titles[1], hook: "Buyers decide on the walk to the coffee shop.", pointsJson: "[]", close: "", body: bodyB, source: "MANUAL" } });
    await prisma.contentScript.update({ where: { id: scriptB.id }, data: { sharedVersionId: verB.id } });

    const monthly = await prisma.project.create({ data: {
      clientId: shell.clientId, contentMonthId: month.id, title: "Dana Maple — October content session", addressLine: "22 Maple Ave, Media, PA 19063",
      status: "EDITING", source: "MANUAL", shootDate: yesterday, deliveryDue: due, editorId: people.Kim.teamMemberId, editorManual: true,
      dropboxFolder: "/isolated/oct5/maple/oct", statusEvidence: JSON.stringify({ dropbox: { rawVideo: 23, finalVideo: 0, stale: false } }),
    } });
    await prisma.appointment.create({ data: { aryeoId: "oct5-appt-maple", projectId: monthly.id, description: "Order Notes:\n\nPlease keep her on the left third. I paid the $175 add-on fee for the second hour. Send the invoice to my assistant.\n\nOrder Questions:\n - Special Instructions for the photographer (for this property only): Film the porch first.\nOr View Full Order Details" } });
    const accel = await prisma.deliverable.create({ data: { projectId: monthly.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", videoStyle: "personal_branding", quantity: 4 } });
    await ensureOutputsForProject(monthly.id);
    const outs = await prisma.deliverableOutput.findMany({ where: { projectId: monthly.id }, orderBy: { slot: "asc" } });
    for (const [i, o] of outs.entries()) {
      await prisma.deliverableOutput.update({ where: { id: o.id }, data: { title: titles[i], topicId: topics[i].id, filmingNote: i === 0 ? "Take 3 is the keeper — she stumbled on 1 and 2." : null, ownerKey: "kim", ownerName: "Kim", ownerSetAt: yesterday, rawInAt: yesterday, promisedAt: due } });
      await prisma.contentVideo.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, monthId: month.id, monthKey, projectId: monthly.id, deliverableId: accel.id, slot: o.slot, outputId: o.id, topicId: topics[i].id, title: titles[i], scriptId: i === 0 ? scriptA.id : i === 1 ? scriptB.id : null, scriptVersionId: i === 0 ? verA.id : null, filmedAt: yesterday, filmedConfirmedAt: yesterday, filmedConfirmedBy: "Harrison (drill)", filmedSource: "staff", status: "EDITING" } });
    }
    // Video 1's clips have their own folder; video 2's do not (the fallback line).
    await prisma.contentTopicFolder.create({ data: { projectId: monthly.id, topicId: topics[0].id, dropboxPath: "/isolated/oct5/maple/oct/02-RAW-Video/01-First weekend", label: "01-First weekend" } });
    // The office's brief: video 1 has direction (with a fee sentence) but no specs; video 2 overrides the specs.
    const b1 = await saveOutputBrief({ projectId: monthly.id, outputId: outs[0].id, actor: "Kyle (drill)", sections: { mustShow: "Show the pricing chart from her listing presentation. The client paid a $150 rush fee." } });
    const b2 = await saveOutputBrief({ projectId: monthly.id, outputId: outs[1].id, actor: "Kyle (drill)", sections: { specs: "16:9 horizontal for YouTube · 1920×1080 · 90 s" } });
    if (!b1.ok || !b2.ok) throw new Error("drill briefs could not be saved");
    await prisma.smartTask.create({ data: { projectId: monthly.id, clientId: shell.clientId, taskType: "edit_video", title: "Edit Dana Maple session", assignedKey: "kim", assignedManually: true, status: "OPEN", dedupeKey: `edit-video-${monthly.id}`, dueAt: due, source: "manual" } });

    // ---- the listing client: brand only in the Aryeo note -------------------
    const rob = await prisma.client.create({ data: { name: "Rob Listing", company: "Main Line Realty", segment: "one_timer", autoConfirmationText: false, autoDeliveryText: false, generalNotes: "Brand colours: #1B2A4A and #D4AF37\nUse his logo on every video.\nHe was refunded $40 last month." } });
    const listing = await prisma.project.create({ data: {
      clientId: rob.id, title: "415 Oak Street, Wayne, PA 19087", status: "SHOT", source: "MANUAL", shootDate: yesterday, deliveryDue: due, editorId: people.John.teamMemberId, editorManual: true,
      dropboxFolder: "/isolated/oct5/oak", statusEvidence: JSON.stringify({ dropbox: { rawVideo: 41 } }),
      reelHook: "Wait until you see the kitchen in this Wayne colonial.", reelScript: "Hi, I'm Rob with Main Line Realty. Welcome to 415 Oak Street.", reelSong: "Upbeat acoustic",
      notes: "Photographer: drone was grounded (wind). No aerials.", videoInstructions: "Agent intro in front of the house, then kitchen first.",
    } });
    await prisma.appointment.create({ data: { aryeoId: "oct5-appt-oak", projectId: listing.id, description: "Order Notes:\n\nSeller asks no shots of the kids' rooms. We were charged twice last time, please refund one.\n\nOrder Questions:\n - Special Instructions for the photographer (for this property only): Please feature the new kitchen and the backyard pool.\nOr View Full Order Details" } });
    await prisma.deliverable.create({ data: { projectId: listing.id, type: "SOCIAL_REEL", label: "Standard Reel with Agent Intro", productTitle: "Photography and Standard Reel w/ Agent intro", videoStyle: "standard_reel_agent_intro", quantity: 1 } });
    await ensureOutputsForProject(listing.id);
    const oak = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: listing.id } });
    await prisma.deliverableOutput.update({ where: { id: oak.id }, data: { ownerKey: "john", ownerName: "John Mark", ownerSetAt: yesterday, rawInAt: yesterday, promisedAt: due } });
    await prisma.smartTask.create({ data: { projectId: listing.id, clientId: rob.id, taskType: "edit_video", title: "Edit 415 Oak", assignedKey: "john", assignedManually: true, status: "OPEN", dedupeKey: `edit-video-${listing.id}`, dueAt: due, source: "manual" } });

    // DRILL_K=dump writes each rendered page as text beside the logs, for a person to read.
    const fs = cjs("node:fs") as typeof import("node:fs");
    const view = async (who: string, id: string, search: Record<string, string> = {}) => {
      await as(who);
      const tree = await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) });
      const html = await render(tree);
      if (process.env.DRILL_K === "dump") fs.writeFileSync(`${process.env.TMPDIR ?? "/tmp"}/oct5-brief-${who}-${id.slice(-6)}-${Object.values(search).join("").slice(-6) || "job"}.html`, html);
      return html;
    };

    // =======================================================================
    c.head("§1 · our money, not the market's");
    // =======================================================================
    c.ok("the client-approved hook is not 'our billing' (it used to be deleted)", !mentionsOurBilling(HOOK) && stripMoneySentences(HOOK) === HOOK);
    c.ok("real-estate words stay: pricing, a $1M price point, a down payment", ["Most sellers learn the pricing lesson after the listing has already gone live.", "At a $1M price point, buyers read the first weekend as a signal.", "Price it right on day one and the down payment math works for the buyer too."].every((x) => stripMoneySentences(x) === x));
    c.ok("our billing goes: a $175 add-on fee, an invoice, a refund, a $150 rush fee", ["I paid the $175 add-on fee for the second hour.", "Send the invoice to my assistant.", "He was refunded $40 last month.", "The client paid a $150 rush fee on this one."].every((x) => mentionsOurBilling(x) && stripMoneySentences(x) === ""));
    const kimBriefs = await outputBriefsFor(monthly.id, { scrub: true });
    c.ok("a creative's copy of the brief carries the approved script word for word", kimBriefs[0]?.script?.text === bodyA, kimBriefs[0]?.script?.text?.slice(0, 80));
    c.ok("…while the office's fee sentence is still withheld and its real-estate sentence kept", JSON.stringify(kimBriefs[0]?.sections).includes("Show the pricing chart") && !JSON.stringify(kimBriefs[0]?.sections).includes("$150") && !JSON.stringify(kimBriefs[0]?.script?.direction).includes("$150"));

    // =======================================================================
    c.head("§2 · Kim on video 1 of the monthly session");
    // =======================================================================
    const kim1 = await view("Kim", monthly.id, { output: outs[0].id });
    const kim1Text = text(kim1);
    const article1 = block(kim1, new RegExp(`<article[^>]*id="brief-${outs[0].id}"`));
    c.ok("the selected video is one article", !!article1 && count(kim1, 'data-brief="selected-video"') === 1);
    c.ok("the hook reaches the editor intact, and so does the rest of the approved script", text(article1).includes(HOOK) && text(article1).includes("At a $1M price point") && text(article1).includes("down payment math"), text(article1).slice(0, 400));
    const order1 = sectionsInOrder(article1);
    c.ok("sections in order: header, Make this, Script, Footage, Brand, Client, Music", JSON.stringify(order1) === JSON.stringify(["header", "make", "script", "footage", "brand", "client", "music"]), order1.join(" > "));
    c.ok("Make this: the personal-branding default when the office wrote no specs", text(block(article1, /data-make-this/)).includes(PERSONAL_BRANDING_MAKE_THIS.replace(/&/g, "&")), text(block(article1, /data-make-this/)));
    c.ok("the script is OPEN by default with a Copy button, and an approved script wears no warning", /<section[^>]*data-brief-section="script"[\s\S]*?<details open=""/.test(article1) && article1.includes('aria-label="Copy the script"') && !article1.includes("data-not-approved"));
    c.ok("a blank script section is not drawn as '(empty)'", !kim1Text.includes("(empty)") && !/Caption CTA/i.test(text(block(article1, /data-brief-section="script"/))));
    const links1 = externalLinks(article1);
    const footageLinks = (links: string[]) => links.filter((u) => u.includes("/isolated/oct5/"));
    c.ok("one footage link — this topic's own clips — and no duplicate links in the brief", footageLinks(links1).length === 1 && links1.some((u) => u.includes("01-First%20weekend") || u.includes("01-First weekend")) && new Set(links1).size === links1.length, links1.join(" | "));
    c.ok("the raw job folder is linked nowhere else on the page", count(kim1, "isolated/oct5/maple/oct\"") + count(kim1, "isolated/oct5/maple/oct/02-RAW-Video\"") === 0, String(count(kim1, "maple/oct")));
    const dueBlock = text(block(article1, /<div[^>]*data-due/));
    const manila = due.toLocaleString("en-US", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const eastern = due.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    c.ok("ONE deadline, labelled in both clocks", dueBlock.includes(`${manila} your time`) && dueBlock.includes(`${eastern} ET`), dueBlock);
    c.ok("…and that date is printed nowhere else on the page", count(kim1Text, manila) === 1 && count(kim1Text, eastern) === 1 && !/Deadline/.test(kim1Text), `${count(kim1Text, manila)} / ${count(kim1Text, eastern)}`);
    const footage1 = text(block(article1, /data-brief-section="footage"/));
    c.ok("Footage carries the photographer's note", footage1.includes("Take 3 is the keeper"));
    const brand1 = block(article1, /data-brief-section="brand"/);
    c.ok("Brand: the portal's colours with hex and the note's fonts", text(brand1).includes("#0B3D2E") && text(brand1).includes("#C9A227") && !text(brand1).includes("#FF0000") && text(brand1).includes("Montserrat and Lora"), text(brand1).slice(0, 300));
    const client1 = block(article1, /data-brief-section="client"/);
    c.ok("their own words sit with the client, and say they win over the house style", text(client1).includes("Calm, confident, no flashy transitions.") && text(client1).includes("theirs wins"));
    c.ok("the order note reaches the editor without our billing", text(client1).includes("Please keep her on the left third.") && !kim1Text.includes("$175") && !/invoice/i.test(kim1Text), text(client1).slice(0, 300));
    c.ok("the office's fee sentence is withheld, its real-estate instruction kept", text(block(article1, /data-brief-section="make"/)).includes("Show the pricing chart") && !kim1Text.includes("$150"));
    c.ok("Music: trending audio for a monthly reel, once", text(block(article1, /data-brief-section="music"/)).includes("trending audio") && count(kim1Text, "trending audio") === 1);

    // =======================================================================
    c.head("§3 · the chips, the jargon, the one Got it");
    // =======================================================================
    const chips = block(kim1, /<section[^>]*aria-label="Video selector"/);
    c.ok("every chip carries its topic title on the chip itself", titles.every((t, i) => text(chips).includes(`${i + 1} · ${t} ·`)), text(chips));
    c.ok("exactly one chip is the selected video", count(chips, 'aria-current="page"') === 1);
    const jargon1 = JARGON.filter((j) => kim1Text.includes(j) || kim1.includes(j));
    c.ok("none of the audit's jargon reaches Kim", jargon1.length === 0, jargon1.join(", "));
    // Oct 5 night review: the ONE press is for the video on this page (it used
    // to acknowledge every pending video, opened or not); Kim's other videos
    // are named, one tap away, not pressed for her.
    c.ok("one Got it button — for THIS video — not a Receive button per video; the others are named as still waiting",
      count(kim1Text, "Got it — video 1") === 1 && kim1Text.includes("Still waiting for your Got it:") && !kim1Text.includes("Receive this assignment"), kim1Text.match(/Got it[^.]*\./g)?.join(" | "));

    // =======================================================================
    c.head("§4 · the Agent Profile");
    // =======================================================================
    const profile1 = block(kim1, /<details[^>]*data-agent-profile/);
    const summary1 = text(block(profile1, /<summary/));
    c.ok("collapsed by default", !!profile1 && !/<details[^>]*data-agent-profile[^>]*\sopen/.test(profile1));
    c.ok("collapsed it shows the name, brokerage, team, segment and a summary", ["Agent Profile", "Dana Maple", "Maple & Co Realty", "Team: The Maple Group", "VIP", "Dana likes calm, confident edits"].every((x) => summary1.includes(x)), summary1);
    const expanded1 = text(profile1.slice(profile1.indexOf("</summary>")));
    c.ok("expanded: Style & brand with the portal's colours (hex) and the Aryeo note's fonts", expanded1.includes("Style & brand") && expanded1.includes("#0B3D2E") && expanded1.includes("from their portal") && expanded1.includes("Montserrat and Lora") && expanded1.includes("from their Aryeo notes"), expanded1.slice(0, 400));
    c.ok("the Aryeo note's style line is in the brief's client section, said once", text(client1).includes("Always add her animated logo") && count(kim1Text, "Always add her animated logo") === 1);
    c.ok("…so the end card asks for the logo instead of skipping it", text(brand1).includes("Their notes ask for their logo") && text(brand1).includes("name card"));
    c.ok("…the portal's explicit colours win over the note's, and no money anywhere in the card", !text(profile1).includes("#FF0000") && !text(profile1).includes("$175") && !/lifetime|\$\d/i.test(text(profile1)));

    // =======================================================================
    c.head("§5 · video 2: the office's own specs, a script the client has not approved");
    // =======================================================================
    const kim2 = await view("Kim", monthly.id, { output: outs[1].id });
    const article2 = block(kim2, new RegExp(`<article[^>]*id="brief-${outs[1].id}"`));
    c.ok("the header names the topic", text(block(article2, /data-brief-section="header"/)).includes(`Video 2 of 4 — ${titles[1]}`));
    c.ok("Make this: the office's line for this video replaces the default", text(block(article2, /data-make-this/)).includes("16:9 horizontal for YouTube") && text(article2).includes("Set by the office for this video"));
    c.ok("a script the client has not approved wears the badge", article2.includes("data-not-approved") && text(article2).includes("Not approved by the client yet"));
    c.ok("no topic folder: one raw-footage link and the honest one-line fallback", footageLinks(externalLinks(article2)).length === 1 && text(article2).includes("aren't in a folder of their own"));

    // =======================================================================
    c.head("§6 · John on the listing reel");
    // =======================================================================
    const john = await view("John", listing.id);
    const johnText = text(john);
    const articleL = block(john, new RegExp(`<article[^>]*id="brief-${oak.id}"`));
    const orderL = sectionsInOrder(articleL);
    c.ok("the same order on a listing reel", JSON.stringify(orderL) === JSON.stringify(["header", "make", "script", "footage", "brand", "client", "music"]), orderL.join(" > "));
    c.ok("Make this: the listing style's own spec, not the monthly one", text(block(articleL, /data-make-this/)).includes(defaultMakeThis("standard_reel_agent_intro")) && !text(articleL).includes("30–60 s"));
    const scriptL = text(block(articleL, /data-brief-section="script"/));
    c.ok("the shared reel script IS this video's script — and no 'No script linked' above it", scriptL.includes("Wait until you see the kitchen") && scriptL.includes("Welcome to 415 Oak Street") && !johnText.includes("No script linked") && count(johnText, "Wait until you see the kitchen") === 1);
    const musicL = text(block(articleL, /data-brief-section="music"/));
    c.ok("one music rule: the Studio's song, never 'use trending' beside it", musicL.includes("Upbeat acoustic") && !/trending/i.test(johnText), musicL);
    c.ok("the office's note, the shoot's instruction and the order's words each appear once", count(johnText, "drone was grounded") === 1 && count(johnText, "Agent intro in front of the house") === 1 && count(johnText, "Please feature the new kitchen") === 1);
    c.ok("no money from the order note or the Aryeo note", !/refund|charged twice|\$40/i.test(johnText));
    const profileL = block(john, /<details[^>]*data-agent-profile/);
    c.ok("John's Agent Profile: Rob, Main Line Realty, the segment, and colours from the Aryeo note", text(block(profileL, /<summary/)).includes("Rob Listing") && text(profileL).includes("Main Line Realty") && text(profileL).includes("One-Timer") && text(profileL).includes("#1B2A4A") && text(profileL).includes("from their Aryeo notes"), text(profileL).slice(0, 400));
    const jargonL = JARGON.filter((j) => johnText.includes(j) || john.includes(j));
    c.ok("none of the audit's jargon reaches John", jargonL.length === 0, jargonL.join(", "));
    c.ok("one video on the job: no chooser, one footage link", !john.includes('aria-label="Video selector"') && footageLinks(externalLinks(john)).length === 1);

    // =======================================================================
    c.head("§7 · sent back: Changes to make comes last in the brief");
    // =======================================================================
    const cut = await prisma.reviewSubmission.create({ data: { projectId: monthly.id, deliverableId: accel.id, outputId: outs[0].id, slot: outs[0].slot, round: 1, status: "CHANGES_REQUESTED", fileName: "maple-1-v1.mp4", source: "upload", sourceWidth: 1080, sourceHeight: 1920, submittedByKey: "kim", submittedByName: "Kim", decidedAt: new Date(), decidedBy: "James", selfCheckedAt: yesterday } });
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { assetUrl: `/api/review/cut/${cut.id}/stream` } });
    await prisma.mediaNote.create({ data: { projectId: monthly.id, assetUrl: `/api/review/cut/${cut.id}/stream`, assetType: "video", lane: "EDITOR", editorKey: "kim", kind: "fix", timeSec: 12, body: "At 0:12 the caption covers her face — move it up.", authorName: "James", authorUserId: people.James.id } });
    const back = await view("Kim", monthly.id, { output: outs[0].id });
    const articleB = block(back, new RegExp(`<article[^>]*id="brief-${outs[0].id}"`));
    const orderB = sectionsInOrder(articleB);
    c.ok("the order holds, with Changes to make as section 8", JSON.stringify(orderB) === JSON.stringify(["header", "make", "script", "footage", "brand", "client", "music", "changes"]), orderB.join(" > "));
    c.ok("Changes to make says what is waiting and where, without copying the notes", text(block(articleB, /data-brief-section="changes"/)).includes("1 note to fix on v1 from James") && !text(articleB).includes("caption covers her face"), text(block(articleB, /data-brief-section="changes"/)));
    c.ok("the header says it came back, and the one link to the exact cut is at the top", text(block(articleB, /data-brief-section="header"/)).includes("Changes requested") && count(back, `cut=${cut.id}`) >= 1);
    c.ok("the review history is folded away, not in the brief", !text(articleB).includes("History ·") && text(back).includes("History · 1 version"));

    // =======================================================================
    c.head("§8 · the office reads the same brief, plus its own tools");
    // =======================================================================
    const kyle = await view("Kyle", monthly.id, { output: outs[0].id });
    const articleK = block(kyle, new RegExp(`<article[^>]*id="brief-${outs[0].id}"`));
    c.ok("Kyle sees the same eight sections in the same order", JSON.stringify(sectionsInOrder(articleK)) === JSON.stringify(orderB));
    c.ok("the office can override the specs per video, with the default shown beside the field", kyle.includes('name="s_specs"') && text(kyle).includes(`Leave empty to use the default: ${PERSONAL_BRANDING_MAKE_THIS}`));
    c.ok("Kyle's deadline is said once, in ET", text(block(articleK, /<div[^>]*data-due/)).includes(`${eastern} ET`) && !text(articleK).includes("your time"));
    c.ok("the receipts read as one line for the office", /Kim has said Got it on 0 of 4 videos/.test(text(kyle)), text(kyle).match(/Kim has[^.]*\./)?.[0]);

    c.ok("nothing was sent: no outbox rows", (await prisma.outboxMessage.count()) === 0);
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
