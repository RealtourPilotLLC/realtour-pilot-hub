export type ContentControlResult = { ok: boolean; message: string; outcome?: "confirmed" | "refused" | "unknown" };
export type ContentControlOutcome = "confirmed" | "refused" | "unknown";
export const contentControlOutcome = (result: ContentControlResult): ContentControlOutcome =>
  result.ok && result.outcome === "confirmed" ? "confirmed" : !result.ok && result.outcome === "refused" ? "refused" : "unknown";

export type IdentityFields = { title: string; topicId: string; scriptId: string; kind: string };
export type IdentityField = keyof IdentityFields;
export type ConfirmedIdentityDraft = { draft: IdentityFields; fields: IdentityField[] };
const fields: IdentityField[] = ["title", "topicId", "scriptId", "kind"];
const storedValue = (field: IdentityField, value: string) => field === "title" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : value;

/** Refresh untouched fields; keep exact edited text when the same field diverges. */
export function reconcileIdentityFields(draft: IdentityFields, baseline: IdentityFields, incoming: IdentityFields, confirmed: ConfirmedIdentityDraft | null = null) {
  const next = { ...draft }, conflicts: IdentityField[] = [];
  for (const field of fields) {
    const confirmedMatch = confirmed?.fields.includes(field) && draft[field] === confirmed.draft[field] && storedValue(field, incoming[field]) === storedValue(field, confirmed.draft[field]);
    if (confirmedMatch || draft[field] === baseline[field]) next[field] = incoming[field];
    else if (incoming[field] !== baseline[field]) conflicts.push(field);
  }
  return { draft: next, baseline: { ...incoming }, conflicts, sourceChanged: fields.some((field) => incoming[field] !== baseline[field]), confirmedApplied: !!confirmed && confirmed.fields.every((field) => storedValue(field, incoming[field]) === storedValue(field, confirmed.draft[field])) };
}

/** A correction contains only actual edits after current source reconciliation. */
export function identityCorrectionPatch(draft: IdentityFields, baseline: IdentityFields) {
  return {
    ...(storedValue("title", draft.title) !== storedValue("title", baseline.title) ? { title: draft.title.trim() } : {}),
    ...(draft.topicId !== baseline.topicId ? { topicId: draft.topicId || null } : {}),
    ...(draft.scriptId !== baseline.scriptId ? { scriptId: draft.scriptId || null } : {}),
    ...(draft.kind !== baseline.kind ? { kind: draft.kind } : {}),
  };
}
