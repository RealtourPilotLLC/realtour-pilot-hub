// ---------------------------------------------------------------------------
// THE TEMPLATE RENDERER AND THE UNTRUSTED-TEXT SANITIZER (prompt pack 0.6).
//
//   · `{{placeholders}}` are filled by a strict renderer: a variable the code
//     forgot to pass is a programming error and THROWS, so a half-rendered
//     prompt can never reach the model.
//   · Missing DATA (null, undefined, empty string) renders as the literal word
//     "unavailable", never an empty string, so the model can say which checks
//     it had to skip and why.
//   · No logic in templates: lists are pre-formatted in code.
//   · Untrusted free text (client QC profile notes, Aryeo special instructions,
//     staff reasons, filenames) is sanitized before it is rendered: control
//     characters stripped, `<` and `>` removed so it cannot close our wrapper
//     tags, whitespace collapsed, 2,000 characters per field at most. The
//     prompts themselves tell the model this text is reference data.
//
// Pure: no I/O, safe to import anywhere (the drills exercise it directly).
// ---------------------------------------------------------------------------

export class TemplateError extends Error {}

export type TemplateValue = string | number | boolean | null | undefined;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** The placeholder names a template uses, in order of first appearance. */
export function templateVars(template: string): string[] {
  const seen: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/**
 * Render `template` with `vars`. Throws TemplateError naming every variable the
 * caller did not pass at all; renders null / undefined / "" as "unavailable".
 * Single pass: a value that itself contains `{{x}}` is never re-expanded.
 */
export function render(template: string, vars: Record<string, TemplateValue>): string {
  const missing = templateVars(template).filter((k) => !Object.prototype.hasOwnProperty.call(vars, k));
  if (missing.length) throw new TemplateError(`template variables not provided: ${missing.join(", ")}`);
  return template.replace(PLACEHOLDER, (_m, key: string) => {
    const v = vars[key];
    if (v === null || v === undefined) return "unavailable";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "unavailable";
    const s = String(v);
    return s.trim() === "" ? "unavailable" : s;
  });
}

// C0 and C1 control characters except plain whitespace, which is collapsed below.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Prepare untrusted free text for a prompt (0.6). Returns "" for nothing (the
 * renderer turns that into "unavailable").
 */
export function sanitizeUntrusted(text: string | null | undefined, max = 2000): string {
  if (!text) return "";
  return String(text)
    .replace(CONTROL, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Em and en dashes never appear in text staff read (Jordan's standing rule). */
export function stripLongDashes(s: string): string {
  return s.replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/,\s*,/g, ",");
}

export function hasLongDash(s: string): boolean {
  return /[\u2013\u2014]/.test(s);
}

/** Fixed-precision number for prompts; null when not a finite number. */
export function fmtNum(n: number | null | undefined, digits = 1): string | null {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : null;
}

export function yesNo(b: boolean | null | undefined): string | null {
  return b === true ? "yes" : b === false ? "no" : null;
}
