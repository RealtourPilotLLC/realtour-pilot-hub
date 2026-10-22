import "server-only";
import { prisma } from "@/lib/prisma";
import { type VideoStyle, VIDEO_STYLE_LABEL, VIDEO_STYLE_OVERRIDE_KEY, videoStyleFromOverrides } from "@/lib/contentPolicy/prompts";
import { SKITS_PER_MONTH_KEY, SKIT_CAST_KEY, MAX_SKIT_CAST, clampSkitsPerMonth, cleanCastMember, skitCastFromOverrides, skitsPerMonthFromOverrides, castMemberLabel, type SkitCastMember } from "@/lib/contentPolicy/videoFormat";

// ---------------------------------------------------------------------------
// PROGRAM STYLE, PER CLIENT (Oct 8 2026) — two switches on the client file.
//
// Jordan: "Mike Ciunci does not do strategy calls, so I'd like the option to
// turn that off for select clients … Mike comes up with his own video topics,
// ideas, scripts, etc, so Mike is really a we-show-up-and-shoot kind of deal."
//
//   STRATEGY CALLS (on | off). Off is the existing call mode NOT_INCLUDED
//     (strategyCallRequired=false, noCallEligible cleared): months read the
//     call NOT_REQUIRED by rule (programMonths), the portal shows no call step
//     and the reminders never ask for one. On puts back what the client had
//     before it was switched off — the explicit mode recorded in the ledger,
//     or the program default (the first call required, later months may be
//     planned in writing) when there was none.
//   CLIENT PLANS THEIR OWN CONTENT (ContentEnrollment.clientSuppliesTopics).
//     On: no topics, topic bank, questions, answers or scripts are asked of
//     them or written by us (every generator refuses — CLIENT_PLANNED_REFUSAL
//     — and the sweeps skip them); the month is ready to film from the start,
//     with no planning gate; the portal month is "add your brief (optional) →
//     book filming"; office and editor screens say "Client-planned".
//
// Both are ledgered (ProgramEnrollmentChange) and re-derive the open months.
// Nothing here messages a client, books or talks to a provider.
// ---------------------------------------------------------------------------

export const CLIENT_PLANNED_REFUSAL = "This client plans their own content, so we don't write topics, questions or scripts for them. Turn that off in Settings › Program style first.";

/** The client plans their own content ("we show up and shoot"). */
export async function clientPlansOwnContent(enrollmentId: string): Promise<boolean> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientSuppliesTopics: true } });
  return !!e?.clientSuppliesTopics;
}

/** Throws CLIENT_PLANNED_REFUSAL for a client who plans their own content. Every topic/question/script generator calls it first. */
export async function assertWeWriteFor(enrollmentId: string): Promise<void> {
  if (await clientPlansOwnContent(enrollmentId)) {
    const err = new Error(CLIENT_PLANNED_REFUSAL);
    err.name = "ClientPlannedError";
    throw err;
  }
}

export type ProgramStyle = { strategyCalls: boolean; clientPlanned: boolean };

/** Calls are "on" unless the explicit (or legacy-derived) mode is NOT_INCLUDED. */
export function programStyleOf(e: { callMode: string | null; strategyCallRequired: boolean; clientSuppliesTopics: boolean }): ProgramStyle {
  const mode = e.callMode === "REQUIRED" || e.callMode === "OPTIONAL_WRITTEN" || e.callMode === "NOT_INCLUDED" ? e.callMode : e.strategyCallRequired ? "REQUIRED" : "NOT_INCLUDED";
  return { strategyCalls: mode !== "NOT_INCLUDED", clientPlanned: e.clientSuppliesTopics };
}

/**
 * Strategy calls on/off. Returns what was written, for the reply line.
 * Off → call mode NOT_INCLUDED (setCallMode keeps strategyCallRequired in step).
 * On  → the mode the client had before the last switch-off, else the program default.
 */
export async function setStrategyCalls(enrollmentId: string, on: boolean, by: string | null): Promise<{ changed: boolean; mode: string }> {
  const { setCallMode, recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
  const { recalcProgramMonthsForEnrollment } = await import("@/lib/programMonths");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, clientId: true, callMode: true, strategyCallRequired: true, noCallEligible: true, clientSuppliesTopics: true } });
  if (!e) throw new Error("Enrollment not found.");
  const style = programStyleOf(e);
  if (!on) {
    // Already off — explicitly, or by the legacy flag (strategyCallRequired=false, no column): nothing to write.
    if (!style.strategyCalls) return { changed: false, mode: "NOT_INCLUDED" };
    await setCallMode(enrollmentId, "NOT_INCLUDED", null, by, "Strategy calls turned off for this client (Program style).");
    return { changed: true, mode: "NOT_INCLUDED" };
  }
  if (style.strategyCalls) return { changed: false, mode: e.callMode ?? "default" };
  // What it was before the last switch-off: the newest callMode change INTO
  // NOT_INCLUDED names it in `fromValue` ("REQUIRED", or "REQUIRED (derived)").
  const last = await prisma.programEnrollmentChange.findFirst({
    where: { enrollmentId, field: "callMode", toValue: JSON.stringify("NOT_INCLUDED") },
    orderBy: { createdAt: "desc" }, select: { fromValue: true },
  });
  let before: string | null = null;
  try { before = last?.fromValue ? (JSON.parse(last.fromValue) as string | null) : null; } catch { before = null; }
  if (before === "REQUIRED" || before === "OPTIONAL_WRITTEN") {
    await setCallMode(enrollmentId, before, null, by, "Strategy calls turned back on (Program style) — the call requirement it had before.");
    return { changed: true, mode: before };
  }
  // The program default: no explicit column, the legacy flag on — the first
  // call is required, later months may be planned in writing (§3).
  const now = new Date();
  const { etMonthKey } = await import("@/lib/contentProgram");
  const base = { enrollmentId, clientId: e.clientId, effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: by, appliedAt: now, reason: "Strategy calls turned back on (Program style) — the program default." } as const;
  if (e.callMode !== null) await recordEnrollmentChange({ ...base, field: "callMode", from: e.callMode, to: null });
  if (!e.strategyCallRequired) await recordEnrollmentChange({ ...base, field: "strategyCallRequired", from: false, to: true });
  if (e.noCallEligible !== null) await recordEnrollmentChange({ ...base, field: "noCallEligible", from: e.noCallEligible, to: null });
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { callMode: null, strategyCallRequired: true, noCallEligible: null } });
  await recalcProgramMonthsForEnrollment(enrollmentId).catch(() => []);
  return { changed: true, mode: "default" };
}

/** Client plans their own content on/off (ledgered through setWorkflowFlags), then re-derive the open months. */
export async function setClientPlanned(enrollmentId: string, on: boolean, by: string | null): Promise<{ changed: boolean }> {
  const { setWorkflowFlags } = await import("@/lib/enrollmentChanges");
  const { recalcProgramMonthsForEnrollment } = await import("@/lib/programMonths");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientSuppliesTopics: true } });
  if (!e) throw new Error("Enrollment not found.");
  if (e.clientSuppliesTopics === on) return { changed: false };
  await setWorkflowFlags(enrollmentId, { clientSuppliesTopics: on }, by);
  await recalcProgramMonthsForEnrollment(enrollmentId).catch(() => []);
  return { changed: true };
}

// ---------------------------------------------------------------------------
// VIDEO STYLE (Oct 13 2026), the third Program style setting.
//
// Jordan: "Some clients, like Janice Pigga, Joe Sutow, and Mike Flatley,
// prefer more creative, skit-style videos ... there should be different
// settings for the accounts. Direct-to-camera or Skits."
//
//   DIRECT ("Direct-to-camera", the default): today's scripts and topics.
//   SKITS ("Skits"): every script draft and revision is a short comedic scene
//     inside the same house framework, the client alone on camera by default,
//     and topic suggestions are skit concepts (contentPolicy/prompts.ts).
//
// No column: it lives in ContentEnrollment.overridesJson as `videoStyle`, and
// a missing value is DIRECT. The change is ledgered (ProgramEnrollmentChange,
// field "overrides") with who made it. Nothing here messages anyone or touches
// a script already written.
//
// Oct 22 2026 (Bernadette Rabel's call): a third choice, MIX ("Mix"): a
// target number of skits a month (`skitsPerMonth`, 2 unless the office types
// another), the rest talking to camera. The style is now the DEFAULT for a
// topic with no format of its own; each topic can be switched on its card
// (contentTopics.setTopicFormat). And the SKIT CAST (`skitCast`): people the
// client confirmed may act in their skits (setSkitCast below).
// ---------------------------------------------------------------------------

export { type VideoStyle, VIDEO_STYLE_LABEL, asVideoStyle, videoStyleFromOverrides } from "@/lib/contentPolicy/prompts";

/** The account's video style; DIRECT when nothing is set. */
export async function videoStyleOf(enrollmentId: string): Promise<VideoStyle> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  return videoStyleFromOverrides(e?.overridesJson ?? null);
}

/**
 * Set the account's video style. DIRECT removes the key (the default), SKITS
 * writes it. Compare-and-swap on the whole bag, like the catch-up and late
 * session records that share it, so a concurrent write to another key is
 * never lost.
 */
export async function setVideoStyle(enrollmentId: string, style: VideoStyle, by: string | null, opts: { skitsPerMonth?: number | null } = {}): Promise<{ changed: boolean; style: VideoStyle; skitsPerMonth: number | null }> {
  if (style !== "DIRECT" && style !== "SKITS" && style !== "MIX") throw new Error("The video style is Direct-to-camera or Skits, or a Mix of both.");
  const { recordEnrollmentChange, readOverrides } = await import("@/lib/enrollmentChanges");
  const { etMonthKey } = await import("@/lib/contentProgram");
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
    if (!e) throw new Error("Enrollment not found.");
    const before = videoStyleFromOverrides(e.overridesJson);
    const beforeTarget = skitsPerMonthFromOverrides(e.overridesJson);
    // A Mix account's target: the one typed, else the one it had, else 2.
    const target = style === "MIX" ? clampSkitsPerMonth(opts.skitsPerMonth ?? beforeTarget) : null;
    if (before === style && beforeTarget === target) return { changed: false, style, skitsPerMonth: target };
    const bag = { ...readOverrides(e.overridesJson) };
    if (style === "DIRECT") delete bag[VIDEO_STYLE_OVERRIDE_KEY]; else bag[VIDEO_STYLE_OVERRIDE_KEY] = style;
    if (target) bag[SKITS_PER_MONTH_KEY] = target; else delete bag[SKITS_PER_MONTH_KEY];
    const next = Object.keys(bag).length ? JSON.stringify(bag) : null;
    const w = await prisma.contentEnrollment.updateMany({ where: { id: enrollmentId, overridesJson: e.overridesJson }, data: { overridesJson: next } });
    if (!w.count) continue; // another write to the bag landed first: read it again
    const now = new Date();
    await recordEnrollmentChange({
      enrollmentId, clientId: e.clientId, field: "overrides",
      from: { [VIDEO_STYLE_OVERRIDE_KEY]: before, ...(beforeTarget ? { [SKITS_PER_MONTH_KEY]: beforeTarget } : {}) },
      to: { [VIDEO_STYLE_OVERRIDE_KEY]: style, ...(target ? { [SKITS_PER_MONTH_KEY]: target } : {}) },
      effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: by, appliedAt: now,
      reason: `Video style set to ${VIDEO_STYLE_LABEL[style]}${target ? ` (${target} skit${target === 1 ? "" : "s"} a month)` : ""} (Program style).`,
    });
    return { changed: true, style, skitsPerMonth: target };
  }
  throw new Error("The client file changed while saving. Try again.");
}

// ---------------------------------------------------------------------------
// THE SKIT CAST (Oct 22 2026). Bernadette Rabel's husband, a voice
// impressionist, will act in her skits. The office adds the people the CLIENT
// confirmed (on a call, by text); the skit prompts list them and allow one per
// skit, with few, short lines (prompts.ts skitCastBlock). Stored in
// overridesJson.skitCast, compare-and-swap like the style, ledgered.
// ---------------------------------------------------------------------------

export { type SkitCastMember, skitCastFromOverrides } from "@/lib/contentPolicy/videoFormat";

export async function skitCastOf(enrollmentId: string): Promise<SkitCastMember[]> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  return skitCastFromOverrides(e?.overridesJson ?? null);
}

/** Add one cast member (`add`) or take one off (`removeId`). Returns the cast as saved. */
export async function setSkitCast(enrollmentId: string, change: { add?: { name?: string | null; role: string; note?: string | null } | null; removeId?: string | null }, by: string | null): Promise<{ changed: boolean; cast: SkitCastMember[] }> {
  const { recordEnrollmentChange, readOverrides } = await import("@/lib/enrollmentChanges");
  const { etMonthKey } = await import("@/lib/contentProgram");
  for (let attempt = 0; attempt < 3; attempt++) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
    if (!e) throw new Error("Enrollment not found.");
    const before = skitCastFromOverrides(e.overridesJson);
    let next = before;
    let said = "";
    if (change.add) {
      const now = new Date();
      const m = cleanCastMember({ ...change.add, id: `cast_${now.getTime().toString(36)}`, addedBy: by, addedAt: now.toISOString() });
      if (!m) throw new Error("Say who they are to the client, for example their spouse or business partner.");
      if (before.length >= MAX_SKIT_CAST) throw new Error(`A skit cast holds up to ${MAX_SKIT_CAST} people.`);
      if (before.some((x) => x.role.toLowerCase() === m.role.toLowerCase() && (x.name ?? "").toLowerCase() === (m.name ?? "").toLowerCase())) return { changed: false, cast: before };
      next = [...before, m];
      said = `Skit cast: added ${castMemberLabel(m)}.`;
    } else if (change.removeId) {
      const gone = before.find((x) => x.id === change.removeId);
      if (!gone) return { changed: false, cast: before };
      next = before.filter((x) => x.id !== change.removeId);
      said = `Skit cast: removed ${castMemberLabel(gone)}.`;
    } else return { changed: false, cast: before };
    const bag = { ...readOverrides(e.overridesJson) };
    if (next.length) bag[SKIT_CAST_KEY] = next; else delete bag[SKIT_CAST_KEY];
    const json = Object.keys(bag).length ? JSON.stringify(bag) : null;
    const w = await prisma.contentEnrollment.updateMany({ where: { id: enrollmentId, overridesJson: e.overridesJson }, data: { overridesJson: json } });
    if (!w.count) continue; // another write to the bag landed first: read it again
    const now = new Date();
    await recordEnrollmentChange({
      enrollmentId, clientId: e.clientId, field: "overrides", from: { [SKIT_CAST_KEY]: before.map(castMemberLabel) }, to: { [SKIT_CAST_KEY]: next.map(castMemberLabel) },
      effectiveAt: now, effectiveMonthKey: etMonthKey(now), changedBy: by, appliedAt: now, reason: said,
    });
    return { changed: true, cast: next };
  }
  throw new Error("The client file changed while saving. Try again.");
}
