/** Only these non-sensitive queue choices belong in a shareable URL. */
import { editingStageFilter } from "@/lib/editingQueueStage";
export type EditingQueueView = "notdone" | "upcoming" | "done";
export type EditingDueFilter = "any" | "overdue" | "today" | "week" | "undated";

const VIEWS = new Set<EditingQueueView>(["notdone", "upcoming", "done"]);
const DUE = new Set<EditingDueFilter>(["any", "overdue", "today", "week", "undated"]);

export function editingQueueFilters(params: URLSearchParams, editorKeys?: ReadonlySet<string>, hideEditor = false) {
  const rawView = params.get("view") as EditingQueueView | null;
  const rawDue = params.get("due") as EditingDueFilter | null;
  const rawEditor = params.get("editor");
  return {
    view: rawView && VIEWS.has(rawView) ? rawView : "notdone" as EditingQueueView,
    due: rawDue && DUE.has(rawDue) ? rawDue : "any" as EditingDueFilter,
    stage: editingStageFilter(params.get("stage")),
    editor: !hideEditor && rawEditor && /^[a-z0-9_-]{1,40}$/.test(rawEditor) &&
      (!editorKeys || editorKeys.has(rawEditor)) ? rawEditor : null,
  };
}

export function editingQueueHref(params: URLSearchParams, editorKeys?: ReadonlySet<string>, hideEditor = false) {
  const { view, due, editor, stage } = editingQueueFilters(params, editorKeys, hideEditor);
  const clean = new URLSearchParams();
  if (view !== "notdone") clean.set("view", view);
  if (editor) clean.set("editor", editor);
  if (due !== "any") clean.set("due", due);
  if (stage !== "all") clean.set("stage", stage);
  const query = clean.toString();
  return `/editing${query ? `?${query}` : ""}`;
}

/** A job only accepts queue context produced by the editing room. */
export function queueReturnHref(raw: string | undefined) {
  if (!raw || raw.length > 160) return "/editing";
  return editingQueueHref(new URLSearchParams(raw));
}
