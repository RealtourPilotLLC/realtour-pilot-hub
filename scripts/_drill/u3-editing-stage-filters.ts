// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual queue SSR and safe URL transitions; no DB, actions or providers.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import { editingQueueFilters, editingQueueHref, queueReturnHref } from "../../src/lib/editingQueueUrl";
import { editingStageOf, matchesEditingStage } from "../../src/lib/editingQueueStage";
import type { QueueRow } from "../../src/components/editing/SimpleQueue";

const RealDate = Date;
const NOW = RealDate.UTC(2026, 9, 1, 14);
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) { return args.length ? Reflect.construct(target, args) : new target(NOW); },
  get(target, key, receiver) { return key === "now" ? () => NOW : Reflect.get(target, key, receiver); },
}) as DateConstructor;
installNextStubs();
let search = "";
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.useSearchParams = () => new URLSearchParams(search);
}
const copied: string[] = [];
// Oct 5 2026: "Copy project link" moved off the row (CopyButton) into the
// row's floating menu (ActionMenu, a3133a5 Oct 2). The real menu still
// renders; this keeps the items each one was handed, so the drill presses
// every Copy item and reads what reached the clipboard — the value actually
// written, not a prop.
type MenuItem = { id: string; onSelect: () => void };
const menuItems: { label: string; items: MenuItem[] }[] = [];
interceptModule((request) => request === "@/components/ui/ActionMenu" || /components[\/]ui[\/]ActionMenu(?:\.tsx)?$/.test(request), (loaded) => {
  const original = loaded as typeof import("../../src/components/ui/ActionMenu");
  return { ...original, ActionMenu: (props: Parameters<typeof original.ActionMenu>[0]) => { menuItems.push({ label: props.label, items: props.items as MenuItem[] }); return createElement(original.ActionMenu, props); } };
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } });

function row(id: string, status: string, editorKey: string | null = "kim", due = "late"): QueueRow {
  const dueISO = due === "none" ? null : due === "late" ? "2026-09-28T21:00:00.000Z" : "2026-10-01T21:00:00.000Z";
  return {
    id, url: `https://hub.example.test/edit/${id}`, street: `${id} Fixture Lane`, client: "Stage Fixture TEST", clientAvatarUrl: null,
    tier: "standard", typeDetail: "Standard Reel", status, held: false, videoBreakdown: null, videosToEdit: 0, startableBy: null,
    editor: editorKey === "kim" ? "Kim" : editorKey === "john" ? "John Mark" : null, editorKey, savedEditorKey: editorKey,
    assignmentState: editorKey ? "assigned" : "unassigned", auto: false, dueISO, late: due === "late", priority: "NORMAL",
    videos: 1, hasScript: false, comments: 0, rawUrl: null, finalUrl: null, rawCount: 1, finalCount: 0,
    shootISO: "2026-09-27T14:00:00.000Z", photographer: null, openRevisions: 0,
    overrides: { statusPinned: false, dueAt: null, videosOwed: null, tier: null, typeDetail: null, priority: null, by: null, at: null, note: null },
    computed: { dueAt: dueISO, videosOwed: 1, tier: "standard", typeDetail: "Standard Reel", priority: "NORMAL" },
    work: { active: [], paused: [] }, workChip: null, blocker: null,
  };
}
const notDone = [
  row("ready-kim", "Ready for editing"), row("ready-john", "Ready for editing", "john", "today"),
  row("changes-kim", "Revisions"), row("changes-john", "Revisions", "john"),
  { ...row("review-kim", "Ready for review", "kim", "today"), videos: 3, videosToEdit: 2, videoBreakdown: "1 ready for review · 2 more to edit" },
  row("waiting-kim", "Waiting", "kim", "none"), row("instructions-none", "Waiting on instructions", null),
  row("active-kim", "In editing"), row("paused-kim", "Paused"), row("unconfirmed-kim", "In editing — not confirmed"),
  row("check-kim", "Check needed"), row("approved-john", "Approved", "john"),
  row("additional-john", "Extra video owed", "john", "none"), row("unknown-kim", "Future status", "kim", "none"),
];
const upcoming = [row("upcoming-kim", "Waiting", "kim", "today"), row("upcoming-john", "Waiting", "john", "today")];
const done = [{ ...row("delivered-kim", "Completed"), late: false }];
const rowCount = (html: string) => Math.max(0, (html.match(/<tr\b/g)?.length ?? 0) - (html.includes("<thead") ? 1 : 0));
const selectedOption = (html: string, value: string) => new RegExp(`<option\\b(?=[^>]*value="${value}")(?=[^>]*\\bselected)[^>]*>`).test(html);
function options(html: string, label: string) {
  const body = html.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1] ?? "";
  return [...body.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((match) => ({ value: match[1], count: Number(match[2].match(/\((\d+)\)$/)?.[1]) }));
}

async function main() {
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { SimpleQueue } = await import("../../src/components/editing/SimpleQueue");
    const render = (params: string | URLSearchParams, own = false) => {
      search = params.toString();
      return renderToStaticMarkup(createElement(SimpleQueue, { notDone: own ? notDone.filter((r) => r.editorKey === "kim") : notDone, upcoming: own ? upcoming.filter((r) => r.editorKey === "kim") : upcoming, done, hideEditor: own }));
    };
    c.ok("four main filters follow the existing displayed status", editingStageOf("Ready for editing") === "ready" && editingStageOf("Revisions") === "changes" && editingStageOf("Ready for review") === "review" && editingStageOf("Waiting on instructions") === "blocked" && editingStageOf("Waiting") === "blocked");
    c.ok("Start, Pause, unconfirmed work, self-check and delivery facts remain separate", ["In editing", "Paused", "In editing — not confirmed", "Check needed", "Approved", "Extra video owed", "Completed"].map(editingStageOf).join(",") === "editing,paused,unconfirmed,check,approved,additional,completed");
    c.ok("unknown future status remains reachable without pretending ready", editingStageOf("Future status") === "other" && matchesEditingStage("all", "Future status") && !matchesEditingStage("ready", "Future status"));
    const safe = editingQueueHref(new URLSearchParams("editor=kim&due=overdue&stage=changes&q=private-draft&token=secret&view=notdone"));
    c.ok("stage adds only a validated query dimension and strips private extras", safe === "/editing?editor=kim&due=overdue&stage=changes");
    c.ok("invalid stage falls back to All and existing choices survive", editingQueueFilters(new URLSearchParams("view=done&editor=kim&due=today&stage=https://bad.example")).stage === "all" && editingQueueHref(new URLSearchParams("view=done&editor=kim&due=today&stage=UNKNOWN")) === "/editing?view=done&editor=kim&due=today");
    const selected = render(safe.split("?")[1]);
    const refreshed = render(safe.split("?")[1]);
    c.ok("stage survives first paint and refresh without widening editor or due", [selected, refreshed].every((html) => rowCount(html) === 1 && ["changes", "kim", "overdue"].every((value) => selectedOption(html, value)) && html.includes("changes-kim Fixture Lane")));
    c.ok("brief link and explicit return preserve all selected dimensions", selected.includes('href="/edit/changes-kim?queue=editor%3Dkim%26due%3Doverdue%26stage%3Dchanges"') && queueReturnHref("editor=kim&due=overdue&stage=changes") === safe);
    const copyItems = menuItems.flatMap((m) => m.items.filter((x) => x.id === "copy"));
    for (const item of copyItems) item.onSelect();
    for (let i = 0; i < 50 && copied.length < copyItems.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    c.ok("clipboard still receives canonical public job URL", copyItems.length > 0 && copied.length === copyItems.length && copied.includes("https://hub.example.test/edit/changes-kim") && copied.every((value) => !value.includes("?")), `${copyItems.length} copy item(s) · ${copied.slice(0, 3).join(" | ")}`);

    let transitions = 0;
    const mismatches: string[] = [];
    // Exercise the actual dropdowns in both directions: choosing each option
    // must show exactly the number advertised under the OTHER dimensions.
    for (const view of ["notdone", "upcoming", "done"]) {
      for (const editor of ["", "kim", "john", "__none__"]) {
        for (const due of ["any", "overdue", "undated"]) {
          for (const stage of ["all", "changes", "review", "blocked", "other"]) {
            const params = new URLSearchParams({ view, editor, due, stage });
            const html = render(params);
            for (const [key, label] of [["stage", "Filter by project stage"], ["editor", "Filter by editor"], ["due", view === "upcoming" ? "Filter by shoot date" : "Filter by due date"]]) {
              for (const option of options(html, label)) {
                const target = new URLSearchParams(params);
                target.set(key, option.value);
                const actual = rowCount(render(target));
                transitions++;
                if (actual !== option.count) mismatches.push(`${params}: ${key}=${option.value}, advertised=${option.count}, shown=${actual}`);
              }
            }
            for (const tab of html.matchAll(/<button[^>]*>(Open work|Upcoming|Completed)<span[^>]*>(\d+)/g)) {
              const target = new URLSearchParams(params);
              target.set("view", ({ "Open work": "notdone", Upcoming: "upcoming", Completed: "done" } as Record<string, string>)[tab[1]]);
              const actual = rowCount(render(target));
              transitions++;
              if (actual !== Number(tab[2])) mismatches.push(`${params}: tab=${tab[1]}, advertised=${tab[2]}, shown=${actual}`);
            }
          }
        }
      }
    }
    c.ok("every offered stage/editor/due/tab count matches its actual rendered rows", transitions > 500 && mismatches.length === 0, `${transitions} transitions; ${mismatches.slice(0, 3).join(" | ") || "no mismatches"}`);
    const empty = render("stage=changes&view=upcoming&editor=kim&due=overdue");
    c.ok("zero-match stage stays selected with All and Clear filters available", rowCount(empty) === 0 && empty.includes('value="changes" selected') && empty.includes("Changes requested (0)") && empty.includes("All stages (1)") && empty.includes("Clear filters"));
    const blocked = render("stage=blocked&view=upcoming&editor=kim&due=overdue");
    c.ok("upcoming waiting label stays honest and keeps the existing overdue fallback", rowCount(blocked) === 1 && blocked.includes("Blocked / waiting") && blocked.includes("All stages (1)") && !blocked.includes('value="overdue" selected'));
    const mixed = render("stage=review&editor=kim");
    c.ok("mixed-video row retains its exact breakdown under the chosen project stage", rowCount(mixed) === 1 && mixed.includes("1 ready for review · 2 more to edit") && mixed.includes("Individual videos may be at different stages"));
    const own = render("stage=changes&editor=john&due=overdue", true);
    c.ok("editor-owned queue ignores office owner query while keeping stage and deadline", rowCount(own) === 1 && own.includes("changes-kim Fixture Lane") && !own.includes("Filter by editor") && !own.includes("More actions"));
    c.ok("render and URL filtering invoke no providers", fence.blocked.length === 0 && fence.faked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
