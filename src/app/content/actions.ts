"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { contentProgramSweep, PACKAGE_RULES } from "@/lib/contentProgram";

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

// Re-run enrollment/month/project sync on demand (the cron also runs it nightly).
export async function runProgramSweep(): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const r = await contentProgramSweep();
  revalidatePath("/content");
  return { ok: true, message: `Synced — ${r.created} enrolled, ${r.monthsCreated} months created, ${r.projectsAttached} shoots attached.` };
}

// ---------------------------------------------------------------------------
// Enrollment settings (package override + per-client workflow flags, spec §3)
// ---------------------------------------------------------------------------
export async function saveEnrollmentSettings(
  enrollmentId: string,
  s: { package?: string; strategyCallRequired?: boolean; clientSuppliesTopics?: boolean; status?: string; notes?: string },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const data: Record<string, unknown> = {};
  if (s.package !== undefined) {
    const rules = PACKAGE_RULES[s.package];
    if (!rules) return { ok: false, message: "Unknown package." };
    // A hand-set package is an override — the Aryeo sync must stop following the plan field.
    Object.assign(data, { package: s.package, ...rules, packageSource: "manual" });
  }
  if (s.strategyCallRequired !== undefined) data.strategyCallRequired = s.strategyCallRequired;
  if (s.clientSuppliesTopics !== undefined) data.clientSuppliesTopics = s.clientSuppliesTopics;
  if (s.status !== undefined && ["ACTIVE", "PAUSED", "ENDED"].includes(s.status)) data.status = s.status;
  if (s.notes !== undefined) data.notes = s.notes.trim().slice(0, 4000) || null;
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data });
  revalidatePath("/content");
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// Month state (strategy-call status until the Phase-3 StrategyCall model)
// ---------------------------------------------------------------------------
const CALL_STATUSES = ["NOT_REQUIRED", "NOT_SCHEDULED", "SCHEDULED", "COMPLETED", "SKIPPED"];
export async function setStrategyCallStatus(monthId: string, status: string, at?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!CALL_STATUSES.includes(status)) return { ok: false, message: "Unknown status." };
  await prisma.contentMonth.update({
    where: { id: monthId },
    data: { strategyCallStatus: status, strategyCallAt: at ? new Date(at) : status === "NOT_SCHEDULED" ? null : undefined },
  });
  revalidatePath("/content");
  return { ok: true, message: "Updated." };
}

export async function saveMonthTranscript(monthId: string, text: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  await prisma.contentMonth.update({
    where: { id: monthId },
    data: { transcriptText: text.trim().slice(0, 500_000) || null, strategyCallStatus: text.trim() ? "COMPLETED" : undefined },
  });
  revalidatePath("/content");
  return { ok: true, message: "Transcript saved. Extraction lands in the next build phase." };
}

// ---------------------------------------------------------------------------
// Topic bank
// ---------------------------------------------------------------------------
export async function addTopic(
  enrollmentId: string,
  t: { title: string; concept?: string; pillar?: string; monthId?: string | null; source?: string },
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const title = t.title.trim().slice(0, 200);
  if (!title) return { ok: false, message: "Give the topic a title." };
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) return { ok: false, message: "Enrollment not found." };
  await prisma.contentTopic.create({
    data: {
      enrollmentId, clientId: e.clientId, title,
      concept: t.concept?.trim().slice(0, 2000) || null,
      pillar: t.pillar?.trim().slice(0, 120) || null,
      monthId: t.monthId ?? null,
      status: t.monthId ? "SELECTED" : "IDEA",
      source: t.source && ["ai", "client", "strategy_call", "staff", "import"].includes(t.source) ? t.source : "staff",
    },
  });
  revalidatePath("/content");
  return { ok: true, message: "Topic added." };
}

export async function setTopicStatus(topicId: string, status: string, monthId?: string | null): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const OK = ["IDEA", "RECOMMENDED", "SAVED", "SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED", "REJECTED", "ARCHIVED"];
  if (!OK.includes(status)) return { ok: false, message: "Unknown status." };
  await prisma.contentTopic.update({
    where: { id: topicId },
    data: { status, ...(monthId !== undefined ? { monthId } : {}) },
  });
  revalidatePath("/content");
  return { ok: true, message: "Updated." };
}

// ---------------------------------------------------------------------------
// Agent profile — six JSON sections, each a labeled free-form field set.
// ---------------------------------------------------------------------------
const PROFILE_SECTIONS = ["brandJson", "voiceJson", "contentPrefsJson", "productionJson", "editingJson", "storiesJson"] as const;
export async function saveProfileSection(clientId: string, section: string, values: Record<string, string>): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!(PROFILE_SECTIONS as readonly string[]).includes(section)) return { ok: false, message: "Unknown section." };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const key = k.trim().slice(0, 80);
    const val = (v ?? "").trim().slice(0, 4000);
    if (key && val) clean[key] = val;
  }
  await prisma.agentProfile.upsert({
    where: { clientId },
    create: { clientId, [section]: JSON.stringify(clean) },
    update: { [section]: JSON.stringify(clean) },
  });
  revalidatePath("/content");
  return { ok: true, message: "Profile saved." };
}

// ---------------------------------------------------------------------------
// Notes (intelligence flag = feeds AI context later; plain notes never do)
// ---------------------------------------------------------------------------
export async function addContentNote(clientId: string, body: string, intelligence: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const text = body.trim().slice(0, 8000);
  if (!text) return { ok: false, message: "Write the note first." };
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  await prisma.contentNote.create({ data: { clientId, body: text, intelligence, authorName: me?.name ?? null } });
  revalidatePath("/content");
  return { ok: true, message: "Note added." };
}

// ---------------------------------------------------------------------------
// Script backfill — Jordan: "I supply the PDF or Word Doc, select the month,
// and it automatically adds. OR you can read the scripts and see the main
// title in the document is for X month."
//
// Flow: upload → extract text (pdf-parse / mammoth) → AI splits the document
// into individual scripts and proposes a month → staff confirms → save.
// Nothing is client-visible; these are internal records for history + AI.
// ---------------------------------------------------------------------------
export type ExtractedScript = { title: string; body: string; hook?: string | null };
export type BackfillPreview = { ok: boolean; message: string; monthGuess?: string | null; scripts?: ExtractedScript[]; sourceFile?: string };

export async function previewScriptBackfill(form: FormData): Promise<BackfillPreview> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, message: "No file." };
  if (file.size > 15 * 1024 * 1024) return { ok: false, message: "File too large (max 15 MB)." };

  let text = "";
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    if (/\.pdf$/i.test(file.name)) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const r = await parser.getText();
        text = r.text ?? "";
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else if (/\.docx$/i.test(file.name)) {
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (/\.(txt|md)$/i.test(file.name)) {
      text = buf.toString("utf-8");
    } else {
      return { ok: false, message: "Use a PDF, Word (.docx), or text file." };
    }
  } catch (e) {
    return { ok: false, message: `Couldn't read the file: ${e instanceof Error ? e.message : "unknown error"}` };
  }
  text = text.trim();
  if (!text) return { ok: false, message: "The file has no readable text." };

  // AI splits the document into scripts + proposes the month from titles/dates.
  try {
    const { aiJson } = await import("@/lib/integrations/ai");
    const out = await aiJson<{ monthKey: string | null; scripts: { title: string; hook: string | null; body: string }[] }>({
      system:
        "You are indexing a real-estate agent's short-form video scripts for an archive. " +
        "Split the document into its individual scripts. Keep each script's text VERBATIM — do not rewrite, summarize, or improve. " +
        "A script's title is its heading or, absent one, its first line/hook. " +
        "If the document names a month (e.g. 'September Scripts', 'Content for March 2026'), return it as monthKey in YYYY-MM form; " +
        "if the year is missing, assume the most plausible recent year. Otherwise monthKey must be null.",
      prompt: text.slice(0, 100_000),
      maxTokens: 16_000,
      schema: {
        type: "object",
        properties: {
          monthKey: { type: ["string", "null"], description: "YYYY-MM the document's scripts are for, or null" },
          scripts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                hook: { type: ["string", "null"] },
                body: { type: "string", description: "the script text, verbatim" },
              },
              required: ["title", "body"],
            },
          },
        },
        required: ["monthKey", "scripts"],
      },
    });
    const scripts = (out.scripts ?? [])
      .filter((s) => s.body?.trim())
      .map((s) => ({ title: (s.title || s.body.slice(0, 60)).trim().slice(0, 200), hook: s.hook?.trim() || null, body: s.body.trim().slice(0, 20_000) }));
    if (scripts.length === 0) return { ok: false, message: "No scripts found in the document." };
    return { ok: true, message: `Found ${scripts.length} script${scripts.length === 1 ? "" : "s"}.`, monthGuess: out.monthKey ?? null, scripts, sourceFile: file.name };
  } catch {
    // AI unavailable → the whole document becomes one script; staff set the month.
    return { ok: true, message: "Imported as one script (AI split unavailable).", monthGuess: null, scripts: [{ title: file.name.replace(/\.[^.]+$/, ""), body: text.slice(0, 20_000), hook: null }], sourceFile: file.name };
  }
}

export async function saveScriptBackfill(
  enrollmentId: string,
  monthKey: string,
  scripts: ExtractedScript[],
  sourceFile: string,
): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return { ok: false, message: "Pick the month first." };
  if (!scripts.length) return { ok: false, message: "Nothing to save." };
  const e = await prisma.contentEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { clientId: true, videosPerMonth: true, strategyCallRequired: true },
  });
  if (!e) return { ok: false, message: "Enrollment not found." };

  // Find-or-create the month; a backfilled past month is historical by design.
  const { etMonthKey } = await import("@/lib/contentProgram");
  let month = await prisma.contentMonth.findUnique({
    where: { enrollmentId_monthKey: { enrollmentId, monthKey } },
    select: { id: true },
  });
  if (!month) {
    month = await prisma.contentMonth.create({
      data: {
        enrollmentId, clientId: e.clientId, monthKey,
        videosOwed: e.videosPerMonth,
        strategyCallStatus: e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
        ...(monthKey < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}),
      },
      select: { id: true },
    });
  }
  for (const s of scripts) {
    await prisma.contentScript.create({
      data: {
        enrollmentId, clientId: e.clientId, monthId: month.id,
        title: s.title.slice(0, 200),
        body: s.body.slice(0, 20_000),
        sectionsJson: s.hook ? JSON.stringify({ hook: s.hook }) : null,
        status: "APPROVED", // history — it was already used
        source: "import",
        sourceFile: sourceFile.slice(0, 200),
      },
    });
  }
  revalidatePath("/content");
  return { ok: true, message: `Saved ${scripts.length} script${scripts.length === 1 ? "" : "s"} to ${monthKey}.` };
}
