// ---------------------------------------------------------------------------
// DRILL: THE PILLAR FORMAT SWITCH, RENDERED (Oct 26 2026).
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
// The client's topic bank (portal TopicBank) and the office's Video Topics
// (TopicsPanel) render to static markup from fixtures: on an account that
// does skits every pillar heading carries "Talking to camera | Skits" with
// both counts (aria-pressed on the one it is on, 44px on a phone), the pillar
// lists that format only and opens on the account's main one, a skit's line
// reads "The skit: ...", there is no Skits section any more, and a Direct
// account has no switch. No database, no provider, no message.
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {}, replace() {}, push() {} });

type Fmt = "SKIT" | "DIRECT";
const flat = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

async function main() {
  const c = makeChecker();
  const { TopicBank } = await import("../../src/components/portal/TopicBank");
  const { TopicsPanel } = await import("../../src/components/content/TopicsPanel");

  // ---- the portal ----------------------------------------------------------
  const pt = (id: string, pillarId: string | null, pillarName: string, format: Fmt, over: Record<string, unknown> = {}) => ({
    id, title: `Title ${id}`, concept: `Concept ${id}.`, pillarId, pillarName, audienceNeed: null, businessGoal: null, intendedMessage: null, source: "ai", mine: false,
    state: "SUGGESTED", selection: null, interview: null, script: null, scriptText: null, strategyLabel: null, lastEventAtISO: null, history: [], declined: null, carried: null,
    questions: null, scriptedNotFilmed: false, plan: null, recommended: null, format, ...over,
  });
  const groups = [
    { pillarId: "p1", pillarName: "Seller Strategy", purpose: null, topics: [pt("d1", "p1", "Seller Strategy", "DIRECT"), pt("d2", "p1", "Seller Strategy", "DIRECT"), pt("d3", "p1", "Seller Strategy", "DIRECT"), pt("k1", "p1", "Seller Strategy", "SKIT"), pt("k2", "p1", "Seller Strategy", "SKIT")] },
    { pillarId: "p2", pillarName: "Personal Branding", purpose: null, topics: [pt("d4", "p2", "Personal Branding", "DIRECT"), pt("k3", "p2", "Personal Branding", "SKIT"), pt("k4", "p2", "Personal Branding", "SKIT"), pt("k5", "p2", "Personal Branding", "SKIT"), pt("k6", "p2", "Personal Branding", "SKIT")] },
    { pillarId: "p3", pillarName: "Local Life", purpose: null, topics: [pt("d5", "p3", "Local Life", "DIRECT")] },
  ];
  const months = [{ id: "m10", monthKey: "2026-10", owed: 4, selected: 0, overflow: 0, historical: false, planning: null }];
  // React separates adjacent text with <!-- -->; the checks read the text as a person would.
  const bank = (videoStyle: "DIRECT" | "SKITS" | "MIX", view: "bank" | "month" = "bank", g = groups) => flat(createElement(TopicBank as never, {
    groups: g, months, archivedCount: 0, total: g.reduce((n, x) => n + x.topics.length, 0), strategyLabel: null, canAct: true, readOnly: false, initialFilter: undefined,
    tabHref: "?tab=plan", view, initialMonthId: "m10", videoStyle, skitsPerMonth: videoStyle === "MIX" ? 2 : null,
  }));
  const group = (html: string, pillar: string) => {
    const m = new RegExp(`<div role="group" aria-label="${pillar}: talking to camera or skits"[^>]*>([\\s\\S]*?)</div>`).exec(html);
    if (!m) return null;
    const btns = [...m[1].matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g)].map((b) => ({ pressed: b[1] === "true", text: b[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), tag: b[0] }));
    return btns;
  };
  const shows = (html: string, id: string) => html.includes(`>Title ${id}<`);

  c.head("the portal bank");
  const mix = bank("MIX");
  const g1 = group(mix, "Seller Strategy");
  c.ok("Mix: each pillar heading has the switch, with the count on each side", !!g1 && g1.length === 2 && g1[0].text === "Talking to camera 3" && g1[1].text === "Skits 2" && group(mix, "Personal Branding")?.map((b) => b.text).join("|") === "Talking to camera 1|Skits 4", JSON.stringify(g1));
  c.ok("…on Talking to camera (the main format), pressed", g1?.[0].pressed === true && g1?.[1].pressed === false);
  c.ok("…and it lists that format only", shows(mix, "d1") && shows(mix, "d4") && !shows(mix, "k1") && !shows(mix, "k3"));
  c.ok("…every option is a real button, 44px on a phone, reachable by keyboard", (g1 ?? []).every((b) => /type="button"/.test(b.tag) && /min-h-11/.test(b.tag) && !/tabindex="-1"/.test(b.tag)));
  c.ok("no Skits section any more", !/<h2[^>]*>Skits<\/h2>/.test(mix));
  const skits = bank("SKITS");
  c.ok("Skits: the pillar opens on Skits and lists the skits, each said as 'The skit: ...'", group(skits, "Seller Strategy")?.[1].pressed === true && shows(skits, "k1") && !shows(skits, "d1") && /The skit: <\/span>Concept k1\./.test(skits));
  c.ok("…a pillar with no skits says so and keeps its switch", group(skits, "Local Life")?.map((b) => b.text).join("|") === "Talking to camera 1|Skits 0" && /No skit concepts in this pillar yet\./.test(skits));
  const direct = bank("DIRECT", "bank", groups.map((g) => ({ ...g, topics: g.topics.filter((t) => t.format === "DIRECT") })));
  c.ok("Direct: no switch, every topic listed as before", !/talking to camera or skits/.test(direct) && shows(direct, "d1") && shows(direct, "d5"));
  const picked = groups.map((g) => ({ ...g, topics: g.topics.map((t) => (t.id === "k1" || t.id === "d2" ? { ...t, state: "SELECTED", selection: { monthId: "m10", monthKey: "2026-10", status: "SELECTED", overflow: false, removable: true } } : t)) })) as unknown as typeof groups;
  const monthView = bank("MIX", "month", picked);
  c.ok("the month view lists the month's picks in both formats, no switch", shows(monthView, "k1") && shows(monthView, "d2") && !/talking to camera or skits/.test(monthView));
  c.ok("…and the Mix line says how many skits are picked", /1 of 2 skits/.test(monthView), (/[^<>]*skit[^<>]*/i.exec(monthView) ?? [""])[0]);
  c.ok("choosing a topic and 'I don't like this one' are still on every card", (mix.match(/Choose this topic/g) ?? []).length >= 4 && /I don(&#x27;|&rsquo;|’)t like this one/.test(mix));

  // ---- the office ----------------------------------------------------------
  const ot = (id: string, pillarId: string, format: Fmt) => ({
    id, title: `Office ${id}`, concept: `Office concept ${id}.`, pillarId, pillarLabel: null, status: "SAVED", approvalState: "APPROVED", source: "ai", audienceNeed: null, businessGoal: null, intendedMessage: null,
    monthId: null, importedMark: null, proposedState: null, lastEventAt: null, scriptId: null, format, formatOwn: true,
  });
  const ogroups = [
    { pillarId: "p1", pillarName: "Seller Strategy", topics: [ot("d1", "p1", "DIRECT"), ot("d2", "p1", "DIRECT"), ot("k1", "p1", "SKIT")] },
    { pillarId: "p2", pillarName: "Personal Branding", topics: [ot("k2", "p2", "SKIT"), ot("k3", "p2", "SKIT")] },
  ];
  const stock = [
    { pillarId: "p1", pillarName: "Seller Strategy", usable: 2, pending: 0, declined: 0, target: 10, need: 8, formats: [{ format: "DIRECT", main: true, usable: 2, pending: 0, target: 10, need: 8 }, { format: "SKIT", main: false, usable: 1, pending: 2, target: 5, need: 2 }] },
  ];
  const sugg = [{ id: "s1", kind: "BANK", rank: 1, title: "Suggested skit lighthouse", description: "She plays both sides of the offer.", pillarName: "Seller Strategy", audienceNeed: null, businessGoal: null, intendedMessage: null, rationale: null, whyNow: null, linkedGoal: null, priorContentRelation: null, relatedTopicId: null, runSummary: null, format: "SKIT" }];
  const panel = (videoStyle: "DIRECT" | "SKITS" | "MIX", g = ogroups) => flat(createElement(TopicsPanel as never, {
    enrollmentId: "e1", month: null, capacity: null, groups: g, proposed: [], monthTopics: [], suggestions: sugg, recommended: [], runs: [], interviews: {}, histories: {},
    pillars: [{ id: "p1", name: "Seller Strategy" }, { id: "p2", name: "Personal Branding" }], topicsPerPillar: 10, isOwner: true, archivedCount: 0, stock, videoStyle,
  }));
  const oshows = (html: string, id: string) => html.includes(`>Office ${id}<`);

  c.head("the office bank");
  const oMix = panel("MIX");
  const og1 = group(oMix, "Seller Strategy");
  c.ok("Mix: each pillar row has the switch with both counts, on Talking to camera", og1?.map((b) => `${b.text}:${b.pressed}`).join("|") === "Talking to camera 2:true|Skits 1:false", JSON.stringify(og1));
  c.ok("…the rows listed are that format's", oshows(oMix, "d1") && oshows(oMix, "d2") && !oshows(oMix, "k1"));
  c.ok("…a pillar with none of that format says so", /No talking-to-camera topics under this pillar yet\./.test(oMix));
  c.ok("…no Skits section any more", !/Skits · /.test(oMix));
  c.ok("the stock line counts each pillar per format", /Seller Strategy: talking to camera 2 of 10 \(needs 8\), skits 1 of 5 \+ 2 to review \(needs 2\)/.test(oMix), (/Seller Strategy:[^<]*/.exec(oMix) ?? [""])[0]);
  c.ok("a skit suggestion reads 'The skit: ...'", /The skit: <\/span>She plays both sides of the offer\./.test(oMix));
  const oSkits = panel("SKITS");
  c.ok("Skits: the pillar opens on Skits, each skit said as 'The skit: ...'", group(oSkits, "Seller Strategy")?.[1].pressed === true && oshows(oSkits, "k1") && !oshows(oSkits, "d1") && /The skit: <\/span>Office concept k1\./.test(oSkits));
  c.ok("…and every card keeps its one format control", (oSkits.match(/Switch to Talking to camera/g) ?? []).length >= 1);
  const oDirect = panel("DIRECT", ogroups.map((g) => ({ ...g, topics: g.topics.filter((t) => t.format === "DIRECT") })));
  c.ok("Direct: no switch, every topic listed", !/talking to camera or skits/.test(oDirect) && oshows(oDirect, "d1") && oshows(oDirect, "d2"));

  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
