import { z } from "zod";
import { noLongDashes, wireSchema, type PromptDef } from "./shared";

// ---------------------------------------------------------------------------
// DELIVERY_SUMMARY_V1: the 3 to 6 line plain-text QC summary for the Aryeo
// order's internal notes and the team (prompt pack 11). Haiku, text only, no
// caching. Every number is computed in code; the model only words it. Any
// failure falls back to a code-only template built from the same stats.
// Text VERBATIM from the pack (11.2, 11.3).
// ---------------------------------------------------------------------------

const SYSTEM = `You write the QC summary that Realtour Pilot staff read in the Aryeo order's internal notes and in Slack. Realtour Pilot is a premium real estate media company.

FORMAT
3 to 6 short plain-text lines, each under 160 characters. No markdown, no bullets, no emoji, no em dashes or en dashes.
Line 1: the status exactly as given in <qc_stats> (QC PASSED, QC PASSED WITH NOTES, or QC HOLD), the address, and the photo count.
Line 2: issues found by severity, then how many were fixed, ignored and still open.
Line 3: AutoHDR credits spent, plus fixes awaiting approval and their credits if any.
Lines 4 and 5 (only when there are open items): open items, most severe first, as short labels with photo positions. Group them as "Open critical:" and "Open major:"; skip MINOR items unless nothing else is open.
Last line: "Report: [QC_LINK]" exactly.

RULES
Use only the numbers and items in <qc_stats>. Never add, recompute or estimate a number. If a number is missing, leave that part out.
Keep it factual and calm. This is internal, so name issues plainly, but never include private details (names, readable document text, license plates).`;

const USER = `<qc_stats>
status: {{status}}
address: {{address}}
photoCount: {{photoCount}}
found: critical {{foundCritical}}, major {{foundMajor}}, minor {{foundMinor}}
fixed: {{fixedCount}} | ignored: {{ignoredCount}} | open: {{openCount}}
creditsSpent: {{creditsSpent}} | pendingApproval: {{pendingApprovalFixes}} fixes, {{pendingApprovalCredits}} credits
openItems (severity | label | positions):
{{openItemRows}}
</qc_stats>

Write the summary.`;

export const DELIVERY_SUMMARY_V1: PromptDef = {
  id: "DELIVERY_SUMMARY",
  version: 1,
  constName: "DELIVERY_SUMMARY_V1",
  core: null,
  slot: "SUMMARY",
  maxTokens: 500,
  temperature: 0,
  cache: false,
  shape: { thinking: "off" },
  timeoutMs: 45_000,
  startMinMs: 15_000,
  system: SYSTEM,
  userTemplate: USER,
  changelog: "v1 (2026-10-13): prompt pack 11.2 to 11.4.",
};

export const SUMMARY_TEXT = USER;
export const QC_LINK_TOKEN = "[QC_LINK]";

/** 11.4, verbatim. */
export function summaryJsonSchema() {
  return wireSchema({
    type: "object",
    additionalProperties: false,
    required: ["lines"],
    properties: {
      lines: { type: "array", items: { type: "string" }, description: "3 to 6 plain-text lines; the last is Report: [QC_LINK]" },
    },
  });
}

export const SummaryLoose = z.object({ lines: z.array(z.string()) });

/** 11.4's zod (makeSummarySchema). */
export const makeSummarySchema = (stats: { status: string; photoCount: number }) => z.object({
  lines: z.array(z.string().max(160).refine(noLongDashes, "long dash").refine((s) => !/^[*#>-]\s/.test(s), "markdown"))
    .min(3).max(6)
    .refine((l) => l[0].startsWith(stats.status.replace(/_/g, " ")), "line 1 must start with status")
    .refine((l) => l[0].includes(String(stats.photoCount)), "line 1 must include photo count")
    .refine((l) => l[l.length - 1] === "Report: [QC_LINK]", "last line must be the report link"),
});
export type SummaryOutput = z.infer<ReturnType<typeof makeSummarySchema>>;
