import { DEFAULT_TEMPLATE_IDS, renderReminder, templateForAction, type TemplateVars } from "./reminderTemplates";

// Pure UI helpers. Keep the complete JSON document as the form's source of
// truth: rebuilding it from a form schema would discard future/unknown keys.
export type PolicyObject = Record<string, unknown>;
const object = (value: unknown): value is PolicyObject => !!value && typeof value === "object" && !Array.isArray(value);

export function parsePolicyDraft(json: string): { policy: PolicyObject; error: null } | { policy: null; error: string } {
  try {
    const policy: unknown = JSON.parse(json);
    return object(policy) ? { policy, error: null } : { policy: null, error: "The policy must be a JSON object." };
  } catch {
    return { policy: null, error: "Fix the JSON in Advanced policy to use the ordinary fields. Your draft is still here." };
  }
}

export function policyField(policy: PolicyObject | null, path: readonly string[]): unknown {
  let value: unknown = policy;
  for (const key of path) value = object(value) ? value[key] : undefined;
  return value;
}

/** Changes one leaf only. Malformed parent values are refused, never replaced. */
export function updatePolicyField(json: string, path: readonly string[], value: unknown): string {
  const parsed = parsePolicyDraft(json);
  if (!parsed.policy) throw new Error(parsed.error);
  if (!path.length || path.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Unsupported policy field.");
  let parent = parsed.policy;
  for (const key of path.slice(0, -1)) {
    if (parent[key] === undefined) parent[key] = {};
    if (!object(parent[key])) throw new Error(`Fix ${key} in Advanced policy before editing its fields. Your draft has been kept.`);
    parent = parent[key];
  }
  parent[path[path.length - 1]] = value;
  return JSON.stringify(parsed.policy, null, 2);
}

/** An empty required input remains invalid; it must never silently become 0. */
export function policyNumberInput(value: string, nullable = false): number | string | null {
  if (!value.trim()) return nullable ? null : "";
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

export type PolicyValidation = { ok: boolean; errors: string[]; warnings: string[] };
export type PolicyEditorState = {
  json: string;
  savedJson: string;
  validation: { json: string; result: PolicyValidation } | null;
  feedback: { ok: boolean; text: string } | null;
};
export type PolicyEditorEvent =
  | { type: "edit"; json: string }
  | { type: "validation"; json: string; result: PolicyValidation }
  | { type: "saved"; json: string; ok: boolean; message: string }
  | { type: "error"; message: string };

export function policyEditorReducer(state: PolicyEditorState, event: PolicyEditorEvent): PolicyEditorState {
  switch (event.type) {
    case "edit": return { ...state, json: event.json, validation: null, feedback: null };
    case "validation": return { ...state, validation: { json: event.json, result: event.result } };
    case "saved": return {
      ...state,
      // A save may finish after more typing. Only the submitted snapshot is saved.
      savedJson: event.ok ? event.json : state.savedJson,
      validation: event.ok ? { json: event.json, result: { ok: true, errors: [], warnings: [] } } : state.validation,
      feedback: { ok: event.ok, text: event.message },
    };
    case "error": return { ...state, feedback: { ok: false, text: event.message } };
  }
}

export function currentPolicyValidation(state: PolicyEditorState): PolicyValidation | null {
  return state.validation?.json === state.json ? state.validation.result : null;
}

export type ReminderTemplateAction = keyof typeof DEFAULT_TEMPLATE_IDS;
export const REMINDER_ACTION_LABELS: Record<ReminderTemplateAction, string> = {
  CHOOSE_PATH: "Choose how to plan", BOOK_CALL: "Book a strategy call", COMPLETE_ANSWERS: "Finish preparation answers",
  BOOK_SESSION: "Book filming", REVIEW_WORK: "Review a cut", SCRIPTS_READY: "Scripts ready", STRATEGY_READY: "Strategy ready",
  CONFIRM_ADDRESS: "Confirm the filming address", APPROVE_SCRIPTS: "Approve scripts before filming",
};

/** Same pure renderer as sending, with fictional sample values and no links. */
export function previewPolicyTemplate(policy: PolicyObject, action: ReminderTemplateAction) {
  if (policy.templates !== undefined && !object(policy.templates)) throw new Error("Fix templates in Advanced policy to preview this message.");
  const selected = policyField(policy, ["templates", action]);
  if (selected !== undefined && typeof selected !== "string") throw new Error("Choose a valid template version to preview this message.");
  const template = templateForAction(action, policy.templates as PolicyObject | undefined);
  const quotedDay = policy.quotedPlanningDeadlineDayOfMonth;
  const vars: TemplateVars = {
    firstName: "Alex", month: "October", portalLink: "[client portal link]", bookCallLink: "[strategy call link]",
    noCallEligible: true, answersStarted: true, sessionNote: null, earliestSession: "[first eligible filming date]",
    itemCount: 1, titles: ["A local market update"], updatedTitles: [],
    deadline: typeof quotedDay === "number" ? `October ${quotedDay}` : null,
    sessionWhen: "[confirmed filming time]", areaText: "[client's general area]", addressLink: "[this session's address link]",
    sessionDay: "[confirmed filming day]", approvalDeadline: "[session time minus the saved approval lead time]",
    firstCallAtET: null, callLink: "[strategy call link]", setupMissing: ["logo", "brand colors"],
  };
  return { id: template.id, body: renderReminder(template, vars) };
}
