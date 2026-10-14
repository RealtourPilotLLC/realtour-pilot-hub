import "server-only";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { runPass } from "./qc/claude";
import { render } from "./qc/prompts/render";
import { noLongDashes, wireSchema, wordCount, type PromptDef, type Validation } from "./qc/prompts/shared";
import { ruleById } from "./registry";
import { photoDeliverySettings } from "./settings";
import { logJobEvent } from "./jobState";
import { alertOwnerAndKyle } from "./notifyOps";

// ---------------------------------------------------------------------------
// PHOTOGRAPHER COACHING NOTE (prompt pack 10, plan §12 item 3).
// After QC closes on a shoot, the findings QC put on on-site capture (and that
// staff did not overrule) become a short, kind note plus three pre-shoot
// reminders. During the first month every note is a DRAFT: Jordan approves it
// (or discards it) on the job page before it reaches the photographer. Text
// only, Sonnet, about $0.006 a shoot. Prompt text VERBATIM from the pack.
// The draft and its outcome live in the job's activity log (PhotoJobEvent
// actions coaching:draft / coaching:sent / coaching:discarded).
// ---------------------------------------------------------------------------

const SYSTEM = `You write a short coaching note to a Realtour Pilot photographer after quality control of one shoot. Realtour Pilot is a premium real estate media company, and its photographers are skilled teammates. The goal is fewer preventable on-site issues next time while keeping a great working relationship.

INPUTS
<shoot>: property street name, photo count, date. <findings>: issues QC attributed to on-site capture, grouped with counts and photo positions. <recurring_30d>: this photographer's most frequent on-site issues over the last 30 days. <strengths>: checks with no on-site issues on this shoot.

WRITE
note: at most 120 words, plain text, warm and direct, addressed to the photographer by first name.
- Open with one specific, genuine strength from <strengths> when there is one.
- Then the one to three most valuable improvements for next time, each concrete: what to check, where, and a quick habit that prevents it.
- If an issue also appears in <recurring_30d>, frame it as a current focus area, never as a repeat offense.
- Close on a positive, forward-looking line.
preShootReminders: exactly 3 short checklist lines (under 12 words each) for the next shoot, ordered by impact, drawn from this shoot and the 30-day trend.
focusRuleIds: the rule ids the note addresses.

TONE RULES
No blame language: do not write "you forgot", "you missed", "failed", "careless", "sloppy", "again", "mistake", "always" or "never". Use "next time", "quick check", "let's". No scores or counts framed as grades. Do not mention money, credits, client complaints, or other photographers. Never invent an issue or a strength; use only the inputs. If there are no on-site findings, write a brief thank-you note and three general reminders based on <recurring_30d> or standard pre-shoot habits. Do not use em dashes or en dashes.`;

const USER = `<photographer firstName="{{photographerFirstName}}" />

<shoot>
Street: {{streetName}} | Photos: {{photoCount}} | Date: {{shootDate}}
</shoot>

<findings>
ruleId | label | count | photo positions | highest severity
{{photographerFindingRows}}
</findings>

<recurring_30d>
ruleId | label | shoots affected | of shoots
{{recurringRows}}
</recurring_30d>

<strengths>
{{strengthsList}}
</strengths>

Write the coaching note.`;

export const COACHING_NOTE_V1: PromptDef = {
  id: "COACHING_NOTE",
  version: 1,
  constName: "COACHING_NOTE_V1",
  core: null,
  slot: "COACHING",
  maxTokens: 800,
  temperature: 0.3,
  cache: false,
  shape: { thinking: "off" },
  timeoutMs: 60_000,
  startMinMs: 20_000,
  system: SYSTEM,
  userTemplate: USER,
  changelog: "v1 (2026-10-14): prompt pack 10.2 to 10.4.",
};

const BLAME = /\b(you forgot|you missed|failed|careless|sloppy|again|mistake|always|never)\b/i;
export type CoachingOutput = { note: string; preShootReminders: string[]; focusRuleIds: string[] };

export function validateCoaching(raw: unknown, ruleIds: Set<string>): Validation<CoachingOutput> {
  const schema = z.object({
    note: z.string().min(10)
      .refine((s) => wordCount(s) <= 120, "note over 120 words: shorten it")
      .refine((s) => !BLAME.test(s), "blame language: rephrase without it")
      .refine(noLongDashes, "remove em and en dashes"),
    preShootReminders: z.array(z.string().refine((s) => wordCount(s) < 12, "a reminder is 12 words or more").refine(noLongDashes, "remove dashes")).length(3),
    focusRuleIds: z.array(z.string()),
  });
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  const coerced: string[] = [];
  const focus = r.data.focusRuleIds.filter((id) => ruleIds.has(id));
  if (focus.length !== r.data.focusRuleIds.length) coerced.push("focusRuleIds: dropped ids not in this shoot's findings");
  return { ok: true, value: { ...r.data, focusRuleIds: focus }, coerced };
}

/** Draft the note for one job (once per QC run). Returns null when there is nothing to do. */
export async function draftCoachingNote(jobId: string): Promise<{ drafted: boolean; reason: string }> {
  const job = await prisma.photoJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true, lastQcRunId: true } });
  if (!job?.lastQcRunId) return { drafted: false, reason: "no QC run" };
  const already = await prisma.photoJobEvent.findFirst({ where: { jobId, action: { startsWith: "coaching:" }, dataJson: { contains: job.lastQcRunId } }, select: { id: true } });
  if (already) return { drafted: false, reason: "already drafted for this QC run" };
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { title: true, shootDate: true, photographerId: true } });
  if (!project?.photographerId) return { drafted: false, reason: "no photographer on the job" };
  const shooter = await prisma.teamMember.findUnique({ where: { id: project.photographerId }, select: { id: true, name: true } });
  if (!shooter) return { drafted: false, reason: "photographer not found" };
  const settings = await photoDeliverySettings();

  const photos = await prisma.photoAsset.findMany({ where: { jobId, status: "ACTIVE" }, orderBy: { sequence: "asc" }, select: { id: true } });
  const position = new Map(photos.map((p, i) => [p.id, i + 1]));
  const findings = await prisma.photoQcFinding.findMany({
    where: { jobId, qcRunId: job.lastQcRunId, responsibility: "PHOTOGRAPHER", confidence: { gte: settings.displayConfidenceFloor }, status: { notIn: ["FALSE_POSITIVE", "OVERRIDDEN", "SUPERSEDED"] } },
    select: { ruleId: true, severity: true, photoId: true },
  });
  const byRule = new Map<string, { count: number; positions: number[]; worst: string }>();
  const rank = (s: string) => (s === "CRITICAL" ? 3 : s === "MAJOR" ? 2 : 1);
  for (const f of findings) {
    const e = byRule.get(f.ruleId) ?? { count: 0, positions: [], worst: f.severity };
    e.count++;
    if (f.photoId && position.has(f.photoId)) e.positions.push(position.get(f.photoId)!);
    if (rank(f.severity) > rank(e.worst)) e.worst = f.severity;
    byRule.set(f.ruleId, e);
  }
  // The photographer's last 30 days of on-site findings, by shoot.
  const since = new Date(Date.now() - 30 * 86_400_000);
  const theirProjects = await prisma.project.findMany({ where: { photographerId: shooter.id, shootDate: { gte: since } }, select: { id: true } });
  const theirJobs = await prisma.photoJob.findMany({ where: { projectId: { in: theirProjects.map((p) => p.id) } }, select: { id: true } });
  const recent = await prisma.photoQcFinding.findMany({
    where: { jobId: { in: theirJobs.map((j) => j.id) }, responsibility: "PHOTOGRAPHER", confidence: { gte: settings.displayConfidenceFloor }, status: { notIn: ["FALSE_POSITIVE", "OVERRIDDEN", "SUPERSEDED"] } },
    select: { ruleId: true, jobId: true },
  });
  const shootsByRule = new Map<string, Set<string>>();
  for (const f of recent) shootsByRule.set(f.ruleId, (shootsByRule.get(f.ruleId) ?? new Set()).add(f.jobId));
  const recurring = [...shootsByRule.entries()].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  // Strengths: the photographer-owned checklist sections with nothing on this shoot.
  const SECTIONS: { label: string; prefixes: string[] }[] = [
    { label: "No camera, tripod or photographer reflections", prefixes: ["REFL_CAMERA", "REFL_PHOTOGRAPHER", "REFL_DRONE"] },
    { label: "Straight verticals and natural perspective", prefixes: ["PERSP_"] },
    { label: "Bathrooms prepared (lids down, toiletries away)", prefixes: ["BATH_"] },
    { label: "Kitchens clear of clutter", prefixes: ["KIT_"] },
    { label: "Exteriors clear of hoses, bins and cars", prefixes: ["EXT_"] },
    { label: "Sharp, well-focused frames", prefixes: ["COMP_BLURRY", "COMP_POOR_FOCUS", "COMP_CAMERA_SHAKE"] },
  ];
  const ruleIdsHere = [...byRule.keys()];
  const strengths = photos.length ? SECTIONS.filter((s) => !ruleIdsHere.some((id) => s.prefixes.some((p) => id.startsWith(p)))).map((s) => s.label) : [];

  const vars = {
    photographerFirstName: shooter.name.split(" ")[0] || shooter.name,
    streetName: (project.title || "the listing").split(",")[0],
    photoCount: photos.length,
    shootDate: project.shootDate ? project.shootDate.toISOString().slice(0, 10) : "unavailable",
    photographerFindingRows: byRule.size
      ? [...byRule.entries()].map(([id, e]) => `${id} | ${ruleById(id)?.shortLabel ?? id} | ${e.count} | ${e.positions.sort((a, b) => a - b).join(", ") || "n/a"} | ${e.worst}`).join("\n")
      : "none",
    recurringRows: recurring.length ? recurring.map(([id, s]) => `${id} | ${ruleById(id)?.shortLabel ?? id} | ${s.size} | ${theirJobs.length}`).join("\n") : "none",
    strengthsList: strengths.length ? strengths.join("\n") : "unavailable",
  };
  const ruleIds = new Set([...byRule.keys(), ...recurring.map(([id]) => id)]);
  const text = render(USER, vars);
  const outcome = await runPass<CoachingOutput, Set<string>>({
    def: COACHING_NOTE_V1,
    label: `coaching ${jobId.slice(-6)}`,
    schema: () =>
      wireSchema({
        type: "object",
        additionalProperties: false,
        required: ["note", "preShootReminders", "focusRuleIds"],
        properties: {
          note: { type: "string", description: "At most 120 words, plain text." },
          preShootReminders: { type: "array", items: { type: "string" }, description: "Exactly 3 lines, under 12 words each." },
          focusRuleIds: { type: "array", items: { type: "string" } },
        },
      }),
    validate: (raw, ids) => validateCoaching(raw, ids),
    prepare: async () => ({ images: [], text, ctx: ruleIds }),
  });
  if (!outcome.ok) {
    // "coaching:failed" carries the run id, so this run is not retried every tick.
    await logJobEvent(jobId, "coaching", "coaching:failed", { qcRunId: job.lastQcRunId, reason: outcome.reason });
    return { drafted: false, reason: outcome.reason };
  }
  await logJobEvent(jobId, "coaching", "coaching:draft", {
    qcRunId: job.lastQcRunId,
    photographerId: shooter.id,
    photographerName: shooter.name,
    note: outcome.value.note,
    preShootReminders: outcome.value.preShootReminders,
    focusRuleIds: outcome.value.focusRuleIds,
    model: outcome.model,
  });
  await alertOwnerAndKyle({
    kind: "photo_coaching_draft",
    title: `Coaching note ready for ${shooter.name.split(" ")[0]}`.slice(0, 90),
    body: `${vars.streetName}: approve or discard before it is sent.`,
    href: `/ops/photo-delivery/${jobId}`,
    dedupeKey: `pd-coaching-${job.lastQcRunId}`,
    text: `A coaching note for ${shooter.name.split(" ")[0]} (${vars.streetName}) is ready for your approval.`,
    to: "owner",
  });
  return { drafted: true, reason: "drafted" };
}

export type CoachingDraft = { eventId: string; at: Date; photographerId: string; photographerName: string; note: string; preShootReminders: string[]; status: "draft" | "sent" | "discarded" };

/** The latest coaching note on a job and what happened to it. */
export async function coachingFor(jobId: string): Promise<CoachingDraft | null> {
  const events = await prisma.photoJobEvent.findMany({ where: { jobId, action: { in: ["coaching:draft", "coaching:sent", "coaching:discarded"] } }, orderBy: { at: "desc" }, take: 10 });
  const draft = events.find((e) => e.action === "coaching:draft");
  if (!draft?.dataJson) return null;
  const d = JSON.parse(draft.dataJson) as { photographerId: string; photographerName: string; note: string; preShootReminders: string[] };
  const after = events.find((e) => e.at >= draft.at && e.action !== "coaching:draft");
  return { eventId: draft.id, at: draft.at, photographerId: d.photographerId, photographerName: d.photographerName, note: d.note, preShootReminders: d.preShootReminders, status: after?.action === "coaching:sent" ? "sent" : after?.action === "coaching:discarded" ? "discarded" : "draft" };
}

/** Owner approves (optionally edited) → Slack DM / text to the photographer. */
export async function sendCoachingNote(jobId: string, by: string, edited?: { note?: string; preShootReminders?: string[] }): Promise<{ ok: boolean; message: string }> {
  const c = await coachingFor(jobId);
  if (!c) return { ok: false, message: "No coaching note to send." };
  if (c.status !== "draft") return { ok: false, message: `This note was already ${c.status}.` };
  const note = (edited?.note ?? c.note).replace(/\s*[–—]\s*/g, ", ").trim();
  const reminders = (edited?.preShootReminders ?? c.preShootReminders).slice(0, 3).map((r) => r.replace(/\s*[–—]\s*/g, ", ").trim()).filter(Boolean);
  if (!note) return { ok: false, message: "The note is empty." };
  const text = `${note}\n\nBefore your next shoot:\n${reminders.map((r) => `- ${r}`).join("\n")}`;
  const { notifyStaffSms } = await import("@/lib/notify");
  const out = await notifyStaffSms([c.photographerId], text, "photo_coaching_note");
  await logJobEvent(jobId, by, "coaching:sent", { draftEventId: c.eventId, outcome: out[0]?.outcome ?? null, edited: !!edited });
  return { ok: true, message: `Sent to ${c.photographerName.split(" ")[0]} (${out[0]?.outcome ?? "queued"}).` };
}

export async function discardCoachingNote(jobId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const c = await coachingFor(jobId);
  if (!c || c.status !== "draft") return { ok: false, message: "No draft to discard." };
  await logJobEvent(jobId, by, "coaching:discarded", { draftEventId: c.eventId });
  return { ok: true, message: "Discarded." };
}

/** Cron: draft notes for jobs whose QC finished since the last pass. */
export async function draftPendingCoaching(max = 3): Promise<{ drafted: number; checked: number }> {
  const settings = await photoDeliverySettings();
  if (!settings.qcEnabled) return { drafted: 0, checked: 0 };
  // Oct 14 2026: not after the free photo check (it is free; a coaching draft
  // is a Claude call). The paid QC's runs only.
  const recentRuns = await prisma.photoQcRun.findMany({ where: { status: "DONE", trigger: { not: "AUTOHDR_CHECK" }, finishedAt: { gte: new Date(Date.now() - 2 * 86_400_000) } }, orderBy: { finishedAt: "desc" }, select: { id: true, jobId: true }, take: 20 });
  let drafted = 0, checked = 0;
  for (const r of recentRuns) {
    if (drafted >= max) break;
    const job = await prisma.photoJob.findUnique({ where: { id: r.jobId }, select: { lastQcRunId: true } });
    if (job?.lastQcRunId !== r.id) continue;
    checked++;
    const d = await draftCoachingNote(r.jobId).catch((e) => ({ drafted: false, reason: (e as Error).message }));
    if (d.drafted) drafted++;
  }
  return { drafted, checked };
}
